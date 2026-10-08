import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, onbSettings, organizationsTable, organizationMembershipsTable, onbGovernanceAuthorityAssignments } from "@workspace/db";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { benchmarkHash, benchmarkProvenance, LIVE_LIMITS, type BenchmarkSelector } from "./hr-policy-benchmark";
import { DRIFT_KEY, DRIFT_CONFIRMATION, comparePolicyDrift, eligibleDriftBaseline, type DriftEvidence } from "./hr-policy-drift";
import { configurePolicyDrift, runPolicyDriftTick, policyEvaluationCatalog, reviewPolicyBenchmark, runPolicyBenchmark, REVIEW_CONFIRMATION, LIVE_CONFIRMATION } from "./hr-policy-evaluation";
import { HrPolicyError } from "./hr-policy-library";
import { currentHroContext } from "./hro-context/core";
import { dispatchHroAi } from "./hro-context/manager";
import { policySelectionRequest } from "./hr-policy-selection";

const org = `drift-fixture-${randomUUID()}`, actor = `reviewer-${randomUUID()}`, owner = `owner-${randomUUID()}`;
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
  ]);
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: org, authorityRole: "hr-compliance", assigneeUserId: actor,
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
  assert.equal(p.checksReserved, 0);
  assert.equal((await policyEvaluationCatalog(org, actor)).currentLiveEvidence, false);
  let calls = 0;
  await tick(async (...args) => { calls++; return correct(...args); });
  assert.equal(calls, 0); // not due
  await due();
  await runPolicyDriftTick(); // production worker skips durable isolated fixture
  assert.equal((await programme()).checksReserved, 0);
  await stop();
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
  const next = await approve();
  await put(DRIFT_KEY, { ...next, expiresAt: new Date(0).toISOString(), nextDueAt: new Date(0).toISOString() });
  await tick(async () => { throw new Error("expired spend"); });
  assert.equal((await programme()).status, "expired");
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
  const run = (await policyEvaluationCatalog(org, actor)).runs.find(r => r.runId === p.latestRunId);
  assert.equal(run.failed, 0);
  assert.equal(run.comparison.verdict, "review-required");
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
  await denied(() => configurePolicyDrift(org, actor, { action: "stop", expectedProgrammeId: id }), 403);
});
