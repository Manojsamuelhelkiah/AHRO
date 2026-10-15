import { bindNewCaseInTransaction } from "../lib/flow-manager/manager";
import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { assertBatchFamilyEnabled, ClientOperationsError } from "../lib/onboarding/client-operations-settings";
import { resolveEffectiveAccessInTransaction } from "../lib/access-governance";
import {
  onbCaseLogistics,
  onbCases,
  onbEvents,
  onbIntakeBatches,
  onbIntakeBatchPeople,
  onbJobProfiles,
  onbPolicyAuthorities,
  organizationMembershipsTable,
  type OnbWorkforceContext,
} from "@workspace/db/schema";
import { getOrganizationId } from "../lib/organization-scope";
import { isChecklistAdministrator } from "../lib/onboarding/checklist";
import { startOrchestration } from "../lib/onboarding/engine";
import {
  resolveEffectiveWorkforcePolicyInTransaction,
} from "../lib/onboarding/checklist-profiles";
import { readinessFromChecklist } from "../lib/onboarding/settings";
import { logisticsForCase } from "../lib/onboarding/logistics-defaults";
import { getDay1LogisticsDefault } from "../lib/onboarding/settings";
import { batchIntakePayloadFingerprint, eligibleForExplicitBatchRelease } from "../lib/onboarding/batch-intake";
import {
  normalizedWorkforceContext,
} from "../lib/onboarding/workforce-policies";
import { SYNTHETIC_OFFLINE_MARKER } from "../lib/onboarding/synthetic-offline";
import {
  evaluateCaseDerivedLifecycleGateInTransaction,
  jurisdictionForWorkforceContext,
  withSensitiveLifecycleFence,
} from "../lib/onboarding/sensitive-lifecycle";
import {
  governanceSnapshotForNewCase,
  withGovernanceDecisionSnapshot,
} from "../lib/onboarding/governance-runtime";
import { assertGovernanceMutationAllowed } from "../lib/onboarding/governance-dispatch";
import { acquireCaseDispatchMutationLock } from "../lib/onboarding/dispatch-guard";
import { readHroBatchRequest, type HroBatchRequest } from "../lib/onboarding/hro-batch-templates";
import { templateOriginalIntent, onboardingOriginalIntent } from "../lib/onboarding/original-intent";

const router: IRouter = Router();

export function requireBatchAdministrator(req: Request, res: Response): boolean {
  if (isChecklistAdministrator(req.organizationRole)) return true;
  res.status(403).json({ message: "Organization owner or admin role required for batch intake and policy authority administration." });
  return false;
}

const asText = (value: unknown, max = 120) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null;

function containsReservedSyntheticMarker(notes: unknown): boolean {
  if (typeof notes !== "string") return false;
  return notes.toLowerCase().includes(SYNTHETIC_OFFLINE_MARKER.toLowerCase()) ||
    /\[demo-controller-run:/i.test(notes);
}

export type BatchPerson = {
  personKey: string;
  workerName: string;
  workerEmail: string;
  workerPhone?: string;
  channelPreference?: "email" | "whatsapp" | "both";
  hireType: string;
  workerCategory: string;
  workerBand?: string;
  role: string;
  department: string;
  geography: string;
  legalEntity: string;
  managerName: string;
  recruiterName: string;
  joiningDate: string;
  urgency?: string;
  notes?: string;
  jobProfileId?: string;
  workforceContext?: OnbWorkforceContext;
  /** Only populated by the validated spreadsheet route, never from the legacy body. */
  batchRequest?: HroBatchRequest;
};

function parsePerson(value: unknown): BatchPerson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const personKey = asText(input.personKey, 160);
  const workerName = asText(input.workerName);
  const workerEmail = asText(input.workerEmail, 254);
  const hireType = asText(input.hireType);
  const workerCategory = asText(input.workerCategory);
  const role = asText(input.role);
  const department = asText(input.department);
  const geography = asText(input.geography);
  const legalEntity = asText(input.legalEntity);
  const managerName = asText(input.managerName);
  const recruiterName = asText(input.recruiterName);
  const joiningDate = asText(input.joiningDate, 20);
  const notes = asText(input.notes, 4000);
  if (!personKey || !workerName || !workerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workerEmail) ||
    !hireType || !workerCategory || !role || !department || !geography || !legalEntity || !managerName || !recruiterName ||
    !joiningDate || !/^\d{4}-\d{2}-\d{2}$/.test(joiningDate) || containsReservedSyntheticMarker(notes)) return null;
  const channel = input.channelPreference;
  if (channel !== undefined && channel !== "email" && channel !== "whatsapp" && channel !== "both") return null;
  const workforceContext = input.workforceContext;
  if (workforceContext !== undefined && (!workforceContext || typeof workforceContext !== "object" || Array.isArray(workforceContext))) return null;
  return {
    personKey, workerName, workerEmail, hireType, workerCategory, role, department, geography,
    legalEntity, managerName, recruiterName, joiningDate,
    ...(asText(input.workerPhone, 32) ? { workerPhone: asText(input.workerPhone, 32)! } : {}),
    ...(channel ? { channelPreference: channel } : {}),
    ...(asText(input.workerBand) ? { workerBand: asText(input.workerBand)! } : {}),
    ...(asText(input.urgency) ? { urgency: asText(input.urgency)! } : {}),
    ...(notes ? { notes } : {}),
    ...(asText(input.jobProfileId, 160) ? { jobProfileId: asText(input.jobProfileId, 160)! } : {}),
    ...(workforceContext ? { workforceContext: workforceContext as OnbWorkforceContext } : {}),
  };
}

