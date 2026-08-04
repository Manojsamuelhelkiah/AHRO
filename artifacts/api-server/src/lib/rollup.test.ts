import test from "node:test";
import assert from "node:assert/strict";
import { computeRollup, computeShares, manualActionFractions, type ScenarioInputs } from "./rollup";
import { intentMap } from "../data/intents";
import { flowClassMap } from "../data/flow-classes";
import { componentSumFor } from "../data/build-components";
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
  const row = withOv.rows.find((r) => r.intentKey === target.intentKey)!;
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
  // sf-ec appears in act steps of fc1/fc3/fc4 flows: marking it non-integrated
  // must lower AI/infra-side MCP cost but raise human cost and cut benefit.
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
  // Intents that never touch sf-ec are unchanged.
  const untouched = integrated.rows.find(
    (r) => partial.rows.find((p) => p.intentKey === r.intentKey)!.netUsd === r.netUsd,
  );
  assert.ok(untouched, "at least one intent is unaffected");
  // Applied assumptions surface the manual-handling assumption only when used.
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
  // Excluding all act-stage systems moves all GET work to manual.
  const all = manualActionFractions(it, {
    ...base,
    nonIntegratedSystems: ["sf-ec", "sf-ecp"],
  });
  assert.equal(all.getFrac, 1);
  // Excluding a system touched only outside the act stage (ticketing, close
  // step) changes nothing — and the manual-handling assumption is not surfaced.
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
  const it = intentMap["payslip-copy"]!; // act step: sf-ec + sf-ecp, both get, both scale
  const bigBase = { ...base, numSystems: 12 };
  const none = manualActionFractions(it, bigBase);
  const one = manualActionFractions(it, { ...bigBase, nonIntegratedSystems: ["sf-ec"] });
  // Total scaled action units are conserved: excluding a system moves units
  // from automated to manual one-for-one, never creating or destroying work.
  assert.ok(Math.abs(none.automatedUnits - (one.automatedUnits + one.manualUnits)) < 1e-9);
  // Both act touches carry equal fan-out weight, so exactly half moves.
  assert.ok(Math.abs(one.manualUnits - none.automatedUnits / 2) < 1e-9);
  // Fan-out grows the units with the landscape and with maturity.
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
  // Platform component one-time costs decompose the flow-class build costs.
  const platform = r.buildBreakdown.filter((c) => c.kind === "platform");
  const oneTime = platform.reduce((a, c) => a + c.oneTimeUsd, 0);
  assert.ok(Math.abs(oneTime - (18000 + 45000 + 120000 + 250000)) < 1e-6); // maturity mixed = 1.0
  // Legacy maturity scales platform components but not onboarding drivers.
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
