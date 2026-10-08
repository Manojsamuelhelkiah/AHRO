import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, onbGovernanceAuthorityAssignments, onbSettings, organizationsTable, organizationMembershipsTable } from "@workspace/db";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { HrPolicyError } from "./hr-policy-library";
import { benchmarkHash, POLICY_BENCHMARK, LIVE_LIMITS } from "./hr-policy-benchmark";
import { LIVE_CONFIRMATION, REVIEW_CONFIRMATION, policyEvaluationCatalog, reviewPolicyBenchmark, runPolicyBenchmark } from "./hr-policy-evaluation";

const suffix = randomUUID();
const org = `policy-eval-${suffix}`;
const otherOrg = `policy-eval-other-${suffix}`;
const reviewer = `synthetic-reviewer-${suffix}`;
const owner = `synthetic-owner-${suffix}`;
const member = `synthetic-member-${suffix}`;
const stranger = `synthetic-stranger-${suffix}`;
const reviewInput = (decision = "approved", expectedReviewId: string | null = null) => ({
  benchmarkHash: benchmarkHash(), decision, expectedReviewId,
  reference: "Synthetic integration test review only", confirmation: REVIEW_CONFIRMATION,
});
const runInput = (mode: "offline" | "live", requestId = randomUUID()) => ({
  mode, requestId, benchmarkHash: benchmarkHash(), ...(mode === "live" ? { confirmation: LIVE_CONFIRMATION } : {}),
});
async function denied(action: () => Promise<unknown>, status: number) {
  await assert.rejects(action, (e: unknown) => e instanceof HrPolicyError && e.statusCode === status);
}
before(async () => {
  await db.insert(organizationsTable).values([
    { id: org, name: "Synthetic policy evaluation", slug: org, joinCodeHash: org, createdByUserId: owner },
    { id: otherOrg, name: "Synthetic other evaluation", slug: otherOrg, joinCodeHash: otherOrg, createdByUserId: stranger },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId: org, clerkUserId: owner, role: "owner" },
    { organizationId: org, clerkUserId: reviewer, role: "admin" },
    { organizationId: org, clerkUserId: member, role: "member" },
    { organizationId: otherOrg, clerkUserId: stranger, role: "owner" },
  ]);
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: org, authorityRole: "hr-compliance", assigneeUserId: reviewer,
    verifiedByUserId: "synthetic-operator", verificationReference: "synthetic-fixture",
  });
});
after(async () => {
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, org));
  await db.delete(onbGovernanceAuthorityAssignments).where(eq(onbGovernanceAuthorityAssignments.organizationId, org));
  await deleteTestOrganizations(eq(organizationsTable.id, org));
  await deleteTestOrganizations(eq(organizationsTable.id, otherOrg));
});

