import { onboardingOriginalIntent } from "../lib/onboarding/original-intent";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbCaseLogistics,
  onbCases,
  onbEvents,
  onbJobProfiles,
  onbStandardIntakeEvents,
  type OnbWorkforceContext,
} from "@workspace/db/schema";
import { getOrganizationId } from "../lib/organization-scope";
import { governanceSnapshotForNewCase, withGovernanceDecisionSnapshot } from "../lib/onboarding/governance-runtime";
import { assertGovernanceMutationAllowed } from "../lib/onboarding/governance-dispatch";
import { logisticsForCase } from "../lib/onboarding/logistics-defaults";
import { getDay1LogisticsDefault, readinessFromChecklist } from "../lib/onboarding/settings";
import { resolveEffectiveWorkforcePolicyInTransaction } from "../lib/onboarding/checklist-profiles";
import { normalizedWorkforceContext } from "../lib/onboarding/workforce-policies";
import {
  evaluateCaseDerivedLifecycleGateInTransaction,
  jurisdictionForWorkforceContext,
  withSensitiveLifecycleFence,
} from "../lib/onboarding/sensitive-lifecycle";
import { isChecklistAdministrator } from "../lib/onboarding/checklist";
import { startOrchestration } from "../lib/onboarding/engine";
import { acquireCaseDispatchMutationLock } from "../lib/onboarding/dispatch-guard";
import { hasCurrentAuthorityScope } from "../lib/onboarding/decision-authority";
import {
  scheduledPreboardingCanActivate,
  scheduledPreboardingDueAt,
  scheduledPreboardingReviewIsDue,
  minimizedWorkforceContextSnapshot,
  standardIntakeEventMetadata,
  standardIntakeEventFingerprint,
  standardIntakeWorkerIdentityFingerprint,
  validateStandardIntakeRows,
  type StandardIntakeEvent,
} from "../lib/onboarding/standard-intake";

const router: IRouter = Router();

type IntakeCaller = {
  sourceId: string;
  sourceIdentity: string;
  principalId: string;
};
type IntakeResult = {
  index: number;
  sourceEventId?: string;
  status: "created" | "reconciled" | "conflict" | "duplicate-active" | "invalid" | "blocked";
  caseId?: number;
  errors?: string[];
  message?: string;
  profileId?: string;
  profileVersion?: number;
};

function requireStandardIntakeAdministrator(req: Request, res: Response): boolean {
  if (isChecklistAdministrator(req.organizationRole)) return true;
  res.status(403).json({ message: "Organization owner or admin role required to review or release standard intake cases." });
  return false;
}

function requireStandardIntakeAdministratorMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (requireStandardIntakeAdministrator(req, res)) next();
}

async function requireStandardIntakeEvidenceAuthority(
  req: Request,
  res: Response,
  organizationId: string,
  caseId: number,
): Promise<boolean> {
  if (!requireStandardIntakeAdministrator(req, res)) return false;
  const allowed = await db.transaction((tx) => hasCurrentAuthorityScope(tx, {
    organizationId,
    actorUserId: req.authUserId!,
    scope: "hr-compliance-approve",
    caseId,
  }));
  if (allowed) return true;
  res.status(403).json({ message: "A current, case-scoped HR/compliance authority assignment is required to view acceptance evidence or release this standard intake case." });
  return false;
}

function currentCaller(req: Request): IntakeCaller {
  if (req.trustedTaIntakeSource) {
    return {
      sourceId: req.trustedTaIntakeSource.sourceId,
      sourceIdentity: req.trustedTaIntakeSource.sourceIdentity,
      principalId: `ta-middleware:${req.trustedTaIntakeSource.sourceId}`,
    };
  }
  const principalId = req.authUserId;
  if (!principalId) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  return {
    sourceId: `control-tower:${principalId}`,
    sourceIdentity: "Authenticated Control Tower TA intake",
    principalId,
  };
}

function eventArray(body: unknown): unknown[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const events = (body as Record<string, unknown>).events;
  return Array.isArray(events) && events.length <= 500 ? events : [];
}

function createIntakeEventLockKey(organizationId: string, sourceId: string, sourceEventId: string): string {
  // Hash the identifiers before presenting an advisory lock argument so source
  // event identifiers are not exposed through database statement telemetry.
  return standardIntakeWorkerIdentityFingerprint(
    `${organizationId}:${sourceId}`,
    sourceEventId,
  );
}

