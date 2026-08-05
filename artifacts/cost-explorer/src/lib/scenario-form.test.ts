/**
 * Comprehensive round-trip tests for scenario-form.ts — the canonical
 * toApiInputs / fromApiInputs pair used by scenario.tsx.
 *
 * Each test simulates the full user-visible flow:
 *   1. A stored ScenarioInputs arrives from the API (GET /scenarios/:id).
 *   2. fromApiInputs converts it to FormValues.
 *   3. The user triggers a recompute or save.
 *   4. toApiInputs converts FormValues back to a ScenarioInputs payload.
 *
 * The tests assert that no data is silently lost in either direction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fromApiInputs, toApiInputs } from "./scenario-form.js";
import { OVERRIDABLE_ASSUMPTION_KEYS } from "./scenario-mapper.js";
import type { ScenarioInputs } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Shared base (required fields only — typed as ScenarioInputs)
// ---------------------------------------------------------------------------

const BASE: ScenarioInputs = {
  numSystems:         4,
  annualTransactions: 120_000,
  employees:          8_000,
  sector:             "manufacturing",
  companyType:        "multi-country",
  isolationTier:      "siloed",
  hrHourlyCostUsd:    38,
  hitlHourlyCostUsd:  42,
  countries:          6,
};

/** Cast an extended object to ScenarioInputs for fromApiInputs tests. */
const asInputs = (x: object) => x as unknown as ScenarioInputs;

// ---------------------------------------------------------------------------
// toApiInputs — assumption-override stripping (regression guard)
// ---------------------------------------------------------------------------

test("toApiInputs: stale assumptionOverrides stripped when _assumptionOverrides is empty", () => {
  const form = fromApiInputs(asInputs({ ...BASE, assumptionOverrides: { "llm-call-cost": 0.099 } }));
  // Simulate user clicking "Reset all" — every key cleared to ""
  const cleared = Object.fromEntries(
    OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [k, "" as number | ""]),
  );
  const result = toApiInputs({ ...form, _assumptionOverrides: cleared });
  assert.ok(!("assumptionOverrides" in result), "stale assumptionOverrides must not appear after reset");
});

test("toApiInputs: stale assumptionOverrides replaced by fresh _assumptionOverrides", () => {
  const form = fromApiInputs(asInputs({ ...BASE, assumptionOverrides: { "llm-call-cost": 0.099 } }));
  const result = toApiInputs({
    ...form,
    _assumptionOverrides: { "slm-call-cost": 0.001 as number | "" },
  });
  assert.ok("assumptionOverrides" in result);
  assert.deepEqual(result.assumptionOverrides, { "slm-call-cost": 0.001 });
  assert.ok(!(result.assumptionOverrides as Record<string, number>)?.["llm-call-cost"],
    "stale key must not appear in rebuilt overrides");
});

test("toApiInputs: empty-string override entries are omitted from payload", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({
    ...form,
    _assumptionOverrides: {
      "slm-call-cost": "" as number | "",
      "llm-call-cost": 0.005 as number | "",
    },
  });
  assert.deepEqual(result.assumptionOverrides, { "llm-call-cost": 0.005 });
});

test("toApiInputs: no assumptionOverrides key in output when all entries are empty", () => {
  const form = fromApiInputs(BASE);
  const allEmpty = Object.fromEntries(
    OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [k, "" as number | ""]),
  );
  const result = toApiInputs({ ...form, _assumptionOverrides: allEmpty });
  assert.ok(!("assumptionOverrides" in result));
});

// ---------------------------------------------------------------------------
// toApiInputs — containmentRates (per-FC precision, task #23)
// ---------------------------------------------------------------------------

test("toApiInputs: containmentRates passed through when non-empty", () => {
  const form = fromApiInputs(BASE);
  const rates = { "fc1-deterministic": 0.92, "fc2-policy": 0.85 };
  const result = toApiInputs({ ...form, containmentRates: rates });
  assert.deepEqual(result.containmentRates, rates);
});

test("toApiInputs: containmentRates with undefined entries compacted (undefined entries dropped)", () => {
  const form = fromApiInputs(BASE);
  // A record with an undefined value should be compacted to only defined entries
  const rates = { "fc1-deterministic": 0.92, "fc2-policy": undefined } as Record<string, number | undefined>;
  const result = toApiInputs({ ...form, containmentRates: rates as Record<string, number> });
  // fc2-policy was undefined — compactFcRecord must drop it
  assert.ok(!result.containmentRates || result.containmentRates["fc2-policy"] === undefined);
});