/**
 * Creates held cases only. Batch intake never starts orchestration or invokes
 * any communication/provider path; an HR user reviews the resulting cases
 * before a downstream workflow is allowed to run.
 */
export async function createHeldBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!requireBatchAdministrator(req, res)) return;
    const input = req.body as Record<string, unknown>;
    const idempotencyKey = asText(input.idempotencyKey, 160);
    const name = asText(input.name, 120);
    const rawPeople = Array.isArray(input.people) ? input.people : [];
    if (rawPeople.some((person) =>
      person && typeof person === "object" && !Array.isArray(person) &&
      containsReservedSyntheticMarker((person as Record<string, unknown>).notes)
    )) {
      res.status(400).json({
        message: "Batch intake notes cannot contain reserved synthetic offline or Demo Controller run markers.",
        code: "RESERVED_SYNTHETIC_MARKER",
      });
      return;
    }
    const trustedPeople = res.locals.hroBatchPeople as BatchPerson[] | undefined;
    const people = trustedPeople ?? rawPeople.map(parsePerson);
    if (!idempotencyKey || !name || people.length === 0 || people.length > 500 || people.some((person) => !person)) {
      res.status(400).json({ message: "A batch name, retry key, and 1–500 valid people are required." });
      return;
    }
    const parsedPeople = people as BatchPerson[];
    // The spreadsheet adapter checks its selected family separately. Legacy
    // JSON intake must not bypass the same client pause for onboarding/transfer.
    if (!trustedPeople) {
      for (const templateId of new Set(parsedPeople.map(person => person.hireType === "internal-transfer"
        ? "employee-changes-internal-transfer" : "onboarding-external-fte"))) {
        try { await assertBatchFamilyEnabled(getOrganizationId(req), templateId); }
        catch (error) {
          if (error instanceof ClientOperationsError) { res.status(error.status).json({ message: error.message }); return; }
          throw error;
        }
      }
    }
    if (new Set(parsedPeople.map((person) => person.personKey)).size !== parsedPeople.length) {
      res.status(400).json({ message: "Each person needs a unique stable personKey for safe retry reconciliation." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const payloadFingerprint = batchIntakePayloadFingerprint(name, parsedPeople);
    // One exact approved decision set is adopted for newly inserted members;
    // reconciliation rows retain their original snapshots on retry.
    const result = await withSensitiveLifecycleFence(organizationId, async () => {
      const logisticsDefault = await getDay1LogisticsDefault(organizationId);
      await governanceSnapshotForNewCase(organizationId);
      return db.transaction(async (tx) => {
        await assertGovernanceMutationAllowed(tx, organizationId);
        // Serialize source-request reconciliation across different upload files,
        // not only retries carrying the same batch key.
        if (trustedPeople) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hro-batch:${organizationId}`}, 0))`);
        const caseAccess = await resolveEffectiveAccessInTransaction(tx, {
          organizationId,
          principalType: "human",
          principalId: req.authUserId!,
          purpose: "onboarding-batch-case-create",
        });
        const requiredCaseKeys = [
          "flow.case.edit",
          "data.case.profile.edit",
          ...(parsedPeople.some((person) => Boolean(person.notes?.trim()) || person.batchRequest)
            ? ["data.case.notes.edit"]
            : []),
        ];
        if (requiredCaseKeys.some((key) => !caseAccess.allows.includes(key))) {
          throw Object.assign(
            new Error("Explicit case-flow and case-profile edit grants (and case-notes edit for notes) are required for batch intake."),
            { statusCode: 403 },
          );
        }
        const governanceSnapshot = await governanceSnapshotForNewCase(organizationId, new Date(), tx);
        if (trustedPeople) {
          for (const country of new Set(trustedPeople.map(person => jurisdictionForWorkforceContext(person.workforceContext ?? {})))) {
            const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId, jurisdiction: country });
            if (!gate.allowed) throw Object.assign(new Error(gate.reason), { statusCode: 409 });
          }
        }
        let [existing] = await tx.select().from(onbIntakeBatches).where(and(
          eq(onbIntakeBatches.organizationId, organizationId),
          eq(onbIntakeBatches.idempotencyKey, idempotencyKey),
        )).for("update");
        if (existing && existing.payloadFingerprint !== payloadFingerprint) {
          throw Object.assign(new Error("This idempotency key was already used with different person details. Use a new key for a changed cohort."), { statusCode: 409 });
        }
        let batchId = existing?.batchId ?? randomUUID();
        if (!existing) {
          const inserted = await tx.insert(onbIntakeBatches).values({
            organizationId, batchId, idempotencyKey, payloadFingerprint, name, createdBy: req.authUserId!,
          }).onConflictDoNothing().returning();
          if (!inserted[0]) {
            [existing] = await tx.select().from(onbIntakeBatches).where(and(
              eq(onbIntakeBatches.organizationId, organizationId),
              eq(onbIntakeBatches.idempotencyKey, idempotencyKey),
            )).for("update");
            if (!existing) throw new Error("Batch intake retry could not be reconciled; please retry with the same key.");
            if (existing.payloadFingerprint !== payloadFingerprint) {
              throw Object.assign(new Error("This idempotency key was already used with different person details. Use a new key for a changed cohort."), { statusCode: 409 });
            }
            batchId = existing.batchId;
          }
        }
        const results: Array<{ personKey: string; caseId: number; status: "created" | "reconciled"; profileId: string; profileVersion: number }> = [];
        for (const person of parsedPeople) {
          const [prior] = await tx.select().from(onbIntakeBatchPeople).where(and(
            eq(onbIntakeBatchPeople.organizationId, organizationId),
            eq(onbIntakeBatchPeople.batchId, batchId),
            eq(onbIntakeBatchPeople.personKey, person.personKey),
          )).limit(1);
          if (prior) {
            const access = await resolveEffectiveAccessInTransaction(tx, {
              organizationId, principalType: "human", principalId: req.authUserId!, caseId: prior.caseId, purpose: "batch-retry-case-reference",
            });
            if (!access.allows.includes("flow.case.read")) throw Object.assign(new Error("Current case access is required to reconcile this request."), { statusCode: 403 });
            const policy = prior.processPolicySnapshot as { profileId?: string; profileVersion?: number };
            results.push({ personKey: person.personKey, caseId: prior.caseId, status: "reconciled", profileId: policy.profileId ?? "unknown", profileVersion: policy.profileVersion ?? 0 });
            continue;
          }
          if (person.batchRequest) {
            const [source] = await tx.select({ case: onbCases, original: onbIntakeBatchPeople.processPolicySnapshot, originalContext: onbIntakeBatchPeople.workforceContextSnapshot }).from(onbIntakeBatchPeople)
              .innerJoin(onbCases, and(eq(onbCases.organizationId, onbIntakeBatchPeople.organizationId), eq(onbCases.id, onbIntakeBatchPeople.caseId)))
              .where(and(
                eq(onbIntakeBatchPeople.organizationId, organizationId),
                sql`${onbIntakeBatchPeople.processPolicySnapshot}->'batchIntake'->>'templateId' = ${person.batchRequest.templateId}`,
                sql`${onbIntakeBatchPeople.processPolicySnapshot}->'batchIntake'->>'requestId' = ${person.batchRequest.requestId}`,
              )).limit(1);
            if (source) {
              const duplicate = source.case;
              const previous = readHroBatchRequest(source.original);
              if (previous?.fingerprint !== person.batchRequest.fingerprint) throw Object.assign(new Error(`Request ${person.personKey} already exists with different data. A retry cannot overwrite an existing case.`), { statusCode: 409 });
              const access = await resolveEffectiveAccessInTransaction(tx, {
                organizationId, principalType: "human", principalId: req.authUserId!, caseId: duplicate.id, purpose: "batch-source-request-reconciliation",
              });
              if (!access.allows.includes("flow.case.read")) throw Object.assign(new Error("Current case access is required to reconcile this request."), { statusCode: 403 });
              await tx.insert(onbIntakeBatchPeople).values({
                organizationId, batchId, personKey: person.personKey, caseId: duplicate.id,
                workforceContextSnapshot: source.originalContext, processPolicySnapshot: source.original,
              });
              results.push({ personKey: person.personKey, caseId: duplicate.id, status: "reconciled", profileId: duplicate.checklistProfileId, profileVersion: duplicate.checklistProfileVersion ?? 1 });
              continue;
            }
          }
          const [jobProfile] = person.jobProfileId
            ? await tx.select().from(onbJobProfiles).where(and(
              eq(onbJobProfiles.organizationId, organizationId),
              eq(onbJobProfiles.profileId, person.jobProfileId),
              eq(onbJobProfiles.enabled, true),
            )).orderBy(desc(onbJobProfiles.version)).limit(1)
            : [];
          if (person.jobProfileId && !jobProfile) throw new Error(`Selected job profile is not available for ${person.workerName}.`);
          const workforceContext = normalizedWorkforceContext({
            ...jobProfile?.context,
            ...person.workforceContext,
            hiringMode: "batch",
            batchId,
          });
          const specialistRequest = person.batchRequest?.executionMode === "specialist-review-only";
          const workforcePolicy = specialistRequest ? {
            profile: {
              profileId: `hro-intake:${person.batchRequest!.templateId}`,
              profileVersion: person.batchRequest!.templateVersion, templateVersion: person.batchRequest!.templateVersion,
              profileName: `${person.batchRequest!.requestType} — intake review`,
              matchedCriteria: {}, explanation: "Input-schema snapshot only; not approved employment policy or execution authority.",
              processPolicy: {},
            },
            classification: null,
            effectiveItems: [{
              id: "hro-specialist-request-review", label: "Authorized specialist review of submitted request",
              order: 0, enabled: true, mandatory: true, evidenceRequired: true,
              enforcementStage: "before-workstreams" as const, executor: "human-task" as const,
              completionAuthority: "designated-human" as const, responsibleRole: "Designated specialist",
            }],
          } : await resolveEffectiveWorkforcePolicyInTransaction(
            tx,
            organizationId,
            workforceContext,
            person,
          );
          const { profile, classification } = workforcePolicy;
          const checklistSnapshot = workforcePolicy.effectiveItems;
          const processPolicySnapshot = withGovernanceDecisionSnapshot({
            profileId: profile.profileId, profileVersion: profile.profileVersion, templateVersion: profile.templateVersion,
            processPolicy: profile.processPolicy ?? {}, classification,
            ...(person.batchRequest ? { batchIntake: person.batchRequest, specialistReviewOnly: specialistRequest } : {}),
          }, governanceSnapshot);
          // The case envelope, logistics, and the batch-person snapshot can
          // retain opaque candidate facts. Check the server-normalized work
          // jurisdiction immediately before their first write.
          const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
            organizationId,
            jurisdiction: jurisdictionForWorkforceContext(workforceContext),
          });
          if (!lifecycle.allowed) {
            throw Object.assign(new Error(lifecycle.reason), { statusCode: 409 });
          }
          const [created] = await tx.insert(onbCases).values({
            organizationId,
            originalIntent: person.batchRequest
              ? templateOriginalIntent(person.batchRequest.templateId)
              : person.hireType === "internal-transfer"
                ? { label: "Internal transfer request", source: "batch-transfer-intake" }
                : onboardingOriginalIntent("batch-onboarding-intake"),
            workerName: person.workerName, workerEmail: person.workerEmail, workerPhone: person.workerPhone ?? null,
            channelPreference: person.channelPreference ?? "email", hireType: person.hireType,
            workerCategory: person.workerCategory, workerBand: person.workerBand ?? null, role: person.role,
            department: person.department, geography: person.geography, legalEntity: person.legalEntity,
            managerName: person.managerName, recruiterName: person.recruiterName, joiningDate: person.joiningDate,
            urgency: person.urgency ?? "normal", notes: person.notes ?? null,
            checklistTemplateVersion: profile.templateVersion, checklistSnapshot,
            checklistProfileId: profile.profileId, checklistProfileName: profile.profileName,
            checklistProfileVersion: profile.profileVersion, checklistMatchedCriteria: profile.matchedCriteria,
            checklistMatchExplanation: profile.explanation, workforceContext, workforceClassification: classification,
            processPolicySnapshot, jobProfileId: jobProfile?.profileId ?? null, jobProfileVersion: jobProfile?.version ?? null,
            readiness: readinessFromChecklist(checklistSnapshot), workstreams: [], lifecycleStage: "trigger-received",
            orchestrationStatus: specialistRequest ? "hro-request-pending-review" : "batch-intake-pending-review",
            createdByUserId: req.authUserId!,
          }).returning();
          await tx.insert(onbCaseLogistics).values({
            organizationId, caseId: created.id, ...logisticsForCase(logisticsDefault, created.joiningDate),
          });
          await tx.insert(onbIntakeBatchPeople).values({
            organizationId, batchId, personKey: person.personKey, caseId: created.id,
            workforceContextSnapshot: workforceContext, processPolicySnapshot,
          });
          if (!specialistRequest) await bindNewCaseInTransaction(tx, organizationId, created.id, "onboarding");
          results.push({ personKey: person.personKey, caseId: created.id, status: "created", profileId: profile.profileId, profileVersion: profile.profileVersion });
        }
        return { batchId, name: existing?.name ?? name, retry: Boolean(existing), results };
      });
    });
    res.status(result.retry ? 200 : 201).json(result);
  } catch (err) {
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (statusCode === 409) {
      res.status(409).json({ message: err instanceof Error ? err.message : "Batch retry payload conflict." });
      return;
    }
    if (statusCode === 403) {
      res.status(403).json({
        message: err instanceof Error ? err.message : "Case edit access is required.",
        code: "CASE_EDIT_ACCESS_REQUIRED",
      });
      return;
    }
    next(err);
  }
};
router.post("/onboarding/batch-intake", createHeldBatch);

