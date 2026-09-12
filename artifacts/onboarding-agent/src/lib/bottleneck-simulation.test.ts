import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OnbOutcomeKpi, OnbOutcomeKpis } from "@workspace/api-client-react";
import {
  BottleneckSimulationInputError,
  BOTTLENECK_STAGES,
  MAX_DAYS,
  simulateBottleneckScenario,
  type BottleneckControls,
} from "./bottleneck-simulation";

function metric(
  id: string,
  overrides: Partial<OnbOutcomeKpi> = {},
): OnbOutcomeKpi {
  return {
    id,
    label: id,
    definition: id,
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
    note: "Measured by the outcome KPI calculator.",
    ...overrides,
  };
}

function response(metrics: OnbOutcomeKpi[] = [metric("cycle-time")]): OnbOutcomeKpis {
  return {
    asOf: "2025-01-31T00:00:00.000Z",
    cohortLabel: "Cases created in-period (last 30 days)",
    caseCount: 12,
    metrics,
  };
}

function controls(
  overrides: Partial<BottleneckControls> = {},
): BottleneckControls {
  return {
    bgv: { delayDays: 0, criticalPathShare: 0 },
    approvals: { delayDays: 0, criticalPathShare: 0 },
    documents: { delayDays: 0, criticalPathShare: 0 },
    provisioning: { delayDays: 0, criticalPathShare: 0 },
    ...overrides,
  };
}

