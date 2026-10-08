import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db, bgvNotificationLockPool, employeeVaultProfiles as profiles, employeeVaultDocuments as documents,
  employeeVaultChecks as checks, employeeVaultRequests as requests, employeeVaultPolicies as policies,
  employeeVaultAudit as audit, employeeVaultReceipts as receipts, onbCases,
} from "@workspace/db";
import { acquireGovernanceDispatchMutationLock, assertGovernanceMutationAllowed } from "../onboarding/governance-dispatch";
import { acquireCaseDispatchMutationLock } from "../onboarding/dispatch-guard";
import { withSensitiveLifecycleFence, withIndependentOwnerLifecycleFences } from "../onboarding/sensitive-lifecycle";
import { reopenApprovalInTransaction } from "../onboarding/approval-version";

export type VaultTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class VaultError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function fail(status: number, message: string): never { throw new VaultError(status, message); }
export async function ownProfile(userId: string) {
  await db.insert(profiles).values({ id: `EV-${randomUUID()}`, userId }).onConflictDoNothing({ target: profiles.userId });
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId));
  if (!profile) return fail(503, "Vault profile unavailable.");
  return profile;
}
export async function liveVaultPolicy(tx: Pick<VaultTx, "select">,
  { storage = false, scanner = false, jurisdiction }: { storage?: boolean; scanner?: boolean; jurisdiction?: string | null } = {}) {
  const [p] = await tx.select().from(policies).where(eq(policies.id, "independent-vault"));
  if (!p || !p.approved || !p.approvalReference || !p.privacyNotice || p.expiresAt <= new Date() ||
    !/^[A-Z]{2}$/.test(p.jurisdiction) ||
    (jurisdiction !== undefined && (!jurisdiction || jurisdiction !== p.jurisdiction)) ||
    !Number.isInteger(p.retentionDays) || p.retentionDays < 1 || p.retentionDays > 3650 ||
    !Number.isInteger(p.receiptRetentionDays) || p.receiptRetentionDays < 1 || p.receiptRetentionDays > 3650 ||
    (storage && !p.storageApproved) || (scanner && !p.scannerApproved)) {
    return fail(503, "Vault processing is unavailable: approved privacy, retention, jurisdiction and processor configuration is required.");
  }
  return p;
}
export async function auditVault(tx: VaultTx, profileId: string, actorId: string, action: string, objectId: string) {
  await tx.insert(audit).values({ id: randomUUID(), profileId, actorId, action, objectId });
}

/**
 * Mutations take the dedicated Vault session lock before lifecycle,
 * governance and case locks, without occupying the waiting SQL pool.
 * Final onboarding gates hold the same case lock, so consent/evidence cannot
 * change between live evidence evaluation and completion. Provider markers
 * block mutations throughout active or ambiguous external I/O.
 */
export async function vaultWrite<T>(
  scope: { profileId?: string; organizationId?: string; requestId?: string; withdrawal?: boolean },
  action: (tx: VaultTx) => Promise<T>,
): Promise<T> {
  const client = await bgvNotificationLockPool.connect();
  // Dedicated session pool prevents callers waiting on the global domain
  // fence from exhausting the SQL pool needed by the current lock holder.
  try {
  await client.query("select pg_advisory_lock(3180101)");
  const related = await db.select().from(requests).where(
    scope.profileId ? eq(requests.profileId, scope.profileId) :
      scope.organizationId ? eq(requests.organizationId, scope.organizationId) :
        scope.requestId ? eq(requests.id, scope.requestId) : sql`false`,
  );
  const organizations = [...new Set([...related.map(r => r.organizationId), ...(scope.organizationId ? [scope.organizationId] : [])])].sort();
  const run = async (tx: VaultTx) => {
    for (const org of organizations) {
      // Withdrawal may never be refused just because a previously authorized
      // disclosure is already in flight. It changes all FUTURE boundaries;
      // dated history cannot undo a disclosure which already occurred.
      if (scope.withdrawal) await acquireGovernanceDispatchMutationLock(tx, org);
      else await assertGovernanceMutationAllowed(tx, org);
    }
    // Product edits also fence cases which have not yet created a request.
    for (const org of organizations) {
      const cases = await tx.select({ id: onbCases.id }).from(onbCases).where(eq(onbCases.organizationId, org)).orderBy(onbCases.id);
      for (const c of cases) await acquireCaseDispatchMutationLock(tx, org, c.id);
      await tx.select({ id: onbCases.id }).from(onbCases).where(eq(onbCases.organizationId, org)).orderBy(onbCases.id).for("update");
    }
    return action(tx);
  };
  // Current access-grant and specialist-authority mutations use this same
  // tenant advisory fence. Hold it for the whole read/disclosure/mutation.
  return await db.transaction(async authorityTx => {
    for (const org of organizations) await authorityTx.execute(sql`select pg_advisory_xact_lock(hashtext(${org}))`);
    if (organizations.length > 1) return withIndependentOwnerLifecycleFences(organizations, () => run(authorityTx));
    const fenced = (i: number): Promise<T> => i === organizations.length ? run(authorityTx) :
      withSensitiveLifecycleFence(organizations[i]!, () => fenced(i + 1));
    return fenced(0);
  });
  } finally {
    try { await client.query("select pg_advisory_unlock(3180101)"); } finally { client.release(); }
  }
}

