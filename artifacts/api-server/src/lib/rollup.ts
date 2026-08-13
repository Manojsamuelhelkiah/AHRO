import { intents, intentMap } from "../data/intents";
import { buildComponents } from "../data/build-components";
import { flowClassMap } from "../data/flow-classes";
import { profileMap, profiles } from "../data/profiles";
import { assumptionMap } from "../data/assumptions";
import { pricePerCall, pricePerCallWithOverlay, MODEL_ROLES } from "../data/model-catalog";
import type { GlobalAssumption, Intent, ActualsOverlay } from "../data/types";
import { intents as referenceIntents } from "../data/intents";

export interface ScenarioInputs {
  numSystems: number;

  annualTransactions: number;

  employees: number;

  sector: string;

  companyType: string;

  isolationTier: string;

  hrHourlyCostUsd: number;

  hitlHourlyCostUsd: number;

  countries: number;

  intentShareOverrides?: Record<string, number>;

  // --- Comparison-task optional fields ---
  /** Share of committed volume in the agentic channel (0-1). Superseded per-year by adoptionRamp. */

  adoptionRate?: number;
  /** Per-flow-class containment overrides (0-1). Superseded per-class by containmentRates. */

  containmentOverrides?: Record<string, number>;
  /** Global fraction of residual HITL minutes actually spent (0-1). Superseded per-class by hitlSamplingRates. */

  hitlSamplingRate?: number;
  /** clean | mixed | legacy (default mixed). */

  landscapeMaturity?: string;
  /** Contract length in years for onboarding amortization (default 3). */

  contractYears?: number;
  /** As-is rework share of transactions in percent (0-20, default 0). */

  reworkRatePct?: number;
  /** Seasonality premium on avoided human effort (1-1.5, default 1). */

  peakLoadFactor?: number;

  // --- Our per-FC precision fields (take precedence over comparison-task scalars) ---
  /** Per-flow-class containment rate (0–1). Non-contained txns fall back to full as-is human cost. */

  modelSelection?: Record<string, string>;
  /** Landscape systems that will NOT be integrated with the MCP layer; their actions stay manual. */

  nonIntegratedSystems?: string[];

  assumptionOverrides?: Record<string, number>;

  containmentRates?: Partial<Record<string, number>>;
  /** Three-element adoption ramp [y1, y2, y3]; each is fraction of annualTransactions in the automated channel. */

  adoptionRamp?: [number, number, number];
  /** Per-flow-class fraction of automated txns that also get HITL review; scales toBeHumanMin. */

  hitlSamplingRates?: Partial<Record<string, number>>;
}

const DEFAULT_CONTAINMENT: Record<string, string> = {
  "fc1-deterministic": "containment-fc1",
  "fc2-policy":        "containment-fc2",
  "fc3-multiagent":    "containment-fc3",
  "fc4-frontier":      "containment-fc4",
};
/**
 * The set of assumption keys that can be overridden per scenario.
 * working-hours-year is intentionally excluded (FTE calc would surprise users).
 */
export const OVERRIDABLE_ASSUMPTION_KEYS = new Set([
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
]);

/** Approved SME adjustments applied to an intent before pricing. */
export interface FlowOverrideValues {
  flowClass?: string;
  toBeHumanMin?: number;
  actGetActions?: number;
  actPutActions?: number;
}

/** Per-assumption variance between pre-calibration estimate and overlay measurement. */
export interface VarianceEntry {
  assumptionKey: string;
  label: string;
  unit: string;
  estimatedValue: number;
  actualValue: number;
  absVariance: number;
  pctVariance: number;
  /** Which side of the model this assumption primarily affects. */
  direction: "cost" | "benefit" | "both";
}
function sizeBand(employees: number): string {
  if (employees < 1000) return "small";
  if (employees < 5000) return "mid";
  if (employees < 20000) return "large";
  return "enterprise";
}

const COMPLEX_CLASSES = new Set(["fc3-multiagent", "fc4-frontier"]);

/**
 * Distribute total annual transactions across intents:
 * share_i ∝ baseWeight_i × sectorDomainWeight(domain_i)
 *          × (sizeAdjustment if intent is a complex class - larger orgs skew complex)
 * Manual intentShareOverrides pin exact shares; remaining intents are
 * normalized into the leftover share.
 *
 * @param extraIntents  Active custom intents loaded from the DB; they participate
 *                      in the weight pool exactly like reference intents.
 */
export function computeShares(inputs: ScenarioInputs, extraIntents: Intent[] = []): Map<string, number> {
  const allIntents = [...referenceIntents, ...extraIntents];
  const profile = profileMap[inputs.sector] ?? profiles[0]!;
  const band = sizeBand(inputs.employees);
  const sizeAdj = profile.sizeAdjustments[band] ?? 1;
  const overrides = inputs.intentShareOverrides ?? {};

  const weights = new Map<string, number>();
  for (const it of allIntents) {
    if (overrides[it.key] !== undefined) continue;
    const dw = profile.domainWeights[it.domain] ?? 1;
    const complexAdj = COMPLEX_CLASSES.has(it.flowClass) ? sizeAdj : 1;
    weights.set(it.key, it.baseWeight * dw * complexAdj);
  }

  const overrideTotal = Object.entries(overrides).reduce(
    (s, [k, v]) => (allIntents.some((i) => i.key === k) ? s + Math.max(0, v) : s),
    0,
  );
  const remaining = Math.max(0, 1 - Math.min(1, overrideTotal));
  const weightSum = [...weights.values()].reduce((a, b) => a + b, 0) || 1;

  const shares = new Map<string, number>();
  for (const it of allIntents) {
    const ov = overrides[it.key];
    if (ov !== undefined) shares.set(it.key, Math.max(0, ov));
    else shares.set(it.key, ((weights.get(it.key) ?? 0) / weightSum) * remaining);
  }
  return shares;
}

function tierMultiplierFor(
  tier: string,
  overrides?: Record<string, number>,
): { mult: number; assumption: GlobalAssumption } {
  const key =
    tier === "dedicated"
      ? "tier-dedicated"
      : tier === "siloed"
        ? "tier-siloed"
        : "tier-pooled";
  const a = effectiveAssumption(key, overrides);
  return { mult: a.value, assumption: a };
}

