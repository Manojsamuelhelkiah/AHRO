import test from "node:test";
import assert from "node:assert/strict";
import {
  toApiInputs,
  fromApiInputs,
  OVERRIDABLE_ASSUMPTION_KEYS,
} from "./scenario-mapper.js";

// ---------------------------------------------------------------------------
// Shared base values
// ---------------------------------------------------------------------------

const BASE = {
  numSystems: 4,
  annualTransactions: 120_000,
  employees: 8_000,
  sector: "manufacturing",
  companyType: "multi-country",
  isolationTier: "siloed",
  hrHourlyCostUsd: 38,
  hitlHourlyCostUsd: 42,
  countries: 6,
  _assumptionOverrides: {} as Record<string, number | "">,
};

// ---------------------------------------------------------------------------
// toApiInputs — stale-override stripping (the regression)
// ---------------------------------------------------------------------------

test("toApiInputs: stale assumptionOverrides stripped when _assumptionOverrides is empty", () => {
  const values = {
    ...BASE,
    // Stale field that ended up in form values when a saved scenario was loaded
    assumptionOverrides: { "llm-call-cost": 0.099 },
    _assumptionOverrides: {}, // user clicked "Reset all"
  };
  const result = toApiInputs(values);
  assert.ok(
    !("assumptionOverrides" in result),
    "stale assumptionOverrides must not appear in output after reset",
  );
});

test("toApiInputs: stale assumptionOverrides replaced by fresh _assumptionOverrides", () => {
  const values = {
    ...BASE,
    assumptionOverrides: { "llm-call-cost": 0.099 }, // stale
    _assumptionOverrides: { "slm-call-cost": 0.001 as number | "" },
  };
  const result = toApiInputs(values);
  assert.ok("assumptionOverrides" in result, "rebuilt overrides must appear in output");
  assert.deepEqual(result.assumptionOverrides, { "slm-call-cost": 0.001 });
  assert.ok(
    !(result.assumptionOverrides as any)?.["llm-call-cost"],
    "stale key must not appear in rebuilt overrides",
  );
});

test("toApiInputs: empty-string override entries are omitted from payload", () => {
  const values = {
    ...BASE,
    _assumptionOverrides: {
      "slm-call-cost": "" as number | "",
      "llm-call-cost": 0.005 as number | "",
    },
  };
  const result = toApiInputs(values);
  assert.deepEqual(result.assumptionOverrides, { "llm-call-cost": 0.005 });
});

test("toApiInputs: no assumptionOverrides key in output when all entries are empty", () => {
  const allEmpty = Object.fromEntries(
    OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [k, "" as number | ""]),
  );
  const result = toApiInputs({ ...BASE, _assumptionOverrides: allEmpty });
  assert.ok(!("assumptionOverrides" in result));
});

// ---------------------------------------------------------------------------
// toApiInputs — containment mapping
// ---------------------------------------------------------------------------

test("toApiInputs: containmentFc fields are mapped to containmentOverrides", () => {
  const values = { ...BASE, containmentFc1: 0.9, containmentFc3: 0.7 };
  const result = toApiInputs(values);
  assert.deepEqual(result.containmentOverrides, {
    "fc1-deterministic": 0.9,
    "fc3-multiagent": 0.7,
  });
  assert.ok(!("containmentFc1" in result), "flat form key must not leak into output");
  assert.ok(!("containmentFc3" in result));
});

test("toApiInputs: no containmentOverrides key when no containment fields set", () => {
  const result = toApiInputs(BASE);
  assert.ok(!("containmentOverrides" in result));
});

// ---------------------------------------------------------------------------
// fromApiInputs — stale-field isolation (the companion regression)
// ---------------------------------------------------------------------------

test("fromApiInputs: assumptionOverrides not spread as top-level form field", () => {
  const apiInputs = {
    ...BASE,
    assumptionOverrides: { "llm-call-cost": 0.005 },
  };
  const form = fromApiInputs(apiInputs);
  assert.ok(
    !("assumptionOverrides" in form),
    "assumptionOverrides must not appear as a raw top-level form key",
  );
  assert.equal(
    (form._assumptionOverrides as any)?.["llm-call-cost"],
    0.005,
    "override must be accessible via _assumptionOverrides",
  );
});

test("fromApiInputs: containmentOverrides not spread as top-level form field", () => {
  const apiInputs = {
    ...BASE,
    containmentOverrides: { "fc1-deterministic": 0.9, "fc4-frontier": 0.6 },
  };
  const form = fromApiInputs(apiInputs);
  assert.ok(!("containmentOverrides" in form));
  assert.equal(form.containmentFc1, 0.9);
  assert.equal(form.containmentFc4, 0.6);
});

// ---------------------------------------------------------------------------
// Round-trip regression: load → reset → toApiInputs
// ---------------------------------------------------------------------------

test("round-trip: load scenario with overrides, reset all, payload has no assumptionOverrides", () => {
  // Step 1 — simulate loading a saved scenario that had overrides
  const saved = {
    numSystems: 4,
    annualTransactions: 120_000,
    employees: 8_000,
    sector: "manufacturing",
    companyType: "multi-country",
    isolationTier: "siloed",
    hrHourlyCostUsd: 38,
    hitlHourlyCostUsd: 42,
    countries: 6,
    assumptionOverrides: { "llm-call-cost": 0.005, "slm-call-cost": 0.001 },
  };
  const formValues = fromApiInputs(saved);

  // fromApiInputs must never produce a top-level assumptionOverrides key
  assert.ok(!("assumptionOverrides" in formValues));

  // Step 2 — simulate handleResetOverrides clearing _assumptionOverrides
  const cleared = Object.fromEntries(
    OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [k, "" as number | ""]),
  );
  const afterReset = { ...formValues, _assumptionOverrides: cleared };

  // Step 3 — toApiInputs for recompute/save
  const payload = toApiInputs(afterReset);
  assert.ok(
    !("assumptionOverrides" in payload),
    "after reset, payload must carry no assumptionOverrides",
  );
});

test("round-trip: load scenario with overrides, change one, payload reflects only new override", () => {
  const saved = {
    numSystems: 4,
    annualTransactions: 120_000,
    employees: 8_000,
    sector: "manufacturing",
    companyType: "multi-country",
    isolationTier: "siloed",
    hrHourlyCostUsd: 38,
    hitlHourlyCostUsd: 42,
    countries: 6,
    assumptionOverrides: { "llm-call-cost": 0.005, "slm-call-cost": 0.001 },
  };
  const formValues = fromApiInputs(saved);

  // User edits only slm-call-cost, clears llm-call-cost
  const edited = {
    ...formValues,
    _assumptionOverrides: {
      ...((formValues._assumptionOverrides as any) ?? {}),
      "llm-call-cost": "" as number | "",
      "slm-call-cost": 0.002 as number | "",
    },
  };

  const payload = toApiInputs(edited);
  assert.deepEqual(payload.assumptionOverrides, { "slm-call-cost": 0.002 });
});
