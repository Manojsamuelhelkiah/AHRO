import type {
  OnbOutcomeKpi,
  OnbOutcomeKpis,
} from "@workspace/api-client-react";

/**
 * Read-only, deterministic what-if arithmetic. It does not infer historical
 * stage timing, make a causal/forecast claim, or persist a scenario.
 */

export const BOTTLENECK_STAGES = [
  "bgv",
  "approvals",
  "documents",
  "provisioning",
] as const;
export type BottleneckStage = (typeof BOTTLENECK_STAGES)[number];

/**
 * Strings are accepted for controlled text inputs. A blank string is invalid,
 * rather than silently becoming zero.
 */
export type NumericInput = number | string | null | undefined;

export type BottleneckStageControl = {
  delayDays: NumericInput;
  /** Percentage in the inclusive range 0..100. */
  criticalPathShare: NumericInput;
};

export type BottleneckControls = Partial<
  Record<BottleneckStage, BottleneckStageControl | null | undefined>
>;

export type BottleneckSimulationInput = {
  /** Generated response from GET /onboarding/analytics/outcome-kpis. */
  outcomeKpis?: OnbOutcomeKpis | null;
  /**
   * Explicit fallback only. It is used only when there is no usable measured
   * cycle-time observation and is always labelled Assumed in the result.
   */
  manualBaselineDays?: NumericInput;
  controls?: BottleneckControls | null;
  /** Explicit comparison value, not an SLA or measured target. */
  comparisonThresholdDays?: NumericInput;
};

export type BottleneckBaselineSource =
  | "measured"
  | "assumed"
  | "unavailable";

export type BottleneckMetricMetadata = {
  metricId: string;
  status: string | null;
  unit: string | null;
  meanDays: number | null;
  sampleSize: number | null;
  /** Existing metric eligibleCount; never recomputed here. */
  denominator: number | null;
  unknownCount: number | null;
  cohortLabel: string | null;
  caseCount: number | null;
};

export type BottleneckBaselineMetadata = BottleneckMetricMetadata & {
  source: BottleneckBaselineSource;
  label: "Measured" | "Assumed" | "Unavailable";
};

export type BottleneckContribution = {
  stage: BottleneckStage;
  delayDays: number | null;
  criticalPathShare: number | null;
  /**
   * delayDays * (criticalPathShare / 100). Null means the stage was omitted;
   * omission is not an inferred zero.
   */
  contributionDays: number | null;
  applied: boolean;
};

export type BottleneckComparison = {
  thresholdDays: number;
  thresholdLabel: "Assumed comparison threshold";
  classification: "at-or-below" | "above";
  /** The comparison is intentionally about the scenario mean only. */
  basis: "scenario-mean-only";
};

export type BgvObservedMetadata = BottleneckMetricMetadata & {
  source: "measured";
};

export type BottleneckSimulationResult = {
  baseline: BottleneckBaselineMetadata;
  baselineMeanDays: number | null;
  contributions: readonly BottleneckContribution[];
  unflooredScenarioMeanDays: number | null;
  scenarioMeanDays: number | null;
  /** scenarioMeanDays - baselineMeanDays. */
  deltaDays: number | null;
  formula:
    | "max(0, baselineMeanDays + Σ(delayDays × criticalPathShare / 100))"
    | null;
  floorApplied: boolean;
  warnings: readonly string[];
  comparison: BottleneckComparison | null;
  /** Present only as real, valid BGV metric evidence; never inferred. */
  bgvObserved: BgvObservedMetadata | null;
  cohort: {
    label: string | null;
    caseCount: number | null;
    sampleSize: number | null;
    denominator: number | null;
    unknownCount: number | null;
  };
  limitations: readonly string[];
};

export type BottleneckSimulationValidationIssue = {
  field: string;
  message: string;
};

export class BottleneckSimulationInputError extends Error {
  readonly issues: readonly BottleneckSimulationValidationIssue[];

  constructor(issues: readonly BottleneckSimulationValidationIssue[]) {
    super(
      issues
        .map((issue) => `${issue.field}: ${issue.message}`)
        .join("; ") || "Invalid bottleneck simulation input",
    );
    this.name = "BottleneckSimulationInputError";
    this.issues = issues;
  }
}

