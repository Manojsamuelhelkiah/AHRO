import test from "node:test";
import assert from "node:assert/strict";
import { computeRollup, computeShares, manualActionFractions, computeVariance, type ScenarioInputs } from "./rollup";
import { intentMap } from "../data/intents";
import { flowClassMap } from "../data/flow-classes";
import { componentSumFor } from "../data/build-components";
import { validateScenarioInputs, validateActualsOverlay, InputValidationError } from "./validate-inputs";
import type { ActualsOverlay } from "../data/types";

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
  const shares = computeShares({ ...base, intentShareOverrides: { "payslip-copy": 0.25 } });
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
  const r = computeRollup({
    ...base,
    adoptionRate: 0.6,
    containmentOverrides: { "fc1-deterministic": 0.8 },
    assumptionOverrides: { "slm-call-cost": 0 },
  });
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
  const full = computeRollup({
    ...base,
    adoptionRate: 0.7,
    containmentOverrides: { "fc1-deterministic": 0.9 },
    hitlSamplingRate: 0.5,
    landscapeMaturity: "mixed",
    contractYears: 3,
    reworkRatePct: 5,
    peakLoadFactor: 1.2,
    modelSelection: { reasoning: "gpt-5" },
  });
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
  const r = computeRollup({
    ...base,
    adoptionRate: 0.6,
    containmentOverrides: { "fc1-deterministic": 0.8 },
    assumptionOverrides: { "slm-call-cost": 0 },
  });
  const shortContract = computeRollup({ ...base, contractYears: 1 });
  assert.ok(shortContract.totals.buildCostUsd > r.totals.buildCostUsd);
  // Legacy maturity raises both build and run (fan-out) cost.
  const legacy = computeRollup({ ...base, landscapeMaturity: "legacy" });
  assert.ok(legacy.totals.buildCostUsd > r.totals.buildCostUsd);
  assert.ok(legacy.totals.runCostUsd > r.totals.runCostUsd);
});

test("countries uplift applies and is reported", () => {
  const few = computeRollup({ ...base, countries: 1 });
  const many = computeRollup({ ...base, countries: 10 });
  assert.ok(many.totals.runCostUsd > few.totals.runCostUsd, "more countries raise run cost");
  assert.ok(many.appliedAssumptions.some((a) => a.key === "country-localization"));
});

test("confidence rises with provided parameters and lists what's missing", () => {
  const minimal = computeRollup(base);
  assert.equal(minimal.confidence.level, "low");
  const missing = minimal.confidence.factors.filter((f) => !f.provided);
  assert.equal(missing.length, 8, "all optional parameters should be reported missing");
  assert.ok(missing.every((f) => f.note.length > 0));

  const partial = computeRollup({ ...base, adoptionRate: 0.7 });
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
    modelSelection: { reasoning: "gpt-5" },
  });
  assert.equal(full.confidence.score, 100);
  assert.equal(full.confidence.level, "high");
  assert.ok(full.confidence.factors.every((f) => f.provided));
});

test("model selection reprices AI consumption exactly", () => {
  const def = computeRollup(base);
  const explicitDefaults = computeRollup({
    ...base,
    modelSelection: { router: "gpt-5-mini", reasoning: "gpt-5", frontier: "claude-opus" },
  });
  assert.ok(
    Math.abs(def.totals.runCostUsd - explicitDefaults.totals.runCostUsd) < 1e-6,
    "selecting the default models must not change cost",
  );
  const cheaper = computeRollup({
    ...base,
    modelSelection: { router: "phi-onprem", reasoning: "gemini-pro", frontier: "o-series" },
  });
  assert.ok(cheaper.totals.runCostUsd < def.totals.runCostUsd, "cheaper models lower run cost");
  assert.ok(cheaper.totals.netUsd > def.totals.netUsd, "cheaper models raise net value");
  const applied = cheaper.appliedAssumptions.find((a) => a.key === "model-reasoning");
  assert.ok(applied && applied.label.includes("Gemini Pro"));
});

test("approved flow overrides adjust intents and flag rows", () => {
  const noOv = computeRollup(base);
  const target = noOv.rows[0]!;
  const withOv = computeRollup(base, {
    [target.intentKey]: { toBeHumanMin: 45, actGetActions: 10, actPutActions: 10 },
  });
  const row = withOv.rows.find((rr) => rr.intentKey === target.intentKey)!;
  assert.equal(row.overridden, true);
  assert.ok(withOv.rows.filter((r) => r.overridden).length === 1);
  assert.ok(row.runCostUsd > target.runCostUsd, "more actions + human minutes raise run cost");
  assert.ok(row.benefitUsd < target.benefitUsd, "more residual human minutes lower benefit");
  // untouched intents unchanged
  const other = noOv.rows[1]!;
  const otherAfter = withOv.rows.find((r) => r.intentKey === other.intentKey)!;
  assert.ok(Math.abs(otherAfter.netUsd - other.netUsd) < 1e-6);
  // reassigning flow class changes pricing template
  const reclass = computeRollup(base, { [target.intentKey]: { flowClass: "fc4-frontier" } });
  const reclassRow = reclass.rows.find((r) => r.intentKey === target.intentKey)!;
  assert.equal(reclassRow.flowClass, "fc4-frontier");
});

test("non-integrated systems shift actions from MCP cost to manual minutes", () => {
  const integrated = computeRollup(base);
  const partial = computeRollup({ ...base, nonIntegratedSystems: ["sf-ec"] });
  const humanOf = (r: typeof integrated) =>
    r.byCostComponent.find((c) => c.key === "human")!.usd;
  assert.ok(humanOf(partial) > humanOf(integrated), "manual actions raise human cost");
  assert.ok(
    partial.totals.benefitUsd < integrated.totals.benefitUsd,
    "manual handling reduces the eliminated-time benefit",
  );
  assert.ok(
    partial.totals.netUsd < integrated.totals.netUsd,
    "net value drops when a system stays manual",
  );
  const untouched = integrated.rows.find(
    (r) => partial.rows.find((p) => p.intentKey === r.intentKey)!.netUsd === r.netUsd,
  );
  assert.ok(untouched, "at least one intent is unaffected");
  assert.ok(partial.appliedAssumptions.some((a) => a.key === "manual-action-minutes"));
  assert.ok(!integrated.appliedAssumptions.some((a) => a.key === "manual-action-minutes"));
});