function companyMultiplierFor(
  companyType: string,
  overrides?: Record<string, number>,
): { mult: number; assumption?: GlobalAssumption } {
  if (companyType === "multi-country") {
    const a = effectiveAssumption("company-multi-country", overrides);
    return { mult: a.value, assumption: a };
  }
  if (companyType === "global") {
    const a = effectiveAssumption("company-global", overrides);
    return { mult: a.value, assumption: a };
  }
  return { mult: 1 };
}

// ─── Per-transaction cost ──────────────────────────────────────────────────────

interface PerTxnCost {
  ai: number;
  infra: number;
  other: number;
  /** Dollarized step benefits + rework benefit (does NOT include human-time benefit; that's in computeRollup) */
  stepBenefit: number;
}
export function maturityAssumptionFor(landscapeMaturity: string | undefined): GlobalAssumption {
  const key = `maturity-${landscapeMaturity ?? "mixed"}`;
  return assumptionMap[key] ?? assumptionMap["maturity-mixed"]!;
}

/**
 * Per-action-type fractions of an intent's act-stage GET/PUT work that hit
 * non-integrated systems. Those actions cannot go through the MCP layer and
 * stay manual (swivel-chair) work.
 */
export function manualActionFractions(
  it: Intent,
  inputs: ScenarioInputs,
): { getFrac: number; putFrac: number; automatedUnits: number; manualUnits: number } {
  const fc = flowClassMap[it.flowClass];
  const maturity = maturityAssumptionFor(inputs.landscapeMaturity);
  const fanout = assumptionMap["landscape-fanout"]!.value * maturity.value;
  const extraSystems = Math.max(0, Math.min(inputs.numSystems, 12) - it.systemsTouchedBase);
  const landscapeFactor = 1 + fanout * extraSystems;
  const excluded = new Set(inputs.nonIntegratedSystems ?? []);

  const pools = {
    get: { touches: 0, weighted: 0, weightedExcluded: 0, anyScales: false },
    put: { touches: 0, weighted: 0, weightedExcluded: 0, anyScales: false },
  };
  if (fc) {
    for (const step of fc.steps) {
      if (step.stage !== "act") continue;
      for (const sys of step.systems) {
        const weight = sys.scalesWithLandscape ? landscapeFactor : 1;
        for (const action of sys.actions) {
          const pool = action === "get" ? pools.get : action === "put" ? pools.put : undefined;
          if (!pool) continue;
          pool.touches += 1;
          pool.weighted += weight;
          if (sys.scalesWithLandscape) pool.anyScales = true;
          if (excluded.has(sys.systemKey)) pool.weightedExcluded += weight;
        }
      }
    }
  }

  const split = (actions: number, pool: (typeof pools)["get"]) => {
    if (pool.touches === 0) {
      return { automated: actions * (pool.anyScales ? landscapeFactor : 1), manual: 0, frac: 0 };
    }
    const perTouch = actions / pool.touches;
    const manual = perTouch * pool.weightedExcluded;
    const automated = perTouch * (pool.weighted - pool.weightedExcluded);
    return { automated, manual, frac: pool.weightedExcluded / pool.weighted };
  };
  const g = split(it.actGetActions, pools.get);
  const p = split(it.actPutActions, pools.put);
  return {
    getFrac: g.frac,
    putFrac: p.frac,
    automatedUnits: g.automated + p.automated,
    manualUnits: g.manual + p.manual,
  };
}
/** Per-transaction cost/benefit for one intent, before tier/company multipliers on ai+infra.
 * Returns stepBenefit (step dollarized + rework); human cost and peak-load benefit are applied
 * per-year in computeRollup so they can vary across the adoption ramp.
 * When ctx is present (calibration overlay), model calls are repriced from measured token actuals.
 */
function perTransaction(it: Intent, inputs: ScenarioInputs, ctx?: OverlayContext): PerTxnCost {
  const ov = inputs.assumptionOverrides;
  const fc = flowClassMap[it.flowClass];
  // Landscape maturity scales Act fan-out effort: legacy landscapes make each
  // extra system more expensive to touch, clean landscapes cheaper.
  const maturity = maturityAssumptionFor(inputs.landscapeMaturity);
  const fanout = eff("landscape-fanout", ov) * maturity.value;
  const mcpCost = eff("mcp-action-cost", ov);
  // automatedUnits carries fan-out weighting for MCP-integrated systems only.
  const { automatedUnits } = manualActionFractions(it, inputs);

  // Model-cost scaling ratio for ai-consumption components without explicit c.calls.
  const primaryModelKey = FC_PRIMARY_MODEL[it.flowClass] ?? "slm-call-cost";
  const defaultModelCost = assumptionMap[primaryModelKey]!.value;
  const modelRatio = defaultModelCost > 0 ? eff(primaryModelKey, ov) / defaultModelCost : 1;

  // Infra cost ratio scaling.
  const defaultInfra = assumptionMap["infra-per-txn"]!.value;
  const infraRatio = defaultInfra > 0 ? eff("infra-per-txn", ov) / defaultInfra : 1;

  let ai = 0;
  let infra = 0;
  let other = 0;
  let stepBenefit = 0;

  if (fc) {
    for (const step of fc.steps) {
      const scales = step.systems.some((s) => s.scalesWithLandscape);
      const extraSystems = Math.max(0, Math.min(inputs.numSystems, 12) - it.systemsTouchedBase);
      const landscapeFactor = scales ? 1 + fanout * extraSystems : 1;
      const isActStep = step.stage === "act";

      for (const c of step.costs) {
        let unit = c.unitCostUsd;
        let alreadyScaled = false;
        if (isActStep && c.label.toLowerCase().includes("mcp")) {
          // automatedUnits already carry fan-out weighting — do not apply
          // step-level landscape factor a second time.
          unit = automatedUnits * mcpCost;
          alreadyScaled = true;
        } else if (c.calls && c.calls.length > 0) {
          // Reprice each call using the precedence chain documented on ROLE_ASSUMPTION_KEY:
          //   token actuals > explicit non-default model > default model + scenario override.
          unit = c.calls.reduce((a, call) => {
            const { price, model, fromTokens } = pricePerCallWithOverlay(
              call.role,
              inputs.modelSelection,
              ctx?.tokenActuals,
            );
            let callPrice = price;
            if (!fromTokens && model.isDefault) {
              const assumptionKey = ROLE_ASSUMPTION_KEY[call.role];
              if (assumptionKey !== undefined) {
                callPrice = eff(assumptionKey, ov);
              }
            }
            return a + call.count * callPrice;
          }, 0);
        } else if (c.type === "ai-consumption") {
          // Baked-in AI cost without explicit call list: scale by model override ratio.
          unit = c.unitCostUsd * modelRatio;
        } else if (c.type === "infra") {
          unit = c.unitCostUsd * infraRatio;
        }
        const scaled = unit * (!alreadyScaled && scales ? landscapeFactor : 1);
        if (c.type === "ai-consumption") ai += scaled;
        else if (c.type === "infra") infra += scaled;
        else if (c.type === "other") other += scaled;
      }
      for (const b of step.benefits) {
        if (b.dollarized) stepBenefit += b.unitBenefitUsd;
      }
    }
  }

  // Client-specific error-reduction benefit (applies per automated contained txn)
  const rework = (inputs.reworkRatePct ?? 0) / 100;
  if (rework > 0) {
    const errShare = assumptionMap["error-reduction-share"]!.value;
    stepBenefit += rework * errShare * (it.asIsHandlingMin / 60) * inputs.hrHourlyCostUsd;
  }

  return { ai, infra, other, stepBenefit };
}

