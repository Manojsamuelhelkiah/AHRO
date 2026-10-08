import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db, hroContextAnchors, hroContextSteps, hroContextTransactions,
  hroContextRetentionPolicies, hroContextRetentionState, onbSensitiveLifecycleHolds, onbAuditLifecycles,
} from "@workspace/db";
import {
  verifiedSensitiveAuthorityInTransaction, withSensitiveLifecycleFence,
  SensitiveLifecycleConflictError, SensitiveLifecycleValidationError,
} from "../onboarding/sensitive-lifecycle";
import { appendProtectedAuditInTransaction } from "../onboarding/protected-audit";
import { lockHroContextRetention } from "./retention-lock";
import { withoutHroContext } from "./core";

export const CONTEXT_RETENTION_LIMITS = Object.freeze({ organizations: 4, correlations: 20, transactions: 100, steps: 500, anchors: 100 });
export const CONTEXT_RETENTION_SAFEGUARDS =
  "Applies to all execution metadata, including authenticated principal identifiers. Age is measured from the newest transaction or step in a complete correlation chain. Unfinished attempts, recent chains, cross-chain parent links and oversized chains are preserved. Any active tenant sensitive-lifecycle or audit legal hold blocks pruning because opaque subject hashes cannot safely resolve hold scope. Protected audit evidence and reviewed policy receipts are independent and never pruned here.";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function currentPolicy(tx: Tx, organizationId: string) {
  const [policy] = await tx.select().from(hroContextRetentionPolicies)
    .where(eq(hroContextRetentionPolicies.organizationId, organizationId))
    .orderBy(desc(hroContextRetentionPolicies.revision)).limit(1);
  return policy ?? null;
}
async function activeHold(tx: Tx, organizationId: string) {
  const [hold] = await tx.select({ id: onbSensitiveLifecycleHolds.id }).from(onbSensitiveLifecycleHolds).where(and(
    eq(onbSensitiveLifecycleHolds.organizationId, organizationId), eq(onbSensitiveLifecycleHolds.active, true),
  )).limit(1);
  const [auditHold] = await tx.select({ active: onbAuditLifecycles.legalHoldActive }).from(onbAuditLifecycles)
    .where(eq(onbAuditLifecycles.organizationId, organizationId)).limit(1);
  return Boolean(hold) || auditHold?.active === true;
}
function policyView(policy: NonNullable<Awaited<ReturnType<typeof currentPolicy>>>) {
  const { approvedByUserId: _actor, approvedAuthorityAssignmentId: _authority, organizationId: _organization, id: _id, ...view } = policy;
  return view;
}

/** Read references/status only after live verified authority and membership checks. */
export async function getContextRetentionStatus(organizationId: string, actorUserId: string) {
  return db.transaction(async tx => {
    await verifiedSensitiveAuthorityInTransaction(tx, organizationId, actorUserId);
    const policy = await currentPolicy(tx, organizationId);
    const holdActive = await activeHold(tx, organizationId);
    const [state] = await tx.select().from(hroContextRetentionState)
      .where(eq(hroContextRetentionState.organizationId, organizationId));
    return {
      policy: policy ? policyView(policy) : null,
      status: !policy ? "approval-required" : !policy.enabled ? "paused" : holdActive ? "held" : "approved",
      holdActive, lastSweep: state ? {
        lastSweepAt: state.lastSweepAt, policyRevision: state.policyRevision, outcome: state.outcome,
        transactionsPruned: state.transactionsPruned, stepsPruned: state.stepsPruned, anchorsPruned: state.anchorsPruned,
      } : null,
      safeguards: CONTEXT_RETENTION_SAFEGUARDS, limits: CONTEXT_RETENTION_LIMITS,
    };
  });
}

export type ContextRetentionInput = {
  expectedRevision: number; enabled: boolean; retentionDays: number;
  purpose: string; lawfulBasis: string; policyReference: string; approvalReference: string;
  confirmPruning: boolean;
};
export function validateContextRetentionInput(body: unknown): ContextRetentionInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SensitiveLifecycleValidationError("A reviewed retention rule is required.");
  const value = body as Record<string, unknown>;
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0 ||
      !Number.isSafeInteger(value.retentionDays) || (value.retentionDays as number) < 0 || (value.retentionDays as number) > 3650 ||
      typeof value.enabled !== "boolean" || typeof value.confirmPruning !== "boolean") {
    throw new SensitiveLifecycleValidationError("Use an integer revision and 0–3650 retention days, with explicit enabled and confirmation choices.");
  }
  const text = (key: string) => {
    const v = value[key];
    if (typeof v !== "string" || !v.trim() || v.length > 500) throw new SensitiveLifecycleValidationError(`${key} must be 1–500 characters.`);
    return v.trim();
  };
  return {
    expectedRevision: value.expectedRevision as number, retentionDays: value.retentionDays as number,
    enabled: value.enabled, confirmPruning: value.confirmPruning,
    purpose: text("purpose"), lawfulBasis: text("lawfulBasis"),
    policyReference: text("policyReference"), approvalReference: text("approvalReference"),
  };
}