test("toApiInputs: containmentRates omitted when not set", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, containmentRates: undefined });
  assert.ok(!result.containmentRates || Object.keys(result.containmentRates).length === 0
    || result.containmentRates === undefined,
    "containmentRates must be absent or empty when not supplied");
});

// ---------------------------------------------------------------------------
// toApiInputs — adoptionRamp (task #23)
// ---------------------------------------------------------------------------

test("toApiInputs: adoptionRampY1/Y2/Y3 collapsed to adoptionRamp tuple", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, adoptionRampY1: 0.4, adoptionRampY2: 0.75, adoptionRampY3: 1.0 });
  assert.deepEqual((result as unknown as Record<string, unknown>).adoptionRamp, [0.4, 0.75, 1.0]);
  assert.ok(!("adoptionRampY1" in result), "exploded fields must not leak into payload");
  assert.ok(!("adoptionRampY2" in result));
  assert.ok(!("adoptionRampY3" in result));
});

test("toApiInputs: adoptionRamp omitted when any of Y1/Y2/Y3 is missing", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, adoptionRampY1: 0.4, adoptionRampY2: 0.75 });
  const raw = result as unknown as Record<string, unknown>;
  assert.ok(!("adoptionRamp" in raw), "partial ramp must not produce adoptionRamp");
});

test("toApiInputs: legacy adoptionRate scalar passed through when ramp absent", () => {
  const form = fromApiInputs(asInputs({ ...BASE, adoptionRate: 0.6 }));
  const result = toApiInputs({ ...form });
  const raw = result as unknown as Record<string, unknown>;
  assert.equal(raw.adoptionRate, 0.6);
  assert.ok(!("adoptionRamp" in raw));
});

// ---------------------------------------------------------------------------
// toApiInputs — hitlSamplingRates (task #23)
// ---------------------------------------------------------------------------

test("toApiInputs: hitlSamplingRates passed through when non-empty", () => {
  const form = fromApiInputs(BASE);
  const rates = { "fc1-deterministic": 0.05, "fc3-multiagent": 0.3 };
  const result = toApiInputs({ ...form, hitlSamplingRates: rates });
  assert.deepEqual(result.hitlSamplingRates, rates);
});

test("toApiInputs: hitlSamplingRates omitted when not set", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, hitlSamplingRates: undefined });
  assert.ok(
    !result.hitlSamplingRates || Object.keys(result.hitlSamplingRates).length === 0,
    "hitlSamplingRates must be absent when not supplied",
  );
});

test("toApiInputs: legacy hitlSamplingRate scalar passed through when per-FC rates absent", () => {
  const form = fromApiInputs(asInputs({ ...BASE, hitlSamplingRate: 0.25 }));
  const result = toApiInputs({ ...form, hitlSamplingRates: undefined });
  const raw = result as unknown as Record<string, unknown>;
  assert.equal(raw.hitlSamplingRate, 0.25);
  assert.ok(!result.hitlSamplingRates || Object.keys(result.hitlSamplingRates).length === 0);
});

// ---------------------------------------------------------------------------
// toApiInputs — modelSelection (task #23)
// ---------------------------------------------------------------------------

test("toApiInputs: model selection fields collapsed to modelSelection record", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, modelRouter: "gemini-flash", modelReasoning: "claude-sonnet" });
  assert.deepEqual(result.modelSelection, { router: "gemini-flash", reasoning: "claude-sonnet" });
  assert.ok(!("modelRouter"    in result), "flat model fields must not leak into payload");
  assert.ok(!("modelReasoning" in result));
});

test("toApiInputs: modelSelection omitted when no model fields set", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form });
  assert.ok(!result.modelSelection || Object.keys(result.modelSelection).length === 0);
});

test("toApiInputs: all four model roles collapsed correctly", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({
    ...form,
    modelRouter:    "gpt-4o-mini",
    modelReasoning: "o1",
    modelFrontier:  "claude-opus",
    modelData:      "gemini-pro",
  });
  assert.deepEqual(result.modelSelection, {
    router:    "gpt-4o-mini",
    reasoning: "o1",
    frontier:  "claude-opus",
    data:      "gemini-pro",
  });
});