interface YearSlice {
  year: 1 | 2 | 3;
  adoptionFraction: number;
  benefitUsd: number;
  totalCostUsd: number;
  netUsd: number;
  humanHoursSaved: number;
  fteEquivalent: number;
}
/**
 * Resolve the effective containment rate for an intent.
 * Hierarchy: per-intent overlay measured > per-FC overlay measured
 *            > scenario containmentRates/containmentOverrides > assumption default.
 */
export function containmentRateFor(
  it: Intent,
  inputs: ScenarioInputs,
  overlay?: ActualsOverlay,
): number {
  // 1. Per-intent measured containment (most specific)
  const intentActuals = overlay?.intents?.find((i) => i.intentKey === it.key);
  if (intentActuals?.measuredContainmentRate !== undefined) {
    return intentActuals.measuredContainmentRate;
  }
  // 2. Per-flow-class measured containment
  const fcMeasured = overlay?.measuredContainmentByFlowClass?.[it.flowClass];
  if (fcMeasured !== undefined) return fcMeasured;
  // 3. Scenario override + assumption default (containmentRates > containmentOverrides > register)
  return getContainmentRate(it.flowClass, inputs);
}

/** Maps the four containment assumption keys to flow-class keys. */
const CONTAINMENT_FC_MAP: Record<string, string> = {
  "containment-fc1": "fc1-deterministic",
  "containment-fc2": "fc2-policy",
  "containment-fc3": "fc3-multiagent",
  "containment-fc4": "fc4-frontier",
};
interface ConfidenceFactor {
  key: string;
  label: string;
  /** True when fraction > 0 (any data supplied for this parameter). */
  provided: boolean;
  /** 0–1: partial-data factors score weight × fraction rather than binary. */
  fraction: number;
  weight: number;
  note: string;
  sourceTier?: "client-confirmed" | "measured";
}

/**
 * Confidence reflects how much of the business case rests on client-specific
 * data vs generic defaults. Per-FC parameters (containment, HITL sampling) score
 * proportionally — supplying 2 of 4 flow classes earns half the weight.
 * Measured overlay values (measuredFactorKeys) push scores beyond the 100-point
 * client-confirmed ceiling and unlock the "calibrated" confidence level.
 */
export function computeConfidence(
  inputs: ScenarioInputs,
  measuredFactorKeys?: Set<string>,
): {
  score: number;
  level: string;
  factors: ConfidenceFactor[];
} {
  const hasAdoption = inputs.adoptionRamp !== undefined || inputs.adoptionRate !== undefined;

  // Per-FC containment: count supplied FCs across both precision field and legacy overrides.
  const suppliedContainmentFCs =
    Object.values(inputs.containmentRates ?? {}).filter((v) => v !== undefined).length +
    Object.keys(inputs.containmentOverrides ?? {}).filter(
      (k) => !(inputs.containmentRates && inputs.containmentRates[k] !== undefined),
    ).length;
  const containmentFraction = Math.min(suppliedContainmentFCs, 4) / 4;

  // Per-FC HITL sampling: scalar covers all 4; per-FC dict scores partially.
  const suppliedSamplingFCs =
    inputs.hitlSamplingRate !== undefined
      ? 4
      : Object.values(inputs.hitlSamplingRates ?? {}).filter((v) => v !== undefined).length;
  const samplingFraction = Math.min(suppliedSamplingFCs, 4) / 4;

  const factors: ConfidenceFactor[] = [
    {
      key: "adoptionRate",
      label: "Adoption rate",
      provided: hasAdoption,
      fraction: hasAdoption ? 1 : 0,
      weight: 12,
      note: "Defaulted to ramp starting at 40%. Year-1 adoption is typically 40–70%, so benefits may be overstated until a ramp is agreed.",
    },
    {
      key: "containmentRates",
      label: "Containment rates",
      provided: containmentFraction > 0,
      fraction: containmentFraction,
      weight: 15,
      note: "Using generic per-flow-class deflection benchmarks (95/88/80/70%). Client-specific pilot or vendor data would materially firm up both cost and benefit.",
    },
    {
      key: "hitlSamplingRate",
      label: "HITL sampling rate",
      provided: samplingFraction > 0,
      fraction: samplingFraction,
      weight: 8,
      note: "Using defaults (5/15/30/60% per flow class). Agreed sampling policies usually cut review cost as trust matures.",
    },
    {
      key: "landscapeMaturity",
      label: "Landscape maturity",
      provided: inputs.landscapeMaturity !== undefined,
      fraction: inputs.landscapeMaturity !== undefined ? 1 : 0,
      weight: 10,
      note: "Assumed a mixed landscape. Legacy systems add ~40% integration effort; clean API-first landscapes save ~20%. Confirm during discovery.",
    },
    {
      key: "contractYears",
      label: "Contract length",
      provided: inputs.contractYears !== undefined,
      fraction: inputs.contractYears !== undefined ? 1 : 0,
      weight: 5,
      note: "Onboarding amortized over an assumed 3-year term. Shorter contracts raise the annual build cost.",
    },
    {
      key: "reworkRatePct",
      label: "As-is rework rate",
      provided: inputs.reworkRatePct !== undefined,
      fraction: inputs.reworkRatePct !== undefined ? 1 : 0,
      weight: 10,
      note: "No client rework baseline provided, so the error-reduction benefit is excluded entirely — the business case is conservative on this axis.",
    },
    {
      key: "peakLoadFactor",
      label: "Peak/seasonality factor",
      provided: inputs.peakLoadFactor !== undefined,
      fraction: inputs.peakLoadFactor !== undefined ? 1 : 0,
      weight: 5,
      note: "No seasonality premium applied. If the client overstaffs for open enrollment or year-end payroll peaks, the benefit is understated.",
    },
  ];

  const BASE = 35; // core inputs always present; max client-confirmed = BASE + 65 = 100
  let score = BASE;

  for (const f of factors) {
    const isMeasured = measuredFactorKeys?.has(f.key) ?? false;
    if (isMeasured) {
      // Measured data from overlay: treat as fully covered (fraction=1) plus bonus.
      f.provided = true;
      f.fraction = 1;
      f.sourceTier = "measured";
      score += f.weight + MEASURED_BONUS;
    } else if (f.fraction > 0) {
      f.sourceTier = "client-confirmed";
      score += f.weight * f.fraction;
    }
  }

  score = Math.round(score);
  const level =
    score > 100 ? "calibrated" : score >= 75 ? "high" : score >= 55 ? "medium" : "low";
  return { score, level, factors };
}

