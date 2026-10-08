import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test, mock } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, pool, organizationsTable, organizationMembershipsTable, onbGovernanceAuthorityAssignments,
  onbSensitiveLifecycleHolds, onbAuditEntries, onbAuditHeads, onbAuditLifecycles,
  hroContextAnchors, hroContextTransactions, hroContextSteps, hroContextRetentionPolicies, hroContextRetentionState,
} from "@workspace/db";
import {
  CONTEXT_RETENTION_LIMITS, getContextRetentionStatus, saveContextRetentionPolicy,
  pruneContextOrganization, validateContextRetentionInput, runContextRetentionTick,
} from "./retention";
import { lockHroContextRetention } from "./retention-lock";
import { openHroContext, closeHroContext } from "./manager";
import { runInHroContext } from "./core";
import { withSensitiveLifecycleFence, setSensitiveLifecycleHold, releaseSensitiveLifecycleHold } from "../onboarding/sensitive-lifecycle";
import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import contextRouter from "../../routes/hro-context";

const org = `context-retention-${randomUUID()}`;
const other = `${org}-other`;
const actor = `privacy-${randomUUID()}`;
const owner = `owner-${randomUUID()}`;
const old = new Date(Date.now() - 100 * 86_400_000);
const now = new Date();
const rule = (revision = 0, enabled = true, days = 30) => ({
  expectedRevision: revision, enabled, retentionDays: days, purpose: "Reviewed continuity metadata",
  lawfulBasis: "Approved legitimate purpose for execution identifiers", policyReference: "TEST-POLICY",
  approvalReference: "TEST-REVIEW", confirmPruning: true,
});
before(async () => {
  for (const id of [org, other]) await db.insert(organizationsTable).values({
    id, name: "Retention test only", slug: id, joinCodeHash: id, createdByUserId: owner,
  });
  await db.insert(organizationMembershipsTable).values([
    { organizationId: org, clerkUserId: actor, role: "member" },
    { organizationId: org, clerkUserId: owner, role: "owner" },
    { organizationId: other, clerkUserId: actor, role: "member" },
  ]);
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: org, authorityRole: "privacy", assigneeUserId: actor, verificationStatus: "verified",
    verifiedByUserId: "fixture-verifier", verificationReference: "TEST-VERIFIED",
  });
});
after(async () => {
  await db.delete(onbSensitiveLifecycleHolds).where(inArray(onbSensitiveLifecycleHolds.organizationId, [org, other]));
  await db.delete(onbGovernanceAuthorityAssignments).where(eq(onbGovernanceAuthorityAssignments.organizationId, org));
  await db.delete(organizationMembershipsTable).where(inArray(organizationMembershipsTable.organizationId, [org, other]));
  await deleteTestOrganizations(inArray(organizationsTable.id, [org, other]));
  await pool.end();
});
async function clearMetadata() {
  await db.delete(hroContextSteps).where(eq(hroContextSteps.organizationId, org));
  await db.delete(hroContextTransactions).where(eq(hroContextTransactions.organizationId, org));
  await db.delete(hroContextAnchors).where(eq(hroContextAnchors.organizationId, org));
}
async function attempt(options: { organizationId?: string; correlationId?: string; parent?: string; status?: string; date?: Date; steps?: number } = {}) {
  const organizationId = options.organizationId ?? org;
  const id = randomUUID(), anchor = randomUUID(), date = options.date ?? old;
  await db.insert(hroContextAnchors).values({
    id: anchor, organizationId, subjectType: "case", subjectHash: randomUUID(), createdAt: date,
  });
  await db.insert(hroContextTransactions).values({
    id, organizationId, anchorId: anchor, parentTransactionId: options.parent ?? null,
    correlationId: options.correlationId ?? randomUUID(), workflow: "onboarding",
    initiatorType: "human", initiatingUserId: actor, executorType: "human",
    status: options.status ?? "completed", startedAt: date, updatedAt: date,
    finishedAt: options.status === "running" ? null : date,
  });
  const steps = options.steps ?? 1;
  if (steps) await db.insert(hroContextSteps).values(Array.from({ length: steps }, () => ({
    organizationId, transactionId: id, code: "scope-bound", createdAt: date,
  })));
  return id;
}
async function present(id: string) {
  return (await db.select({ id: hroContextTransactions.id }).from(hroContextTransactions).where(eq(hroContextTransactions.id, id))).length > 0;
}