export async function saveContextRetentionPolicy(organizationId: string, actorUserId: string, body: unknown) {
  const input = validateContextRetentionInput(body);
  // Same privacy hold/deletion fence as the existing lifecycle. New revisions
  // never inherit approval; every save records a new live authority receipt.
  await withSensitiveLifecycleFence(organizationId, () => db.transaction(async tx => {
    await lockHroContextRetention(tx, organizationId);
    const authority = await verifiedSensitiveAuthorityInTransaction(tx, organizationId, actorUserId);
    const previous = await currentPolicy(tx, organizationId);
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new SensitiveLifecycleConflictError("Retention policy changed. Reload and review the current revision.");
    if (input.enabled && !input.confirmPruning) throw new SensitiveLifecycleValidationError("Explicitly confirm irreversible metadata pruning before enabling this reviewed rule.");
    const { expectedRevision: _expected, confirmPruning: _confirmation, ...rule } = input;
    const [created] = await tx.insert(hroContextRetentionPolicies).values({
      ...rule, organizationId, revision: input.expectedRevision + 1,
      approvedByUserId: actorUserId, approvedAuthorityAssignmentId: authority.id,
    }).returning();
    await appendProtectedAuditInTransaction(tx, {
      organizationId, actorId: actorUserId, actorKind: "authenticated", actorAuthority: `governance-assignment:${authority.id}`,
      action: input.enabled ? "privacy.context-retention.approved" : "privacy.context-retention.paused",
      outcome: "success", objectType: "context-retention-policy", objectId: String(created!.id),
      reviewedRevision: created!.revision, source: "privacy-route",
    });
  }));
  return getContextRetentionStatus(organizationId, actorUserId);
}