/** Context carrying overlay values relevant to a single intent's pricing. */
interface OverlayContext {
  /** Replaces it.toBeHumanMin when supplied from overlay. */
  effectiveHumanMin?: number;
  /** Replaces inputs.hitlSamplingRate when supplied from overlay. */
  hitlSamplingRate?: number;
  /** Token counts per role for per-token repricing. */
  tokenActuals?: Record<string, { avgInputTokens: number; avgOutputTokens: number }>;
}
export function computeRollup(
  inputs: ScenarioInputs,
  flowOverrides?: Record<string, FlowOverrideValues>,
  overlay?: ActualsOverlay,
  extraIntents: Intent[] = [],
) {
  const ov = inputs.assumptionOverrides;
  const allIntents = [...referenceIntents, ...extraIntents];
  const shares = computeShares(inputs, extraIntents);
  const tier = tierMultiplierFor(inputs.isolationTier, ov);
  const company = companyMultiplierFor(inputs.companyType, ov);
  const costMult = tier.mult * company.mult;
  const ramp = getAdoptionRamp(inputs);
  const maturity = maturityAssumptionFor(inputs.landscapeMaturity);
  const contractYears = inputs.contractYears ?? 3;
  const peakLoadFactor = Math.min(Math.max(inputs.peakLoadFactor ?? 1, 1), 1.5);
  const workingHours = assumptionMap["working-hours-year"]!.value;

  // Localization uplift: each extra country (capped at 20) adds AI/infra run
  // cost to knowledge-grounded (fc2) and frontier (fc4) flows.
  const localization = effectiveAssumption("country-localization", ov);
  const localizationMult =
    1 + localization.value * Math.min(Math.max(0, inputs.countries - 1), 20);
  const LOCALIZED_CLASSES = new Set(["fc2-policy", "fc4-frontier"]);

  // ---------------------------------------------------------------------------
  // Determine which confidence factors are backed by measurements from overlay
  // ---------------------------------------------------------------------------
  const measuredFactorKeys = new Set<string>();
  if (overlay) {
    const hasContainmentMeasurement =
      (overlay.measuredContainmentByFlowClass &&
        Object.keys(overlay.measuredContainmentByFlowClass).length > 0) ||
      overlay.intents?.some((i) => i.measuredContainmentRate !== undefined);
    if (hasContainmentMeasurement) measuredFactorKeys.add("containmentRates");
    if (overlay.measuredHitlSamplingRate !== undefined) measuredFactorKeys.add("hitlSamplingRate");
  }

  // Detect overlay intent keys that have no matching entry in the active registry.
  // The rollup proceeds on the valid remainder; orphans are reported to callers.
  const knownIntentKeys = new Set(allIntents.map((i) => i.key));
  const orphanedIntentKeys: string[] = overlay
    ? (overlay.intents ?? [])
        .map((i) => i.intentKey)
        .filter((k) => !knownIntentKeys.has(k))
    : [];

  // Track which assumption defaults were used (for appliedAssumptions).
  const usedSamplingKeys = new Set<string>();
  let usedRampDefault = false;
  let anyManualActions = false;

  const rows: ReturnType<typeof buildRow>[] = [];
  const byFlowClass = new Map<string, number>();
  const byDomain = new Map<string, number>();
  const byCost = { "ai-consumption": 0, infra: 0, human: 0, build: 0, other: 0 };
  // Txn-weighted amortization factor per flow class (uses adopted volume, not contained).
  const fcAmortFactor = new Map<string, number>();

  // Year accumulators [y1, y2, y3]
  const yearBenefit = [0, 0, 0];
  const yearTotalCost = [0, 0, 0];
  const yearMinutesSaved = [0, 0, 0];

  // Totals = year-1 semantics
  let runCostUsd = 0;
  let buildCostUsd = 0;
  let benefitUsd = 0;
  let humanMinutesSaved = 0;

  function buildRow(
    it: Intent, share: number, txns: number,
    runCost: number, buildCost: number, aiCost: number, infraCost: number,
    humanCost: number, otherCost: number, benefit: number, minutesSaved: number,
    overridden: boolean,
  ) {
    return {
      intentId: it.id,
      intentKey: it.key,
      intentName: it.name,
      domain: it.domain,
      flowClass: it.flowClass,
      share,
      transactions: txns,
      runCostUsd: runCost,
      buildCostUsd: buildCost,
      aiCostUsd: aiCost,
      infraCostUsd: infraCost,
      humanCostUsd: humanCost,
      otherCostUsd: otherCost,
      benefitUsd: benefit,
      netUsd: benefit - runCost - buildCost,
      humanMinutesSaved: minutesSaved,
      overridden,
    };
  }

  for (const baseIntent of allIntents) {
    // Approved SME flow overrides adjust the intent before pricing.
    const ovFl = flowOverrides?.[baseIntent.key];
    const it: Intent = ovFl
      ? {
          ...baseIntent,
          ...(ovFl.flowClass !== undefined && { flowClass: ovFl.flowClass }),
          ...(ovFl.toBeHumanMin !== undefined && { toBeHumanMin: ovFl.toBeHumanMin }),
          ...(ovFl.actGetActions !== undefined && { actGetActions: ovFl.actGetActions }),
          ...(ovFl.actPutActions !== undefined && { actPutActions: ovFl.actPutActions }),
        }
      : baseIntent;

    const share = shares.get(it.key) ?? 0;
    const txns = share * inputs.annualTransactions; // total committed volume for this intent

    // Overlay context: per-intent token actuals for model repricing.
    const intentActualsData = overlay?.intents?.find((i) => i.intentKey === it.key);
    const ctx: OverlayContext | undefined = overlay
      ? { tokenActuals: overlay.tokenActualsByRole }
      : undefined;

    const per = perTransaction(it, inputs, ctx);
    const fc = flowClassMap[it.flowClass];

    const localMult = LOCALIZED_CLASSES.has(it.flowClass) ? localizationMult : 1;
    // Containment: overlay hierarchy → scenario override → assumption default.
    const containmentRate = containmentRateFor(it, inputs, overlay);
    // HITL sampling: overlay measured rate beats scenario and per-FC inputs.
    const samplingRate = overlay?.measuredHitlSamplingRate !== undefined
      ? overlay.measuredHitlSamplingRate
      : getHitlSamplingRate(it.flowClass, inputs);

    // Track which assumption defaults were used.
    if (!inputs.hitlSamplingRates || inputs.hitlSamplingRates[it.flowClass] === undefined) {
      if (inputs.hitlSamplingRate === undefined && overlay?.measuredHitlSamplingRate === undefined) {
        const sk = DEFAULT_HITL_SAMPLE[it.flowClass];
        if (sk) usedSamplingKeys.add(sk);
      }
    }
    if (!inputs.adoptionRamp && inputs.adoptionRate === undefined) usedRampDefault = true;

    // Non-integrated systems add manual handling minutes per action.
    const { manualUnits } = manualActionFractions(it, inputs);
    const manualMinutes = manualUnits > 0 ? manualUnits * assumptionMap["manual-action-minutes"]!.value : 0;
    if (manualUnits > 0) anyManualActions = true;

    // Effective residual human minutes per contained transaction.
    // Overlay avgHitlMinutes replaces toBeHumanMin (measured residual replaces estimated residual).
    const baseHumanMin = intentActualsData?.avgHitlMinutes ?? it.toBeHumanMin;
    const effectiveHumanMin = baseHumanMin * samplingRate + manualMinutes;

    // Build cost is amortized per flow class, scaled by landscape maturity.
    const buildPerTxn = fc ? (fc.buildCostUsd * maturity.value) / fc.amortizationTransactions : 0;
    if (fc) {
      // fcAmortFactor uses adopted (y1) volume so buildBreakdown.annualUsd reconciles with totals.buildCostUsd.
      fcAmortFactor.set(
        it.flowClass,
        (fcAmortFactor.get(it.flowClass) ?? 0) + (txns * ramp[0]!) / fc.amortizationTransactions,
      );
    }

    // Per-year computation for all 3 years
    for (let yi = 0; yi < 3; yi++) {
      const adoptionFraction = ramp[yi]!;
      const adoptedTxns = txns * adoptionFraction;               // all volume entering the agentic channel
      const containedTxns = adoptedTxns * containmentRate;       // flows that completed the automated path
      const fallbackTxns = adoptedTxns * (1 - containmentRate);  // flows that escalated to human

      // AI/infra/other/build charged on full ADOPTED (attempted) volume —
      // failed attempts still ran and cost money before escalating.
      const aiCostY = per.ai * adoptedTxns * costMult * localMult;
      const infraCostY = per.infra * adoptedTxns * costMult * localMult;
      const otherCostY = per.other * adoptedTxns;
      const buildCostY = buildPerTxn * adoptedTxns;
      // Human cost: sampled HITL on contained txns + full as-is on fallback txns.
      const humanCostY =
        containedTxns * (effectiveHumanMin / 60) * inputs.hitlHourlyCostUsd +
        fallbackTxns * (it.asIsHandlingMin / 60) * inputs.hrHourlyCostUsd;
      const runCostY = aiCostY + infraCostY + humanCostY + otherCostY;

      // Benefit on contained transactions only, with peak-load premium.
      const humanBenefitY =
        containedTxns *
        (Math.max(0, it.asIsHandlingMin - effectiveHumanMin) / 60) *
        inputs.hrHourlyCostUsd *
        peakLoadFactor;
      const benefitY = per.stepBenefit * containedTxns + humanBenefitY;
      const minutesSavedY = containedTxns * Math.max(0, it.asIsHandlingMin - effectiveHumanMin);

      yearBenefit[yi]! += benefitY;
      yearTotalCost[yi]! += runCostY + buildCostY;
      yearMinutesSaved[yi]! += minutesSavedY;

      // Totals = year 1 only (yi === 0)
      if (yi === 0) {
        runCostUsd += runCostY;
        buildCostUsd += buildCostY;
        benefitUsd += benefitY;
        humanMinutesSaved += minutesSavedY;

        byCost["ai-consumption"] += aiCostY;
        byCost.infra += infraCostY;
        byCost.human += humanCostY;
        byCost.build += buildCostY;
        byCost.other += otherCostY;
        byFlowClass.set(it.flowClass, (byFlowClass.get(it.flowClass) ?? 0) + runCostY + buildCostY);
        byDomain.set(it.domain, (byDomain.get(it.domain) ?? 0) + runCostY + buildCostY);

        rows.push(buildRow(
          it, share,
          adoptedTxns,
          runCostY, buildCostY, aiCostY, infraCostY, humanCostY, otherCostY,
          benefitY, minutesSavedY, !!ovFl,
        ));
      }
    }
  }

  // Knowledge maintenance: fixed annual editorial cost per country for policy/frontier flows.
  const kmAssumption = assumptionMap["knowledge-maintenance-country"]!;
  const knowledgeMaintenanceUsd = kmAssumption.value * inputs.countries;
  const localizedRows = rows.filter((r) => LOCALIZED_CLASSES.has(r.flowClass));
  const localizedTxns = localizedRows.reduce((a, r) => a + r.transactions, 0);
  for (const r of localizedRows) {
    const alloc = localizedTxns > 0
      ? knowledgeMaintenanceUsd * (r.transactions / localizedTxns)
      : knowledgeMaintenanceUsd / (localizedRows.length || 1);
    r.otherCostUsd += alloc;
    r.runCostUsd += alloc;
    r.netUsd -= alloc;
  }
  runCostUsd += knowledgeMaintenanceUsd;
  byCost.other += knowledgeMaintenanceUsd;
  for (let yi = 0; yi < 3; yi++) yearTotalCost[yi]! += knowledgeMaintenanceUsd;

  // Client onboarding: one-time setup amortized over the contract length,
  // allocated across all rows by transaction volume.
  const onboardingTotal =
    assumptionMap["onboarding-base"]!.value +
    assumptionMap["onboarding-per-system"]!.value * inputs.numSystems +
    assumptionMap["onboarding-per-country"]!.value * inputs.countries;
  const onboardingAnnualUsd = onboardingTotal / Math.max(1, contractYears);
  const allTxns = rows.reduce((a, r) => a + r.transactions, 0);
  for (const r of rows) {
    const alloc = allTxns > 0
      ? onboardingAnnualUsd * (r.transactions / allTxns)
      : onboardingAnnualUsd / rows.length;
    r.buildCostUsd += alloc;
    r.netUsd -= alloc;
  }
  buildCostUsd += onboardingAnnualUsd;
  byCost.build += onboardingAnnualUsd;
  // Onboarding is a one-time cost — only charge in years that fall within the contract term.
  for (let yi = 0; yi < 3; yi++) {
    if (yi < contractYears) yearTotalCost[yi]! += onboardingAnnualUsd;
  }

  // Rebuild flow-class and domain buckets from final rows (after fixed-cost allocations).
  byFlowClass.clear();
  byDomain.clear();
  for (const r of rows) {
    byFlowClass.set(r.flowClass, (byFlowClass.get(r.flowClass) ?? 0) + r.runCostUsd + r.buildCostUsd);
    byDomain.set(r.domain, (byDomain.get(r.domain) ?? 0) + r.runCostUsd + r.buildCostUsd);
  }

  rows.sort((a, b) => b.transactions - a.transactions);

  const totalCostUsd = runCostUsd + buildCostUsd;
  const humanHoursSaved = humanMinutesSaved / 60;
  const txnTotal = inputs.annualTransactions || 1;

  const byYear: YearSlice[] = ([1, 2, 3] as const).map((year, yi) => ({
    year,
    adoptionFraction: ramp[yi]!,
    benefitUsd: yearBenefit[yi]!,
    totalCostUsd: yearTotalCost[yi]!,
    netUsd: yearBenefit[yi]! - yearTotalCost[yi]!,
    humanHoursSaved: yearMinutesSaved[yi]! / 60,
    fteEquivalent: yearMinutesSaved[yi]! / 60 / workingHours,
  }));

  // Component-level build breakdown: platform components decompose each flow-class
  // build cost; onboarding split by its three drivers. Annual amounts sum exactly
  // to totals.buildCostUsd.
  const buildBreakdown = [
    ...buildComponents.map((c) => {
      const oneTime =
        maturity.value *
        Object.values(c.perFlowClassUsd).reduce((a, v) => a + v, 0);
      let annual = 0;
      for (const [fcKey, factor] of fcAmortFactor) {
        annual += (c.perFlowClassUsd[fcKey] ?? 0) * maturity.value * factor;
      }
      return {
        key: c.key,
        name: c.name,
        description: c.description,
        kind: "platform" as const,
        provisioning: "core" as const,
        oneTimeUsd: oneTime,
        annualUsd: annual,
      };
    }),
    ...[
      { a: assumptionMap["onboarding-base"]!,       total: assumptionMap["onboarding-base"]!.value },
      { a: assumptionMap["onboarding-per-system"]!,  total: assumptionMap["onboarding-per-system"]!.value * inputs.numSystems },
      { a: assumptionMap["onboarding-per-country"]!, total: assumptionMap["onboarding-per-country"]!.value * inputs.countries },
    ].map(({ a, total }) => ({
      key: a.key,
      name: a.label,
      description: a.rationale,
      kind: "onboarding" as const,
      provisioning: "custom" as const,
      oneTimeUsd: total,
      annualUsd: total / Math.max(1, contractYears),
    })),
  ];

  const appliedAssumptions: GlobalAssumption[] = [
    effectiveAssumption("slm-call-cost", ov),
    effectiveAssumption("llm-call-cost", ov),
    effectiveAssumption("frontier-call-cost", ov),
    effectiveAssumption("mcp-action-cost", ov),
    effectiveAssumption("infra-per-txn", ov),
    effectiveAssumption("landscape-fanout", ov),
    ...(inputs.countries > 1 ? [localization] : []),
    tier.assumption,
    ...(company.assumption ? [company.assumption] : []),
    assumptionMap["working-hours-year"]!,
    maturity,
    kmAssumption,
    assumptionMap["onboarding-base"]!,
    assumptionMap["onboarding-per-system"]!,
    assumptionMap["onboarding-per-country"]!,
    // Containment assumptions: always include all 4 FCs, reflecting tuning or overlay measurement.
    // computeVariance compares measured against the effective estimate (tuned or default), not raw default.
    ...["containment-fc1", "containment-fc2", "containment-fc3", "containment-fc4"].map(
      (key): GlobalAssumption => {
        const a = assumptionMap[key]!;
        const fcKey = CONTAINMENT_FC_MAP[key];
        // Effective estimate: containmentRates > containmentOverrides > register default.
        const scenarioTuned = fcKey
          ? (inputs.containmentRates?.[fcKey] ?? inputs.containmentOverrides?.[fcKey])
          : undefined;
        const effectiveEstimate = scenarioTuned ?? a.value;
        // Overlay measured value for this FC.
        const measuredRate = fcKey ? overlay?.measuredContainmentByFlowClass?.[fcKey] : undefined;
        if (measuredRate !== undefined) {
          return {
            ...a,
            value: effectiveEstimate,
            measuredValue: measuredRate,
            source: { name: "Measured actuals", confidence: "measured" },
          };
        }
        if (scenarioTuned !== undefined) {
          return {
            ...a,
            value: scenarioTuned,
            source: { name: "Scenario inputs", confidence: "high" },
          };
        }
        return a;
      },
    ),
    ...[...usedSamplingKeys].map((k) => assumptionMap[k]!),
    ...(usedRampDefault ? [assumptionMap["ramp-y1"]!, assumptionMap["ramp-y2"]!, assumptionMap["ramp-y3"]!] : []),
    ...((inputs.reworkRatePct ?? 0) > 0 ? [assumptionMap["error-reduction-share"]!] : []),
    ...(anyManualActions ? [assumptionMap["manual-action-minutes"]!] : []),
    // The effective model per role — tagged measured when overlay supplies token actuals.
    ...MODEL_ROLES.map((role): GlobalAssumption => {
      const { price: effectivePrice, model, fromTokens } = pricePerCallWithOverlay(
        role,
        inputs.modelSelection,
        overlay?.tokenActualsByRole,
      );
      const tokenData = overlay?.tokenActualsByRole?.[role];
      return {
        key: `model-${role}`,
        label: `${role[0]!.toUpperCase()}${role.slice(1)} model: ${model.label}`,
        provisioning: "configurable" as const,
        value: model.pricePerCallUsd,
        unit: "USD per call",
        rationale: fromTokens
          ? `Repriced from measured tokens: avg ${tokenData!.avgInputTokens} input + ${tokenData!.avgOutputTokens} output tokens × catalog per-token rates.`
          : model.description,
        source: {
          name: fromTokens
            ? "Measured actuals"
            : inputs.modelSelection?.[role]
              ? "Scenario model selection"
              : "Default model stack",
          confidence: fromTokens ? "measured" : inputs.modelSelection?.[role] ? "high" : "medium",
        },
        ...(fromTokens ? { measuredValue: effectivePrice } : {}),
      };
    }),
    // HITL sampling — tagged measured when overlay supplies it.
    ...(overlay?.measuredHitlSamplingRate !== undefined
      ? [
          {
            key: "hitl-sampling-rate",
            label: "HITL sampling rate (measured)",
            provisioning: "configurable" as const,
            value: inputs.hitlSamplingRate ?? 1,
            measuredValue: overlay.measuredHitlSamplingRate,
            unit: "fraction",
            rationale:
              "Measured fraction of residual HITL checkpoints actually reviewed in production.",
            source: { name: "Measured actuals", confidence: "measured" as const },
          },
        ]
      : []),
  ];

  // Core vs custom demarcation split — a quotable commercial summary:
  // "$X/year core platform (amortized), $Y one-time custom implementation".
  // Derived from buildBreakdown so the numbers reconcile with totals.buildCostUsd,
  // plus the configurable dials actually applied to this scenario.
  const sumBy = (
    prov: "core" | "custom",
    field: "oneTimeUsd" | "annualUsd",
  ) => buildBreakdown.filter((c) => c.provisioning === prov).reduce((a, c) => a + c[field], 0);
  const demarcationSplit = {
    coreOneTimeUsd: sumBy("core", "oneTimeUsd"),
    coreAnnualUsd: sumBy("core", "annualUsd"),
    customOneTimeUsd: sumBy("custom", "oneTimeUsd"),
    customAnnualUsd: sumBy("custom", "annualUsd"),
    contractYears,
    // Configurable dials applied to this scenario (deduped by key).
    configurableDials: appliedAssumptions.filter(
      (a, i, arr) => a.provisioning === "configurable" && arr.findIndex((b) => b.key === a.key) === i,
    ),
  };

  const fcLabels: Record<string, string> = {
    "fc1-deterministic": "Deterministic Self-Service",
    "fc2-policy":        "Grounded Policy Answer",
    "fc3-multiagent":    "Multi-Agent Transaction",
    "fc4-frontier":      "Frontier Judgment Case",
  };
  const costLabels: Record<string, string> = {
    "ai-consumption": "AI consumption",
    infra:  "Platform infrastructure",
    human:  "Human-in-the-loop",
    build:  "Build (amortized)",
    other:  "Other",
  };

  return {
    totals: {
      runCostUsd,
      buildCostUsd,
      totalCostUsd,
      benefitUsd,
      netUsd: benefitUsd - totalCostUsd,
      roi: totalCostUsd > 0 ? benefitUsd / totalCostUsd : 0,
      costPerTransactionUsd: totalCostUsd / txnTotal,
      benefitPerTransactionUsd: benefitUsd / txnTotal,
      humanHoursSaved,
      fteEquivalent: humanHoursSaved / workingHours,
    },
    byYear,
    rows,
    byFlowClass: [...byFlowClass.entries()].map(([key, usd]) => ({ key, label: fcLabels[key] ?? key, usd })),
    byCostComponent: Object.entries(byCost).map(([key, usd]) => ({ key, label: costLabels[key] ?? key, usd })),
    byDomain: [...byDomain.entries()]
      .map(([key, usd]) => ({ key, label: key, usd }))
      .sort((a, b) => b.usd - a.usd),
    tierMultiplier: tier.mult,
    adoptionRate: ramp[0],
    knowledgeMaintenanceUsd,
    onboardingAnnualUsd,
    buildBreakdown,
    demarcationSplit,
    appliedAssumptions,
    confidence: computeConfidence(inputs, measuredFactorKeys),
    calibrated: !!overlay,
    ...(orphanedIntentKeys.length > 0 ? { orphanedIntentKeys } : {}),
  };
}