export const CYCLE_TIME_METRIC_ID = "cycle-time";
export const BGV_TURNAROUND_METRIC_ID = "bgv-turnaround";
export const MAX_DAYS = 3_650;

const FORMULA =
  "max(0, baselineMeanDays + Σ(delayDays × criticalPathShare / 100))" as const;
const UNAVAILABLE_STATUSES = new Set([
  "insufficient-data",
  "not-collected",
]);
const BASE_LIMITATIONS = [
  "What-if arithmetic is not a causal or scientific forecast.",
  "Stage effects are treated as independent and non-overlapping only as an explicit assumption; no historical stage inference is performed.",
  "Aggregate means do not establish SLA-violation fractions or on-time case counts.",
  "This simulation is ephemeral and read-only; it does not save or change onboarding records.",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isKnownStage(value: string): value is BottleneckStage {
  return (BOTTLENECK_STAGES as readonly string[]).includes(value);
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function parseNumber(
  value: NumericInput,
  field: string,
  minimum: number,
  maximum: number,
  issues: BottleneckSimulationValidationIssue[],
): number | null {
  if (value === undefined) {
    issues.push({ field, message: "is required" });
    return null;
  }
  if (value === null || (typeof value === "string" && value.trim() === "")) {
    issues.push({ field, message: "must not be blank; enter a number" });
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    issues.push({ field, message: "must be a number" });
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    issues.push({ field, message: "must be a finite number" });
    return null;
  }
  if (parsed < minimum || parsed > maximum) {
    issues.push({
      field,
      message: `must be between ${minimum} and ${maximum}`,
    });
    return null;
  }
  return parsed;
}

type NormalizedControl = { delayDays: number; criticalPathShare: number };
type NormalizedControls = Record<
  BottleneckStage,
  NormalizedControl | null
>;

function normalizeControls(
  controls: BottleneckControls | null | undefined,
): {
  normalized: NormalizedControls;
  issues: BottleneckSimulationValidationIssue[];
} {
  const normalized = {} as NormalizedControls;
  const issues: BottleneckSimulationValidationIssue[] = [];

  if (controls === null) {
    issues.push({
      field: "controls",
      message: "must be an object; omit a stage for no assumption",
    });
    return { normalized, issues };
  }
  if (controls !== undefined && !isRecord(controls)) {
    issues.push({ field: "controls", message: "must be an object" });
    return { normalized, issues };
  }
  for (const key of Object.keys(controls ?? {})) {
    if (!isKnownStage(key)) {
      issues.push({
        field: `controls.${key}`,
        message: "is not a supported bottleneck stage",
      });
    }
  }

  for (const stage of BOTTLENECK_STAGES) {
    const raw = controls?.[stage];
    if (raw === undefined) {
      normalized[stage] = null;
      continue;
    }
    if (raw === null || !isRecord(raw)) {
      issues.push({
        field: `controls.${stage}`,
        message: "must contain delayDays and criticalPathShare",
      });
      normalized[stage] = null;
      continue;
    }
    const delayDays = parseNumber(
      raw.delayDays as NumericInput,
      `controls.${stage}.delayDays`,
      -MAX_DAYS,
      MAX_DAYS,
      issues,
    );
    const criticalPathShare = parseNumber(
      raw.criticalPathShare as NumericInput,
      `controls.${stage}.criticalPathShare`,
      0,
      100,
      issues,
    );
    normalized[stage] =
      delayDays === null || criticalPathShare === null
        ? null
        : { delayDays, criticalPathShare };
  }
  return { normalized, issues };
}

export function validateBottleneckSimulationInput(
  input: BottleneckSimulationInput,
): readonly BottleneckSimulationValidationIssue[] {
  const issues = [...normalizeControls(input.controls).issues];
  if (input.manualBaselineDays !== undefined) {
    parseNumber(input.manualBaselineDays, "manualBaselineDays", 0, MAX_DAYS, issues);
  }
  if (input.comparisonThresholdDays !== undefined) {
    parseNumber(
      input.comparisonThresholdDays,
      "comparisonThresholdDays",
      0,
      MAX_DAYS,
      issues,
    );
  }
  return issues;
}

/**
 * Existing outcome KPI status is target status (met/missed), not a separate
 * observation status. A non-null, in-range days value with a positive sample
 * and a non-unavailable status is the measured source in that generated DTO.
 */
function usableMeasuredMetric(
  metric: OnbOutcomeKpi | undefined,
): metric is OnbOutcomeKpi & { value: number } {
  return (
    metric !== undefined &&
    metric.unit === "days" &&
    typeof metric.value === "number" &&
    Number.isFinite(metric.value) &&
    metric.value >= 0 &&
    metric.value <= MAX_DAYS &&
    typeof metric.sampleSize === "number" &&
    Number.isFinite(metric.sampleSize) &&
    metric.sampleSize > 0 &&
    typeof metric.status === "string" &&
    metric.status.length > 0 &&
    !UNAVAILABLE_STATUSES.has(metric.status)
  );
}

function sourceDaysOutOfBounds(metric: OnbOutcomeKpi | undefined): boolean {
  return (
    metric?.unit === "days" &&
    typeof metric.value === "number" &&
    Number.isFinite(metric.value) &&
    (metric.value < 0 || metric.value > MAX_DAYS)
  );
}

function metricMetadata(
  metric: OnbOutcomeKpi | undefined,
  response: OnbOutcomeKpis | null | undefined,
): BottleneckMetricMetadata {
  return {
    metricId: metric?.id ?? CYCLE_TIME_METRIC_ID,
    status: typeof metric?.status === "string" ? metric.status : null,
    unit: typeof metric?.unit === "string" ? metric.unit : null,
    meanDays:
      metric?.unit === "days" &&
      typeof metric.value === "number" &&
      Number.isFinite(metric.value)
        ? metric.value
        : null,
    sampleSize: finiteCount(metric?.sampleSize),
    denominator: finiteCount(metric?.eligibleCount),
    unknownCount: finiteCount(metric?.unknownCount),
    cohortLabel:
      typeof response?.cohortLabel === "string" ? response.cohortLabel : null,
    caseCount: finiteCount(response?.caseCount),
  };
}

function responseMetric(
  response: OnbOutcomeKpis | null | undefined,
  id: string,
): OnbOutcomeKpi | undefined {
  return response?.metrics.find((metric) => metric.id === id);
}

/**
 * Measured cycle-time wins. Manual input is used only when the measured
 * source is unavailable and is explicitly labelled Assumed. With neither,
 * no automatic baseline is produced.
 */
export function simulateBottleneckScenario(
  input: BottleneckSimulationInput,
): BottleneckSimulationResult {
  const controls = normalizeControls(input.controls);
  const issues = [...controls.issues];
  let manualBaselineDays: number | null = null;
  let comparisonThresholdDays: number | null = null;

  if (input.manualBaselineDays !== undefined) {
    manualBaselineDays = parseNumber(
      input.manualBaselineDays,
      "manualBaselineDays",
      0,
      MAX_DAYS,
      issues,
    );
  }
  if (input.comparisonThresholdDays !== undefined) {
    comparisonThresholdDays = parseNumber(
      input.comparisonThresholdDays,
      "comparisonThresholdDays",
      0,
      MAX_DAYS,
      issues,
    );
  }
  if (issues.length > 0) {
    throw new BottleneckSimulationInputError(issues);
  }

  const response = input.outcomeKpis;
  const cycleMetric = responseMetric(response, CYCLE_TIME_METRIC_ID);
  const measuredCycle = usableMeasuredMetric(cycleMetric)
    ? cycleMetric
    : undefined;
  const bgvMetric = responseMetric(response, BGV_TURNAROUND_METRIC_ID);
  const measuredBgv = usableMeasuredMetric(bgvMetric) ? bgvMetric : undefined;
  const cycleMetadata = metricMetadata(cycleMetric, response);
  const source: BottleneckBaselineSource =
    measuredCycle !== undefined
      ? "measured"
      : manualBaselineDays !== null
        ? "assumed"
        : "unavailable";
  const baselineMeanDays =
    measuredCycle?.value ?? manualBaselineDays ?? null;
  const baseline: BottleneckBaselineMetadata = {
    ...cycleMetadata,
    meanDays: baselineMeanDays,
    source,
    label:
      source === "measured"
        ? "Measured"
        : source === "assumed"
          ? "Assumed"
          : "Unavailable",
  };

  const contributions: BottleneckContribution[] = BOTTLENECK_STAGES.map(
    (stage) => {
      const control = controls.normalized[stage];
      if (control === null || control === undefined) {
        return {
          stage,
          delayDays: null,
          criticalPathShare: null,
          contributionDays: null,
          applied: false,
        };
      }
      return {
        stage,
        delayDays: control.delayDays,
        criticalPathShare: control.criticalPathShare,
        contributionDays:
          control.delayDays * (control.criticalPathShare / 100),
        applied: true,
      };
    },
  );
  const totalContributionDays = contributions.reduce(
    (sum, contribution) => sum + (contribution.contributionDays ?? 0),
    0,
  );
  const unflooredScenarioMeanDays =
    baselineMeanDays === null
      ? null
      : baselineMeanDays + totalContributionDays;
  const scenarioMeanDays =
    unflooredScenarioMeanDays === null
      ? null
      : Math.max(0, unflooredScenarioMeanDays);
  const floorApplied =
    unflooredScenarioMeanDays !== null && unflooredScenarioMeanDays < 0;
  const deltaDays =
    scenarioMeanDays === null || baselineMeanDays === null
      ? null
      : scenarioMeanDays - baselineMeanDays;
  const comparison =
    scenarioMeanDays !== null && comparisonThresholdDays !== null
      ? {
          thresholdDays: comparisonThresholdDays,
          thresholdLabel: "Assumed comparison threshold" as const,
          classification:
            scenarioMeanDays <= comparisonThresholdDays
              ? ("at-or-below" as const)
              : ("above" as const),
          basis: "scenario-mean-only" as const,
        }
      : null;

  const warnings: string[] = [];
  if (floorApplied) {
    warnings.push(
      "The arithmetic result was below zero and was floored to 0 days; this is a mathematical floor, not an observed outcome.",
    );
  }
  if (source === "unavailable") {
    warnings.push(
      "No usable measured cycle-time observation is available, and no explicit manual baseline was supplied; the scenario mean is unavailable.",
    );
  }
  if (source === "assumed") {
    warnings.push(
      "The baseline is an explicit Assumed value, not a measured onboarding outcome.",
    );
  }
  if (sourceDaysOutOfBounds(cycleMetric)) {
    warnings.push(
      `The cycle-time source value (${cycleMetric?.value} days) is outside the allowed measured range [0, ${MAX_DAYS}] and was marked unavailable.`,
    );
  }
  if (sourceDaysOutOfBounds(bgvMetric)) {
    warnings.push(
      `BGV observed metadata is unavailable because its source value (${bgvMetric?.value} days) is outside the allowed measured range [0, ${MAX_DAYS}].`,
    );
  }
  if (comparisonThresholdDays !== null) {
    warnings.push(
      "The threshold comparison classifies the scenario mean only; it does not estimate SLA violations or on-time cases.",
    );
  }

  const limitations: string[] = [...BASE_LIMITATIONS];
  if (source === "unavailable") {
    limitations.push(
      "No automatic baseline was created because the cycle-time metric has no usable observations.",
    );
  }
  if (source === "assumed") {
    limitations.push(
      "The measured cycle-time baseline was unavailable; the displayed baseline is labelled Assumed.",
    );
  }

  return {
    baseline,
    baselineMeanDays,
    contributions,
    unflooredScenarioMeanDays,
    scenarioMeanDays,
    deltaDays,
    formula: baselineMeanDays === null ? null : FORMULA,
    floorApplied,
    warnings,
    comparison,
    bgvObserved: measuredBgv
      ? { ...metricMetadata(measuredBgv, response), source: "measured" }
      : null,
    cohort: {
      label:
        typeof response?.cohortLabel === "string"
          ? response.cohortLabel
          : null,
      caseCount: finiteCount(response?.caseCount),
      sampleSize: cycleMetadata.sampleSize,
      denominator: cycleMetadata.denominator,
      unknownCount: cycleMetadata.unknownCount,
    },
    limitations,
  };
}

export const calculateBottleneckSimulation = simulateBottleneckScenario;
export const simulateBottleneck = simulateBottleneckScenario;