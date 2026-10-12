import assert from "node:assert/strict";
import { test } from "node:test";
import { runPolicyDriftTick, configurePolicyDrift } from "./hr-policy-evaluation";
import { comparePolicyDrift, eligibleDriftBaseline, type DriftEvidence } from "./hr-policy-drift";
import { benchmarkProvenance, LIVE_LIMITS } from "./hr-policy-benchmark";

test("scheduled calls are permanently inert, including old consent and test-selector callers", async () => {
  let calls = 0;
  const provider = async () => { calls++; throw new Error("Retired work must not dispatch."); };
  await runPolicyDriftTick(provider, "client");
  await runPolicyDriftTick();
  assert.equal(calls, 0);
  await assert.rejects(configurePolicyDrift("client", "verified-reviewer", { enabled: false }), { name: "RetiredCaseCapabilityError" });
});
test("historical receipt comparison never invents stability, authorization or complete evidence", () => {
  const p = benchmarkProvenance();
  const base: DriftEvidence = {
    runId: "historical", mode: "live", status: "passed", model: p.model,
    benchmarkHash: p.benchmarkHash, requestHash: p.requestHash, contractHash: p.contractHash,
    providerIsolated: true, authorizationCurrent: true, calls: LIVE_LIMITS.calls, failed: 0,
    review: { reviewId: "old" },
    providerReceipts: Array.from({ length: LIVE_LIMITS.calls }, (_, i) => ({
      responseId: `historical-${i}`, resolvedModel: "resolved-a", systemFingerprint: "fp-a",
      promptTokens: 100, completionTokens: 100,
    })),
    results: [],
  };
  assert.equal(comparePolicyDrift(base, base).verdict, "no-observed-drift");
  assert.equal(comparePolicyDrift(base, { ...base, providerReceipts: base.providerReceipts!.map(r => ({ ...r, resolvedModel: "resolved-b" })) }).providerChanged, true);
  assert.equal(comparePolicyDrift(base, { ...base, providerReceipts: [] }).verdict, "incomplete");
  const noFingerprints = { ...base, providerReceipts: base.providerReceipts!.map(r => ({ ...r, systemFingerprint: null })) };
  assert.equal(comparePolicyDrift(noFingerprints, noFingerprints).fingerprintCoverage, "unknown");
  assert.equal(comparePolicyDrift(base, { ...base, authorizationCurrent: false }).verdict, "incomplete");
  assert.equal(eligibleDriftBaseline(base, "old", true), false, "missing historical result coverage never becomes a valid baseline");
});
