import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  and, asc, desc, eq, gt, inArray, isNull, lte, or, sql,
} from "drizzle-orm";
import {
  db,
  pool,
  onbActionCenterActions,
  onbApprovals,
  onbApprovalHistory,
  onbApprovalNotifications,
  onbCandidateLinks,
  onbCandidateSessions,
  onbCandidateUploads,
  onbCandidateUploadReservations,
  onbCallSlots,
  onbCaseLogistics,
  onbCases,
  onbCommunications,
  onbDocuments,
  onbEarlyTenureAssignments,
  onbEarlyTenureCaseSnapshots,
  onbEarlyTenureCheckins,
  onbEarlyTenureEvidence,
  onbEarlyTenureReminders,
  onbEarlyTenureSurveyResponses,
  onbEmploymentOutcomeEvidence,
  onbOutcomeEvidenceAuthorityReceipts,
  onbEmployeeRecords,
  onbEvents,
  onbFrontlineEvidence,
  onbFrontlineFulfillments,
  onbFrontlineKpiInputs,
  onbFrontlinePolicyExceptions,
  onbFrontlineReleaseState,
  onbGovernanceAuthorityAssignments,
  onbGuardrailEvents,
  onbIntakeBatchPeople,
  onbPolicyAuthorities,
  onbPolicyEvidence,
  onbProbationDecisions,
  onbReadinessSlaAttestations,
  onbReadinessSlaCaseState,
  onbReadinessSlaLedger,
  onbReadinessSlaOutbox,
  onbReadinessSlaSnapshots,
  onbSettings,
  onbStandardIntakeEvents,
  onbStandardProviderSourceRecords,
  onbSensitiveLifecycleConfirmations,
  onbSensitiveLifecycleDeletionJobs,
  onbSensitiveLifecycleHolds,
  onbSensitiveLifecyclePolicies,
  onbSensitiveLifecycleScanCursors,
  onbSensitiveObjectDerivatives,
  onbSensitiveObjectManifests,
  onbSystemChecks,
  onbWatchEmails,
  onbVoiceSessions,
  organizationMembershipsTable,
} from "@workspace/db";
import { getPrivateFile } from "../objectStorage";
import { logger } from "../logger";
import { appendProtectedAuditInTransaction } from "./protected-audit";
import { makeSharedTick } from "./shared-tick";

export const SENSITIVE_DATA_CLASSES = [
  "candidate-document",
  "identity",
  "medical",
  "payroll",
  "bgv",
  "candidate-contact",
  "candidate-voice",
  "candidate-portal",
] as const;
export type SensitiveDataClass = typeof SENSITIVE_DATA_CLASSES[number];
// Every class has a server-owned minimisation handler. Opaque case-derived
// text is never guessed into a class: it requires all current class policies.
const DELETION_SUPPORTED_CLASSES = new Set<SensitiveDataClass>([
  "candidate-document", "identity", "medical", "payroll", "bgv",
  "candidate-contact", "candidate-voice", "candidate-portal",
]);
const OPAQUE_CASE_DERIVED_CLASSES = [...SENSITIVE_DATA_CLASSES] as const;
// A candidate-upload object is opaque private byte content. Its document
// labels may help route a review, but cannot prove the absence of another
// sensitive class in the bytes. Every lifecycle boundary therefore treats
// every candidate upload (including legacy manifest/reservation records) as
// requiring the complete class set.
export const OPAQUE_CANDIDATE_UPLOAD_CLASSES = [...SENSITIVE_DATA_CLASSES] as const;

export function effectiveSensitiveDataClassesForCandidateUpload(): readonly SensitiveDataClass[] {
  return OPAQUE_CANDIDATE_UPLOAD_CLASSES;
}
// These are server-owned, case-derived setting namespaces. They are deliberately
// local constants rather than importing their writers, which prevents a
// lifecycle/write-boundary module cycle.
const OPERATIONAL_REQUEST_SETTING_PREFIX = "operational_requests:";
const DEMO_RUN_SETTING_PREFIX = "demo-controller.run.v1:";

export class SensitiveLifecycleValidationError extends Error {}
export class SensitiveLifecyclePermissionError extends Error {}
export class SensitiveLifecycleConflictError extends Error {}

type PolicyInput = {
  dataClass: SensitiveDataClass;
  jurisdiction: string;
  purpose: string;
  lawfulBasis: string;
  retentionDays: number;
  providerSharingApproved: boolean;
  permittedProviders: string[];
  policyReference: string;
  approvalReference: string;
  expectedRevision: number;
};

const MAX_TEXT = 2_000;
const MAX_RETENTION_DAYS = 365_000;
const CONFIRMATION_PHRASE = "AUTHORIZE RETENTION SHORTENING";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SensitiveLifecycleValidationError(`${name} is required.`);
  }
  const result = value.trim();
  if (result.length > MAX_TEXT) throw new SensitiveLifecycleValidationError(`${name} is too long.`);
  return result;
}

/** Jurisdiction is an explicitly recorded work location, never legal entity. */
export function jurisdictionForWorkforceContext(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = value as { workCountry?: unknown; workState?: unknown };
  const country = typeof context.workCountry === "string" ? context.workCountry.trim().toUpperCase() : "";
  const state = typeof context.workState === "string" ? context.workState.trim().toUpperCase() : "";
  // Do not infer a country from the employer entity or a bare state/province.
  if (!/^[A-Z]{2,3}$/.test(country) || (state && !/^[A-Z0-9 -]{2,40}$/.test(state))) return null;
  return state ? `${country}-${state}` : country;
}

function policyInput(value: unknown): PolicyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SensitiveLifecycleValidationError("A policy object is required.");
  }
  const body = value as Record<string, unknown>;
  if (!SENSITIVE_DATA_CLASSES.includes(body.dataClass as SensitiveDataClass)) {
    throw new SensitiveLifecycleValidationError("dataClass is not a supported sensitive data class.");
  }
  const retentionDays = body.retentionDays;
  if (typeof retentionDays !== "number" || !Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > MAX_RETENTION_DAYS) {
    throw new SensitiveLifecycleValidationError("retentionDays must be a non-negative approved number of days.");
  }
  const expectedRevision = body.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new SensitiveLifecycleValidationError("expectedRevision must be a non-negative integer.");
  }
  if (typeof body.providerSharingApproved !== "boolean") {
    throw new SensitiveLifecycleValidationError("providerSharingApproved must be explicitly true or false.");
  }
  if (!Array.isArray(body.permittedProviders) ||
    body.permittedProviders.some((provider) => typeof provider !== "string" || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(provider))) {
    throw new SensitiveLifecycleValidationError("permittedProviders must be concrete lowercase provider identifiers.");
  }
  const permittedProviders = [...new Set(body.permittedProviders)];
  if (body.providerSharingApproved !== (permittedProviders.length > 0)) {
    throw new SensitiveLifecycleValidationError("providerSharingApproved must exactly match whether permittedProviders is non-empty.");
  }
  return {
    dataClass: body.dataClass as SensitiveDataClass,
    jurisdiction: text(body.jurisdiction, "jurisdiction"),
    purpose: text(body.purpose, "purpose"),
    lawfulBasis: text(body.lawfulBasis, "lawfulBasis"),
    retentionDays,
    providerSharingApproved: body.providerSharingApproved,
    permittedProviders,
    policyReference: text(body.policyReference, "policyReference"),
    approvalReference: text(body.approvalReference, "approvalReference"),
    expectedRevision,
  };
}

type LifecycleFenceToken = {
  active: boolean;
  nested: number;
  idleWaiters: Set<() => void>;
};

const lifecycleFenceContext = new AsyncLocalStorage<ReadonlyMap<string, LifecycleFenceToken>>();

function newLifecycleFenceToken(): LifecycleFenceToken {
  return { active: true, nested: 0, idleWaiters: new Set() };
}

function waitForNestedFenceCalls(token: LifecycleFenceToken): Promise<void> {
  if (token.nested === 0) return Promise.resolve();
  return new Promise<void>((resolve) => token.idleWaiters.add(resolve));
}

function notifyNestedFenceCallsDrained(token: LifecycleFenceToken): void {
  if (token.nested !== 0) return;
  for (const resolve of token.idleWaiters) resolve();
  token.idleWaiters.clear();
}

/**
 * The same request can pass through collection and provider boundaries.  Keep
 * the original advisory lock for the whole operation, while making nested
 * fences for that tenant reentrant rather than deadlocking on a second pooled
 * connection.
 */
export async function withSensitiveLifecycleFence<T>(organizationId: string, action: () => Promise<T>): Promise<T> {
  const held = lifecycleFenceContext.getStore();
  const inherited = held?.get(organizationId);
  if (inherited?.active) {
    inherited.nested += 1;
    try {
      return await action();
    } finally {
      inherited.nested -= 1;
      notifyNestedFenceCallsDrained(inherited);
    }
  }
  const client = await pool.connect();
  const token = newLifecycleFenceToken();
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 252))", [organizationId]);
    return await lifecycleFenceContext.run(
      new Map([...(held ?? []), [organizationId, token]]),
      action,
    );
  } finally {
    try {
      // A timer/void continuation inherits AsyncLocalStorage. Keep a token
      // active while an already-started nested operation drains: that operation
      // may itself enter a grandchild fence and must remain reentrant, or the
      // owner would wait on work blocked behind its own lock. Once the nesting
      // count is truly idle, invalidate synchronously before unlock so later
      // detached callbacks acquire a fresh real fence.
      while (token.nested > 0) await waitForNestedFenceCalls(token);
      token.active = false;
      await client.query("select pg_advisory_unlock(hashtextextended($1, 252))", [organizationId]);
    } finally {
      client.release();
    }
  }
}

/**
 * Mandatory runtime boundary for writes that can retain opaque case-derived
 * narratives. The advisory fence is deliberately application-level and
 * reentrant; it avoids adding database triggers that would deadlock callers
 * already holding transaction-scoped dispatch locks. The row lock, gate, and
 * supplied write share one transaction so a collection writer cannot slip in
 * between policy/hold evaluation and persistence.
 */
export async function withCaseDerivedLifecycleWrite<T>(
  input: { organizationId: string; caseId: number },
  write: (tx: any, caseRow: typeof onbCases.$inferSelect) => Promise<T>,
): Promise<T> {
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const caseRow = await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    return write(tx, caseRow);
  }));
}

/** For writers that already own the fenced case transaction. */
export async function assertCaseDerivedLifecycleWriteAllowedInTransaction(
  tx: any,
  input: { organizationId: string; caseId: number },
): Promise<typeof onbCases.$inferSelect> {
  const [caseRow] = await tx.select().from(onbCases).where(and(
      eq(onbCases.organizationId, input.organizationId),
      eq(onbCases.id, input.caseId),
  )).for("update");
  if (!caseRow) throw new SensitiveLifecycleValidationError("Case-derived sensitive write requires a current tenant case.");
  const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
    organizationId: input.organizationId,
    jurisdiction: jurisdictionForWorkforceContext(caseRow.workforceContext),
  });
  if (!gate.allowed) throw new SensitiveLifecycleConflictError(`SENSITIVE_LIFECYCLE_BLOCKED:${gate.reason}`);
  const unsafeSettings = await unsafeCaseDerivedSettingsInTransaction(tx, input.organizationId, input.caseId);
  if (unsafeSettings) throw new SensitiveLifecycleConflictError(`SENSITIVE_LIFECYCLE_BLOCKED:${unsafeSettings}`);
  return caseRow;
}

export async function verifiedSensitiveAuthorityInTransaction(
  tx: any,
  organizationId: string,
  actorUserId: string,
) {
  const now = new Date();
  const [assignment] = await tx.select().from(onbGovernanceAuthorityAssignments).where(and(
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    eq(onbGovernanceAuthorityAssignments.assigneeUserId, actorUserId),
    inArray(onbGovernanceAuthorityAssignments.authorityRole, ["privacy", "legal"]),
    eq(onbGovernanceAuthorityAssignments.verificationStatus, "verified"),
    isNull(onbGovernanceAuthorityAssignments.revokedAt),
    or(isNull(onbGovernanceAuthorityAssignments.expiresAt), gt(onbGovernanceAuthorityAssignments.expiresAt, now)),
  )).for("update");
  if (!assignment) {
    throw new SensitiveLifecyclePermissionError(
      "A current server-verified privacy or legal authority assignment is required; tenant ownership is not authority.",
    );
  }
  const [membership] = await tx.select({ id: organizationMembershipsTable.id })
    .from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, actorUserId),
      isNull(organizationMembershipsTable.revokedAt),
    ));
  if (!membership) throw new SensitiveLifecyclePermissionError("A current tenant membership is required.");
  return assignment;
}

function policyView(row: typeof onbSensitiveLifecyclePolicies.$inferSelect) {
  return {
    id: row.id,
    dataClass: row.dataClass,
    jurisdiction: row.jurisdiction,
    revision: row.revision,
    purpose: row.purpose,
    lawfulBasis: row.lawfulBasis,
    retentionDays: row.retentionDays,
    providerSharingApproved: row.providerSharingApproved,
    permittedProviders: row.permittedProviders,
    policyReference: row.policyReference,
    approvalReference: row.approvalReference,
    approvedAt: row.approvedAt.toISOString(),
    isCurrent: row.isCurrent,
  };
}

async function writePolicyInTransaction(
  tx: any,
  organizationId: string,
  actorUserId: string,
  input: PolicyInput,
) {
  const authority = await verifiedSensitiveAuthorityInTransaction(tx, organizationId, actorUserId);
  const [current] = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    eq(onbSensitiveLifecyclePolicies.dataClass, input.dataClass),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, input.jurisdiction),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
  )).for("update");
  if ((current?.revision ?? 0) !== input.expectedRevision) {
    throw new SensitiveLifecycleConflictError("Policy changed since the reviewed revision; reload before retrying.");
  }
  const now = new Date();
  if (current) {
    await tx.update(onbSensitiveLifecyclePolicies).set({
      isCurrent: false, supersededAt: now,
    }).where(eq(onbSensitiveLifecyclePolicies.id, current.id));
  }
  const [created] = await tx.insert(onbSensitiveLifecyclePolicies).values({
    organizationId,
    dataClass: input.dataClass,
    jurisdiction: input.jurisdiction,
    revision: (current?.revision ?? 0) + 1,
    purpose: input.purpose,
    lawfulBasis: input.lawfulBasis,
    retentionDays: input.retentionDays,
    providerSharingApproved: input.providerSharingApproved,
    permittedProviders: input.permittedProviders,
    policyReference: input.policyReference,
    approvalReference: input.approvalReference,
    approvedByUserId: actorUserId,
    approvedAuthorityAssignmentId: authority.id,
    approvedAt: now,
  }).returning();
  if (!created) throw new Error("Sensitive lifecycle policy was not persisted.");
  await appendProtectedAuditInTransaction(tx, {
    organizationId, actorId: actorUserId, actorKind: "authenticated",
    actorAuthority: `governance-assignment:${authority.id}`,
    action: "privacy.sensitive-lifecycle.policy-approved", outcome: "success",
    objectType: "sensitive-lifecycle-policy", objectId: String(created.id),
    reviewedRevision: created.revision, source: "privacy-route",
  });
  return created;
}

export async function listSensitiveLifecyclePolicies(input: { organizationId: string; actorUserId: string }) {
  return db.transaction(async (tx) => {
    await verifiedSensitiveAuthorityInTransaction(tx, input.organizationId, input.actorUserId);
    const rows = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
      eq(onbSensitiveLifecyclePolicies.organizationId, input.organizationId),
      eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    ));
    return rows.map(policyView);
  });
}

export async function saveSensitiveLifecyclePolicy(input: {
  organizationId: string; actorUserId: string; policy: unknown;
}) {
  const parsed = policyInput(input.policy);
  return withSensitiveLifecycleFence(input.organizationId, async () => {
  const [current] = await db.select().from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, input.organizationId),
    eq(onbSensitiveLifecyclePolicies.dataClass, parsed.dataClass),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, parsed.jurisdiction),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
  ));
  if (current && parsed.retentionDays < current.retentionDays) {
    throw new SensitiveLifecycleConflictError("Retention shortening requires a preview and explicit authorized confirmation.");
  }
  return db.transaction(async (tx) => policyView(await writePolicyInTransaction(
    tx, input.organizationId, input.actorUserId, parsed,
  )));
  });
}

