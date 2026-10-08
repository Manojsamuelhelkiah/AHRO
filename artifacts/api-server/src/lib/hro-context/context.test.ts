import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import { db, pool, organizationsTable, hroContextAnchors, hroContextTransactions, hroContextSteps } from "@workspace/db";
import { currentHroContext, makeHroContextFrame, runInHroContext, withoutHroContext, workflowForHroPath } from "./core";
import { checkHroAiBudget, HroContextBudgetError } from "./ai-budget";
import { closeHroContext, openHroContext, recordHroContextStep, withHroContext, dispatchHroAi } from "./manager";
import contextRouter from "../../routes/hro-context";
import { hroRequestContext } from "../../middlewares/hro-context";
import { makeSharedTick } from "../onboarding/shared-tick";

after(async () => { await pool.end(); });
const seed = (organizationId: string) => ({
  organizationId, workflow: "onboarding" as const, subjectType: "case" as const,
  subjectId: "123", initiatingUserId: "test-human",
});

test("concurrent context frames never cross organizations or actors", async () => {
  await Promise.all(["tenant-a", "tenant-b"].map(async organizationId => {
    const frame = makeHroContextFrame(seed(organizationId), randomUUID());
    await runInHroContext(frame, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(currentHroContext()?.organizationId, organizationId);
      assert.throws(() => makeHroContextFrame(seed("other-tenant"), randomUUID()), /TENANT_MISMATCH/);
      assert.throws(() => makeHroContextFrame({ ...seed(organizationId), initiatingUserId: "other-human" }, randomUUID()), /ACTOR_MISMATCH/);
      const child = makeHroContextFrame(seed(organizationId), randomUUID());
      assert.equal(child.parentTransactionId, frame.id);
      assert.equal(child.correlationId, frame.correlationId);
      assert.notEqual(child.id, frame.id);
      assert.equal(withoutHroContext(() => currentHroContext()), null);
      assert.equal(currentHroContext()?.id, frame.id);
      assert(!JSON.stringify(frame).includes('"subjectId"'));
    });
  }));
  assert.equal(currentHroContext(), null);
});

test("inherited delayed callbacks cannot revive a closed frame", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let delayed!: Promise<unknown>;
  await runInHroContext(makeHroContextFrame(seed("tenant-a"), randomUUID()), async () => {
    delayed = (async () => { await barrier; return currentHroContext(); })();
  });
  release();
  assert.equal(await delayed, null);
});

test("background shared ticks detach the heartbeat's tenant and human context", async () => {
  let ticks = 0;
  const tick = makeSharedTick(async () => { ticks++; assert.equal(currentHroContext(), null); });
  await runInHroContext(makeHroContextFrame(seed("tenant-a"), randomUUID()), async () => {
    await tick();
    assert.equal(currentHroContext()?.organizationId, "tenant-a");
  });
  assert.equal(ticks, 1);
});

test("AI budgets validate Unicode bytes and reject oversize without truncating evidence", () => {
  assert.equal(checkHroAiBudget([{ content: "界" }], 3000).inputBytes, 35);
  for (const output of [0, 1.5, 16001, NaN]) {
    assert.throws(() => checkHroAiBudget([{ content: "safe" }], output), HroContextBudgetError);
  }
  assert.throws(() => checkHroAiBudget([{ content: { untrusted: "data" } }], 3000), HroContextBudgetError);
  const content = "x".repeat(24001);
  assert.throws(() => checkHroAiBudget([{ content }], 3000), /HRO_AI_INPUT_TOO_LARGE/);
  assert.equal(content.length, 24001);
});

test("route classifications include policy, transfers, lifecycle and agent workflows", () => {
  for (const [path, workflow] of [
    ["/policies/answer", "hr-policy"], ["/onboarding/workforce-transfers/programs", "workforce-transfer"],
    ["/onboarding/frontline/x", "frontline"], ["/onboarding/early-tenure/policy", "early-tenure"],
    ["/privacy/lifecycle/deletion-jobs/1/retry", "privacy-lifecycle"],
    ["/agent-invocations", "agent"], ["/onboarding/checklist-profiles/draft", "onboarding"],
    ["/onboarding/governance/decisions", "governance"], ["/onboarding/action-center/actions/assign", "governance"],
  ]) assert.equal(workflowForHroPath(path!), workflow);
  assert.equal(workflowForHroPath("/scenarios"), null);
});

