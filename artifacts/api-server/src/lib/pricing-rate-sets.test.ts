/**
 * Unit tests for the pricing rate set validation, baseline seeding, and rollup integration.
 * No live DB required — tests use in-process code only.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateRateSnapshot,
  validateRateSetBody,
  buildBaselineRates,
  MODEL_CATALOG_KEYS,
  FLOW_BUILD_COST_KEYS,
  type PricingRateSnapshot,
} from "./pricing-rate-sets";
import { computeRollup, type ScenarioInputs } from "./rollup";
import { computeSensitivity } from "./sensitivity";
import { assumptionMap } from "../data/assumptions";
import { modelCatalog } from "../data/model-catalog";
import { flowClasses } from "../data/flow-classes";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a valid complete baseline snapshot. */
function validSnapshot(): PricingRateSnapshot {
  return buildBaselineRates();
}

const baseInputs: ScenarioInputs = {
  numSystems: 4,
  annualTransactions: 120_000,
  employees: 8_000,
  sector: "manufacturing",
  companyType: "multi-country",
  isolationTier: "siloed",
  hrHourlyCostUsd: 38,
  hitlHourlyCostUsd: 42,
  countries: 6,
};

// ─── Snapshot completeness validation ─────────────────────────────────────────

test("validateRateSnapshot: valid complete snapshot passes", () => {
  const result = validateRateSnapshot(validSnapshot());
  assert.equal(result.valid, true, `Errors: ${result.errors.join("; ")}`);
  assert.equal(result.errors.length, 0);
});

test("validateRateSnapshot: missing top-level key fails", () => {
  const snap = validSnapshot() as unknown as Record<string, unknown>;
  delete snap["slmCallCost"];
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("slmCallCost")));
});

test("validateRateSnapshot: NaN value fails as unsafe", () => {
  const snap = validSnapshot();
  snap.llmCallCost = NaN;
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("llmCallCost")));
});

test("validateRateSnapshot: Infinity value fails as unsafe", () => {
  const snap = validSnapshot();
  snap.mcpActionCost = Infinity;
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("mcpActionCost")));
});

test("validateRateSnapshot: negative value fails", () => {
  const snap = validSnapshot();
  snap.infraPerTxn = -1;
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("infraPerTxn")));
});

test("validateRateSnapshot: implausibly large finite value fails as unsafe", () => {
  const snap = validSnapshot();
  snap.supportHourlyCostUsd = 100_001;
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("supportHourlyCostUsd")));
});

test("validateRateSnapshot: unknown rate key fails", () => {
  const snap = validSnapshot() as unknown as Record<string, unknown>;
  snap["retiredVendorRate"] = 1;
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("retiredVendorRate")));
});

test("validateRateSnapshot: default model per-call rate must match its role default", () => {
  const snap = validSnapshot();
  snap.modelRates["gpt-5-mini"] = {
    ...snap.modelRates["gpt-5-mini"]!,
    pricePerCallUsd: snap.slmCallCost + 0.001,
  };
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("gpt-5-mini")));
});

test("validateRateSnapshot: missing model catalog entry fails", () => {
  const snap = validSnapshot();
  const mr = { ...snap.modelRates };
  const firstKey = MODEL_CATALOG_KEYS[0]!;
  delete mr[firstKey];
  snap.modelRates = mr;
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes(firstKey)));
});

test("validateRateSnapshot: missing model sub-field fails", () => {
  const snap = validSnapshot();
  const firstKey = MODEL_CATALOG_KEYS[0]!;
  const mr = { ...snap.modelRates, [firstKey]: { pricePerCallUsd: 0.01 } };
  snap.modelRates = mr as typeof snap.modelRates;
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes(firstKey)));
});

test("validateRateSnapshot: all 4 flow build rates required", () => {
  for (const fcKey of FLOW_BUILD_COST_KEYS) {
    const snap = validSnapshot();
    const fb = { ...snap.flowBuildRates };
    delete fb[fcKey];
    snap.flowBuildRates = fb;
    const result = validateRateSnapshot(snap);
    assert.equal(result.valid, false, `Expected failure for missing ${fcKey}`);
    assert.ok(result.errors.some((e) => e.includes(fcKey)), `Error should mention ${fcKey}`);
  }
});