async function eligibleUploadsForPolicyInTransaction(tx: any, input: {
  organizationId: string; dataClass: SensitiveDataClass; jurisdiction: string; retentionDays: number; now: Date;
}): Promise<{ eligibleUploadIds: number[]; eligibleRecordKeys: string[]; heldRecordCount: number }> {
  if (!DELETION_SUPPORTED_CLASSES.has(input.dataClass)) {
    return { eligibleUploadIds: [], eligibleRecordKeys: [], heldRecordCount: 0 };
  }
  // Relational records remain class-specific. Their preview boundary is the
  // proposed policy's own period; opaque upload eligibility is calculated
  // separately below against every applicable class period.
  const cutoff = new Date(input.now.getTime() - input.retentionDays * 86_400_000);
  const [uploads, holds] = await Promise.all([
    tx.select({
      id: onbCandidateUploads.id, caseId: onbCandidateUploads.caseId, objectPath: onbCandidateUploads.objectPath,
      key: onbDocuments.key, label: onbDocuments.label, category: onbDocuments.category,
      workforceContext: onbCases.workforceContext, createdAt: onbCandidateUploads.createdAt,
    }).from(onbCandidateUploads).innerJoin(onbCases, and(
      eq(onbCases.organizationId, onbCandidateUploads.organizationId),
      eq(onbCases.id, onbCandidateUploads.caseId),
    )).innerJoin(onbDocuments, eq(onbDocuments.id, onbCandidateUploads.documentId)).where(and(
      eq(onbCandidateUploads.organizationId, input.organizationId),
    )),
    tx.select().from(onbSensitiveLifecycleHolds).where(and(
      eq(onbSensitiveLifecycleHolds.organizationId, input.organizationId),
      eq(onbSensitiveLifecycleHolds.active, true),
    )),
  ]);
  const held = (caseId: number, objectPath: string | null) => holds.some((hold: typeof onbSensitiveLifecycleHolds.$inferSelect) =>
    (!hold.dataClass || effectiveSensitiveDataClassesForCandidateUpload().includes(hold.dataClass as SensitiveDataClass)) &&
    (!hold.caseId || hold.caseId === caseId) &&
    (!hold.objectPath || hold.objectPath === objectPath));
  const matchingUploads = uploads.filter((upload: {
    key: string; label: string; category: string; caseId: number; objectPath: string; workforceContext: unknown; createdAt: Date;
  }) => {
    if (jurisdictionForWorkforceContext(upload.workforceContext) !== input.jurisdiction) return false;
    return true;
  });

  let relational: Array<{ recordKind: string; recordId: string; caseId: number; workforceContext: unknown }> = [];
  if (input.dataClass === "candidate-contact" || input.dataClass === "bgv") {
    const rows = await tx.select({
      id: onbCommunications.id, caseId: onbCommunications.caseId, workforceContext: onbCases.workforceContext,
    }).from(onbCommunications).innerJoin(onbCases, and(
      eq(onbCases.organizationId, onbCommunications.organizationId), eq(onbCases.id, onbCommunications.caseId),
    )).where(and(
      eq(onbCommunications.organizationId, input.organizationId),
      eq(onbCommunications.sensitiveDataClass, input.dataClass),
      lte(onbCommunications.createdAt, cutoff),
    ));
    relational = rows.map((row: any) => ({ recordKind: "communication", recordId: String(row.id), caseId: row.caseId, workforceContext: row.workforceContext }));
  } else if (input.dataClass === "candidate-voice") {
    const [communications, rows] = await Promise.all([
      tx.select({ id: onbCommunications.id, caseId: onbCommunications.caseId, workforceContext: onbCases.workforceContext })
        .from(onbCommunications).innerJoin(onbCases, and(
          eq(onbCases.organizationId, onbCommunications.organizationId), eq(onbCases.id, onbCommunications.caseId),
        )).where(and(
          eq(onbCommunications.organizationId, input.organizationId),
          eq(onbCommunications.sensitiveDataClass, "candidate-voice"),
          lte(onbCommunications.createdAt, cutoff),
        )),
      tx.select({
      token: onbVoiceSessions.token, caseId: onbVoiceSessions.caseId, workforceContext: onbCases.workforceContext,
    }).from(onbVoiceSessions).innerJoin(onbCases, and(
      eq(onbCases.organizationId, onbVoiceSessions.organizationId), eq(onbCases.id, onbVoiceSessions.caseId),
    )).where(and(eq(onbVoiceSessions.organizationId, input.organizationId), eq(onbVoiceSessions.finalized, true), lte(onbVoiceSessions.startedAt, cutoff))),
    ]);
    relational = [
      ...communications.map((row: any) => ({ recordKind: "communication", recordId: String(row.id), caseId: row.caseId, workforceContext: row.workforceContext })),
      ...rows.map((row: any) => ({ recordKind: "voice-session", recordId: row.token, caseId: row.caseId, workforceContext: row.workforceContext })),
    ];
  } else if (input.dataClass === "candidate-portal") {
    const [links, sessions] = await Promise.all([
      tx.select({ id: onbCandidateLinks.id, caseId: onbCandidateLinks.caseId, workforceContext: onbCases.workforceContext })
        .from(onbCandidateLinks).innerJoin(onbCases, and(eq(onbCases.organizationId, onbCandidateLinks.organizationId), eq(onbCases.id, onbCandidateLinks.caseId)))
        .where(and(eq(onbCandidateLinks.organizationId, input.organizationId), lte(onbCandidateLinks.createdAt, cutoff))),
      tx.select({ idHash: onbCandidateSessions.idHash, caseId: onbCandidateSessions.caseId, workforceContext: onbCases.workforceContext })
        .from(onbCandidateSessions).innerJoin(onbCases, and(eq(onbCases.organizationId, onbCandidateSessions.organizationId), eq(onbCases.id, onbCandidateSessions.caseId)))
        .where(and(eq(onbCandidateSessions.organizationId, input.organizationId), lte(onbCandidateSessions.createdAt, cutoff))),
    ]);
    relational = [
      ...links.map((row: any) => ({ recordKind: "candidate-link", recordId: String(row.id), caseId: row.caseId, workforceContext: row.workforceContext })),
      ...sessions.map((row: any) => ({ recordKind: "candidate-session", recordId: row.idHash, caseId: row.caseId, workforceContext: row.workforceContext })),
    ];
  }
  const matchingRelational = relational.filter((record) => jurisdictionForWorkforceContext(record.workforceContext) === input.jurisdiction);
  // A shortening preview must disclose opaque case envelopes too. Their
  // proposed class period is combined with the current approved periods for
  // every other class; absent policy coverage deliberately leaves the envelope
  // out of the eligible list rather than pretending a partial policy is enough.
  const [caseRows, opaquePolicies] = await Promise.all([
    tx.select({
      id: onbCases.id, workforceContext: onbCases.workforceContext, workerEmail: onbCases.workerEmail,
      createdAt: onbCases.createdAt, updatedAt: onbCases.updatedAt,
    }).from(onbCases).where(eq(onbCases.organizationId, input.organizationId)),
    tx.select().from(onbSensitiveLifecyclePolicies).where(and(
      eq(onbSensitiveLifecyclePolicies.organizationId, input.organizationId),
      eq(onbSensitiveLifecyclePolicies.jurisdiction, input.jurisdiction),
      eq(onbSensitiveLifecyclePolicies.isCurrent, true),
      inArray(onbSensitiveLifecyclePolicies.dataClass, [...OPAQUE_CASE_DERIVED_CLASSES]),
    )),
  ]);
  const opaqueByClass = new Map<string, typeof onbSensitiveLifecyclePolicies.$inferSelect>(
    opaquePolicies.map((policy: typeof onbSensitiveLifecyclePolicies.$inferSelect) => [policy.dataClass, policy]),
  );
  const opaqueCoverageComplete = OPAQUE_CASE_DERIVED_CLASSES.every((dataClass) => opaqueByClass.has(dataClass));
  // Uploaded bytes are opaque and can contain any sensitive class regardless
  // of a nominal document label. A shortening preview includes them for every
  // class and considers them eligible only after the longest applicable period
  // has elapsed (including the proposed replacement period).
  const eligibleOpaqueUploads = opaqueCoverageComplete
    ? matchingUploads.filter((upload: { caseId: number; objectPath: string; createdAt: Date }) =>
      OPAQUE_CASE_DERIVED_CLASSES.every((dataClass) => {
        const days = dataClass === input.dataClass
          ? input.retentionDays
          : opaqueByClass.get(dataClass)!.retentionDays;
        return upload.createdAt <= new Date(input.now.getTime() - days * 86_400_000);
      }),
    )
    : [];
  const uploadIds = eligibleOpaqueUploads.filter((upload: { caseId: number; objectPath: string }) =>
    !held(upload.caseId, upload.objectPath),
  ).map((upload: { id: number }) => upload.id).sort((a: number, b: number) => a - b);
  const sourceAges = new Map<number, Date>(await Promise.all(caseRows.map(async (caseRow: {
    id: number; workerEmail: string; updatedAt: Date;
  }) => [caseRow.id, await newestCaseDerivedSourceAtInTransaction(
    tx, input.organizationId, caseRow.id, caseRow.workerEmail, caseRow.updatedAt,
  )] as const)));
  const envelopeHeld = (caseId: number) => holds.some((hold: typeof onbSensitiveLifecycleHolds.$inferSelect) =>
    (!hold.dataClass || OPAQUE_CASE_DERIVED_CLASSES.includes(hold.dataClass as SensitiveDataClass)) &&
    (!hold.caseId || hold.caseId === caseId));
  const eligibleEnvelopeKeys = opaqueCoverageComplete
    ? caseRows.filter((caseRow: { id: number; workforceContext: unknown }) =>
      jurisdictionForWorkforceContext(caseRow.workforceContext) === input.jurisdiction &&
      OPAQUE_CASE_DERIVED_CLASSES.every((dataClass) => {
        const days = dataClass === input.dataClass ? input.retentionDays : opaqueByClass.get(dataClass)!.retentionDays;
        return sourceAges.get(caseRow.id)! <= new Date(input.now.getTime() - days * 86_400_000);
      }) &&
      !envelopeHeld(caseRow.id),
    ).map((caseRow: { id: number }) => `case-derived-envelope:${caseRow.id}`)
    : [];
  const heldEnvelopeCount = opaqueCoverageComplete
    ? caseRows.filter((caseRow: { id: number; workforceContext: unknown }) =>
      jurisdictionForWorkforceContext(caseRow.workforceContext) === input.jurisdiction &&
      OPAQUE_CASE_DERIVED_CLASSES.every((dataClass) => {
        const days = dataClass === input.dataClass ? input.retentionDays : opaqueByClass.get(dataClass)!.retentionDays;
        return sourceAges.get(caseRow.id)! <= new Date(input.now.getTime() - days * 86_400_000);
      }) && envelopeHeld(caseRow.id),
    ).length
    : 0;
  const eligibleRecordKeys = [
    ...uploadIds.map((id: number) => `candidate-upload:${id}`),
    ...matchingRelational.filter((record) => !held(record.caseId, null)).map((record) => `${record.recordKind}:${record.recordId}`),
    ...eligibleEnvelopeKeys,
  ].sort();
  return {
    eligibleUploadIds: uploadIds,
    eligibleRecordKeys,
    heldRecordCount: eligibleOpaqueUploads.filter((upload: any) => held(upload.caseId, upload.objectPath)).length +
      matchingRelational.filter((record) => held(record.caseId, null)).length + heldEnvelopeCount,
  };
}

export async function previewRetentionShortening(input: {
  organizationId: string; actorUserId: string; policy: unknown;
}) {
  const parsed = policyInput(input.policy);
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    await verifiedSensitiveAuthorityInTransaction(tx, input.organizationId, input.actorUserId);
    const [current] = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
      eq(onbSensitiveLifecyclePolicies.organizationId, input.organizationId),
      eq(onbSensitiveLifecyclePolicies.dataClass, parsed.dataClass),
      eq(onbSensitiveLifecyclePolicies.jurisdiction, parsed.jurisdiction),
      eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    )).for("update");
    if (!current || current.revision !== parsed.expectedRevision || parsed.retentionDays >= current.retentionDays) {
      throw new SensitiveLifecycleConflictError("A current policy with a strictly shorter proposed retention is required.");
    }
    const inventory = await eligibleUploadsForPolicyInTransaction(tx, {
      organizationId: input.organizationId, dataClass: parsed.dataClass,
      jurisdiction: parsed.jurisdiction, retentionDays: parsed.retentionDays, now: new Date(),
    });
    const affectedObjectCount = inventory.eligibleRecordKeys.length;
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const [confirmation] = await tx.insert(onbSensitiveLifecycleConfirmations).values({
      organizationId: input.organizationId, actorUserId: input.actorUserId,
      policyId: current.id, expectedRevision: current.revision,
      proposedPolicy: parsed, affectedObjectCount, eligibleUploadIds: inventory.eligibleUploadIds,
      eligibleRecordKeys: inventory.eligibleRecordKeys, heldRecordCount: inventory.heldRecordCount, expiresAt,
    }).returning();
    return {
      confirmationId: confirmation!.id,
      expiresAt: expiresAt.toISOString(),
      affectedObjectCount,
      heldRecordCount: inventory.heldRecordCount,
      requiresExplicitAuthorizedConfirmation: true,
      confirmationPhrase: CONFIRMATION_PHRASE,
    };
  }));
}

export async function confirmRetentionShortening(input: {
  organizationId: string; actorUserId: string; confirmationId: number; confirmationPhrase: unknown;
}) {
  if (input.confirmationPhrase !== CONFIRMATION_PHRASE) {
    throw new SensitiveLifecycleValidationError(`confirmationPhrase must exactly equal ${CONFIRMATION_PHRASE}.`);
  }
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [confirmation] = await tx.select().from(onbSensitiveLifecycleConfirmations).where(and(
      eq(onbSensitiveLifecycleConfirmations.organizationId, input.organizationId),
      eq(onbSensitiveLifecycleConfirmations.id, input.confirmationId),
      eq(onbSensitiveLifecycleConfirmations.actorUserId, input.actorUserId),
      isNull(onbSensitiveLifecycleConfirmations.confirmedAt),
    )).for("update");
    if (!confirmation || confirmation.expiresAt <= new Date()) {
      throw new SensitiveLifecycleConflictError("Retention-shortening preview is absent, used, or expired.");
    }
    const proposed = policyInput(confirmation.proposedPolicy);
    const currentInventory = await eligibleUploadsForPolicyInTransaction(tx, {
      organizationId: input.organizationId, dataClass: proposed.dataClass,
      jurisdiction: proposed.jurisdiction, retentionDays: proposed.retentionDays, now: new Date(),
    });
    const previewEligibleKeys = [...confirmation.eligibleRecordKeys].sort();
    if (currentInventory.eligibleRecordKeys.length !== previewEligibleKeys.length ||
        currentInventory.eligibleRecordKeys.some((key, index) => key !== previewEligibleKeys[index]) ||
        currentInventory.heldRecordCount !== confirmation.heldRecordCount) {
      throw new SensitiveLifecycleConflictError(
        "Eligible retention inventory changed since preview; create a fresh shortening preview before confirming.",
      );
    }
    const created = await writePolicyInTransaction(
      tx, input.organizationId, input.actorUserId, proposed,
    );
    await tx.update(onbSensitiveLifecycleConfirmations).set({ confirmedAt: new Date() })
      .where(eq(onbSensitiveLifecycleConfirmations.id, confirmation.id));
    return policyView(created);
  }));
}