// ---------------------------------------------------------------------------
// toApiInputs — nonIntegratedSystems (task #23)
// ---------------------------------------------------------------------------

test("toApiInputs: nonIntegratedSystems passed through when non-empty", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, nonIntegratedSystems: ["sap-hcm", "workday"] });
  assert.deepEqual(result.nonIntegratedSystems, ["sap-hcm", "workday"]);
});

test("toApiInputs: nonIntegratedSystems omitted when empty array", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, nonIntegratedSystems: [] });
  assert.ok(
    !result.nonIntegratedSystems || result.nonIntegratedSystems.length === 0,
    "empty nonIntegratedSystems must be omitted",
  );
});

// ---------------------------------------------------------------------------
// toApiInputs — delivery & seasonality scalar fields
// ---------------------------------------------------------------------------

test("toApiInputs: landscapeMaturity included when set", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, landscapeMaturity: "legacy" });
  assert.equal(result.landscapeMaturity, "legacy");
});

test("toApiInputs: contractYears included when set", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, contractYears: 3 });
  assert.equal(result.contractYears, 3);
});

test("toApiInputs: peakLoadFactor included when set", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, peakLoadFactor: 1.2 });
  assert.equal(result.peakLoadFactor, 1.2);
});

test("toApiInputs: reworkRatePct included when set", () => {
  const form = fromApiInputs(BASE);
  const result = toApiInputs({ ...form, reworkRatePct: 5 });
  assert.equal(result.reworkRatePct, 5);
});

// ---------------------------------------------------------------------------
// fromApiInputs — stale-field isolation (regression guard)
// ---------------------------------------------------------------------------

test("fromApiInputs: assumptionOverrides not spread as top-level form field", () => {
  const form = fromApiInputs(asInputs({ ...BASE, assumptionOverrides: { "llm-call-cost": 0.005 } }));
  assert.ok(!("assumptionOverrides" in form), "assumptionOverrides must not appear as raw top-level form key");
  assert.equal((form._assumptionOverrides as Record<string, unknown>)?.["llm-call-cost"], 0.005);
});

test("fromApiInputs: legacy containmentOverrides merged into containmentRates (not spread)", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    containmentOverrides: { "fc1-deterministic": 0.9, "fc4-frontier": 0.6 },
  }));
  assert.ok(!("containmentOverrides" in form), "containmentOverrides must not appear as a raw form key");
  // Legacy field is merged into containmentRates
  assert.deepEqual(form.containmentRates?.["fc1-deterministic"], 0.9);
  assert.deepEqual(form.containmentRates?.["fc4-frontier"], 0.6);
});

// ---------------------------------------------------------------------------
// fromApiInputs — per-FC precision fields (task #23)
// ---------------------------------------------------------------------------

test("fromApiInputs: adoptionRamp array exploded to per-year form fields", () => {
  const form = fromApiInputs(asInputs({ ...BASE, adoptionRamp: [0.4, 0.75, 1.0] }));
  assert.equal(form.adoptionRampY1, 0.4);
  assert.equal(form.adoptionRampY2, 0.75);
  assert.equal(form.adoptionRampY3, 1.0);
  assert.ok(!("adoptionRamp" in form), "adoptionRamp array must not appear in form output");
});

test("fromApiInputs: modelSelection record exploded to per-role form fields", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    modelSelection: { router: "gemini-flash", reasoning: "claude-sonnet", frontier: "gpt-5-pro" },
  }));
  assert.equal(form.modelRouter,    "gemini-flash");
  assert.equal(form.modelReasoning, "claude-sonnet");
  assert.equal(form.modelFrontier,  "gpt-5-pro");
  assert.equal(form.modelData,      undefined);
  assert.ok(!("modelSelection" in form), "modelSelection must not appear as raw form key");
});

test("fromApiInputs: containmentRates passes through as form field", () => {
  const rates = { "fc1-deterministic": 0.93, "fc2-policy": 0.87 };
  const form = fromApiInputs(asInputs({ ...BASE, containmentRates: rates }));
  assert.deepEqual(form.containmentRates, rates);
});

test("fromApiInputs: hitlSamplingRates passes through as form field", () => {
  const rates = { "fc1-deterministic": 0.05, "fc4-frontier": 0.6 };
  const form = fromApiInputs(asInputs({ ...BASE, hitlSamplingRates: rates }));
  assert.deepEqual(form.hitlSamplingRates, rates);
});