test("draft answer keys cannot become approved or measured merely by running tests", async () => {
  const catalog = await policyEvaluationCatalog(org, owner);
  assert.equal(catalog.approved, false);
  assert.equal(catalog.canReview, false);
  assert.equal(catalog.currentLiveEvidence, false);
  await denied(() => runPolicyBenchmark(org, member, runInput("offline")), 409);
  await denied(() => reviewPolicyBenchmark(org, owner, reviewInput()), 403);
  await denied(() => reviewPolicyBenchmark(org, reviewer, { ...reviewInput(), benchmarkHash: "stale" }), 409);
  await denied(() => reviewPolicyBenchmark(org, reviewer, { ...reviewInput(), confirmation: "yes" }), 400);
  await denied(() => reviewPolicyBenchmark(org, reviewer, { ...reviewInput(), reference: "x".repeat(501) }), 400);
});
test("verified review binds every synthetic source, expected outcome and explicit abstention", async () => {
  const approved = await reviewPolicyBenchmark(org, reviewer, reviewInput());
  const catalog = await policyEvaluationCatalog(org, member);
  assert.equal(catalog.approved, true);
  assert.equal(catalog.review?.reviewId, approved.review.reviewId);
  assert.equal(catalog.review?.benchmarkHash, benchmarkHash());
  const translation = POLICY_BENCHMARK.find(c => c.pairing?.language === "es")!;
  const originalQuestion = translation.question;
  try {
    translation.question += " Synthetic changed wording.";
    assert.equal((await policyEvaluationCatalog(org, member)).approved, false);
    await denied(() => runPolicyBenchmark(org, member, runInput("offline")), 409);
    await denied(() => runPolicyBenchmark(org, reviewer, runInput("live"), async () => {
      throw new Error("Unreviewed translation reached provider");
    }), 409);
  } finally { translation.question = originalQuestion; }
  await denied(() => reviewPolicyBenchmark(org, reviewer, reviewInput()), 409);
  const id = randomUUID();
  const input = runInput("offline", id);
  const first = await runPolicyBenchmark(org, member, input);
  const second = await runPolicyBenchmark(org, member, input);
  assert.deepEqual(first, second);
  assert.equal(first.run.calls, 0);
  assert.equal(first.run.failed, 0);
  assert.equal(first.run.outcomeAgreement, null);
  assert.equal(first.run.pairedConsistency, null);
  assert.equal(first.run.pairedFailed, 0);
  assert.equal(first.run.pairs.length, 15);
  assert.equal(first.run.review.reviewId, approved.review.reviewId);
  assert.equal((await policyEvaluationCatalog(org, member)).currentLiveEvidence, false);
  await denied(() => runPolicyBenchmark(org, owner, input), 409);
  await denied(() => runPolicyBenchmark(org, member, { ...input, question: "Private employee case" }), 400);
});
test("real-model dispatch needs separate explicit authority and never accepts employee input", async () => {
  await denied(() => runPolicyBenchmark(org, reviewer, { ...runInput("live"), confirmation: undefined }), 403);
  await denied(() => runPolicyBenchmark(org, owner, runInput("live")), 403);
  await denied(() => runPolicyBenchmark(org, member, runInput("live")), 403);
  await denied(() => runPolicyBenchmark(otherOrg, stranger, runInput("offline")), 409);
  await denied(() => policyEvaluationCatalog(org, stranger), 403);
});
test("a reserved live run is idempotent, provider-isolated and bounded across concurrent requests", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const input = runInput("live");
  let calls = 0;
  const running = runPolicyBenchmark(org, reviewer, input, async (q, excerpt, context) => {
    calls++; reached(); await pending;
    const c = POLICY_BENCHMARK.find(c => c.question === q && c.source.text === context && c.expected.modelCalled)!;
    return c.expected.outcome === "supported"
      ? { outcome: "supported", excerptId: "extract-1", quotedText: excerpt }
      : { outcome: c.expected.outcome as "insufficient" | "conflicting" | "injected", excerptId: null, quotedText: null };
  });
  await started;
  const retry = await runPolicyBenchmark(org, reviewer, input, async () => { throw new Error("Duplicate dispatch"); });
  assert.equal(retry.run.status, "running");
  await denied(() => runPolicyBenchmark(org, reviewer, runInput("live"), async () => { throw new Error("Concurrent dispatch"); }), 409);
  release();
  const finished = await running;
  assert.equal(calls, LIVE_LIMITS.calls);
  assert.equal(finished.run.failed, 0);
  assert.equal(finished.run.providerIsolated, true);
  assert.equal(finished.run.pairedConsistency, 1);
  assert.equal(finished.run.pairedFailed, 0);
  assert.equal((await policyEvaluationCatalog(org, reviewer)).currentLiveEvidence, false);
});
test("review rejection, budget exhaustion and revoked memberships remain fail closed", async () => {
  const catalog = await policyEvaluationCatalog(org, reviewer);
  await reviewPolicyBenchmark(org, reviewer, reviewInput("rejected", catalog.review!.reviewId));
  await denied(() => runPolicyBenchmark(org, member, runInput("offline")), 409);
  const rejected = await policyEvaluationCatalog(org, reviewer);
  await reviewPolicyBenchmark(org, reviewer, reviewInput("approved", rejected.review!.reviewId));
  await db.update(onbSettings).set({ value: JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 3, activeUntil: 0 }) })
    .where(and(eq(onbSettings.organizationId, org), eq(onbSettings.key, "policy-evaluation:live-budget")));
  await denied(() => runPolicyBenchmark(org, reviewer, runInput("live"), async () => { throw new Error("Budget leaked"); }), 409);
  await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
    eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, member),
  ));
  await denied(() => policyEvaluationCatalog(org, member), 403);
  await denied(() => runPolicyBenchmark(org, member, runInput("offline")), 403);
});