export async function setSensitiveLifecycleHold(input: {
  organizationId: string; actorUserId: string; dataClass?: unknown; caseId?: unknown; objectPath?: unknown;
  reason: unknown; reference: unknown;
}) {
  const dataClass = input.dataClass === undefined ? null : policyInput({
    dataClass: input.dataClass, jurisdiction: "scope", purpose: "scope", lawfulBasis: "scope",
    retentionDays: 0, providerSharingApproved: false, permittedProviders: [], policyReference: "scope", approvalReference: "scope", expectedRevision: 0,
  }).dataClass;
  const caseId = input.caseId === undefined ? null : Number(input.caseId);
  if (caseId !== null && (!Number.isInteger(caseId) || caseId < 1)) {
    throw new SensitiveLifecycleValidationError("caseId must be a positive integer.");
  }
  const objectPath = input.objectPath === undefined ? null : text(input.objectPath, "objectPath");
  if (objectPath && (!objectPath.startsWith("/objects/") || objectPath.includes(".."))) {
    throw new SensitiveLifecycleValidationError("objectPath is invalid.");
  }
  if (!dataClass && !caseId && !objectPath) throw new SensitiveLifecycleValidationError("A hold scope is required.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const authority = await verifiedSensitiveAuthorityInTransaction(tx, input.organizationId, input.actorUserId);
    if (caseId) {
      const [caseRow] = await tx.select({ id: onbCases.id }).from(onbCases).where(and(
        eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, caseId),
      )).for("update");
      if (!caseRow) throw new SensitiveLifecycleValidationError("Hold caseId does not belong to this organization.");
    }
    if (objectPath) {
      const [manifest] = await tx.select().from(onbSensitiveObjectManifests).where(and(
        eq(onbSensitiveObjectManifests.organizationId, input.organizationId),
        eq(onbSensitiveObjectManifests.objectPath, objectPath),
      )).for("update");
      if (!manifest) throw new SensitiveLifecycleValidationError("Hold objectPath is not a known lifecycle-managed object.");
      if (caseId && manifest.caseId !== caseId) {
        throw new SensitiveLifecycleValidationError("Hold caseId contradicts the object’s server-recorded case.");
      }
    }
    const [hold] = await tx.insert(onbSensitiveLifecycleHolds).values({
      organizationId: input.organizationId, dataClass, caseId, objectPath,
      reason: text(input.reason, "reason"), reference: text(input.reference, "reference"),
      setByUserId: input.actorUserId, setAuthorityAssignmentId: authority.id,
    }).returning();
    await appendProtectedAuditInTransaction(tx, {
      organizationId: input.organizationId, actorId: input.actorUserId, actorKind: "authenticated",
      actorAuthority: `governance-assignment:${authority.id}`, action: "privacy.sensitive-lifecycle.hold-set",
      outcome: "success", objectType: "sensitive-lifecycle-hold", objectId: String(hold!.id), source: "privacy-route",
    });
    return hold;
  }));
}

export async function releaseSensitiveLifecycleHold(input: {
  organizationId: string; actorUserId: string; holdId: number; reference: unknown;
}) {
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const authority = await verifiedSensitiveAuthorityInTransaction(tx, input.organizationId, input.actorUserId);
    const [hold] = await tx.update(onbSensitiveLifecycleHolds).set({
      active: false, releasedAt: new Date(), releasedByUserId: input.actorUserId,
      releasedAuthorityAssignmentId: authority.id,
    }).where(and(
      eq(onbSensitiveLifecycleHolds.organizationId, input.organizationId),
      eq(onbSensitiveLifecycleHolds.id, input.holdId),
      eq(onbSensitiveLifecycleHolds.active, true),
    )).returning();
    if (!hold) throw new SensitiveLifecycleConflictError("Active hold not found.");
    // A release reference is deliberately validated even though protected audit
    // minimizes it out of the immutable chain.
    text(input.reference, "reference");
    // A hold may have stopped a worker after it claimed a bounded job. Requeue
    // blocked rows for fresh fenced evaluation rather than requiring operators
    // to recreate the policy or silently treating a released hold as deletion.
    await tx.update(onbSensitiveLifecycleDeletionJobs).set({
      status: "queued", claimOwner: null, claimUntil: null, lastError: null, updatedAt: new Date(),
    }).where(and(
      eq(onbSensitiveLifecycleDeletionJobs.organizationId, input.organizationId),
      eq(onbSensitiveLifecycleDeletionJobs.status, "blocked"),
    ));
    await appendProtectedAuditInTransaction(tx, {
      organizationId: input.organizationId, actorId: input.actorUserId, actorKind: "authenticated",
      actorAuthority: `governance-assignment:${authority.id}`, action: "privacy.sensitive-lifecycle.hold-released",
      outcome: "success", objectType: "sensitive-lifecycle-hold", objectId: String(hold.id), source: "privacy-route",
    });
    return hold;
  }));
}

export async function listSensitiveLifecycleHolds(input: { organizationId: string; actorUserId: string }) {
  return db.transaction(async (tx) => {
    await verifiedSensitiveAuthorityInTransaction(tx, input.organizationId, input.actorUserId);
    return tx.select().from(onbSensitiveLifecycleHolds).where(
      eq(onbSensitiveLifecycleHolds.organizationId, input.organizationId),
    );
  });
}

export async function listSensitiveLifecycleDeletionJobs(input: { organizationId: string; actorUserId: string }) {
  return db.transaction(async (tx) => {
    await verifiedSensitiveAuthorityInTransaction(tx, input.organizationId, input.actorUserId);
    return tx.select().from(onbSensitiveLifecycleDeletionJobs).where(
      eq(onbSensitiveLifecycleDeletionJobs.organizationId, input.organizationId),
    );
  });
}

export async function retrySensitiveLifecycleDeletionJob(input: {
  organizationId: string; actorUserId: string; jobId: number;
}) {
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    await verifiedSensitiveAuthorityInTransaction(tx, input.organizationId, input.actorUserId);
    const [job] = await tx.update(onbSensitiveLifecycleDeletionJobs).set({
      status: "queued", claimOwner: null, claimUntil: null, lastError: null, updatedAt: new Date(),
    }).where(and(
      eq(onbSensitiveLifecycleDeletionJobs.organizationId, input.organizationId),
      eq(onbSensitiveLifecycleDeletionJobs.id, input.jobId),
      eq(onbSensitiveLifecycleDeletionJobs.status, "failed"),
    )).returning();
    if (!job) throw new SensitiveLifecycleConflictError("Only an existing failed deletion job may be retried.");
    return job;
  }));
}

export async function evaluateSensitiveLifecycleGate(input: {
  organizationId: string; jurisdiction: string | null | undefined; dataClass: SensitiveDataClass;
  disclosure: boolean; providerId?: string; /** false only for retention cleanup, never a new collection/disclosure boundary */
  collection?: boolean;
}) {
  if (!DELETION_SUPPORTED_CLASSES.has(input.dataClass)) {
    return {
      allowed: false as const,
      reason: `Sensitive class ${input.dataClass} has no reconciled lifecycle deletion handler; collection and disclosure are blocked.`,
    };
  }
  const jurisdiction = input.jurisdiction?.trim();
  if (!jurisdiction) return { allowed: false, reason: "Sensitive lifecycle policy is blocked because the case jurisdiction is missing." };
  const [policy] = await db.select().from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, input.organizationId),
    eq(onbSensitiveLifecyclePolicies.dataClass, input.dataClass),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, jurisdiction),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
  ));
  if (!policy) return { allowed: false, reason: "No approved class-specific sensitive lifecycle policy exists for this jurisdiction." };
  if (input.disclosure && (!policy.providerSharingApproved || !input.providerId ||
      !policy.permittedProviders.includes(input.providerId))) {
    return { allowed: false, reason: "The approved sensitive lifecycle policy does not authorize this concrete provider disclosure." };
  }
  // Exact class/provider authorization is necessary but insufficient for
  // collection that can be copied into opaque case narratives. Do this only
  // after the precise gate so an absent policy/provider never gains a broader
  // explanation or query path.
  if (input.collection !== false) {
    const caseDerived = await evaluateCaseDerivedLifecycleGate({
      organizationId: input.organizationId,
      jurisdiction,
    });
    if (!caseDerived.allowed) return { allowed: false as const, reason: caseDerived.reason };
  }
  return { allowed: true, policy };
}

type PolicyRevisionSet = Record<string, { id: number; revision: number }>;

/**
 * Approval history is immutable and therefore can only be retained during
 * sensitive-content collection/minimisation when it is one of these exact
 * server-owned minimal shapes. V1 has no authority provenance; V2 adds only
 * the verified assignment identity and its positive revision. Any extra key,
 * incorrect JSON type, or legacy shape remains opaque and fails closed.
 */
const SAFE_GOVERNED_APPROVAL_HISTORY_PROJECTION = sql`(
  (
    ${onbApprovalHistory.projectionKind} = 'governed-minimal-v1'
    and ${onbApprovalHistory.comment} is null
    and ${onbApprovalHistory.reason} is null
    and ${onbApprovalHistory.snapshot} = '{"schema":"governed-minimal-v1"}'::jsonb
  )
  or (
    ${onbApprovalHistory.projectionKind} = 'governed-minimal-v2'
    and ${onbApprovalHistory.comment} is null
    and ${onbApprovalHistory.reason} is null
    and jsonb_typeof(${onbApprovalHistory.snapshot}) = 'object'
    and ${onbApprovalHistory.snapshot}->>'schema' = 'governed-minimal-v2'
    and jsonb_typeof(${onbApprovalHistory.snapshot}->'decidedAuthorityId') = 'string'
    and coalesce(${onbApprovalHistory.snapshot}->>'decidedAuthorityId', '') <> ''
    and jsonb_typeof(${onbApprovalHistory.snapshot}->'decidedAuthorityRevision') = 'number'
    and (${onbApprovalHistory.snapshot}->>'decidedAuthorityRevision') ~ '^[1-9][0-9]*$'
    and (
      ${onbApprovalHistory.snapshot}
        - 'schema'
        - 'decidedAuthorityId'
        - 'decidedAuthorityRevision'
    ) = '{}'::jsonb
  )
)`;

/**
 * Free text and JSON copied into a case can contain identity, medical, BGV,
 * contact, or other sensitive facts together. There is no safe text heuristic
 * that can decide which retention rule wins. Collection callers for such an
 * envelope must use this gate; it fails closed until every possible class has
 * an approved current policy for the recorded work jurisdiction.
 */
export async function evaluateCaseDerivedLifecycleGateInTransaction(tx: any, input: {
  organizationId: string; jurisdiction: string | null | undefined;
}) {
  const jurisdiction = input.jurisdiction?.trim();
  if (!jurisdiction) {
    return { allowed: false as const, reason: "Case-derived sensitive collection is blocked because the case jurisdiction is missing." };
  }
  const policies: Array<typeof onbSensitiveLifecyclePolicies.$inferSelect> = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, input.organizationId),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, jurisdiction),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    inArray(onbSensitiveLifecyclePolicies.dataClass, [...OPAQUE_CASE_DERIVED_CLASSES]),
  ));
  const byClass = new Map<string, typeof onbSensitiveLifecyclePolicies.$inferSelect>(
    policies.map((policy) => [policy.dataClass, policy]),
  );
  const missing = OPAQUE_CASE_DERIVED_CLASSES.filter((dataClass) => !byClass.has(dataClass));
  if (missing.length) {
    return {
      allowed: false as const,
      reason: `Case-derived sensitive collection is unresolved: current approved policies are missing for ${missing.join(", ")}. Opaque mixed narratives are not auto-classified.`,
      missingDataClasses: missing,
    };
  }
  // Approval snapshots are independently retained and append-only. Their
  // legacy/opaque shape means a new live case cannot safely claim that its
  // collection lifecycle is supported while a same-jurisdiction (or orphaned,
  // therefore jurisdiction-unprovable) private snapshot awaits governed
  // retention remediation. This mirrors the worker's fail-closed outcome.
  const [immutableHistory] = await tx.select({ id: onbApprovalHistory.id })
    .from(onbApprovalHistory)
    .leftJoin(onbCases, and(
      eq(onbCases.organizationId, onbApprovalHistory.organizationId),
      eq(onbCases.id, onbApprovalHistory.caseId),
    ))
    .where(and(
      eq(onbApprovalHistory.organizationId, input.organizationId),
      sql`not ${SAFE_GOVERNED_APPROVAL_HISTORY_PROJECTION}`,
      or(
        isNull(onbCases.id),
        sql`upper(coalesce(${onbCases.workforceContext}->>'workCountry', ${onbCases.workforceContext}->>'country', '')) = upper(${jurisdiction})`,
      ),
    )).limit(1);
  if (immutableHistory) {
    return {
      allowed: false as const,
      reason: "Case-derived sensitive collection is blocked: append-only approval history may contain an opaque private snapshot awaiting a governed audit-retention exception or manual remediation.",
    };
  }
  const unsafeSettings = await unsafeCaseDerivedSettingsInTransaction(tx, input.organizationId);
  if (unsafeSettings) return { allowed: false as const, reason: unsafeSettings };
  return {
    allowed: true as const,
    policies: Object.fromEntries(OPAQUE_CASE_DERIVED_CLASSES.map((dataClass) => {
      const policy = byClass.get(dataClass)!;
      return [dataClass, { id: policy.id, revision: policy.revision, retentionDays: policy.retentionDays }];
    })),
  };
}

/**
 * Demo run entries are JSON ledgers keyed independently of a case. A valid
 * server-owned entry has exactly one numeric caseId; an unknown/multi-case
 * shape cannot be safely attributed and therefore blocks collection until an
 * operator remediates it. Operational request state is keyed by the case ID,
 * so only malformed namespace keys are globally unresolved.
 */
async function unsafeCaseDerivedSettingsInTransaction(
  tx: any, organizationId: string, _caseId?: number,
): Promise<string | null> {
  const rows = await tx.select({ key: onbSettings.key, value: onbSettings.value })
    .from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      or(
        sql`${onbSettings.key} like ${`${OPERATIONAL_REQUEST_SETTING_PREFIX}%`}`,
        sql`${onbSettings.key} like ${`${DEMO_RUN_SETTING_PREFIX}%`}`,
      ),
    ));
  for (const row of rows) {
    if (row.key.startsWith(OPERATIONAL_REQUEST_SETTING_PREFIX)) {
      if (!/^\d+$/.test(row.key.slice(OPERATIONAL_REQUEST_SETTING_PREFIX.length))) {
        return "Case-derived collection is blocked: an operational-request setting has an unrecognised case key and cannot be safely attributed.";
      }
      continue;
    }
    try {
      const value = JSON.parse(row.value) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          !Number.isInteger((value as { caseId?: unknown }).caseId)) {
        return "Case-derived collection is blocked: a demo ledger has an unrecognised or multi-case shape and requires lifecycle review.";
      }
    } catch {
      return "Case-derived collection is blocked: a demo ledger cannot be parsed and requires lifecycle review.";
    }
  }
  return null;
}

async function caseDerivedSettingKeysForMinimisationInTransaction(
  tx: any, organizationId: string, caseId: number,
): Promise<{ keys: string[]; error?: string }> {
  const rows = await tx.select({ key: onbSettings.key, value: onbSettings.value })
    .from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      or(
        eq(onbSettings.key, `${OPERATIONAL_REQUEST_SETTING_PREFIX}${caseId}`),
        sql`${onbSettings.key} like ${`${DEMO_RUN_SETTING_PREFIX}%`}`,
      ),
    )).for("update");
  const keys: string[] = [];
  for (const row of rows) {
    if (row.key === `${OPERATIONAL_REQUEST_SETTING_PREFIX}${caseId}`) {
      keys.push(row.key);
      continue;
    }
    try {
      const value = JSON.parse(row.value) as { caseId?: unknown };
      if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isInteger(value.caseId)) {
        return { keys: [], error: "A demo ledger has an unrecognised or multi-case shape; automatic case minimisation requires review." };
      }
      if (value.caseId === caseId) keys.push(row.key);
    } catch {
      return { keys: [], error: "A demo ledger cannot be parsed; automatic case minimisation requires review." };
    }
  }
  return { keys };
}

