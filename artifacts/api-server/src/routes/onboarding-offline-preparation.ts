import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, onbCases, onbEvents } from "@workspace/db";
import { SaveOfflineCasePreparationBody, ActivateOfflineCaseBody, ReconfirmOfflineCaseActivationBody,
  StartOfflineCaseWorkflowBody } from "@workspace/api-zod";
import { activateOfflineCaseInTransaction, OFFLINE_OPERATIONAL_BOUNDARY_READY,
  startOfflineWorkflowInTransaction } from "../lib/onboarding/offline-activation";
import { startOrchestration } from "../lib/onboarding/engine";
import { getOrganizationId } from "../lib/organization-scope";
import { hasHumanPermissions } from "../lib/human-permissions";
import { acquireCaseDispatchMutationLock, hasActiveCaseDispatchMarker } from "../lib/onboarding/dispatch-guard";
import { canonicalIntakeHash, findHroTemplate } from "../lib/onboarding/hro-batch-templates";
import {
  actualRunOwnsCase, preparationSource, preparationInputIssues, preparationView,
  validStoredPreparation, PREPARATION_EDIT_KEYS, PreparationError,
} from "../lib/onboarding/offline-preparation";
import {
  withSensitiveLifecycleFence, unsafeCaseDerivedSettingsInTransaction,
  evaluateCaseDerivedLifecycleGateInTransaction, jurisdictionForWorkforceContext,
} from "../lib/onboarding/sensitive-lifecycle";

const router: IRouter = Router();
const path = "/onboarding/cases/:caseId/operational-preparation";
router.get(path, async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (!Number.isSafeInteger(caseId) || caseId < 1) throw new PreparationError(400, "Use a valid case reference.");
    const organizationId = getOrganizationId(req);
    const result = await db.transaction(async tx => {
      const [row] = await tx.select().from(onbCases).where(and(
        eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
      ));
      if (!row) throw new PreparationError(404, "Case not found.");
      return preparationView(tx, row, req.authUserId!);
    });
    res.json(result);
  } catch (error) {
    if (error instanceof PreparationError) res.status(error.status).json({ message: error.message });
    else next(error);
  }
});

