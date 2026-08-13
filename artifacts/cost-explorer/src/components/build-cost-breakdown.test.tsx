// UI-level reconciliation test: the quotable core/custom strip must render the
// SAME amounts as the Build Cost Breakdown table footer. Guards against a
// formatting or field-mix-up regression silently showing clients a wrong
// quotable number.
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DemarcationSplitStrip,
  BuildBreakdownTable,
  type BuildCostRollupSlice,
} from "./build-cost-breakdown";
import { formatCurrency } from "../lib/format";

// ─── Fixture rollup (core annual + custom annual === total build cost) ──────

const fixture: BuildCostRollupSlice = {
  demarcationSplit: {
    coreAnnualUsd: 41_250,
    coreOneTimeUsd: 495_000,
    customOneTimeUsd: 186_000,
    customAnnualUsd: 62_000,
    contractYears: 3,
    configurableDials: [{ label: "Containment rates" }, { label: "Adoption ramp" }],
  },
  buildBreakdown: [
    {
      key: "orchestrator",
      name: "Agent Orchestrator",
      description: "Core platform runtime",
      kind: "platform",
      provisioning: "core",
      oneTimeUsd: 495_000,
      annualUsd: 41_250,
    },
    {
      key: "sys-integrations",
      name: "System Integrations",
      description: "Client-specific connectors",
      kind: "integration",
      provisioning: "custom",
      oneTimeUsd: 150_000,
      annualUsd: 50_000,
    },
    {
      key: "onboarding",
      name: "Client Onboarding",
      description: "Per-client implementation",
      kind: "services",
      provisioning: "custom",
      oneTimeUsd: 36_000,
      annualUsd: 12_000,
    },
  ],
  totals: { buildCostUsd: 103_250 },
};

const extract = (html: string, testId: string): string => {
  // Grab the inner text of the element carrying the given data-testid.
  const re = new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`);
  const m = html.match(re);
  assert.ok(m, `element with data-testid="${testId}" not rendered`);
  return m![1];
};

test("fixture is internally consistent (core + custom annual = total build cost = row sum)", () => {
  const { coreAnnualUsd, customAnnualUsd } = fixture.demarcationSplit;
  assert.equal(coreAnnualUsd + customAnnualUsd, fixture.totals.buildCostUsd);
  const rowSum = fixture.buildBreakdown.reduce((a, c) => a + c.annualUsd, 0);
  assert.equal(rowSum, fixture.totals.buildCostUsd);
  // And per-demarcation row sums match the strip fields.
  const sumFor = (p: string) =>
    fixture.buildBreakdown.filter(c => c.provisioning === p).reduce((a, c) => a + c.annualUsd, 0);
  assert.equal(sumFor("core"), coreAnnualUsd);
  assert.equal(sumFor("custom"), customAnnualUsd);
});

test("demarcation strip renders exact core/custom annual amounts from the rollup", () => {
  const html = renderToStaticMarkup(<DemarcationSplitStrip split={fixture.demarcationSplit} />);
  assert.equal(extract(html, "demarcation-core-annual"), formatCurrency(fixture.demarcationSplit.coreAnnualUsd, true));
  assert.equal(extract(html, "demarcation-custom-annual"), formatCurrency(fixture.demarcationSplit.customAnnualUsd, true));
  // The strip must keep its stable testids for the page-level KPI strip.
  assert.match(html, /data-testid="demarcation-split"/);
  assert.match(html, /data-testid="demarcation-core"/);
  assert.match(html, /data-testid="demarcation-custom"/);
});

test("strip amounts reconcile with the breakdown table footer (no drift)", () => {
  const stripHtml = renderToStaticMarkup(<DemarcationSplitStrip split={fixture.demarcationSplit} />);
  const tableHtml = renderToStaticMarkup(<BuildBreakdownTable rollup={fixture} />);

  const parseCompactUsd = (s: string): number => {
    const m = s.match(/^\$([\d.]+)([KMB])?$/);
    assert.ok(m, `unparseable currency string: ${s}`);
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[m![2] as "K" | "M" | "B"] ?? 1;
    return parseFloat(m![1]) * mult;
  };

  const coreAnnual = parseCompactUsd(extract(stripHtml, "demarcation-core-annual"));
  const customAnnual = parseCompactUsd(extract(stripHtml, "demarcation-custom-annual"));
  const footerAnnual = parseCompactUsd(extract(tableHtml, "breakdown-annual-total"));

  // Core annual + custom annual must equal the total build cost shown in the
  // table footer. Tolerance covers compact-notation rounding (1 decimal digit).
  const tolerance = footerAnnual * 0.05 + 1;
  assert.ok(
    Math.abs(coreAnnual + customAnnual - footerAnnual) <= tolerance,
    `strip (${coreAnnual} + ${customAnnual}) drifted from footer ${footerAnnual}`,
  );
  // Exact string-level check: footer must be formatted from totals.buildCostUsd
  // with the same formatter the strip uses.
  assert.equal(extract(tableHtml, "breakdown-annual-total"), formatCurrency(fixture.totals.buildCostUsd, true));
  // One-time footer must equal the sum of row one-time costs.
  assert.equal(
    extract(tableHtml, "breakdown-onetime-total"),
    formatCurrency(fixture.buildBreakdown.reduce((a, c) => a + c.oneTimeUsd, 0), true),
  );
});

test("breakdown table renders each row's annual amount with the shared formatter", () => {
  const html = renderToStaticMarkup(<BuildBreakdownTable rollup={fixture} />);
  for (const c of fixture.buildBreakdown) {
    assert.match(html, new RegExp(`data-testid="badge-provisioning-${c.key}"`));
    assert.ok(html.includes(formatCurrency(c.annualUsd, true)), `row amount missing for ${c.key}`);
  }
});
