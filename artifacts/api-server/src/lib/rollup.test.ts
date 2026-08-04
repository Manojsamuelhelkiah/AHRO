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
  ];
  for (const [name, patch] of variants) {
    const cost = computeRollup({ ...base, ...patch }).totals.totalCostUsd;
    assert.notEqual(cost.toFixed(6), baseCost.toFixed(6), `${name} did not change total cost`);
  }
  const baseBenefit = computeRollup(base).totals.benefitUsd;
  const hrBenefit = computeRollup({ ...base, hrHourlyCostUsd: 76 }).totals.benefitUsd;
  assert.ok(hrBenefit > baseBenefit, "hrHourlyCostUsd did not change benefit");
});

test("countries uplift applies and is reported", () => {
  const one = computeRollup({ ...base, countries: 1 });
  const many = computeRollup({ ...base, countries: 10 });
  assert.ok(many.totals.runCostUsd > one.totals.runCostUsd);
  assert.ok(!one.appliedAssumptions.some((a) => a.key === "country-localization"));
  assert.ok(many.appliedAssumptions.some((a) => a.key === "country-localization"));
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