export async function evaluateCaseDerivedLifecycleGate(input: {
  organizationId: string; jurisdiction: string | null | undefined;
}) {
  return db.transaction((tx) => evaluateCaseDerivedLifecycleGateInTransaction(tx, input));
}

async function opaqueCasePolicySetInTransaction(tx: any, input: {
  organizationId: string; jurisdiction: string; now: Date; createdAt: Date;
  expected?: PolicyRevisionSet;
}) {
  const policies = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, input.organizationId),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, input.jurisdiction),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    inArray(onbSensitiveLifecyclePolicies.dataClass, [...OPAQUE_CASE_DERIVED_CLASSES]),
  )).for("update");
  const byClass = new Map<string, typeof onbSensitiveLifecyclePolicies.$inferSelect>(
    policies.map((policy: typeof onbSensitiveLifecyclePolicies.$inferSelect) => [policy.dataClass, policy]),
  );
  for (const dataClass of OPAQUE_CASE_DERIVED_CLASSES) {
    const policy = byClass.get(dataClass);
    if (!policy) return { state: "blocked" as const, message: `Opaque case envelope is unresolved: no current approved ${dataClass} policy exists for this jurisdiction.` };
    const expected = input.expected?.[dataClass];
    if (expected && (expected.id !== policy.id || expected.revision !== policy.revision)) {
      return { state: "blocked" as const, message: `Policy revision changed for ${dataClass}; opaque envelope deletion requires a fresh all-class evaluation.` };
    }
    if (input.createdAt > new Date(input.now.getTime() - policy.retentionDays * 86_400_000)) {
      return { state: "blocked" as const, message: `Opaque case envelope remains within the current ${dataClass} retention period.` };
    }
  }
  return {
    state: "ready" as const,
    policies: byClass,
    revisions: Object.fromEntries(OPAQUE_CASE_DERIVED_CLASSES.map((dataClass) => {
      const policy = byClass.get(dataClass)!;
      return [dataClass, { id: policy.id, revision: policy.revision }];
    })) as PolicyRevisionSet,
  };
}

/**
 * Conservative precondition for legacy cleanup paths that cannot carry a
 * record-specific job revision. A case/object hold pauses that class's
 * tenant-wide legacy sweep rather than risking deletion of its held record.
 */
export async function sensitiveLifecycleDestructionHeld(organizationId: string, dataClass: SensitiveDataClass): Promise<boolean> {
  const [hold] = await db.select({ id: onbSensitiveLifecycleHolds.id })
    .from(onbSensitiveLifecycleHolds).where(and(
      eq(onbSensitiveLifecycleHolds.organizationId, organizationId),
      eq(onbSensitiveLifecycleHolds.active, true),
      or(
        isNull(onbSensitiveLifecycleHolds.dataClass),
        eq(onbSensitiveLifecycleHolds.dataClass, dataClass),
      ),
    )).limit(1);
  return Boolean(hold);
}

/** Called in the same transaction that makes a candidate upload durable. */
export async function recordSensitivePrimaryObjectInTransaction(tx: any, input: {
  organizationId: string; caseId: number; objectPath: string; dataClass: SensitiveDataClass;
}) {
  await tx.insert(onbSensitiveObjectManifests).values({
    ...input, manifestState: "complete", reconciledAt: new Date(),
  }).onConflictDoNothing();
}

/** Server-owned metadata classification; browser input never chooses a class. */
export function sensitiveDataClassForDocument(input: {
  key: string; label: string; category: string;
}): SensitiveDataClass | null {
  const source = `${input.key} ${input.label}`.toLowerCase();
  if (/\b(medical|health|fitness|drug[- ]?test|occupational)\b/.test(source)) return "medical";
  if (/\b(bgv|background|police|criminal|screening)\b/.test(source)) return "bgv";
  if (/\b(bank|payroll|tax|pan|uan|epf|salary|statutory)\b/.test(source)) return "payroll";
  if (input.category === "identity" || /\b(id|passport|address|education|authorization)\b/.test(source)) return "identity";
  return ["identity", "statutory", "contract", "policy"].includes(input.category)
    ? "candidate-document"
    : null;
}

/**
 * Used by the only case-delete boundary.  An object-scoped hold also blocks
 * the containing case because cascade deletion would otherwise erase the
 * corresponding metadata before its preserved object can be reconciled.
 */
export async function sensitiveLifecycleCaseDeletionBlockedInTransaction(
  tx: any,
  organizationId: string,
  caseIds: readonly number[],
): Promise<boolean> {
  if (!caseIds.length) return false;
  const [caseHold] = await tx.select({ id: onbSensitiveLifecycleHolds.id })
    .from(onbSensitiveLifecycleHolds).where(and(
      eq(onbSensitiveLifecycleHolds.organizationId, organizationId),
      eq(onbSensitiveLifecycleHolds.active, true),
      or(isNull(onbSensitiveLifecycleHolds.caseId), inArray(onbSensitiveLifecycleHolds.caseId, [...caseIds])),
    )).limit(1);
  if (caseHold) return true;
  // A pre-save reservation can be the only durable record of a private object
  // path. Do not allow case cleanup to make its server-owned class/document
  // impossible to revalidate before the reservation reaches a terminal state.
  const [pendingReservation] = await tx.select({ id: onbCandidateUploadReservations.id })
    .from(onbCandidateUploadReservations).where(and(
      eq(onbCandidateUploadReservations.organizationId, organizationId),
      inArray(onbCandidateUploadReservations.caseId, [...caseIds]),
      inArray(onbCandidateUploadReservations.state, ["reserved", "cleanup-processing"]),
    )).limit(1);
  if (pendingReservation) return true;
  const uploads = await tx.select({ objectPath: onbCandidateUploads.objectPath })
    .from(onbCandidateUploads).where(and(
      eq(onbCandidateUploads.organizationId, organizationId),
      inArray(onbCandidateUploads.caseId, [...caseIds]),
    ));
  if (!uploads.length) return false;
  const [objectHold] = await tx.select({ id: onbSensitiveLifecycleHolds.id })
    .from(onbSensitiveLifecycleHolds).where(and(
      eq(onbSensitiveLifecycleHolds.organizationId, organizationId),
      eq(onbSensitiveLifecycleHolds.active, true),
      inArray(onbSensitiveLifecycleHolds.objectPath, uploads.map((upload: { objectPath: string }) => upload.objectPath)),
    )).limit(1);
  return Boolean(objectHold);
}

async function holdApplies(tx: any, input: {
  organizationId: string; dataClasses: readonly string[]; caseId: number | null; objectPath: string | null;
}) {
  const [hold] = await tx.select({ id: onbSensitiveLifecycleHolds.id }).from(onbSensitiveLifecycleHolds).where(and(
    eq(onbSensitiveLifecycleHolds.organizationId, input.organizationId),
    eq(onbSensitiveLifecycleHolds.active, true),
    or(
      isNull(onbSensitiveLifecycleHolds.dataClass),
      inArray(onbSensitiveLifecycleHolds.dataClass, [...input.dataClasses]),
    ),
    or(isNull(onbSensitiveLifecycleHolds.caseId), eq(onbSensitiveLifecycleHolds.caseId, input.caseId ?? -1)),
    or(
      isNull(onbSensitiveLifecycleHolds.objectPath),
      input.objectPath === null
        ? sql`false`
        : eq(onbSensitiveLifecycleHolds.objectPath, input.objectPath),
    ),
  )).limit(1);
  return Boolean(hold);
}

/**
 * The case itself is the inventory root for representations that cannot be
 * safely classified from their free text (events, approvals, check notes,
 * readiness/workstream JSON, SLA narratives, action payloads, and matching
 * archived stints). The root intentionally needs every class policy rather
 * than choosing a convenient generic/document period.
 */
async function scheduleExpiredCaseDerivedEnvelopes(now: Date, limit: number): Promise<number> {
  const cursorKey = "__system_case_derived_envelope_scan__";
  // A single global primary-key page bounds total work per tick, rather than
  // multiplying the limit by tenant count. This durable cursor advances for
  // every scanned case, including completed, held, missing-policy, and
  // not-yet-due records, so a completed prefix cannot starve later cases.
  return db.transaction(async (tx) => {
      let [cursor] = await tx.select().from(onbSensitiveLifecycleScanCursors).where(
        eq(onbSensitiveLifecycleScanCursors.organizationId, cursorKey),
      ).for("update");
      if (!cursor) {
        await tx.insert(onbSensitiveLifecycleScanCursors).values({ organizationId: cursorKey }).onConflictDoNothing();
        [cursor] = await tx.select().from(onbSensitiveLifecycleScanCursors).where(
          eq(onbSensitiveLifecycleScanCursors.organizationId, cursorKey),
        ).for("update");
      }
      if (!cursor) throw new Error("Sensitive lifecycle scan cursor was not persisted.");
      const cases = await tx.select({
        id: onbCases.id, organizationId: onbCases.organizationId,
        workerEmail: onbCases.workerEmail, workforceContext: onbCases.workforceContext,
        updatedAt: onbCases.updatedAt,
      }).from(onbCases).where(gt(onbCases.id, cursor.cursorCaseId))
        .orderBy(asc(onbCases.id)).limit(limit);
      if (!cases.length) {
        // Wrap after exhaustion; work starts at the first case on the next
        // invocation instead of loading an unbounded table in one tick.
        if (cursor.cursorCaseId !== 0) {
          await tx.update(onbSensitiveLifecycleScanCursors).set({ cursorCaseId: 0, updatedAt: now })
            .where(eq(onbSensitiveLifecycleScanCursors.organizationId, cursorKey));
        }
        return 0;
      }
      let inserted = 0;
      for (const caseRow of cases) {
        const jurisdiction = jurisdictionForWorkforceContext(caseRow.workforceContext);
        if (!jurisdiction) continue;
        const newestSourceAt = await newestCaseDerivedSourceAtInTransaction(
          tx, caseRow.organizationId, caseRow.id, caseRow.workerEmail, caseRow.updatedAt,
        );
        const policySet = await opaqueCasePolicySetInTransaction(tx, {
          organizationId: caseRow.organizationId, jurisdiction, now, createdAt: newestSourceAt,
        });
        // Missing/incomplete policy coverage and still-live periods are
        // unresolved states, not an opportunity to guess a class or redact.
        if (policySet.state !== "ready") continue;
        for (const dataClass of OPAQUE_CASE_DERIVED_CLASSES) {
          const policy = policySet.policies.get(dataClass)!;
          const existing = await tx.select({ id: onbSensitiveLifecycleDeletionJobs.id })
            .from(onbSensitiveLifecycleDeletionJobs).where(and(
              eq(onbSensitiveLifecycleDeletionJobs.organizationId, caseRow.organizationId),
              eq(onbSensitiveLifecycleDeletionJobs.recordKind, "candidate-upload"),
              eq(onbSensitiveLifecycleDeletionJobs.recordId, `case-derived-envelope:${caseRow.id}`),
              eq(onbSensitiveLifecycleDeletionJobs.policyId, policy.id),
              eq(onbSensitiveLifecycleDeletionJobs.policyRevision, policy.revision),
            )).limit(1);
          if (existing.length) continue;
          const rows = await tx.insert(onbSensitiveLifecycleDeletionJobs).values({
            organizationId: caseRow.organizationId, caseId: caseRow.id, dataClass,
            recordKind: "candidate-upload", recordId: `case-derived-envelope:${caseRow.id}`,
            policyId: policy.id, policyRevision: policy.revision, policyRevisions: policySet.revisions,
          }).onConflictDoNothing().returning({ id: onbSensitiveLifecycleDeletionJobs.id });
          inserted += rows.length;
        }
      }
      await tx.update(onbSensitiveLifecycleScanCursors).set({
        cursorCaseId: cases[cases.length - 1]!.id, updatedAt: now,
      }).where(eq(onbSensitiveLifecycleScanCursors.organizationId, cursorKey));
      return inserted;
  });
}

async function scheduleExpiredCandidateUploads(now: Date, limit: number): Promise<number> {
  const scanLimit = limit;
  // Candidate-upload bytes are opaque. Do not use labels, categories, or a
  // stored nominal class as proof that any sensitive class is absent.
  const uploads = await db.select({
    id: onbCandidateUploads.id, organizationId: onbCandidateUploads.organizationId, caseId: onbCandidateUploads.caseId,
    createdAt: onbCandidateUploads.createdAt,
    workforceContext: onbCases.workforceContext,
  }).from(onbCandidateUploads).innerJoin(onbCases, and(
    eq(onbCases.organizationId, onbCandidateUploads.organizationId), eq(onbCases.id, onbCandidateUploads.caseId),
  )).where(and(
      sql`not exists (select 1 from ${onbSensitiveLifecycleDeletionJobs}
        where ${onbSensitiveLifecycleDeletionJobs.organizationId} = ${onbCandidateUploads.organizationId}
          and ${onbSensitiveLifecycleDeletionJobs.recordKind} = 'candidate-upload'
          and ${onbSensitiveLifecycleDeletionJobs.recordId} = ${onbCandidateUploads.id}::text)`,
    ))
    .orderBy(asc(onbCandidateUploads.createdAt), asc(onbCandidateUploads.id)).limit(scanLimit);
  let created = 0;
  for (const upload of uploads) {
    const jurisdiction = jurisdictionForWorkforceContext(upload.workforceContext);
    if (!jurisdiction) continue;
    const policySet = await db.transaction((tx) => opaqueCasePolicySetInTransaction(tx, {
      organizationId: upload.organizationId, jurisdiction, now, createdAt: upload.createdAt,
    }));
    if (policySet.state !== "ready") continue;
    const policy = policySet.policies.get("candidate-document")!;
    const result = await db.insert(onbSensitiveLifecycleDeletionJobs).values({
      organizationId: upload.organizationId, dataClass: "candidate-document", caseId: upload.caseId, uploadId: upload.id,
      recordKind: "candidate-upload", recordId: String(upload.id),
      policyId: policy.id, policyRevision: policy.revision, policyRevisions: policySet.revisions,
    }).onConflictDoNothing().returning({ id: onbSensitiveLifecycleDeletionJobs.id });
    created += result.length;
  }
  return created;
}

type RelationalLifecycleRecord = {
  organizationId: string;
  caseId: number;
  createdAt: Date;
  dataClass: SensitiveDataClass;
  recordKind: "communication" | "voice-session" | "candidate-link" | "candidate-session";
  recordId: string;
  workforceContext: unknown;
};

/**
 * Candidate contact, terminal voice state, and portal credentials are
 * relational records.  They have no private-file byte to delete, but their
 * content/tokens still need a durable, policy-revision fenced lifecycle.
 */