const DEFAULT_HITL_SAMPLE: Record<string, string> = {
  "fc1-deterministic": "hitl-sample-fc1",
  "fc2-policy":        "hitl-sample-fc2",
  "fc3-multiagent":    "hitl-sample-fc3",
  "fc4-frontier":      "hitl-sample-fc4",
};
/** Map from assumption keys that are directionally "benefit" drivers. */
const BENEFIT_KEYS = new Set([
  "containment-fc1", "containment-fc2", "containment-fc3", "containment-fc4",
  "hitl-sampling-rate",
]);

/**
 * Effective numeric value of an assumption (shorthand).
 */
function eff(key: string, overrides?: Record<string, number>): number {
  return effectiveAssumption(key, overrides).value;
}

/**
 * Returns the effective GlobalAssumption, substituting the override value if present.
 * The assumption metadata (label, unit, rationale, source) is always from the global default.
 */
function effectiveAssumption(
  key: string,
  overrides?: Record<string, number>,
): GlobalAssumption {
  const base = assumptionMap[key]!;
  if (overrides && overrides[key] !== undefined) {
    return { ...base, value: overrides[key]! };
  }
  return base;
}

/**
 * Per-flow-class primary AI model assumption key.
 * Used to scale baked-in ai-consumption unit costs by the ratio of
 * (effective model cost / default model cost) when overrides are present.
 *
 * For mixed steps (e.g. fc2 knowledge step = LLM + SLM) the primary model
 * dominates cost so ratio-scaling gives a faithful approximation.
 */
