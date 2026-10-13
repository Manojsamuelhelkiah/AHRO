import { randomUUID } from "node:crypto";
import { denyRetiredCaseCapability, retiredCaseCapabilitiesEnabled } from "./retired-case-capabilities";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { db, onbSettings } from "@workspace/db";
import { HrPolicyError, policyCapabilities, verifiedAuthority } from "./hr-policy-library";
import { recordedHumanPermissionDecisionCurrent } from "./human-permissions";
import { selectApprovedPolicyExtract, type PolicyProviderReceipt } from "./hr-policy-ai";
import { benchmarkHash, benchmarkProvenance, POLICY_BENCHMARK, evaluateBenchmark, LIVE_LIMITS, BENCHMARK_LIMITATION, type BenchmarkSelector } from "./hr-policy-benchmark";
import { DRIFT_KEY, DRIFT_CONFIRMATION, DRIFT_INTERVAL, DRIFT_DURATION, DRIFT_MAX_CHECKS, DRIFT_RUN_WINDOW,
  eligibleDriftBaseline, comparePolicyDrift, type DriftProgramme, type DriftEvidence } from "./hr-policy-drift";
import { withHroContext } from "./hro-context/manager";
import { withoutHroContext } from "./hro-context/core";
import { deliverPolicyDriftNotice } from "./hr-policy-drift-notifications";