async function scheduleExpiredRelationalRecords(now: Date, limit: number): Promise<number> {
  // Each relational query joins its current policy and applies retention,
  // jurisdiction, and no-prior-job predicates before LIMIT. This is an
  // indexed eligible query, not a rotating best-effort scan.
  const scanLimit = limit;
  const [communications, sessions, links, portalSessions] = await Promise.all([
    db.select({
      id: onbCommunications.id, organizationId: onbCommunications.organizationId,
      caseId: onbCommunications.caseId, createdAt: onbCommunications.createdAt,
      dataClass: onbCommunications.sensitiveDataClass, workforceContext: onbCases.workforceContext,
    }).from(onbCommunications).innerJoin(onbCases, and(
      eq(onbCases.organizationId, onbCommunications.organizationId),
      eq(onbCases.id, onbCommunications.caseId),
    )).innerJoin(onbSensitiveLifecyclePolicies, and(
      eq(onbSensitiveLifecyclePolicies.organizationId, onbCommunications.organizationId),
      eq(onbSensitiveLifecyclePolicies.dataClass, onbCommunications.sensitiveDataClass),
      eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    )).where(and(
      sql`${onbCommunications.createdAt} <= ${now}::timestamptz - (${onbSensitiveLifecyclePolicies.retentionDays} * interval '1 day')`,
      sql`(case when coalesce(${onbCases.workforceContext}->>'workState', '') <> ''
        then upper(${onbCases.workforceContext}->>'workCountry') || '-' || upper(${onbCases.workforceContext}->>'workState')
        else upper(${onbCases.workforceContext}->>'workCountry') end) = ${onbSensitiveLifecyclePolicies.jurisdiction}`,
      sql`not exists (
        select 1 from ${onbSensitiveLifecycleDeletionJobs}
        where ${onbSensitiveLifecycleDeletionJobs.organizationId} = ${onbCommunications.organizationId}
          and ${onbSensitiveLifecycleDeletionJobs.recordKind} = 'communication'
          and ${onbSensitiveLifecycleDeletionJobs.recordId} = ${onbCommunications.id}::text
      )`,
    )).orderBy(asc(onbCommunications.createdAt), asc(onbCommunications.id)).limit(scanLimit),
    db.select({
      token: onbVoiceSessions.token, organizationId: onbVoiceSessions.organizationId,
      caseId: onbVoiceSessions.caseId, createdAt: onbVoiceSessions.startedAt,
      finalized: onbVoiceSessions.finalized, workforceContext: onbCases.workforceContext,
    }).from(onbVoiceSessions).innerJoin(onbCases, and(
      eq(onbCases.organizationId, onbVoiceSessions.organizationId),
      eq(onbCases.id, onbVoiceSessions.caseId),
    )).innerJoin(onbSensitiveLifecyclePolicies, and(
      eq(onbSensitiveLifecyclePolicies.organizationId, onbVoiceSessions.organizationId),
      eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-voice"),
      eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    )).where(and(
      eq(onbVoiceSessions.finalized, true),
      sql`${onbVoiceSessions.startedAt} <= ${now}::timestamptz - (${onbSensitiveLifecyclePolicies.retentionDays} * interval '1 day')`,
      sql`(case when coalesce(${onbCases.workforceContext}->>'workState', '') <> ''
        then upper(${onbCases.workforceContext}->>'workCountry') || '-' || upper(${onbCases.workforceContext}->>'workState')
        else upper(${onbCases.workforceContext}->>'workCountry') end) = ${onbSensitiveLifecyclePolicies.jurisdiction}`,
      sql`not exists (select 1 from ${onbSensitiveLifecycleDeletionJobs}
        where ${onbSensitiveLifecycleDeletionJobs.organizationId} = ${onbVoiceSessions.organizationId}
          and ${onbSensitiveLifecycleDeletionJobs.recordKind} = 'voice-session'
          and ${onbSensitiveLifecycleDeletionJobs.recordId} = ${onbVoiceSessions.token})`,
    )).orderBy(asc(onbVoiceSessions.startedAt), asc(onbVoiceSessions.token)).limit(scanLimit),
    db.select({
      id: onbCandidateLinks.id, organizationId: onbCandidateLinks.organizationId,
      caseId: onbCandidateLinks.caseId, createdAt: onbCandidateLinks.createdAt,
      workforceContext: onbCases.workforceContext,
    }).from(onbCandidateLinks).innerJoin(onbCases, and(
      eq(onbCases.organizationId, onbCandidateLinks.organizationId),
      eq(onbCases.id, onbCandidateLinks.caseId),
    )).innerJoin(onbSensitiveLifecyclePolicies, and(
      eq(onbSensitiveLifecyclePolicies.organizationId, onbCandidateLinks.organizationId),
      eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-portal"),
      eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    )).where(and(
      sql`${onbCandidateLinks.createdAt} <= ${now}::timestamptz - (${onbSensitiveLifecyclePolicies.retentionDays} * interval '1 day')`,
      sql`(case when coalesce(${onbCases.workforceContext}->>'workState', '') <> ''
        then upper(${onbCases.workforceContext}->>'workCountry') || '-' || upper(${onbCases.workforceContext}->>'workState')
        else upper(${onbCases.workforceContext}->>'workCountry') end) = ${onbSensitiveLifecyclePolicies.jurisdiction}`,
      sql`not exists (select 1 from ${onbSensitiveLifecycleDeletionJobs}
        where ${onbSensitiveLifecycleDeletionJobs.organizationId} = ${onbCandidateLinks.organizationId}
          and ${onbSensitiveLifecycleDeletionJobs.recordKind} = 'candidate-link'
          and ${onbSensitiveLifecycleDeletionJobs.recordId} = ${onbCandidateLinks.id}::text)`,
    )).orderBy(asc(onbCandidateLinks.createdAt), asc(onbCandidateLinks.id)).limit(scanLimit),
    db.select({
      idHash: onbCandidateSessions.idHash, organizationId: onbCandidateSessions.organizationId,
      caseId: onbCandidateSessions.caseId, createdAt: onbCandidateSessions.createdAt,
      workforceContext: onbCases.workforceContext,
    }).from(onbCandidateSessions).innerJoin(onbCases, and(
      eq(onbCases.organizationId, onbCandidateSessions.organizationId),
      eq(onbCases.id, onbCandidateSessions.caseId),
    )).innerJoin(onbSensitiveLifecyclePolicies, and(
      eq(onbSensitiveLifecyclePolicies.organizationId, onbCandidateSessions.organizationId),
      eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-portal"),
      eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    )).where(and(
      sql`${onbCandidateSessions.createdAt} <= ${now}::timestamptz - (${onbSensitiveLifecyclePolicies.retentionDays} * interval '1 day')`,
      sql`(case when coalesce(${onbCases.workforceContext}->>'workState', '') <> ''
        then upper(${onbCases.workforceContext}->>'workCountry') || '-' || upper(${onbCases.workforceContext}->>'workState')
        else upper(${onbCases.workforceContext}->>'workCountry') end) = ${onbSensitiveLifecyclePolicies.jurisdiction}`,
      sql`not exists (select 1 from ${onbSensitiveLifecycleDeletionJobs}
        where ${onbSensitiveLifecycleDeletionJobs.organizationId} = ${onbCandidateSessions.organizationId}
          and ${onbSensitiveLifecycleDeletionJobs.recordKind} = 'candidate-session'
          and ${onbSensitiveLifecycleDeletionJobs.recordId} = ${onbCandidateSessions.idHash})`,
    )).orderBy(asc(onbCandidateSessions.createdAt), asc(onbCandidateSessions.idHash)).limit(scanLimit),
  ]);
  const records: RelationalLifecycleRecord[] = [
    ...communications
      .filter((row) => SENSITIVE_DATA_CLASSES.includes(row.dataClass as SensitiveDataClass))
      .map((row) => ({
      organizationId: row.organizationId, caseId: row.caseId, createdAt: row.createdAt,
      dataClass: row.dataClass as SensitiveDataClass,
      recordKind: "communication" as const, recordId: String(row.id), workforceContext: row.workforceContext,
      })),
    // Never schedule in-flight calls. The handler independently rechecks this
    // terminal state after claiming its job.
    ...sessions.filter((row) => row.finalized).map((row) => ({
      organizationId: row.organizationId, caseId: row.caseId, createdAt: row.createdAt,
      dataClass: "candidate-voice" as const, recordKind: "voice-session" as const,
      recordId: row.token, workforceContext: row.workforceContext,
    })),
    ...links.map((row) => ({
      organizationId: row.organizationId, caseId: row.caseId, createdAt: row.createdAt,
      dataClass: "candidate-portal" as const, recordKind: "candidate-link" as const,
      recordId: String(row.id), workforceContext: row.workforceContext,
    })),
    ...portalSessions.map((row) => ({
      organizationId: row.organizationId, caseId: row.caseId, createdAt: row.createdAt,
      dataClass: "candidate-portal" as const, recordKind: "candidate-session" as const,
      recordId: row.idHash, workforceContext: row.workforceContext,
    })),
  ];
  let created = 0;
  for (const record of records) {
    const gate = await evaluateSensitiveLifecycleGate({
      organizationId: record.organizationId,
      jurisdiction: jurisdictionForWorkforceContext(record.workforceContext),
      dataClass: record.dataClass,
      disclosure: false, collection: false,
    });
    if (!gate.allowed || !gate.policy) continue;
    if (record.createdAt > new Date(now.getTime() - gate.policy.retentionDays * 86_400_000)) continue;
    const result = await db.insert(onbSensitiveLifecycleDeletionJobs).values({
      organizationId: record.organizationId, dataClass: record.dataClass, caseId: record.caseId,
      recordKind: record.recordKind, recordId: record.recordId,
      policyId: gate.policy.id, policyRevision: gate.policy.revision,
    }).onConflictDoNothing().returning({ id: onbSensitiveLifecycleDeletionJobs.id });
    created += result.length;
  }
  return created;
}

async function blockJob(jobId: number, message: string) {
  await db.update(onbSensitiveLifecycleDeletionJobs).set({
    status: "blocked", lastError: message.slice(0, 500), claimOwner: null, claimUntil: null, updatedAt: new Date(),
  }).where(eq(onbSensitiveLifecycleDeletionJobs.id, jobId));
}

async function opaqueEnvelopeHoldApplies(tx: any, organizationId: string, caseId: number) {
  const [hold] = await tx.select({ id: onbSensitiveLifecycleHolds.id })
    .from(onbSensitiveLifecycleHolds).where(and(
      eq(onbSensitiveLifecycleHolds.organizationId, organizationId),
      eq(onbSensitiveLifecycleHolds.active, true),
      or(isNull(onbSensitiveLifecycleHolds.caseId), eq(onbSensitiveLifecycleHolds.caseId, caseId)),
      or(
        isNull(onbSensitiveLifecycleHolds.dataClass),
        inArray(onbSensitiveLifecycleHolds.dataClass, [...OPAQUE_CASE_DERIVED_CLASSES]),
      ),
    )).limit(1);
  return Boolean(hold);
}

/**
 * Retention starts from the newest source representation, not merely from case
 * creation. This is intentionally a complete, conservative inventory of the
 * mutable case-derived stores. There is no persisted AI chat/explanation
 * table in this schema; should one be added it must be included here before
 * its collection gate can be considered supported.
 */