test("fromApiInputs: nonIntegratedSystems passes through as form field", () => {
  const form = fromApiInputs(asInputs({ ...BASE, nonIntegratedSystems: ["sap-hcm"] }));
  assert.ok(Array.isArray(form.nonIntegratedSystems));
  assert.ok(form.nonIntegratedSystems!.includes("sap-hcm"));
});

// ---------------------------------------------------------------------------
// fromApiInputs — legacy scalar backward-compat
// ---------------------------------------------------------------------------

test("legacy: adoptionRate scalar survives load → save when no ramp is stored", () => {
  const form = fromApiInputs(asInputs({ ...BASE, adoptionRate: 0.80 }));
  assert.equal(form.adoptionRate, 0.80);
  assert.equal(form.adoptionRampY1, undefined, "ramp fields must be absent for a pure-scalar save");
  const payload = toApiInputs(form);
  assert.equal((payload as unknown as Record<string, unknown>).adoptionRate, 0.80);
  assert.ok(!("adoptionRamp" in (payload as unknown as Record<string, unknown>)));
});

test("legacy: hitlSamplingRate scalar survives load → save when no per-FC rates stored", () => {
  const form = fromApiInputs(asInputs({ ...BASE, hitlSamplingRate: 0.35 }));
  assert.equal(form.hitlSamplingRate, 0.35);
  assert.equal(form.hitlSamplingRates, undefined);
  const payload = toApiInputs(form);
  assert.equal((payload as unknown as Record<string, unknown>).hitlSamplingRate, 0.35);
  assert.ok(!payload.hitlSamplingRates || Object.keys(payload.hitlSamplingRates).length === 0);
});

test("legacy: containmentOverrides (old field name) merged into containmentRates on load", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    containmentOverrides: { "fc1-deterministic": 0.90, "fc2-policy": 0.85 },
  }));
  assert.deepEqual(form.containmentRates, { "fc1-deterministic": 0.90, "fc2-policy": 0.85 });
  const payload = toApiInputs(form);
  assert.deepEqual(payload.containmentRates, { "fc1-deterministic": 0.90, "fc2-policy": 0.85 });
});

test("legacy: current containmentRates take priority over containmentOverrides on merge", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    containmentRates:    { "fc1-deterministic": 0.92 },
    containmentOverrides: { "fc1-deterministic": 0.88, "fc3-multiagent": 0.70 },
  }));
  assert.equal(form.containmentRates?.["fc1-deterministic"], 0.92, "current value must win");
  assert.equal(form.containmentRates?.["fc3-multiagent"], 0.70, "legacy gap must be filled");
});

// ---------------------------------------------------------------------------
// Round-trip regression: load → edit → toApiInputs
// ---------------------------------------------------------------------------

test("round-trip: load scenario with overrides, reset all, payload has no assumptionOverrides", () => {
  const saved = asInputs({
    ...BASE,
    assumptionOverrides: { "llm-call-cost": 0.005, "slm-call-cost": 0.001 },
  });
  const form = fromApiInputs(saved);
  assert.ok(!("assumptionOverrides" in form));

  const cleared = Object.fromEntries(
    OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [k, "" as number | ""]),
  );
  const payload = toApiInputs({ ...form, _assumptionOverrides: cleared });
  assert.ok(!("assumptionOverrides" in payload), "after reset, payload must carry no assumptionOverrides");
});

test("round-trip: load scenario with overrides, change one, payload reflects only new override", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    assumptionOverrides: { "llm-call-cost": 0.005, "slm-call-cost": 0.001 },
  }));
  const edited = {
    ...form,
    _assumptionOverrides: {
      ...((form._assumptionOverrides as Record<string, number | "">) ?? {}),
      "llm-call-cost": "" as number | "",
      "slm-call-cost": 0.002 as number | "",
    },
  };
  const payload = toApiInputs(edited);
  assert.deepEqual(payload.assumptionOverrides, { "slm-call-cost": 0.002 });
});