const REVIEW_KEY = "policy-evaluation:review";
const SLOT_KEY = "policy-evaluation:live-budget";
const RUN_PREFIX = "policy-evaluation:run:";
/** In-process fault injection only; never supplied by routes or the heartbeat. */
export type DriftTestCheckpoint = (stage: "reserved" | "before-finalization") => Promise<void>;
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
  const programme = await readSetting(db, org, DRIFT_KEY) as DriftProgramme | null;
  const eligibleBaselineIds = review?.decision === "approved" ? runs
    .filter(r => eligibleDriftBaseline(r, review.reviewId)).map(r => r.runId) as string[] : [];
  await policyCapabilities(org, actor);
  return {
    ...provenance, cases: [], canReview: false, review,
    approved: false,
    reviewConfirmation: "", liveConfirmation: "",
    limits: { ...LIVE_LIMITS, liveRunsPerTenantPerDay: 3 }, runs,
    drift: { programme, confirmation: "", eligibleBaselineIds: [],
      maxChecks: DRIFT_MAX_CHECKS, durationDays: 7, intervalHours: 24 },
    currentLiveEvidence: false,
    limitation: "Historical evaluation evidence only. Execution has been retired; retained results do not establish current accuracy or readiness.",
  };
}
export async function reviewPolicyBenchmark(org: string, actor: string, input: unknown) {
  denyRetiredCaseCapability();
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
export async function runPolicyBenchmark(org: string, actor: string, input: unknown, testSelector?: BenchmarkSelector, programmeId?: string, testCheckpoint?: DriftTestCheckpoint) {
  denyRetiredCaseCapability();
  if (testCheckpoint && (!testSelector || !programmeId)) throw new Error("Drift fault injection requires an isolated programme and fake transport.");
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
    let programme: DriftProgramme | null = null;
    if (programmeId) {
      if (mode !== "live") throw new HrPolicyError("Drift checks require live mode.");
      programme = await assertDriftAuthority(tx, org, actor, programmeId, review.reviewId);
      if (programme.providerIsolated !== Boolean(testSelector)) throw new HrPolicyError("Drift provider isolation mismatch.", 409);
    }
    const existing = await readSetting(tx, org, runKey);
    if (existing) {
      if (existing.mode !== mode || existing.actor !== actor || existing.benchmarkHash !== benchmarkHash()) throw new HrPolicyError("This request id belongs to a different run.", 409);
      return { existing, review, baselineRunId: programme?.baselineRunId };
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
    if (programme) {
      if (Date.parse(programme.nextDueAt) > Date.now() || programme.checksReserved >= DRIFT_MAX_CHECKS)
        throw new HrPolicyError("The approved drift programme is not due or is exhausted.", 409);
      await writeSetting(tx, org, DRIFT_KEY, { ...programme, checksReserved: programme.checksReserved + 1,
        latestRunId: body.requestId, nextDueAt: new Date(Date.now() + DRIFT_INTERVAL).toISOString() });
    }
    await writeSetting(tx, org, runKey, {
      ...benchmarkProvenance(), runId: body.requestId, mode, actor, review, status: "running", createdAt: new Date().toISOString(),
      ...(programmeId ? { programmeId, baselineRunId: programme!.baselineRunId } : {}),
    });
    return { existing: null, review, baselineRunId: programme?.baselineRunId };
  });
  if (reserved.existing) return { run: reserved.existing };
  await testCheckpoint?.("reserved");
  const authorize = () => db.transaction(async tx => {
    await fence(tx, org);
    await verifiedAuthority(tx, org, actor, "hr-compliance");
    const current = await assertReview(tx, org);
    if (current.reviewId !== reserved.review.reviewId) throw new HrPolicyError("The business review changed during this run.", 409);
    if (programmeId) await assertDriftAuthority(tx, org, actor, programmeId, current.reviewId);
  });
  const providerReceipts: PolicyProviderReceipt[] = [];
  const report = await evaluateBenchmark(mode, mode === "live"
    ? testSelector ?? selectApprovedPolicyExtract
    : undefined, mode === "live" ? authorize : undefined, receipt => providerReceipts.push(receipt));
  let authorizationCurrent = true;
  if (mode === "live") {
    try { await authorize(); } catch { authorizationCurrent = false; }
  }
  let run: Record<string, any> = {
    ...report, providerReceipts, providerIsolated: Boolean(testSelector), authorizationCurrent, runId: body.requestId, actor, review: reserved.review,
    status: authorizationCurrent && report.failed === 0 && report.pairedFailed === 0 ? "passed" : "failed",
  };
  await testCheckpoint?.("before-finalization");
  await db.transaction(async tx => {
    await fence(tx, org);
    if (programmeId) {
      const programme = await readSetting(tx, org, DRIFT_KEY) as DriftProgramme;
      // Fence final evidence against stop, replaced consent, review or authority changes.
      try { await assertDriftAuthority(tx, org, actor, programmeId, reserved.review.reviewId); }
      catch { run.authorizationCurrent = false; run.status = "failed"; }
      const baseline = await readSetting(tx, org, `${RUN_PREFIX}${reserved.baselineRunId}`);
      const comparison = comparePolicyDrift(baseline, run as DriftEvidence);
      run = { ...run, programmeId, comparison };
      if (programme.programmeId === programmeId) {
        await writeSetting(tx, org, DRIFT_KEY, { ...programme,
          status: programme.status === "stopped" ? "stopped" : comparison.verdict !== "no-observed-drift" ? "paused"
            : programme.checksReserved >= DRIFT_MAX_CHECKS ? "exhausted" : "active",
          warning: comparison.warning });
        if (programme.status !== "stopped" && comparison.verdict !== "no-observed-drift")
          await deliverPolicyDriftNotice(tx, org, { programmeId, runId: run.runId,
            reasons: [...(comparison.providerChanged ? ["provider-changed" as const] : []),
              ...(comparison.changedCases.length || run.failed > 0 ? ["answer-regression" as const] : []), "programme-paused"] });
      }
    }
    await writeSetting(tx, org, runKey, run);
  });
  await policyCapabilities(org, actor);
  return { run };
}