async function newestCaseDerivedSourceAtInTransaction(
  tx: any, organizationId: string, caseId: number, workerEmail: string, caseUpdatedAt: Date,
): Promise<Date> {
  const newest = async (table: any, timestamp: any, predicate: any) => {
    const [row] = await tx.select({ at: timestamp }).from(table).where(predicate).orderBy(desc(timestamp)).limit(1);
    return row?.at as Date | undefined;
  };
  const settings = await tx.select({ key: onbSettings.key, value: onbSettings.value, updatedAt: onbSettings.updatedAt })
    .from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      or(
        eq(onbSettings.key, `${OPERATIONAL_REQUEST_SETTING_PREFIX}${caseId}`),
        sql`${onbSettings.key} like ${`${DEMO_RUN_SETTING_PREFIX}%`}`,
      ),
    ));
  const settingTimestamps: Date[] = [];
  for (const row of settings) {
    if (row.key === `${OPERATIONAL_REQUEST_SETTING_PREFIX}${caseId}`) {
      settingTimestamps.push(row.updatedAt);
      continue;
    }
    try {
      const value = JSON.parse(row.value) as { caseId?: unknown };
      if (value && typeof value === "object" && value.caseId === caseId) settingTimestamps.push(row.updatedAt);
    } catch {
      // The collection gate and deletion handler surface unparseable values as
      // a fail-closed review requirement; never infer case ownership here.
    }
  }
  const timestamps = await Promise.all([
    newest(onbEvents, onbEvents.createdAt, and(eq(onbEvents.organizationId, organizationId), eq(onbEvents.caseId, caseId))),
    newest(onbApprovals, onbApprovals.createdAt, and(eq(onbApprovals.organizationId, organizationId), eq(onbApprovals.caseId, caseId))),
    newest(onbDocuments, onbDocuments.updatedAt, and(eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId))),
    newest(onbCandidateUploads, onbCandidateUploads.createdAt, and(eq(onbCandidateUploads.organizationId, organizationId), eq(onbCandidateUploads.caseId, caseId))),
    newest(onbSensitiveObjectManifests, onbSensitiveObjectManifests.updatedAt, and(eq(onbSensitiveObjectManifests.organizationId, organizationId), eq(onbSensitiveObjectManifests.caseId, caseId))),
    newest(onbSystemChecks, onbSystemChecks.requestedAt, and(eq(onbSystemChecks.organizationId, organizationId), eq(onbSystemChecks.caseId, caseId))),
    newest(onbSystemChecks, onbSystemChecks.lastCheckedAt, and(eq(onbSystemChecks.organizationId, organizationId), eq(onbSystemChecks.caseId, caseId))),
    newest(onbCaseLogistics, onbCaseLogistics.updatedAt, and(eq(onbCaseLogistics.organizationId, organizationId), eq(onbCaseLogistics.caseId, caseId))),
    newest(onbCallSlots, onbCallSlots.createdAt, and(eq(onbCallSlots.organizationId, organizationId), eq(onbCallSlots.caseId, caseId))),
    newest(onbWatchEmails, onbWatchEmails.receivedAt, and(eq(onbWatchEmails.organizationId, organizationId), eq(onbWatchEmails.caseId, caseId))),
    newest(onbGuardrailEvents, onbGuardrailEvents.createdAt, and(eq(onbGuardrailEvents.organizationId, organizationId), eq(onbGuardrailEvents.caseId, caseId))),
    newest(onbApprovalHistory, onbApprovalHistory.createdAt, and(eq(onbApprovalHistory.organizationId, organizationId), eq(onbApprovalHistory.caseId, caseId))),
    newest(onbApprovalNotifications, onbApprovalNotifications.createdAt, and(eq(onbApprovalNotifications.organizationId, organizationId), eq(onbApprovalNotifications.caseId, caseId))),
    newest(onbReadinessSlaSnapshots, onbReadinessSlaSnapshots.createdAt, and(eq(onbReadinessSlaSnapshots.organizationId, organizationId), eq(onbReadinessSlaSnapshots.caseId, caseId))),
    newest(onbReadinessSlaCaseState, onbReadinessSlaCaseState.updatedAt, and(eq(onbReadinessSlaCaseState.organizationId, organizationId), eq(onbReadinessSlaCaseState.caseId, caseId))),
    newest(onbReadinessSlaAttestations, onbReadinessSlaAttestations.createdAt, and(eq(onbReadinessSlaAttestations.organizationId, organizationId), eq(onbReadinessSlaAttestations.caseId, caseId))),
    newest(onbReadinessSlaLedger, onbReadinessSlaLedger.updatedAt, and(eq(onbReadinessSlaLedger.organizationId, organizationId), eq(onbReadinessSlaLedger.caseId, caseId))),
    newest(onbReadinessSlaOutbox, onbReadinessSlaOutbox.updatedAt, and(eq(onbReadinessSlaOutbox.organizationId, organizationId), eq(onbReadinessSlaOutbox.caseId, caseId))),
    newest(onbActionCenterActions, onbActionCenterActions.updatedAt, and(eq(onbActionCenterActions.organizationId, organizationId), eq(onbActionCenterActions.caseId, caseId))),
    newest(onbPolicyEvidence, onbPolicyEvidence.createdAt, and(eq(onbPolicyEvidence.organizationId, organizationId), eq(onbPolicyEvidence.caseId, caseId))),
    newest(onbPolicyAuthorities, onbPolicyAuthorities.createdAt, and(eq(onbPolicyAuthorities.organizationId, organizationId), eq(onbPolicyAuthorities.caseId, caseId))),
    newest(onbFrontlineEvidence, onbFrontlineEvidence.createdAt, and(eq(onbFrontlineEvidence.organizationId, organizationId), eq(onbFrontlineEvidence.caseId, caseId))),
    newest(onbFrontlineFulfillments, onbFrontlineFulfillments.createdAt, and(eq(onbFrontlineFulfillments.organizationId, organizationId), eq(onbFrontlineFulfillments.caseId, caseId))),
    newest(onbFrontlineKpiInputs, onbFrontlineKpiInputs.createdAt, and(eq(onbFrontlineKpiInputs.organizationId, organizationId), eq(onbFrontlineKpiInputs.caseId, caseId))),
    newest(onbFrontlinePolicyExceptions, onbFrontlinePolicyExceptions.createdAt, and(eq(onbFrontlinePolicyExceptions.organizationId, organizationId), eq(onbFrontlinePolicyExceptions.caseId, caseId))),
    newest(onbFrontlinePolicyExceptions, onbFrontlinePolicyExceptions.revokedAt, and(eq(onbFrontlinePolicyExceptions.organizationId, organizationId), eq(onbFrontlinePolicyExceptions.caseId, caseId))),
    newest(onbFrontlineReleaseState, onbFrontlineReleaseState.updatedAt, and(eq(onbFrontlineReleaseState.organizationId, organizationId), eq(onbFrontlineReleaseState.caseId, caseId))),
    // Early-tenure tasks, actual-join anchors, acknowledgements and probation
    // records are opaque case-derived evidence. Include every mutable source
    // in the retention watermark so they cannot outlive an unnoticed later
    // source representation.
    newest(onbEarlyTenureCaseSnapshots, onbEarlyTenureCaseSnapshots.updatedAt, and(eq(onbEarlyTenureCaseSnapshots.organizationId, organizationId), eq(onbEarlyTenureCaseSnapshots.caseId, caseId))),
    newest(onbEarlyTenureAssignments, onbEarlyTenureAssignments.updatedAt, and(eq(onbEarlyTenureAssignments.organizationId, organizationId), eq(onbEarlyTenureAssignments.caseId, caseId))),
    newest(onbEarlyTenureCheckins, onbEarlyTenureCheckins.updatedAt, and(eq(onbEarlyTenureCheckins.organizationId, organizationId), eq(onbEarlyTenureCheckins.caseId, caseId))),
    newest(onbEarlyTenureEvidence, onbEarlyTenureEvidence.createdAt, and(eq(onbEarlyTenureEvidence.organizationId, organizationId), eq(onbEarlyTenureEvidence.caseId, caseId))),
    newest(onbEarlyTenureEvidence, onbEarlyTenureEvidence.observedAt, and(eq(onbEarlyTenureEvidence.organizationId, organizationId), eq(onbEarlyTenureEvidence.caseId, caseId))),
    newest(onbEarlyTenureReminders, onbEarlyTenureReminders.updatedAt, and(eq(onbEarlyTenureReminders.organizationId, organizationId), eq(onbEarlyTenureReminders.caseId, caseId))),
    newest(onbProbationDecisions, onbProbationDecisions.createdAt, and(eq(onbProbationDecisions.organizationId, organizationId), eq(onbProbationDecisions.caseId, caseId))),
    // Restricted outcome evidence carries actual employment dates and survey
    // scores. It is not safely redactable because its authorization/source
    // checks are deliberately non-null, so the lifecycle worker deletes it.
    newest(onbEarlyTenureSurveyResponses, onbEarlyTenureSurveyResponses.createdAt, and(eq(onbEarlyTenureSurveyResponses.organizationId, organizationId), eq(onbEarlyTenureSurveyResponses.caseId, caseId))),
    newest(onbEarlyTenureSurveyResponses, onbEarlyTenureSurveyResponses.submittedAt, and(eq(onbEarlyTenureSurveyResponses.organizationId, organizationId), eq(onbEarlyTenureSurveyResponses.caseId, caseId))),
    newest(onbEmploymentOutcomeEvidence, onbEmploymentOutcomeEvidence.createdAt, and(eq(onbEmploymentOutcomeEvidence.organizationId, organizationId), eq(onbEmploymentOutcomeEvidence.caseId, caseId))),
    newest(onbEmploymentOutcomeEvidence, onbEmploymentOutcomeEvidence.observedAt, and(eq(onbEmploymentOutcomeEvidence.organizationId, organizationId), eq(onbEmploymentOutcomeEvidence.caseId, caseId))),
    newest(onbOutcomeEvidenceAuthorityReceipts, onbOutcomeEvidenceAuthorityReceipts.verifiedAt, and(eq(onbOutcomeEvidenceAuthorityReceipts.organizationId, organizationId), eq(onbOutcomeEvidenceAuthorityReceipts.caseId, caseId))),
    newest(onbIntakeBatchPeople, onbIntakeBatchPeople.createdAt, and(eq(onbIntakeBatchPeople.organizationId, organizationId), eq(onbIntakeBatchPeople.caseId, caseId))),
    // Server-confirmed provider source IDs/evidence and standard-intake
    // snapshots are case-derived references. They are inventory roots even
    // though the lifecycle worker preserves their rows and linkage.
    newest(onbStandardProviderSourceRecords, onbStandardProviderSourceRecords.recordedAt, and(
      eq(onbStandardProviderSourceRecords.organizationId, organizationId),
      eq(onbStandardProviderSourceRecords.caseId, caseId),
    )),
    newest(onbStandardProviderSourceRecords, onbStandardProviderSourceRecords.sourceObservedAt, and(
      eq(onbStandardProviderSourceRecords.organizationId, organizationId),
      eq(onbStandardProviderSourceRecords.caseId, caseId),
    )),
    newest(onbStandardIntakeEvents, onbStandardIntakeEvents.createdAt, and(
      eq(onbStandardIntakeEvents.organizationId, organizationId),
      eq(onbStandardIntakeEvents.caseId, caseId),
    )),
    newest(onbStandardIntakeEvents, onbStandardIntakeEvents.replayedAt, and(
      eq(onbStandardIntakeEvents.organizationId, organizationId),
      eq(onbStandardIntakeEvents.caseId, caseId),
    )),
    newest(onbStandardIntakeEvents, onbStandardIntakeEvents.activationReleasedAt, and(
      eq(onbStandardIntakeEvents.organizationId, organizationId),
      eq(onbStandardIntakeEvents.caseId, caseId),
    )),
    newest(onbEmployeeRecords, onbEmployeeRecords.createdAt, and(
      eq(onbEmployeeRecords.organizationId, organizationId),
      sql`lower(${onbEmployeeRecords.workerEmail}) = lower(${workerEmail})`,
    )),
  ]);
  return [...timestamps, ...settingTimestamps].reduce<Date>((latest, value) => value && value > latest ? value : latest, caseUpdatedAt);
}

