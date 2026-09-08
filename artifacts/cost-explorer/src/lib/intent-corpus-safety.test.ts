import test from "node:test";
import assert from "node:assert/strict";
import {
  isIntentCorpusUnavailable,
  overlayRequiresCompleteCorpus,
} from "./intent-corpus-safety.js";

test("corpus stays unavailable through loading, request failure, and degraded responses", () => {
  assert.equal(isIntentCorpusUnavailable(false, undefined), true);
  assert.equal(isIntentCorpusUnavailable(true, undefined), true);
  assert.equal(isIntentCorpusUnavailable(false, false), true);
  assert.equal(isIntentCorpusUnavailable(false, true), false);
});

test("flow-class, global, and token-only calibration remains reference-safe", () => {
  assert.equal(overlayRequiresCompleteCorpus({
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.8 },
    measuredHitlSamplingRate: 0.2,
    tokenActualsByRole: { router: { avgInputTokens: 100, avgOutputTokens: 20 } },
  }), false);
});

test("per-intent calibration requires the complete corpus", () => {
  assert.equal(overlayRequiresCompleteCorpus({
    intents: [{ intentKey: "custom-payroll", measuredContainmentRate: 0.8 }],
  }, new Set(["payslip-copy"])), true);
});

test("built-in per-intent calibration remains reference-safe", () => {
  assert.equal(overlayRequiresCompleteCorpus({
    intents: [{ intentKey: "payslip-copy", measuredContainmentRate: 0.8 }],
  }, new Set(["payslip-copy"])), false);
});