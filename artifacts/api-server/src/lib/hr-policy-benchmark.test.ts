import assert from "node:assert/strict";
import { test } from "node:test";
import { POLICY_BENCHMARK, benchmarkHash, benchmarkGate, benchmarkProvenance, evaluateBenchmark, LIVE_LIMITS, validateBenchmarkPairs, scoreBenchmarkPairs, type BenchmarkResult } from "./hr-policy-benchmark";
import { HrPolicyAiUnavailableError, parsePolicySelection, policySelectionRequest, sentenceForQuestion } from "./hr-policy-selection";

test("provider-free replay covers all proposed business outcomes without claiming accuracy", async () => {
  const report = await evaluateBenchmark("offline", async () => { throw new Error("Provider called in CI"); });
  assert.equal(report.failed, 0);
  assert.equal(report.calls, 0);
  assert.equal(report.outcomeAgreement, null);
  assert.equal(report.abstentionAgreement, null);
  assert.equal(report.pairedConsistency, null);
  assert.equal(report.pairedSupportAgreement, null);
  assert.equal(report.pairedAbstentionAgreement, null);
  assert.equal(report.pairedFailed, 0);
  assert.equal(report.pairs.length, 15);
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
  assert.equal(report.pairedConsistency, 1);
  assert.equal(report.pairedSupportAgreement, 1);
  assert.equal(report.pairedAbstentionAgreement, 1);
  assert.equal(report.pairedFailed, 0);
});
test("paired questions bind the same fictional source, audience, applicability, dates and answer key", () => {
  validateBenchmarkPairs();
  assert.equal(POLICY_BENCHMARK.filter(c => c.expected.modelCalled).length, LIVE_LIMITS.calls);
  assert.equal(LIVE_LIMITS.totalCompletionTokens, LIVE_LIMITS.calls * LIVE_LIMITS.completionTokensPerCall);
  const variants = POLICY_BENCHMARK.filter(c => c.pairing);
  assert.deepEqual(new Set(variants.map(c => c.pairing!.language)), new Set(["en", "es", "hi"]));
  for (const group of new Set(variants.map(c => c.pairing!.groupId))) {
    const cases = variants.filter(c => c.pairing!.groupId === group);
    assert.equal(cases.length, 4);
    for (const c of cases) {
      assert.deepEqual(c.source, cases[0].source);
      assert.deepEqual(c.expected, cases[0].expected);
      assert.equal(c.role, cases[0].role);
      assert.deepEqual(c.applicability, cases[0].applicability);
      assert.equal(c.appliesOn, cases[0].appliesOn);
    }
  }
  const c = variants.find(c => c.pairing!.variant === "translation")!;
  const oldHash = benchmarkHash();
  const original = c.appliesOn;
  try {
    c.appliesOn = "2026-10-09";
    assert.notEqual(benchmarkHash(), oldHash);
    assert.throws(validateBenchmarkPairs, /Invalid paired benchmark context/);
  } finally { c.appliesOn = original; }
});
test("a language-specific unsafe answer fails deterministic pair support and abstention checks", async () => {
  const report = await evaluateBenchmark("live", async (q, excerpt, context) => {
    const c = POLICY_BENCHMARK.find(c => c.question === q && c.source.text === context && c.expected.modelCalled)!;
    if (c.id === "paired-pay-3") return { outcome: "supported", excerptId: "extract-1", quotedText: excerpt };
    return c.expected.outcome === "supported"
      ? { outcome: "supported", excerptId: "extract-1", quotedText: excerpt }
      : { outcome: c.expected.outcome as "insufficient" | "conflicting" | "injected", excerptId: null, quotedText: null };
  }, async () => {});
  assert.equal(report.unsafeSupportCount, 1);
  assert.equal(report.pairedSupportAgreement, 1);
  assert.equal(report.pairedAbstentionAgreement, 5 / 6);
  assert.equal(report.pairedConsistency, 8 / 9);
  assert.equal(report.pairedFailed, 1);
  assert.equal(report.pairs.find(p => p.variantCaseId === "paired-pay-3")?.passed, false);
});
test("equal wrong answers and paired errors cannot masquerade as successful language assurance", async () => {
  const replay = await evaluateBenchmark("offline");
  const results: BenchmarkResult[] = replay.results.map(r => r.caseId.startsWith("paired-pay")
    ? { ...r, actual: "supported", abstained: false, quotedText: r.candidate, passed: false } : r);
  const wrongPairs = scoreBenchmarkPairs(results).filter(p => p.groupId === "paired-pay");
  assert.ok(wrongPairs.every(p => p.consistent && !p.passed));
  for (const r of results.filter(r => r.caseId.startsWith("paired-pay"))) {
    r.actual = "error"; r.abstained = true; r.quotedText = null;
  }
  assert.ok(scoreBenchmarkPairs(results).filter(p => p.groupId === "paired-pay").every(p => !p.consistent && !p.passed));
  assert.ok(scoreBenchmarkPairs(results.filter(r => r.caseId !== "paired-leave-3"))
    .some(p => p.variantCaseId === "paired-leave-3" && !p.passed && !p.consistent));
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
test("partial live runs report missing pairs as failures rather than successful abstentions", async () => {
  const previous = LIVE_LIMITS.calls;
  try {
    LIVE_LIMITS.calls = 1;
    const report = await evaluateBenchmark("live", async (_q, excerpt) =>
      ({ outcome: "supported", excerptId: "extract-1", quotedText: excerpt }), async () => {});
    assert.equal(report.calls, 1);
    assert.ok(report.results.some(r => r.errorCode === "budget_exhausted"));
    assert.equal(report.pairedConsistency, 0);
    assert.equal(report.pairedSupportAgreement, 0);
    assert.equal(report.pairedAbstentionAgreement, 0);
    assert.ok(report.pairs.filter(p => p.modelRequired).every(p => !p.consistent && !p.passed));
    assert.ok(report.pairs.filter(p => !p.modelRequired).every(p => p.passed));
  } finally { LIVE_LIMITS.calls = previous; }
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
