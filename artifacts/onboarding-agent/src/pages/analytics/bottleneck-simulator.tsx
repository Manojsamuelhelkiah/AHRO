import React, { useEffect, useMemo, useState } from "react";
import {
  getGetOnboardingOutcomeKpisQueryKey,
  useGetOnboardingOutcomeKpis,
  type GetOnboardingOutcomeKpisParams,
  type OnbOutcomeKpis,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  Info,
  SlidersHorizontal,
  TrendingDown,
} from "lucide-react";
import { Button, Label, cn } from "@/components/ui-shared";
import {
  BottleneckSimulationInputError,
  BOTTLENECK_STAGES,
  simulateBottleneckScenario,
  type BottleneckControls,
  type BottleneckSimulationInput,
  type BottleneckSimulationResult,
  type BottleneckStage,
} from "@/lib/bottleneck-simulation";

export type BottleneckSimulatorProps = {
  period: string;
  region: string;
  domain: string;
  caseType: string;
};

type OutcomePeriod = NonNullable<GetOnboardingOutcomeKpisParams["period"]>;

const OUTCOME_PERIODS: readonly OutcomePeriod[] = ["7", "30", "90", "All"];

type StageFormValue = {
  delayDays: string;
  criticalPathShare: string;
};

export type BottleneckFormValues = {
  baselineSource: "measured" | "manual";
  manualBaselineDays: string;
  comparisonThresholdDays: string;
  stages: Record<BottleneckStage, StageFormValue>;
};

const EMPTY_STAGES: Record<BottleneckStage, StageFormValue> = {
  bgv: { delayDays: "", criticalPathShare: "" },
  approvals: { delayDays: "", criticalPathShare: "" },
  documents: { delayDays: "", criticalPathShare: "" },
  provisioning: { delayDays: "", criticalPathShare: "" },
};

export const initialBottleneckFormValues = (): BottleneckFormValues => ({
  baselineSource: "measured",
  manualBaselineDays: "",
  comparisonThresholdDays: "",
  stages: {
    bgv: { ...EMPTY_STAGES.bgv },
    approvals: { ...EMPTY_STAGES.approvals },
    documents: { ...EMPTY_STAGES.documents },
    provisioning: { ...EMPTY_STAGES.provisioning },
  },
});

function toOutcomePeriod(value: string): OutcomePeriod {
  return OUTCOME_PERIODS.includes(value as OutcomePeriod)
    ? (value as OutcomePeriod)
    : "30";
}

function blankToUndefined(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
}

/**
 * Keep form strings intact at the model boundary. A wholly blank stage is
 * omitted (not modelled); a partially filled stage remains present so the
 * canonical validator can explain which value is missing.
 */
export function buildBottleneckControls(
  stages: BottleneckFormValues["stages"],
): BottleneckControls {
  const controls: BottleneckControls = {};
  for (const stage of BOTTLENECK_STAGES) {
    const value = stages[stage];
    if (
      value.delayDays.trim() === "" &&
      value.criticalPathShare.trim() === ""
    ) {
      continue;
    }
    controls[stage] = {
      delayDays: value.delayDays,
      criticalPathShare: value.criticalPathShare,
    };
  }
  return controls;
}

/**
 * Pure adapter used by the component and tests. Manual mode deliberately
 * passes null for outcomeKpis, so a measured response can never silently win
 * over an explicit manual baseline.
 */
export function buildBottleneckSimulationInput(
  form: BottleneckFormValues,
  outcomeKpis: OnbOutcomeKpis | null | undefined,
): BottleneckSimulationInput {
  return {
    outcomeKpis: form.baselineSource === "measured" ? outcomeKpis ?? null : null,
    manualBaselineDays:
      form.baselineSource === "manual"
        ? form.manualBaselineDays
        : undefined,
    comparisonThresholdDays: blankToUndefined(
      form.comparisonThresholdDays,
    ),
    controls: buildBottleneckControls(form.stages),
  };
}

export function BottleneckSimulator(props: BottleneckSimulatorProps) {
  const filterKey = [
    props.period,
    props.region,
    props.domain,
    props.caseType,
  ].join("\u001f");
  return <BottleneckSimulatorPanel key={filterKey} {...props} />;
}

function asSimulationError(error: unknown): string {
  if (error instanceof BottleneckSimulationInputError) {
    return error.message;
  }
  return "The scenario could not be calculated. Check each value and try again.";
}