/** Atomic sweeps need no expiring job lease: crashes roll back all deletes and status. */
export async function pruneContextOrganization(organizationId: string, now = new Date()) {
  return withoutHroContext(() => withSensitiveLifecycleFence(organizationId, () => db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await lockHroContextRetention(tx, organizationId);
    const policy = await currentPolicy(tx, organizationId);
    const counts = { transactionsPruned: 0, stepsPruned: 0, anchorsPruned: 0 };
    let outcome = !policy ? "approval-required" : !policy.enabled ? "paused" : await activeHold(tx, organizationId) ? "held" : "swept";
    if (policy?.enabled && outcome === "swept") {
      const cutoff = new Date(now.getTime() - policy.retentionDays * 86_400_000);
      // Full chains only. Filters exclude ineligible chains before LIMIT, so
      // an old unfinished/oversized chain cannot starve unrelated eligible work.
      const candidates = await tx.execute<{ correlation_id: string }>(sql`
        select t.correlation_id from hro_context_transactions t
        where t.organization_id = ${organizationId}
        group by t.correlation_id
        having count(*) <= ${CONTEXT_RETENTION_LIMITS.transactions}
          and bool_and(t.status in ('completed','failed') and t.finished_at is not null
            and greatest(t.started_at,t.updated_at,t.finished_at) <= ${cutoff})
          and not exists (
            select 1 from hro_context_steps s join hro_context_transactions member
              on member.organization_id = s.organization_id and member.id = s.transaction_id
            where member.organization_id = ${organizationId} and member.correlation_id = t.correlation_id
              and s.created_at > ${cutoff})
          and not exists (
            select 1 from hro_context_transactions member
            left join hro_context_transactions parent on parent.organization_id = member.organization_id and parent.id = member.parent_transaction_id
            where member.organization_id = ${organizationId} and member.correlation_id = t.correlation_id
              and member.parent_transaction_id is not null
              and (parent.id is null or parent.correlation_id <> member.correlation_id))
          and not exists (
            select 1 from hro_context_transactions member join hro_context_transactions child
              on child.organization_id = member.organization_id and child.parent_transaction_id = member.id
            where member.organization_id = ${organizationId} and member.correlation_id = t.correlation_id
              and child.correlation_id <> member.correlation_id)
          and (select count(*) from hro_context_steps s join hro_context_transactions member
            on member.organization_id = s.organization_id and member.id = s.transaction_id
            where member.organization_id = ${organizationId} and member.correlation_id = t.correlation_id) <= ${CONTEXT_RETENTION_LIMITS.steps}
        order by min(t.finished_at), t.correlation_id limit ${CONTEXT_RETENTION_LIMITS.correlations}
      `);
      for (const candidate of candidates.rows) {
        const members = await tx.select({
          id: hroContextTransactions.id, status: hroContextTransactions.status,
          startedAt: hroContextTransactions.startedAt, updatedAt: hroContextTransactions.updatedAt,
          finishedAt: hroContextTransactions.finishedAt,
        }).from(hroContextTransactions).where(and(
          eq(hroContextTransactions.organizationId, organizationId), eq(hroContextTransactions.correlationId, candidate.correlation_id),
        )).limit(CONTEXT_RETENTION_LIMITS.transactions + 1).for("update");
        const ids = members.map(m => m.id);
        if (!ids.length || counts.transactionsPruned + ids.length > CONTEXT_RETENTION_LIMITS.transactions) continue;
        // Candidate selection is only a hint. A writer may have committed new
        // activity before these row locks were acquired; recheck before deleting.
        if (members.some(member => !['completed', 'failed'].includes(member.status) ||
          !member.finishedAt || Math.max(member.startedAt.getTime(), member.updatedAt.getTime(),
            member.finishedAt.getTime()) > cutoff.getTime())) continue;
        const steps = await tx.select({ id: hroContextSteps.id, createdAt: hroContextSteps.createdAt }).from(hroContextSteps).where(and(
          eq(hroContextSteps.organizationId, organizationId), inArray(hroContextSteps.transactionId, ids),
        )).limit(CONTEXT_RETENTION_LIMITS.steps + 1).for("update");
        if (counts.stepsPruned + steps.length > CONTEXT_RETENTION_LIMITS.steps) continue;
        if (steps.some(step => step.createdAt.getTime() > cutoff.getTime())) continue;
        await tx.delete(hroContextSteps).where(and(eq(hroContextSteps.organizationId, organizationId), inArray(hroContextSteps.transactionId, ids)));
        await tx.delete(hroContextTransactions).where(and(eq(hroContextTransactions.organizationId, organizationId), inArray(hroContextTransactions.id, ids)));
        counts.transactionsPruned += ids.length;
        counts.stepsPruned += steps.length;
      }
      const anchors = await tx.execute<{ id: string }>(sql`
        select a.id from hro_context_anchors a where a.organization_id = ${organizationId}
          and a.created_at <= ${cutoff} and not exists (
            select 1 from hro_context_transactions t where t.organization_id = a.organization_id and t.anchor_id = a.id)
        order by a.created_at, a.id limit ${CONTEXT_RETENTION_LIMITS.anchors} for update
      `);
      if (anchors.rows.length) {
        await tx.delete(hroContextAnchors).where(and(eq(hroContextAnchors.organizationId, organizationId), inArray(hroContextAnchors.id, anchors.rows.map(a => a.id))));
        counts.anchorsPruned = anchors.rows.length;
      }
    }
    const state = { organizationId, lastSweepAt: now, policyRevision: policy?.revision ?? 0, outcome, ...counts };
    await tx.insert(hroContextRetentionState).values(state).onConflictDoUpdate({
      target: hroContextRetentionState.organizationId, set: state,
    });
    return state;
  })));
}

let inFlight: Promise<{ organizations: number; failures: number }> | null = null;
/** Awaited by the autoscale heartbeat; no timer, request identity, or process-only cursor. */
export function runContextRetentionTick() {
  if (inFlight) return inFlight;
  inFlight = withoutHroContext(async () => {
    let organizations = 0;
    let failures = 0;
    try {
      // Least recently swept first survives restarts and avoids tenant starvation.
      const rows = await db.execute<{ organization_id: string }>(sql`
        select p.organization_id from
          (select distinct on (organization_id) organization_id, enabled
            from hro_context_retention_policies order by organization_id, revision desc) p
        left join hro_context_retention_state s on s.organization_id = p.organization_id
        where p.enabled
        order by s.last_sweep_at nulls first, p.organization_id limit ${CONTEXT_RETENTION_LIMITS.organizations}
      `);
      for (const row of rows.rows) {
        try { await pruneContextOrganization(row.organization_id); organizations++; }
        catch {
          failures++;
          // A failed transaction must not claim deletion success. Record a safe
          // failure marker independently so one failing tenant cannot starve all others.
          await db.insert(hroContextRetentionState).values({
            organizationId: row.organization_id, lastSweepAt: new Date(), policyRevision: 0, outcome: "failed",
          }).onConflictDoUpdate({
            target: hroContextRetentionState.organizationId,
            set: { lastSweepAt: new Date(), policyRevision: 0, outcome: "failed", transactionsPruned: 0, stepsPruned: 0, anchorsPruned: 0 },
          }).catch(() => undefined);
        }
      }
    } catch { failures++; }
    return { organizations, failures };
  }).finally(() => { inFlight = null; });
  return inFlight;
}
