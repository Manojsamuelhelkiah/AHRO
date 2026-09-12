import { createHash, createHmac } from "node:crypto";
import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbAuditEntries,
  onbAuditHeads,
  onbAuditLifecycles,
  onbApprovalHistory,
  organizationMembershipsTable,
} from "@workspace/db/schema";
import type { OnboardingDbTransaction } from "./settings";
import {
  enqueueAuditCheckpointInTransaction,
  externalAnchoringStatus,
} from "./external-audit-anchor";

export type AuditActorKind = "authenticated" | "system" | "historical";
/** attempted is intentionally unresolved: a process may die before outcome capture. */
export type AuditOutcome = "attempted" | "success" | "denied" | "failure";

export type ProtectedAuditInput = {
  organizationId: string;
  actorId?: string | null;
  actorKind: AuditActorKind;
  actorAuthority: string;
  action: string;
  outcome: AuditOutcome;
  objectType: string;
  objectId?: string | null;
  caseReference?: string | null;
  reviewedRevision?: number | null;
  source: string;
  correlationId?: string | null;
  /**
   * Only caller-selected safe facts belong here (status, route, identifier
   * type). The sanitizer drops nested data and redacts suspicious keys.
   */
  payload?: Record<string, unknown>;
  correctionOfId?: number | null;
  occurredAt?: Date;
};

const MAX_METADATA_VALUE_LENGTH = 240;
/**
 * Audit metadata is a deliberately small schema, not an arbitrary bag of
 * caller-provided data. Adding a field requires an explicit review here.
 */
const ALLOWED_METADATA_KEYS = new Set([
  "accessLocked",
  "approvalVersion",
  "decision",
  "errorRecorded",
  "exportFormat",
  "externalEffectReferencePresent",
  "guardrailAction",
  "httpStatus",
  "journalStatus",
  "malwareVerdict",
  "method",
  "providerIdempotency",
  "reasonProvided",
  "recoverySweep",
  "requestedOrganizationSupplied",
  "safeStatus",
  "statementLength",
  "suppressedCount",
  "syntheticReset",
  "toolName",
]);