function BottleneckSimulatorPanel({
  period,
  region,
  domain,
  caseType,
}: BottleneckSimulatorProps) {
  const params = useMemo<GetOnboardingOutcomeKpisParams>(
    () => ({
      period: toOutcomePeriod(period),
      ...(region !== "All regions" ? { region } : {}),
      ...(caseType !== "All cases" ? { hireType: caseType } : {}),
      ...(domain === "Onboarding" ? { domain: "Onboarding" } : {}),
    }),
    [period, region, domain, caseType],
  );

  const {
    data: kpis,
    isFetching,
    isError,
    refetch,
  } = useGetOnboardingOutcomeKpis(params, {
    query: { queryKey: getGetOnboardingOutcomeKpisQueryKey(params) },
  });

  const [form, setForm] = useState<BottleneckFormValues>(
    initialBottleneckFormValues,
  );

  useEffect(() => {
    setForm(initialBottleneckFormValues());
  }, [period, region, domain, caseType]);

  const simulationState = useMemo<{
    result: BottleneckSimulationResult | null;
    error: string | null;
  }>(() => {
    try {
      return {
        result: simulateBottleneckScenario(
          buildBottleneckSimulationInput(form, kpis),
        ),
        error: null,
      };
    } catch (error) {
      return { result: null, error: asSimulationError(error) };
    }
  }, [form, kpis]);

  const simulationResult = simulationState.result;
  const simulationError = simulationState.error;
  const hasBaseline =
    simulationResult?.baselineMeanDays !== null &&
    simulationResult?.baselineMeanDays !== undefined;
  const isMeasured =
    simulationResult?.baseline.source === "measured" && hasBaseline;

  const updateStage = (
    stage: BottleneckStage,
    field: keyof StageFormValue,
    value: string,
  ) => {
    setForm((previous) => ({
      ...previous,
      stages: {
        ...previous.stages,
        [stage]: { ...previous.stages[stage], [field]: value },
      },
    }));
  };

  const inputClass =
    "flex h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]";

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)] overflow-hidden">
      <div className="border-b border-[var(--border)] p-4 md:p-5 bg-[var(--surface-alt)] flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-semibold text-[var(--text-primary)] m-0">
            Bottleneck Simulator
          </h2>
          <p className="text-[13px] text-[var(--text-muted)] mt-1">
            Model explicit signed stage-delay assumptions against the selected
            cycle-time mean.
          </p>
        </div>
        <div className="p-2 bg-[var(--primary-light)] text-[var(--primary)] rounded-full">
          <SlidersHorizontal className="w-5 h-5" />
        </div>
      </div>

      {isError && (
        <div
          className="m-4 bg-[var(--status-red-bg)] text-[var(--status-red-fg)] p-4 rounded-[var(--radius-lg)] border border-[var(--status-red)] text-sm flex gap-2 items-start"
          role="alert"
        >
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>
            <p className="font-semibold">Unable to load measured outcomes</p>
            <p className="opacity-90 mt-1">
              Measured mode remains unavailable. Manual Entry can still use an
              explicit assumed baseline.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </div>
        </div>
      )}

      <div className="p-4 md:p-5 grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8">
        <div className="lg:col-span-4 space-y-6">
          <div className="space-y-3">
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">
              Baseline Configuration
            </h3>

            <div className="flex gap-2 mb-2 p-1 bg-[var(--surface-soft)] rounded-md border border-[var(--border)]">
              <button
                type="button"
                className={cn(
                  "flex-1 text-xs py-1.5 px-2 rounded-sm font-medium transition-colors",
                  form.baselineSource === "measured"
                    ? "bg-[var(--surface)] text-[var(--primary)] shadow-sm border border-[var(--border)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
                onClick={() =>
                  setForm((previous) => ({
                    ...previous,
                    baselineSource: "measured",
                  }))
                }
              >
                Measured Data
              </button>
              <button
                type="button"
                className={cn(
                  "flex-1 text-xs py-1.5 px-2 rounded-sm font-medium transition-colors",
                  form.baselineSource === "manual"
                    ? "bg-[var(--surface)] text-[var(--primary)] shadow-sm border border-[var(--border)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
                onClick={() =>
                  setForm((previous) => ({
                    ...previous,
                    baselineSource: "manual",
                  }))
                }
              >
                Manual Entry
              </button>
            </div>

            {form.baselineSource === "measured" ? (
              <div className="p-3 bg-[var(--surface-alt)] rounded-md border border-[var(--border)]">
                {isFetching && !kpis ? (
                  <div className="text-xs text-[var(--text-muted)] animate-pulse">
                    Loading baseline data...
                  </div>
                ) : !isMeasured ? (
                  <div className="text-xs text-[var(--status-amber)] flex gap-2 items-start">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>
                      No valid measured baseline is available for this cohort.
                      Switch to Manual Entry to use an explicit assumption.
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-baseline">
                      <span className="text-xs text-[var(--text-muted)]">
                        Cycle Time Mean
                      </span>
                      <span className="text-lg font-bold text-[var(--text-primary)]">
                        {simulationResult.baselineMeanDays?.toFixed(1) ?? "—"}{" "}
                        days
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-[var(--text-muted)] border-t border-[var(--border)] pt-2">
                      Based on{" "}
                      {simulationResult.baseline.sampleSize ?? 0} observation
                      {(simulationResult.baseline.sampleSize ?? 0) !== 1 &&
                        "s"}{" "}
                      in selected cohort.
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="text-xs">Manual Baseline (Days)</Label>
                <input
                  type="number"
                  min="0"
                  max="3650"
                  step="0.1"
                  value={form.manualBaselineDays}
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      manualBaselineDays: event.target.value,
                    }))
                  }
                  className={inputClass}
                  placeholder="e.g. 21.5"
                />
                <p className="text-[10px] text-[var(--text-muted)]">
                  This value is labelled Assumed and is not measured evidence.
                </p>
                {kpis && (
                  <p className="text-[10px] text-[var(--text-muted)] border-t border-[var(--border)] pt-2">
                    Cohort information only: {kpis.cohortLabel} (
                    {kpis.caseCount} cases). This fetched cohort is not used
                    as the manual baseline.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2 mt-4 pt-4 border-t border-[var(--border)]">
              <Label className="text-xs">Assumed Comparison Threshold (Days)</Label>
              <input
                type="number"
                min="0"
                max="3650"
                step="1"
                value={form.comparisonThresholdDays}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    comparisonThresholdDays: event.target.value,
                  }))
                }
                className={inputClass}
                placeholder="Optional comparison"
              />
              <p className="text-[10px] text-[var(--text-muted)]">
                Compares the scenario mean only; it is not an SLA rate.
              </p>
            </div>
          </div>
        </div>

        <div className="lg:col-span-8">
          <h3 className="text-[12px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-4">
            Stage Delay Assumptions
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {BOTTLENECK_STAGES.map((stage) => (
              <StageInput
                key={stage}
                label={
                  stage.charAt(0).toUpperCase() +
                  stage.slice(1)
                }
                delayValue={form.stages[stage].delayDays}
                onDelayChange={(value) =>
                  updateStage(stage, "delayDays", value)
                }
                shareValue={form.stages[stage].criticalPathShare}
                onShareChange={(value) =>
                  updateStage(stage, "criticalPathShare", value)
                }
              />
            ))}
          </div>

          {simulationError && (
            <div
              className="mt-6 p-4 rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] text-[var(--status-red-fg)] text-sm"
              role="alert"
            >
              <div className="font-semibold">Check simulation inputs</div>
              <div className="mt-1 whitespace-pre-wrap">{simulationError}</div>
            </div>
          )}

          {simulationResult && hasBaseline ? (
            <div className="mt-6 p-4 md:p-5 rounded-md border border-[var(--primary-light)] bg-[var(--status-info-bg)]">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4 mb-4">
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--primary)]">
                    Scenario Mean
                  </div>
                  <div className="text-[32px] font-bold text-[var(--text-primary)] leading-none mt-1">
                    {simulationResult.scenarioMeanDays?.toFixed(1) ?? "—"}{" "}
                    <span className="text-[14px] font-medium text-[var(--text-muted)]">
                      days
                    </span>
                  </div>
                  {simulationResult.floorApplied && (
                    <div className="text-[11px] text-[var(--status-amber)] mt-1 flex items-center gap-1 font-semibold">
                      <AlertTriangle className="w-3 h-3" /> Floor applied
                    </div>
                  )}
                </div>
                <div className="sm:text-right">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--status-green)] flex items-center sm:justify-end gap-1">
                    <TrendingDown className="w-3 h-3" /> Change from baseline
                  </div>
                  <div className="text-[24px] font-bold text-[var(--status-green)] leading-none mt-1">
                    {simulationResult.deltaDays !== null &&
                    simulationResult.deltaDays > 0
                      ? "+"
                      : ""}
                    {simulationResult.deltaDays?.toFixed(1) ?? "—"}{" "}
                    <span className="text-[12px] font-medium opacity-80">
                      days
                    </span>
                  </div>
                </div>
              </div>

              {(simulationResult.warnings.length > 0 ||
                simulationResult.limitations.length > 0) && (
                <div className="mt-5 pt-4 border-t border-[rgba(76,66,238,0.15)] space-y-2">
                  {simulationResult.warnings.map((warning, index) => (
                    <div
                      key={`w-${index}`}
                      className="flex gap-2 items-start text-[12px] text-[var(--primary)]"
                    >
                      <Info className="w-4 h-4 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{warning}</span>
                    </div>
                  ))}
                  {simulationResult.limitations.map((limitation, index) => (
                    <div
                      key={`l-${index}`}
                      className="flex gap-2 items-start text-[12px] text-[var(--text-muted)]"
                    >
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{limitation}</span>
                    </div>
                  ))}
                </div>
              )}

              {simulationResult.comparison && (
                <div className="mt-4 p-3 bg-[var(--surface)] border border-[var(--border)] rounded text-[12px] flex items-center justify-between">
                  <span className="font-semibold">
                    {simulationResult.comparison.thresholdLabel} (
                    {simulationResult.comparison.thresholdDays} days)
                  </span>
                  <span
                    className={cn(
                      "font-bold uppercase tracking-wider px-2 py-0.5 rounded text-[10px]",
                      simulationResult.comparison.classification ===
                        "at-or-below"
                        ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]"
                        : "bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]",
                    )}
                  >
                    {simulationResult.comparison.classification ===
                    "at-or-below"
                      ? "At or below mean threshold"
                      : "Above mean threshold"}
                  </span>
                </div>
              )}
            </div>
          ) : (
            !simulationError && (
              <div className="mt-6 p-6 rounded-md border border-dashed border-[var(--border)] text-center text-sm text-[var(--text-muted)] flex flex-col items-center justify-center bg-[var(--surface-alt)] min-h-[120px]">
                <SlidersHorizontal className="w-8 h-8 text-[var(--border-strong)] mb-3 opacity-50" />
                <p>
                  Enter a valid baseline and complete any stage assumption you
                  want to model.
                </p>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

type StageInputProps = {
  label: string;
  delayValue: string;
  onDelayChange: (value: string) => void;
  shareValue: string;
  onShareChange: (value: string) => void;
};

function StageInput({
  label,
  delayValue,
  onDelayChange,
  shareValue,
  onShareChange,
}: StageInputProps) {
  const inputClass =
    "flex h-8 w-full rounded-sm border border-[var(--border)] bg-[var(--surface)] px-2 text-xs shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]";

  return (
    <div className="p-3 md:p-4 bg-[var(--surface-alt)] rounded-md border border-[var(--border)]">
      <div className="font-semibold text-[13px] text-[var(--text-primary)] mb-4">
        {label}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-[10px] text-[var(--text-muted)] mb-1.5 block uppercase tracking-wider font-semibold">
            Signed delay (days)
          </Label>
          <input
            type="number"
            min="-3650"
            max="3650"
            step="0.5"
            value={delayValue}
            onChange={(event) => onDelayChange(event.target.value)}
            className={inputClass}
            placeholder="+ delay / − improvement"
          />
        </div>
        <div>
          <Label className="text-[10px] text-[var(--text-muted)] mb-1.5 block uppercase tracking-wider font-semibold">
            Critical path (%)
          </Label>
          <input
            type="number"
            min="0"
            max="100"
            step="10"
            value={shareValue}
            onChange={(event) => onShareChange(event.target.value)}
            className={inputClass}
            placeholder="0–100"
          />
        </div>
      </div>
      <p className="text-[10px] text-[var(--text-muted)] mt-2">
        + delays; − improvements. Blank pair = not modeled.
      </p>
    </div>
  );
}