import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutcomeKpisGrid, STATIC_KPIS } from "./outcome-kpis";
import type { OnbOutcomeKpi } from "@workspace/api-client-react";

function render(props: React.ComponentProps<typeof OutcomeKpisGrid>): string {
  return renderToStaticMarkup(<OutcomeKpisGrid {...props} />);
}

function mockKpi(partial: Partial<OnbOutcomeKpi>): OnbOutcomeKpi {
  return {
    id: "test",
    label: "Test",
    definition: "Test definition",
    baseline: "TBD",
    targetLabel: "TBD",
    targetValue: 0,
    direction: "at-most",
    unit: "percent",
    value: null,
    status: "not-collected",
    sampleSize: 0,
    eligibleCount: 0,
    unknownCount: 0,
    note: "",
    ...partial,
  };
}

test("shows all 7 static KPIs when loading with no data", () => {
  const html = render({
    metrics: [],
    isLoading: true,
    isError: false,
  });

  // Verify all 7 KPIs are present
  for (const kpi of STATIC_KPIS) {
    assert.ok(html.includes(kpi.label), `Missing label: ${kpi.label}`);
    assert.ok(html.includes(kpi.definition), `Missing definition: ${kpi.definition}`);
    assert.match(html, /Not yet measured/);
  }
  
  // Verify loading state is shown (spinner class)
  assert.match(html, /animate-spin/);
});

test("shows error alert and keeps the 7 KPI layout when isError is true", () => {
  const html = render({
    metrics: [],
    isLoading: false,
    isError: true,
  });

  assert.match(html, /Failed to load outcomes/);
  assert.match(html, /Retry/);
  
  // Verify all 7 KPIs are still present
  for (const kpi of STATIC_KPIS) {
    assert.ok(html.includes(kpi.label), `Missing label: ${kpi.label}`);
  }
});

test("displays valid KPI values correctly (met, missed, format)", () => {
  const html = render({
    metrics: [
      mockKpi({
        id: "cycle-time",
        label: "Onboarding Cycle Time",
        definition: "Time from offer acceptance to completion of all mandatory onboarding steps.",
        baseline: "TBD",
        targetLabel: "<=7days",
        targetValue: 7,
        direction: "at-most",
        unit: "days",
        value: 5.5,
        status: "met",
        sampleSize: 42,
        unknownCount: 3,
      }),
      mockKpi({
        id: "enps",
        label: "New-Hire Experience (eNPS)",
        definition: "Employee Net Promoter Score measured from the 30-day onboarding survey.",
        baseline: "TBD",
        targetLabel: ">=+40",
        targetValue: 40,
        direction: "at-least",
        unit: "score",
        value: 30,
        status: "missed",
        sampleSize: 15,
        unknownCount: 0,
      })
    ],
    isLoading: false,
    isError: false,
  });

  // Check successful metric rendering
  assert.match(html, /5\.5 days/);
  assert.match(html, /Target met/);
  assert.match(html, /Sample:/);
  assert.match(html, /42/);
  assert.match(html, /Missing:/);
  assert.match(html, /3/);
  
  // Check missed metric rendering
  assert.match(html, /\+30/); // formatValue formats score > 0 with +
  assert.match(html, /Target missed/);
  assert.match(html, /15/);
  // Other KPIs should still be rendered as 'Not yet measured'
  assert.match(html, /Day-1 Readiness Rate/);
});

test("displays zero values accurately rather than hiding them", () => {
  const html = render({
    metrics: [
      mockKpi({
        id: "attrition",
        label: "0–90 Day Attrition",
        definition: "Percentage of new hires departing the organization voluntarily or involuntarily within 90 days.",
        baseline: "TBD",
        targetLabel: "<=3%",
        targetValue: 3,
        direction: "at-most",
        unit: "percent",
        value: 0,
        status: "met",
        sampleSize: 50,
      })
    ],
    isLoading: false,
    isError: false,
  });

  assert.match(html, /0%/); // should render 0% rather than "Not yet measured"
  assert.match(html, /Target met/);
});

test("handles null values or insufficient-data status explicitly", () => {
  const html = render({
    metrics: [
      mockKpi({
        id: "day1-readiness",
        label: "Day-1 Readiness Rate",
        definition: "Percentage of new hires with all access, hardware, and orientation scheduled by Day 1.",
        baseline: "TBD",
        targetLabel: ">=98%",
        targetValue: 98,
        direction: "at-least",
        unit: "percent",
        value: null,
        status: "insufficient-data",
        note: "Wait until cohort reaches day 1",
      })
    ],
    isLoading: false,
    isError: false,
  });

  assert.match(html, /Not yet measured/);
  assert.match(html, /Wait until cohort reaches day 1/);
  assert.doesNotMatch(html, /Target met/);
  assert.doesNotMatch(html, /Target missed/);
});

test("renders cohort label and case count when provided", () => {
  const html = render({
    metrics: [],
    isLoading: false,
    isError: false,
    cohortLabel: "Past 30 Days (EMEA)",
    caseCount: 154,
  });

  assert.match(html, /Past 30 Days \(EMEA\)/);
  assert.match(html, /154 cases/);
});

test("does not render stale target met status when isError is true", () => {
  const html = render({
    metrics: [
      mockKpi({
        id: "cycle-time",
        label: "Onboarding Cycle Time",
        definition: "Time from offer acceptance to completion of all mandatory onboarding steps.",
        baseline: "TBD",
        targetLabel: "<=7days",
        targetValue: 7,
        direction: "at-most",
        unit: "days",
        value: 5.5,
        status: "met",
      })
    ],
    isLoading: false,
    isError: true,
  });

  assert.doesNotMatch(html, /Target met/);
  assert.doesNotMatch(html, /5\.5 days/);
  assert.match(html, /Unavailable/);
});