export async function invalidateVaultReuse(tx: VaultTx, scope: { profileId?: string; organizationId?: string; requestId?: string }) {
  const rows = await tx.select().from(requests).where(
    scope.profileId ? eq(requests.profileId, scope.profileId) :
      scope.organizationId ? eq(requests.organizationId, scope.organizationId) : eq(requests.id, scope.requestId!),
  );
  for (const r of rows) {
    const affected = await tx.update(receipts).set({ invalidatedAt: new Date() }).where(and(
      eq(receipts.organizationId, r.organizationId), eq(receipts.requestId, r.id), isNull(receipts.invalidatedAt),
    )).returning({ id: receipts.id });
    // An invitation/decline alone never supplied case evidence. Reopen only
    // previously live consumption, and do so once rather than resetting final
    // authority again on repeated withdrawal or unrelated personal updates.
    if (!affected.length) continue;
    const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, r.organizationId), eq(onbCases.id, r.caseId)));
    // Completed-case receipts stay dated history, not active credentials.
    if (!c || c.lifecycleStage === "complete") continue;
    const old = await tx.select().from(receipts).where(eq(receipts.requestId, r.id));
    if (!old.length) continue;
    await reopenApprovalInTransaction(tx, {
      organizationId: r.organizationId, caseId: r.caseId, idempotencyKey: `gateway-c:${r.caseId}:human-queue`,
      reason: "Employee Vault evidence or authorization changed; current BGV and renewed final HR review are required.",
      actor: "employee-vault",
      invalidationOnly: true,
    });
    // Do not rewrite opaque readiness narratives while collection policy or
    // legal holds are unavailable. Live BGV gates read the invalidated receipt,
    // and the numeric approval-cycle reset prevents stale final HR authority.
    await tx.update(onbCases).set({ updatedAt: new Date() }).where(and(eq(onbCases.organizationId, r.organizationId), eq(onbCases.id, r.caseId)));
  }
}
export async function currentDocumentBindings(tx: Pick<VaultTx, "select">, profileId: string, ids: string[], jurisdiction: string) {
  if (!ids.length || new Set(ids).size !== ids.length) return fail(400, "Select distinct documents.");
  const rows = await tx.select().from(documents).where(and(eq(documents.profileId, profileId), inArray(documents.id, ids)));
  const policy = await liveVaultPolicy(tx, { jurisdiction });
  if (rows.length !== ids.length || rows.some(d => d.jurisdiction !== jurisdiction || d.policyRevision !== policy.revision ||
    !d.sha256 || ["reserved", "uploading", "deleted", "delete-pending", "superseded"].includes(d.state))) {
    return fail(409, "Document revision is unavailable or superseded.");
  }
  return rows.map(d => ({ id: d.id, revision: d.revision, sha256: d.sha256! }));
}
export async function invalidateDocumentChecks(tx: VaultTx, profileId: string, documentId: string) {
  const rows = await tx.select().from(checks).where(eq(checks.profileId, profileId));
  for (const c of rows.filter(c => c.bindings.some(b => b.id === documentId))) {
    await tx.update(checks).set({ state: "superseded" }).where(eq(checks.id, c.id));
  }
  await invalidateVaultReuse(tx, { profileId });
}