test("validateRateSnapshot: zero amortizationTransactions fails", () => {
  const snap = validSnapshot();
  const firstFc = FLOW_BUILD_COST_KEYS[0]!;
  snap.flowBuildRates = {
    ...snap.flowBuildRates,
    [firstFc]: { buildCostUsd: 18000, amortizationTransactions: 0 },
  };
  const result = validateRateSnapshot(snap);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("amortizationTransactions")));
});

test("validateRateSnapshot: non-object input fails immediately", () => {
  const result = validateRateSnapshot(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

// ─── RateSetBody validation ──────────────────────────────────────────────────

test("validateRateSetBody: valid body passes", () => {
  const result = validateRateSetBody({
    effectiveDate: "2025-06-01",
    rationale: "Initial baseline",
    rates: validSnapshot(),
  });
  assert.equal(result.valid, true, `Errors: ${result.errors.join("; ")}`);
});

test("validateRateSetBody: blank rationale fails", () => {
  const result = validateRateSetBody({
    effectiveDate: "2025-06-01",
    rationale: "   ",
    rates: validSnapshot(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("rationale")));
});

test("validateRateSetBody: missing effectiveDate fails", () => {
  const result = validateRateSetBody({
    rationale: "Valid rationale",
    rates: validSnapshot(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("effectiveDate")));
});

test("validateRateSetBody: invalid date format fails", () => {
  const result = validateRateSetBody({
    effectiveDate: "01-06-2025",
    rationale: "Valid rationale",
    rates: validSnapshot(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("effectiveDate")));
});

test("validateRateSetBody: impossible calendar date fails", () => {
  const result = validateRateSetBody({
    effectiveDate: "2026-02-30",
    rationale: "Invalid date must not reach the database",
    rates: validSnapshot(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("effectiveDate")));
});

test("validateRateSetBody: future effectiveDate is allowed (scheduled)", () => {
  const result = validateRateSetBody({
    effectiveDate: "2099-01-01",
    rationale: "Scheduled future version",
    rates: validSnapshot(),
  });
  assert.equal(result.valid, true, `Errors: ${result.errors.join("; ")}`);
});

test("validateRateSetBody: unsafe rate in body fails", () => {
  const snap = validSnapshot();
  snap.frontierCallCost = NaN;
  const result = validateRateSetBody({
    effectiveDate: "2025-06-01",
    rationale: "Valid rationale",
    rates: snap,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("frontierCallCost")));
});

// ─── Baseline parity ─────────────────────────────────────────────────────────

test("buildBaselineRates: all model catalog keys are present", () => {
  const baseline = buildBaselineRates();
  for (const key of MODEL_CATALOG_KEYS) {
    assert.ok(baseline.modelRates[key], `Model key ${key} should be in baseline`);
  }
});

test("buildBaselineRates: model rates match code catalog", () => {
  const baseline = buildBaselineRates();
  for (const m of modelCatalog) {
    const br = baseline.modelRates[m.key];
    assert.ok(br, `${m.key} should be in baseline`);
    assert.equal(br.pricePerCallUsd, m.pricePerCallUsd, `${m.key} pricePerCallUsd`);
    assert.equal(br.inputPricePerMillionTokens, m.inputPricePerMillionTokens, `${m.key} inputPricePerMillionTokens`);
    assert.equal(br.outputPricePerMillionTokens, m.outputPricePerMillionTokens, `${m.key} outputPricePerMillionTokens`);
  }
});

test("buildBaselineRates: AI call costs match assumptions", () => {
  const baseline = buildBaselineRates();
  assert.equal(baseline.slmCallCost, assumptionMap["slm-call-cost"]!.value);
  assert.equal(baseline.llmCallCost, assumptionMap["llm-call-cost"]!.value);
  assert.equal(baseline.frontierCallCost, assumptionMap["frontier-call-cost"]!.value);
  assert.equal(baseline.dataCallCost, assumptionMap["data-call-cost"]!.value);
  assert.equal(baseline.mcpActionCost, assumptionMap["mcp-action-cost"]!.value);
  assert.equal(baseline.infraPerTxn, assumptionMap["infra-per-txn"]!.value);
});

test("buildBaselineRates: flow build costs and amortization match flow-classes", () => {
  const baseline = buildBaselineRates();
  for (const fc of flowClasses) {
    const fbr = baseline.flowBuildRates[fc.key];
    assert.ok(fbr, `${fc.key} should be in baseline`);
    assert.equal(fbr.buildCostUsd, fc.buildCostUsd, `${fc.key} buildCostUsd`);
    assert.equal(fbr.amortizationTransactions, fc.amortizationTransactions, `${fc.key} amortizationTransactions`);
  }
});

test("buildBaselineRates: onboarding rates match assumptions", () => {
  const baseline = buildBaselineRates();
  assert.equal(baseline.onboardingBase, assumptionMap["onboarding-base"]!.value);
  assert.equal(baseline.onboardingPerSystem, assumptionMap["onboarding-per-system"]!.value);
  assert.equal(baseline.onboardingPerCountry, assumptionMap["onboarding-per-country"]!.value);
  assert.equal(baseline.knowledgeMaintenancePerCountry, assumptionMap["knowledge-maintenance-country"]!.value);
});

test("buildBaselineRates: passes validation", () => {
  const result = validateRateSnapshot(buildBaselineRates());
  assert.equal(result.valid, true, `Baseline should be valid: ${result.errors.join("; ")}`);
});

// ─── Rollup with rate snapshot (changed rates affect expected quote components) ──

test("rollup with baseline snapshot produces same totals as without snapshot", () => {
  const baseline = buildBaselineRates();
  const withSnapshot = computeRollup(baseInputs, undefined, undefined, [], baseline);
  const withoutSnapshot = computeRollup(baseInputs, undefined, undefined, []);
  // Totals should be identical since baseline = code constants
  assert.ok(
    Math.abs(withSnapshot.totals.totalCostUsd - withoutSnapshot.totals.totalCostUsd) < 0.01,
    `Expected total costs to match: ${withSnapshot.totals.totalCostUsd} vs ${withoutSnapshot.totals.totalCostUsd}`,
  );
  assert.ok(
    Math.abs(withSnapshot.totals.benefitUsd - withoutSnapshot.totals.benefitUsd) < 0.01,
    `Expected benefit to match: ${withSnapshot.totals.benefitUsd} vs ${withoutSnapshot.totals.benefitUsd}`,
  );
});

test("rollup snapshot: increasing slmCallCost increases AI cost", () => {
  const baseRollup = computeRollup(baseInputs);
  const snapshot = buildBaselineRates();
  snapshot.slmCallCost = snapshot.slmCallCost * 2;
  snapshot.modelRates["gpt-5-mini"]!.pricePerCallUsd = snapshot.slmCallCost;
  assert.equal(validateRateSnapshot(snapshot).valid, true);
  const higherSlm = computeRollup(baseInputs, undefined, undefined, [], snapshot);
  assert.ok(
    higherSlm.commercialSummary.annualAiCostUsd > baseRollup.commercialSummary.annualAiCostUsd,
    "Doubling SLM call cost should increase AI cost",
  );
});

test("rollup snapshot: increasing mcpActionCost increases AI cost", () => {
  const baseRollup = computeRollup(baseInputs);
  const snapshot = buildBaselineRates();
  snapshot.mcpActionCost = snapshot.mcpActionCost * 3;
  const higherMcp = computeRollup(baseInputs, undefined, undefined, [], snapshot);
  assert.ok(
    higherMcp.totals.totalCostUsd > baseRollup.totals.totalCostUsd,
    "Tripling MCP action cost should increase total cost",
  );
});

test("rollup snapshot: increasing infraPerTxn increases infra cost", () => {
  const baseRollup = computeRollup(baseInputs);
  const snapshot = buildBaselineRates();
  snapshot.infraPerTxn = snapshot.infraPerTxn * 5;
  const higherInfra = computeRollup(baseInputs, undefined, undefined, [], snapshot);
  assert.ok(
    higherInfra.commercialSummary.annualInfrastructureCostUsd > baseRollup.commercialSummary.annualInfrastructureCostUsd,
    "5x infra cost should increase infrastructure cost in commercial summary",
  );
});

test("rollup snapshot: increasing fc3 buildCostUsd increases build cost", () => {
  const baseRollup = computeRollup(baseInputs);
  const snapshot = buildBaselineRates();
  snapshot.flowBuildRates["fc3-multiagent"] = {
    buildCostUsd: snapshot.flowBuildRates["fc3-multiagent"]!.buildCostUsd * 2,
    amortizationTransactions: snapshot.flowBuildRates["fc3-multiagent"]!.amortizationTransactions,
  };
  const higherBuild = computeRollup(baseInputs, undefined, undefined, [], snapshot);
  assert.ok(
    higherBuild.totals.buildCostUsd > baseRollup.totals.buildCostUsd,
    "Doubling fc3 build cost should increase total build cost",
  );
});

test("rollup snapshot: scenario overrides still take precedence over snapshot", () => {
  const snapshot = buildBaselineRates();
  snapshot.slmCallCost = 1.0; // artificially high in snapshot
  snapshot.modelRates["gpt-5-mini"]!.pricePerCallUsd = snapshot.slmCallCost;
  assert.equal(validateRateSnapshot(snapshot).valid, true);

  const withSnapshotOnly = computeRollup(baseInputs, undefined, undefined, [], snapshot);
  const withScenarioOverride = computeRollup(
    { ...baseInputs, assumptionOverrides: { "slm-call-cost": 0.0 } },
    undefined,
    undefined,
    [],
    snapshot,
  );
  // Scenario override of 0 should produce lower AI cost than snapshot value of 1.0
  assert.ok(
    withScenarioOverride.commercialSummary.annualAiCostUsd < withSnapshotOnly.commercialSummary.annualAiCostUsd,
    "Scenario override should take precedence over snapshot",
  );
});

test("rollup snapshot: rateSetReference appears in commercialSummary when provided", () => {
  const snapshot = buildBaselineRates();
  const ref = {
    rateSetId: 42,
    effectiveDate: "2025-06-01",
    rationale: "Test ref",
    createdBy: "tester",
    createdAt: new Date().toISOString(),
  };
  const rollup = computeRollup(baseInputs, undefined, undefined, [], snapshot, ref);
  assert.ok(rollup.commercialSummary.rateSetReference, "rateSetReference should be in commercialSummary");
  assert.equal(rollup.commercialSummary.rateSetReference!.rateSetId, 42);
  assert.equal(rollup.commercialSummary.rateSetReference!.effectiveDate, "2025-06-01");
});

test("rollup snapshot: rateSetReference absent when no ref provided", () => {
  const rollup = computeRollup(baseInputs);
  assert.equal(rollup.commercialSummary.rateSetReference, undefined, "rateSetReference should be absent");
});

test("rollup snapshot: totals reconcile with rows after snapshot override", () => {
  const snapshot = buildBaselineRates();
  snapshot.slmCallCost = 0.01;
  snapshot.modelRates["gpt-5-mini"]!.pricePerCallUsd = snapshot.slmCallCost;
  snapshot.mcpActionCost = 0.02;
  assert.equal(validateRateSnapshot(snapshot).valid, true);
  const rollup = computeRollup(baseInputs, undefined, undefined, [], snapshot);
  const rowRun = rollup.rows.reduce((a, r) => a + r.runCostUsd, 0);
  const rowBuild = rollup.rows.reduce((a, r) => a + r.buildCostUsd, 0);
  assert.ok(Math.abs(rowRun - rollup.totals.runCostUsd) < 1e-4, "Row run costs should sum to totals.runCostUsd");
  assert.ok(Math.abs(rowBuild - rollup.totals.buildCostUsd) < 1e-4, "Row build costs should sum to totals.buildCostUsd");
});

test("rollup snapshot: support defaults from snapshot seed commercial assumptions", () => {
  const snapshot = buildBaselineRates();
  snapshot.supportTeamFte = 5;
  snapshot.supportHourlyCostUsd = 200;
  snapshot.supportToolingAnnualUsdPerClient = 50_000;

  const withSnapshot = computeRollup(baseInputs, undefined, undefined, [], snapshot);
  const withoutSnapshot = computeRollup(baseInputs);

  // Scenario with snapshot's higher support defaults should have higher support cost
  assert.ok(
    withSnapshot.commercialSummary.annualSupportCostUsd > withoutSnapshot.commercialSummary.annualSupportCostUsd,
    "Higher snapshot support defaults should increase support cost",
  );
});

test("rollup snapshot: explicit commercialAssumptions override snapshot support defaults", () => {
  const snapshot = buildBaselineRates();
  snapshot.supportTeamFte = 10; // high in snapshot
  snapshot.supportHourlyCostUsd = 500;

  // Explicitly override in scenario
  const withExplicitOverride = computeRollup(
    {
      ...baseInputs,
      commercialAssumptions: { supportTeamFte: 1, supportHourlyCostUsd: 60, supportToolingAnnualUsdPerClient: 5_000 },
    },
    undefined,
    undefined,
    [],
    snapshot,
  );
  const withoutSnapshot = computeRollup(baseInputs);

  // With explicit low values overriding the snapshot's high values, cost should be similar to no-snapshot case
  assert.ok(
    Math.abs(withExplicitOverride.commercialSummary.annualSupportCostUsd - withoutSnapshot.commercialSummary.annualSupportCostUsd) < 1,
    "Explicit commercialAssumptions should override snapshot support defaults",
  );
});

test("sensitivity uses the same active snapshot for its baseline and rate nudges", () => {
  const snapshot = buildBaselineRates();
  snapshot.slmCallCost *= 2;
  snapshot.modelRates["gpt-5-mini"]!.pricePerCallUsd = snapshot.slmCallCost;
  assert.equal(validateRateSnapshot(snapshot).valid, true);

  const result = computeSensitivity(baseInputs, undefined, [], undefined, snapshot);
  const expectedBaseline = computeRollup(
    baseInputs,
    undefined,
    undefined,
    [],
    snapshot,
  ).totals.netUsd;
  assert.equal(result.baselineNetUsd, expectedBaseline);

  const slmRow = result.rows.find((row) => row.key === "slm-call-cost");
  assert.ok(slmRow);
  assert.equal(slmRow.baseValue, snapshot.slmCallCost);
});

test("workbook export uses and names the exact active rate snapshot", async () => {
  const [{ buildScenarioWorkbook }, { default: ExcelJS }] = await Promise.all([
    import("./workbook"),
    import("exceljs"),
  ]);
  const baseline = buildBaselineRates();
  const changed = buildBaselineRates();
  changed.slmCallCost *= 4;
  changed.modelRates["gpt-5-mini"]!.pricePerCallUsd = changed.slmCallCost;
  assert.equal(validateRateSnapshot(changed).valid, true);

  const reference = {
    rateSetId: 42,
    effectiveDate: "2026-09-01",
    rationale: "Approved vendor list-price refresh.",
    createdBy: "Commercial Owner",
    createdAt: "2026-08-20T12:00:00.000Z",
  };
  const [baselineBuffer, changedBuffer] = await Promise.all([
    buildScenarioWorkbook(baseInputs, [], baseline, {
      ...reference,
      rateSetId: 1,
      rationale: "Baseline",
    }),
    buildScenarioWorkbook(baseInputs, [], changed, reference),
  ]);

  const baselineWorkbook = new ExcelJS.Workbook();
  const changedWorkbook = new ExcelJS.Workbook();
  await Promise.all([
    baselineWorkbook.xlsx.load(baselineBuffer as unknown as ArrayBuffer),
    changedWorkbook.xlsx.load(changedBuffer as unknown as ArrayBuffer),
  ]);

  const readmeText = changedWorkbook
    .getWorksheet("READ ME")!
    .getColumn(1)
    .values.map(String)
    .join("\n");
  assert.match(readmeText, /Rate set v42 · effective 2026-09-01/);
  assert.match(readmeText, /Approved vendor list-price refresh/);

  const assumptionSheet = changedWorkbook.getWorksheet("Assumptions")!;
  const slmRow = assumptionSheet
    .getRows(2, assumptionSheet.rowCount - 1)!
    .find((row) => row.getCell(1).value === "slm-call-cost");
  assert.equal(slmRow?.getCell(4).value, changed.slmCallCost);

  const aiReferenceTotal = (workbook: InstanceType<typeof ExcelJS.Workbook>) => {
    const sheet = workbook.getWorksheet("Flow Classes")!;
    let total = 0;
    for (let row = 2; row <= sheet.rowCount; row += 1) {
      total += Number(sheet.getCell(row, 9).value);
    }
    return total;
  };
  assert.ok(
    aiReferenceTotal(changedWorkbook) > aiReferenceTotal(baselineWorkbook),
    "Changed active AI rate should change workbook reference unit costs",
  );
});
