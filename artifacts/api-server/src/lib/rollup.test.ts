import test from "node:test";
import assert from "node:assert/strict";
import { computeRollup, computeShares, type ScenarioInputs } from "./rollup";
import { validateScenarioInputs, InputValidationError } from "./validate-inputs";

const base: ScenarioInputs = {
  numSystems: 4,
  annualTransactions: 120000,
  employees: 8000,
  sector: "manufacturing",
  companyType: "multi-country",
  isolationTier: "siloed",
  hrHourlyCostUsd: 38,
  hitlHourlyCostUsd: 42,
  countries: 6,
};

test("shares sum to 1 and transactions equal committed volume", () => {
  const shares = computeShares(base);
  const total = [...shares.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares sum to ${total}`);

  const rollup = computeRollup(base);
  const txns = rollup.rows.reduce((a, r) => a + r.transactions, 0);
  assert.ok(Math.abs(txns - base.annualTransactions) < 1e-6);
});

test("override shares are pinned and remainder normalizes", () => {
  const shares = computeShares({ ...base, intentShareOverrides: { "payslip-copy": 0.25 } });
  assert.ok(Math.abs((shares.get("payslip-copy") ?? 0) - 0.25) < 1e-12);
  const total = [...shares.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("totals reconcile with rows and cost-component buckets", () => {
  const r = computeRollup(base);
  const rowRun = r.rows.reduce((a, x) => a + x.runCostUsd, 0);
  const rowBuild = r.rows.reduce((a, x) => a + x.buildCostUsd, 0);
  const rowBenefit = r.rows.reduce((a, x) => a + x.benefitUsd, 0);
  assert.ok(Math.abs(rowRun - r.totals.runCostUsd) < 1e-6);
  assert.ok(Math.abs(rowBuild - r.totals.buildCostUsd) < 1e-6);
  assert.ok(Math.abs(rowBenefit - r.totals.benefitUsd) < 1e-6);

  const bucketTotal = r.byCostComponent.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(bucketTotal - r.totals.totalCostUsd) < 1e-6);

  const fcTotal = r.byFlowClass.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(fcTotal - r.totals.totalCostUsd) < 1e-6);

  const domainTotal = r.byDomain.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(domainTotal - r.totals.totalCostUsd) < 1e-6);

  // Reconciliation must hold under partial adoption + fixed-cost allocation too.
  const p = computeRollup({ ...base, adoptionRate: 0.6, contractYears: 2 });
  const pDomain = p.byDomain.reduce((a, b) => a + b.usd, 0);
  const pRows = p.rows.reduce((a, x) => a + x.runCostUsd + x.buildCostUsd, 0);
  assert.ok(Math.abs(pDomain - p.totals.totalCostUsd) < 1e-6);
  assert.ok(Math.abs(pRows - p.totals.totalCostUsd) < 1e-6);
});

test("every scenario input changes the result", () => {
  const baseCost = computeRollup(base).totals.totalCostUsd;
  const variants: Array<[string, Partial<ScenarioInputs>]> = [
    ["numSystems", { numSystems: 10 }],
    ["annualTransactions", { annualTransactions: 240000 }],
    ["employees (size band)", { employees: 500 }],
    ["sector", { sector: "technology" }],
    ["companyType", { companyType: "single-country" }],
    ["isolationTier", { isolationTier: "dedicated" }],
    ["hitlHourlyCostUsd", { hitlHourlyCostUsd: 84 }],
    ["countries", { countries: 1 }],
    ["overrides", { intentShareOverrides: { "cross-border-relocation": 0.3 } }],
    ["adoptionRate", { adoptionRate: 0.5 }],
    ["containmentOverrides", { containmentOverrides: { "fc1-deterministic": 0.5 } }],
    ["hitlSamplingRate", { hitlSamplingRate: 0.3 }],
    ["landscapeMaturity", { landscapeMaturity: "legacy" }],
    ["contractYears", { contractYears: 1 }],
  ];
  for (const [name, patch] of variants) {
    const cost = computeRollup({ ...base, ...patch }).totals.totalCostUsd;
    assert.notEqual(cost.toFixed(6), baseCost.toFixed(6), `${name} did not change total cost`);
  }
  const baseBenefit = computeRollup(base).totals.benefitUsd;
  const hrBenefit = computeRollup({ ...base, hrHourlyCostUsd: 76 }).totals.benefitUsd;
  assert.ok(hrBenefit > baseBenefit, "hrHourlyCostUsd did not change benefit");
  const reworkBenefit = computeRollup({ ...base, reworkRatePct: 8 }).totals.benefitUsd;
  assert.ok(reworkBenefit > baseBenefit, "reworkRatePct did not increase benefit");
  const peakBenefit = computeRollup({ ...base, peakLoadFactor: 1.3 }).totals.benefitUsd;
  assert.ok(peakBenefit > baseBenefit, "peakLoadFactor did not increase benefit");
});

test("adoption scales channel volume; containment shifts cost to human fallback", () => {
  const full = computeRollup({ ...base, adoptionRate: 1 });
  const half = computeRollup({ ...base, adoptionRate: 0.5 });
  const halfTxns = half.rows.reduce((a, r) => a + r.transactions, 0);
  assert.ok(Math.abs(halfTxns - base.annualTransactions * 0.5) < 1e-6);
  assert.ok(half.totals.benefitUsd < full.totals.benefitUsd);

  const low = computeRollup({ ...base, containmentOverrides: {
    "fc1-deterministic": 0.4, "fc2-policy": 0.4, "fc3-multiagent": 0.4, "fc4-frontier": 0.4,
  }});
  assert.ok(low.totals.benefitUsd < full.totals.benefitUsd, "lower containment must cut benefit");
  const humanLow = low.byCostComponent.find((c) => c.key === "human")!.usd;
  const humanFull = full.byCostComponent.find((c) => c.key === "human")!.usd;
  assert.ok(humanLow > humanFull, "lower containment must raise human fallback cost");
});

test("fixed costs (knowledge maintenance, onboarding) are reported and reconciled", () => {
  const r = computeRollup(base);
  assert.ok(r.knowledgeMaintenanceUsd > 0);
  assert.ok(r.onboardingAnnualUsd > 0);
  // Amortizing over fewer years raises annual build cost.
  const shortContract = computeRollup({ ...base, contractYears: 1 });
  assert.ok(shortContract.totals.buildCostUsd > r.totals.buildCostUsd);
  // Legacy maturity raises both build and run (fan-out) cost.
  const legacy = computeRollup({ ...base, landscapeMaturity: "legacy" });
  assert.ok(legacy.totals.buildCostUsd > r.totals.buildCostUsd);
  assert.ok(legacy.totals.runCostUsd > r.totals.runCostUsd);
});

test("countries uplift applies and is reported", () => {
  const one = computeRollup({ ...base, countries: 1 });
  const many = computeRollup({ ...base, countries: 10 });
  assert.ok(many.totals.runCostUsd > one.totals.runCostUsd);
  assert.ok(!one.appliedAssumptions.some((a) => a.key === "country-localization"));
  assert.ok(many.appliedAssumptions.some((a) => a.key === "country-localization"));
});

test("confidence rises with provided parameters and lists what's missing", () => {
  const minimal = computeRollup(base);
  assert.equal(minimal.confidence.level, "low");
  const missing = minimal.confidence.factors.filter((f) => !f.provided);
  assert.equal(missing.length, 7, "all optional parameters should be reported missing");
  assert.ok(missing.every((f) => f.note.length > 0));

  const partial = computeRollup({ ...base, adoptionRate: 0.7, landscapeMaturity: "legacy" });
  assert.ok(partial.confidence.score > minimal.confidence.score);

  const full = computeRollup({
    ...base,
    adoptionRate: 0.7,
    containmentOverrides: { "fc1-deterministic": 0.9 },
    hitlSamplingRate: 0.5,
    landscapeMaturity: "mixed",
    contractYears: 3,
    reworkRatePct: 5,
    peakLoadFactor: 1.2,
  });
  assert.equal(full.confidence.score, 100);
  assert.equal(full.confidence.level, "high");
  assert.ok(full.confidence.factors.every((f) => f.provided));
});

test("tier multiplier reported matches input tier", () => {
  assert.equal(computeRollup({ ...base, isolationTier: "pooled" }).tierMultiplier, 1.0);
  assert.equal(computeRollup({ ...base, isolationTier: "dedicated" }).tierMultiplier, 2.5);
});

test("validation rejects malformed inputs", () => {
  const bad: Array<Partial<ScenarioInputs>> = [
    { numSystems: 0 },
    { numSystems: 2.5 },
    { annualTransactions: -5 },
    { employees: 1.5 },
    { countries: 0 },
    { sector: "unknown-sector" },
    { companyType: "galactic" },
    { isolationTier: "gold" },
    { hrHourlyCostUsd: 0 },
    { intentShareOverrides: { "not-an-intent": 0.1 } },
    { intentShareOverrides: { "payslip-copy": 1.5 } },
    { intentShareOverrides: { "payslip-copy": 0.8, "leave-balance": 0.5 } },
    { adoptionRate: 0 },
    { adoptionRate: 1.2 },
    { hitlSamplingRate: -0.1 },
    { containmentOverrides: { "not-a-flow-class": 0.5 } },
    { containmentOverrides: { "fc1-deterministic": 1.5 } },
    { landscapeMaturity: "pristine" },
    { contractYears: 2.5 },
    { reworkRatePct: 30 },
    { peakLoadFactor: 0.5 },
  ];
  for (const patch of bad) {
    assert.throws(
      () => validateScenarioInputs({ ...base, ...patch }),
      InputValidationError,
      `expected rejection for ${JSON.stringify(patch)}`,
    );
  }
  assert.doesNotThrow(() => validateScenarioInputs(base));
});
