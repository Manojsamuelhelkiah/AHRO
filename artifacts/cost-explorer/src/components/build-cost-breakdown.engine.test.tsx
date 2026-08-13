// End-to-end reconciliation: render the demarcation strip and Build Cost
// Breakdown table from a rollup computed by the REAL api-server engine (not a
// hand-built fixture), and assert the quotable strip numbers reconcile with
// the table footer. Closes the gap where the engine could change how
// demarcationSplit relates to buildBreakdown/totals without the UI test noticing.
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  computeRollup,
  type ScenarioInputs,
} from "../../../api-server/src/lib/rollup";
import {
  DemarcationSplitStrip,
  BuildBreakdownTable,
  type BuildCostRollupSlice,
} from "./build-cost-breakdown";
import { formatCurrency } from "../lib/format";

// Representative scenario: mirrors the base fixture used across engine tests,
// with a non-default contract term so custom annualization is exercised.
const inputs: ScenarioInputs = {
  numSystems: 4,
  annualTransactions: 120000,
  employees: 8000,
  sector: "manufacturing",
  companyType: "multi-country",
  isolationTier: "siloed",
  hrHourlyCostUsd: 38,
  hitlHourlyCostUsd: 42,
  countries: 6,
  adoptionRate: 0.6,
  contractYears: 4,
};

const rollup = computeRollup(inputs);
// The engine Rollup is a structural superset of the UI slice.
const slice: BuildCostRollupSlice = rollup;

const extract = (html: string, testId: string): string => {
  const re = new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`);
  const m = html.match(re);
  assert.ok(m, `element with data-testid="${testId}" not rendered`);
  return m![1];
};

test("engine rollup: core + custom annual reconcile with total build cost", () => {
  const ds = rollup.demarcationSplit;
  assert.ok(ds.coreAnnualUsd > 0, "core annual is positive");
  assert.ok(ds.customAnnualUsd > 0, "custom annual is positive");
  assert.ok(
    Math.abs(ds.coreAnnualUsd + ds.customAnnualUsd - rollup.totals.buildCostUsd) < 1e-6,
    "core + custom annual must equal total build cost",
  );
  const rowSum = rollup.buildBreakdown.reduce((a, c) => a + c.annualUsd, 0);
  assert.ok(Math.abs(rowSum - rollup.totals.buildCostUsd) < 1e-6, "row sum reconciles");
});

test("strip and table render exact engine amounts through the shared formatter", () => {
  const stripHtml = renderToStaticMarkup(<DemarcationSplitStrip split={slice.demarcationSplit} />);
  const tableHtml = renderToStaticMarkup(<BuildBreakdownTable rollup={slice} />);

  assert.equal(
    extract(stripHtml, "demarcation-core-annual"),
    formatCurrency(rollup.demarcationSplit.coreAnnualUsd, true),
  );
  assert.equal(
    extract(stripHtml, "demarcation-custom-annual"),
    formatCurrency(rollup.demarcationSplit.customAnnualUsd, true),
  );
  assert.equal(
    extract(tableHtml, "breakdown-annual-total"),
    formatCurrency(rollup.totals.buildCostUsd, true),
  );
  assert.equal(
    extract(tableHtml, "breakdown-onetime-total"),
    formatCurrency(rollup.buildBreakdown.reduce((a, c) => a + c.oneTimeUsd, 0), true),
  );
  // Every engine breakdown row is rendered.
  for (const c of rollup.buildBreakdown) {
    assert.match(tableHtml, new RegExp(`data-testid="badge-provisioning-${c.key}"`));
  }
});

test("rendered strip amounts reconcile numerically with the table footer", () => {
  const stripHtml = renderToStaticMarkup(<DemarcationSplitStrip split={slice.demarcationSplit} />);
  const tableHtml = renderToStaticMarkup(<BuildBreakdownTable rollup={slice} />);

  const parseCompactUsd = (s: string): number => {
    const m = s.match(/^\$([\d.]+)([KMB])?$/);
    assert.ok(m, `unparseable currency string: ${s}`);
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[m![2] as "K" | "M" | "B"] ?? 1;
    return parseFloat(m![1]) * mult;
  };

  const coreAnnual = parseCompactUsd(extract(stripHtml, "demarcation-core-annual"));
  const customAnnual = parseCompactUsd(extract(stripHtml, "demarcation-custom-annual"));
  const footerAnnual = parseCompactUsd(extract(tableHtml, "breakdown-annual-total"));

  // Tolerance covers compact-notation rounding (1 decimal digit per figure).
  const tolerance = footerAnnual * 0.05 + 1;
  assert.ok(
    Math.abs(coreAnnual + customAnnual - footerAnnual) <= tolerance,
    `strip (${coreAnnual} + ${customAnnual}) drifted from footer ${footerAnnual}`,
  );
});