function boundedText(value: unknown, max = MAX_METADATA_VALUE_LENGTH): string | number | boolean | null | undefined {
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

export function minimizeAuditPayload(payload: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  if (!payload) return {};
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([key]) => ALLOWED_METADATA_KEYS.has(key))
      .flatMap(([key, value]) => {
        const safe = boundedText(value);
        return safe === undefined ? [] : [[key.slice(0, 80), safe]];
      }),
  );
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
    .join(",")}}`;
}

export type HashableAuditEntry = Omit<ProtectedAuditInput, "occurredAt"> & {
  sequence: number;
  occurredAt: Date | string;
  payload: Record<string, unknown>;
  previousHash: string;
};

/** Public for deterministic integrity tests and independent verifier tooling. */
export function auditEntryHash(entry: HashableAuditEntry): string {
  return createHash("sha256").update(stableValue({
    organizationId: entry.organizationId,
    sequence: entry.sequence,
    occurredAt: entry.occurredAt instanceof Date ? entry.occurredAt.toISOString() : entry.occurredAt,
    actorId: entry.actorId ?? null,
    actorKind: entry.actorKind,
    actorAuthority: entry.actorAuthority,
    action: entry.action,
    outcome: entry.outcome,
    objectType: entry.objectType,
    objectId: entry.objectId ?? null,
    caseReference: entry.caseReference ?? null,
    reviewedRevision: entry.reviewedRevision ?? null,
    source: entry.source,
    correlationId: entry.correlationId ?? null,
    payload: entry.payload,
    correctionOfId: entry.correctionOfId ?? null,
    previousHash: entry.previousHash,
  })).digest("hex");
}

function compact(value: string | null | undefined, limit: number): string | null {
  const trimmed = value?.trim().slice(0, limit);
  return trimmed || null;
}

function opaqueReference(value: string | null | undefined): string | null {
  const compacted = compact(value, 2_000);
  if (!compacted) return null;
  // Allows controlled reconciliation records to retain the same opaque
  // subject; a reviewer-supplied displayed reference is never re-hashed.
  if (/^ref:[a-f0-9]{32}$/i.test(compacted)) return compacted;
  const key = process.env.AUDIT_PSEUDONYMIZATION_KEY;
  const digest = key
    ? createHmac("sha256", key).update(compacted).digest("hex")
    : createHash("sha256").update(compacted).digest("hex");
  return `ref:${digest.slice(0, 32)}`;
}

/** Reviewers may paste the displayed `ref:…` value or a source identifier. */
function auditObjectFilterReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^ref:[a-f0-9]{32}$/i.test(value) ? value : opaqueReference(value) ?? undefined;
}

/**
 * Serializes one tenant chain using a transaction-scoped advisory lock. The
 * entry and chain head commit together; callers should await this before
 * claiming a sensitive action has completed.
 */
export async function appendProtectedAuditInTransaction(
  tx: OnboardingDbTransaction,
  input: ProtectedAuditInput,
) {
  const occurredAt = input.occurredAt ?? new Date();
  const normalized = {
    ...input,
    actorId: compact(input.actorId, 200),
    actorAuthority: compact(input.actorAuthority, 120) ?? "unverified",
    action: compact(input.action, 160) ?? "unknown",
    objectType: compact(input.objectType, 120) ?? "unknown",
    objectId: opaqueReference(input.objectId),
    caseReference: opaqueReference(input.caseReference),
    source: compact(input.source, 120) ?? "application",
    correlationId: opaqueReference(input.correlationId),
    payload: minimizeAuditPayload(input.payload),
  };
  if (!normalized.organizationId.trim()) throw new Error("Audit organization is required");

  // A per-tenant lock makes sequence allocation and head advancement atomic
  // even when concurrent HTTP requests/background workers share a tenant.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${normalized.organizationId}, 0))`);
  let [head] = await tx.select().from(onbAuditHeads)
    .where(eq(onbAuditHeads.organizationId, normalized.organizationId))
    .for("update");
  if (!head) {
    await tx.insert(onbAuditHeads).values({
      organizationId: normalized.organizationId,
      lastSequence: 0,
      lastHash: "",
      updatedAt: occurredAt,
    });
    [head] = await tx.select().from(onbAuditHeads)
      .where(eq(onbAuditHeads.organizationId, normalized.organizationId))
      .for("update");
  }
  if (!head) throw new Error("Audit chain head could not be initialized");
  const sequence = head.lastSequence + 1;
  const previousHash = head.lastHash;
  const entryHash = auditEntryHash({
    ...normalized,
    sequence,
    occurredAt,
    previousHash,
  });
  const [entry] = await tx.insert(onbAuditEntries).values({
    ...normalized,
    sequence,
    occurredAt,
    previousHash,
    entryHash,
    correctionOfId: input.correctionOfId ?? null,
  }).returning();
  await tx.update(onbAuditHeads).set({
    lastSequence: sequence,
    lastHash: entryHash,
    updatedAt: occurredAt,
  }).where(eq(onbAuditHeads.organizationId, normalized.organizationId));
  const [lifecycle] = await tx.select({
    retentionStatement: onbAuditLifecycles.retentionStatement,
    legalHoldActive: onbAuditLifecycles.legalHoldActive,
  }).from(onbAuditLifecycles).where(eq(onbAuditLifecycles.organizationId, normalized.organizationId));
  await enqueueAuditCheckpointInTransaction(tx, {
    organizationId: normalized.organizationId,
    sequence,
    hash: entryHash,
    retentionStatementPresent: Boolean(lifecycle?.retentionStatement),
    legalHoldActive: lifecycle?.legalHoldActive ?? false,
  });
  return entry;
}

export async function appendProtectedAudit(input: ProtectedAuditInput) {
  return db.transaction((tx) => appendProtectedAuditInTransaction(tx, input));
}

