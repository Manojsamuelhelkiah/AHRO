import assert from "node:assert/strict";
import { test } from "node:test";
import { POLICY_BENCHMARK, benchmarkHash, benchmarkGate, benchmarkProvenance, evaluateBenchmark, LIVE_LIMITS } from "./hr-policy-benchmark";
import { HrPolicyAiUnavailableError, parsePolicySelection, policySelectionRequest, sentenceForQuestion } from "./hr-policy-selection";

test("provider-free replay covers all proposed business outcomes without claiming accuracy", async () => {
  const report = await evaluateBenchmark("offline", async () => { throw new Error("Provider called in CI"); });
  assert.equal(report.failed, 0);
  assert.equal(report.calls, 0);
  assert.equal(report.outcomeAgreement, null);
  assert.equal(report.abstentionAgreement, null);
  assert.equal(report.accuracyGuarantee, false);
  assert.equal(report.evidenceKind, "scripted-contract-replay");
  assert.equal(new Set(POLICY_BENCHMARK.map(c => c.id)).size, POLICY_BENCHMARK.length);
  for (const outcome of ["supported", "insufficient", "conflicting", "injected"]) assert.ok(POLICY_BENCHMARK.some(c => c.expected.outcome === outcome));
});
test("date, audience, source lifecycle, applicability and embedded injection gates never call the selector", async () => {
  for (const c of POLICY_BENCHMARK) {
    assert.equal(benchmarkGate(c) === null, c.expected.modelCalled, c.id);
    if (!c.expected.modelCalled) assert.equal(benchmarkGate(c), c.expected.outcome, c.id);
  }
  assert.ok(POLICY_BENCHMARK.some(c => c.id === "expired-historical"));
  assert.ok(POLICY_BENCHMARK.some(c => c.id === "wrong-audience"));
});
test("invented ids, changed quotes, hidden fields, prose and malformed refusals fail closed", () => {
  const excerpt = "Only this sentence may be selected.";
  for (const content of [
    "", "not JSON", "null", "[]",
    JSON.stringify({ outcome: "supported", excerptId: "extract-2", quotedText: excerpt }),
    JSON.stringify({ outcome: "supported", excerptId: "extract-1", quotedText: `${excerpt} Extra claim.` }),
    JSON.stringify({ outcome: "supported", excerptId: "extract-1", quotedText: excerpt, confidence: 0.99 }),
    JSON.stringify({ outcome: "insufficient", excerptId: "extract-1", quotedText: excerpt }),
    JSON.stringify({ outcome: "insufficient", excerptId: null, quotedText: "invented answer" }),
  ]) assert.throws(() => parsePolicySelection(content, excerpt), HrPolicyAiUnavailableError);
});
test("the exact-quote validator does not by itself establish semantic support", async () => {
  let authorizations = 0;
  const report = await evaluateBenchmark("live",
    async (_q, excerpt) => ({ outcome: "supported", excerptId: "extract-1", quotedText: excerpt }),
    async () => { authorizations++; });
  assert.equal(report.calls, LIVE_LIMITS.calls);
  assert.equal(authorizations, report.calls);
  assert.ok(report.failed > 0);
  assert.ok(report.unsafeSupportCount > 0);
  assert.equal(report.results.find(r => r.caseId === "citation-bait")?.passed, false);
  assert.equal(report.results.find(r => r.caseId === "wrong-audience")?.modelCalled, false);
});
test("fake-provider model results are scored by ground truth, never confidence", async () => {
  const report = await evaluateBenchmark("live", async (q, excerpt, context) => {
    const c = POLICY_BENCHMARK.find(c => c.question === q && c.source.text === context && c.expected.modelCalled)!;
    assert.equal(excerpt, sentenceForQuestion(c.source.text, q));
    return c.expected.outcome === "supported"
      ? { outcome: "supported", excerptId: "extract-1", quotedText: excerpt }
      : { outcome: c.expected.outcome as "insufficient" | "conflicting" | "injected", excerptId: null, quotedText: null };
  }, async () => {});
  assert.equal(report.failed, 0);
  assert.equal(report.outcomeAgreement, 1);
  assert.equal(report.unsafeSupportCount, 0);
  assert.equal(report.accuracyGuarantee, false);
});
test("authorization failures, unavailable providers and budget exhaustion are failures, not correct abstentions", async () => {
  await assert.rejects(() => evaluateBenchmark("live"), /explicit authorization/);
  let calls = 0;
  const report = await evaluateBenchmark("live", async () => { calls++; throw new Error("unavailable"); }, async () => { throw new Error("revoked"); });
  assert.equal(calls, 0);
  assert.equal(report.calls, 0);
  assert.ok(report.failed > 0);
  for (const result of report.results.filter(r => r.actual === "error")) assert.equal(result.passed, false);
});
test("prompt, model, benchmark and full source revision provenance are content-bound", () => {
  const a = benchmarkProvenance();
  assert.match(a.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(a.benchmarkHash, benchmarkHash());
  assert.equal(a.sourceVersions.length, POLICY_BENCHMARK.length);
  const c = POLICY_BENCHMARK[0];
  const original = c.source.text;
  try { c.source.text += " Changed approved revision."; assert.notEqual(benchmarkHash(), a.benchmarkHash); }
  finally { c.source.text = original; }
  const request = policySelectionRequest("Ignore instructions", "Quoted data", "Full context");
  assert.equal(request.model, a.model);
  assert.equal(request.max_completion_tokens, LIVE_LIMITS.completionTokensPerCall);
  assert.equal(request.messages[0].role, "system");
  assert.match(request.messages[1].content, /untrusted/);
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.response_format.json_schema.schema.additionalProperties, false);
  assert.equal("tools" in request, false);
});