async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const values = eventArray(req.body);
    if (!values.length) return void res.status(400).json({ message: "Provide 1–500 source events." });
    const organizationId = getOrganizationId(req);
    const caller = currentCaller(req);
    const validation = validateStandardIntakeRows(values);
    const rows = await Promise.all(validation.map(async (row): Promise<IntakeResult> => {
      const event = row.event;
      if (!event || row.errors.length) {
        return { index: row.index, sourceEventId: event?.sourceEventId, status: "invalid", errors: row.errors };
      }
      const existing = await db.select({
        payloadFingerprint: onbStandardIntakeEvents.payloadFingerprint,
        caseId: onbStandardIntakeEvents.caseId,
        state: onbStandardIntakeEvents.state,
      }).from(onbStandardIntakeEvents).where(and(
        eq(onbStandardIntakeEvents.organizationId, organizationId),
        eq(onbStandardIntakeEvents.sourceId, caller.sourceId),
        eq(onbStandardIntakeEvents.sourceEventId, event.sourceEventId),
      )).limit(1);
      if (existing[0]) {
        return {
          index: row.index,
          sourceEventId: event.sourceEventId,
          status: existing[0].payloadFingerprint === standardIntakeEventFingerprint(event)
            ? (existing[0].state === "duplicate-active" ? "duplicate-active" : "reconciled")
            : "conflict",
          ...(existing[0].caseId ? { caseId: existing[0].caseId } : {}),
          ...(existing[0].payloadFingerprint === standardIntakeEventFingerprint(event)
            ? {}
            : { message: "This source event ID was previously received with different facts or evidence." }),
        };
      }
      const [duplicate] = await db.select({ id: onbCases.id }).from(onbCases).where(and(
        eq(onbCases.organizationId, organizationId),
        sql`lower(${onbCases.workerEmail}) = ${event.person.workerEmail}`,
        sql`${onbCases.lifecycleStage} not in ('complete')`,
      )).limit(1);
      if (duplicate) return {
        index: row.index, sourceEventId: event.sourceEventId, status: "duplicate-active", caseId: duplicate.id,
        message: "An active case already exists for this worker; review it instead of creating a second case.",
      };
      const policy = await db.transaction((tx) =>
        // Preview does not mutate; a transaction keeps the policy selection
        // coherent with the resolver used on commit.
        resolveEffectiveWorkforcePolicyInTransaction(
          tx,
          organizationId,
          normalizedWorkforceContext(event.person.workforceContext ?? {}),
          event.person,
        ),
      );
      return {
        index: row.index, sourceEventId: event.sourceEventId, status: "created",
        profileId: policy.profile.profileId, profileVersion: policy.profile.profileVersion,
      };
    }));
    res.json({ sourceId: caller.sourceId, rows });
  } catch (error) {
    next(error);
  }
}