const FC_PRIMARY_MODEL: Record<string, string> = {
  "fc1-deterministic": "slm-call-cost",
  "fc2-policy": "llm-call-cost",
  "fc3-multiagent": "llm-call-cost",
  "fc4-frontier": "frontier-call-cost",
};

/**
 * Maps each model role to its scenario-overridable assumption key.
 *
 * Used in perTransaction to honour scenario call-cost overrides (e.g. slm-call-cost)
 * when a step's explicit call list uses the DEFAULT model for that role.
 *
 * Pricing precedence for every call in c.calls:
 *   1. Token actuals (fromTokens=true): exact per-token repricing from measured logs — always wins.
 *   2. Explicitly selected non-default model: catalog price for that model wins.
 *      The user consciously chose a different model; the assumption override does not apply.
 *   3. Default model (no selection, or selection is the default model):
 *      eff(ROLE_ASSUMPTION_KEY[role], ov) — the scenario override for that role is honoured.
 *
 * The data role is intentionally absent: data-call-cost is not in OVERRIDABLE_ASSUMPTION_KEYS
 * so it cannot be overridden per scenario and falls through to the catalog value.
 */
const ROLE_ASSUMPTION_KEY: Partial<Record<string, string>> = {
  router: "slm-call-cost",
  reasoning: "llm-call-cost",
  frontier: "frontier-call-cost",
};