test("no invented approval; owner and cross-tenant authority denied; invalid/unsafe rules rejected", async () => {
  const status = await getContextRetentionStatus(org, actor);
  assert.equal(status.policy, null);
  assert.equal(status.status, "approval-required");
  const id = await attempt();
  assert.equal((await pruneContextOrganization(org)).outcome, "approval-required");
  assert(await present(id));
  await assert.rejects(saveContextRetentionPolicy(org, owner, rule()), /verified privacy or legal/);
  await assert.rejects(getContextRetentionStatus(other, actor), /verified privacy or legal/);
  for (const retentionDays of [-1, 0.1, 3651, "30", null]) assert.throws(() => validateContextRetentionInput({ ...rule(), retentionDays }));
  await assert.rejects(saveContextRetentionPolicy(org, actor, { ...rule(), confirmPruning: false }), /Explicitly confirm/);
  const approved = await saveContextRetentionPolicy(org, actor, rule());
  assert.equal(approved.policy?.revision, 1);
  assert.equal(approved.policy?.enabled, true);
  await assert.rejects(saveContextRetentionPolicy(org, actor, rule()), /changed/);
  const receipts = await db.select().from(onbAuditEntries).where(and(
    eq(onbAuditEntries.organizationId, org), eq(onbAuditEntries.action, "privacy.context-retention.approved"),
  ));
  assert.equal(receipts.length, 1);
});

test("whole chains preserve running, recent and inconsistent links; concurrent sweeps prune old chains once and leave audit untouched", async () => {
  await clearMetadata();
  const expiredCorrelation = randomUUID();
  const parent = await attempt({ correlationId: expiredCorrelation });
  const child = await attempt({ correlationId: expiredCorrelation, parent });
  const activeCorrelation = randomUUID();
  const oldActiveParent = await attempt({ correlationId: activeCorrelation });
  const activeChild = await attempt({ correlationId: activeCorrelation, parent: oldActiveParent, status: "running" });
  const recentCorrelation = randomUUID();
  const oldRecentParent = await attempt({ correlationId: recentCorrelation });
  const recent = await attempt({ correlationId: recentCorrelation, parent: oldRecentParent, date: now });
  const externalParent = await attempt();
  const externalChild = await attempt({ parent: externalParent });
  const malformed = await attempt({ parent: randomUUID() });
  const otherAttempt = await attempt({ organizationId: other });
  const stepRecent = await attempt();
  await db.insert(hroContextSteps).values({ organizationId: org, transactionId: stepRecent, code: "approval-observed", createdAt: now });
  const auditBefore = await db.select().from(onbAuditEntries).where(eq(onbAuditEntries.organizationId, org));
  const headsBefore = await db.select().from(onbAuditHeads).where(eq(onbAuditHeads.organizationId, org));
  const policiesBefore = await db.select().from(hroContextRetentionPolicies).where(eq(hroContextRetentionPolicies.organizationId, org));
  const results = await Promise.all([pruneContextOrganization(org, now), pruneContextOrganization(org, now)]);
  assert.equal(results.reduce((sum, r) => sum + r.transactionsPruned, 0), 2);
  assert.equal(await present(parent), false);
  assert.equal(await present(child), false);
  for (const id of [oldActiveParent, activeChild, oldRecentParent, recent, externalParent, externalChild, malformed, stepRecent, otherAttempt]) assert(await present(id));
  assert.deepEqual(await db.select().from(onbAuditEntries).where(eq(onbAuditEntries.organizationId, org)), auditBefore);
  assert.deepEqual(await db.select().from(onbAuditHeads).where(eq(onbAuditHeads.organizationId, org)), headsBefore);
  assert.deepEqual(await db.select().from(hroContextRetentionPolicies).where(eq(hroContextRetentionPolicies.organizationId, org)), policiesBefore);
});