test("durable continuity, closed-step fencing, failed attempts and own-tenant history", async () => {
  const orgA = `context-test-${randomUUID()}`, orgB = `context-test-${randomUUID()}`;
  const actor = `context-actor-${randomUUID()}`;
  for (const id of [orgA, orgB]) await db.insert(organizationsTable).values({
    id, name: "Context test", slug: id, joinCodeHash: id, createdByUserId: actor,
  });
  try {
    const input = { ...seed(orgA), initiatingUserId: actor };
    const frame = await openHroContext(input);
    await runInHroContext(frame, async () => {
      await recordHroContextStep("checkpoint-recorded", { reference: "private-business-value" });
      let dispatched = false;
      await assert.rejects(dispatchHroAi({
        messages: [{ content: "x".repeat(25000) }], max_completion_tokens: 3000,
      }, async () => { dispatched = true; }), /INPUT_TOO_LARGE/);
      assert.equal(dispatched, false);
      await closeHroContext(frame, "completed");
      await assert.rejects(recordHroContextStep("approval-observed"), /ALREADY_CLOSED/);
    });
    const next = await openHroContext(input);
    assert.equal(next.anchorId, frame.anchorId);
    assert.notEqual(next.id, frame.id);
    await closeHroContext(next, "completed");
    const unrelated = await openHroContext({ ...input, initiatingUserId: "other-actor" });
    await closeHroContext(unrelated, "completed");
    const crossTenant = await openHroContext({ ...input, organizationId: orgB });
    await closeHroContext(crossTenant, "completed");
    await assert.rejects(withHroContext(input, async () => { throw new Error("expected-failure"); }), /expected-failure/);
    const [failed] = await db.select().from(hroContextTransactions).where(and(
      eq(hroContextTransactions.organizationId, orgA), eq(hroContextTransactions.status, "failed"),
    ));
    assert(failed?.finishedAt);
    const [step] = await db.select().from(hroContextSteps).where(and(
      eq(hroContextSteps.transactionId, frame.id), eq(hroContextSteps.code, "checkpoint-recorded"),
    ));
    assert.equal(step?.referenceHash?.length, 64);
    assert(!JSON.stringify(step).includes("private-business-value"));
    await assert.rejects(db.insert(hroContextSteps).values({
      organizationId: orgB, transactionId: frame.id, code: "scope-bound",
    }), (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23503");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.organizationId = orgA; req.authUserId = actor; next(); });
    app.use(hroRequestContext);
    app.use(contextRouter);
    app.use("/organizations/current/access", hroRequestContext, (_req, res) => {
      res.json({ workflow: currentHroContext()?.workflow });
    });
    app.post("/onboarding/context-probe", (_req, res) => {
      const context = currentHroContext();
      res.json({ organizationId: context?.organizationId, actor: context?.initiatingUserId });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      const probe = await fetch(`http://127.0.0.1:${address.port}/onboarding/context-probe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: orgB, initiatingUserId: "spoofed", context: frame }),
      });
      assert.equal(probe.status, 200);
      assert.deepEqual(await probe.json(), { organizationId: orgA, actor });
      assert(probe.headers.get("X-HRO-Transaction-Id"));
      assert(probe.headers.get("X-HRO-Correlation-Id"));
      const mountedProbe = await fetch(`http://127.0.0.1:${address.port}/organizations/current/access/groups`, {
        method: "POST",
      });
      assert.equal(mountedProbe.status, 200);
      assert.deepEqual(await mountedProbe.json(), { workflow: "organization" });
      const response = await fetch(`http://127.0.0.1:${address.port}/context-manager/transactions`);
      assert.equal(response.status, 200);
      const body = await response.json() as { available: boolean; transactions: Array<{ id: string }> };
      assert(body.available);
      assert(body.transactions.some(t => t.id === frame.id));
      assert(!body.transactions.some(t => t.id === unrelated.id || t.id === crossTenant.id));
      assert(!JSON.stringify(body).includes("private-business-value"));
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally {
    for (const organizationId of [orgA, orgB]) {
      await db.delete(hroContextSteps).where(eq(hroContextSteps.organizationId, organizationId));
      await db.delete(hroContextTransactions).where(eq(hroContextTransactions.organizationId, organizationId));
      await db.delete(hroContextAnchors).where(eq(hroContextAnchors.organizationId, organizationId));
      await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
    }
  }
});