test("round-trip: load scenario with overrides, recompute, payload preserves overrides", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    assumptionOverrides: { "llm-call-cost": 0.005, "slm-call-cost": 0.001 },
  }));
  assert.ok(!("assumptionOverrides" in form), "assumptionOverrides must not be a raw form key");
  assert.equal((form._assumptionOverrides as Record<string, unknown>)?.["llm-call-cost"], 0.005);
  assert.equal((form._assumptionOverrides as Record<string, unknown>)?.["slm-call-cost"], 0.001);
  const payload = toApiInputs(form);
  assert.deepEqual(payload.assumptionOverrides, { "llm-call-cost": 0.005, "slm-call-cost": 0.001 });
});

test("round-trip: load scenario with overrides, clear one, payload reflects only remaining", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    assumptionOverrides: { "llm-call-cost": 0.005, "slm-call-cost": 0.001 },
  }));
  const edited = {
    ...form,
    _assumptionOverrides: {
      ...(form._assumptionOverrides as Record<string, number | "">),
      "llm-call-cost": "" as "",
    },
  };
  const payload = toApiInputs(edited);
  assert.deepEqual(payload.assumptionOverrides, { "slm-call-cost": 0.001 });
});

test("round-trip: containmentRates survive load → save", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    containmentRates: { "fc1-deterministic": 0.92, "fc3-multiagent": 0.75 },
  }));
  assert.deepEqual(form.containmentRates, { "fc1-deterministic": 0.92, "fc3-multiagent": 0.75 });
  const payload = toApiInputs(form);
  assert.deepEqual(payload.containmentRates, { "fc1-deterministic": 0.92, "fc3-multiagent": 0.75 });
});

test("round-trip: adoptionRamp survives load → save", () => {
  const form = fromApiInputs(asInputs({ ...BASE, adoptionRamp: [0.30, 0.60, 1.00] }));
  assert.equal(form.adoptionRampY1, 0.30);
  assert.equal(form.adoptionRampY2, 0.60);
  assert.equal(form.adoptionRampY3, 1.00);
  const payload = toApiInputs(form);
  assert.deepEqual((payload as unknown as Record<string, unknown>).adoptionRamp, [0.30, 0.60, 1.00]);
});

test("round-trip: hitlSamplingRates survive load → save", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    hitlSamplingRates: { "fc2-policy": 0.20, "fc4-frontier": 0.55 },
  }));
  assert.deepEqual(form.hitlSamplingRates, { "fc2-policy": 0.20, "fc4-frontier": 0.55 });
  const payload = toApiInputs(form);
  assert.deepEqual(payload.hitlSamplingRates, { "fc2-policy": 0.20, "fc4-frontier": 0.55 });
});

test("round-trip: nonIntegratedSystems survive load → save", () => {
  const form = fromApiInputs(asInputs({ ...BASE, nonIntegratedSystems: ["sap-hcm", "workday"] }));
  const payload = toApiInputs(form);
  assert.deepEqual(payload.nonIntegratedSystems, ["sap-hcm", "workday"]);
});

test("round-trip: modelSelection survive load → save", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    modelSelection: { router: "gemini-flash", reasoning: "claude-sonnet" },
  }));
  const payload = toApiInputs(form);
  assert.deepEqual(payload.modelSelection, { router: "gemini-flash", reasoning: "claude-sonnet" });
});

test("round-trip: delivery fields survive load → save", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    landscapeMaturity: "legacy",
    contractYears:     3,
    peakLoadFactor:    1.2,
    reworkRatePct:     5,
  }));
  const payload = toApiInputs(form);
  assert.equal(payload.landscapeMaturity, "legacy");
  assert.equal(payload.contractYears,    3);
  assert.equal(payload.peakLoadFactor,   1.2);
  assert.equal(payload.reworkRatePct,    5);
});