async function assertDriftAuthority(tx: any, org: string, actor: string, id: string, reviewId: string) {
  const p = await readSetting(tx, org, DRIFT_KEY) as DriftProgramme | null;
  if (!p || p.programmeId !== id || p.status !== "active" || p.actor !== actor ||
    !await recordedHumanPermissionDecisionCurrent(tx, org, p.authorityId, ["tool.policy.manage"], undefined, undefined, actor) ||
    p.reviewId !== reviewId || Date.parse(p.expiresAt) <= Date.now())
    throw new HrPolicyError("Drift consent, current policy-management permission or baseline review is no longer current.", 409);
  const currentReview = await assertReview(tx, org);
  const baseline = await readSetting(tx, org, `${RUN_PREFIX}${p.baselineRunId}`);
  if (currentReview.reviewId !== reviewId || !eligibleDriftBaseline(baseline, reviewId, p.providerIsolated))
    throw new HrPolicyError("The reviewed live baseline no longer matches this benchmark and contract.", 409);
  return p;
}

export async function configurePolicyDrift(org: string, actor: string, input: unknown, providerIsolated = false) {
  denyRetiredCaseCapability();
  const body = bodyRecord(input, ["action", "baselineRunId", "expectedProgrammeId", "confirmation"]);
  if (!["approve", "stop"].includes(String(body.action))) throw new HrPolicyError("Invalid drift programme action.");
  return db.transaction(async tx => {
    await fence(tx, org);
    const grant = await verifiedAuthority(tx, org, actor, "hr-compliance");
    const old = await readSetting(tx, org, DRIFT_KEY) as DriftProgramme | null;
    if ((old?.programmeId ?? null) !== body.expectedProgrammeId) throw new HrPolicyError("Drift consent changed; refresh.", 409);
    if (body.action === "stop") {
      if (!old) throw new HrPolicyError("There is no approved drift programme.", 409);
      const programme = { ...old, status: "stopped" as const };
      await writeSetting(tx, org, DRIFT_KEY, programme);
      await writeSetting(tx, org, `${DRIFT_KEY}:history:${randomUUID()}`, { ...programme, stoppedBy: actor, stoppedAt: new Date().toISOString() });
      return { programme };
    }
    if (body.confirmation !== DRIFT_CONFIRMATION || typeof body.baselineRunId !== "string")
      throw new HrPolicyError("Separate explicit drift budget consent and reviewed live baseline are required.", 403);
    const pending = old?.latestRunId ? await readSetting(tx, org, `${RUN_PREFIX}${old.latestRunId}`) : null;
    if (pending?.status === "running") {
      if (Date.parse(pending.createdAt) + DRIFT_RUN_WINDOW > Date.now())
        throw new HrPolicyError("An unfinished drift run must settle before replacing consent.", 409);
      await writeSetting(tx, org, `${RUN_PREFIX}${old!.latestRunId}`, { ...pending, status: "unfinished", authorizationCurrent: false });
    }
    const review = await assertReview(tx, org);
    const baseline = await readSetting(tx, org, `${RUN_PREFIX}${body.baselineRunId}`);
    if (!eligibleDriftBaseline(baseline, review.reviewId, providerIsolated)) throw new HrPolicyError("Select a completed, non-isolated current live baseline.", 409);
    if (old?.status === "active") throw new HrPolicyError("Stop the active programme before replacing its consent.", 409);
    const now = Date.now();
    const programme: DriftProgramme = {
      programmeId: randomUUID(), baselineRunId: body.baselineRunId, actor, authorityId: grant.id, reviewId: review.reviewId,
      status: "active", approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + DRIFT_DURATION).toISOString(),
      nextDueAt: new Date(now + DRIFT_INTERVAL).toISOString(), checksReserved: 0, latestRunId: null, warning: null,
      providerIsolated,
    };
    await writeSetting(tx, org, DRIFT_KEY, programme);
    await writeSetting(tx, org, `${DRIFT_KEY}:history:${programme.programmeId}`, programme);
    return { programme };
  });
}

