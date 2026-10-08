import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, onbSettings, organizationsTable, organizationMembershipsTable, onbGovernanceAuthorityAssignments } from "@workspace/db";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { buildDriftFaultWorker, runDriftFaultWorker, type FaultStage } from "../test-support/drift-fault-harness";
import { benchmarkHash, benchmarkProvenance, LIVE_LIMITS, type BenchmarkSelector } from "./hr-policy-benchmark";
import { DRIFT_KEY, DRIFT_CONFIRMATION, comparePolicyDrift, eligibleDriftBaseline, type DriftEvidence } from "./hr-policy-drift";
import { configurePolicyDrift, runPolicyDriftTick, policyEvaluationCatalog, reviewPolicyBenchmark, runPolicyBenchmark, REVIEW_CONFIRMATION, LIVE_CONFIRMATION } from "./hr-policy-evaluation";
import { HrPolicyError } from "./hr-policy-library";
import { currentHroContext } from "./hro-context/core";
import { dispatchHroAi } from "./hro-context/manager";
import { policySelectionRequest } from "./hr-policy-selection";
import { policyDriftInbox, updatePolicyDriftInbox, deliverPolicyDriftNotice } from "./hr-policy-drift-notifications";

const org = `drift-fixture-${randomUUID()}`, actor = `reviewer-${randomUUID()}`, owner = `owner-${randomUUID()}`;
const recipient = `independent-reviewer-${randomUUID()}`;
const tick = (selector: BenchmarkSelector) => runPolicyDriftTick(selector, org);
let baseline: DriftEvidence;
const correct: BenchmarkSelector = async (question, excerpt, context) => {
  const { POLICY_BENCHMARK } = await import("./hr-policy-benchmark");
  const c = POLICY_BENCHMARK.find(c => c.question === question && c.source.text === context)!;
  return c.expected.outcome === "supported" ? { outcome: "supported", excerptId: "extract-1", quotedText: excerpt }
    : { outcome: c.expected.outcome as "conflicting" | "insufficient" | "injected", excerptId: null, quotedText: null };
};
const keyWhere = (key: string) => and(eq(onbSettings.organizationId, org), eq(onbSettings.key, key));
async function put(key: string, value: unknown) {
  await db.insert(onbSettings).values({ organizationId: org, key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(value) } });
}
async function programme() {
  const [row] = await db.select().from(onbSettings).where(keyWhere(DRIFT_KEY)); return JSON.parse(row.value);
}
async function approve() {
  const current = (await policyEvaluationCatalog(org, actor)).drift.programme;
  const result = await configurePolicyDrift(org, actor, { action: "approve", baselineRunId: baseline.runId,
    expectedProgrammeId: current?.programmeId ?? null, confirmation: DRIFT_CONFIRMATION }, true);
  return result.programme;
}
async function due() { const p = await programme(); await put(DRIFT_KEY, { ...p, nextDueAt: new Date(0).toISOString() }); }
async function stop() {
  const p = await programme();
  await configurePolicyDrift(org, actor, { action: "stop", expectedProgrammeId: p.programmeId });
}
const denied = (fn: () => Promise<unknown>, status: number) => assert.rejects(fn, (e: unknown) => e instanceof HrPolicyError && e.statusCode === status);
before(async () => {
  await db.insert(organizationsTable).values({ id: org, name: "Isolated synthetic drift", slug: org, joinCodeHash: org, createdByUserId: owner });
  await db.insert(organizationMembershipsTable).values([
    { organizationId: org, clerkUserId: actor, role: "admin" }, { organizationId: org, clerkUserId: owner, role: "owner" },
    { organizationId: org, clerkUserId: recipient, role: "member" },
  ]);
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: org, authorityRole: "hr-compliance", assigneeUserId: actor,
    verifiedByUserId: "synthetic-operator", verificationReference: "fixture-only",
  });
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: org, authorityRole: "hr-compliance", assigneeUserId: recipient,
    verifiedByUserId: "synthetic-operator", verificationReference: "fixture-only",
  });
  const { review } = await reviewPolicyBenchmark(org, actor, { benchmarkHash: benchmarkHash(), decision: "approved",
    reference: "Synthetic baseline test", expectedReviewId: null, confirmation: REVIEW_CONFIRMATION });
  // Create baseline through the exact production runner/evaluator/receipt
  // plumbing, not by assembling a report with fabricated stored receipts.
  const response = await runPolicyBenchmark(org, actor, {
    benchmarkHash: benchmarkHash(), mode: "live", requestId: randomUUID(), confirmation: LIVE_CONFIRMATION,
  }, async (q, e, c, signal, receipt) => {
    assert.equal(typeof receipt, "function", "Every live dispatch must receive its receipt sink");
    receipt!({ responseId: randomUUID(), resolvedModel: "resolved-a", systemFingerprint: "fp-a",
      promptTokens: 100, completionTokens: 100 });
    return correct(q, e, c, signal);
  });
  baseline = response.run as DriftEvidence;
  assert.equal(baseline.status, "passed");
  assert.equal(baseline.providerReceipts?.length, LIVE_LIMITS.calls);
  assert.equal(baseline.review?.reviewId, review.reviewId);
  await put("policy-evaluation:live-budget", { day: "old", count: 0, activeUntil: 0 });
});
after(async () => {
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, org));
  await db.delete(onbGovernanceAuthorityAssignments).where(eq(onbGovernanceAuthorityAssignments.organizationId, org));
  await deleteTestOrganizations(eq(organizationsTable.id, org));
});
test("comparison distinguishes provider alias change, answer drift, missing receipts and unknown fingerprints", () => {
  const real = { ...baseline, providerIsolated: false };
  assert.equal(eligibleDriftBaseline(real, baseline.review!.reviewId), true);
  assert.equal(eligibleDriftBaseline(baseline, baseline.review!.reviewId), false);
  assert.equal(eligibleDriftBaseline({ ...real, requestHash: "changed" }, baseline.review!.reviewId), false);
  assert.equal(eligibleDriftBaseline({ ...real, status: "running" }, baseline.review!.reviewId), false);
  const unchanged = comparePolicyDrift(real, real);
  assert.equal(unchanged.verdict, "no-observed-drift");
  const changed = { ...real, providerReceipts: real.providerReceipts!.map(r => ({ ...r, resolvedModel: "resolved-b" })) };
  assert.equal(changed.model, real.model);
  assert.equal(comparePolicyDrift(real, changed).providerChanged, true);
  assert.equal(comparePolicyDrift(real, changed).verdict, "review-required");
  assert.equal(comparePolicyDrift(real, { ...real, providerReceipts: real.providerReceipts!.map(r => ({ ...r, systemFingerprint: "fp-b" })) }).providerChanged, true);
  assert.equal(comparePolicyDrift(real, { ...real, providerReceipts: [] }).verdict, "incomplete");
  const noFingerprints = { ...real, providerReceipts: real.providerReceipts!.map(r => ({ ...r, systemFingerprint: null })) };
  assert.equal(comparePolicyDrift(noFingerprints, noFingerprints).fingerprintCoverage, "unknown");
  const results = real.results!.map((r, i) => i ? r : { ...r, actual: "insufficient" as const, abstained: true, quotedText: null });
  assert.deepEqual(comparePolicyDrift(real, { ...real, results }).changedCases, [results[0].caseId]);
  assert.equal(comparePolicyDrift(real, { ...real, authorizationCurrent: false }).verdict, "incomplete");
});
test("separate consent requires reviewer, eligible baseline and strict fictional-only inputs; reads and approval spend nothing", async () => {
  const input = { action: "approve", baselineRunId: baseline.runId, expectedProgrammeId: null, confirmation: DRIFT_CONFIRMATION };
  await denied(() => configurePolicyDrift(org, owner, input, true), 403);
  await denied(() => configurePolicyDrift(org, actor, { ...input, question: "employee content" }, true), 400);
  await denied(() => configurePolicyDrift(org, actor, { ...input, confirmation: "yes" }, true), 403);
  await denied(() => configurePolicyDrift(org, actor, input), 409); // isolated fixture never accepted over HTTP
  const p = await approve();
  assert.equal((await policyDriftInbox(org, actor)).optedIn, false, "spending consent never opts into notifications");
  assert.equal(p.checksReserved, 0);
  assert.equal((await policyEvaluationCatalog(org, actor)).currentLiveEvidence, false);
  let calls = 0;
  await tick(async (...args) => { calls++; return correct(...args); });
  assert.equal(calls, 0); // not due
  await due();
  await runPolicyDriftTick(undefined, org); // production mode skips fixture; never scan other tenants
  assert.equal((await programme()).checksReserved, 0);
  await stop();
});
test("private notices require separate verified opt-in, redact evidence, and deduplicate concurrent programme/run deliveries", async () => {
  await denied(() => policyDriftInbox(`unrelated-${randomUUID()}`, actor), 403);
  await denied(() => updatePolicyDriftInbox(org, owner, { action: "enable", expectedVersion: 0 }), 403);
  const before = await policyDriftInbox(org, actor);
  const preference = await updatePolicyDriftInbox(org, actor, { action: "enable", expectedVersion: before.version });
  assert.equal(preference.enabled, true);
  assert.deepEqual(preference.notices, [], "opting in never backfills prior warnings");
  await denied(() => updatePolicyDriftInbox(org, actor, { action: "disable", expectedVersion: before.version }), 409);
  const event = { programmeId: randomUUID(), runId: randomUUID(), reasons: ["provider-changed", "answer-regression", "programme-paused"] as const };
  const deliver = () => db.transaction(async tx => {
    await tx.execute((await import("drizzle-orm")).sql`select pg_advisory_xact_lock(hashtext(${`policy-evaluation:${org}`}))`);
    await deliverPolicyDriftNotice(tx, org, { ...event, reasons: [...event.reasons] });
  });
  await Promise.all([deliver(), deliver()]);
  const received = await policyDriftInbox(org, actor);
  assert.equal(received.notices.length, 1);
  assert.deepEqual(Object.keys(received.notices[0]).sort(), ["createdAt", "id", "programmeId", "reasons", "runId"]);
  assert.deepEqual(received.notices[0].reasons, event.reasons);
  assert.deepEqual((await policyDriftInbox(org, owner)).notices, [], "tenant ownership grants no reviewer disclosure");
  const acknowledged = await updatePolicyDriftInbox(org, actor, { action: "acknowledge", noticeId: received.notices[0].id, expectedVersion: received.version });
  assert.deepEqual(acknowledged.notices, []);
  await deliver();
  assert.deepEqual((await policyDriftInbox(org, actor)).notices, [], "acknowledgement survives repeated delivery");
  const disabled = await updatePolicyDriftInbox(org, actor, { action: "disable", expectedVersion: received.version });
  const enabled = await updatePolicyDriftInbox(org, actor, { action: "enable", expectedVersion: disabled.version });
  assert.deepEqual(enabled.notices, [], "prior generations never reappear");
  await deliver();
  assert.deepEqual((await policyDriftInbox(org, actor)).notices, []);
  await updatePolicyDriftInbox(org, recipient, { action: "enable", expectedVersion: 0 });
});
test("concurrent workers reserve once, share daily budget and record failed missing-receipt evidence", async () => {
  await approve(); await due();
  let calls = 0, release!: () => void, reached!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { reached = r; });
  const worker = tick(async (...args) => { calls++; reached(); await held; return correct(...args); });
  await started;
  await tick(async () => { throw new Error("duplicate dispatch"); });
  assert.equal((await programme()).checksReserved, 1);
  release(); await worker;
  assert.equal(calls, LIVE_LIMITS.calls);
  const p = await programme();
  assert.equal(p.status, "paused");
  assert.match(p.warning, /failed or unfinished/);
  const catalog = await policyEvaluationCatalog(org, actor);
  assert.equal(catalog.runs.find(r => r.runId === p.latestRunId).comparison.verdict, "incomplete");
  await put("policy-evaluation:live-budget", { day: new Date().toISOString().slice(0, 10), count: 3, activeUntil: 0 });
  await approve(); await due();
  await tick(async () => { throw new Error("budget leaked"); });
  assert.equal((await programme()).checksReserved, 0);
  assert.match((await programme()).warning, /budget/);
  await put("policy-evaluation:live-budget", { day: "old", count: 0, activeUntil: 0 });
});
test("stop during dispatch rechecks fresh consent before the next call and final result", async () => {
  await approve(); await due();
  let calls = 0;
  await tick(async (...args) => { calls++; await stop(); return correct(...args); });
  assert.equal(calls, 1);
  assert.equal((await programme()).status, "stopped");
  const catalog = await policyEvaluationCatalog(org, actor);
  const run = catalog.runs.find(r => r.runId === catalog.drift.programme!.latestRunId)!;
  assert.equal(run.authorizationCurrent, false);
  assert.equal(run.status, "failed");
});
test("interrupted reservations are unfinished without redispatch and consent expires without spending", async () => {
  const p = await approve();
  const runId = randomUUID();
  await put(`policy-evaluation:run:${runId}`, { ...benchmarkProvenance(), runId, mode: "live", status: "running", createdAt: new Date(0).toISOString() });
  await put(DRIFT_KEY, { ...p, checksReserved: 1, latestRunId: runId, nextDueAt: new Date(0).toISOString() });
  await tick(async () => { throw new Error("crash retry"); });
  assert.equal((await programme()).status, "paused");
  assert.equal((await policyEvaluationCatalog(org, actor)).runs.find(r => r.runId === runId).status, "unfinished");
  const notices = (await policyDriftInbox(org, actor)).notices.filter(n => n.programmeId === p.programmeId);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].reasons, ["programme-paused"]);
  await tick(async () => { throw new Error("notification must never retry the provider"); });
  assert.equal((await policyDriftInbox(org, actor)).notices.filter(n => n.programmeId === p.programmeId).length, 1);
  const next = await approve();
  await put(DRIFT_KEY, { ...next, expiresAt: new Date(0).toISOString(), nextDueAt: new Date(0).toISOString() });
  await tick(async () => { throw new Error("expired spend"); });
  assert.equal((await programme()).status, "expired");
});
test("SIGKILL at each dispatch boundary survives worker restart without redispatch or refunded reservations", { timeout: 180_000 }, async () => {
  const worker = await buildDriftFaultWorker();
  const otherOrg = `drift-fixture-${randomUUID()}`;
  try {
    await db.insert(organizationsTable).values({ id: otherOrg, name: "Fictional untouched drift sentinel",
      slug: otherOrg, joinCodeHash: otherOrg, createdByUserId: owner });
    const stages: FaultStage[] = ["reserved", "dispatched", "receipt", "before-finalization"];
    for (const stage of stages) {
      await put("policy-evaluation:live-budget", { day: new Date().toISOString().slice(0, 10), count: 1, activeUntil: 0 });
      const p = await approve();
      await due();
      assert.equal(p.providerIsolated, true, "Persist isolation before any child or live worker can select the programme");
      const sentinel = { ...p, nextDueAt: new Date(0).toISOString() };
      await db.insert(onbSettings).values({ organizationId: otherOrg, key: DRIFT_KEY, value: JSON.stringify(sentinel) })
        .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(sentinel) } });
      const messages = await runDriftFaultWorker(worker.workerPath, org, stage);
      const dispatches = stage === "reserved" ? 0 : stage === "before-finalization" ? LIVE_LIMITS.calls : 1;
      const receipts = stage === "reserved" || stage === "dispatched" ? 0 : stage === "before-finalization" ? LIVE_LIMITS.calls : 1;
      assert.equal(messages.filter(m => m.kind === "dispatch").length, dispatches, stage);
      assert.equal(messages.filter(m => m.kind === "receipt").length, receipts, stage);
      assert.ok(messages.filter(m => m.kind === "dispatch" || m.kind === "receipt").every(m => m.org === org));
      const reserved = await programme();
      assert.equal(reserved.checksReserved, 1, stage);
      assert.notEqual(reserved.latestRunId, null);
      const [budgetRow] = await db.select().from(onbSettings).where(keyWhere("policy-evaluation:live-budget"));
      const budget = JSON.parse(budgetRow.value);
      assert.equal(budget.count, 2, "One reservation shares the manual live daily budget");
      const runKey = `policy-evaluation:run:${reserved.latestRunId}`;
      const catalog = await policyEvaluationCatalog(org, actor);
      const running = catalog.runs.find(r => r.runId === reserved.latestRunId)!;
      assert.equal(running.status, "running", "SIGKILL must not execute finalization");
      // A fresh process must not resend even before the ambiguity window expires.
      const immediate = await runDriftFaultWorker(worker.workerPath, org, "recover");
      assert.equal(immediate.filter(m => m.kind === "dispatch" || m.kind === "receipt").length, 0);
      assert.deepEqual(await programme(), reserved);
      // Advance only this owned run's timestamp, not budget/consent, to avoid a real-time wait.
      await put(runKey, { ...running, createdAt: new Date(0).toISOString() });
      for (let restart = 0; restart < 2; restart++) {
        const recovery = await runDriftFaultWorker(worker.workerPath, org, "recover");
        assert.equal(recovery.filter(m => m.kind === "dispatch" || m.kind === "receipt").length, 0);
        const visible = await policyEvaluationCatalog(org, actor);
        assert.equal(visible.drift.programme!.status, "paused");
        assert.equal(visible.drift.programme!.checksReserved, 1);
        assert.equal(visible.drift.programme!.latestRunId, reserved.latestRunId);
        assert.match(visible.drift.programme!.warning!, /unfinished.*reservation consumed.*No automatic retry/i);
        assert.equal(visible.currentLiveEvidence, false);
        const unfinished = visible.runs.find(r => r.runId === reserved.latestRunId)!;
        assert.equal(unfinished.status, "unfinished");
        assert.equal(unfinished.authorizationCurrent, false);
        assert.equal(unfinished.comparison, undefined, "Unfinished receipts must not imply a completed drift verdict");
      }
      const [afterBudget] = await db.select().from(onbSettings).where(keyWhere("policy-evaluation:live-budget"));
      assert.deepEqual(JSON.parse(afterBudget.value), budget, "Recovery must neither refund nor spend shared daily budget");
      const [untouched] = await db.select().from(onbSettings).where(and(eq(onbSettings.organizationId, otherOrg), eq(onbSettings.key, DRIFT_KEY)));
      assert.deepEqual(JSON.parse(untouched.value), sentinel, "Child workers must never claim another fixture tenant");
      await runPolicyDriftTick(undefined, org);
      assert.equal((await programme()).checksReserved, 1, "Production workers cannot dispatch isolated fixture programmes");
    }
  } finally {
    await worker.dispose();
    await db.delete(onbSettings).where(eq(onbSettings.organizationId, otherOrg));
    await deleteTestOrganizations(eq(organizationsTable.id, otherOrg));
  }
});
test("at most three checks consume durable programme reservations, and provider changes warn despite passing answers", async () => {
  await put("policy-evaluation:live-budget", { day: "old", count: 0, activeUntil: 0 });
  await approve();
  const selector: BenchmarkSelector = async (q, e, c, s, receipt) => {
    assert.equal(currentHroContext()?.organizationId, org);
    assert.equal(currentHroContext()?.executorType, "system");
    assert.equal(currentHroContext()?.initiatingUserId, actor);
    receipt?.({ responseId: randomUUID(), resolvedModel: "resolved-a", systemFingerprint: "fp-a", promptTokens: 100, completionTokens: 100 });
    return dispatchHroAi(policySelectionRequest(q, e, c), () => correct(q, e, c, s));
  };
  for (let i = 1; i <= 3; i++) {
    // Advance the due marker to represent the next approved daily window.
    await due();
    await put("policy-evaluation:live-budget", { day: "old", count: 0, activeUntil: 0 });
    await tick(selector);
    const p = await programme();
    assert.equal(p.checksReserved, i);
    assert.equal(p.status, i === 3 ? "exhausted" : "active");
    const run = (await policyEvaluationCatalog(org, actor)).runs.find(r => r.runId === p.latestRunId);
    assert.equal(run.status, "passed");
    assert.equal(run.comparison.verdict, "no-observed-drift");
  }
  await due();
  await tick(async () => { throw new Error("fourth check"); });
  assert.equal((await programme()).checksReserved, 3);
  await approve(); await due();
  await put("policy-evaluation:live-budget", { day: "old", count: 0, activeUntil: 0 });
  await tick(async (q, e, c, s, receipt) => {
    receipt?.({ responseId: randomUUID(), resolvedModel: "resolved-b", systemFingerprint: "fp-b", promptTokens: 100, completionTokens: 100 });
    return correct(q, e, c, s);
  });
  const p = await programme();
  assert.equal(p.status, "paused");
  assert.match(p.warning, /Provider identity changed/);
  const notice = (await policyDriftInbox(org, actor)).notices.find(n => n.programmeId === p.programmeId)!;
  assert.ok(notice);
  assert.deepEqual(notice.reasons, ["provider-changed", "programme-paused"]);
  const run = (await policyEvaluationCatalog(org, actor)).runs.find(r => r.runId === p.latestRunId);
  assert.equal(run.failed, 0);
  assert.equal(run.comparison.verdict, "review-required");
});
test("answer regressions deliver a content-free run notice and opt-out prevents subsequent delivery", async () => {
  const p = await approve(); await due();
  await put("policy-evaluation:live-budget", { day: "old", count: 0, activeUntil: 0 });
  await tick(async (_q, _e, _c, _s, receipt) => {
    receipt!({ responseId: randomUUID(), resolvedModel: "resolved-a", systemFingerprint: "fp-a", promptTokens: 100, completionTokens: 100 });
    return { outcome: "insufficient", excerptId: null, quotedText: null };
  });
  assert.equal((await programme()).status, "paused");
  const inbox = await policyDriftInbox(org, actor);
  const notice = inbox.notices.find(n => n.programmeId === p.programmeId)!;
  assert.deepEqual(notice.reasons, ["answer-regression", "programme-paused"]);
  assert.equal(notice.runId, (await programme()).latestRunId);
  const beforeBudget = await db.select().from(onbSettings).where(keyWhere("policy-evaluation:live-budget"));
  await policyDriftInbox(org, actor);
  const disabled = await updatePolicyDriftInbox(org, actor, { action: "disable", expectedVersion: inbox.version });
  const event = { programmeId: randomUUID(), runId: null, reasons: ["programme-paused" as const] };
  await db.transaction(tx => deliverPolicyDriftNotice(tx, org, event));
  assert.deepEqual((await policyDriftInbox(org, actor)).notices, []);
  const reenabled = await updatePolicyDriftInbox(org, actor, { action: "enable", expectedVersion: disabled.version });
  assert.deepEqual(reenabled.notices, []);
  assert.deepEqual(await db.select().from(onbSettings).where(keyWhere("policy-evaluation:live-budget")), beforeBudget,
    "reading notices and changing notification consent cannot consume or reset the model budget");
});
test("changed answer-key review pauses the programme without provider spending", async () => {
  await approve(); await due();
  const review = (await policyEvaluationCatalog(org, actor)).review!;
  await reviewPolicyBenchmark(org, actor, { benchmarkHash: benchmarkHash(), decision: "approved",
    reference: "Replacement synthetic review", expectedReviewId: review.reviewId, confirmation: REVIEW_CONFIRMATION });
  await tick(async () => { throw new Error("stale review spend"); });
  assert.equal((await programme()).checksReserved, 0);
  assert.equal((await programme()).status, "paused");
  // Restore a newly reviewed isolated baseline for the final authority test.
  const current = (await policyEvaluationCatalog(org, actor)).review!;
  baseline = { ...baseline, review: current };
  await put(`policy-evaluation:run:${baseline.runId}`, baseline);
});
test("revoked authority pauses rather than spending", async () => {
  await approve(); await due();
  await db.update(onbGovernanceAuthorityAssignments).set({ revokedAt: new Date() })
    .where(and(eq(onbGovernanceAuthorityAssignments.organizationId, org), eq(onbGovernanceAuthorityAssignments.assigneeUserId, actor)));
  await tick(async () => { throw new Error("revoked authority spend"); });
  assert.equal((await programme()).status, "paused");
  assert.equal((await programme()).checksReserved, 0);
  const id = (await programme()).programmeId;
  const otherReviewer = await policyDriftInbox(org, recipient);
  assert.deepEqual(otherReviewer.notices.find(n => n.programmeId === id)?.reasons, ["programme-paused"],
    "loss of the spending actor's authority still notifies separately opted-in current reviewers");
  await denied(() => configurePolicyDrift(org, actor, { action: "stop", expectedProgrammeId: id }), 403);
  const hidden = await policyDriftInbox(org, actor);
  assert.equal(hidden.enabled, false);
  assert.equal(hidden.optedIn, true);
  assert.deepEqual(hidden.notices, [], "already delivered warnings cannot be read after authority revocation");
  const optedOut = await updatePolicyDriftInbox(org, actor, { action: "disable", expectedVersion: hidden.version });
  assert.equal(optedOut.optedIn, false, "privacy withdrawal requires membership, not renewed specialist authority");
  await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
    eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, recipient)));
  await denied(() => policyDriftInbox(org, recipient), 403);
  await db.transaction(tx => deliverPolicyDriftNotice(tx, org, {
    programmeId: randomUUID(), runId: null, reasons: ["programme-paused"],
  }));
  await db.update(organizationMembershipsTable).set({ revokedAt: null }).where(and(
    eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, recipient)));
  assert.equal((await policyDriftInbox(org, recipient)).notices.length, otherReviewer.notices.length,
    "delivery does not use a reviewer whose membership was revoked");
});
