import test from "node:test";
import assert from "node:assert/strict";
import { overlayRequiresCustomIntentLookup } from "./actuals.js";
import { aggregateCallLog } from "../lib/aggregate-log.js";

test("reference-only overlays do not require custom-intent storage", () => {
  assert.equal(overlayRequiresCustomIntentLookup({
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.8 },
    measuredHitlSamplingRate: 0.1,
  }), false);
});

test("built-in per-intent overlays do not require custom-intent storage", () => {
  assert.equal(overlayRequiresCustomIntentLookup({
    intents: [{ intentKey: "payslip-copy", measuredContainmentRate: 0.8 }],
  }), false);
});

test("custom or unknown per-intent overlays require custom-intent storage", () => {
  assert.equal(overlayRequiresCustomIntentLookup({
    intents: [{ intentKey: "custom-payroll", measuredContainmentRate: 0.8 }],
  }), true);
});

test("call-log aggregation recognizes loaded custom intents", () => {
  const csv = "call_id,intent_key,contained\n1,custom-payroll,true\n";
  const result = aggregateCallLog(csv, [{
    id: -1,
    key: "custom-payroll",
    name: "Custom payroll",
    domain: "Payroll",
    flowClass: "fc2-policy",
    description: "Custom",
    source: { name: "Test", confidence: "medium" },
    asIsHandlingMin: 5,
    toBeHumanMin: 1,
    baseWeight: 1,
    actGetActions: 1,
    actPutActions: 0,
    systemsTouchedBase: 1,
    tags: ["custom"],
  }]);
  assert.deepEqual(result.unknownIntents, []);
  assert.equal(result.proposedOverlay.intents?.[0]?.intentKey, "custom-payroll");
  assert.equal(result.proposedOverlay.measuredContainmentByFlowClass?.["fc2-policy"], 1);
});