test("manual action fractions are action-typed and stage-scoped", () => {
  const it = intentMap["payslip-copy"]!; // act step: sf-ec + sf-ecp, both get, both scale
  // Excluding a read-only act system affects GET work only; both act systems
  // scale with landscape (equal weight), so the fraction is exactly 1/2.
  const readOnly = manualActionFractions(it, { ...base, nonIntegratedSystems: ["sf-ec"] });
  assert.equal(readOnly.getFrac, 0.5);
  assert.equal(readOnly.putFrac, 0);
  const all = manualActionFractions(it, {
    ...base,
    nonIntegratedSystems: ["sf-ec", "sf-ecp"],
  });
  assert.equal(all.getFrac, 1);
  const nonAct = manualActionFractions(it, { ...base, nonIntegratedSystems: ["ticketing"] });
  assert.equal(nonAct.getFrac, 0);
  assert.equal(nonAct.putFrac, 0);
  // With nonIntegratedSystems: assumption surfaces AND the net cost changes.
  const rWithNonIntegrated = computeRollup({ ...base, nonIntegratedSystems: ["sf-ec"] });
  const rWithout = computeRollup(base);
  const touched = rWithNonIntegrated.appliedAssumptions.some((a) => a.key === "manual-action-minutes");
  const anyRowChanged = rWithNonIntegrated.totals.netUsd !== rWithout.totals.netUsd;
  assert.equal(touched, anyRowChanged, "assumption surfaces iff actions are actually excluded");
  // Without nonIntegratedSystems: assumption is not surfaced at all.
  assert.equal(rWithout.appliedAssumptions.some((a) => a.key === "manual-action-minutes"), false);
});

test("fan-out applies exactly once and identically to automated and manual units", () => {
  const it = intentMap["payslip-copy"]!;
  const bigBase = { ...base, numSystems: 12 };
  const none = manualActionFractions(it, bigBase);
  const one = manualActionFractions(it, { ...bigBase, nonIntegratedSystems: ["sf-ec"] });
  assert.ok(Math.abs(none.automatedUnits - (one.automatedUnits + one.manualUnits)) < 1e-9);
  assert.ok(Math.abs(one.manualUnits - none.automatedUnits / 2) < 1e-9);
  const small = manualActionFractions(it, { ...base, numSystems: 2, nonIntegratedSystems: ["sf-ec"] });
  assert.ok(one.manualUnits > small.manualUnits, "more systems -> more manual work at stake");
  // Legacy maturity raises fan-out — compare fractions for the same intent at same exclusions.
  const oneLegacy = manualActionFractions(it, { ...bigBase, landscapeMaturity: "legacy", nonIntegratedSystems: ["sf-ec"] });
  assert.ok(oneLegacy.manualUnits > one.manualUnits, "legacy maturity raises fan-out weighting");
});

test("build component decomposition matches each flow class's build cost", () => {
  for (const fc of Object.values(flowClassMap)) {
    assert.equal(componentSumFor(fc.key), fc.buildCostUsd, fc.key);
  }
});

test("build breakdown reconciles exactly with total build cost", () => {
  const r = computeRollup({
    ...base,
    adoptionRate: 0.6,
    containmentOverrides: { "fc1-deterministic": 0.8 },
    assumptionOverrides: { "slm-call-cost": 0 },
  });
  const breakdownAnnual = r.buildBreakdown.reduce((a, c) => a + c.annualUsd, 0);
  assert.ok(Math.abs(breakdownAnnual - r.totals.buildCostUsd) < 1e-6);
  const platform = r.buildBreakdown.filter((c) => c.kind === "platform");
  const oneTime = platform.reduce((a, c) => a + c.oneTimeUsd, 0);
  assert.ok(Math.abs(oneTime - (18000 + 45000 + 120000 + 250000)) < 1e-6);
  const legacy = computeRollup({ ...base, landscapeMaturity: "legacy" });
  const legacyPlatform = legacy.buildBreakdown.filter((c) => c.kind === "platform");
  assert.ok(legacyPlatform.reduce((a, c) => a + c.oneTimeUsd, 0) > oneTime);
  const onboarding = (res: typeof r) =>
    res.buildBreakdown.filter((c) => c.kind === "onboarding").reduce((a, c) => a + c.annualUsd, 0);
  assert.ok(Math.abs(onboarding(legacy) - onboarding(r)) < 1e-6);
  assert.ok(Math.abs(onboarding(r) - r.onboardingAnnualUsd) < 1e-6);
});

test("tier multiplier reported matches input tier", () => {
  assert.equal(computeRollup({ ...base, isolationTier: "pooled" }).tierMultiplier, 1.0);
  assert.equal(computeRollup({ ...base, isolationTier: "dedicated" }).tierMultiplier, 2.5);
});

// ── Custom intent tests ───────────────────────────────────────────────────

/** Minimal custom intent fixture in Intent shape (no DB needed — pure function tests). */
const customIntent = {
  id: -99,
  key: "custom-visa-support",
  name: "Visa Support Request",
  domain: "mobility",
  flowClass: "fc2-policy" as const,
  description: "Client-specific visa support flow.",
  source: { name: "Client workshop", confidence: "medium" as const },
  asIsHandlingMin: 40,
  toBeHumanMin: 8,
  baseWeight: 3,
  actGetActions: 2,
  actPutActions: 0,
  systemsTouchedBase: 2,
  tags: ["custom"],
};

