import assert from "node:assert/strict";
import test from "node:test";
import { resolveSetupFlowBasis, validateSetupFlowBasis } from "./setup-flow-basis";
import { intents } from "../data/intents";

test("base definitions resolve every supported domain without an uploaded document", () => {
  const basis = resolveSetupFlowBasis(["Hire", "Pay"], []);
  assert.equal(basis.source, "product-base");
  assert.ok(Object.keys(basis.intentWeights).length > 0);
  assert.ok(Math.abs(Object.values(basis.intentWeights).reduce((sum, value) => sum + value, 0) - 1) < 1e-10);
  assert.ok(Object.keys(basis.intentWeights).every((key) => intents.some((intent) => intent.key === key && ["hire", "pay"].includes(intent.domain))));
  assert.deepEqual(basis, resolveSetupFlowBasis(["Pay", "Hire", "Hire"], []));
  validateSetupFlowBasis(basis, basis, { intentShareOverrides: basis.intentWeights });
});

test("existing scoped approved overrides change the fingerprint and retain revision references", () => {
  const key = intents.find((intent) => intent.domain === "hire")!.key;
  const override = { intentKey: key, version: 3, flowClass: null, toBeHumanMin: 42, actGetActions: null, actPutActions: null };
  const base = resolveSetupFlowBasis(["Hire"], []);
  const custom = resolveSetupFlowBasis(["Hire"], [override]);
  assert.equal(custom.source, "product-base-with-overrides");
  assert.deepEqual(custom.overrideRefs, [`${key}:v3`]);
  assert.notEqual(custom.fingerprint, base.fingerprint);
  assert.throws(() => validateSetupFlowBasis(base, custom, { intentShareOverrides: base.intentWeights }), /changed/);
  assert.throws(() => validateSetupFlowBasis(custom, custom, { intentShareOverrides: {} }), /scope/);
  assert.throws(() => validateSetupFlowBasis({ ...custom, source: "product-base" }, custom, { intentShareOverrides: custom.intentWeights }), /changed/);
});

test("missing selected base definitions and unknown domains fail with actionable errors", () => {
  assert.throws(() => resolveSetupFlowBasis(["Hire"], [], intents.filter((intent) => intent.domain !== "hire")), /Hire.*unavailable/);
  assert.throws(() => resolveSetupFlowBasis(["Unknown"], []), /supported/);
  assert.throws(() => resolveSetupFlowBasis([], []), /supported/);
});