/**
 * Closes the audit-observation gap after a process dies between a committed
 * mutation and HTTP outcome capture. It does not claim that the business
 * mutation failed: the linked event truthfully records that the completion
 * observation was lost and requires reconciliation by a reviewer.
 */
export async function reconcileAbandonedProtectedAuditAttempts(
  organizationId: string,
  olderThanMs = 60_000,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`);
    const pending = await tx.select().from(onbAuditEntries).where(and(
      eq(onbAuditEntries.organizationId, organizationId),
      eq(onbAuditEntries.outcome, "attempted"),
      lte(onbAuditEntries.occurredAt, cutoff),
      sql`${onbAuditEntries.action} like '%.attempted'`,
      sql`not exists (
        select 1 from ${onbAuditEntries} as resolved
        where resolved.correction_of_id = ${onbAuditEntries.id}
      )`,
    )).orderBy(asc(onbAuditEntries.sequence)).limit(100);
    for (const entry of pending) {
      await appendProtectedAuditInTransaction(tx, {
        organizationId,
        actorId: null,
        actorKind: "system",
        actorAuthority: "audit-reconciliation",
        action: "onboarding.audit-outcome.recovery-required",
        outcome: "failure",
        objectType: entry.objectType,
        objectId: entry.objectId,
        caseReference: entry.caseReference,
        reviewedRevision: entry.reviewedRevision,
        source: "audit-recovery",
        correlationId: entry.correlationId,
        payload: { errorRecorded: true },
        correctionOfId: entry.id,
      });
    }
    return pending.length;
  });
}

/** Rechecks the persisted tenant membership at the audit write boundary. */
export async function verifiedAuditAuthority(
  organizationId: string,
  actorId: string,
): Promise<"owner" | "admin" | "member" | null> {
  const [membership] = await db.select({ role: organizationMembershipsTable.role })
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, actorId),
    ));
  return membership?.role ?? null;
}

export type AuditFilter = {
  from?: Date;
  to?: Date;
  action?: string;
  objectType?: string;
  objectId?: string;
  actorId?: string;
  outcome?: AuditOutcome;
  afterSequence?: number;
  limit?: number;
};

export async function listProtectedAudit(organizationId: string, filter: AuditFilter = {}) {
  const predicates = [
    eq(onbAuditEntries.organizationId, organizationId),
    filter.from ? gte(onbAuditEntries.occurredAt, filter.from) : undefined,
    filter.to ? lte(onbAuditEntries.occurredAt, filter.to) : undefined,
    filter.action ? eq(onbAuditEntries.action, filter.action) : undefined,
    filter.objectType ? eq(onbAuditEntries.objectType, filter.objectType) : undefined,
    filter.objectId ? eq(onbAuditEntries.objectId, auditObjectFilterReference(filter.objectId)!) : undefined,
    filter.actorId ? eq(onbAuditEntries.actorId, filter.actorId) : undefined,
    filter.outcome ? eq(onbAuditEntries.outcome, filter.outcome) : undefined,
    filter.afterSequence ? gt(onbAuditEntries.sequence, filter.afterSequence) : undefined,
  ];
  return db.select().from(onbAuditEntries).where(and(...predicates))
    .orderBy(asc(onbAuditEntries.sequence)).limit(Math.min(Math.max(filter.limit ?? 100, 1), 501));
}

/** Reviewer-safe historical lookup that deliberately does not join live data. */
export async function listRetainedApprovalHistory(
  organizationId: string,
  approvalId: number,
) {
  return db.select().from(onbApprovalHistory).where(and(
    eq(onbApprovalHistory.organizationId, organizationId),
    eq(onbApprovalHistory.approvalId, approvalId),
  )).orderBy(desc(onbApprovalHistory.createdAt), desc(onbApprovalHistory.id));
}

export type AuditIntegrity = {
  status: "empty" | "verified" | "broken";
  checkedEntries: number;
  firstBrokenSequence: number | null;
  headMatches: boolean;
  externalAnchoring: {
    requiredForLaunch: true;
    providerId?: string;
    providerKind?: "simulated" | "external";
    configured: boolean;
    verified?: boolean;
    comparison?: string;
    regulatedProductionLaunchBlocked: boolean;
    limitation: string;
    recommendedOutageBehavior?: string;
  };
};

export const externalAnchoring = {
  requiredForLaunch: true as const,
  configured: false,
  regulatedProductionLaunchBlocked: true,
  limitation: "No independent anchoring/WORM implementation is connected. It remains a launch prerequisite; this database chain is not resistant to a privileged database administrator.",
};

export function regulatedProductionAuditLaunchBlocked(
  localStatus: AuditIntegrity["status"],
  externalBlocked: boolean,
): boolean {
  return localStatus !== "verified" || externalBlocked;
}

/**
 * Pure verifier used by reviewer requests and isolated integrity tests. It
 * detects altered fields, missing entries, and changed ordering/sequence
 * relative to the independently stored tenant head.
 */
export function verifyProtectedAuditRows(
  entries: Array<typeof onbAuditEntries.$inferSelect>,
  head: typeof onbAuditHeads.$inferSelect | undefined,
): AuditIntegrity {
  if (!head && entries.length === 0) {
    return {
      status: "empty", checkedEntries: 0, firstBrokenSequence: null, headMatches: true,
      externalAnchoring,
    };
  }
  let previousHash = "";
  let expectedSequence = 1;
  let firstBrokenSequence: number | null = null;
  for (const entry of entries) {
    const expectedHash = auditEntryHash({
      organizationId: entry.organizationId,
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      actorId: entry.actorId,
      actorKind: entry.actorKind as AuditActorKind,
      actorAuthority: entry.actorAuthority,
      action: entry.action,
      outcome: entry.outcome as AuditOutcome,
      objectType: entry.objectType,
      objectId: entry.objectId,
      caseReference: entry.caseReference,
      reviewedRevision: entry.reviewedRevision,
      source: entry.source,
      correlationId: entry.correlationId,
      payload: entry.payload,
      correctionOfId: entry.correctionOfId,
      previousHash,
    });
    if (
      firstBrokenSequence === null &&
      (entry.sequence !== expectedSequence || entry.previousHash !== previousHash || entry.entryHash !== expectedHash)
    ) firstBrokenSequence = entry.sequence;
    previousHash = entry.entryHash;
    expectedSequence += 1;
  }
  const headMatches = head !== undefined &&
    head.lastSequence === entries.length &&
    head.lastHash === previousHash;
  if (firstBrokenSequence === null && !headMatches) firstBrokenSequence = entries.length + 1;
  return {
    status: firstBrokenSequence === null ? "verified" : "broken",
    checkedEntries: entries.length,
    firstBrokenSequence,
    headMatches,
    externalAnchoring,
  };
}

/** Recomputes the tenant hash chain and compares it to the stored head. */
export async function verifyProtectedAudit(organizationId: string): Promise<AuditIntegrity> {
  const local = await db.transaction(async (tx) => {
    // Uses the same tenant-local lock as append. Locking the head alone does
    // not prevent a concurrent writer before the entries read under Read
    // Committed isolation.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`);
    const [head] = await tx.select().from(onbAuditHeads)
      .where(eq(onbAuditHeads.organizationId, organizationId))
      .for("update");
    const entries = await tx.select().from(onbAuditEntries)
      .where(eq(onbAuditEntries.organizationId, organizationId))
      .orderBy(asc(onbAuditEntries.sequence));
    return verifyProtectedAuditRows(entries, head);
  });
  // Do this after releasing the tenant lock. The status check uses the normal
  // pool and must not require a second connection while many verifiers run.
  const anchoring = await externalAnchoringStatus(organizationId);
  const localVerified = local.status === "verified";
  return {
    ...local,
    externalAnchoring: {
      ...anchoring,
      configured: anchoring.configured && localVerified,
      regulatedProductionLaunchBlocked: regulatedProductionAuditLaunchBlocked(
        local.status,
        anchoring.regulatedProductionLaunchBlocked,
      ),
    },
  };
}