/**
 * Batch intake is deliberately inert. An owner/admin must explicitly release
 * a non-Gate-A case before it can enter the normal orchestration claim path.
 * Gate-A pathways remain held for their dedicated acceptance confirmation.
 */
router.post("/onboarding/batch-intake/:batchId/cases/:caseId/release", async (req, res, next) => {
  try {
    if (!requireBatchAdministrator(req, res)) return;
    const batchId = String(req.params.batchId ?? "").trim();
    const caseId = Number(req.params.caseId);
    if (!batchId || !Number.isInteger(caseId) || caseId < 1) {
      res.status(400).json({ message: "A valid batch and case are required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const outcome = await withSensitiveLifecycleFence(organizationId, () => db.transaction(async (tx) => {
      await acquireCaseDispatchMutationLock(tx, organizationId, caseId);
      const [row] = await tx.select({ case: onbCases }).from(onbIntakeBatchPeople)
        .innerJoin(onbCases, and(
          eq(onbIntakeBatchPeople.organizationId, onbCases.organizationId),
          eq(onbIntakeBatchPeople.caseId, onbCases.id),
        ))
        .where(and(
          eq(onbIntakeBatchPeople.organizationId, organizationId),
          eq(onbIntakeBatchPeople.batchId, batchId),
          eq(onbIntakeBatchPeople.caseId, caseId),
        )).for("update");
      if (!row) return { kind: "not-found" as const };
      if (readHroBatchRequest(row.case.processPolicySnapshot)?.executionMode === "specialist-review-only") {
        return { kind: "specialist-review-only" as const };
      }
      const caseAccess = await resolveEffectiveAccessInTransaction(tx, {
        organizationId,
        principalType: "human",
        principalId: req.authUserId!,
        caseId,
        purpose: "onboarding-batch-case-release",
      });
      if (!caseAccess.allows.includes("flow.case.edit")) {
        throw Object.assign(
          new Error("Explicit case-flow edit access is required to release this batch case."),
          { statusCode: 403 },
        );
      }
      if (!eligibleForExplicitBatchRelease(row.case.hireType)) return { kind: "gate-a-required" as const };
      if (row.case.checklistSnapshot.some((item) =>
        item.id === "policy-rebase-required" && item.enabled && item.mandatory,
      )) {
        return { kind: "policy-rebase-required" as const };
      }
      if (row.case.orchestrationStatus !== "batch-intake-pending-review") {
        return { kind: "already-released" as const, status: row.case.orchestrationStatus };
      }
      const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
        organizationId,
        jurisdiction: jurisdictionForWorkforceContext(row.case.workforceContext),
      });
      if (!lifecycle.allowed) {
        return { kind: "lifecycle-blocked" as const, message: lifecycle.reason };
      }
      const [released] = await tx.update(onbCases).set({
        orchestrationStatus: "idle",
        orchestrationCheckpoint: null,
        updatedAt: new Date(),
      }).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId))).returning();
      await tx.insert(onbEvents).values({
        organizationId, caseId, agent: "batch-intake-review", engine: "human",
        hitlPattern: "approve-before-act", ruleRef: "Batch intake release",
        title: "Batch case explicitly released",
        detail: `An authorized organization administrator released this non-Gate-A batch case into the normal onboarding orchestration path.`,
        idempotencyKey: `batch-release:${batchId}:${caseId}`,
      }).onConflictDoNothing();
      return { kind: "released" as const, case: released };
    }));
    if (outcome.kind === "not-found") return void res.status(404).json({ message: "Batch case not found in this organization." });
    if (outcome.kind === "specialist-review-only") return void res.status(409).json({ message: "This is a specialist-review request, not an onboarding case. Batch release cannot authorize external changes." });
    if (outcome.kind === "gate-a-required") return void res.status(409).json({ message: "This case requires the dedicated Offer-Acceptance Package confirmation; batch release cannot bypass it." });
    if (outcome.kind === "policy-rebase-required") return void res.status(409).json({ message: "This batch case has a pending workforce context correction. Rebase its policy before explicit release." });
    if (outcome.kind === "already-released") return void res.status(409).json({ message: `This case is no longer held for batch review (status: ${outcome.status}).` });
    if (outcome.kind === "lifecycle-blocked") return void res.status(409).json({ message: outcome.message });
    startOrchestration(caseId);
    res.json({ caseId, batchId, orchestrationStatus: outcome.case.orchestrationStatus });
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/policy-authorities", async (req, res, next) => {
  try {
    if (!requireBatchAdministrator(req, res)) return;
    const organizationId = getOrganizationId(req);
    const rows = await db.select({
      userId: onbPolicyAuthorities.userId,
      authorityRole: onbPolicyAuthorities.authorityRole,
      caseId: onbPolicyAuthorities.caseId,
      itemId: onbPolicyAuthorities.itemId,
      site: onbPolicyAuthorities.site,
      assignedBy: onbPolicyAuthorities.assignedBy,
      createdAt: onbPolicyAuthorities.createdAt,
      membershipRole: organizationMembershipsTable.role,
    }).from(onbPolicyAuthorities).innerJoin(organizationMembershipsTable, and(
      eq(onbPolicyAuthorities.organizationId, organizationMembershipsTable.organizationId),
      eq(onbPolicyAuthorities.userId, organizationMembershipsTable.clerkUserId),
      isNull(organizationMembershipsTable.revokedAt),
    )).where(and(
      eq(onbPolicyAuthorities.organizationId, organizationId),
      isNull(onbPolicyAuthorities.revokedAt),
    ));
    res.json(rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })));
  } catch (err) {
    next(err);
  }
});

export default router;