async function commitOne(
  organizationId: string,
  caller: IntakeCaller,
  event: StandardIntakeEvent,
): Promise<Omit<IntakeResult, "index">> {
  const fingerprint = standardIntakeEventFingerprint(event);
  return withSensitiveLifecycleFence(organizationId, async () => {
    const logisticsDefault = await getDay1LogisticsDefault(organizationId);
    return db.transaction(async (tx) => {
      await assertGovernanceMutationAllowed(tx, organizationId);
      // Both source-event and worker identity locks serialize races that no
      // row-level lock can see before either competing insert exists.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${createIntakeEventLockKey(organizationId, caller.sourceId, event.sourceEventId)}))`);
      const [prior] = await tx.select().from(onbStandardIntakeEvents).where(and(
        eq(onbStandardIntakeEvents.organizationId, organizationId),
        eq(onbStandardIntakeEvents.sourceId, caller.sourceId),
        eq(onbStandardIntakeEvents.sourceEventId, event.sourceEventId),
      )).for("update");
      if (prior) {
        if (prior.payloadFingerprint !== fingerprint) {
          return { sourceEventId: event.sourceEventId, status: "conflict", message: "This source event ID was previously received with different facts or evidence." };
        }
        await tx.update(onbStandardIntakeEvents).set({ replayedAt: new Date() }).where(and(
          eq(onbStandardIntakeEvents.organizationId, organizationId),
          eq(onbStandardIntakeEvents.sourceId, caller.sourceId),
          eq(onbStandardIntakeEvents.sourceEventId, event.sourceEventId),
        ));
        if (prior.state === "case-deleted") {
          return {
            sourceEventId: event.sourceEventId,
            status: "blocked",
            message: "The prior linked case was deleted; this source event is retained as a deduplication tombstone and cannot create a new case.",
          };
        }
        return {
          sourceEventId: event.sourceEventId,
          status: prior.state === "duplicate-active" ? "duplicate-active" : "reconciled",
          ...(prior.caseId ? { caseId: prior.caseId } : {}),
          ...(prior.failureReason ? { message: prior.failureReason } : {}),
        };
      }
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${standardIntakeWorkerIdentityFingerprint(organizationId, event.person.workerEmail)}))`);
      const [duplicate] = await tx.select({ id: onbCases.id }).from(onbCases).where(and(
        eq(onbCases.organizationId, organizationId),
        sql`lower(${onbCases.workerEmail}) = ${event.person.workerEmail}`,
        sql`${onbCases.lifecycleStage} not in ('complete')`,
      )).for("update").limit(1);
      if (duplicate) {
        const message = "An active case already exists for this worker; review it instead of creating a second case.";
        await tx.insert(onbStandardIntakeEvents).values({
          organizationId, sourceId: caller.sourceId, sourceEventId: event.sourceEventId,
          eventType: event.eventType, sourceIdentity: caller.sourceIdentity,
          acceptanceEvidenceReference: event.acceptanceEvidenceReference, payloadFingerprint: fingerprint,
          intakeSnapshot: standardIntakeEventMetadata(event),
          workforceContextSnapshot: {},
          processPolicySnapshot: {}, caseId: duplicate.id, state: "duplicate-active", failureReason: message,
        });
        return { sourceEventId: event.sourceEventId, status: "duplicate-active", caseId: duplicate.id, message };
      }
      const [jobProfile] = event.person.jobProfileId
        ? await tx.select().from(onbJobProfiles).where(and(
          eq(onbJobProfiles.organizationId, organizationId),
          eq(onbJobProfiles.profileId, event.person.jobProfileId),
          eq(onbJobProfiles.enabled, true),
        )).orderBy(desc(onbJobProfiles.version)).limit(1)
        : [];
      if (event.person.jobProfileId && !jobProfile) {
        return { sourceEventId: event.sourceEventId, status: "blocked", message: "The selected job profile is no longer available; correct the source event and replay it." };
      }
      const workforceContext = normalizedWorkforceContext({
        ...jobProfile?.context,
        ...event.person.workforceContext,
      });
      const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
        organizationId, jurisdiction: jurisdictionForWorkforceContext(workforceContext),
      });
      if (!lifecycle.allowed) return { sourceEventId: event.sourceEventId, status: "blocked", message: lifecycle.reason };
      const governanceSnapshot = await governanceSnapshotForNewCase(organizationId, new Date(), tx);
      const policy = await resolveEffectiveWorkforcePolicyInTransaction(tx, organizationId, workforceContext, event.person);
      const processPolicySnapshot = withGovernanceDecisionSnapshot({
        profileId: policy.profile.profileId,
        profileVersion: policy.profile.profileVersion,
        templateVersion: policy.profile.templateVersion,
        processPolicy: policy.profile.processPolicy ?? {},
        classification: policy.classification,
      }, governanceSnapshot);
      const [created] = await tx.insert(onbCases).values({
        organizationId,
        originalIntent: onboardingOriginalIntent("trusted-offer-intake"),
        workerName: event.person.workerName, workerEmail: event.person.workerEmail,
        workerPhone: event.person.workerPhone ?? null, channelPreference: event.person.channelPreference ?? "email",
        hireType: event.person.hireType, workerCategory: event.person.workerCategory,
        workerBand: event.person.workerBand ?? null, role: event.person.role,
        department: event.person.department, geography: event.person.geography,
        legalEntity: event.person.legalEntity, managerName: event.person.managerName,
        recruiterName: event.person.recruiterName, joiningDate: event.person.joiningDate,
        urgency: event.person.urgency ?? "normal", notes: null,
        checklistTemplateVersion: policy.profile.templateVersion, checklistSnapshot: policy.effectiveItems,
        checklistProfileId: policy.profile.profileId, checklistProfileName: policy.profile.profileName,
        checklistProfileVersion: policy.profile.profileVersion, checklistMatchedCriteria: policy.profile.matchedCriteria,
        checklistMatchExplanation: policy.profile.explanation, workforceContext,
        workforceClassification: policy.classification, processPolicySnapshot,
        jobProfileId: jobProfile?.profileId ?? null, jobProfileVersion: jobProfile?.version ?? null,
        readiness: readinessFromChecklist(policy.effectiveItems), workstreams: [],
        lifecycleStage: "trigger-received", orchestrationStatus: "standard-intake-pending-review",
        createdByUserId: caller.principalId,
      }).returning();
      await tx.insert(onbCaseLogistics).values({
        organizationId, caseId: created.id, ...logisticsForCase(logisticsDefault, created.joiningDate),
      });
      await tx.insert(onbStandardIntakeEvents).values({
        organizationId, sourceId: caller.sourceId, sourceEventId: event.sourceEventId,
        eventType: event.eventType, sourceIdentity: caller.sourceIdentity,
        acceptanceEvidenceReference: event.acceptanceEvidenceReference, payloadFingerprint: fingerprint,
        intakeSnapshot: standardIntakeEventMetadata(event),
        workforceContextSnapshot: minimizedWorkforceContextSnapshot(workforceContext),
        processPolicySnapshot: {
          profileId: policy.profile.profileId,
          profileVersion: policy.profile.profileVersion,
          templateVersion: policy.profile.templateVersion,
          classification: policy.classification?.label ?? null,
          governanceSnapshotVersion: governanceSnapshot.version,
          dataHandling: "Case retains full approved policy snapshot; intake register retains policy identity only.",
        },
        caseId: created.id, state: "created",
        activationDueAt: event.eventType === "scheduled-preboarding"
          ? scheduledPreboardingDueAt(event.person.joiningDate)
          : null,
        activationStatus: event.eventType === "scheduled-preboarding" ? "scheduled" : "awaiting-review",
      });
      await tx.insert(onbEvents).values({
        organizationId, caseId: created.id, agent: "standard-intake", engine: "system",
        hitlPattern: "human-review-required", ruleRef: "Trusted accepted-offer intake",
        title: "Trusted source event received",
        detail: `Source ${caller.sourceIdentity} supplied ${event.eventType}; its acceptance evidence reference is retained in the restricted intake register. The case is held for review and no messages or provider work were started.`,
        idempotencyKey: `standard-intake:${caller.sourceId}:${event.sourceEventId}`,
      }).onConflictDoNothing();
      return {
        sourceEventId: event.sourceEventId, status: "created", caseId: created.id,
        profileId: policy.profile.profileId, profileVersion: policy.profile.profileVersion,
      };
    });
  });
}

export async function commitStandardIntake(req: Request, res: Response, next: NextFunction) {
  try {
    const values = eventArray(req.body);
    if (!values.length) return void res.status(400).json({ message: "Provide 1–500 source events." });
    const organizationId = getOrganizationId(req);
    const caller = currentCaller(req);
    const validated = validateStandardIntakeRows(values);
    const results: IntakeResult[] = [];
    for (const row of validated) {
      const event = row.event;
      if (!event || row.errors.length) {
        results.push({ index: row.index, sourceEventId: event?.sourceEventId, status: "invalid", errors: row.errors });
        continue;
      }
      try {
        results.push({ index: row.index, ...await commitOne(organizationId, caller, event) });
      } catch (error) {
        results.push({
          index: row.index, sourceEventId: event.sourceEventId, status: "blocked",
          message: error instanceof Error ? error.message : "The source event could not be committed.",
        });
      }
    }
    const hasCreated = results.some((row) => row.status === "created");
    const hasFailure = results.some((row) => !["created", "reconciled"].includes(row.status));
    res.status(hasFailure ? 207 : hasCreated ? 201 : 200).json({
      sourceId: caller.sourceId,
      replay: req.path.endsWith("/replay"),
      results,
      summary: {
        created: results.filter((row) => row.status === "created").length,
        reconciled: results.filter((row) => row.status === "reconciled").length,
        unresolved: results.filter((row) => !["created", "reconciled"].includes(row.status)).length,
      },
    });
  } catch (error) {
    next(error);
  }
}

router.post("/onboarding/standard-intake/preview", requireStandardIntakeAdministratorMiddleware, preview);
router.post("/onboarding/standard-intake/events", requireStandardIntakeAdministratorMiddleware, commitStandardIntake);
router.post("/onboarding/standard-intake/replay", requireStandardIntakeAdministratorMiddleware, commitStandardIntake);

/**
 * This narrow, administrator-only read exposes the source-system evidence
 * reference at Gate A. It intentionally returns no offer artifact and is
 * separate from the broadly visible activity feed.
 */
router.get("/onboarding/cases/:caseId/standard-intake-evidence", async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (!Number.isInteger(caseId) || caseId < 1) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    if (!await requireStandardIntakeEvidenceAuthority(req, res, organizationId, caseId)) return;
    const sources = await db.select({
      sourceId: onbStandardIntakeEvents.sourceId,
      sourceIdentity: onbStandardIntakeEvents.sourceIdentity,
      sourceEventId: onbStandardIntakeEvents.sourceEventId,
      eventType: onbStandardIntakeEvents.eventType,
      acceptanceEvidenceReference: onbStandardIntakeEvents.acceptanceEvidenceReference,
      activationDueAt: onbStandardIntakeEvents.activationDueAt,
      activationStatus: onbStandardIntakeEvents.activationStatus,
      activationReviewRequestedAt: onbStandardIntakeEvents.activationReviewRequestedAt,
      activationReleasedAt: onbStandardIntakeEvents.activationReleasedAt,
      receivedAt: onbStandardIntakeEvents.createdAt,
      state: onbStandardIntakeEvents.state,
    }).from(onbStandardIntakeEvents).where(and(
      eq(onbStandardIntakeEvents.organizationId, organizationId),
      eq(onbStandardIntakeEvents.caseId, caseId),
      eq(onbStandardIntakeEvents.state, "created"),
    )).limit(2);
    if (sources.length > 1) {
      res.status(409).json({ message: "Multiple canonical standard intake events are associated with this case; resolve the intake record ambiguity before viewing evidence." });
      return;
    }
    const source = sources[0];
    if (!source) {
      res.status(404).json({ message: "No standard intake source event is associated with this case." });
      return;
    }
    res.json({
      ...source,
      activationDueAt: source.activationDueAt?.toISOString() ?? null,
      activationReviewRequestedAt: source.activationReviewRequestedAt?.toISOString() ?? null,
      activationReleasedAt: source.activationReleasedAt?.toISOString() ?? null,
      receivedAt: source.receivedAt.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * An explicit staff action moves an inert standard-intake case to the existing
 * engine. It does not mark Gate A complete: the engine creates the normal
 * authority-bound Gate A review and only its existing confirmation can pass it.
 */
router.post("/onboarding/cases/:caseId/standard-intake/release", async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (!Number.isInteger(caseId) || caseId < 1) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    if (!await requireStandardIntakeEvidenceAuthority(req, res, organizationId, caseId)) return;
    const outcome = await withSensitiveLifecycleFence(organizationId, () => db.transaction(async (tx) => {
      await acquireCaseDispatchMutationLock(tx, organizationId, caseId);
      const canonicalRows = await tx.select({
        case: onbCases,
        eventType: onbStandardIntakeEvents.eventType,
        activationDueAt: onbStandardIntakeEvents.activationDueAt,
        activationStatus: onbStandardIntakeEvents.activationStatus,
        sourceId: onbStandardIntakeEvents.sourceId,
        sourceEventId: onbStandardIntakeEvents.sourceEventId,
      }).from(onbStandardIntakeEvents).innerJoin(onbCases, and(
        eq(onbStandardIntakeEvents.organizationId, onbCases.organizationId),
        eq(onbStandardIntakeEvents.caseId, onbCases.id),
      )).where(and(
        eq(onbStandardIntakeEvents.organizationId, organizationId),
        eq(onbStandardIntakeEvents.caseId, caseId),
        eq(onbStandardIntakeEvents.state, "created"),
      )).limit(2).for("update");
      if (!canonicalRows.length) return { kind: "not-found" as const };
      if (canonicalRows.length > 1) return { kind: "canonical-ambiguous" as const };
      const row = canonicalRows[0]!;
      if (row.case.checklistSnapshot.some((item) =>
        item.id === "policy-rebase-required" && item.enabled && item.mandatory,
      )) return { kind: "policy-rebase-required" as const };
      if (!scheduledPreboardingCanActivate(row.eventType, row.case.joiningDate)) {
        return { kind: "scheduled-date-due" as const };
      }
      if (row.eventType === "scheduled-preboarding" && !scheduledPreboardingReviewIsDue(
        row.eventType,
        row.activationDueAt,
      )) return { kind: "scheduled-not-due" as const, dueAt: row.activationDueAt };
      if (row.eventType === "scheduled-preboarding" && row.activationStatus !== "due-review") {
        return { kind: "scheduled-review-not-queued" as const };
      }
      if (row.case.orchestrationStatus !== "standard-intake-pending-review") {
        return { kind: "already-released" as const, status: row.case.orchestrationStatus };
      }
      const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
        organizationId,
        jurisdiction: jurisdictionForWorkforceContext(row.case.workforceContext),
      });
      if (!lifecycle.allowed) return { kind: "lifecycle-blocked" as const, message: lifecycle.reason };
      const [canonicalReleased] = await tx.update(onbStandardIntakeEvents).set({
        activationStatus: "released",
        activationReleasedAt: new Date(),
        activationReleasedBy: req.authUserId!,
      }).where(and(
        eq(onbStandardIntakeEvents.organizationId, organizationId),
        eq(onbStandardIntakeEvents.sourceId, row.sourceId),
        eq(onbStandardIntakeEvents.sourceEventId, row.sourceEventId),
        eq(onbStandardIntakeEvents.state, "created"),
        eq(onbStandardIntakeEvents.activationStatus, row.activationStatus),
      )).returning({ sourceEventId: onbStandardIntakeEvents.sourceEventId });
      if (!canonicalReleased) return { kind: "canonical-changed" as const };
      const [released] = await tx.update(onbCases).set({
        orchestrationStatus: "idle",
        orchestrationCheckpoint: null,
        updatedAt: new Date(),
      }).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId))).returning();
      await tx.insert(onbEvents).values({
        organizationId, caseId, agent: "standard-intake-review", engine: "human",
        hitlPattern: "approve-before-act", ruleRef: "Standard intake release",
        title: "Standard intake case released for Offer-Acceptance Package",
        detail: `An authorized administrator reviewed the restricted TA source evidence reference and released this ${row.eventType} case to the existing onboarding engine. Offer-Acceptance Package remains required before any downstream onboarding work.`,
        idempotencyKey: `standard-intake-release:${row.sourceId}:${row.sourceEventId}`,
      }).onConflictDoNothing();
      return { kind: "released" as const, case: released };
    }));
    if (outcome.kind === "not-found") return void res.status(404).json({ message: "Standard intake case not found in this organization." });
    if (outcome.kind === "canonical-ambiguous") return void res.status(409).json({ message: "Multiple canonical standard intake events are associated with this case; resolve the intake record ambiguity before release." });
    if (outcome.kind === "policy-rebase-required") return void res.status(409).json({ message: "This standard intake case has a pending workforce context correction. Rebase its policy before release." });
    if (outcome.kind === "scheduled-date-due") return void res.status(409).json({ message: "Scheduled preboarding can only be released before its joining date. Escalate this now-due intake event instead of starting a late preboarding workflow." });
    if (outcome.kind === "scheduled-not-due") return void res.status(409).json({ message: `Scheduled preboarding is not due for HR release until ${outcome.dueAt?.toISOString() ?? "its scheduled review time"}.` });
    if (outcome.kind === "scheduled-review-not-queued") return void res.status(409).json({ message: "Scheduled preboarding is awaiting its durable HR review queue. Refresh after the scheduler heartbeat has recorded the due review." });
    if (outcome.kind === "already-released") return void res.status(409).json({ message: `This case is no longer held for standard intake review (status: ${outcome.status}).` });
    if (outcome.kind === "lifecycle-blocked") return void res.status(409).json({ message: outcome.message });
    if (outcome.kind === "canonical-changed") return void res.status(409).json({ message: "The canonical standard intake event changed while release was being reviewed. Refresh and retry." });
    startOrchestration(caseId);
    res.json({ caseId, orchestrationStatus: outcome.case.orchestrationStatus, gateAWillBeRequired: true });
  } catch (error) {
    next(error);
  }
});

export default router;