async function processCaseDerivedEnvelopeDeletionJob(
  job: typeof onbSensitiveLifecycleDeletionJobs.$inferSelect,
  now: Date,
) {
  return db.transaction(async (tx) => {
    if (!job.caseId || job.recordId !== `case-derived-envelope:${job.caseId}`) {
      return { state: "blocked" as const, message: "Case-derived envelope job is missing a stable case identity." };
    }
    const [caseRow] = await tx.select().from(onbCases).where(and(
      eq(onbCases.organizationId, job.organizationId), eq(onbCases.id, job.caseId),
    )).for("update");
    if (!caseRow) return { state: "complete" as const };
    const jurisdiction = jurisdictionForWorkforceContext(caseRow.workforceContext);
    if (!jurisdiction) {
      // Eight class-fenced jobs may be queued for one opaque envelope. Once
      // one has durably completed, its siblings observe the explicit
      // minimisation marker rather than treating the intentionally-cleared
      // workforce context as a new unresolved record.
      if (caseRow.workerName === "[minimized]" &&
          caseRow.workerEmail === `case-${caseRow.id}@minimized.invalid`) {
        await tx.update(onbSensitiveLifecycleDeletionJobs).set({
          status: "completed", completedAt: now, claimOwner: null, claimUntil: null, updatedAt: now,
        }).where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
        return { state: "complete" as const };
      }
      return { state: "blocked" as const, message: "Case-derived envelope has no current workforce jurisdiction; automatic minimisation is blocked." };
    }
    const expected = job.policyRevisions as PolicyRevisionSet;
    if (Object.keys(expected).length !== OPAQUE_CASE_DERIVED_CLASSES.length) {
      return { state: "blocked" as const, message: "Case-derived envelope lacks a complete all-class policy revision inventory." };
    }
    const newestSourceAt = await newestCaseDerivedSourceAtInTransaction(
      tx, job.organizationId, job.caseId, caseRow.workerEmail, caseRow.updatedAt,
    );
    const policySet = await opaqueCasePolicySetInTransaction(tx, {
      organizationId: job.organizationId, jurisdiction, now, createdAt: newestSourceAt, expected,
    });
    if (policySet.state !== "ready") return policySet;
    const expectedJobPolicy = expected[job.dataClass];
    if (!expectedJobPolicy || expectedJobPolicy.id !== job.policyId || expectedJobPolicy.revision !== job.policyRevision) {
      return { state: "blocked" as const, message: "Case-derived envelope job policy identity does not match its all-class revision inventory." };
    }
    if (await opaqueEnvelopeHoldApplies(tx, job.organizationId, job.caseId)) {
      return { state: "blocked" as const, message: "An active legal/privacy hold for an applicable sensitive class blocks case-envelope minimisation." };
    }
    // A manifest with no candidate-upload row is an unaccounted primary or
    // derivative representation. Never redact the relational inventory and
    // make an operator believe the case has been fully minimised.
    const [unaccountedObject] = await tx.select({ id: onbSensitiveObjectManifests.id })
      .from(onbSensitiveObjectManifests)
      .where(and(
        eq(onbSensitiveObjectManifests.organizationId, job.organizationId),
        eq(onbSensitiveObjectManifests.caseId, job.caseId),
        sql`not exists (select 1 from ${onbCandidateUploads}
          where ${onbCandidateUploads.organizationId} = ${job.organizationId}
            and ${onbCandidateUploads.objectPath} = ${onbSensitiveObjectManifests.objectPath})`,
      )).limit(1);
    if (unaccountedObject) {
      return { state: "blocked" as const, message: "A case object manifest has no accountable candidate-upload primary record; automatic minimisation fails closed." };
    }
    // Approval history has an independent append-only database trigger and is
    // retained even when its live case disappears. It is not the protected
    // audit hash chain, but it is still immutable evidence. Only the exact
    // server-owned minimal projection is safe to retain; opaque legacy rows
    // require a governed-retention exception rather than a rewrite.
    const [immutableApprovalHistory] = await tx.select({ id: onbApprovalHistory.id })
      .from(onbApprovalHistory).where(and(
        eq(onbApprovalHistory.organizationId, job.organizationId),
        eq(onbApprovalHistory.caseId, job.caseId),
        sql`not ${SAFE_GOVERNED_APPROVAL_HISTORY_PROJECTION}`,
      )).limit(1);
    if (immutableApprovalHistory) {
      return {
        state: "blocked" as const,
        message: "Append-only approval history is retained independently and may contain opaque sensitive snapshots; automatic case minimisation is blocked pending a governed audit-retention exception or manual remediation.",
      };
    }
    const caseDerivedSettings = await caseDerivedSettingKeysForMinimisationInTransaction(
      tx, job.organizationId, job.caseId,
    );
    if (caseDerivedSettings.error) return { state: "blocked" as const, message: caseDerivedSettings.error };

    const originalEmail = caseRow.workerEmail;
    const archived = await tx.select({ id: onbEmployeeRecords.id }).from(onbEmployeeRecords).where(and(
      eq(onbEmployeeRecords.organizationId, job.organizationId),
      sql`lower(${onbEmployeeRecords.workerEmail}) = lower(${originalEmail})`,
    )).for("update");

    // Preserve the case record, its identifier, all lifecycle/check statuses,
    // and foreign-key links. Only case-derived personal/narrative content is
    // replaced with a non-original minimisation marker.
    await tx.update(onbCases).set({
      workerName: "[minimized]", workerEmail: `case-${caseRow.id}@minimized.invalid`,
      workerPhone: null, channelPreference: "minimized", workerBand: null,
      role: "[minimized]", department: "[minimized]", geography: "[minimized]",
      legalEntity: "[minimized]", managerName: "[minimized]", recruiterName: "[minimized]",
      joiningDate: "[minimized]", workforceContext: {}, workforceClassification: null,
      checklistSnapshot: [], checklistMatchedCriteria: {}, checklistMatchExplanation: "[minimized]",
      processPolicySnapshot: {}, readiness: [], workstreams: [],
      primarySkill: null, skillCriticality: null, scenarioKey: null,
      planSummary: null, notes: null, candidateEmailAuthorizedAt: null, candidateEmailAuthorizedBy: null,
      offerAcceptanceCompletedAt: null, offerAcceptanceCompletedBy: null, createdByUserId: null, updatedAt: now,
    }).where(and(eq(onbCases.organizationId, job.organizationId), eq(onbCases.id, job.caseId)));
    await tx.update(onbEvents).set({ title: "[minimized]", detail: "[minimized]" })
      .where(and(eq(onbEvents.organizationId, job.organizationId), eq(onbEvents.caseId, job.caseId)));
    await tx.update(onbApprovals).set({
      recommendation: "[minimized]", rationale: "[minimized]", recordsEvidence: null,
      comment: null, resumeAction: null, decidedBy: null, requestedByUserId: null,
      authorityReviewedByUserId: null,
    }).where(and(eq(onbApprovals.organizationId, job.organizationId), eq(onbApprovals.caseId, job.caseId)));
    await tx.update(onbSystemChecks).set({ externalRef: "[minimized]", note: null })
      .where(and(eq(onbSystemChecks.organizationId, job.organizationId), eq(onbSystemChecks.caseId, job.caseId)));
    await tx.update(onbDocuments).set({
      key: sql`'minimized-' || ${onbDocuments.id}::text`, label: "[minimized]", note: null,
    }).where(and(
      eq(onbDocuments.organizationId, job.organizationId), eq(onbDocuments.caseId, job.caseId),
      sql`not exists (select 1 from ${onbCandidateUploads}
        where ${onbCandidateUploads.organizationId} = ${job.organizationId}
          and ${onbCandidateUploads.documentId} = ${onbDocuments.id})`,
    ));
    await tx.update(onbCaseLogistics).set({
      orientationDate: null, orientationTime: null, timezone: null, format: null,
      venueAddress: null, googleMapsUrl: null, meetingUrl: null, reportingContact: null, arrivalInstructions: null,
    }).where(and(eq(onbCaseLogistics.organizationId, job.organizationId), eq(onbCaseLogistics.caseId, job.caseId)));
    await tx.update(onbCallSlots).set({ slots: [] })
      .where(and(eq(onbCallSlots.organizationId, job.organizationId), eq(onbCallSlots.caseId, job.caseId)));
    await tx.update(onbWatchEmails).set({
      fromAddress: "[minimized]", subject: null, snippet: null, action: "[minimized]",
    }).where(and(eq(onbWatchEmails.organizationId, job.organizationId), eq(onbWatchEmails.caseId, job.caseId)));
    await tx.update(onbGuardrailEvents).set({ detail: "[minimized]" })
      .where(and(eq(onbGuardrailEvents.organizationId, job.organizationId), eq(onbGuardrailEvents.caseId, job.caseId)));
    await tx.update(onbApprovalNotifications).set({
      recipient: "[minimized]", subject: "[minimized]", body: "[minimized]",
      failureReason: null, providerMessageId: null, sourceMessageId: null,
    }).where(and(eq(onbApprovalNotifications.organizationId, job.organizationId), eq(onbApprovalNotifications.caseId, job.caseId)));
    await tx.update(onbReadinessSlaSnapshots).set({
      joiningDate: null, policy: { streams: [], actions: [] }, applicability: [], createdBy: "[minimized]",
    }).where(and(eq(onbReadinessSlaSnapshots.organizationId, job.organizationId), eq(onbReadinessSlaSnapshots.caseId, job.caseId)));
    await tx.update(onbReadinessSlaCaseState).set({
      payrollCutoff: null, payrollCutoffReason: null, payrollCutoffSetBy: null, payrollCutoffSetAt: null, updatedAt: now,
    }).where(and(eq(onbReadinessSlaCaseState.organizationId, job.organizationId), eq(onbReadinessSlaCaseState.caseId, job.caseId)));
    await tx.update(onbReadinessSlaAttestations).set({
      reason: "[minimized]", attestedBy: "[minimized]", attestedRole: "[minimized]",
      sourceStartDate: null, sourceEvidenceRevision: null,
    }).where(and(eq(onbReadinessSlaAttestations.organizationId, job.organizationId), eq(onbReadinessSlaAttestations.caseId, job.caseId)));
    await tx.update(onbReadinessSlaLedger).set({ lastRationale: null, history: [], updatedAt: now })
      .where(and(eq(onbReadinessSlaLedger.organizationId, job.organizationId), eq(onbReadinessSlaLedger.caseId, job.caseId)));
    await tx.update(onbReadinessSlaOutbox).set({
      recipient: null, payload: {}, deliveryInfo: null, lastError: null, updatedAt: now,
    }).where(and(eq(onbReadinessSlaOutbox.organizationId, job.organizationId), eq(onbReadinessSlaOutbox.caseId, job.caseId)));
    await tx.update(onbActionCenterActions).set({
      owner: null, assignee: null, outcome: null, notes: null, persona: null,
      actorUserId: "[minimized]", actorName: "[minimized]", payload: {}, updatedAt: now,
    }).where(and(eq(onbActionCenterActions.organizationId, job.organizationId), eq(onbActionCenterActions.caseId, job.caseId)));
    await tx.update(onbPolicyEvidence).set({
      evidenceReference: "[minimized]", reason: "[minimized]", verifiedBy: "[minimized]", verifiedByUserId: "[minimized]",
    }).where(and(eq(onbPolicyEvidence.organizationId, job.organizationId), eq(onbPolicyEvidence.caseId, job.caseId)));
    await tx.update(onbPolicyAuthorities).set({
      userId: sql`'minimized-' || ${onbPolicyAuthorities.userId}`, site: "[minimized]", assignedBy: "[minimized]",
    }).where(and(eq(onbPolicyAuthorities.organizationId, job.organizationId), eq(onbPolicyAuthorities.caseId, job.caseId)));
    // Frontline issue, authority, medical/payroll/statutory and KPI references
    // are private source evidence; they are deleted rather than retained as a
    // misleading minimised receipt.
    await tx.delete(onbFrontlineFulfillments).where(and(eq(onbFrontlineFulfillments.organizationId, job.organizationId), eq(onbFrontlineFulfillments.caseId, job.caseId)));
    await tx.delete(onbFrontlinePolicyExceptions).where(and(eq(onbFrontlinePolicyExceptions.organizationId, job.organizationId), eq(onbFrontlinePolicyExceptions.caseId, job.caseId)));
    await tx.delete(onbFrontlineEvidence).where(and(eq(onbFrontlineEvidence.organizationId, job.organizationId), eq(onbFrontlineEvidence.caseId, job.caseId)));
    await tx.delete(onbFrontlineKpiInputs).where(and(eq(onbFrontlineKpiInputs.organizationId, job.organizationId), eq(onbFrontlineKpiInputs.caseId, job.caseId)));
    await tx.delete(onbFrontlineReleaseState).where(and(eq(onbFrontlineReleaseState.organizationId, job.organizationId), eq(onbFrontlineReleaseState.caseId, job.caseId)));
    await tx.update(onbEarlyTenureCaseSnapshots).set({
      plannedJoiningDate: "[minimized]", actualJoinedAt: null,
      policy: {
        applicability: {}, probationLengthDays: 1,
        decisionAuthorityScope: "hr-compliance-approve", obligations: [], checkIns: [],
      },
      enrolledByUserId: "[minimized]", enrolledBy: "[minimized]", updatedAt: now,
    }).where(and(eq(onbEarlyTenureCaseSnapshots.organizationId, job.organizationId), eq(onbEarlyTenureCaseSnapshots.caseId, job.caseId)));
    await tx.update(onbEarlyTenureAssignments).set({
      title: "[minimized]", ownerName: "[minimized]", ownerUserId: null,
      requiredConnectorKey: null, taskDetails: {}, completedByUserId: null, updatedAt: now,
    }).where(and(eq(onbEarlyTenureAssignments.organizationId, job.organizationId), eq(onbEarlyTenureAssignments.caseId, job.caseId)));
    // Once a case has crossed the approved minimization boundary, outstanding
    // early-tenure work cannot be resurrected by a later reminder scan. Keep
    // completed historical structure intact, but terminally cancel active
    // targets and suppress both unclaimed and already-claimed reminder rows.
    await tx.update(onbEarlyTenureAssignments).set({
      status: "cancelled", updatedAt: now,
    }).where(and(
      eq(onbEarlyTenureAssignments.organizationId, job.organizationId),
      eq(onbEarlyTenureAssignments.caseId, job.caseId),
      eq(onbEarlyTenureAssignments.status, "pending"),
    ));
    await tx.update(onbEarlyTenureEvidence).set({
      evidenceReference: "[minimized]", sourceConnectorKey: null,
      recordedByUserId: "[minimized]", recordedBy: "[minimized]", note: null,
    }).where(and(eq(onbEarlyTenureEvidence.organizationId, job.organizationId), eq(onbEarlyTenureEvidence.caseId, job.caseId)));
    await tx.update(onbEarlyTenureCheckins).set({
      label: "[minimized]", ownerUserId: null, completedByUserId: null, evidenceReference: null, updatedAt: now,
    }).where(and(eq(onbEarlyTenureCheckins.organizationId, job.organizationId), eq(onbEarlyTenureCheckins.caseId, job.caseId)));
    await tx.update(onbEarlyTenureCheckins).set({
      status: "cancelled", updatedAt: now,
    }).where(and(
      eq(onbEarlyTenureCheckins.organizationId, job.organizationId),
      eq(onbEarlyTenureCheckins.caseId, job.caseId),
      eq(onbEarlyTenureCheckins.status, "scheduled"),
    ));
    await tx.update(onbEarlyTenureReminders).set({
      intendedRecipient: "[minimized]", recipientEmail: null, deliveryInfo: null, lastError: null,
      status: sql`case when ${onbEarlyTenureReminders.status} in ('pending', 'claimed') then 'suppressed' else ${onbEarlyTenureReminders.status} end`,
      claimOwner: null, claimUntil: null, updatedAt: now,
    }).where(and(eq(onbEarlyTenureReminders.organizationId, job.organizationId), eq(onbEarlyTenureReminders.caseId, job.caseId)));
    await tx.update(onbProbationDecisions).set({
      rationale: "[minimized]", evidenceReference: "[minimized]", decidedByUserId: "[minimized]", decidedBy: "[minimized]",
      authorityId: "[minimized]",
    }).where(and(eq(onbProbationDecisions.organizationId, job.organizationId), eq(onbProbationDecisions.caseId, job.caseId)));
    await tx.delete(onbEarlyTenureSurveyResponses).where(and(
      eq(onbEarlyTenureSurveyResponses.organizationId, job.organizationId),
      eq(onbEarlyTenureSurveyResponses.caseId, job.caseId),
    ));
    await tx.delete(onbEmploymentOutcomeEvidence).where(and(
      eq(onbEmploymentOutcomeEvidence.organizationId, job.organizationId),
      eq(onbEmploymentOutcomeEvidence.caseId, job.caseId),
    ));
    await tx.delete(onbOutcomeEvidenceAuthorityReceipts).where(and(
      eq(onbOutcomeEvidenceAuthorityReceipts.organizationId, job.organizationId),
      eq(onbOutcomeEvidenceAuthorityReceipts.caseId, job.caseId),
    ));
    await tx.update(onbIntakeBatchPeople).set({
      personKey: sql`'minimized-' || ${onbIntakeBatchPeople.personKey}`,
      workforceContextSnapshot: {}, processPolicySnapshot: {},
    }).where(and(eq(onbIntakeBatchPeople.organizationId, job.organizationId), eq(onbIntakeBatchPeople.caseId, job.caseId)));
    // Keep durable provider/intake register rows and their case linkage for
    // audit/idempotency, while removing all original person/provider evidence
    // and opaque snapshots. The synthetic provider ID is per-row so its
    // organization/provider/type uniqueness constraint remains valid.
    await tx.update(onbStandardProviderSourceRecords).set({
      sourceRecordId: sql`'minimized-' || ${onbStandardProviderSourceRecords.id}::text`,
      normalizedState: "[minimized]",
      evidenceReference: "[minimized]",
      fieldSnapshot: {},
      recordedBy: "[minimized]",
    }).where(and(
      eq(onbStandardProviderSourceRecords.organizationId, job.organizationId),
      eq(onbStandardProviderSourceRecords.caseId, job.caseId),
    ));
    await tx.update(onbStandardIntakeEvents).set({
      sourceIdentity: "[minimized]",
      acceptanceEvidenceReference: "[minimized]",
      payloadFingerprint: "[minimized]",
      intakeSnapshot: {},
      workforceContextSnapshot: {},
      processPolicySnapshot: {},
      failureReason: sql`case when ${onbStandardIntakeEvents.failureReason} is null then null else '[minimized]' end`,
      activationReleasedBy: sql`case when ${onbStandardIntakeEvents.activationReleasedBy} is null then null else '[minimized]' end`,
    }).where(and(
      eq(onbStandardIntakeEvents.organizationId, job.organizationId),
      eq(onbStandardIntakeEvents.caseId, job.caseId),
    ));
    // These setting namespaces are server-owned case representations. Delete
    // only the exact operational key and demo ledgers whose parsed single
    // caseId matches; other tenant configuration and other demo runs remain.
    if (caseDerivedSettings.keys.length) {
      await tx.delete(onbSettings).where(and(
        eq(onbSettings.organizationId, job.organizationId),
        inArray(onbSettings.key, caseDerivedSettings.keys),
      ));
    }
    if (archived.length) {
      await tx.update(onbEmployeeRecords).set({
        workerEmail: sql`'minimized-' || ${onbEmployeeRecords.id}::text || '@invalid'`,
        workerName: "[minimized]", role: "[minimized]", department: "[minimized]",
        startDate: "[minimized]", endDate: "[minimized]", exitReason: "[minimized]",
        noticeRequiredDays: 0, noticeServedDays: 0, performanceRating: "[minimized]",
        rehireEligible: false, notes: null,
      }).where(inArray(onbEmployeeRecords.id, archived.map((row: { id: number }) => row.id)));
    }
    await tx.update(onbSensitiveLifecycleDeletionJobs).set({
      status: "completed", completedAt: now, claimOwner: null, claimUntil: null, updatedAt: now,
    }).where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
    await appendProtectedAuditInTransaction(tx, {
      organizationId: job.organizationId, actorKind: "system", actorAuthority: "sensitive-lifecycle-worker",
      action: "privacy.sensitive-lifecycle.case-derived-envelope-minimized", outcome: "success",
      objectType: "case-derived-envelope", objectId: job.recordId, caseReference: `case:${job.caseId}`,
      reviewedRevision: job.policyRevision, source: "sensitive-lifecycle-worker",
    });
    return { state: "complete" as const };
  });
}

async function relationalRecordIsSafeToDeleteInTransaction(tx: any, job: typeof onbSensitiveLifecycleDeletionJobs.$inferSelect, now: Date) {
  const caseId = job.caseId;
  if (!caseId) {
    return { state: "blocked" as const, message: "Relational lifecycle job is missing its case identity." };
  }
  const [current] = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.id, job.policyId),
    eq(onbSensitiveLifecyclePolicies.organizationId, job.organizationId),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
  )).for("update");
  if (!current || current.revision !== job.policyRevision || current.dataClass !== job.dataClass) {
    return { state: "blocked" as const, message: "Policy revision changed; deletion requires a fresh policy evaluation." };
  }
  const [caseRow] = await tx.select({ workforceContext: onbCases.workforceContext })
    .from(onbCases).where(and(
      eq(onbCases.organizationId, job.organizationId),
      eq(onbCases.id, caseId),
    )).for("update");
  if (!caseRow || jurisdictionForWorkforceContext(caseRow.workforceContext) !== current.jurisdiction) {
    return { state: "blocked" as const, message: "Current workforce jurisdiction no longer matches the queued policy." };
  }
  if (await holdApplies(tx, {
    organizationId: job.organizationId, dataClasses: [job.dataClass], caseId, objectPath: null,
  })) {
    return { state: "blocked" as const, message: "An active legal/privacy hold blocks deletion." };
  }
  // A manifest for a relational class is an explicit declaration that external
  // bytes/derivatives exist. There is no safe generic eraser for those bytes;
  // fail closed rather than redacting the row and leaving an untracked copy.
  const [externalObject] = await tx.select({ id: onbSensitiveObjectManifests.id })
    .from(onbSensitiveObjectManifests).where(and(
      eq(onbSensitiveObjectManifests.organizationId, job.organizationId),
      eq(onbSensitiveObjectManifests.dataClass, job.dataClass),
      eq(onbSensitiveObjectManifests.caseId, caseId),
    )).limit(1);
  if (externalObject) {
    return {
      state: "blocked" as const,
      message: "An external object or derivative is recorded for this relational class; no unsafe generic byte deletion is available.",
    };
  }

  let createdAt: Date | null = null;
  if (job.recordKind === "communication") {
    const [record] = await tx.select({
      id: onbCommunications.id, caseId: onbCommunications.caseId, createdAt: onbCommunications.createdAt,
      dataClass: onbCommunications.sensitiveDataClass,
    }).from(onbCommunications).where(and(
      eq(onbCommunications.organizationId, job.organizationId),
      eq(onbCommunications.id, Number(job.recordId)),
    )).for("update");
    if (!record) return { state: "complete" as const };
    if (record.caseId !== caseId || record.dataClass !== job.dataClass) return { state: "blocked" as const, message: "Record class or case identity changed; deletion is blocked." };
    createdAt = record.createdAt;
  } else if (job.recordKind === "voice-session") {
    const [record] = await tx.select({
      token: onbVoiceSessions.token, caseId: onbVoiceSessions.caseId,
      startedAt: onbVoiceSessions.startedAt, finalized: onbVoiceSessions.finalized,
    }).from(onbVoiceSessions).where(and(
      eq(onbVoiceSessions.organizationId, job.organizationId),
      eq(onbVoiceSessions.token, job.recordId),
    )).for("update");
    if (!record) return { state: "complete" as const };
    if (record.caseId !== caseId) return { state: "blocked" as const, message: "Record case identity changed; deletion is blocked." };
    if (!record.finalized) return { state: "blocked" as const, message: "An in-flight voice session must never be redacted or deleted." };
    createdAt = record.startedAt;
  } else if (job.recordKind === "candidate-link") {
    const [record] = await tx.select({
      id: onbCandidateLinks.id, caseId: onbCandidateLinks.caseId, createdAt: onbCandidateLinks.createdAt,
    }).from(onbCandidateLinks).where(and(
      eq(onbCandidateLinks.organizationId, job.organizationId),
      eq(onbCandidateLinks.id, Number(job.recordId)),
    )).for("update");
    if (!record) return { state: "complete" as const };
    if (record.caseId !== caseId) return { state: "blocked" as const, message: "Record case identity changed; deletion is blocked." };
    createdAt = record.createdAt;
  } else if (job.recordKind === "candidate-session") {
    const [record] = await tx.select({
      idHash: onbCandidateSessions.idHash, caseId: onbCandidateSessions.caseId, createdAt: onbCandidateSessions.createdAt,
    }).from(onbCandidateSessions).where(and(
      eq(onbCandidateSessions.organizationId, job.organizationId),
      eq(onbCandidateSessions.idHash, job.recordId),
    )).for("update");
    if (!record) return { state: "complete" as const };
    if (record.caseId !== caseId) return { state: "blocked" as const, message: "Record case identity changed; deletion is blocked." };
    createdAt = record.createdAt;
  } else {
    return { state: "blocked" as const, message: "Unsupported relational lifecycle record kind." };
  }
  if (!createdAt || createdAt > new Date(now.getTime() - current.retentionDays * 86_400_000)) {
    return { state: "blocked" as const, message: "The item is no longer eligible under the current retention policy." };
  }
  return { state: "ready" as const };
}

