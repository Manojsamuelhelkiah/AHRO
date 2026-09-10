import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbApprovals,
  onbCandidateUploads,
  onbCases,
  onbDocuments,
  onbEvents,
  onbReadinessSlaAttestations,
  onbReadinessSlaCaseState,
  onbReadinessSlaLedger,
  onbReadinessSlaOutbox,
  onbReadinessSlaPolicies,
  onbReadinessSlaSnapshots,
  onbSystemChecks,
  type OnbReadinessSlaPolicy,
  type OnbReadinessSlaPolicyRow,
  type OnbReadinessSlaSnapshotRow,
  type OnbReadinessSlaStreamKey,
} from "@workspace/db/schema";
import {
  calculateReadinessSlaScore,
  calculateReadinessSlaActionTiming,
  actionStatusAt,
  defaultReadinessSlaPolicy,
  deriveStreamResult,
  readinessSlaApplicability,
  type ReadinessSlaActionTiming,
  type ReadinessSlaCaseProfile,
  type ReadinessSlaScore,
  type ReadinessSlaStreamResult,
  validateReadinessSlaPolicy,
} from "./readiness-sla";
import type { OnboardingDbTransaction } from "./settings";
import { isValidEmail } from "./settings";
import { reopenApprovalInTransaction } from "./approval-version";
import { isSyntheticOfflineCase } from "./synthetic-offline";

type CaseRow = typeof onbCases.$inferSelect;
type SlaTx = Pick<OnboardingDbTransaction, "select" | "insert" | "update" | "execute">;

export type ReadinessSlaActionView = {
  key: string;
  streamKey: string;
  label: string;
  owner: string;
  backupEmail: string | null;
  notifyEmail: boolean;
  notifyInApp: boolean;
  mandatory: boolean;
  status: "scheduled" | "warning" | "breach" | "escalated" | "resolved" | "needs-configuration";
  dueAt: string | null;
  warningAt: string | null;
  escalationAt: string | null;
  reason: string;
};

export type ReadinessSlaView = {
  caseId: number;
  enrolled: boolean;
  snapshotVersion: number | null;
  policyVersion: number | null;
  score: number;
  band: ReadinessSlaScore["band"];
  passes: boolean;
  thresholds: { green: 100; amberMinimum: 80 };
  streams: ReadinessSlaStreamResult[];
  actions: ReadinessSlaActionView[];
  payrollCutoff: string | null;
  history: Array<{
    actionKey: string;
    state: string;
    at: string;
    rationale: string;
  }>;
  reason: string;
};

export function currentPolicyFromRow(row: OnbReadinessSlaPolicyRow | undefined): {
  version: number;
  policy: OnbReadinessSlaPolicy;
} {
  return row
    ? { version: row.version, policy: validateReadinessSlaPolicy(row.policy) }
    : { version: 0, policy: defaultReadinessSlaPolicy() };
}

export async function getEffectiveReadinessSlaPolicy(
  organizationId: string,
): Promise<{ version: number; policy: OnbReadinessSlaPolicy }> {
  const [row] = await db
    .select()
    .from(onbReadinessSlaPolicies)
    .where(eq(onbReadinessSlaPolicies.organizationId, organizationId))
    .orderBy(desc(onbReadinessSlaPolicies.version))
    .limit(1);
  return currentPolicyFromRow(row);
}

export async function saveReadinessSlaPolicy(input: {
  organizationId: string;
  expectedVersion: number;
  policy: unknown;
  createdBy: string;
}): Promise<{ version: number; policy: OnbReadinessSlaPolicy }> {
  const policy = validateReadinessSlaPolicy(input.policy);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error("expectedVersion must be a non-negative integer");
  }
  return db.transaction(async (tx) => {
    await acquireReadinessSlaPolicyLock(tx, input.organizationId);
    const [current] = await tx
      .select()
      .from(onbReadinessSlaPolicies)
      .where(eq(onbReadinessSlaPolicies.organizationId, input.organizationId))
      .orderBy(desc(onbReadinessSlaPolicies.version))
      .limit(1);
    const currentVersion = current?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      const conflict = new Error(
        `Readiness SLA policy changed since it was loaded (current version ${currentVersion}).`,
      );
      conflict.name = "ReadinessSlaPolicyVersionConflict";
      throw conflict;
    }
    const version = currentVersion + 1;
    await tx.insert(onbReadinessSlaPolicies).values({
      organizationId: input.organizationId,
      version,
      policy,
      createdBy: input.createdBy,
    });
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: null,
      agent: "readiness-sla-policy",
      engine: "rules",
      hitlPattern: "notify-only",
      ruleRef: "Weighted readiness SLA policy",
      title: "Weighted readiness SLA policy published",
      detail: `Organization readiness SLA policy version ${version} was published by ${input.createdBy}; existing case snapshots remain unchanged.`,
      idempotencyKey: `readiness-sla-policy:${input.organizationId}:${version}`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    return { version, policy };
  });
}