/** Only the runtime heartbeat calls this; builds, catalog reads and publication never dispatch. */
export async function runPolicyDriftTick(testSelector?: BenchmarkSelector, isolatedOrg?: string, testCheckpoint?: DriftTestCheckpoint) {
  if (!retiredCaseCapabilitiesEnabled()) return; // Preserve pending receipts, never manufacture results.
  if (testSelector && !isolatedOrg) throw new Error("Isolated drift workers require their fixture tenant.");
  if (testCheckpoint && !testSelector) throw new Error("Drift fault injection requires fake transport.");
  const rows = await db.select().from(onbSettings).where(and(eq(onbSettings.key, DRIFT_KEY),
    isolatedOrg ? eq(onbSettings.organizationId, isolatedOrg) : undefined))
    .orderBy(onbSettings.updatedAt);
  for (const row of rows) {
    const p = JSON.parse(row.value) as DriftProgramme;
    if (p.status !== "active" || p.providerIsolated !== Boolean(testSelector)) continue;
    const org = row.organizationId;
    const ready = await db.transaction(async tx => {
      await fence(tx, org);
      const current = await readSetting(tx, org, DRIFT_KEY) as DriftProgramme;
      if (current.programmeId !== p.programmeId || current.status !== "active") return false;
      const last = current.latestRunId ? await readSetting(tx, org, `${RUN_PREFIX}${current.latestRunId}`) : null;
      if (last?.status === "running") {
        if (Date.parse(last.createdAt) + DRIFT_RUN_WINDOW > Date.now()) return false;
        await writeSetting(tx, org, `${RUN_PREFIX}${current.latestRunId}`, { ...last, status: "unfinished", authorizationCurrent: false });
        await writeSetting(tx, org, DRIFT_KEY, { ...current, status: "paused", warning: "Drift check unfinished after interruption; reservation consumed. No automatic retry." });
        await deliverPolicyDriftNotice(tx, org, { programmeId: current.programmeId, runId: current.latestRunId, reasons: ["programme-paused"] });
        return false;
      }
      if (Date.parse(current.expiresAt) <= Date.now()) {
        await writeSetting(tx, org, DRIFT_KEY, { ...current, status: "expired" }); return false;
      }
      try { await assertDriftAuthority(tx, org, p.actor, p.programmeId, p.reviewId); }
      catch {
        await writeSetting(tx, org, DRIFT_KEY, { ...current, status: "paused", warning: "Drift authorization or reviewed baseline is no longer current. No provider call made." });
        await deliverPolicyDriftNotice(tx, org, { programmeId: current.programmeId, runId: current.latestRunId, reasons: ["programme-paused"] });
        return false;
      }
      return Date.parse(current.nextDueAt) <= Date.now();
    });
    if (!ready) continue;
    try {
      await withoutHroContext(() => withHroContext({
        organizationId: org, workflow: "hr-policy", subjectType: "tenant", subjectId: org,
        initiatingUserId: p.actor, executor: { type: "system" },
      }, () => runPolicyBenchmark(org, p.actor, { benchmarkHash: benchmarkHash(), mode: "live",
        requestId: randomUUID(), confirmation: LIVE_CONFIRMATION }, testSelector, p.programmeId, testCheckpoint)));
    } catch (error) {
      // Budget contention is visible, not silently reported as stability.
      await db.transaction(async tx => {
        await fence(tx, org);
        const current = await readSetting(tx, org, DRIFT_KEY) as DriftProgramme;
        if (current.programmeId === p.programmeId && current.status === "active" && current.latestRunId === p.latestRunId) {
          await writeSetting(tx, org, DRIFT_KEY,
            { ...current, status: "paused", warning: "Drift check blocked or failed; inspect evidence and shared tenant budget before reauthorizing." });
          await deliverPolicyDriftNotice(tx, org, { programmeId: current.programmeId, runId: current.latestRunId, reasons: ["programme-paused"] });
        }
      });
    }
    break; // at most one bounded programme per shared tick
  }
}