/**
 * HITL sampling rate for a flow class.
 * Precedence: hitlSamplingRates[fc] → hitlSamplingRate (global scalar) → assumption default.
 */
function getHitlSamplingRate(fc: string, inputs: ScenarioInputs): number {
  if (inputs.hitlSamplingRates && inputs.hitlSamplingRates[fc] !== undefined) return inputs.hitlSamplingRates[fc]!;
  if (inputs.hitlSamplingRate !== undefined) return inputs.hitlSamplingRate;
  const key = DEFAULT_HITL_SAMPLE[fc];
  return key ? assumptionMap[key]!.value : 1.0;
}
/**
 * Confidence score:
 *  - BASE = 30 (core inputs always present)
 *  - Each optional factor adds `weight` when client-confirmed (provided)
 *  - When a factor is backed by a measured actuals overlay it adds
 *    `weight + MEASURED_BONUS`, guaranteeing a strictly higher score than
 *    merely providing the same input as a client estimate.
 *  - Score is NOT capped at 100; exceeding 100 signals full calibration.
 *  - Level: > 100 → "calibrated", ≥ 75 → "high", ≥ 55 → "medium", else "low"
 */
const MEASURED_BONUS = 3;

/** Map from assumption keys that are directionally "cost" drivers. */
const COST_KEYS = new Set([
  "model-router", "model-reasoning", "model-frontier", "model-data",
]);