export async function acquireReadinessSlaPolicyLock(
  tx: Pick<OnboardingDbTransaction, "execute">,
  organizationId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`readiness-sla-policy:${organizationId}`}))`);
}

function profileForCase(c: Pick<CaseRow, "hireType" | "workerCategory">): ReadinessSlaCaseProfile {
  return { hireType: c.hireType, workerCategory: c.workerCategory };
}

export async function reopenGateCApprovalInTransaction(
  tx: OnboardingDbTransaction,
  organizationId: string,
  caseId: number,
  reason: string,
  actor: string,
): Promise<void> {
  const [gateC] = await tx.select({ id: onbApprovals.id }).from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, organizationId),
    eq(onbApprovals.caseId, caseId),
    eq(onbApprovals.status, "approved"),
    sql`${onbApprovals.ruleRef} = 'Gate C — Day-1 readiness confirmation'`,
  )).for("update");
  if (!gateC) return;
  await reopenApprovalInTransaction(tx, {
    organizationId,
    caseId,
    approvalId: gateC.id,
    reason,
    actor,
  });
}

export type ReadinessSlaEnrollment = {
  snapshot: OnbReadinessSlaSnapshotRow;
  state: typeof onbReadinessSlaCaseState.$inferSelect;
};

/**
 * Close queued SLA notifications while the case lock is held. In-flight
 * claimed rows are intentionally untouched: their provider outcome is already
 * uncertain and the lease fencing/manual-reconciliation path owns them.
 */
export async function suppressReadinessSlaOutboxInTransaction(
  tx: SlaTx,
  organizationId: string,
  caseId: number,
  reason: string,
  ledgerId?: number,
): Promise<void> {
  await tx.update(onbReadinessSlaOutbox).set({
    status: "failed",
    deliveryInfo: `Suppressed: ${reason}. Terminal; no automatic retry.`,
    lastError: `sla-obligation-suppressed: ${reason}`.slice(0, 500),
    claimOwner: null,
    claimUntil: null,
    updatedAt: new Date(),
  }).where(and(
    eq(onbReadinessSlaOutbox.organizationId, organizationId),
    eq(onbReadinessSlaOutbox.caseId, caseId),
    eq(onbReadinessSlaOutbox.status, "pending"),
    ...(ledgerId === undefined ? [] : [eq(onbReadinessSlaOutbox.ledgerId, ledgerId)]),
  ));
}

/**
 * Enrollment is deliberately a write operation. GET handlers must use
 * getReadinessSlaView and return a not-enrolled representation instead.
 */
export async function ensureReadinessSlaEnrollment(
  organizationId: string,
  caseId: number,
  createdBy = "readiness-sla-worker",
  allowCompleted = false,
): Promise<ReadinessSlaEnrollment | null> {
  return db.transaction(async (tx) => {
    await acquireReadinessSlaPolicyLock(tx, organizationId);
    const [c] = await tx.select().from(onbCases).where(and(
      eq(onbCases.id, caseId),
      eq(onbCases.organizationId, organizationId),
    )).for("update");
    if (!c) return null;
    if (isSyntheticOfflineCase(c)) return null;
    const [existingState] = await tx.select().from(onbReadinessSlaCaseState).where(and(
      eq(onbReadinessSlaCaseState.caseId, caseId),
      eq(onbReadinessSlaCaseState.organizationId, organizationId),
    )).for("update");
    if (existingState) {
      const [snapshot] = await tx.select().from(onbReadinessSlaSnapshots).where(and(
        eq(onbReadinessSlaSnapshots.caseId, caseId),
        eq(onbReadinessSlaSnapshots.organizationId, organizationId),
        eq(onbReadinessSlaSnapshots.snapshotVersion, existingState.snapshotVersion),
      ));
      if (!snapshot) throw new Error("Readiness SLA enrollment points to a missing snapshot");
      return { snapshot, state: existingState };
    }
    // Historical complete cases are grandfathered; no policy replay occurs.
    if (c.lifecycleStage === "complete" && !allowCompleted) return null;
    let [policyRow] = await tx.select().from(onbReadinessSlaPolicies).where(
      eq(onbReadinessSlaPolicies.organizationId, organizationId),
    ).orderBy(desc(onbReadinessSlaPolicies.version)).limit(1);
    if (!policyRow) {
      const policy = defaultReadinessSlaPolicy();
      [policyRow] = await tx.insert(onbReadinessSlaPolicies).values({
        organizationId,
        version: 1,
        policy,
        createdBy: "system-default",
      }).returning();
    }
    if (!policyRow) throw new Error("Readiness SLA policy could not be resolved");
    const policy = validateReadinessSlaPolicy(policyRow.policy);
    const [snapshot] = await tx.insert(onbReadinessSlaSnapshots).values({
      organizationId,
      caseId,
      snapshotVersion: 1,
      policyVersion: policyRow.version,
      joiningDate: c.joiningDate,
      policy,
      applicability: readinessSlaApplicability(profileForCase(c)),
      createdBy,
    }).returning();
    const [state] = await tx.insert(onbReadinessSlaCaseState).values({
      organizationId,
      caseId,
      snapshotVersion: 1,
    }).returning();
    if (!snapshot || !state) throw new Error("Readiness SLA enrollment could not be persisted");
    await tx.insert(onbEvents).values({
      organizationId,
      caseId,
      agent: "readiness-sla",
      engine: "rules",
      hitlPattern: "notify-only",
      ruleRef: "Weighted readiness SLA enrollment",
      title: "Weighted readiness SLA enrolled",
      detail: `Case enrolled with readiness SLA policy snapshot ${policyRow.version}; five streams retain distinct source-of-truth boundaries.`,
      idempotencyKey: `readiness-sla:${caseId}:enrolled`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    return { snapshot, state };
  });
}

/** Used by legacy connector sweeps to avoid emitting a second timed SLA. */
export async function hasReadinessSlaEnrollment(
  organizationId: string,
  caseId: number,
): Promise<boolean> {
  const [state] = await db.select({ caseId: onbReadinessSlaCaseState.caseId })
    .from(onbReadinessSlaCaseState)
    .where(and(
      eq(onbReadinessSlaCaseState.organizationId, organizationId),
      eq(onbReadinessSlaCaseState.caseId, caseId),
    ))
    .limit(1);
  return Boolean(state);
}

/**
 * Connector checks retain their source-system status, but their displayed
 * deadline follows the immutable case snapshot once the readiness SLA is
 * enrolled. A null result means the legacy default may be used.
 */
export async function readinessSlaDueAtForSystem(
  organizationId: string,
  caseId: number,
  system: "bgv" | "itsm" | "payroll",
): Promise<Date | null> {
  const [c] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, organizationId),
    eq(onbCases.id, caseId),
  ));
  if (!c) return null;
  const enrollment = await enrollmentForRead(organizationId, caseId);
  if (!enrollment) return null;
  const streamKey = system === "itsm" ? "it-assets" : system;
  const streamActions = enrollment.snapshot.policy.actions
    .filter((action) => action.enabled && action.streamKey === streamKey);
  // The watcher represents the source's result deadline. BGV initiation is a
  // separate human action and must not shorten the vendor-result check's
  // displayed dueAt.
  const actions = system === "bgv"
    ? streamActions.filter((action) => action.key === "bgv-result")
    : streamActions;
  const checks = await db.select().from(onbSystemChecks).where(and(
    eq(onbSystemChecks.organizationId, organizationId),
    eq(onbSystemChecks.caseId, caseId),
  ));
  const dueDates = (actions.length > 0 ? actions : streamActions)
    .map((action) => timingForAction(
      action,
      c,
      enrollment.state,
      enrollment.snapshot.joiningDate,
      actionStartFromChecks(action, checks),
    ).dueAt)
    .filter((dueAt): dueAt is Date => dueAt !== null);
  if (dueDates.length === 0) return null;
  return dueDates.reduce((earliest, dueAt) =>
    dueAt.getTime() < earliest.getTime() ? dueAt : earliest,
  );
}

async function enrollmentForRead(
  organizationId: string,
  caseId: number,
): Promise<ReadinessSlaEnrollment | null> {
  const [state] = await db.select().from(onbReadinessSlaCaseState).where(and(
    eq(onbReadinessSlaCaseState.caseId, caseId),
    eq(onbReadinessSlaCaseState.organizationId, organizationId),
  ));
  if (!state) return null;
  const [snapshot] = await db.select().from(onbReadinessSlaSnapshots).where(and(
    eq(onbReadinessSlaSnapshots.caseId, caseId),
    eq(onbReadinessSlaSnapshots.organizationId, organizationId),
    eq(onbReadinessSlaSnapshots.snapshotVersion, state.snapshotVersion),
  ));
  if (!snapshot) throw new Error("Readiness SLA enrollment points to a missing snapshot");
  return { snapshot, state };
}

async function resolveStreamResults(
  organizationId: string,
  c: CaseRow,
  snapshot: OnbReadinessSlaSnapshotRow,
  tx: SlaTx | typeof db = db,
): Promise<ReadinessSlaStreamResult[]> {
  const requiredDocuments = await tx.select({
    id: onbDocuments.id,
    status: onbDocuments.status,
  }).from(onbDocuments).where(and(
    eq(onbDocuments.organizationId, organizationId),
    eq(onbDocuments.caseId, c.id),
    eq(onbDocuments.required, true),
  ));
  const requiredDocumentIds = requiredDocuments.map((document) => document.id);
  const uploads = requiredDocumentIds.length === 0
    ? []
    : await tx.select({
      documentId: onbCandidateUploads.documentId,
      malwareScanState: onbCandidateUploads.malwareScanState,
      validationState: onbCandidateUploads.validationState,
    }).from(onbCandidateUploads).where(and(
      eq(onbCandidateUploads.organizationId, organizationId),
      eq(onbCandidateUploads.caseId, c.id),
      inArray(onbCandidateUploads.documentId, requiredDocumentIds),
    ));
  const docsComplete = requiredDocuments.every((document) => document.status === "verified")
    && uploads.every((upload) => upload.malwareScanState === "clean" && upload.validationState === "passed");
  const docsReason = docsComplete
    ? "All required documents are verified and every associated upload is malware-clean"
    : "Required document verification and malware-safe upload evidence are incomplete";

  const checks = await tx.select().from(onbSystemChecks).where(and(
    eq(onbSystemChecks.organizationId, organizationId),
    eq(onbSystemChecks.caseId, c.id),
  ));
  const bgvCheck = checks.find((check) => check.system === "bgv");
  const payrollCheck = checks.find((check) => check.system === "payroll");
  const attestation = await tx.select().from(onbReadinessSlaAttestations).where(and(
    eq(onbReadinessSlaAttestations.organizationId, organizationId),
    eq(onbReadinessSlaAttestations.caseId, c.id),
    eq(onbReadinessSlaAttestations.snapshotVersion, snapshot.snapshotVersion),
    eq(onbReadinessSlaAttestations.streamKey, "hris"),
  )).orderBy(desc(onbReadinessSlaAttestations.id)).limit(1);
  const readiness = c.readiness ?? [];
  const access = readiness.find((item) => item.key === "access");
  const assets = readiness.find((item) => item.key === "assets");
  const payroll = readiness.find((item) => item.key === "payroll");
  const streamsByKey = new Map(snapshot.policy.streams.map((stream) => [stream.key, stream]));
  const applicability = new Map(snapshot.applicability.map((item) => [item.key, item]));
  const make = (
    key: OnbReadinessSlaStreamKey,
    complete: boolean,
    reason: string,
    completedAt?: Date | string | null,
  ) => {
    const stream = streamsByKey.get(key);
    const applies = applicability.get(key);
    if (!stream || !applies) throw new Error(`Readiness SLA snapshot is missing ${key}`);
    return deriveStreamResult({
      key,
      label: stream.label,
      weight: stream.weight,
      applicability: applies,
      complete,
      reason,
      completedAt,
    });
  };
  return [
    make("documentation", docsComplete, docsReason),
    make("bgv", bgvCheck?.status === "done", bgvCheck?.status === "done"
      ? "Current tracked BGV check reported done"
      : "Current tracked BGV check is not done", bgvCheck?.completedAt),
    make("hris", attestation[0]?.complete === true, attestation[0]?.complete
      ? `HRIS completion attested by ${attestation[0].attestedBy} at ${attestation[0].createdAt.toISOString()}`
      : "Separate HRIS attestation with timestamp and reason is required", attestation[0]?.complete ? attestation[0].createdAt : null),
    make("it-assets", access?.status === "ready" && assets?.status === "ready",
      access?.status === "ready" && assets?.status === "ready"
        ? "Existing access and assets readiness are both ready"
        : "Both existing access and assets readiness must be ready"),
    make("payroll", payroll?.status === "ready" && payrollCheck?.status === "done",
      payroll?.status === "ready" && payrollCheck?.status === "done"
        ? "Existing payroll check and payroll readiness are both ready"
        : "Existing payroll check and payroll readiness must both be ready", payrollCheck?.completedAt),
  ];
}

function timingForAction(
  action: OnbReadinessSlaPolicy["actions"][number],
  c: CaseRow,
  state: typeof onbReadinessSlaCaseState.$inferSelect,
  joiningDate: string | null = c.joiningDate,
  actionStartedAt: Date | null = null,
): ReadinessSlaActionTiming {
  return calculateReadinessSlaActionTiming({
    action,
    joiningDate,
    actionStartedAt,
    payrollCutoff: state.payrollCutoff,
  });
}

function actionStartFromChecks(
  action: OnbReadinessSlaPolicy["actions"][number],
  checks: Array<typeof onbSystemChecks.$inferSelect>,
): Date | null {
  const system = action.streamKey === "bgv"
    ? "bgv"
    : action.streamKey === "it-assets"
      ? "itsm"
      : action.streamKey === "payroll"
        ? "payroll"
        : null;
  if (!system) return null;
  return checks.find((check) => check.system === system)?.requestedAt ?? null;
}

export async function getReadinessSlaView(
  organizationId: string,
  caseId: number,
): Promise<ReadinessSlaView | null> {
  const [c] = await db.select().from(onbCases).where(and(
    eq(onbCases.id, caseId),
    eq(onbCases.organizationId, organizationId),
  ));
  if (!c) return null;
  const enrollment = await enrollmentForRead(organizationId, caseId);
  if (!enrollment) {
    const applicability = readinessSlaApplicability(profileForCase(c));
    const policy = (await getEffectiveReadinessSlaPolicy(organizationId)).policy;
    const streams = policy.streams.map((stream) => deriveStreamResult({
      key: stream.key,
      label: stream.label,
      weight: stream.weight,
      applicability: applicability.find((item) => item.key === stream.key)!,
      complete: false,
      reason: "Case is not enrolled; no historical policy replay occurred",
    }));
    return {
      caseId,
      enrolled: false,
      snapshotVersion: null,
      policyVersion: null,
      ...calculateReadinessSlaScore(streams, false),
      thresholds: { green: 100, amberMinimum: 80 },
      streams,
      actions: [],
      payrollCutoff: null,
      history: [],
      reason: c.lifecycleStage === "complete"
        ? "Historical completed case is grandfathered and was not replay-enrolled"
        : "Case has not been enrolled yet; enrollment is required before Gate C uses this score",
    };
  }
  const streams = await resolveStreamResults(organizationId, c, enrollment.snapshot);
  const score = calculateReadinessSlaScore(
    streams,
    streams.some((stream) => stream.applicable && stream.status !== "complete"),
  );
  const ledgerRows = await db.select().from(onbReadinessSlaLedger).where(and(
    eq(onbReadinessSlaLedger.organizationId, organizationId),
    eq(onbReadinessSlaLedger.caseId, caseId),
    eq(onbReadinessSlaLedger.snapshotVersion, enrollment.snapshot.snapshotVersion),
  )).orderBy(desc(onbReadinessSlaLedger.occurrence), desc(onbReadinessSlaLedger.id));
  const latestLedger = new Map<string, typeof ledgerRows[number]>();
  for (const row of ledgerRows) {
    if (!latestLedger.has(row.actionKey)) latestLedger.set(row.actionKey, row);
  }
  const actionStartChecks = await db.select().from(onbSystemChecks).where(and(
    eq(onbSystemChecks.organizationId, organizationId),
    eq(onbSystemChecks.caseId, caseId),
  ));
  const actions = enrollment.snapshot.policy.actions
    .filter((action) => action.enabled)
    .map((action) => {
      const timing = timingForAction(
        action,
        c,
        enrollment.state,
        enrollment.snapshot.joiningDate,
        actionStartFromChecks(action, actionStartChecks),
      );
      const ledger = latestLedger.get(action.key);
      const status = ledger?.state === "warned"
        ? "warning" as const
        : ledger?.state === "breached"
          ? "breach" as const
          : ledger?.state === "escalated"
            ? "escalated" as const
            : ledger?.state === "resolved"
              ? "resolved" as const
              : timing.status === "needs-configuration"
        ? "needs-configuration" as const
        : action.streamKey && streams.find((stream) => stream.key === action.streamKey)?.status === "complete"
          ? "resolved" as const
          : "scheduled" as const;
      return {
        key: action.key,
        streamKey: action.streamKey,
        label: action.label,
        owner: action.owner,
        backupEmail: action.backupEmail,
        notifyEmail: action.notifyEmail,
        notifyInApp: action.notifyInApp,
        mandatory: action.mandatory,
        status,
        dueAt: timing.dueAt?.toISOString() ?? null,
        warningAt: timing.warningAt?.toISOString() ?? null,
        escalationAt: timing.escalationAt?.toISOString() ?? null,
        reason: timing.reason,
      };
    });
  return {
    caseId,
    enrolled: true,
    snapshotVersion: enrollment.snapshot.snapshotVersion,
    policyVersion: enrollment.snapshot.policyVersion,
    ...score,
    thresholds: { green: 100, amberMinimum: 80 },
    streams,
    actions,
    payrollCutoff: enrollment.state.payrollCutoff?.toISOString() ?? null,
    history: ledgerRows.flatMap((row) => row.history.map((entry) => ({
      actionKey: row.actionKey,
      state: entry.state,
      at: entry.at,
      rationale: entry.rationale,
    }))),
    reason: score.reason,
  };
}

/** Tenant/case-bound adapter used by contextual contact. */
export async function resolveReadinessSlaAction(input: {
  actionId: string;
  organizationId: string;
  caseId: number;
}): Promise<{
  id: string;
  organizationId: string;
  caseId: number;
  snapshotRevision: number;
  status: string;
  dueAt: Date | null;
  candidateRelevant: boolean;
  actionKind: string;
  ownerEmail: string | null;
  backupEmail: string | null;
  reason: string;
} | null> {
  const [c] = await db.select().from(onbCases).where(and(
    eq(onbCases.id, input.caseId),
    eq(onbCases.organizationId, input.organizationId),
  ));
  if (!c) return null;
  const enrollment = await enrollmentForRead(input.organizationId, input.caseId);
  if (!enrollment) return null;
  const action = enrollment.snapshot.policy.actions.find((item) => item.key === input.actionId && item.enabled);
  if (!action) return null;
  const actionStartChecks = await db.select().from(onbSystemChecks).where(and(
    eq(onbSystemChecks.organizationId, input.organizationId),
    eq(onbSystemChecks.caseId, input.caseId),
  ));
  const timing = timingForAction(
    action,
    c,
    enrollment.state,
    enrollment.snapshot.joiningDate,
    actionStartFromChecks(action, actionStartChecks),
  );
  const [ledger] = await db.select().from(onbReadinessSlaLedger).where(and(
    eq(onbReadinessSlaLedger.organizationId, input.organizationId),
    eq(onbReadinessSlaLedger.caseId, input.caseId),
    eq(onbReadinessSlaLedger.snapshotVersion, enrollment.snapshot.snapshotVersion),
    eq(onbReadinessSlaLedger.actionKey, action.key),
  )).orderBy(desc(onbReadinessSlaLedger.occurrence)).limit(1);
  const status = ledger?.state === "warned"
    ? "warning"
    : ledger?.state === "breached"
      ? "breach"
      : ledger?.state === "escalated"
        ? "escalated"
        : ledger?.state === "resolved"
          ? "resolved"
          : actionStatusAt(timing);
  return {
    id: action.key,
    organizationId: input.organizationId,
    caseId: input.caseId,
    snapshotRevision: enrollment.snapshot.snapshotVersion,
    status,
    dueAt: timing.dueAt,
    candidateRelevant: action.streamKey === "documentation",
    actionKind: action.streamKey,
    ownerEmail: isValidEmail(action.owner) ? action.owner : null,
    backupEmail: action.backupEmail,
    reason: timing.reason,
  };
}

/**
 * Typed Gate C hook. It takes a transaction so the approval agent can call it
 * while holding the same case lock as the existing final decision.
 */
export async function readinessSlaGateForCase(
  tx: SlaTx,
  organizationId: string,
  caseId: number,
): Promise<ReadinessSlaView> {
  const [c] = await tx.select().from(onbCases).where(and(
    eq(onbCases.id, caseId),
    eq(onbCases.organizationId, organizationId),
  ));
  if (!c) throw new Error("Case not found for readiness SLA gate");
  const [state] = await tx.select().from(onbReadinessSlaCaseState).where(and(
    eq(onbReadinessSlaCaseState.caseId, caseId),
    eq(onbReadinessSlaCaseState.organizationId, organizationId),
  ));
  // Before rollout, and for already-complete history, preserve old engine
  // authority. Active un-enrolled cases fail closed until the create/worker
  // hook enrolls them and gives HR a dedicated HRIS attestation path.
  if (!state) {
    const policy = defaultReadinessSlaPolicy();
    const applicability = readinessSlaApplicability(profileForCase(c));
    const streams = policy.streams.map((stream) => deriveStreamResult({
      key: stream.key,
      label: stream.label,
      weight: stream.weight,
      applicability: applicability.find((item) => item.key === stream.key)!,
      complete: false,
      reason: "Case is not enrolled",
    }));
    const score = calculateReadinessSlaScore(streams, c.lifecycleStage !== "complete");
    return {
      caseId,
      enrolled: false,
      snapshotVersion: null,
      policyVersion: null,
      ...score,
      passes: c.lifecycleStage === "complete",
      thresholds: { green: 100, amberMinimum: 80 },
      streams,
      actions: [],
      payrollCutoff: null,
      history: [],
      reason: c.lifecycleStage === "complete"
        ? "Historical completed case is grandfathered"
        : "Readiness SLA enrollment is missing; Gate C fails closed",
    };
  }
  const [snapshot] = await tx.select().from(onbReadinessSlaSnapshots).where(and(
    eq(onbReadinessSlaSnapshots.organizationId, organizationId),
    eq(onbReadinessSlaSnapshots.caseId, caseId),
    eq(onbReadinessSlaSnapshots.snapshotVersion, state.snapshotVersion),
  ));
  if (!snapshot) throw new Error("Readiness SLA snapshot missing for Gate C");
  const streams = await resolveStreamResults(organizationId, c, snapshot, tx);
  const score = calculateReadinessSlaScore(streams);
  return {
    caseId,
    enrolled: true,
    snapshotVersion: snapshot.snapshotVersion,
    policyVersion: snapshot.policyVersion,
    ...score,
    thresholds: { green: 100, amberMinimum: 80 },
    streams,
    actions: [],
    payrollCutoff: state.payrollCutoff?.toISOString() ?? null,
    history: [],
    reason: score.reason,
  };
}

export async function rebaseReadinessSlaCase(input: {
  organizationId: string;
  caseId: number;
  expectedSnapshotVersion: number;
  reason: string;
  changedBy: string;
}): Promise<ReadinessSlaEnrollment> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("A reason is required for a readiness SLA rebase");
  return db.transaction(async (tx) => {
    await acquireReadinessSlaPolicyLock(tx, input.organizationId);
    const [c] = await tx.select().from(onbCases).where(and(
      eq(onbCases.id, input.caseId),
      eq(onbCases.organizationId, input.organizationId),
    )).for("update");
    if (!c) throw new Error("Case not found");
    const [state] = await tx.select().from(onbReadinessSlaCaseState).where(and(
      eq(onbReadinessSlaCaseState.caseId, input.caseId),
      eq(onbReadinessSlaCaseState.organizationId, input.organizationId),
    )).for("update");
    if (!state) throw new Error("Case is not enrolled in readiness SLA");
    if (state.snapshotVersion !== input.expectedSnapshotVersion) {
      const error = new Error(`Readiness SLA snapshot changed (current version ${state.snapshotVersion})`);
      error.name = "ReadinessSlaSnapshotVersionConflict";
      throw error;
    }
    if (c.lifecycleStage === "complete") {
      throw new Error("Completed cases cannot be rebased");
    }
    if (c.orchestrationStatus === "running" ||
      (c.orchestrationClaimUntil && c.orchestrationClaimUntil.getTime() > Date.now())) {
      throw new Error("Case has an active orchestration claim; rebase was rejected");
    }
    const [policyRow] = await tx.select().from(onbReadinessSlaPolicies).where(
      eq(onbReadinessSlaPolicies.organizationId, input.organizationId),
    ).orderBy(desc(onbReadinessSlaPolicies.version)).limit(1);
    const policy = policyRow ? validateReadinessSlaPolicy(policyRow.policy) : defaultReadinessSlaPolicy();
    const nextVersion = state.snapshotVersion + 1;
    const [snapshot] = await tx.insert(onbReadinessSlaSnapshots).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      snapshotVersion: nextVersion,
      policyVersion: policyRow?.version ?? 0,
      joiningDate: c.joiningDate,
      policy,
      applicability: readinessSlaApplicability(profileForCase(c)),
      createdBy: input.changedBy,
    }).returning();
    const [nextState] = await tx.update(onbReadinessSlaCaseState).set({
      snapshotVersion: nextVersion,
      updatedAt: new Date(),
    }).where(and(
      eq(onbReadinessSlaCaseState.organizationId, input.organizationId),
      eq(onbReadinessSlaCaseState.caseId, input.caseId),
      eq(onbReadinessSlaCaseState.snapshotVersion, input.expectedSnapshotVersion),
    )).returning();
    if (!snapshot || !nextState) throw new Error("Readiness SLA rebase was concurrently changed");
    await suppressReadinessSlaOutboxInTransaction(
      tx,
      input.organizationId,
      input.caseId,
      `case snapshot rebased to version ${nextVersion}; prior obligation is superseded`,
    );
    await reopenGateCApprovalInTransaction(
      tx,
      input.organizationId,
      input.caseId,
      `Gate C reopened because the readiness policy snapshot was rebased: ${reason}`,
      input.changedBy,
    );
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "readiness-sla-policy",
      engine: "human",
      hitlPattern: "hard-block",
      ruleRef: "Weighted readiness SLA policy rebase",
      title: "Readiness SLA case snapshot rebased",
      detail: `${input.changedBy} rebased case snapshot ${input.expectedSnapshotVersion} to ${nextVersion}: ${reason}. Prior breach and notification history was preserved.`,
      idempotencyKey: `readiness-sla:${input.caseId}:rebase:${nextVersion}`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    return { snapshot, state: nextState };
  });
}

export async function setReadinessSlaPayrollCutoff(input: {
  organizationId: string;
  caseId: number;
  expectedSnapshotVersion: number;
  payrollCutoff: Date;
  reason: string;
  setBy: string;
}): Promise<ReadinessSlaEnrollment> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("A reason is required for the payroll cutoff");
  if (Number.isNaN(input.payrollCutoff.getTime())) throw new Error("Payroll cutoff must be a valid timestamp");
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(onbCases).where(and(
      eq(onbCases.id, input.caseId),
      eq(onbCases.organizationId, input.organizationId),
    )).for("update");
    if (!c) throw new Error("Case not found");
    const [state] = await tx.select().from(onbReadinessSlaCaseState).where(and(
      eq(onbReadinessSlaCaseState.caseId, input.caseId),
      eq(onbReadinessSlaCaseState.organizationId, input.organizationId),
    )).for("update");
    if (!state) throw new Error("Case is not enrolled in readiness SLA");
    if (state.snapshotVersion !== input.expectedSnapshotVersion) {
      const error = new Error(`Readiness SLA snapshot changed (current version ${state.snapshotVersion})`);
      error.name = "ReadinessSlaSnapshotVersionConflict";
      throw error;
    }
    const [nextState] = await tx.update(onbReadinessSlaCaseState).set({
      payrollCutoff: input.payrollCutoff,
      payrollCutoffReason: reason,
      payrollCutoffSetBy: input.setBy,
      payrollCutoffSetAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(onbReadinessSlaCaseState.organizationId, input.organizationId),
      eq(onbReadinessSlaCaseState.caseId, input.caseId),
      eq(onbReadinessSlaCaseState.snapshotVersion, input.expectedSnapshotVersion),
    )).returning();
    const [snapshot] = await tx.select().from(onbReadinessSlaSnapshots).where(and(
      eq(onbReadinessSlaSnapshots.organizationId, input.organizationId),
      eq(onbReadinessSlaSnapshots.caseId, input.caseId),
      eq(onbReadinessSlaSnapshots.snapshotVersion, input.expectedSnapshotVersion),
    ));
    if (!nextState || !snapshot) throw new Error("Payroll cutoff was concurrently changed");
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "readiness-sla",
      engine: "human",
      hitlPattern: "notify-only",
      ruleRef: "Weighted readiness payroll cutoff",
      title: "Case payroll cutoff configured",
      detail: `${input.setBy} set payroll cutoff to ${input.payrollCutoff.toISOString()}: ${reason}`,
      idempotencyKey: `readiness-sla:${input.caseId}:payroll-cutoff:${input.expectedSnapshotVersion}:${input.payrollCutoff.toISOString()}`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    return { snapshot, state: nextState };
  });
}

export async function recordReadinessSlaAttestation(input: {
  organizationId: string;
  caseId: number;
  streamKey: "hris";
  complete: boolean;
  expectedSnapshotVersion: number;
  reason: string;
  attestedBy: string;
  attestedRole: string;
}): Promise<typeof onbReadinessSlaAttestations.$inferSelect> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("A reason is required for a readiness attestation");
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(onbCases).where(and(
      eq(onbCases.id, input.caseId),
      eq(onbCases.organizationId, input.organizationId),
    )).for("update");
    if (!c) throw new Error("Case not found");
    const [state] = await tx.select().from(onbReadinessSlaCaseState).where(and(
      eq(onbReadinessSlaCaseState.caseId, input.caseId),
      eq(onbReadinessSlaCaseState.organizationId, input.organizationId),
    )).for("update");
    if (!state) throw new Error("Case is not enrolled in readiness SLA");
    if (state.snapshotVersion !== input.expectedSnapshotVersion) {
      const error = new Error(`Readiness SLA snapshot changed (current version ${state.snapshotVersion})`);
      error.name = "ReadinessSlaSnapshotVersionConflict";
      throw error;
    }
    const [row] = await tx.insert(onbReadinessSlaAttestations).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      snapshotVersion: input.expectedSnapshotVersion,
      streamKey: input.streamKey,
      complete: input.complete,
      reason,
      attestedBy: input.attestedBy,
      attestedRole: input.attestedRole,
    }).returning();
    if (!row) throw new Error("Readiness attestation could not be recorded");
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "readiness-sla",
      engine: "human",
      hitlPattern: "hard-block",
      ruleRef: "Weighted readiness HRIS attestation",
      title: input.complete ? "HRIS readiness attested" : "HRIS readiness reopened",
      detail: `${input.attestedBy} (${input.attestedRole}) ${input.complete ? "attested completion" : "reopened readiness"} for the separate HRIS stream: ${reason}`,
      idempotencyKey: `readiness-sla:${input.caseId}:hris-attestation:${row.id}`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    if (!input.complete) {
      await reopenGateCApprovalInTransaction(
        tx,
        input.organizationId,
        input.caseId,
        "Gate C reopened because HRIS readiness regressed; fresh readiness review is required.",
        input.attestedBy,
      );
    }
    return row;
  });
}