test("round-trip: full scenario — all task-#23 fields + overrides preserved", () => {
  const saved = asInputs({
    ...BASE,
    assumptionOverrides:  { "slm-call-cost": 0.001, "infra-per-txn": 0.00005 },
    adoptionRamp:         [0.40, 0.75, 1.00],
    containmentRates:     { "fc1-deterministic": 0.95, "fc2-policy": 0.88 },
    hitlSamplingRates:    { "fc3-multiagent": 0.30 },
    modelSelection:       { router: "gpt-4o-mini", reasoning: "o1" },
    nonIntegratedSystems: ["legacy-hrms"],
    landscapeMaturity:    "mixed",
    contractYears:        3,
  });

  const form    = fromApiInputs(saved);
  const payload = toApiInputs(form);
  const raw     = payload as unknown as Record<string, unknown>;

  // No API composite keys leak into form
  assert.ok(!("assumptionOverrides" in form));
  assert.ok(!("adoptionRamp"        in form));
  assert.ok(!("modelSelection"      in form));

  // All fields survive the round-trip
  assert.deepEqual(payload.assumptionOverrides,  { "slm-call-cost": 0.001, "infra-per-txn": 0.00005 });
  assert.deepEqual(raw.adoptionRamp,             [0.40, 0.75, 1.00]);
  assert.deepEqual(payload.containmentRates,     { "fc1-deterministic": 0.95, "fc2-policy": 0.88 });
  assert.deepEqual(payload.hitlSamplingRates,    { "fc3-multiagent": 0.30 });
  assert.deepEqual(payload.modelSelection,       { router: "gpt-4o-mini", reasoning: "o1" });
  assert.deepEqual(payload.nonIntegratedSystems, ["legacy-hrms"]);
  assert.equal(payload.landscapeMaturity, "mixed");
  assert.equal(payload.contractYears,     3);
});

// ---------------------------------------------------------------------------
// Core required fields — never dropped
// ---------------------------------------------------------------------------

test("round-trip: all required core fields preserved across load → save", () => {
  const form = fromApiInputs(BASE);
  const payload = toApiInputs(form);
  assert.equal(payload.numSystems,         BASE.numSystems);
  assert.equal(payload.annualTransactions, BASE.annualTransactions);
  assert.equal(payload.employees,          BASE.employees);
  assert.equal(payload.sector,             BASE.sector);
  assert.equal(payload.companyType,        BASE.companyType);
  assert.equal(payload.isolationTier,      BASE.isolationTier);
  assert.equal(payload.hrHourlyCostUsd,    BASE.hrHourlyCostUsd);
  assert.equal(payload.hitlHourlyCostUsd,  BASE.hitlHourlyCostUsd);
  assert.equal(payload.countries,          BASE.countries);
});

// ---------------------------------------------------------------------------
// Round-trip guard: duplicate-guard aliases (named to match original test IDs)
// ---------------------------------------------------------------------------

test("fromApiInputs: assumptionOverrides not spread as top-level form field (duplicate guard)", () => {
  const form = fromApiInputs(asInputs({ ...BASE, assumptionOverrides: { "llm-call-cost": 0.005 } }));
  assert.ok(!("assumptionOverrides" in form));
  assert.equal((form._assumptionOverrides as Record<string, unknown>)?.["llm-call-cost"], 0.005);
});

test("fromApiInputs: containmentOverrides not spread as top-level form field (duplicate guard)", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    containmentOverrides: { "fc1-deterministic": 0.9, "fc4-frontier": 0.6 },
  }));
  assert.ok(!("containmentOverrides" in form));
  // Merged into containmentRates (not flat fields — scenario-form uses the modern approach)
  assert.equal(form.containmentRates?.["fc1-deterministic"], 0.9);
  assert.equal(form.containmentRates?.["fc4-frontier"], 0.6);
});

test("round-trip: load scenario with overrides, reset all, payload has no assumptionOverrides (duplicate guard)", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    assumptionOverrides: { "llm-call-cost": 0.005, "slm-call-cost": 0.001 },
  }));
  assert.ok(!("assumptionOverrides" in form));
  const cleared = Object.fromEntries(
    OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [k, "" as number | ""]),
  );
  const payload = toApiInputs({ ...form, _assumptionOverrides: cleared });
  assert.ok(!("assumptionOverrides" in payload));
});

test("round-trip: load scenario with overrides, change one, payload reflects only new override (duplicate guard)", () => {
  const form = fromApiInputs(asInputs({
    ...BASE,
    assumptionOverrides: { "llm-call-cost": 0.005, "slm-call-cost": 0.001 },
  }));
  const edited = {
    ...form,
    _assumptionOverrides: {
      ...((form._assumptionOverrides as Record<string, number | "">) ?? {}),
      "llm-call-cost": "" as number | "",
      "slm-call-cost": 0.002 as number | "",
    },
  };
  const payload = toApiInputs(edited);
  assert.deepEqual(payload.assumptionOverrides, { "slm-call-cost": 0.002 });
});