async function processRelationalDeletionJob(job: typeof onbSensitiveLifecycleDeletionJobs.$inferSelect, now: Date) {
  return db.transaction(async (tx) => {
    const staged = await relationalRecordIsSafeToDeleteInTransaction(tx, job, now);
    if (staged.state === "complete") {
      await tx.update(onbSensitiveLifecycleDeletionJobs).set({
        status: "completed", completedAt: now, claimOwner: null, claimUntil: null, updatedAt: now,
      }).where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
      return "completed" as const;
    }
    if (staged.state === "blocked") return staged;
    if (job.recordKind === "communication") {
      await tx.update(onbCommunications).set({
        toAddress: "[redacted]", subject: null, body: "[redacted by approved retention policy]",
        failureReason: null, externalMessageId: null, sensitive: false,
      }).where(and(
        eq(onbCommunications.organizationId, job.organizationId),
        eq(onbCommunications.id, Number(job.recordId)),
      ));
    } else if (job.recordKind === "voice-session") {
      await tx.update(onbVoiceSessions).set({
        reason: null, turns: [], decisions: [], lastSpeech: null, lastResponse: null, providerFailureReason: null,
      }).where(and(
        eq(onbVoiceSessions.organizationId, job.organizationId),
        eq(onbVoiceSessions.token, job.recordId),
        eq(onbVoiceSessions.finalized, true),
      ));
    } else if (job.recordKind === "candidate-link") {
      // Preserve protected audit candidate-link object IDs; they have no FK to
      // this bearer credential and remain the immutable evidence trail.
      await tx.delete(onbCandidateLinks).where(and(
        eq(onbCandidateLinks.organizationId, job.organizationId),
        eq(onbCandidateLinks.id, Number(job.recordId)),
      ));
    } else {
      await tx.delete(onbCandidateSessions).where(and(
        eq(onbCandidateSessions.organizationId, job.organizationId),
        eq(onbCandidateSessions.idHash, job.recordId),
      ));
    }
    await tx.update(onbSensitiveLifecycleDeletionJobs).set({
      status: "completed", completedAt: now, claimOwner: null, claimUntil: null, updatedAt: now,
    }).where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
    await appendProtectedAuditInTransaction(tx, {
      organizationId: job.organizationId, actorKind: "system", actorAuthority: "sensitive-lifecycle-worker",
      action: "privacy.sensitive-lifecycle.relational-record-minimized", outcome: "success",
      objectType: job.recordKind, objectId: job.recordId,
      caseReference: job.caseId ? `case:${job.caseId}` : undefined,
      reviewedRevision: job.policyRevision, source: "sensitive-lifecycle-worker",
    });
    return "completed" as const;
  });
}

async function uploadMatchesCurrentLifecycleContext(
  tx: any,
  job: typeof onbSensitiveLifecycleDeletionJobs.$inferSelect,
  upload: typeof onbCandidateUploads.$inferSelect,
  policy: typeof onbSensitiveLifecyclePolicies.$inferSelect,
) {
  const [[caseRow], [document]] = await Promise.all([
    tx.select({ workforceContext: onbCases.workforceContext, workerName: onbCases.workerName, id: onbCases.id }).from(onbCases).where(and(
      eq(onbCases.organizationId, job.organizationId), eq(onbCases.id, upload.caseId),
    )).for("update"),
    tx.select({ key: onbDocuments.key, label: onbDocuments.label, category: onbDocuments.category })
      .from(onbDocuments).where(and(
        eq(onbDocuments.organizationId, job.organizationId),
        eq(onbDocuments.id, upload.documentId),
        eq(onbDocuments.caseId, upload.caseId),
      )).for("update"),
  ]);
  if (!caseRow || !document) return false;
  // An envelope job may have already completed in the same worker batch. Its
  // all-class policy fence was revalidated immediately before minimisation;
  // allow the separately durable primary-object deletion to finish rather
  // than stranding a file because the envelope intentionally cleared context.
  if (caseRow.workerName === "[minimized]") {
    return true;
  }
  return jurisdictionForWorkforceContext(caseRow.workforceContext) === policy.jurisdiction;
}

async function processDeletionJob(jobId: number, owner: string, now: Date): Promise<"completed" | "blocked" | "skipped"> {
  const [job] = await db.transaction(async (tx) => {
    const [claimed] = await tx.update(onbSensitiveLifecycleDeletionJobs).set({
      status: "processing", claimOwner: owner, claimUntil: new Date(now.getTime() + 5 * 60_000),
      attempts: sql`${onbSensitiveLifecycleDeletionJobs.attempts} + 1`, updatedAt: now,
    }).where(and(
      eq(onbSensitiveLifecycleDeletionJobs.id, jobId), eq(onbSensitiveLifecycleDeletionJobs.status, "queued"),
    )).returning();
    return [claimed];
  });
  if (!job) return "skipped";
  return withSensitiveLifecycleFence(job.organizationId, async () => {
    if (job.recordKind === "candidate-upload" && job.caseId &&
        job.recordId === `case-derived-envelope:${job.caseId}`) {
      const envelope = await processCaseDerivedEnvelopeDeletionJob(job, now);
      if (envelope.state === "complete") return "completed";
      await blockJob(job.id, envelope.message);
      return "blocked";
    }
    if (job.recordKind !== "candidate-upload") {
      const relational = await processRelationalDeletionJob(job, now);
      if (relational === "completed") return relational;
      await blockJob(job.id, relational.message);
      return "blocked";
    }
    const uploadId = job.uploadId;
    if (!uploadId) {
      await blockJob(job.id, "Candidate-upload lifecycle job is missing its upload identifier.");
      return "blocked";
    }
    const staged = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
        eq(onbSensitiveLifecyclePolicies.id, job.policyId),
        eq(onbSensitiveLifecyclePolicies.organizationId, job.organizationId),
        eq(onbSensitiveLifecyclePolicies.isCurrent, true),
      )).for("update");
      const [upload] = await tx.select().from(onbCandidateUploads).where(and(
        eq(onbCandidateUploads.organizationId, job.organizationId), eq(onbCandidateUploads.id, uploadId),
      )).for("update");
      if (!upload) return { state: "complete" as const, paths: [] as string[] };
      if (!current || current.revision !== job.policyRevision || current.dataClass !== job.dataClass) {
        return { state: "blocked" as const, message: "Policy revision changed; deletion requires a fresh policy evaluation." };
      }
      const allClassPolicies = await opaqueCasePolicySetInTransaction(tx, {
        organizationId: job.organizationId,
        jurisdiction: current.jurisdiction,
        now,
        createdAt: upload.createdAt,
        expected: Object.keys(job.policyRevisions ?? {}).length
          ? job.policyRevisions as PolicyRevisionSet
          : undefined,
      });
      if (allClassPolicies.state !== "ready") {
        return { state: "blocked" as const, message: allClassPolicies.message };
      }
      if (!await uploadMatchesCurrentLifecycleContext(tx, job, upload, current)) {
        return { state: "blocked" as const, message: "Current workforce jurisdiction no longer matches the queued policy." };
      }
      if (await holdApplies(tx, {
        organizationId: job.organizationId,
        dataClasses: effectiveSensitiveDataClassesForCandidateUpload(),
        caseId: upload.caseId,
        objectPath: upload.objectPath,
      })) {
        return { state: "blocked" as const, message: "An active legal/privacy hold blocks deletion." };
      }
      const [manifest] = await tx.select().from(onbSensitiveObjectManifests).where(and(
        eq(onbSensitiveObjectManifests.organizationId, job.organizationId),
        eq(onbSensitiveObjectManifests.objectPath, upload.objectPath),
      )).for("update");
      if (!manifest || manifest.manifestState !== "complete") {
        return { state: "blocked" as const, message: "Derivative reconciliation is absent or incomplete; deletion fails closed." };
      }
      const derivatives = await tx.select({ derivativePath: onbSensitiveObjectDerivatives.derivativePath })
        .from(onbSensitiveObjectDerivatives).where(eq(onbSensitiveObjectDerivatives.manifestId, manifest.id));
      return { state: "ready" as const, upload, manifestId: manifest.id, paths: [...derivatives.map((item) => item.derivativePath), upload.objectPath] };
    });
    if (staged.state === "complete") {
      await db.update(onbSensitiveLifecycleDeletionJobs).set({
        status: "completed", completedAt: now, claimOwner: null, claimUntil: null, updatedAt: now,
      })
        .where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
      return "completed";
    }
    if (staged.state === "blocked") {
      await blockJob(job.id, staged.message);
      return "blocked";
    }
    try {
      for (const path of staged.paths) await getPrivateFile(path).delete({ ignoreNotFound: true });
    } catch (error) {
      await db.update(onbSensitiveLifecycleDeletionJobs).set({
        status: "failed", lastError: error instanceof Error ? error.message.slice(0, 500) : "Object deletion failed",
        claimOwner: null, claimUntil: null, updatedAt: new Date(),
      }).where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
      return "blocked";
    }
    const finalized = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
        eq(onbSensitiveLifecyclePolicies.id, job.policyId), eq(onbSensitiveLifecyclePolicies.isCurrent, true),
      )).for("update");
      const [upload] = await tx.select().from(onbCandidateUploads).where(and(
        eq(onbCandidateUploads.organizationId, job.organizationId), eq(onbCandidateUploads.id, uploadId),
      )).for("update");
      if (!upload) return "completed" as const;
      const [manifest] = await tx.select().from(onbSensitiveObjectManifests).where(and(
        eq(onbSensitiveObjectManifests.id, staged.manifestId),
        eq(onbSensitiveObjectManifests.organizationId, job.organizationId),
        eq(onbSensitiveObjectManifests.objectPath, upload.objectPath),
      )).for("update");
      const allClassPolicies = current && current.revision === job.policyRevision && current.dataClass === job.dataClass
        ? await opaqueCasePolicySetInTransaction(tx, {
            organizationId: job.organizationId,
            jurisdiction: current.jurisdiction,
            now,
            createdAt: upload.createdAt,
            expected: Object.keys(job.policyRevisions ?? {}).length
              ? job.policyRevisions as PolicyRevisionSet
              : undefined,
          })
        : { state: "blocked" as const, message: "Policy revision changed; deletion requires a fresh policy evaluation." };
      if (allClassPolicies.state !== "ready" ||
          !manifest || manifest.manifestState !== "complete" ||
          !await uploadMatchesCurrentLifecycleContext(tx, job, upload, current) ||
          await holdApplies(tx, {
            organizationId: job.organizationId,
            dataClasses: effectiveSensitiveDataClassesForCandidateUpload(),
            caseId: upload.caseId,
            objectPath: upload.objectPath,
          })) {
        return "blocked" as const;
      }
      await tx.delete(onbCandidateUploads).where(eq(onbCandidateUploads.id, upload.id));
      // The upload row is only one representation of the document. Once the
      // last primary file is gone, remove its sensitive label/note/key as well;
      // doing this before byte deletion would break the server-side class
      // recheck and could strand the private primary or a derivative.
      const [remainingUpload] = await tx.select({ id: onbCandidateUploads.id })
        .from(onbCandidateUploads).where(and(
          eq(onbCandidateUploads.organizationId, job.organizationId),
          eq(onbCandidateUploads.documentId, upload.documentId),
        )).limit(1);
      if (!remainingUpload) {
        await tx.update(onbDocuments).set({
          key: sql`'minimized-' || ${onbDocuments.id}::text`,
          label: "[minimized]", note: null,
        }).where(and(
          eq(onbDocuments.organizationId, job.organizationId),
          eq(onbDocuments.id, upload.documentId),
          eq(onbDocuments.caseId, upload.caseId),
        ));
      }
      await tx.delete(onbSensitiveObjectManifests).where(eq(onbSensitiveObjectManifests.id, staged.manifestId));
      await tx.update(onbSensitiveLifecycleDeletionJobs).set({
        status: "completed", completedAt: now, claimOwner: null, claimUntil: null, updatedAt: now,
      }).where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
      await appendProtectedAuditInTransaction(tx, {
        organizationId: job.organizationId, actorKind: "system", actorAuthority: "sensitive-lifecycle-worker",
        action: "privacy.sensitive-lifecycle.object-deleted", outcome: "success",
        objectType: "candidate-document", objectId: String(upload.id), caseReference: `case:${upload.caseId}`,
        reviewedRevision: job.policyRevision, source: "sensitive-lifecycle-worker",
      });
      return "completed" as const;
    });
    if (finalized === "blocked") await blockJob(job.id, "A hold or policy revision was observed at final deletion reconciliation.");
    return finalized;
  });
}

/**
 * `organizationId` is an internal worker/testing scope, never a public request
 * parameter. Omitting it preserves the production global sweep.
 */
export async function runSensitiveLifecycleDeletionWorker(options: {
  now?: Date;
  limit?: number;
  organizationId?: string;
} = {}) {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  // A process can die after claiming a durable job. Reclaim only an expired
  // lease; the per-tenant lifecycle fence serializes a late former worker
  // with its recovery worker at the final deletion boundary.
  await db.update(onbSensitiveLifecycleDeletionJobs).set({
    status: "queued", claimOwner: null, claimUntil: null, updatedAt: now,
  }).where(and(
    eq(onbSensitiveLifecycleDeletionJobs.status, "processing"),
    lte(onbSensitiveLifecycleDeletionJobs.claimUntil, now),
    options.organizationId
      ? eq(onbSensitiveLifecycleDeletionJobs.organizationId, options.organizationId)
      : undefined,
  ));
  // Kept in the lifecycle tick rather than an unrelated maintenance timer so
  // stale private-object reservations receive the same tenant fence, hold, and
  // bounded recovery discipline as lifecycle deletions. The dynamic import
  // avoids an initialization cycle: reservations reuse this module's fence.
  const { recoverPendingCandidateUploadReservations } = await import("./candidate-upload-reservations");
  const pendingRecovery = await recoverPendingCandidateUploadReservations({
    now, limit, organizationId: options.organizationId,
  });
  const scheduled = await scheduleExpiredCandidateUploads(now, limit * 4);
  const scheduledRelational = await scheduleExpiredRelationalRecords(now, limit * 4);
  const scheduledCaseDerived = await scheduleExpiredCaseDerivedEnvelopes(now, limit * 4);
  const jobs = await db.select({ id: onbSensitiveLifecycleDeletionJobs.id }).from(onbSensitiveLifecycleDeletionJobs)
    .where(and(
      eq(onbSensitiveLifecycleDeletionJobs.status, "queued"),
      options.organizationId
        ? eq(onbSensitiveLifecycleDeletionJobs.organizationId, options.organizationId)
        : undefined,
    ))
    .orderBy(onbSensitiveLifecycleDeletionJobs.createdAt).limit(limit);
  let completed = 0;
  let blocked = 0;
  const owner = `sensitive-lifecycle-worker:${randomUUID()}`;
  for (const job of jobs) {
    const result = await processDeletionJob(job.id, owner, now);
    if (result === "completed") completed += 1;
    if (result === "blocked") blocked += 1;
  }
  return {
    scheduled: scheduled + scheduledRelational + scheduledCaseDerived,
    completed,
    blocked,
    pendingReservations: pendingRecovery,
  };
}

/** Autoscale heartbeat callers await this shared tick rather than skipping it. */
export const runSensitiveLifecycleDeletionTick = makeSharedTick(async () => {
  try {
    await runSensitiveLifecycleDeletionWorker();
  } catch (error) {
    logger.error({ err: error }, "sensitive lifecycle deletion tick failed");
  }
});

let timer: ReturnType<typeof setInterval> | undefined;
export function startSensitiveLifecycleDeletionWorker(): void {
  if (timer) return;
  const tick = () => void runSensitiveLifecycleDeletionTick();
  tick();
  timer = setInterval(tick, 60_000);
  timer.unref?.();
}