/**
 * Compute per-assumption variance between an estimated rollup (no overlay)
 * and a calibrated rollup (with overlay). Returns one entry per assumption
 * where a measuredValue is present in the calibrated result.
 */
export function computeVariance(
  estimated: ReturnType<typeof computeRollup>,
  actual: ReturnType<typeof computeRollup>,
): VarianceEntry[] {
  const entries: VarianceEntry[] = [];
  const estimatedMap = new Map(estimated.appliedAssumptions.map((a) => [a.key, a]));

  for (const a of actual.appliedAssumptions) {
    if (a.measuredValue === undefined) continue;
    const est = estimatedMap.get(a.key);
    const estimatedValue = est?.value ?? a.value;
    const actualValue = a.measuredValue;
    const absVariance = actualValue - estimatedValue;
    const pctVariance =
      estimatedValue !== 0 ? (absVariance / Math.abs(estimatedValue)) * 100 : 0;

    let direction: VarianceEntry["direction"] = "both";
    if (COST_KEYS.has(a.key)) direction = "cost";
    else if (BENEFIT_KEYS.has(a.key)) direction = "benefit";

    entries.push({
      assumptionKey: a.key,
      label: a.label,
      unit: a.unit,
      estimatedValue,
      actualValue,
      absVariance,
      pctVariance,
      direction,
    });
  }
  return entries;
}

/**
 * Containment rate for a flow class.
 * Precedence: containmentRates[fc] → containmentOverrides[fc] → assumption default.
 */
function getContainmentRate(fc: string, inputs: ScenarioInputs): number {
  if (inputs.containmentRates && inputs.containmentRates[fc] !== undefined) return inputs.containmentRates[fc]!;
  if (inputs.containmentOverrides && inputs.containmentOverrides[fc] !== undefined) return inputs.containmentOverrides[fc]!;
  const key = DEFAULT_CONTAINMENT[fc];
  return key ? assumptionMap[key]!.value : 1.0;
}

export const VALID_FLOW_CLASSES = new Set(Object.keys(DEFAULT_CONTAINMENT));

/**
 * Three-year adoption ramp.
 * Precedence: adoptionRamp array → adoptionRate scalar (flat, all 3 years the same) → assumption defaults.
 */
function getAdoptionRamp(inputs: ScenarioInputs): [number, number, number] {
  if (inputs.adoptionRamp) return inputs.adoptionRamp;
  if (inputs.adoptionRate !== undefined) {
    const r = Math.min(Math.max(inputs.adoptionRate, 0), 1);
    return [r, r, r];
  }
  return [
    assumptionMap["ramp-y1"]!.value,
    assumptionMap["ramp-y2"]!.value,
    assumptionMap["ramp-y3"]!.value,
  ];
}
