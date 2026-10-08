import { randomUUID } from "node:crypto";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { db, onbSettings } from "@workspace/db";
import { HrPolicyError, policyCapabilities, verifiedAuthority } from "./hr-policy-library";
import { selectApprovedPolicyExtract, type PolicyProviderReceipt } from "./hr-policy-ai";
import { benchmarkHash, benchmarkProvenance, POLICY_BENCHMARK, evaluateBenchmark, LIVE_LIMITS, BENCHMARK_LIMITATION, type BenchmarkSelector } from "./hr-policy-benchmark";

const REVIEW_KEY = "policy-evaluation:review";
const SLOT_KEY = "policy-evaluation:live-budget";
const RUN_PREFIX = "policy-evaluation:run:";
export const REVIEW_CONFIRMATION = "I reviewed every synthetic question, paraphrase and translation for semantic equivalence, and checked its source, audience, dates, expected quote, outcome and abstention.";
export const LIVE_CONFIRMATION = "Run the approved synthetic benchmark against the real model within the displayed budget.";
type Review = { reviewId: string; benchmarkHash: string; decision: "approved" | "rejected"; reviewer: string; reviewedAt: string; authorityId: number; reference: string };
async function readSetting(tx: any, org: string, key: string) {
  const [row] = await tx.select().from(onbSettings).where(and(eq(onbSettings.organizationId, org), eq(onbSettings.key, key)));
  return row ? JSON.parse(row.value) : null;
}
async function writeSetting(tx: any, org: string, key: string, value: unknown) {
  await tx.insert(onbSettings).values({ organizationId: org, key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(value), updatedAt: sql`now()` } });
}
async function fence(tx: any, org: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`policy-evaluation:${org}`}))`);
}
function bodyRecord(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new HrPolicyError("Invalid evaluation request.");
  return input as Record<string, unknown>;
}
async function assertReview(tx: any, org: string) {
  const review = await readSetting(tx, org, REVIEW_KEY) as Review | null;
  if (!review || review.decision !== "approved" || review.benchmarkHash !== benchmarkHash()) throw new HrPolicyError("The current synthetic answer key needs business approval.", 409);
  return review;
}
export async function policyEvaluationCatalog(org: string, actor: string) {
  await policyCapabilities(org, actor); // live tenant membership
  const review = await readSetting(db, org, REVIEW_KEY) as Review | null;
  let canReview = false;
  try { await db.transaction(tx => verifiedAuthority(tx, org, actor, "hr-compliance")); canReview = true; }
  catch (error) { if (!(error instanceof HrPolicyError) || error.statusCode !== 403) throw error; }
  const rows = await db.select({ value: onbSettings.value }).from(onbSettings)
    .where(and(eq(onbSettings.organizationId, org), like(onbSettings.key, `${RUN_PREFIX}%`)))
    .orderBy(desc(onbSettings.updatedAt)).limit(20);
  await policyCapabilities(org, actor); // reauthorize response
  const provenance = benchmarkProvenance();
  const runs = rows.map(r => JSON.parse(r.value));
  return {
    ...provenance, cases: POLICY_BENCHMARK, canReview, review,
    approved: review?.decision === "approved" && review.benchmarkHash === benchmarkHash(),
    reviewConfirmation: REVIEW_CONFIRMATION, liveConfirmation: LIVE_CONFIRMATION,
    limits: { ...LIVE_LIMITS, liveRunsPerTenantPerDay: 3 }, runs,
    currentLiveEvidence: runs.some(r => r.mode === "live" && r.status === "passed" && !r.providerIsolated && r.authorizationCurrent &&
      r.benchmarkHash === provenance.benchmarkHash && r.requestHash === provenance.requestHash && r.contractHash === provenance.contractHash &&
      r.review?.reviewId === review?.reviewId && review?.decision === "approved"),
    limitation: BENCHMARK_LIMITATION,
  };
}
export async function reviewPolicyBenchmark(org: string, actor: string, input: unknown) {
  const body = bodyRecord(input, ["benchmarkHash", "decision", "reference", "confirmation", "expectedReviewId"]);
  if (body.benchmarkHash !== benchmarkHash()) throw new HrPolicyError("The benchmark changed; refresh and review every case again.", 409);
  if (!["approved", "rejected"].includes(String(body.decision)) || typeof body.reference !== "string" || !body.reference.trim() || body.reference.length > 500 ||
      body.confirmation !== REVIEW_CONFIRMATION) throw new HrPolicyError("A review decision, evidence reference and explicit review confirmation are required.");
  return db.transaction(async tx => {
    await fence(tx, org);
    const authority = await verifiedAuthority(tx, org, actor, "hr-compliance");
    const current = await readSetting(tx, org, REVIEW_KEY);
    if ((current?.reviewId ?? null) !== body.expectedReviewId) throw new HrPolicyError("The business review changed; refresh before deciding.", 409);
    const review: Review = {
      reviewId: randomUUID(),
      benchmarkHash: benchmarkHash(), decision: body.decision as Review["decision"], reference: String(body.reference).trim(),
      reviewer: actor, reviewedAt: new Date().toISOString(), authorityId: authority.id,
    };
    await writeSetting(tx, org, `${REVIEW_KEY}:history:${randomUUID()}`, review);
    await writeSetting(tx, org, REVIEW_KEY, review);
    return { review };
  });
}
export async function runPolicyBenchmark(org: string, actor: string, input: unknown, testSelector?: BenchmarkSelector) {
  const body = bodyRecord(input, ["benchmarkHash", "mode", "confirmation", "requestId"]);
  if (body.benchmarkHash !== benchmarkHash()) throw new HrPolicyError("The benchmark changed; refresh before running.", 409);
  if ((body.mode !== "offline" && body.mode !== "live") || typeof body.requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(body.requestId)) throw new HrPolicyError("A valid run mode and request id are required.");
  const mode = body.mode;
  if (mode === "live" && body.confirmation !== LIVE_CONFIRMATION) throw new HrPolicyError("Explicit real-model budget authorization is required.", 403);
  const runKey = `${RUN_PREFIX}${body.requestId}`;
  const reserved = await db.transaction(async tx => {
    await fence(tx, org);
    if (mode === "live") await verifiedAuthority(tx, org, actor, "hr-compliance");
    else await policyCapabilities(org, actor);
    const review = await assertReview(tx, org);
    const existing = await readSetting(tx, org, runKey);
    if (existing) {
      if (existing.mode !== mode || existing.actor !== actor || existing.benchmarkHash !== benchmarkHash()) throw new HrPolicyError("This request id belongs to a different run.", 409);
      return { existing, review };
    }
    if (mode === "live") {
      const slot = await readSetting(tx, org, SLOT_KEY);
      const day = new Date().toISOString().slice(0, 10);
      if (slot?.activeUntil > Date.now()) throw new HrPolicyError("A real-model evaluation is already reserved. Retry after its budget window.", 409);
      const count = slot?.day === day ? slot.count : 0;
      if (count >= 3) throw new HrPolicyError("The tenant's daily real-model evaluation budget is exhausted.", 409);
      // Durable reservation before dispatch. Crashes consume the budget; retries
      // never reclaim an ambiguous real-model call or reset the daily count.
      await writeSetting(tx, org, SLOT_KEY, { day, count: count + 1, activeUntil: Date.now() + LIVE_LIMITS.milliseconds + 30000 });
    }
    await writeSetting(tx, org, runKey, {
      ...benchmarkProvenance(), runId: body.requestId, mode, actor, review, status: "running", createdAt: new Date().toISOString(),
    });
    return { existing: null, review };
  });
  if (reserved.existing) return { run: reserved.existing };
  const authorize = () => db.transaction(async tx => {
    await fence(tx, org);
    await verifiedAuthority(tx, org, actor, "hr-compliance");
    const current = await assertReview(tx, org);
    if (current.reviewId !== reserved.review.reviewId) throw new HrPolicyError("The business review changed during this run.", 409);
  });
  const providerReceipts: PolicyProviderReceipt[] = [];
  const report = await evaluateBenchmark(mode, mode === "live"
    ? testSelector ?? ((q, e, c, signal) => selectApprovedPolicyExtract(q, e, c, signal, receipt => providerReceipts.push(receipt)))
    : undefined, mode === "live" ? authorize : undefined);
  let authorizationCurrent = true;
  if (mode === "live") {
    try { await authorize(); } catch { authorizationCurrent = false; }
  }
  const run = {
    ...report, providerReceipts, providerIsolated: Boolean(testSelector), authorizationCurrent, runId: body.requestId, actor, review: reserved.review,
    status: authorizationCurrent && report.failed === 0 && report.pairedFailed === 0 ? "passed" : "failed",
  };
  await db.transaction(async tx => { await fence(tx, org); await writeSetting(tx, org, runKey, run); });
  await policyCapabilities(org, actor);
  return { run };
}