router.put(path, async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (!Number.isSafeInteger(caseId) || caseId < 1) throw new PreparationError(400, "Use a valid case reference.");
    const body = SaveOfflineCasePreparationBody.parse(req.body);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)
      throw new PreparationError(400, "A non-negative integer revision is required.");
    const organizationId = getOrganizationId(req);
    const actorUserId = req.authUserId!;
    const result = await withSensitiveLifecycleFence(organizationId, () => db.transaction(async tx => {
      await acquireCaseDispatchMutationLock(tx, organizationId, caseId);
      const [row] = await tx.select().from(onbCases).where(and(
        eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
      )).for("update");
      if (!row) throw new PreparationError(404, "Case not found.");
      const source = preparationSource(row);
      if (!source || await actualRunOwnsCase(tx, row))
        throw new PreparationError(409, "Only an exact verified fictional inventory example without actual UAT ownership is eligible.");
      if (!await hasHumanPermissions(tx, {
        organizationId, caseId, actorUserId, requiredKeys: PREPARATION_EDIT_KEYS,
      })) throw new PreparationError(403, "Current named-user case, profile, notes and sensitive-field permissions are required. Shared Demo logins cannot save real information.");
      if (row.operationalPreparation && !validStoredPreparation(row))
        throw new PreparationError(409, "Stored preparation provenance is inconsistent; no information was replaced.");
      const revision = validStoredPreparation(row)?.revision ?? 0;
      if (revision !== body.expectedRevision) throw new PreparationError(409, "Preparation changed. Reload before saving.");
      if (await hasActiveCaseDispatchMarker(tx, organizationId, caseId) ||
        row.orchestrationClaimUntil && row.orchestrationClaimUntil > new Date())
        throw new PreparationError(409, "An active or ambiguous operation requires reconciliation before preparation can change.");
      const template = findHroTemplate(source.values.processPolicySnapshot.batchIntake.templateId)!;
      const issues = preparationInputIssues(template.id, body.data);
      // Incomplete drafts are allowed; invalid populated values are not.
      const invalid = issues.filter(issue => !issue.message.endsWith(" is required."));
      if (invalid.length) throw new PreparationError(400, invalid.map(issue => `${issue.column}: ${issue.message}`).join(" "));
      const originalJurisdiction = jurisdictionForWorkforceContext(row.workforceContext);
      if (originalJurisdiction && originalJurisdiction.split("-")[0] !== body.data.work_country)
        throw new PreparationError(409, "The supplied country conflicts with retained case jurisdiction. Resolve the jurisdiction and its lifecycle policies before storing a draft.");
      if (row.operationalPreparation?.data.work_country &&
        row.operationalPreparation.data.work_country !== body.data.work_country)
        throw new PreparationError(409, "A saved draft's collection jurisdiction cannot be replaced here. Governed correction must preserve the existing retention obligations.");
      const unsafeSettings = await unsafeCaseDerivedSettingsInTransaction(tx, organizationId, caseId);
      if (unsafeSettings) throw new PreparationError(409, unsafeSettings);
      const collection = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
        organizationId, jurisdiction: originalJurisdiction ?? body.data.work_country ?? null,
      });
      if (!collection.allowed) throw new PreparationError(409, collection.reason);
      const data = Object.fromEntries(Object.entries(body.data).map(([key, value]) => [key, value.trim()]));
      const now = new Date();
      const [saved] = await tx.update(onbCases).set({
        ...(row.operationalActivation ? { processPolicySnapshot: {
          ...row.processPolicySnapshot, operationalPreparationReviewPending: { revision: revision + 1 },
        } } : {}),
        operationalPreparation: {
          schema: "offline-case-preparation/v1", organizationId, caseId,
          sourceKey: source.key, sourceFingerprint: canonicalIntakeHash(source.values),
          templateId: template.id, templateVersion: template.version,
          revision: revision + 1, data, updatedByUserId: actorUserId, updatedAt: now.toISOString(),
        },
        updatedAt: now,
      }).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId))).returning();
      await tx.insert(onbEvents).values({
        organizationId, caseId, agent: "human", engine: "operational-preparation",
        title: "Operational preparation saved",
        detail: "A separate unverified request draft was saved. Fictional source history is unchanged; no activation or external effects were authorized.",
        idempotencyKey: `operational-preparation:${caseId}:${revision + 1}`,
      });
      return preparationView(tx, saved!, actorUserId);
    }));
    res.json(result);
  } catch (error) {
    if (error instanceof PreparationError) res.status(error.status).json({ message: error.message });
    else if (error instanceof Error && error.name.startsWith("SensitiveLifecycle"))
      res.status(409).json({ message: error.message });
    else next(error);
  }
});
for (const reconfirm of [false, true]) router.post(
  `/onboarding/cases/:caseId/${reconfirm ? "operational-reconfirmation" : "operational-activation"}`,
  async (req, res, next) => {
    try {
      if (!OFFLINE_OPERATIONAL_BOUNDARY_READY)
        throw new PreparationError(503, "Operational activation safety validation is not yet complete. Your editable preparation remains saved; no live work has started.");
      const caseId = Number(req.params.caseId);
      const body = (reconfirm ? ReconfirmOfflineCaseActivationBody : ActivateOfflineCaseBody).parse(req.body);
      if (!Number.isSafeInteger(caseId) || caseId < 1 ||
        !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)
        throw new PreparationError(400, "Valid case and preparation revisions are required.");
      const organizationId = getOrganizationId(req);
      const result = await withSensitiveLifecycleFence(organizationId, () => db.transaction(async tx => {
        const saved = await activateOfflineCaseInTransaction(tx, {
          organizationId, caseId, actorUserId: req.authUserId!, expectedRevision: body.expectedRevision,
          requirementsFingerprint: body.requirementsFingerprint, confirmIdentity: body.confirmIdentity,
          confirmSourceEvidenceExcluded: body.excludeHistoricalEvidence, reconfirm,
        });
        return preparationView(tx, saved, req.authUserId!);
      }));
      res.json(result);
    } catch (error) {
      if (error instanceof PreparationError) res.status(error.status).json({ message: error.message });
      else if (error instanceof Error && error.name.startsWith("SensitiveLifecycle"))
        res.status(409).json({ message: error.message });
      else next(error);
    }
  },
);
router.post("/onboarding/cases/:caseId/operational-start", async (req, res, next) => {
  try {
    if (!OFFLINE_OPERATIONAL_BOUNDARY_READY)
      throw new PreparationError(503, "Operational workflow safety validation is not yet complete. Preparation remains saved; no delivery is enabled.");
    const caseId = Number(req.params.caseId);
    const body = StartOfflineCaseWorkflowBody.parse(req.body);
    if (!Number.isSafeInteger(caseId) || caseId < 1 || !Number.isSafeInteger(body.expectedRevision))
      throw new PreparationError(400, "Valid case and preparation revisions are required.");
    const organizationId = getOrganizationId(req);
    const view = await withSensitiveLifecycleFence(organizationId, () => db.transaction(async tx => {
      const saved = await startOfflineWorkflowInTransaction(tx, {
        ...body, organizationId, caseId, actorUserId: req.authUserId!,
      });
      return preparationView(tx, saved, req.authUserId!);
    }));
    // Activation never reaches this wake-up. It is only the explicit,
    // permission-checked start confirmation, committed before engine entry.
    startOrchestration(caseId);
    res.json(view);
  } catch (error) {
    if (error instanceof PreparationError) res.status(error.status).json({ message: error.message });
    else next(error);
  }
});
export default router;
