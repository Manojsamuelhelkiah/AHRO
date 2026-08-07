/**
 * Pure schema and serialization helpers for the Scenario Builder form.
 * Extracted here so they can be unit-tested without any React/DOM dependency.
 *
 * This module is the canonical toApiInputs / fromApiInputs pair used by
 * scenario.tsx.  Do NOT duplicate these functions on the page.
 */
import * as z from "zod";
import type { ScenarioInputs } from "@workspace/api-client-react";
import {
  OVERRIDABLE_ASSUMPTION_KEYS,
  buildAssumptionOverrides,
  type OverridableKey,
} from "./scenario-mapper.js";

// ─── Flow-class constants ─────────────────────────────────────────────────────

export const FLOW_CLASSES = [
  { key: "fc1-deterministic", label: "FC1 – Deterministic" },
  { key: "fc2-policy",        label: "FC2 – Policy Answer" },
  { key: "fc3-multiagent",    label: "FC3 – Multi-Agent" },
  { key: "fc4-frontier",      label: "FC4 – Frontier" },
] as const;

export type FcKey = typeof FLOW_CLASSES[number]["key"];

export const DEFAULT_CONTAINMENT: Record<FcKey, number> = {
  "fc1-deterministic": 0.95,
  "fc2-policy":        0.88,
  "fc3-multiagent":    0.80,
  "fc4-frontier":      0.70,
};

export const DEFAULT_SAMPLING: Record<FcKey, number> = {
  "fc1-deterministic": 0.05,
  "fc2-policy":        0.15,
  "fc3-multiagent":    0.30,
  "fc4-frontier":      0.60,
};

// ─── Schema helpers ───────────────────────────────────────────────────────────

/** Empty inputs are treated as "not provided" — the model falls back to documented defaults. */
export const optionalNumber = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? undefined : v),
    schema.optional(),
  );

/**
 * Per-FC rate record: each entry uses the same empty-to-undefined preprocessing so clearing
 * an individual field omits it from the submitted object rather than coercing to 0.
 */
export const fcRateEntrySchema = z.preprocess(
  (v) => (v === "" || v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? undefined : v),
  z.number().min(0).max(1).optional(),
);
export const fcRateSchema = z.record(fcRateEntrySchema);

/**
 * Assumption-override entries: accept a numeric value or an explicit empty string
 * (clearing a field).  Empty string is preserved in form state so React Hook Form
 * can render a controlled input, then stripped by toApiInputs/buildAssumptionOverrides.
 */
const assumptionOverridesSchema = z.object(
  Object.fromEntries(
    OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [
      k,
      z.union([z.literal(""), z.coerce.number().min(0, "Must be ≥ 0")]).optional(),
    ])
  )
) as z.ZodObject<Record<OverridableKey, z.ZodOptional<z.ZodUnion<[z.ZodLiteral<"">, z.ZodNumber]>>>>;

// ─── Form schema ──────────────────────────────────────────────────────────────

export const formSchema = z.object({
  // Core (required)
  numSystems:           z.coerce.number().int("Whole number required").min(1, "At least 1 system"),
  annualTransactions:   z.coerce.number().int("Whole number required").min(100, "Min 100 transactions"),
  employees:            z.coerce.number().int("Whole number required").min(10, "Min 10 employees"),
  sector:               z.string().min(1, "Required"),
  companyType:          z.enum(["single-country", "multi-country", "global"]),
  isolationTier:        z.enum(["pooled", "siloed", "dedicated"]),
  hrHourlyCostUsd:      z.coerce.number().min(1),
  hitlHourlyCostUsd:    z.coerce.number().min(1),
  countries:            z.coerce.number().int("Whole number required").min(1),

  // Automation Fidelity – per-FC objects (primary precision fields)
  containmentRates:     fcRateSchema.optional(),
  adoptionRampY1:       optionalNumber(z.number().min(0).max(1)),
  adoptionRampY2:       optionalNumber(z.number().min(0).max(1)),
  adoptionRampY3:       optionalNumber(z.number().min(0).max(1)),
  hitlSamplingRates:    fcRateSchema.optional(),

  // Scalar fallbacks — persisted on load for backward-compat with saves predating
  // per-FC records.  toApiInputs passes them through only when the per-FC fields
  // are absent so the model can still apply them.
  adoptionRate:         optionalNumber(z.coerce.number().min(0.01, "Min 1%").max(1, "Max 100%")),
  hitlSamplingRate:     optionalNumber(z.coerce.number().min(0.01, "Min 1%").max(1, "Max 100%")),

  // Delivery & Seasonality
  landscapeMaturity:    z.enum(["clean", "mixed", "legacy"]).optional(),
  contractYears:        optionalNumber(z.coerce.number().int("Whole number required").min(1).max(10)),
  peakLoadFactor:       optionalNumber(z.coerce.number().min(1, "Min 1.0").max(1.5, "Max 1.5")),

  // Cost Baseline extras
  reworkRatePct:        optionalNumber(z.coerce.number().min(0).max(20, "Max 20%")),

  // AI Model Stack (optional; absence = use registered defaults)
  modelRouter:          z.string().optional(),
  modelReasoning:       z.string().optional(),
  modelFrontier:        z.string().optional(),
  modelData:            z.string().optional(),

  // Non-integrated systems
  nonIntegratedSystems: z.array(z.string()).optional(),

  // Assumption overrides (Tune Assumptions panel).
  // The private _assumptionOverrides field is the ONLY place these live in the
  // form.  The API-shaped assumptionOverrides key must NEVER appear as a
  // top-level form value (fromApiInputs strips it and re-exposes via this field).
  _assumptionOverrides: assumptionOverridesSchema.optional(),

  // Per-intent containment targets (drift comparison only).
  // The private _intentContainmentOverrides field is the ONLY place these live
  // in the form. Never spread raw API intentContainmentOverrides here.
  // Empty-string entries mean "cleared / not set" and are stripped by toApiInputs.
  _intentContainmentOverrides: z.record(
    z.preprocess(
      (v) => (v === "" || v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? undefined : v),
      z.number().min(0).max(1).optional(),
    )
  ).optional(),
});