describe("bottleneck what-if simulation", () => {
  test("uses the generated cycle-time metric and preserves its cohort denominator", () => {
    const result = simulateBottleneckScenario({
      outcomeKpis: response([
        metric("cycle_time", { value: 99 }),
        metric("cycle-time", {
          value: 8,
          sampleSize: 4,
          eligibleCount: 10,
          unknownCount: 6,
        }),
      ]),
      controls: controls(),
    });

    assert.equal(result.baseline.source, "measured");
    assert.equal(result.baseline.metricId, "cycle-time");
    assert.equal(result.baselineMeanDays, 8);
    assert.equal(result.scenarioMeanDays, 8);
    assert.equal(result.cohort.sampleSize, 4);
    assert.equal(result.cohort.denominator, 10);
    assert.equal(result.cohort.unknownCount, 6);
    assert.equal(result.cohort.label, "Cases created in-period (last 30 days)");
    assert.equal(result.cohort.caseCount, 12);
  });

  test("does not invent an automatic baseline when there are no observations", () => {
    const result = simulateBottleneckScenario({
      outcomeKpis: response([
        metric("cycle-time", {
          value: null,
          status: "insufficient-data",
          sampleSize: 0,
          eligibleCount: 7,
          unknownCount: 7,
        }),
      ]),
      controls: controls({ bgv: { delayDays: 5, criticalPathShare: 100 } }),
    });

    assert.equal(result.baseline.source, "unavailable");
    assert.equal(result.baseline.label, "Unavailable");
    assert.equal(result.baseline.meanDays, null);
    assert.equal(result.scenarioMeanDays, null);
    assert.equal(result.formula, null);
    assert.equal(result.cohort.sampleSize, 0);
    assert.equal(result.cohort.denominator, 7);
    assert.match(result.warnings.join(" "), /no usable measured cycle-time/i);
  });

  test("uses an explicit manual baseline only as Assumed", () => {
    const result = simulateBottleneckScenario({
      outcomeKpis: response([]),
      manualBaselineDays: 6,
      controls: controls({ approvals: { delayDays: 2, criticalPathShare: 50 } }),
    });

    assert.equal(result.baseline.source, "assumed");
    assert.equal(result.baseline.label, "Assumed");
    assert.equal(result.baseline.meanDays, 6);
    assert.equal(result.scenarioMeanDays, 7);
    assert.match(result.warnings.join(" "), /Assumed value/);
  });

  test("applies signed, percentage-weighted controls with a transparent formula", () => {
    const result = simulateBottleneckScenario({
      outcomeKpis: response([metric("cycle-time", { value: 10 })]),
      controls: controls({
        bgv: { delayDays: 4, criticalPathShare: 50 },
        approvals: { delayDays: -2, criticalPathShare: 25 },
        documents: { delayDays: 3, criticalPathShare: 100 },
        provisioning: { delayDays: 1, criticalPathShare: 0 },
      }),
    });

    // 10 + (4*.5) + (-2*.25) + (3*1) + (1*0) = 14.5.
    assert.equal(result.scenarioMeanDays, 14.5);
    assert.equal(result.deltaDays, 4.5);
    assert.equal(result.floorApplied, false);
    assert.equal(result.formula, "max(0, baselineMeanDays + Σ(delayDays × criticalPathShare / 100))");
    assert.deepEqual(
      result.contributions.map((item) => item.contributionDays),
      [2, -0.5, 3, 0],
    );
  });

  test("classifies only the scenario mean against an explicit assumed threshold", () => {
    const result = simulateBottleneckScenario({
      outcomeKpis: response([metric("cycle-time", { value: 7 })]),
      comparisonThresholdDays: 8,
      controls: controls({ bgv: { delayDays: 2, criticalPathShare: 50 } }),
    });

    assert.deepEqual(result.comparison, {
      thresholdDays: 8,
      thresholdLabel: "Assumed comparison threshold",
      classification: "at-or-below",
      basis: "scenario-mean-only",
    });
    assert.match(result.warnings.join(" "), /does not estimate SLA violations/i);
    assert.ok(
      !("slaViolationFraction" in result) &&
        !("onTimeCaseCount" in result),
    );
  });

  test("publishes BGV observed metadata only when the BGV KPI is a real usable observation", () => {
    const withBgv = simulateBottleneckScenario({
      outcomeKpis: response([
        metric("cycle-time", { value: 8 }),
        metric("bgv-turnaround", {
          value: 3,
          status: "met",
          sampleSize: 2,
          eligibleCount: 10,
          unknownCount: 8,
        }),
      ]),
      controls: controls(),
    });
    assert.equal(withBgv.bgvObserved?.metricId, "bgv-turnaround");
    assert.equal(withBgv.bgvObserved?.meanDays, 3);
    assert.equal(withBgv.bgvObserved?.sampleSize, 2);
    assert.equal(withBgv.bgvObserved?.denominator, 10);

    const unavailableBgv = simulateBottleneckScenario({
      outcomeKpis: response([
        metric("cycle-time", { value: 8 }),
        metric("bgv-turnaround", {
          value: null,
          status: "not-collected",
          sampleSize: 0,
        }),
      ]),
      controls: controls(),
    });
    assert.equal(unavailableBgv.bgvObserved, null);
  });

  test("rejects negative and oversized measured source days, while accepting zero", () => {
    for (const value of [-0.001, MAX_DAYS + 0.001]) {
      const invalidCycle = simulateBottleneckScenario({
        outcomeKpis: response([metric("cycle-time", { value })]),
        controls: controls(),
      });
      assert.equal(invalidCycle.baseline.source, "unavailable");
      assert.equal(invalidCycle.baseline.label, "Unavailable");
      assert.equal(invalidCycle.baseline.meanDays, null);
      assert.equal(invalidCycle.scenarioMeanDays, null);
      assert.match(
        invalidCycle.warnings.join(" "),
        /no usable measured cycle-time observation/i,
      );
    }

    const zeroCycle = simulateBottleneckScenario({
      outcomeKpis: response([metric("cycle-time", { value: 0 })]),
      controls: controls(),
    });
    assert.equal(zeroCycle.baseline.source, "measured");
    assert.equal(zeroCycle.baselineMeanDays, 0);
    assert.equal(zeroCycle.scenarioMeanDays, 0);

    for (const value of [-0.001, MAX_DAYS + 0.001]) {
      const invalidBgv = simulateBottleneckScenario({
        outcomeKpis: response([
          metric("cycle-time", { value: 8 }),
          metric("bgv-turnaround", { value }),
        ]),
        controls: controls(),
      });
      assert.equal(invalidBgv.baseline.source, "measured");
      assert.equal(invalidBgv.bgvObserved, null);
    }

    const zeroBgv = simulateBottleneckScenario({
      outcomeKpis: response([
        metric("cycle-time", { value: 8 }),
        metric("bgv-turnaround", { value: 0 }),
      ]),
      controls: controls(),
    });
    assert.equal(zeroBgv.bgvObserved?.meanDays, 0);
  });

  test("is monotonic for positive independent delays", () => {
    const base = simulateBottleneckScenario({
      outcomeKpis: response([metric("cycle-time", { value: 8 })]),
      controls: controls(),
    });
    const larger = simulateBottleneckScenario({
      outcomeKpis: response([metric("cycle-time", { value: 8 })]),
      controls: controls({
        approvals: { delayDays: 3, criticalPathShare: 50 },
      }),
    });

    assert.equal(base.scenarioMeanDays, 8);
    assert.ok(
      larger.scenarioMeanDays !== null &&
        base.scenarioMeanDays !== null &&
        larger.scenarioMeanDays >= base.scenarioMeanDays,
    );
  });

  test("preserves zero identity and floors negative scenarios at zero", () => {
    const identity = simulateBottleneckScenario({
      outcomeKpis: response([metric("cycle-time", { value: 0 })]),
      controls: controls(),
    });
    assert.equal(identity.scenarioMeanDays, 0);
    assert.equal(identity.deltaDays, 0);
    assert.equal(identity.floorApplied, false);

    const floored = simulateBottleneckScenario({
      outcomeKpis: response([metric("cycle-time", { value: 2 })]),
      controls: controls({
        bgv: { delayDays: -10, criticalPathShare: 100 },
      }),
    });
    assert.equal(floored.unflooredScenarioMeanDays, -8);
    assert.equal(floored.scenarioMeanDays, 0);
    assert.equal(floored.deltaDays, -2);
    assert.equal(floored.floorApplied, true);
    assert.match(floored.warnings.join(" "), /floored to 0 days/i);
  });

  test("rejects blanks, non-finite values, and out-of-range controls", () => {
    assert.throws(
      () =>
        simulateBottleneckScenario({
          outcomeKpis: response(),
          controls: controls({
            bgv: { delayDays: "", criticalPathShare: 50 },
            approvals: { delayDays: Number.NaN, criticalPathShare: 50 },
            documents: { delayDays: 1, criticalPathShare: 101 },
            provisioning: { delayDays: Number.POSITIVE_INFINITY, criticalPathShare: 0 },
          }),
          comparisonThresholdDays: "",
        }),
      (error: unknown) => {
        assert.ok(error instanceof BottleneckSimulationInputError);
        assert.match(error.message, /controls\.bgv\.delayDays/);
        assert.match(error.message, /controls\.approvals\.delayDays/);
        assert.match(error.message, /controls\.documents\.criticalPathShare/);
        assert.match(error.message, /controls\.provisioning\.delayDays/);
        assert.match(error.message, /comparisonThresholdDays/);
        return true;
      },
    );
  });

  test("keeps the four-stage contract explicit", () => {
    assert.deepEqual(BOTTLENECK_STAGES, [
      "bgv",
      "approvals",
      "documents",
      "provisioning",
    ]);
  });
});