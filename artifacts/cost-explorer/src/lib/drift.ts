/**
 * Pure helpers for tracking calibration drift across multiple actuals overlays.
 * No React, no browser globals — safe to unit-test in Node.
 *
 * Design note: `estimateMap` is the single extension point for plugging in a
 * scenario's appliedAssumptions (Decision B, now implemented via
 * scenarioToEstimateMap). Keys are assumption keys exactly as used by the
 * rollup engine (e.g. "containment-fc1", "hitl-sampling-rate",
 * "intent-cont-{intentKey}", "intent-hitl-{intentKey}", "token-cost-{role}").
 *
 * Token-cost series: pass a `RolePricingMap` as the fourth argument to
 * `computeDrift` to emit per-role USD/call drift series. Omitting it (or passing
 * undefined) is backward-compatible — no token-cost series are emitted.
 */

import type { RolePricingMap } from "./token-pricing";
import { repriceRole } from "./token-pricing";

/**
 * Local type alias for the actuals overlay payload.
 * Mirrors ActualsOverlayInput from @workspace/api-client-react — kept local so
 * this module remains importable in the esbuild test context without workspace
 * package resolution.
 */
export interface OverlayPayload {
  clientLabel?: string;
  periodStart?: string;
  periodEnd?: string;
  intents?: Array<{
    intentKey: string;
    measuredContainmentRate?: number;
    avgHitlMinutes?: number;
  }>;
  measuredContainmentByFlowClass?: Record<string, number>;
  measuredHitlSamplingRate?: number;
  tokenActualsByRole?: Record<string, { avgInputTokens: number; avgOutputTokens: number }>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Polarity: which direction of change represents improvement. */
export type DriftPolarity = "higher-is-better" | "lower-is-better";

/** One overlay's measurement for a single assumption. */
export interface DriftPoint {
  overlayId: number;
  /** Short period label, e.g. "2025-01" or "Overlay #3". Unique within a series. */
  periodLabel: string;
  /** null when this overlay did not measure this assumption (gap). */
  measuredValue: number | null;
}

/** Time-series of measured values for one assumption across the selected overlays. */
export interface DriftSeries {
  assumptionKey: string;
  label: string;
  unit: string;
  polarity: DriftPolarity;
  /** Reference line value (from the global assumptions register or caller-supplied map). */
  estimate: number | null; // null = no register default available for this key
  /** Points sorted chronologically (periodStart asc, id asc for ties). */
  points: DriftPoint[];
  /** Trend direction across all non-null points (see computeTrend). */
  trend: "improving" | "degrading" | "stable" | "mixed";
  /**
   * quality(lastNonNull) - quality(firstNonNull):
   *   positive = moving in the favorable direction between first and last period.
   * Undefined when there is only one non-null point.
   */
  trendDelta: number | undefined;
}

/** Minimal overlay shape the drift lib needs (matches ActualsOverlayRecord). */
export interface DriftOverlayInput {
  id: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  clientLabel?: string | null;
  payload: OverlayPayload;
}

/**
 * Minimal slice of ScenarioInputs that scenarioToEstimateMap needs.
 * Kept local (no workspace-package imports) so drift.ts stays unit-testable
 * in a plain Node context.
 */
export interface ScenarioEstimateSource {
  /** Per-flow-class containment overrides (flow-class key → 0-1 fraction). */
  containmentOverrides?: Record<string, number>;
  /** Fraction of HITL checkpoints actually reviewed (0-1). */
  hitlSamplingRate?: number;
}
/**
 * Thrown by requireSingleClient (and transitively by computeDrift) when the
 * caller supplies overlays that span more than one clientLabel group.
 *
 * null / undefined clientLabel is its own distinct group ("unlabeled") — it
 * can never be mixed with a named client.
 */
export class MixedClientError extends Error {
  readonly clientLabels: string[];
  constructor(labels: string[]) {
    super(
      `computeDrift received overlays from ${labels.length} distinct client groups: ` +
        labels.join(", ") +
        ". Filter to a single client before calling.",
    );
    this.name = "MixedClientError";
    this.clientLabels = labels;
  }
}

/**
 * Throws MixedClientError if `overlays` span more than one distinct
 * clientLabel group.  Call this before any computation that must be
 * per-client.
 *
 * Rules:
 *   - overlays with clientLabel === null | undefined → group key "(unlabeled)"
 *   - all other overlays → group key is the clientLabel string
 *   - > 1 distinct group → throws
 */
export function requireSingleClient(overlays: DriftOverlayInput[]): void {
  const groups = new Set(overlays.map((o) => o.clientLabel ?? null));
  if (groups.size > 1) {
    const labels = [...groups].map((g) => (g === null ? "(unlabeled)" : g));
    throw new MixedClientError(labels);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fraction of the reference scale below which quality movement is "stable".
 * A series whose quality range is < STABLE_TOLERANCE × |estimate| is "stable".
 */
export const STABLE_TOLERANCE = 0.05;

// ---------------------------------------------------------------------------
// Internal drift spec — the set of assumptions extractable from an overlay
// ---------------------------------------------------------------------------

interface DriftSpec {
  key: string;
  label: string;
  unit: string;
  polarity: DriftPolarity;
  /** Canonical default from the global assumptions register (Decision B reference). */
  registerDefault: number;
  extract(payload: OverlayPayload): number | undefined;
}

const FC_CONTAINMENT_SPECS: DriftSpec[] = [
  {
    key: "containment-fc1",
    label: "Containment: deterministic self-service (FC1)",
    unit: "fraction",
    polarity: "higher-is-better",
    registerDefault: 0.95,
    extract: (p) => p.measuredContainmentByFlowClass?.["fc1-deterministic"],
  },
  {
    key: "containment-fc2",
    label: "Containment: grounded policy answers (FC2)",
    unit: "fraction",
    polarity: "higher-is-better",
    registerDefault: 0.85,
    extract: (p) => p.measuredContainmentByFlowClass?.["fc2-policy"],
  },
  {
    key: "containment-fc3",
    label: "Containment: multi-agent transactions (FC3)",
    unit: "fraction",
    polarity: "higher-is-better",
    registerDefault: 0.75,
    extract: (p) => p.measuredContainmentByFlowClass?.["fc3-multiagent"],
  },
  {
    key: "containment-fc4",
    label: "Containment: frontier judgment cases (FC4)",
    unit: "fraction",
    polarity: "higher-is-better",
    registerDefault: 0.60,
    extract: (p) => p.measuredContainmentByFlowClass?.["fc4-frontier"],
  },
];

const HITL_SAMPLING_SPEC: DriftSpec = {
  key: "hitl-sampling-rate",
  label: "HITL sampling rate",
  unit: "fraction",
  polarity: "higher-is-better", // matches rollup BENEFIT_KEYS — higher = more checkpoints reviewed
  registerDefault: 1.0,
  extract: (p) => p.measuredHitlSamplingRate,
};

const ALL_FIXED_SPECS: DriftSpec[] = [...FC_CONTAINMENT_SPECS, HITL_SAMPLING_SPEC];

// ---------------------------------------------------------------------------
// Period label helpers
// ---------------------------------------------------------------------------

/**
 * Shorten a full ISO date string to year-month ("2025-01-01" → "2025-01").
 * Passes through strings that are already year-month or shorter.
 */
function abbreviateDate(s: string): string {
  const m = s.match(/^(\d{4}-\d{2})/);
  return m ? m[1]! : s;
}

/**
 * Build a short period label for an overlay.
 * "2025-01" | "2025-01–2025-03" | "Overlay #id"
 */
export function periodLabel(overlay: DriftOverlayInput): string {
  if (!overlay.periodStart) return `Overlay #${overlay.id}`;
  const start = abbreviateDate(overlay.periodStart);
  if (!overlay.periodEnd) return start;
  const end = abbreviateDate(overlay.periodEnd);
  return start === end ? start : `${start}–${end}`;
}

/**
 * Sort key: ISO periodStart ascending, id ascending as tiebreaker.
 * Overlays without periodStart sort after those with one.
 */
function overlaySortKey(overlay: DriftOverlayInput): string {
  // "\uFFFF" sorts after all normal ISO date characters
  const start = overlay.periodStart ?? "\uFFFF";
  return `${start}::${String(overlay.id).padStart(12, "0")}`;
}

/**
 * Deduplicate period labels within a sorted overlay list.
 * When the same label appears more than once, append " (#id)" to disambiguate.
 */
function buildUniqueLabels(sorted: DriftOverlayInput[]): string[] {
  const rawLabels = sorted.map(periodLabel);
  const freq: Record<string, number> = {};
  for (const l of rawLabels) freq[l] = (freq[l] ?? 0) + 1;
  const seen: Record<string, number> = {};
  return sorted.map((ov, i) => {
    const base = rawLabels[i]!;
    if (freq[base]! > 1) {
      seen[base] = (seen[base] ?? 0) + 1;
      return `${base} (#${ov.id})`;
    }
    return base;
  });
}

// ---------------------------------------------------------------------------
// Trend computation
// ---------------------------------------------------------------------------

/**
 * Convert a measured value to a quality score where HIGHER = BETTER.
 * For "higher-is-better": quality = measured.
 * For "lower-is-better": quality = −measured.
 */
export function toQuality(measured: number, polarity: DriftPolarity): number {
  return polarity === "higher-is-better" ? measured : -measured;
}

/**
 * Compute the trend label for a series.
 *
 * Rules (evaluated in order):
 * 1. Fewer than 2 non-null points → "stable" (insufficient data).
 * 2. Quality range < STABLE_TOLERANCE × |estimate| → "stable" (negligible variation).
 * 3. All consecutive non-null quality deltas are non-negative → "improving".
 * 4. All consecutive non-null quality deltas are non-positive → "degrading".
 * 5. Direction reverses at least once → "mixed".
 *
 * @param points   Drift points in chronological order.
 * @param polarity Assumption polarity (determines quality direction).
 * @param estimate Reference value for the stable-tolerance scale.
 *                 Uses 1 when null (no register default).
 */
export function computeTrend(
  points: DriftPoint[],
  polarity: DriftPolarity,
  estimate: number | null,
): DriftSeries["trend"] {
  const nonNull = points.filter((p) => p.measuredValue !== null);
  if (nonNull.length < 2) return "stable";

  const qualities = nonNull.map((p) => toQuality(p.measuredValue!, polarity));
  const refScale = Math.max(Math.abs(estimate ?? 1), 0.0001);
  const rangeMin = Math.min(...qualities);
  const rangeMax = Math.max(...qualities);
  const qualityRange = rangeMax - rangeMin;

  // Rule 2: stable tolerance
  if (qualityRange / refScale < STABLE_TOLERANCE) return "stable";

  // Check monotonicity of consecutive pairs
  let hasUp = false;
  let hasDown = false;
  for (let i = 1; i < qualities.length; i++) {
    const delta = qualities[i]! - qualities[i - 1]!;
    if (delta > 0) hasUp = true;
    if (delta < 0) hasDown = true;
  }

  if (hasUp && hasDown) return "mixed";
  if (hasUp) return "improving";
  return "degrading";
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compute drift series from a set of actuals overlays.
 *
 * @param overlays       Two or more overlays to compare. Order does not matter —
 *                       the function sorts internally by periodStart asc, id asc.
 * @param estimateMap    Optional caller-supplied estimate overrides keyed by
 *                       assumption key. Accepts any subset of keys; the function
 *                       falls back to register defaults for un-supplied keys.
 *                       Future: pass scenario.appliedAssumptions values here.
 *                       Token-cost keys follow the pattern "token-cost-{role}".
 * @param intentLabels   Optional display name map (intentKey → name) for per-intent
 *                       series labels.
 * @param rolePricingMap Optional per-role pricing catalog used to reprice overlay
 *                       tokenActualsByRole into USD/call drift series. When omitted,
 *                       no token-cost series are emitted (backward-compatible).
 *                       Derived at runtime from the live /model-catalog API endpoint
 *                       (see calibration.tsx). Pass undefined to suppress token series.
 *
 * Returns one DriftSeries per assumption that is measured in at least one overlay.
 * Order: flow-class containment → HITL sampling → token cost per role →
 *        per-intent containment → per-intent HITL minutes.
 */
export function computeDrift(
  overlays: DriftOverlayInput[],
  estimateMap: Record<string, number> = {},
  intentLabels: Record<string, string> = {},
  rolePricingMap?: RolePricingMap,
): DriftSeries[] {
  if (overlays.length === 0) return [];

  // Guard: reject mixed-client input at the computation boundary.
  // This is the backstop — the UI should already filter to one client,
  // but computeDrift enforces it so no code path can silently produce
  // a cross-client series.
  requireSingleClient(overlays);

  // Sort overlays chronologically
  const sorted = [...overlays].sort((a, b) =>
    overlaySortKey(a).localeCompare(overlaySortKey(b)),
  );
  const uniqueLabels = buildUniqueLabels(sorted);

  const series: DriftSeries[] = [];

  // -- Fixed specs (fc containment + hitl sampling) --
  for (const spec of ALL_FIXED_SPECS) {
    const estimate: number =
      estimateMap[spec.key] !== undefined
        ? estimateMap[spec.key]!
        : spec.registerDefault;

    const points: DriftPoint[] = sorted.map((ov, i) => ({
      overlayId: ov.id,
      periodLabel: uniqueLabels[i]!,
      measuredValue: spec.extract(ov.payload) ?? null,
    }));

    if (points.every((p) => p.measuredValue === null)) continue;

    const nonNull = points.filter((p) => p.measuredValue !== null);
    const firstQ = toQuality(nonNull[0]!.measuredValue!, spec.polarity);
    const lastQ = toQuality(nonNull[nonNull.length - 1]!.measuredValue!, spec.polarity);

    series.push({
      assumptionKey: spec.key,
      label: spec.label,
      unit: spec.unit,
      polarity: spec.polarity,
      estimate,
      points,
      trend: computeTrend(points, spec.polarity, estimate),
      trendDelta: nonNull.length >= 2 ? lastQ - firstQ : undefined,
    });
  }

  // -- Per-role token cost (USD/call) --
  // Emitted only when rolePricingMap is provided and at least one overlay has
  // tokenActualsByRole data for the role. Polarity is lower-is-better: cheaper
  // calls represent improvement. Estimate = defaultPricePerCallUsd from the
  // pricing map (the baked per-call cost the model was assumed to have before
  // token actuals were measured).
  if (rolePricingMap) {
    // Collect every role present across all overlays that also has a pricing entry.
    const tokenRoles = new Set<string>();
    for (const ov of sorted) {
      for (const role of Object.keys(ov.payload.tokenActualsByRole ?? {})) {
        if (rolePricingMap[role]) tokenRoles.add(role);
      }
    }

    for (const role of tokenRoles) {
      const assumptionKey = `token-cost-${role}`;
      const pricing = rolePricingMap[role]!;
      const estimate: number =
        estimateMap[assumptionKey] !== undefined
          ? estimateMap[assumptionKey]!
          : pricing.defaultPricePerCallUsd;

      const points: DriftPoint[] = sorted.map((ov, i) => {
        const actuals = ov.payload.tokenActualsByRole?.[role];
        return {
          overlayId: ov.id,
          periodLabel: uniqueLabels[i]!,
          measuredValue:
            actuals !== undefined
              ? repriceRole(actuals, pricing)
              : null,
        };
      });

      if (points.every((p) => p.measuredValue === null)) continue;

      const nonNull = points.filter((p) => p.measuredValue !== null);
      const firstQ = toQuality(nonNull[0]!.measuredValue!, "lower-is-better");
      const lastQ = toQuality(nonNull[nonNull.length - 1]!.measuredValue!, "lower-is-better");

      series.push({
        assumptionKey,
        label: `Token cost/call: ${pricing.label}`,
        unit: "USD",
        polarity: "lower-is-better",
        estimate,
        points,
        trend: computeTrend(points, "lower-is-better", estimate),
        trendDelta: nonNull.length >= 2 ? lastQ - firstQ : undefined,
      });
    }
  }

  // -- Per-intent containment --
  const intentContKeys = new Set<string>();
  for (const ov of sorted) {
    for (const ia of ov.payload.intents ?? []) {
      if (ia.measuredContainmentRate !== undefined) intentContKeys.add(ia.intentKey);
    }
  }

  for (const intentKey of intentContKeys) {
    const assumptionKey = `intent-cont-${intentKey}`;
    const estimate: number | null =
      estimateMap[assumptionKey] !== undefined
        ? estimateMap[assumptionKey]!
        : null; // no per-intent register default

    const points: DriftPoint[] = sorted.map((ov, i) => {
      const ia = ov.payload.intents?.find((x) => x.intentKey === intentKey);
      return {
        overlayId: ov.id,
        periodLabel: uniqueLabels[i]!,
        measuredValue: ia?.measuredContainmentRate ?? null,
      };
    });

    if (points.every((p) => p.measuredValue === null)) continue;

    const nonNull = points.filter((p) => p.measuredValue !== null);
    const firstQ = toQuality(nonNull[0]!.measuredValue!, "higher-is-better");
    const lastQ = toQuality(nonNull[nonNull.length - 1]!.measuredValue!, "higher-is-better");

    series.push({
      assumptionKey,
      label: `Containment: ${intentLabels[intentKey] ?? intentKey}`,
      unit: "fraction",
      polarity: "higher-is-better",
      estimate,
      points,
      trend: computeTrend(points, "higher-is-better", estimate),
      trendDelta: nonNull.length >= 2 ? lastQ - firstQ : undefined,
    });
  }

  // -- Per-intent HITL minutes --
  const intentHitlKeys = new Set<string>();
  for (const ov of sorted) {
    for (const ia of ov.payload.intents ?? []) {
      if (ia.avgHitlMinutes !== undefined) intentHitlKeys.add(ia.intentKey);
    }
  }

  for (const intentKey of intentHitlKeys) {
    const assumptionKey = `intent-hitl-${intentKey}`;
    const estimate: number | null =
      estimateMap[assumptionKey] !== undefined
        ? estimateMap[assumptionKey]!
        : null; // toBeHumanMin from intent corpus — caller must supply

    const points: DriftPoint[] = sorted.map((ov, i) => {
      const ia = ov.payload.intents?.find((x) => x.intentKey === intentKey);
      return {
        overlayId: ov.id,
        periodLabel: uniqueLabels[i]!,
        measuredValue: ia?.avgHitlMinutes ?? null,
      };
    });

    if (points.every((p) => p.measuredValue === null)) continue;

    const nonNull = points.filter((p) => p.measuredValue !== null);
    const firstQ = toQuality(nonNull[0]!.measuredValue!, "lower-is-better");
    const lastQ = toQuality(nonNull[nonNull.length - 1]!.measuredValue!, "lower-is-better");

    series.push({
      assumptionKey,
      label: `HITL minutes: ${intentLabels[intentKey] ?? intentKey}`,
      unit: "minutes",
      polarity: "lower-is-better",
      estimate,
      points,
      trend: computeTrend(points, "lower-is-better", estimate),
      trendDelta: nonNull.length >= 2 ? lastQ - firstQ : undefined,
    });
  }

  return series;
}

/**
 * Convert a scenario's applied assumptions into an `estimateMap` for
 * `computeDrift`.
 *
 * Flow-class containment overrides are expanded in two ways:
 *   1. Fixed-spec keys: "containment-fc1" … "containment-fc4"
 *   2. Per-intent keys (Option 3): "intent-cont-{intentKey}" for every intent
 *      whose flowClass maps to an overridden flow class. This populates
 *      per-intent estimate cells that would otherwise show "N/A".
 *
 * Keys absent from the returned map fall through to register defaults in
 * computeDrift — no key is added for unset or unrecognised inputs.
 *
 * @param source            Scenario inputs slice.
 * @param intentFlowClasses Map of intentKey → flowClass for per-intent
 *                          expansion. Pass `{}` or omit when not needed.
 */
export function scenarioToEstimateMap(
  source: ScenarioEstimateSource,
  intentFlowClasses: Record<string, string> = {},
): Record<string, number> {
  const map: Record<string, number> = {};
  const co = source.containmentOverrides ?? {};

  // 1. Flow-class containment overrides → fixed drift-spec keys
  for (const [fcKey, val] of Object.entries(co)) {
    const driftKey = FC_KEY_TO_DRIFT_KEY[fcKey];
    if (driftKey !== undefined) map[driftKey] = val;
  }

  // 2. HITL sampling rate
  if (source.hitlSamplingRate !== undefined) {
    map["hitl-sampling-rate"] = source.hitlSamplingRate;
  }

  // 3. Per-intent containment expansion from flow-class overrides.
  //    For each intent whose flow class has a scenario override, emit
  //    intent-cont-{intentKey} = that override value.
  for (const [intentKey, flowClass] of Object.entries(intentFlowClasses)) {
    const fcVal = co[flowClass];
    if (fcVal !== undefined) {
      map[`intent-cont-${intentKey}`] = fcVal;
    }
  }

  return map;
}

/**
 * Maps a flow-class key (as used by ScenarioInputs.containmentOverrides)
 * to the corresponding drift assumptionKey used by computeDrift.
 */
const FC_KEY_TO_DRIFT_KEY: Record<string, string> = {
  "fc1-deterministic": "containment-fc1",
  "fc2-policy": "containment-fc2",
  "fc3-multiagent": "containment-fc3",
  "fc4-frontier": "containment-fc4",
};