test("recent activity committed between candidate selection and locking preserves the whole chain", async () => {
  for (const activity of ['step', 'transaction'] as const) {
    await clearMetadata();
    const id = await attempt();
    let injected = false;
    const originalTransaction = db.transaction.bind(db);
    const stub = mock.method(db, "transaction", async (action: Parameters<typeof db.transaction>[0]) =>
      originalTransaction(tx => action(new Proxy(tx, {
        get(target, prop) {
          if (prop === "execute") return async (query: Parameters<typeof tx.execute>[0]) => {
            const result = await target.execute(query);
            if (!injected && result.rows.some(row => typeof row === 'object' && row !== null && 'correlation_id' in row)) {
              injected = true;
              // A separate committed writer, before the sweep holds member row
              // locks. No providers, real cases, or production authority changes.
              if (activity === 'step') {
                await db.insert(hroContextSteps).values({
                  organizationId: org, transactionId: id, code: 'approval-observed', createdAt: now,
                });
              } else {
                await db.update(hroContextTransactions).set({ updatedAt: now })
                  .where(eq(hroContextTransactions.id, id));
              }
            }
            return result;
          };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }))));
    try {
      const swept = await pruneContextOrganization(org, now);
      assert(injected, 'the interleaving must execute after candidate selection');
      assert.equal(swept.transactionsPruned, 0, activity);
      assert.equal(swept.stepsPruned, 0, activity);
      assert(await present(id), 'recent activity protects the transaction and all its steps');
      assert.equal((await db.select().from(hroContextSteps).where(eq(hroContextSteps.transactionId, id))).length,
        activity === 'step' ? 2 : 1);
    } finally { stub.mock.restore(); }
  }
});

test("any class/object hold blocks opaque metadata, shared hold fence serializes a sweep, and release resumes", async () => {
  await clearMetadata();
  const id = await attempt();
  // Use the real authority-checked hold mutation path, not just a local flag.
  const hold = await setSensitiveLifecycleHold({
    organizationId: org, actorUserId: actor, dataClass: "medical", reason: "Test legal preservation", reference: "TEST-HOLD",
  });
  assert.equal((await pruneContextOrganization(org, now)).outcome, "held");
  assert(await present(id));
  assert.equal((await getContextRetentionStatus(org, actor)).status, "held");
  const { AsyncResource } = await import("node:async_hooks");
  const resource = new AsyncResource("outside-retention-fence");
  let completed = false;
  let pending!: Promise<Awaited<ReturnType<typeof pruneContextOrganization>>>;
  await withSensitiveLifecycleFence(org, async () => {
    pending = resource.runInAsyncScope(() => pruneContextOrganization(org, now).then(result => {
      completed = true;
      return result;
    }));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(completed, false, "sweep must wait behind the same privacy fence as hold mutation");
  });
  assert.equal((await pending).outcome, "held");
  resource.emitDestroy();
  await releaseSensitiveLifecycleHold({ organizationId: org, actorUserId: actor, holdId: hold.id, reference: "TEST-RELEASE" });
  assert.equal((await pruneContextOrganization(org, now)).transactionsPruned, 1);
  assert.equal(await present(id), false);
});

test("concurrent policy shortening and hold acquisition wait behind the shared lifecycle fence", async () => {
  const { AsyncResource } = await import("node:async_hooks");
  const resource = new AsyncResource("outside-retention-fence");
  let pendingHold!: Promise<unknown>, pendingPolicy!: Promise<unknown>;
  let holdDone = false, policyDone = false;
  await withSensitiveLifecycleFence(org, async () => {
    pendingHold = resource.runInAsyncScope(() => setSensitiveLifecycleHold({
      organizationId: org, actorUserId: actor, dataClass: "bgv", reason: "Test hold", reference: "TEST-SERIAL-HOLD",
    }).then(() => { holdDone = true; }));
    pendingPolicy = resource.runInAsyncScope(() => saveContextRetentionPolicy(org, actor, rule(1, true, 10)).then(() => { policyDone = true; }));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(holdDone, false);
    assert.equal(policyDone, false);
  });
  await Promise.all([pendingHold, pendingPolicy]);
  resource.emitDestroy();
  assert(holdDone && policyDone);
  assert.equal((await pruneContextOrganization(org)).outcome, "held");
  const holds = await db.select().from(onbSensitiveLifecycleHolds).where(and(
    eq(onbSensitiveLifecycleHolds.organizationId, org), eq(onbSensitiveLifecycleHolds.active, true),
  ));
  for (const hold of holds) await releaseSensitiveLifecycleHold({ organizationId: org, actorUserId: actor, holdId: hold.id, reference: "TEST-RELEASE" });
});

test("audit legal hold also blocks pruning, and retention lock serializes audit hold transitions", async () => {
  await clearMetadata();
  const id = await attempt();
  await db.transaction(async tx => {
    await lockHroContextRetention(tx, org);
    await tx.insert(onbAuditLifecycles).values({ organizationId: org, legalHoldActive: true }).onConflictDoUpdate({
      target: onbAuditLifecycles.organizationId, set: { legalHoldActive: true },
    });
  });
  assert.equal((await pruneContextOrganization(org)).outcome, "held");
  assert(await present(id));
  await db.transaction(async tx => {
    await lockHroContextRetention(tx, org);
    await tx.update(onbAuditLifecycles).set({ legalHoldActive: false }).where(eq(onbAuditLifecycles.organizationId, org));
  });
  assert.equal((await pruneContextOrganization(org)).transactionsPruned, 1);
});

test("bounded batches resume, oversized chains do not starve unrelated work, and orphan anchors are bounded", async () => {
  await clearMetadata();
  const oversized = await attempt({ steps: CONTEXT_RETENTION_LIMITS.steps + 1 });
  const correlation = randomUUID();
  for (let i = 0; i <= CONTEXT_RETENTION_LIMITS.transactions; i++) await attempt({ correlationId: correlation, steps: 0 });
  for (let i = 0; i < 25; i++) await attempt();
  const first = await pruneContextOrganization(org, now);
  const second = await pruneContextOrganization(org, now);
  assert.equal(first.transactionsPruned + second.transactionsPruned, 25);
  assert(first.transactionsPruned <= CONTEXT_RETENTION_LIMITS.transactions && first.stepsPruned <= CONTEXT_RETENTION_LIMITS.steps);
  assert(await present(oversized));
  await db.insert(hroContextAnchors).values(Array.from({ length: 105 }, () => ({
    id: randomUUID(), organizationId: org, subjectType: "case", subjectHash: randomUUID(), createdAt: old,
  })));
  assert.equal((await pruneContextOrganization(org, now)).anchorsPruned, 100);
  assert.equal((await pruneContextOrganization(org, now)).anchorsPruned, 5);
});

test("crash before status commit rolls back deletion; a fresh sweep safely resumes", async () => {
  await clearMetadata();
  const id = await attempt();
  const originalTransaction = db.transaction.bind(db);
  // Fail exactly after deletes but before the atomic status write.
  const stub = mock.method(db, "transaction", async (action: Parameters<typeof db.transaction>[0]) =>
    originalTransaction(tx => action(new Proxy(tx, {
      get(target, prop) {
        if (prop === "insert") return (table: unknown) => {
          if (table === hroContextRetentionState) throw new Error("simulated-process-interruption");
          return target.insert(table as typeof hroContextRetentionState);
        };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }))));
  try { await assert.rejects(pruneContextOrganization(org, now), /simulated-process-interruption/); }
  finally { stub.mock.restore(); }
  assert(await present(id));
  assert.equal((await db.select().from(hroContextSteps).where(eq(hroContextSteps.transactionId, id))).length, 1);
  assert.equal((await pruneContextOrganization(org, now)).transactionsPruned, 1);
  assert.equal(await present(id), false);
});

test("opening children cannot race parent pruning and missing/closed parents cannot be revived", async () => {
  await clearMetadata();
  const parent = await openHroContext({ organizationId: org, subjectType: "tenant", subjectId: org, workflow: "organization", initiatingUserId: actor });
  await runInHroContext(parent, async () => {
    const child = await openHroContext({ organizationId: org, subjectType: "case", subjectId: "safe-test-case", workflow: "onboarding" });
    assert.equal(child.parentTransactionId, parent.id);
    await closeHroContext(child, "completed");
    await pruneContextOrganization(org, new Date(Date.now() + 20 * 86_400_000));
    assert(await present(parent.id));
    assert(await present(child.id));
    await closeHroContext(parent, "completed");
    await assert.rejects(openHroContext({ organizationId: org, subjectType: "case", subjectId: "safe-test-case", workflow: "onboarding" }), /PARENT_UNAVAILABLE/);
  });
});

test("pause persists across sweeps, live revoked authority is rejected, and heartbeat is bounded/no-throw", async () => {
  const status = await saveContextRetentionPolicy(org, actor, rule(2, false));
  assert.equal(status.status, "paused");
  const id = await attempt();
  assert.equal((await pruneContextOrganization(org)).outcome, "paused");
  assert(await present(id));
  await db.update(onbGovernanceAuthorityAssignments).set({ revokedAt: new Date() }).where(eq(onbGovernanceAuthorityAssignments.organizationId, org));
  await assert.rejects(getContextRetentionStatus(org, actor), /verified privacy or legal/);
  await assert.rejects(saveContextRetentionPolicy(org, actor, rule(3)), /verified privacy or legal/);
  await db.update(onbGovernanceAuthorityAssignments).set({ revokedAt: null }).where(eq(onbGovernanceAuthorityAssignments.organizationId, org));
  const first = runContextRetentionTick(), second = runContextRetentionTick();
  assert.equal(first, second);
  const result = await first;
  assert(result.organizations <= CONTEXT_RETENTION_LIMITS.organizations);
});

test("retention routes enforce live authority, reject cross-tenant access, and expose real status", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = req.header("x-test-actor");
    req.organizationId = req.header("x-test-org") ?? org;
    next();
  });
  app.use(contextRouter);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/context-manager/retention`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { "x-test-actor": owner } })).status, 403);
    assert.equal((await fetch(url, { headers: { "x-test-actor": actor, "x-test-org": other } })).status, 403);
    const response = await fetch(url, { headers: { "x-test-actor": actor } });
    assert.equal(response.status, 200);
    const status = await response.json() as {
      policy: { revision: number }; status: string; limits: { transactions: number };
    };
    assert.equal(status.policy.revision, 3);
    assert.equal(status.status, "paused");
    assert.equal(status.limits.transactions, 100);
    assert(!JSON.stringify(status).includes(actor));
    const stale = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "x-test-actor": actor }, body: JSON.stringify(rule(0)) });
    assert.equal(stale.status, 409);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
