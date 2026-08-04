/**
 * Pure form↔API mappers for ScenarioInputs.
 *
 * These functions are intentionally free of React so they can be unit-tested
 * with Node's built-in test runner (see scenario-mapper.test.ts).
 */
import type { ScenarioInputs } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Overridable assumption key registry
// ---------------------------------------------------------------------------

export const OVERRIDABLE_ASSUMPTION_KEYS = [
  "slm-call-cost",
  "llm-call-cost",
  "frontier-call-cost",
  "mcp-action-cost",
  "infra-per-txn",
  "landscape-fanout",
  "country-localization",
  "tier-pooled",
  "tier-siloed",
  "tier-dedicated",
  "company-multi-country",
  "company-global",
] as const;

export type OverridableKey = (typeof OVERRIDABLE_ASSUMPTION_KEYS)[number];

// ---------------------------------------------------------------------------
// Form-values interface (structural — no Zod dependency)
// ---------------------------------------------------------------------------

/** The shape the mapper cares about; scenario.tsx's FormValues satisfies this. */
export interface MapperFormValues {
  adoptionRate?: number;
  hitlSamplingRate?: number;
  landscapeMaturity?: "clean" | "mixed" | "legacy";
  contractYears?: number;
  reworkRatePct?: number;
  peakLoadFactor?: number;
  containmentFc1?: number;
  containmentFc2?: number;
  containmentFc3?: number;
  containmentFc4?: number;
  /** Private form field: per-key overrides entered by the user. */
  _assumptionOverrides?: Partial<Record<OverridableKey, number | "">>;
  /**
   * NOT a real form field. The API returns this key inside ScenarioInputs, and
   * it may be inadvertently spread into form values when a saved scenario is
   * loaded. The mappers always strip it and rebuild solely from
   * _assumptionOverrides so that "Reset all to defaults" produces a clean
   * payload.
   */
  assumptionOverrides?: Record<string, number>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapse the form's _assumptionOverrides into a ScenarioInputs override
 * record. Empty strings and undefined values are treated as "not set".
 * Returns undefined when no active overrides remain (i.e. all cleared).
 */
export function buildAssumptionOverrides(
  raw: Partial<Record<OverridableKey, number | "">> | undefined
): Record<string, number> | undefined {
  if (!raw) return undefined;
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== "" && v !== undefined && v !== null) {
      result[k] = Number(v);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// Form → API
// ---------------------------------------------------------------------------

/**
 * Maps the flat form values to a ScenarioInputs payload for the API.
 *
 * Key invariant: **always** destructures out both `_assumptionOverrides` AND
 * any stale `assumptionOverrides` that may have been spread in when loading a
 * saved scenario, then rebuilds the override record solely from
 * `_assumptionOverrides`. This ensures that after the user clicks "Reset all
 * to defaults" the outgoing payload (and any subsequent save) contains no
 * assumptionOverrides whatsoever.
 */
export function toApiInputs(v: MapperFormValues): ScenarioInputs {
  const {
    adoptionRate,
    hitlSamplingRate,
    landscapeMaturity,
    contractYears,
    reworkRatePct,
    peakLoadFactor,
    containmentFc1,
    containmentFc2,
    containmentFc3,
    containmentFc4,
    _assumptionOverrides,
    assumptionOverrides: _staleOverrides, // always strip — rebuilt below from _assumptionOverrides
    ...core
  } = v;

  const containmentOverrides: Record<string, number> = {};
  if (containmentFc1 !== undefined) containmentOverrides["fc1-deterministic"] = containmentFc1;
  if (containmentFc2 !== undefined) containmentOverrides["fc2-policy"] = containmentFc2;
  if (containmentFc3 !== undefined) containmentOverrides["fc3-multiagent"] = containmentFc3;
  if (containmentFc4 !== undefined) containmentOverrides["fc4-frontier"] = containmentFc4;

  const assumptionOverrides = buildAssumptionOverrides(_assumptionOverrides);

  return {
    ...core,
    ...(adoptionRate !== undefined && { adoptionRate }),
    ...(hitlSamplingRate !== undefined && { hitlSamplingRate }),
    ...(landscapeMaturity !== undefined && { landscapeMaturity }),
    ...(contractYears !== undefined && { contractYears }),
    ...(reworkRatePct !== undefined && { reworkRatePct }),
    ...(peakLoadFactor !== undefined && { peakLoadFactor }),
    ...(Object.keys(containmentOverrides).length > 0 && { containmentOverrides }),
    ...(assumptionOverrides !== undefined && { assumptionOverrides }),
  } as ScenarioInputs;
}

// ---------------------------------------------------------------------------
// API → Form (for loading saved scenarios)
// ---------------------------------------------------------------------------

/** Fallback defaults used when a saved scenario omits a field. */
export const DEFAULT_FORM_VALUES = {
  numSystems: 5,
  annualTransactions: 50000,
  employees: 5000,
  sector: "technology",
  companyType: "multi-country" as const,
  isolationTier: "siloed" as const,
  hrHourlyCostUsd: 45,
  hitlHourlyCostUsd: 35,
  countries: 3,
};

/**
 * Maps a stored ScenarioInputs record back to the flat form shape.
 *
 * Critically, `containmentOverrides` and `assumptionOverrides` are
 * **destructured out before spreading** so they never land as top-level form
 * keys. `assumptionOverrides` is rebuilt into the private `_assumptionOverrides`
 * field; `containmentOverrides` is mapped to the flat `containmentFc*` fields.
 */
export function fromApiInputs(inputs: Record<string, unknown>): MapperFormValues {
  // Explicitly pull out the composite API keys before spreading so they never
  // appear as raw top-level form values.
  const {
    containmentOverrides,
    assumptionOverrides,
    ...flatInputs
  } = inputs;

  const co = (containmentOverrides ?? {}) as Record<string, number>;
  const savedOv = (assumptionOverrides ?? {}) as Record<string, number>;

  const _assumptionOverrides: Partial<Record<OverridableKey, number | "">> = {};
  for (const k of OVERRIDABLE_ASSUMPTION_KEYS) {
    if (savedOv[k] !== undefined) {
      _assumptionOverrides[k] = savedOv[k];
    }
  }

  return {
    ...DEFAULT_FORM_VALUES,
    ...flatInputs,
    containmentFc1: co["fc1-deterministic"],
    containmentFc2: co["fc2-policy"],
    containmentFc3: co["fc3-multiagent"],
    containmentFc4: co["fc4-frontier"],
    // _assumptionOverrides is the ONLY place assumption overrides live in the form
    _assumptionOverrides:
      Object.keys(_assumptionOverrides).length > 0 ? _assumptionOverrides : {},
    // assumptionOverrides is intentionally absent from the returned object
  };
}