export type FormValues = z.infer<typeof formSchema>;

// ─── Default form values ──────────────────────────────────────────────────────

export const defaultValues: FormValues = {
  numSystems:         5,
  annualTransactions: 50000,
  employees:          5000,
  sector:             "technology",
  companyType:        "multi-country",
  isolationTier:      "siloed",
  hrHourlyCostUsd:    45,
  hitlHourlyCostUsd:  35,
  countries:          3,
  // Advanced fields intentionally absent — model uses register defaults,
  // and absence (not equality-with-default) drives the confidence score.
};

// ─── Serialization helpers ────────────────────────────────────────────────────

/**
 * Strips keys whose values are undefined from a per-FC record.
 * Returns undefined when no keys remain — so the field is omitted from API inputs
 * and the model falls back to its registered defaults (preserving confidence score).
 */
export function compactFcRecord(
  r: Record<string, number | undefined> | undefined,
): Record<string, number> | undefined {
  if (!r) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ─── Canonical mapper pair ────────────────────────────────────────────────────

/**
 * Maps validated form values → ScenarioInputs for compute/save API calls.
 *
 * Invariant: `_assumptionOverrides` is the single source for assumption overrides.
 * Any stale top-level `assumptionOverrides` key (which must never appear in
 * FormValues, but is guarded here for safety) is stripped and rebuilt from
 * `_assumptionOverrides` only.
 */
export function toApiInputs(v: FormValues): ScenarioInputs {
  const inputs: ScenarioInputs = {
    numSystems:         v.numSystems,
    annualTransactions: v.annualTransactions,
    employees:          v.employees,
    sector:             v.sector,
    companyType:        v.companyType,
    isolationTier:      v.isolationTier,
    hrHourlyCostUsd:    v.hrHourlyCostUsd,
    hitlHourlyCostUsd:  v.hitlHourlyCostUsd,
    countries:          v.countries,
  };

  // Per-FC containment rates (primary path).
  const cr = compactFcRecord(v.containmentRates);
  if (cr) inputs.containmentRates = cr;

  // Adoption ramp — only serialize when all three years are present;
  // a partial ramp is ambiguous.  Fall back to legacy scalar when ramp absent.
  const inputsAny = inputs as unknown as Record<string, unknown>;
  if (v.adoptionRampY1 !== undefined && v.adoptionRampY2 !== undefined && v.adoptionRampY3 !== undefined)
    inputsAny.adoptionRamp = [v.adoptionRampY1, v.adoptionRampY2, v.adoptionRampY3];
  else if (v.adoptionRate !== undefined)
    inputsAny.adoptionRate = v.adoptionRate;

  // Per-FC HITL sampling rates (primary path); fall back to legacy scalar.
  const hsr = compactFcRecord(v.hitlSamplingRates);
  if (hsr) inputs.hitlSamplingRates = hsr;
  else if (v.hitlSamplingRate !== undefined)
    inputsAny.hitlSamplingRate = v.hitlSamplingRate;

  // Delivery & Seasonality.
  if (v.landscapeMaturity !== undefined) inputs.landscapeMaturity = v.landscapeMaturity;
  if (v.contractYears     !== undefined) inputs.contractYears     = v.contractYears;
  if (v.peakLoadFactor    !== undefined) inputs.peakLoadFactor    = v.peakLoadFactor;
  if (v.reworkRatePct     !== undefined) inputs.reworkRatePct     = v.reworkRatePct;

  // Model selection — only pass confirmed values; absence = use registered defaults.
  const modelSelection: Record<string, string> = {};
  if (v.modelRouter)    modelSelection.router    = v.modelRouter;
  if (v.modelReasoning) modelSelection.reasoning = v.modelReasoning;
  if (v.modelFrontier)  modelSelection.frontier  = v.modelFrontier;
  if (v.modelData)      modelSelection.data       = v.modelData;
  if (Object.keys(modelSelection).length > 0) inputs.modelSelection = modelSelection;

  // Non-integrated systems — absence = all integrated.
  if ((v.nonIntegratedSystems?.length ?? 0) > 0)
    inputs.nonIntegratedSystems = v.nonIntegratedSystems;

  // Assumption overrides: build from _assumptionOverrides, stripping empties.
  // Guard against any stale top-level assumptionOverrides that may have leaked in.
  const assumptionOverrides = buildAssumptionOverrides(
    v._assumptionOverrides as Partial<Record<OverridableKey, number | "">>,
  );
  if (assumptionOverrides !== undefined)
    inputs.assumptionOverrides = assumptionOverrides;

  // Per-intent containment overrides (drift comparison only).
  // Collapse _intentContainmentOverrides → intentContainmentOverrides, stripping empties/undefined.
  const ico = v._intentContainmentOverrides;
  if (ico) {
    const result: Record<string, number> = {};
    for (const [k, val] of Object.entries(ico)) {
      if (val !== undefined && val !== null && val !== ("" as unknown)) {
        result[k] = Number(val);
      }
    }
    if (Object.keys(result).length > 0)
      inputs.intentContainmentOverrides = result;
  }

  return inputs;
}

/**
 * Maps a stored ScenarioInputs record back to the flat form shape.
 *
 * Handles:
 *   - assumptionOverrides → _assumptionOverrides (critical: never leaks as raw top-level key)
 *   - containmentRates (current) and legacy containmentOverrides → merged containmentRates
 *   - adoptionRamp array (current) and legacy adoptionRate scalar
 *   - hitlSamplingRates record (current) and legacy hitlSamplingRate scalar
 *   - modelSelection → individual model fields
 */
export function fromApiInputs(s: ScenarioInputs): FormValues {
  const raw = s as unknown as Record<string, unknown>;

  const ramp = raw.adoptionRamp  as [number, number, number] | undefined;
  const cr   = raw.containmentRates  as Record<string, number> | undefined;
  const co   = raw.containmentOverrides as Record<string, number> | undefined; // legacy field name
  const hsr  = raw.hitlSamplingRates as Record<string, number> | undefined;
  const ms   = raw.modelSelection   as Record<string, string>  | undefined;
  const ov   = raw.assumptionOverrides as Record<string, number> | undefined;
  const ico  = raw.intentContainmentOverrides as Record<string, number> | undefined;

  // Merge legacy containmentOverrides (lower priority) with current containmentRates.
  const mergedCr: Record<string, number> | undefined =
    (cr || co) ? { ...co, ...cr } : undefined;

  // Rebuild _assumptionOverrides — the ONLY place assumption overrides live in form state.
  const _assumptionOverrides: Partial<Record<OverridableKey, number | "">> = {};
  if (ov) {
    for (const k of OVERRIDABLE_ASSUMPTION_KEYS) {
      if (ov[k] !== undefined) _assumptionOverrides[k] = ov[k];
    }
  }

  // Rebuild _intentContainmentOverrides — never expose raw intentContainmentOverrides
  // as a top-level form key. Only carry through valid numeric 0-1 values.
  const _intentContainmentOverrides: Record<string, number | undefined> = {};
  if (ico) {
    for (const [k, v] of Object.entries(ico)) {
      if (typeof v === "number" && v >= 0 && v <= 1) {
        _intentContainmentOverrides[k] = v;
      }
    }
  }

  return {
    numSystems:         s.numSystems,
    annualTransactions: s.annualTransactions,
    employees:          s.employees,
    sector:             s.sector,
    companyType:        s.companyType as FormValues["companyType"],
    isolationTier:      s.isolationTier as FormValues["isolationTier"],
    hrHourlyCostUsd:    s.hrHourlyCostUsd,
    hitlHourlyCostUsd:  s.hitlHourlyCostUsd,
    countries:          s.countries,
    // Automation Fidelity — only restore explicitly-saved fields so confidence
    // score stays honest (absence ≠ equality with default).
    containmentRates:   mergedCr,
    adoptionRampY1:     ramp?.[0],
    adoptionRampY2:     ramp?.[1],
    adoptionRampY3:     ramp?.[2],
    // Legacy scalar adoption rate: restored only when no per-FC ramp is present.
    adoptionRate:       ramp ? undefined : (raw.adoptionRate as number | undefined),
    hitlSamplingRates:  hsr,
    // Legacy scalar HITL rate: restored only when no per-FC rates are present.
    hitlSamplingRate:   hsr ? undefined : (raw.hitlSamplingRate as number | undefined),
    landscapeMaturity:  s.landscapeMaturity as FormValues["landscapeMaturity"],
    contractYears:      s.contractYears,
    peakLoadFactor:     s.peakLoadFactor,
    reworkRatePct:      s.reworkRatePct,
    modelRouter:        ms?.router,
    modelReasoning:     ms?.reasoning,
    modelFrontier:      ms?.frontier,
    modelData:          ms?.data,
    nonIntegratedSystems: (raw.nonIntegratedSystems as string[] | undefined) ?? [],
    _assumptionOverrides:
      Object.keys(_assumptionOverrides).length > 0 ? _assumptionOverrides : {},
    _intentContainmentOverrides:
      Object.keys(_intentContainmentOverrides).length > 0 ? _intentContainmentOverrides : {},
  };
}
