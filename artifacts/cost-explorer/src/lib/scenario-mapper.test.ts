/**
 * Tests for scenario-mapper.ts support exports only.
 * The canonical mapper pair (toApiInputs / fromApiInputs) is tested in
 * scenario-form.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssumptionOverrides,
  OVERRIDABLE_ASSUMPTION_KEYS,
} from "./scenario-mapper.js";

// ---------------------------------------------------------------------------
// buildAssumptionOverrides
// ---------------------------------------------------------------------------

test("buildAssumptionOverrides: returns undefined for undefined input", () => {
  assert.equal(buildAssumptionOverrides(undefined), undefined);
});

test("buildAssumptionOverrides: returns undefined when all entries are empty strings", () => {
  const raw = Object.fromEntries(
    OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [k, "" as number | ""]),
  );
  assert.equal(buildAssumptionOverrides(raw), undefined);
});

test("buildAssumptionOverrides: strips empty-string entries, keeps numeric values", () => {
  const result = buildAssumptionOverrides({
    "slm-call-cost": "" as number | "",
    "llm-call-cost": 0.005 as number | "",
  });
  assert.deepEqual(result, { "llm-call-cost": 0.005 });
});

test("buildAssumptionOverrides: returns undefined when all values are empty after filtering", () => {
  const result = buildAssumptionOverrides({ "slm-call-cost": "" as number | "" });
  assert.equal(result, undefined);
});

test("buildAssumptionOverrides: coerces number strings to numbers", () => {
  // Number() cast is applied — passing 0.001 as a number should survive.
  const result = buildAssumptionOverrides({ "frontier-call-cost": 0.001 as number | "" });
  assert.deepEqual(result, { "frontier-call-cost": 0.001 });
});

test("buildAssumptionOverrides: multiple valid entries all preserved", () => {
  const result = buildAssumptionOverrides({
    "slm-call-cost":      0.002 as number | "",
    "llm-call-cost":      0.008 as number | "",
    "frontier-call-cost": 0.05  as number | "",
  });
  assert.deepEqual(result, {
    "slm-call-cost":      0.002,
    "llm-call-cost":      0.008,
    "frontier-call-cost": 0.05,
  });
});

// ---------------------------------------------------------------------------
// OVERRIDABLE_ASSUMPTION_KEYS registry
// ---------------------------------------------------------------------------

test("OVERRIDABLE_ASSUMPTION_KEYS: contains no duplicate entries", () => {
  const seen = new Set<string>();
  for (const k of OVERRIDABLE_ASSUMPTION_KEYS) {
    assert.ok(!seen.has(k), `Duplicate key: ${k}`);
    seen.add(k);
  }
});

test("OVERRIDABLE_ASSUMPTION_KEYS: contains expected call-cost keys", () => {
  assert.ok(OVERRIDABLE_ASSUMPTION_KEYS.includes("slm-call-cost"));
  assert.ok(OVERRIDABLE_ASSUMPTION_KEYS.includes("llm-call-cost"));
  assert.ok(OVERRIDABLE_ASSUMPTION_KEYS.includes("frontier-call-cost"));
});
