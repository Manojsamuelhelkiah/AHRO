/**
 * One-at-a-time sensitivity analysis: nudge each business-case driver ±20%
 * while holding everything else constant, re-run the exact pricing engine,
 * and report how far the net benefit swings. Rows are sorted by swing so the
 * UI can render a tornado chart with the material assumptions on top.
 */
import { computeRollup, OVERRIDABLE_ASSUMPTION_KEYS, type ScenarioInputs, type FlowOverrideValues } from "./rollup";
import { assumptionMap } from "../data/assumptions";
import type { ActualsOverlay, Intent } from "../data/types";

const NUDGE = 0.2;

const FC_CONTAINMENT: Record<string, string> = {
  "fc1-deterministic": "containment-fc1",
  "fc2-policy": "containment-fc2",
  "fc3-multiagent": "containment-fc3",
  "fc4-frontier": "containment-fc4",
};

const DEFAULT_RAMP: [number, number, number] = [0.4, 0.75, 1.0];

export interface SensitivityRow {
  key: string;
  label: string;
  group: "assumption" | "labor" | "containment" | "adoption";
  baseValue: number;
  lowValue: number;
  highValue: number;
  netLowUsd: number;
  netHighUsd: number;
  /** Max absolute deviation of net benefit from baseline across the two nudges. */
  swingUsd: number;
}

export interface SensitivityResult {
  baselineNetUsd: number;
  nudgePct: number;
  rows: SensitivityRow[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function computeSensitivity(
  inputs: ScenarioInputs,
  overrides?: Record<string, FlowOverrideValues>,
  customIntents: Intent[] = [],
  overlay?: ActualsOverlay,
): SensitivityResult {
  // Overlay (measured actuals) is held constant across baseline and every
  // nudge, so the tornado matches the calibrated rollup on screen.
  const net = (v: ScenarioInputs) =>
    computeRollup(v, overrides, overlay, customIntents).totals.netUsd;
  const baseline = net(inputs);

  const rows: SensitivityRow[] = [];
  const push = (
    key: string,
    label: string,
    group: SensitivityRow["group"],
    baseValue: number,
    make: (factor: number) => ScenarioInputs,
    clampFraction = false,
  ) => {
    const lowValue = clampFraction ? clamp01(baseValue * (1 - NUDGE)) : baseValue * (1 - NUDGE);
    const highValue = clampFraction ? clamp01(baseValue * (1 + NUDGE)) : baseValue * (1 + NUDGE);
    const netLowUsd = net(make(1 - NUDGE));
    const netHighUsd = net(make(1 + NUDGE));
    rows.push({
      key, label, group, baseValue, lowValue, highValue, netLowUsd, netHighUsd,
      swingUsd: Math.max(Math.abs(netLowUsd - baseline), Math.abs(netHighUsd - baseline)),
    });
  };

  // 1. Overridable global assumptions (respect any per-scenario override as base).
  for (const key of OVERRIDABLE_ASSUMPTION_KEYS) {
    const def = assumptionMap[key];
    if (!def) continue;
    const base = inputs.assumptionOverrides?.[key] ?? def.value;
    if (base === 0) continue; // ±20% of zero moves nothing
    push(key, def.label, "assumption", base, (f) => ({
      ...inputs,
      assumptionOverrides: { ...inputs.assumptionOverrides, [key]: base * f },
    }));
  }

  // 2. Labor rates.
  push("hrHourlyCostUsd", "As-is HR labor rate ($/hr)", "labor", inputs.hrHourlyCostUsd, (f) => ({
    ...inputs, hrHourlyCostUsd: inputs.hrHourlyCostUsd * f,
  }));
  push("hitlHourlyCostUsd", "HITL reviewer rate ($/hr)", "labor", inputs.hitlHourlyCostUsd, (f) => ({
    ...inputs, hitlHourlyCostUsd: inputs.hitlHourlyCostUsd * f,
  }));

  // 3. Containment, per flow class (base = scenario override or register default).
  for (const [fc, aKey] of Object.entries(FC_CONTAINMENT)) {
    const def = assumptionMap[aKey];
    if (!def) continue;
    const base = inputs.containmentRates?.[fc] ?? def.value;
    push(aKey, def.label, "containment", base, (f) => ({
      ...inputs,
      containmentRates: { ...inputs.containmentRates, [fc]: clamp01(base * f) },
    }), true);
  }

  // 4. Adoption (scale the whole ramp; scalar adoptionRate becomes a flat ramp).
  const ramp: [number, number, number] =
    inputs.adoptionRamp ??
    (inputs.adoptionRate !== undefined
      ? [inputs.adoptionRate, inputs.adoptionRate, inputs.adoptionRate]
      : DEFAULT_RAMP);
  const rampAvg = (ramp[0] + ramp[1] + ramp[2]) / 3;
  push("adoption", "Adoption ramp (all years)", "adoption", rampAvg, (f) => ({
    ...inputs,
    adoptionRate: undefined,
    adoptionRamp: ramp.map((r) => clamp01(r * f)) as [number, number, number],
  }), true);

  rows.sort((a, b) => b.swingUsd - a.swingUsd);
  return { baselineNetUsd: baseline, nudgePct: NUDGE, rows };
}