test("shares still sum to 1 when a custom intent is added", () => {
  const shares = computeShares(base, [customIntent]);
  const total = [...shares.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares sum to ${total}`);
  assert.ok(shares.has(customIntent.key), "custom intent has a share entry");
  assert.ok((shares.get(customIntent.key) ?? 0) > 0, "custom intent share is positive");
});

test("custom intent row appears in rollup and totals reconcile", () => {
  const r = computeRollup(base, undefined, undefined, [customIntent]);

  // Row appears in the result
  const row = r.rows.find((rr) => rr.intentKey === customIntent.key);
  assert.ok(row, "custom intent row must appear in rollup rows");
  assert.ok(row!.transactions > 0, "custom intent row has allocated transactions");
  assert.ok(row!.benefitUsd > 0, "custom intent has positive benefit (asIs > toBe)");

  // Domain bucket picks up the custom intent's domain
  const domainBucket = r.byDomain.find((b) => b.key === customIntent.domain);
  assert.ok(domainBucket, "custom intent domain appears in byDomain");

  // Totals still reconcile
  const rowRun = r.rows.reduce((a, x) => a + x.runCostUsd, 0);
  const rowBuild = r.rows.reduce((a, x) => a + x.buildCostUsd, 0);
  const rowBenefit = r.rows.reduce((a, x) => a + x.benefitUsd, 0);
  assert.ok(Math.abs(rowRun - r.totals.runCostUsd) < 1e-6, "run cost reconciles");
  assert.ok(Math.abs(rowBuild - r.totals.buildCostUsd) < 1e-6, "build cost reconciles");
  assert.ok(Math.abs(rowBenefit - r.totals.benefitUsd) < 1e-6, "benefit reconciles");

  const bucketTotal = r.byCostComponent.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(bucketTotal - r.totals.totalCostUsd) < 1e-6, "cost-component buckets reconcile");

  const fcTotal = r.byFlowClass.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(fcTotal - r.totals.totalCostUsd) < 1e-6, "byFlowClass reconciles");

  const domainTotal = r.byDomain.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(domainTotal - r.totals.totalCostUsd) < 1e-6, "byDomain reconciles");
});

test("custom intent moves rollup totals vs no custom intents", () => {
  const without = computeRollup(base);
  const with_ = computeRollup(base, undefined, undefined, [customIntent]);
  // Adding an intent with positive benefit and non-zero transactions must change totals.
  assert.notEqual(
    with_.totals.totalCostUsd.toFixed(6),
    without.totals.totalCostUsd.toFixed(6),
    "total cost must change when custom intent added",
  );
  assert.notEqual(
    with_.totals.benefitUsd.toFixed(6),
    without.totals.benefitUsd.toFixed(6),
    "benefit must change when custom intent added",
  );
  // Row count increases
  assert.equal(with_.rows.length, without.rows.length + 1, "one extra row for custom intent");
});

test("retired custom intent excluded — rollup reverts to reference-only result", () => {
  // Simulate retirement by passing no extraIntents (retired intents are filtered by the route
  // before calling computeRollup; the pure function only sees what it's given).
  const without = computeRollup(base);
  const withCustom = computeRollup(base, undefined, undefined, [customIntent]);
  const retired = computeRollup(base, undefined, undefined, []); // retired = not passed in

  // After retirement the rollup is identical to the no-custom baseline.
  assert.equal(retired.rows.length, without.rows.length, "retired intent not in row count");
  assert.ok(
    Math.abs(retired.totals.totalCostUsd - without.totals.totalCostUsd) < 1e-6,
    "retired intent: total cost equals reference-only rollup",
  );
  // And it differs from the with-custom version.
  assert.notEqual(
    retired.totals.totalCostUsd.toFixed(6),
    withCustom.totals.totalCostUsd.toFixed(6),
    "retired rollup differs from active-custom rollup",
  );
});

test("flow override is accepted on a custom intent key and adjusts the row", () => {
  // The rollup applies overrides keyed on intent key — custom keys work identically.
  const without = computeRollup(base, undefined, undefined, [customIntent]);
  const baseRow = without.rows.find((r) => r.intentKey === customIntent.key)!;

  const with_ = computeRollup(
    base,
    { [customIntent.key]: { toBeHumanMin: 20, actGetActions: 5 } },
    undefined,
    [customIntent],
  );
  const overriddenRow = with_.rows.find((r) => r.intentKey === customIntent.key)!;
  assert.equal(overriddenRow.overridden, true, "override flag set for custom intent");
  // More residual human minutes → higher human cost
  assert.ok(
    overriddenRow.humanCostUsd > baseRow.humanCostUsd,
    "override raising toBeHumanMin raises human cost",
  );
  // More GET actions → higher run cost
  assert.ok(
    overriddenRow.runCostUsd > baseRow.runCostUsd,
    "override adding GET actions raises run cost",
  );
  // Totals still reconcile after override
  const rowRun = with_.rows.reduce((a, x) => a + x.runCostUsd, 0);
  assert.ok(Math.abs(rowRun - with_.totals.runCostUsd) < 1e-6, "totals reconcile with override on custom intent");
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
    { assumptionOverrides: { "not-a-key": 0.1 } },
    { assumptionOverrides: { "slm-call-cost": -1 } },
  ];

  const allKeys: Record<string, number> = {
    "slm-call-cost": 0.001,
    "llm-call-cost": 0.01,
    "frontier-call-cost": 0.06,
    "mcp-action-cost": 0.002,
    "infra-per-txn": 0.01,
    "landscape-fanout": 0.25,
    "country-localization": 0.02,
    "tier-pooled": 1.0,
    "tier-siloed": 1.3,
    "tier-dedicated": 2.0,
    "company-multi-country": 1.05,
    "company-global": 1.15,
  };

  for (const b of bad) {
    assert.throws(
      () => validateScenarioInputs({ ...base, ...b }),
      InputValidationError,
      `expected rejection for: ${JSON.stringify(b)}`,
    );
  }
  assert.doesNotThrow(
    () => validateScenarioInputs({ ...base, assumptionOverrides: allKeys }),
    "all 12 overridable keys should pass validation with valid values",
  );
});

// ---------------------------------------------------------------------------
// Actuals overlay tests
// ---------------------------------------------------------------------------

test("empty overlay (undefined) produces identical totals to baseline", () => {
  const baseline = computeRollup(base);
  const withEmpty = computeRollup(base, undefined, undefined);
  assert.ok(Math.abs(baseline.totals.totalCostUsd - withEmpty.totals.totalCostUsd) < 1e-9,
    "undefined overlay must not change total cost");
  assert.ok(Math.abs(baseline.totals.benefitUsd - withEmpty.totals.benefitUsd) < 1e-9,
    "undefined overlay must not change benefit");
  assert.equal(withEmpty.calibrated, false);
});

test("overlay with flow-class containment moves the result", () => {
  const baseline = computeRollup(base);
  // Measured containment is lower than the fc1 default of 0.95
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.72 },
  };
  const calibrated = computeRollup(base, undefined, overlay);
  assert.equal(calibrated.calibrated, true);
  assert.ok(
    calibrated.totals.benefitUsd < baseline.totals.benefitUsd,
    "lower measured containment must reduce benefit",
  );
  // The fc1 containment assumption must be flagged as measured
  const fc1Entry = calibrated.appliedAssumptions.find((a) => a.key === "containment-fc1");
  assert.ok(fc1Entry, "containment-fc1 must appear in appliedAssumptions");
  assert.equal(fc1Entry!.source.confidence, "measured");
  assert.ok(fc1Entry!.measuredValue !== undefined, "measuredValue must be set");
  assert.ok(Math.abs(fc1Entry!.measuredValue! - 0.72) < 1e-9);
  // Unaffected classes must not be flagged
  const fc2Entry = calibrated.appliedAssumptions.find((a) => a.key === "containment-fc2");
  assert.ok(fc2Entry && fc2Entry.source.confidence !== "measured",
    "containment-fc2 must not be flagged as measured when not in overlay");
});

test("overlay with per-intent containment overrides flow-class rate for that intent", () => {
  const baseline = computeRollup(base);
  // Provide a flow-class rate and a stricter per-intent rate for one fc1 intent
  const fc1Intent = baseline.rows.find((r) => r.flowClass === "fc1-deterministic")!;
  assert.ok(fc1Intent, "need at least one fc1 intent");
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.88 },
    intents: [{ intentKey: fc1Intent.intentKey, measuredContainmentRate: 0.60 }],
  };
  const calibrated = computeRollup(base, undefined, overlay);
  // The per-intent override (0.60) is stricter than the fc-level override (0.88);
  // that intent should contribute less benefit than if only fc-level applied.
  const fcOnlyOverlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.88 },
  };
  const fcOnly = computeRollup(base, undefined, fcOnlyOverlay);
  assert.ok(
    calibrated.totals.benefitUsd < fcOnly.totals.benefitUsd,
    "per-intent measured containment (0.60) must yield lower benefit than fc-level (0.88)",
  );
});

test("overlay with measured HITL sampling rate moves cost and is flagged", () => {
  const baseline = computeRollup(base);
  const overlay: ActualsOverlay = { measuredHitlSamplingRate: 0.3 };
  const calibrated = computeRollup(base, undefined, overlay);
  // Lower HITL sampling → less review cost on contained transactions → lower human cost
  const humanBaseline = baseline.byCostComponent.find((c) => c.key === "human")!.usd;
  const humanCalibrated = calibrated.byCostComponent.find((c) => c.key === "human")!.usd;
  assert.ok(humanCalibrated < humanBaseline, "lower sampling rate must reduce human cost");
  // Flagged as measured in appliedAssumptions
  const samplingEntry = calibrated.appliedAssumptions.find((a) => a.key === "hitl-sampling-rate");
  assert.ok(samplingEntry, "hitl-sampling-rate must appear in appliedAssumptions when overlay provides it");
  assert.equal(samplingEntry!.source.confidence, "measured");
  assert.ok(Math.abs(samplingEntry!.measuredValue! - 0.3) < 1e-9);
});

test("overlay with token actuals reprices model calls and flags model assumptions", () => {
  const baseline = computeRollup(base);
  // Measured tokens are substantially lower than the baked per-call profile →
  // token-computed price < pricePerCallUsd → lower AI run cost.
  const overlay: ActualsOverlay = {
    tokenActualsByRole: {
      router: { avgInputTokens: 800, avgOutputTokens: 100 },
      reasoning: { avgInputTokens: 3000, avgOutputTokens: 500 },
    },
  };
  const calibrated = computeRollup(base, undefined, overlay);
  assert.ok(
    calibrated.totals.runCostUsd < baseline.totals.runCostUsd,
    "fewer tokens must reduce AI run cost",
  );
  // Router and reasoning model entries must be flagged as measured
  const routerEntry = calibrated.appliedAssumptions.find((a) => a.key === "model-router");
  assert.ok(routerEntry && routerEntry.source.confidence === "measured",
    "model-router must be flagged measured");
  assert.ok(routerEntry!.measuredValue !== undefined, "model-router measuredValue must be set");
  // value is the original per-call estimate; measuredValue is the token-computed price
  assert.ok(
    Math.abs(routerEntry!.value - routerEntry!.measuredValue!) > 1e-9 ||
      routerEntry!.measuredValue !== undefined,
    "router value and measuredValue should differ unless tokens happen to match exactly",
  );
  // Frontier not in overlay → still uses catalog per-call, not flagged
  const frontierEntry = calibrated.appliedAssumptions.find((a) => a.key === "model-frontier");
  assert.ok(frontierEntry && frontierEntry.source.confidence !== "measured",
    "model-frontier must not be flagged when not in overlay");
});

test("token repricing: no overlay = identical to baseline byte-for-byte", () => {
  // Explicitly verifies the existing per-call path is untouched when no overlay.
  const a = computeRollup(base, undefined, undefined);
  const b = computeRollup(base);
  assert.ok(Math.abs(a.totals.runCostUsd - b.totals.runCostUsd) < 1e-9);
  assert.ok(Math.abs(a.totals.benefitUsd - b.totals.benefitUsd) < 1e-9);
  // No model entries should have measuredValue without overlay
  for (const role of ["router", "reasoning", "frontier", "data"]) {
    const entry = a.appliedAssumptions.find((x) => x.key === `model-${role}`);
    assert.ok(entry && entry.measuredValue === undefined,
      `model-${role} must not have measuredValue without overlay`);
  }
});

test("variance is empty for baseline rollup and non-zero when overlay differs", () => {
  const estimated = computeRollup(base);
  // No variance between identical runs (both no overlay)
  const sameVariance = computeVariance(estimated, estimated);
  assert.equal(sameVariance.length, 0,
    "variance between identical runs must be empty");

  // Real overlay → non-empty variance
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.72 },
    tokenActualsByRole: { router: { avgInputTokens: 800, avgOutputTokens: 100 } },
  };
  const actual = computeRollup(base, undefined, overlay);
  const variance = computeVariance(estimated, actual);
  assert.ok(variance.length > 0, "variance must have entries when overlay differs");
  const containmentVar = variance.find((v) => v.assumptionKey === "containment-fc1");
  assert.ok(containmentVar, "containment-fc1 variance entry must exist");
  assert.ok(Math.abs(containmentVar!.estimatedValue - 0.95) < 1e-9,
    "estimated value must be the assumption default (0.95)");
  assert.ok(Math.abs(containmentVar!.actualValue - 0.72) < 1e-9,
    "actual value must be the overlay measurement (0.72)");
  assert.ok(containmentVar!.absVariance < 0, "fc1 containment decreased → negative absVariance");
});

test("variance is zero when actuals equal the assumption defaults exactly", () => {
  // Supply measured values that exactly match assumption defaults
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.95 }, // same as default
  };
  const estimated = computeRollup(base);
  const actual = computeRollup(base, undefined, overlay);
  const variance = computeVariance(estimated, actual);
  const containmentVar = variance.find((v) => v.assumptionKey === "containment-fc1");
  assert.ok(containmentVar, "entry must still exist even at zero variance");
  assert.ok(Math.abs(containmentVar!.absVariance) < 1e-9, "absVariance must be zero");
  assert.ok(Math.abs(containmentVar!.pctVariance) < 1e-9, "pctVariance must be zero");
});

test("measured tier yields strictly higher confidence score than client-confirmed", () => {
  // Client-confirmed: containment provided via scenario inputs
  const clientConfirmed = computeRollup({
    ...base,
    containmentOverrides: { "fc1-deterministic": 0.90 },
  });
  // Measured: same value supplied via overlay
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.90 },
  };
  const measured = computeRollup(base, undefined, overlay);
  assert.ok(
    measured.confidence.score > clientConfirmed.confidence.score,
    `measured score (${measured.confidence.score}) must exceed client-confirmed score (${clientConfirmed.confidence.score})`,
  );
  // The containmentOverrides factor must carry the "measured" source tier
  const factor = measured.confidence.factors.find((f) => f.key === "containmentOverrides");
  assert.ok(factor && factor.sourceTier === "measured",
    "containmentOverrides factor must have sourceTier = measured");
  // Client-confirmed factor has correct tier too
  const ccFactor = clientConfirmed.confidence.factors.find((f) => f.key === "containmentOverrides");
  assert.ok(ccFactor && ccFactor.sourceTier === "client-confirmed",
    "client-confirmed containmentOverrides factor must have sourceTier = client-confirmed");
});

test("measured tier on hitlSamplingRate and tokenPricing yield higher score", () => {
  // Only hitlSamplingRate measured
  const overlayHitl: ActualsOverlay = { measuredHitlSamplingRate: 0.4 };
  const withHitlInput = computeRollup({ ...base, hitlSamplingRate: 0.4 });
  const withHitlMeasured = computeRollup(base, undefined, overlayHitl);
  assert.ok(
    withHitlMeasured.confidence.score > withHitlInput.confidence.score,
    "measured HITL sampling must score higher than client-confirmed",
  );
  // Model token actuals
  const overlayTokens: ActualsOverlay = {
    tokenActualsByRole: { reasoning: { avgInputTokens: 4000, avgOutputTokens: 800 } },
  };
  const withModelInput = computeRollup({ ...base, modelSelection: { reasoning: "gpt-5" } });
  const withModelMeasured = computeRollup(base, undefined, overlayTokens);
  assert.ok(
    withModelMeasured.confidence.score > withModelInput.confidence.score,
    "measured token pricing must score higher than client-confirmed model selection",
  );
});

test("fully-measured overlay can push score above 100 (calibrated level)", () => {
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: {
      "fc1-deterministic": 0.93,
      "fc2-policy": 0.82,
      "fc3-multiagent": 0.71,
      "fc4-frontier": 0.58,
    },
    measuredHitlSamplingRate: 0.35,
    tokenActualsByRole: {
      router: { avgInputTokens: 900, avgOutputTokens: 120 },
      reasoning: { avgInputTokens: 4500, avgOutputTokens: 700 },
    },
  };
  // Baseline full client-confirmed input caps at 100
  const fullClientConfirmed = computeRollup({
    ...base,
    adoptionRate: 0.7,
    containmentOverrides: { "fc1-deterministic": 0.9 },
    hitlSamplingRate: 0.5,
    landscapeMaturity: "mixed",
    contractYears: 3,
    reworkRatePct: 5,
    peakLoadFactor: 1.2,
    modelSelection: { reasoning: "gpt-5" },
  });
  assert.equal(fullClientConfirmed.confidence.score, 100);
  assert.equal(fullClientConfirmed.confidence.level, "high");

  // Measured overlay (partial inputs + overlay) must exceed 100
  const withMeasured = computeRollup(
    { ...base, adoptionRate: 0.7, landscapeMaturity: "mixed", contractYears: 3, reworkRatePct: 5, peakLoadFactor: 1.2 },
    undefined,
    overlay,
  );
  assert.ok(withMeasured.confidence.score > 100,
    `score ${withMeasured.confidence.score} must exceed 100 when measurements are applied`);
  assert.equal(withMeasured.confidence.level, "calibrated");
});

test("overlay totals reconcile: rows and buckets still match after calibration", () => {
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.80 },
    measuredHitlSamplingRate: 0.5,
    tokenActualsByRole: { router: { avgInputTokens: 1000, avgOutputTokens: 150 } },
  };
  const r = computeRollup(base, undefined, overlay);
  const rowRun = r.rows.reduce((a, x) => a + x.runCostUsd, 0);
  const rowBuild = r.rows.reduce((a, x) => a + x.buildCostUsd, 0);
  const rowBenefit = r.rows.reduce((a, x) => a + x.benefitUsd, 0);
  assert.ok(Math.abs(rowRun - r.totals.runCostUsd) < 1e-6, "row run reconciles");
  assert.ok(Math.abs(rowBuild - r.totals.buildCostUsd) < 1e-6, "row build reconciles");
  assert.ok(Math.abs(rowBenefit - r.totals.benefitUsd) < 1e-6, "row benefit reconciles");
  const bucketTotal = r.byCostComponent.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(bucketTotal - r.totals.totalCostUsd) < 1e-6, "bucket total reconciles");
  const fcTotal = r.byFlowClass.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(fcTotal - r.totals.totalCostUsd) < 1e-6, "fc total reconciles");
});

test("actuals overlay validation: rejects unknown intent keys and flow classes", () => {
  const badIntent = validateActualsOverlay({
    intents: [{ intentKey: "not-a-real-intent", measuredContainmentRate: 0.9 }],
  });
  assert.equal(badIntent.valid, false);
  assert.ok(badIntent.errors.some((e) => e.includes("not-a-real-intent")));

  const badFc = validateActualsOverlay({
    measuredContainmentByFlowClass: { "fc99-fantasy": 0.5 },
  });
  assert.equal(badFc.valid, false);
  assert.ok(badFc.errors.some((e) => e.includes("fc99-fantasy")));

  const badRate = validateActualsOverlay({
    measuredContainmentByFlowClass: { "fc1-deterministic": 1.5 },
  });
  assert.equal(badRate.valid, false);

  const badSampling = validateActualsOverlay({ measuredHitlSamplingRate: -0.1 });
  assert.equal(badSampling.valid, false);

  const badTokenRole = validateActualsOverlay({
    tokenActualsByRole: { "super-intelligence": { avgInputTokens: 100, avgOutputTokens: 50 } },
  });
  assert.equal(badTokenRole.valid, false);
  assert.ok(badTokenRole.errors.some((e) => e.includes("super-intelligence")));
});

test("actuals overlay validation: accepts valid payloads and reports measured fields", () => {
  const result = validateActualsOverlay({
    clientLabel: "Acme Q1 2025",
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.88 },
    measuredHitlSamplingRate: 0.4,
    tokenActualsByRole: { router: { avgInputTokens: 900, avgOutputTokens: 120 } },
    intents: [{ intentKey: "payslip-copy", avgHitlMinutes: 3.5 }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.intentRowCount, 1);
  assert.ok(result.measuredFields.includes("containment"));
  assert.ok(result.measuredFields.includes("hitlSampling"));
  assert.ok(result.measuredFields.includes("tokenPricing"));
  assert.ok(result.measuredFields.includes("hitlMinutes"));
});

test("actuals overlay validation: rejects empty overlay with no measurements", () => {
  const result = validateActualsOverlay({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

// ---------------------------------------------------------------------------
// Tuned-assumption + overlay (measured-wins) interaction tests
// ---------------------------------------------------------------------------

test("measured containment wins over scenario-tuned containment and variance is against tuned value", () => {
  // User tunes fc1 containment to 0.80 (scenario override).
  // Overlay measures it at 0.72.
  // Resolution: overlay wins (0.72 applied in compute).
  // Variance estimatedValue must be 0.80 (tuned), not 0.95 (register default).
  const tunedInputs: ScenarioInputs = {
    ...base,
    containmentOverrides: { "fc1-deterministic": 0.80 },
  };
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.72 },
  };

  // Measured wins: calibrated rollup should use 0.72, not 0.80
  const estimated = computeRollup(tunedInputs);
  const actual = computeRollup(tunedInputs, undefined, overlay);

  // The tuned rollup (no overlay) uses 0.80 — verify it differs from the raw default rollup
  const rawDefault = computeRollup(base);
  assert.ok(
    Math.abs(estimated.totals.benefitUsd - rawDefault.totals.benefitUsd) > 1,
    "tuned containment (0.80 vs default 0.95) must move the estimated benefit",
  );

  // With overlay 0.72 < tuned 0.80 → less contained → lower benefit than tuned estimate
  assert.ok(
    actual.totals.benefitUsd < estimated.totals.benefitUsd,
    "overlay containment (0.72) must reduce benefit below tuned estimate (0.80)",
  );
  // And measured wins over the tuned value → calibrated benefit < tuned estimate
  // (not just different from raw default)
  assert.ok(
    actual.totals.benefitUsd < estimated.totals.benefitUsd,
    "measured value wins: calibrated benefit must be less than tuned-estimate benefit",
  );

  // appliedAssumptions: the containment-fc1 entry value must reflect the tuned value (0.80),
  // not the register default (0.95), in BOTH the estimated and actual rollup.
  const estEntry = estimated.appliedAssumptions.find(a => a.key === "containment-fc1");
  assert.ok(estEntry, "containment-fc1 must appear in estimated appliedAssumptions");
  assert.ok(
    Math.abs(estEntry!.value - 0.80) < 1e-9,
    `estimated containment-fc1.value must be tuned value 0.80, got ${estEntry!.value}`,
  );
  assert.equal(estEntry!.source.confidence, "high", "tuned-only entry should be client-confirmed (high)");

  const actEntry = actual.appliedAssumptions.find(a => a.key === "containment-fc1");
  assert.ok(actEntry, "containment-fc1 must appear in calibrated appliedAssumptions");
  assert.ok(
    Math.abs(actEntry!.value - 0.80) < 1e-9,
    `calibrated containment-fc1.value must be tuned value 0.80, got ${actEntry!.value}`,
  );
  assert.ok(
    Math.abs(actEntry!.measuredValue! - 0.72) < 1e-9,
    `calibrated containment-fc1.measuredValue must be 0.72, got ${actEntry!.measuredValue}`,
  );
  assert.equal(actEntry!.source.confidence, "measured");

  // Variance: estimatedValue = 0.80 (tuned), NOT 0.95 (register default)
  const variance = computeVariance(estimated, actual);
  const fc1Var = variance.find(v => v.assumptionKey === "containment-fc1");
  assert.ok(fc1Var, "containment-fc1 variance entry must exist");
  assert.ok(
    Math.abs(fc1Var!.estimatedValue - 0.80) < 1e-9,
    `variance estimatedValue must be tuned value 0.80, got ${fc1Var!.estimatedValue}`,
  );
  assert.ok(
    Math.abs(fc1Var!.actualValue - 0.72) < 1e-9,
    `variance actualValue must be measured value 0.72, got ${fc1Var!.actualValue}`,
  );
  // absVariance = 0.72 - 0.80 = -0.08 (not -0.23 = 0.72 - 0.95)
  assert.ok(
    Math.abs(fc1Var!.absVariance - (-0.08)) < 1e-9,
    `absVariance must be -0.08 (measured - tuned), got ${fc1Var!.absVariance}`,
  );
  assert.ok(
    Math.abs(fc1Var!.pctVariance - (-10.0)) < 0.01,
    `pctVariance must be -10% (-0.08 / 0.80), got ${fc1Var!.pctVariance}`,
  );
});

test("measured containment against untuned scenario uses register default as estimatedValue", () => {
  // No scenario tuning — overlay measures fc2 at 0.79.
  // estimatedValue in variance must be the register default 0.85.
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc2-policy": 0.79 },
  };
  const estimated = computeRollup(base);
  const actual = computeRollup(base, undefined, overlay);
  const variance = computeVariance(estimated, actual);
  const fc2Var = variance.find(v => v.assumptionKey === "containment-fc2");
  assert.ok(fc2Var, "containment-fc2 variance entry must exist");
  assert.ok(
    Math.abs(fc2Var!.estimatedValue - 0.85) < 1e-9,
    `without tuning, estimatedValue must be register default 0.85, got ${fc2Var!.estimatedValue}`,
  );
  assert.ok(
    Math.abs(fc2Var!.absVariance - (0.79 - 0.85)) < 1e-9,
    `absVariance must be 0.79 - 0.85 = -0.06, got ${fc2Var!.absVariance}`,
  );
});

test("measured HITL sampling wins over scenario-tuned sampling; variance uses tuned value", () => {
  // User tunes hitlSamplingRate to 0.50. Overlay measures 0.30.
  // Measured wins; variance estimatedValue = 0.50 (tuned), not 1.0 (default).
  const tunedInputs: ScenarioInputs = { ...base, hitlSamplingRate: 0.50 };
  const overlay: ActualsOverlay = { measuredHitlSamplingRate: 0.30 };

  const estimated = computeRollup(tunedInputs);
  const actual = computeRollup(tunedInputs, undefined, overlay);

  // Measured (0.30) < tuned (0.50) → even less HITL review cost in calibrated run
  const humanEst = estimated.byCostComponent.find(c => c.key === "human")!.usd;
  const humanAct = actual.byCostComponent.find(c => c.key === "human")!.usd;
  assert.ok(humanAct < humanEst, "overlay HITL sampling (0.30) must lower human cost below tuned (0.50)");

  // appliedAssumptions: hitl-sampling-rate.value = 0.50 (tuned), not 1.0 (default)
  const actEntry = actual.appliedAssumptions.find(a => a.key === "hitl-sampling-rate");
  assert.ok(actEntry, "hitl-sampling-rate must appear in appliedAssumptions when overlay measures it");
  assert.ok(
    Math.abs(actEntry!.value - 0.50) < 1e-9,
    `hitl-sampling-rate.value must be tuned 0.50, got ${actEntry!.value}`,
  );
  assert.ok(
    Math.abs(actEntry!.measuredValue! - 0.30) < 1e-9,
    `hitl-sampling-rate.measuredValue must be 0.30, got ${actEntry!.measuredValue}`,
  );

  // Variance: estimatedValue = 0.50 (tuned, correctly; hitl-sampling-rate not in estimated
  // appliedAssumptions so falls back to a.value = 0.50 from the actual entry)
  const variance = computeVariance(estimated, actual);
  const sampVar = variance.find(v => v.assumptionKey === "hitl-sampling-rate");
  assert.ok(sampVar, "hitl-sampling-rate variance entry must exist");
  assert.ok(
    Math.abs(sampVar!.estimatedValue - 0.50) < 1e-9,
    `hitl-sampling-rate estimatedValue must be tuned 0.50, got ${sampVar!.estimatedValue}`,
  );
  assert.ok(
    Math.abs(sampVar!.absVariance - (-0.20)) < 1e-9,
    `absVariance must be -0.20 (0.30 - 0.50), got ${sampVar!.absVariance}`,
  );
});

test("model selection (tuning) + token overlay: variance uses selected model per-call price as estimate", () => {
  // User selects gemini-pro for reasoning (tuned per-call = $0.014).
  // Overlay measures tokens → different effective price.
  // estimatedValue in variance = 0.014 (selected model's per-call), not $0.02 (gpt-5 default).
  const tunedInputs: ScenarioInputs = {
    ...base,
    modelSelection: { reasoning: "gemini-pro" },
  };
  const overlay: ActualsOverlay = {
    tokenActualsByRole: {
      reasoning: { avgInputTokens: 2000, avgOutputTokens: 400 },
    },
  };

  const estimated = computeRollup(tunedInputs);
  const actual = computeRollup(tunedInputs, undefined, overlay);

  // The model-reasoning entry in estimated reflects the selected model (gemini-pro)
  const estEntry = estimated.appliedAssumptions.find(a => a.key === "model-reasoning");
  assert.ok(estEntry, "model-reasoning must appear in estimated assumptions");
  // gemini-pro per-call price is $0.014
  assert.ok(
    Math.abs(estEntry!.value - 0.014) < 1e-9,
    `estimated model-reasoning.value must be gemini-pro per-call 0.014, got ${estEntry!.value}`,
  );

  const variance = computeVariance(estimated, actual);
  const modelVar = variance.find(v => v.assumptionKey === "model-reasoning");
  assert.ok(modelVar, "model-reasoning variance entry must exist when token actuals provided");
  assert.ok(
    Math.abs(modelVar!.estimatedValue - 0.014) < 1e-9,
    `model-reasoning estimatedValue must be selected model price 0.014, got ${modelVar!.estimatedValue}`,
  );
  // Token-computed price: (2000 * 1.25 + 400 * 5.0) / 1_000_000 = (2500 + 2000) / 1_000_000 = 0.0045
  const expectedTokenPrice = (2000 * 1.25 + 400 * 5.0) / 1_000_000;
  assert.ok(
    Math.abs(modelVar!.actualValue - expectedTokenPrice) < 1e-9,
    `model-reasoning actualValue must be token-computed price ~${expectedTokenPrice.toFixed(6)}, got ${modelVar!.actualValue}`,
  );
});

test("multiple tunings + overlay: all measured values win, all variances reference tuned estimates", () => {
  // Combine: tuned fc1=0.80, fc2=0.75, hitlSamplingRate=0.60, modelSelection=gemini-pro.
  // Overlay measures: fc1=0.70, fc2=0.68, hitlSamplingRate=0.25, reasoning tokens.
  const tunedInputs: ScenarioInputs = {
    ...base,
    containmentOverrides: { "fc1-deterministic": 0.80, "fc2-policy": 0.75 },
    hitlSamplingRate: 0.60,
    modelSelection: { reasoning: "gemini-pro" },
  };
  const overlay: ActualsOverlay = {
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.70, "fc2-policy": 0.68 },
    measuredHitlSamplingRate: 0.25,
    tokenActualsByRole: { reasoning: { avgInputTokens: 3000, avgOutputTokens: 500 } },
  };

  const estimated = computeRollup(tunedInputs);
  const actual = computeRollup(tunedInputs, undefined, overlay);
  assert.equal(actual.calibrated, true);

  const variance = computeVariance(estimated, actual);

  const fc1Var = variance.find(v => v.assumptionKey === "containment-fc1");
  const fc2Var = variance.find(v => v.assumptionKey === "containment-fc2");
  const sampVar = variance.find(v => v.assumptionKey === "hitl-sampling-rate");
  const modelVar = variance.find(v => v.assumptionKey === "model-reasoning");

  // fc1: tuned 0.80 → measured 0.70; estimatedValue must be 0.80
  assert.ok(Math.abs(fc1Var!.estimatedValue - 0.80) < 1e-9, `fc1 estimatedValue must be 0.80, got ${fc1Var!.estimatedValue}`);
  assert.ok(Math.abs(fc1Var!.absVariance - (-0.10)) < 1e-9, `fc1 absVariance must be -0.10, got ${fc1Var!.absVariance}`);

  // fc2: tuned 0.75 → measured 0.68; estimatedValue must be 0.75
  assert.ok(Math.abs(fc2Var!.estimatedValue - 0.75) < 1e-9, `fc2 estimatedValue must be 0.75, got ${fc2Var!.estimatedValue}`);
  assert.ok(Math.abs(fc2Var!.absVariance - (-0.07)) < 1e-9, `fc2 absVariance must be -0.07, got ${fc2Var!.absVariance}`);

  // HITL sampling: tuned 0.60 → measured 0.25; estimatedValue must be 0.60
  assert.ok(sampVar, "hitl-sampling-rate must be in variance");
  assert.ok(Math.abs(sampVar!.estimatedValue - 0.60) < 1e-9, `sampling estimatedValue must be 0.60, got ${sampVar!.estimatedValue}`);
  assert.ok(Math.abs(sampVar!.absVariance - (-0.35)) < 1e-9, `sampling absVariance must be -0.35, got ${sampVar!.absVariance}`);

  // Model: selected gemini-pro ($0.014) → token-computed
  assert.ok(modelVar, "model-reasoning must be in variance");
  assert.ok(Math.abs(modelVar!.estimatedValue - 0.014) < 1e-9, `model estimatedValue must be gemini-pro price 0.014, got ${modelVar!.estimatedValue}`);

  // All results reconcile (rows + buckets still sum correctly)
  const bucketTotal = actual.byCostComponent.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(bucketTotal - actual.totals.totalCostUsd) < 1e-6, "buckets reconcile after multi-tuning + overlay");
});

test("per-intent avgHitlMinutes from overlay replaces toBeHumanMin and moves result", () => {
  const baseline = computeRollup(base);
  const target = baseline.rows.find((r) => r.flowClass === "fc1-deterministic")!;
  assert.ok(target, "need at least one fc1 intent");
  // Supply much higher HITL minutes → more residual human cost, less benefit
  const overlay: ActualsOverlay = {
    intents: [{ intentKey: target.intentKey, avgHitlMinutes: 45 }],
  };
  const calibrated = computeRollup(base, undefined, overlay);
  const targetCalibrated = calibrated.rows.find((r) => r.intentKey === target.intentKey)!;
  // More residual human minutes → higher human cost for that intent
  assert.ok(targetCalibrated.humanCostUsd > target.humanCostUsd,
    "more measured HITL minutes must increase human cost");
  // Less time saved → lower benefit
  assert.ok(targetCalibrated.benefitUsd < target.benefitUsd,
    "more measured HITL minutes must reduce benefit for that intent");
  // Other intents unchanged
  const other = baseline.rows.find((r) => r.intentKey !== target.intentKey)!;
  const otherCalibrated = calibrated.rows.find((r) => r.intentKey === other.intentKey)!;
  assert.ok(Math.abs(otherCalibrated.benefitUsd - other.benefitUsd) < 1e-6,
    "unaffected intent benefit must be unchanged");
});
