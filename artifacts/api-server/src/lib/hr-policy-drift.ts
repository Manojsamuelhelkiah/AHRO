import { benchmarkProvenance, LIVE_LIMITS, type BenchmarkResult } from "./hr-policy-benchmark";
import type { PolicyProviderReceipt } from "./hr-policy-ai";

export const DRIFT_KEY = "policy-evaluation:drift";
export const DRIFT_CONFIRMATION = "I reviewed this real-model baseline and authorize up to three daily synthetic drift checks for seven days within the shared tenant budget.";
export const DRIFT_INTERVAL = 24 * 60 * 60 * 1000;
export const DRIFT_DURATION = 7 * DRIFT_INTERVAL;
export const DRIFT_MAX_CHECKS = 3;
export const DRIFT_RUN_WINDOW = LIVE_LIMITS.milliseconds + 30_000;
export interface DriftProgramme {
  programmeId: string; baselineRunId: string; actor: string; authorityId: number; reviewId: string;
  status: "active" | "paused" | "stopped" | "expired" | "exhausted";
  approvedAt: string; expiresAt: string; nextDueAt: string; checksReserved: number;
  latestRunId: string | null; warning: string | null;
  providerIsolated: boolean;
}
export interface DriftEvidence {
  runId: string; mode: string; status: string; model?: string;
  benchmarkHash: string; requestHash?: string; contractHash?: string;
  providerIsolated?: boolean; authorizationCurrent?: boolean; calls?: number; failed?: number;
  review?: { reviewId: string };
  providerReceipts?: PolicyProviderReceipt[]; results?: BenchmarkResult[];
}
export function eligibleDriftBaseline(run: DriftEvidence | null, reviewId: string, isolated = false): boolean {
  const p = benchmarkProvenance();
  return Boolean(run && run.mode === "live" && run.status === "passed" && run.failed === 0 &&
    run.providerIsolated === isolated && run.authorizationCurrent === true &&
    run.model === p.model && run.benchmarkHash === p.benchmarkHash &&
    run.requestHash === p.requestHash && run.contractHash === p.contractHash && run.review?.reviewId === reviewId &&
    run.calls === LIVE_LIMITS.calls && run.providerReceipts?.length === run.calls &&
    run.providerReceipts.every(r => Boolean(r.responseId && r.resolvedModel)) &&
    run.results?.length === p.sourceVersions.length && run.results.every(r => r.passed));
}
/** Compare actual observations, not only scores. Missing fingerprints are unknown, not stability proof. */
export function comparePolicyDrift(baseline: DriftEvidence, fresh: DriftEvidence) {
  const identities = (run: DriftEvidence) => [...new Set(run.providerReceipts?.map(r =>
    JSON.stringify([r.resolvedModel, r.systemFingerprint])) ?? [])].sort();
  const oldIdentity = identities(baseline), newIdentity = identities(fresh);
  const receiptComplete = fresh.calls === LIVE_LIMITS.calls && fresh.providerReceipts?.length === fresh.calls &&
    fresh.providerReceipts.every(r => Boolean(r.responseId && r.resolvedModel));
  const providerChanged = JSON.stringify(oldIdentity) !== JSON.stringify(newIdentity);
  const changedCases = (fresh.results ?? []).filter(r => {
    const old = baseline.results?.find(b => b.caseId === r.caseId);
    return !old || old.actual !== r.actual || old.abstained !== r.abstained || old.quotedText !== r.quotedText;
  }).map(r => r.caseId);
  const incomplete = !receiptComplete || !fresh.authorizationCurrent ||
    fresh.results?.length !== baseline.results?.length || fresh.results?.some(r => r.actual === "error" || r.actual === "not-run");
  const failed = fresh.failed !== 0 || fresh.status !== "passed";
  return {
    baselineRunId: baseline.runId, requestedModel: fresh.model,
    providerChanged, changedCases, oldIdentity, newIdentity,
    fingerprintCoverage: fresh.providerReceipts?.every(r => r.systemFingerprint != null) ? "reported" : "unknown",
    verdict: incomplete ? "incomplete" : providerChanged || changedCases.length || failed ? "review-required" : "no-observed-drift",
    warning: incomplete ? "Drift check failed or unfinished; provider stability is unknown."
      : providerChanged ? "Provider identity changed behind the unchanged requested model. Review fresh synthetic results."
      : changedCases.length || failed ? "Synthetic answers changed or failed the reviewed key. Reviewer investigation is required."
      : null,
  };
}
