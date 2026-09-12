import assert from "node:assert/strict";
import { test } from "node:test";
import type { OnbOutcomeKpis } from "@workspace/api-client-react";
import {
  BottleneckSimulationInputError,
  type BottleneckStage,
  simulateBottleneckScenario,
} from "@/lib/bottleneck-simulation";
import {
  buildBottleneckControls,
  buildBottleneckSimulationInput,
  initialBottleneckFormValues,
  type BottleneckFormValues,
} from "./bottleneck-simulator";

const outcomeKpis: OnbOutcomeKpis = {
  asOf: "2025-01-31T00:00:00.000Z",
  cohortLabel: "Cases created in-period (last 30 days)",
  caseCount: 12,
  metrics: [
    {
      id: "cycle-time",
      label: "Onboarding Cycle Time",
      definition: "Days from offer acceptance to Day-1 readiness",
      baseline: "TBD",
      targetLabel: "≤ 7 days",
      targetValue: 7,
      direction: "at-most",
      unit: "days",
      value: 8,
      status: "missed",
      sampleSize: 4,
      eligibleCount: 10,
      unknownCount: 6,
      note: "",
    },
  ],
};

function formWith(
  overrides: Partial<BottleneckFormValues> = {},
): BottleneckFormValues {
  const initial = initialBottleneckFormValues();
  return {
    ...initial,
    ...overrides,
    stages: {
      ...initial.stages,
      ...(overrides.stages ?? {}),
    },
  };
}

test("form mapper omits blank stages while preserving zero and signed values", () => {
  const form = formWith({
    stages: {
      bgv: { delayDays: "", criticalPathShare: "" },
      approvals: { delayDays: "-1.5", criticalPathShare: "50" },
      documents: { delayDays: "0", criticalPathShare: "0" },
      provisioning: { delayDays: "", criticalPathShare: "" },
    },
  });

  assert.deepEqual(buildBottleneckControls(form.stages), {
    approvals: { delayDays: "-1.5", criticalPathShare: "50" },
    documents: { delayDays: "0", criticalPathShare: "0" },
  });
});

test("measured mode uses the DTO and never substitutes the manual value", () => {
  const form = formWith({
    baselineSource: "measured",
    manualBaselineDays: "0",
    comparisonThresholdDays: "0",
  });
  const input = buildBottleneckSimulationInput(form, outcomeKpis);

  assert.equal(input.outcomeKpis, outcomeKpis);
  assert.equal(input.manualBaselineDays, undefined);
  assert.equal(input.comparisonThresholdDays, "0");
  assert.equal(
    simulateBottleneckScenario(input).baseline.source,
    "measured",
  );
});

test("manual mode explicitly nulls measured DTO and preserves a zero baseline", () => {
  const form = formWith({
    baselineSource: "manual",
    manualBaselineDays: "0",
    comparisonThresholdDays: "0",
  });
  const input = buildBottleneckSimulationInput(form, outcomeKpis);

  assert.equal(input.outcomeKpis, null);
  assert.equal(input.manualBaselineDays, "0");
  assert.equal(input.comparisonThresholdDays, "0");
  const result = simulateBottleneckScenario(input);
  assert.equal(result.baseline.source, "assumed");
  assert.equal(result.baselineMeanDays, 0);
  assert.equal(result.scenarioMeanDays, 0);
});

test("partially filled stage stays invalid so the canonical error can be shown", () => {
  const form = formWith({
    baselineSource: "manual",
    manualBaselineDays: "5",
    stages: {
      bgv: { delayDays: "", criticalPathShare: "50" },
    } as BottleneckFormValues["stages"],
  });
  const input = buildBottleneckSimulationInput(form, outcomeKpis);

  assert.throws(
    () => simulateBottleneckScenario(input),
    (error: unknown) => {
      assert.ok(error instanceof BottleneckSimulationInputError);
      assert.match(error.message, /controls\.bgv\.delayDays/);
      return true;
    },
  );
});

test("all canonical stages remain available to the form mapper", () => {
  const form = initialBottleneckFormValues();
  const stageNames = Object.keys(form.stages).sort() as BottleneckStage[];
  assert.deepEqual(stageNames, [
    "approvals",
    "bgv",
    "documents",
    "provisioning",
  ]);
});