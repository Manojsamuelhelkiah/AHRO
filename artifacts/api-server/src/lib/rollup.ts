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
  /** Share of committed volume arriving through the agentic channel (0-1, default 1). */

  adoptionRate?: number;
  /** Per-flow-class containment overrides (0-1); defaults from containment-* assumptions. */

  containmentOverrides?: Record<string, number>;
  /** Fraction of default residual HITL minutes actually spent (0-1, default 1). */

  hitlSamplingRate?: number;
  /** clean | mixed | legacy (default mixed). */

  landscapeMaturity?: string;
  /** Contract length in years for onboarding amortization (default 3). */

  contractYears?: number;
  /** As-is rework share of transactions in percent (0-20, default 0). */

  reworkRatePct?: number;
  /** Seasonality premium on avoided human effort (1-1.5, default 1). */

  peakLoadFactor?: number;
  /** Chosen AI models per role (router | reasoning | frontier), keys from the model catalog. */

  modelSelection?: Record<string, string>;
  /** Landscape systems that will NOT be integrated with the MCP layer; their actions stay manual. */

  nonIntegratedSystems?: string[];

  assumptionOverrides?: Record<string, number>;
}

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

interface PerTxnCost {
  ai: number;
  infra: number;
  human: number;
  other: number;
  benefit: number;
}

/** Per-transaction cost/benefit for one intent, before tier/company multipliers on ai+infra. */
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
/** Per-transaction cost/benefit for one intent, before tier/company multipliers on ai+infra. */
function perTransaction(
  it: Intent,
  inputs: ScenarioInputs,
  ctx?: OverlayContext,
): PerTxnCost {
  const ov = inputs.assumptionOverrides;
  const fc = flowClassMap[it.flowClass];
  // Landscape maturity scales Act fan-out effort.
  const maturity = maturityAssumptionFor(inputs.landscapeMaturity);
  // landscape-fanout and mcp-action-cost are override-aware.
  const fanout = eff("landscape-fanout", ov) * maturity.value;
  const mcpCost = eff("mcp-action-cost", ov);
  const { automatedUnits, manualUnits } = manualActionFractions(it, inputs);

  // Overlay-resolved values: overlay beats scenario input beats default.
  const effectiveHumanMin = ctx?.effectiveHumanMin ?? it.toBeHumanMin;
  const sampling = ctx?.hitlSamplingRate ?? inputs.hitlSamplingRate ?? 1;
  const tokenActuals = ctx?.tokenActuals;

  // Compute model-cost scaling ratio for ai-consumption components that lack
  // an explicit c.calls list. flow-classes.ts bakes default assumption values
  // into unitCostUsd; when a scenario overrides a model-cost assumption we
  // scale by (effective / default). For mixed steps the primary model
  // dominates so ratio-scaling is a faithful approximation.
  const primaryModelKey = FC_PRIMARY_MODEL[it.flowClass] ?? "slm-call-cost";
  const defaultModelCost = assumptionMap[primaryModelKey]!.value;
  const modelRatio = defaultModelCost > 0 ? eff(primaryModelKey, ov) / defaultModelCost : 1;

  // Similarly scale infra components.
  const defaultInfra = assumptionMap["infra-per-txn"]!.value;
  const infraRatio = defaultInfra > 0 ? eff("infra-per-txn", ov) / defaultInfra : 1;

  let ai = 0;
  let infra = 0;
  let other = 0;
  let benefit = 0;

  if (fc) {
    for (const step of fc.steps) {
      const scales = step.systems.some((s) => s.scalesWithLandscape);
      // Landscape factor: intents touch at least systemsTouchedBase systems;
      // each extra client system adds `fanout` of the base act effort.
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
          // Explicit call list: reprice from overlay token actuals when available
          // (overlay beats catalog). assumptionOverrides model keys (slm-call-cost
          // etc.) are a separate path for baked-in costs and do not interact here.
          unit = c.calls.reduce(
            (a, call) =>
              a + call.count * pricePerCallWithOverlay(call.role, inputs.modelSelection, tokenActuals).price,
            0,
          );
        } else if (c.type === "ai-consumption") {
          // Baked-in ai cost: scale by (effective / default) for this fc's primary model.
          unit = c.unitCostUsd * modelRatio;
        } else if (c.type === "infra") {
          unit = c.unitCostUsd * infraRatio;
        }
        const scaled = unit * (!alreadyScaled && scales ? landscapeFactor : 1);
        if (c.type === "ai-consumption") ai += scaled;
        else if (c.type === "infra") infra += scaled;
        else if (c.type === "other") other += scaled;
        // c.type === "human" carries no unit cost; residual human minutes are
        // intent-level (effectiveHumanMin) and priced below.
      }
      for (const b of step.benefits) {
        if (b.dollarized) benefit += b.unitBenefitUsd;
      }
    }
  }

  // Actions on non-integrated systems stay manual: each get/put adds handling
  // minutes on EVERY transaction (not thinned by sampling — execution work).
  const manualMinutes =
    manualUnits > 0 ? manualUnits * assumptionMap["manual-action-minutes"]!.value : 0;
  // Residual human review on contained transactions, thinned by HITL sampling rate.
  // Overlay context (measured rate) beats scenario input beats default.
  const human =
    ((effectiveHumanMin / 60) * sampling + manualMinutes / 60) * inputs.hitlHourlyCostUsd;
  // Core dollarized benefit: human handling time eliminated, valued at client HR
  // rate with seasonality premium. Manual minutes for non-integrated systems are NOT eliminated.
  const peak = inputs.peakLoadFactor ?? 1;
  benefit +=
    (Math.max(0, it.asIsHandlingMin - effectiveHumanMin - manualMinutes) / 60) *
    inputs.hrHourlyCostUsd *
    peak;
  // Client-specific error-reduction benefit: a share of as-is rework volume
  // is eliminated by systematic validation.
  const rework = (inputs.reworkRatePct ?? 0) / 100;
  if (rework > 0) {
    const errShare = assumptionMap["error-reduction-share"]!.value;
    benefit += rework * errShare * (it.asIsHandlingMin / 60) * inputs.hrHourlyCostUsd;
  }

  return { ai, infra, human, other, benefit };
}
/**
 * Resolve the effective containment rate for an intent, honouring the overlay
 * hierarchy: per-intent measured > per-flow-class measured > scenario override
 * > assumption default.
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
  // 3. Scenario-level client-confirmed containment override
  const override = inputs.containmentOverrides?.[it.flowClass];
  if (override !== undefined) return override;
  // 4. Default from the assumptions register
  const key = `containment-${it.flowClass.split("-")[0]}`;
  return assumptionMap[key]?.value ?? 1;
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
  provided: boolean;
  weight: number;
  note: string;
  sourceTier?: "client-confirmed" | "measured";
}

export function computeConfidence(
  inputs: ScenarioInputs,
  measuredFactorKeys?: Set<string>,
): {
  score: number;
  level: string;
  factors: ConfidenceFactor[];
} {
  const factors: ConfidenceFactor[] = [
    {
      key: "adoptionRate",
      label: "Adoption rate",
      provided: inputs.adoptionRate !== undefined,
      weight: 12,
      note: "Defaulted to 100% of volume in the agentic channel. Year-1 adoption is typically 40-70%, so benefits are likely overstated until a ramp is agreed.",
    },
    {
      key: "containmentOverrides",
      label: "Containment rates",
      provided:
        !!inputs.containmentOverrides && Object.keys(inputs.containmentOverrides).length > 0,
      weight: 15,
      note: "Using generic per-flow-class deflection benchmarks (95/85/75/60%). Client-specific pilot or vendor data would materially firm up both cost and benefit.",
    },
    {
      key: "hitlSamplingRate",
      label: "HITL sampling rate",
      provided: inputs.hitlSamplingRate !== undefined,
      weight: 8,
      note: "Defaulted to reviewing 100% of residual checkpoints. Agreed sampling policies usually cut review cost as trust matures.",
    },
    {
      key: "landscapeMaturity",
      label: "Landscape maturity",
      provided: inputs.landscapeMaturity !== undefined,
      weight: 10,
      note: "Assumed a mixed landscape. Legacy systems add ~40% integration effort; clean API-first landscapes save ~20%. Confirm during discovery.",
    },
    {
      key: "contractYears",
      label: "Contract length",
      provided: inputs.contractYears !== undefined,
      weight: 5,
      note: "Onboarding amortized over an assumed 3-year term. Shorter contracts raise the annual build cost.",
    },
    {
      key: "reworkRatePct",
      label: "As-is rework rate",
      provided: inputs.reworkRatePct !== undefined,
      weight: 10,
      note: "No client rework baseline provided, so the error-reduction benefit is excluded entirely — the business case is conservative on this axis.",
    },
    {
      key: "peakLoadFactor",
      label: "Peak/seasonality factor",
      provided: inputs.peakLoadFactor !== undefined,
      weight: 5,
      note: "No seasonality premium applied. If the client overstaffs for open enrollment or year-end payroll peaks, the benefit is understated.",
    },
    {
      key: "modelSelection",
      label: "AI model stack",
      provided: !!inputs.modelSelection && Object.keys(inputs.modelSelection).length > 0,
      weight: 5,
      note: "Using default model prices per role. Confirming the actual router/reasoning/frontier models pins AI consumption to real contract rates.",
    },
  ];

  const BASE = 30; // core inputs always present
  let score = BASE;

  for (const f of factors) {
    const isMeasured = measuredFactorKeys?.has(f.key) ?? false;
    if (isMeasured) {
      f.provided = true;
      f.sourceTier = "measured";
      score += f.weight + MEASURED_BONUS;
    } else if (f.provided) {
      f.sourceTier = "client-confirmed";
      score += f.weight;
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
  const adoption = Math.min(Math.max(inputs.adoptionRate ?? 1, 0), 1);
  const maturity = maturityAssumptionFor(inputs.landscapeMaturity);
  const contractYears = inputs.contractYears ?? 3;

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
    if (hasContainmentMeasurement) measuredFactorKeys.add("containmentOverrides");
    if (overlay.measuredHitlSamplingRate !== undefined) measuredFactorKeys.add("hitlSamplingRate");
    if (overlay.tokenActualsByRole && Object.keys(overlay.tokenActualsByRole).length > 0) {
      measuredFactorKeys.add("modelSelection");
    }
  }

  const rows = [];
  const byFlowClass = new Map<string, number>();
  const byDomain = new Map<string, number>();
  const byCost = { "ai-consumption": 0, infra: 0, human: 0, build: 0, other: 0 };

  let runCostUsd = 0;
  let buildCostUsd = 0;
  let benefitUsd = 0;
  let humanMinutesSaved = 0;
  let anyManualActions = false;
  // Txn-weighted amortization factor per flow class, for decomposing platform
  // build cost into architecture components (reconciles exactly with buildCost).
  const fcAmortFactor = new Map<string, number>();

  for (const baseIntent of allIntents) {
    // Approved SME flow overrides adjust the intent before pricing.
    const flowOv = flowOverrides?.[baseIntent.key];
    const it: Intent = flowOv
      ? {
          ...baseIntent,
          ...(flowOv.flowClass !== undefined && { flowClass: flowOv.flowClass }),
          ...(flowOv.toBeHumanMin !== undefined && { toBeHumanMin: flowOv.toBeHumanMin }),
          ...(flowOv.actGetActions !== undefined && { actGetActions: flowOv.actGetActions }),
          ...(flowOv.actPutActions !== undefined && { actPutActions: flowOv.actPutActions }),
        }
      : baseIntent;
    const share = shares.get(it.key) ?? 0;
    // Only adopted volume flows through the agentic channel; the remainder
    // stays in the as-is process (no platform cost, no benefit).
    const txns = share * inputs.annualTransactions * adoption;
    const containment = containmentRateFor(it, inputs, overlay);
    const containedTxns = txns * containment;
    const fallbackTxns = txns - containedTxns;

    // Resolve per-intent overlay context (overlay beats scenario input beats default).
    const intentActualsData = overlay?.intents?.find((i) => i.intentKey === it.key);
    const ctx: OverlayContext | undefined = overlay
      ? {
          effectiveHumanMin: intentActualsData?.avgHitlMinutes,
          hitlSamplingRate: overlay.measuredHitlSamplingRate,
          tokenActuals: overlay.tokenActualsByRole,
        }
      : undefined;
    // Effective HITL minutes (may differ from it.toBeHumanMin when overlay present).
    const effectiveHumanMin = ctx?.effectiveHumanMin ?? it.toBeHumanMin;

    const per = perTransaction(it, inputs, ctx);
    const fc = flowClassMap[it.flowClass];
    if (manualActionFractions(it, inputs).manualUnits > 0) anyManualActions = true;

    const localMult = LOCALIZED_CLASSES.has(it.flowClass) ? localizationMult : 1;
    // AI/infra run cost is incurred on ALL agentic transactions — including
    // uncontained ones (the flow ran before it escalated).
    const aiCost = per.ai * txns * costMult * localMult;
    const infraCost = per.infra * txns * costMult * localMult;
    // Human cost: sampled HITL minutes on contained transactions plus full
    // as-is handling on uncontained fallbacks (at the HITL/service rate).
    const fallbackHumanPerTxn = (it.asIsHandlingMin / 60) * inputs.hitlHourlyCostUsd;
    const humanCost = per.human * containedTxns + fallbackHumanPerTxn * fallbackTxns;
    const otherCost = per.other * txns;
    const runCost = aiCost + infraCost + humanCost + otherCost;
    // Build cost is amortized per flow class, scaled by landscape maturity.
    const buildPerTxn = fc ? (fc.buildCostUsd * maturity.value) / fc.amortizationTransactions : 0;
    const buildCost = buildPerTxn * txns;
    if (fc) {
      fcAmortFactor.set(
        it.flowClass,
        (fcAmortFactor.get(it.flowClass) ?? 0) + txns / fc.amortizationTransactions,
      );
    }
    // Benefits accrue only on contained transactions.
    const benefit = per.benefit * containedTxns;
    const minutesSaved = Math.max(0, it.asIsHandlingMin - effectiveHumanMin) * containedTxns;

    runCostUsd += runCost;
    buildCostUsd += buildCost;
    benefitUsd += benefit;
    humanMinutesSaved += minutesSaved;

    byCost["ai-consumption"] += aiCost;
    byCost.infra += infraCost;
    byCost.human += humanCost;
    byCost.build += buildCost;
    byCost.other += otherCost;
    byFlowClass.set(it.flowClass, (byFlowClass.get(it.flowClass) ?? 0) + runCost + buildCost);
    byDomain.set(it.domain, (byDomain.get(it.domain) ?? 0) + runCost + buildCost);

    rows.push({
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
      overridden: !!flowOv,
    });
  }

  // Knowledge maintenance: fixed annual editorial cost per country for the
  // policy corpora backing fc2/fc4 flows; allocated to fc2/fc4 rows by volume.
  const kmAssumption = assumptionMap["knowledge-maintenance-country"]!;
  const knowledgeMaintenanceUsd = kmAssumption.value * inputs.countries;
  const localizedRows = rows.filter((r) => LOCALIZED_CLASSES.has(r.flowClass));
  const localizedTxns = localizedRows.reduce((a, r) => a + r.transactions, 0);
  for (const r of localizedRows) {
    const alloc =
      localizedTxns > 0
        ? knowledgeMaintenanceUsd * (r.transactions / localizedTxns)
        : knowledgeMaintenanceUsd / (localizedRows.length || 1);
    r.otherCostUsd += alloc;
    r.runCostUsd += alloc;
    r.netUsd -= alloc;
  }
  runCostUsd += knowledgeMaintenanceUsd;
  byCost.other += knowledgeMaintenanceUsd;

  // Client onboarding: one-time setup amortized over the contract length,
  // allocated across all rows by transaction volume.
  const onboardingTotal =
    assumptionMap["onboarding-base"]!.value +
    assumptionMap["onboarding-per-system"]!.value * inputs.numSystems +
    assumptionMap["onboarding-per-country"]!.value * inputs.countries;
  const onboardingAnnualUsd = onboardingTotal / Math.max(1, contractYears);
  const allTxns = rows.reduce((a, r) => a + r.transactions, 0);
  for (const r of rows) {
    const alloc =
      allTxns > 0
        ? onboardingAnnualUsd * (r.transactions / allTxns)
        : onboardingAnnualUsd / rows.length;
    r.buildCostUsd += alloc;
    r.netUsd -= alloc;
  }
  buildCostUsd += onboardingAnnualUsd;
  byCost.build += onboardingAnnualUsd;

  // Component-level build breakdown: platform components decompose each flow
  // class's build cost exactly (same maturity scaling and amortization), and
  // onboarding is split into its three drivers. Annual amounts sum to the
  // roll-up's total build cost.
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
        kind: "platform",
        oneTimeUsd: oneTime,
        annualUsd: annual,
      };
    }),
    ...[
      { a: assumptionMap["onboarding-base"]!, total: assumptionMap["onboarding-base"]!.value },
      { a: assumptionMap["onboarding-per-system"]!, total: assumptionMap["onboarding-per-system"]!.value * inputs.numSystems },
      { a: assumptionMap["onboarding-per-country"]!, total: assumptionMap["onboarding-per-country"]!.value * inputs.countries },
    ].map(({ a, total }) => ({
      key: a.key,
      name: a.label,
      description: a.rationale,
      kind: "onboarding",
      oneTimeUsd: total,
      annualUsd: total / Math.max(1, contractYears),
    })),
  ];

  // Rebuild flow-class and domain buckets from the final rows so they stay
  // reconciled with the fixed-cost allocations above.
  byFlowClass.clear();
  byDomain.clear();
  for (const r of rows) {
    byFlowClass.set(r.flowClass, (byFlowClass.get(r.flowClass) ?? 0) + r.runCostUsd + r.buildCostUsd);
    byDomain.set(r.domain, (byDomain.get(r.domain) ?? 0) + r.runCostUsd + r.buildCostUsd);
  }

  rows.sort((a, b) => b.transactions - a.transactions);

  const totalCostUsd = runCostUsd + buildCostUsd;
  const workingHours = assumptionMap["working-hours-year"]!.value;
  const humanHoursSaved = humanMinutesSaved / 60;
  const txnTotal = inputs.annualTransactions || 1;

  // appliedAssumptions: use effectiveAssumption() for override-aware entries;
  // our containment-tuning fix (variance = measured − tuned_or_default, not
  // measured − raw_default); pricePerCallWithOverlay for model-role entries.
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
    // Containment assumptions — reflect scenario-level tuning in `value` so that
    // computeVariance compares measured against the *effective* estimate (the tuned
    // value the user would otherwise get), not the stale register default.
    ...["containment-fc1", "containment-fc2", "containment-fc3", "containment-fc4"].map(
      (key): GlobalAssumption => {
        const a = assumptionMap[key]!;
        const fcKey = CONTAINMENT_FC_MAP[key];
        // Tuned value: scenario-level containmentOverrides win over the register default.
        const scenarioTuned = fcKey ? inputs.containmentOverrides?.[fcKey] : undefined;
        const effectiveEstimate = scenarioTuned ?? a.value;
        // Measured value: flow-class measured from overlay.
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
    maturity,
    kmAssumption,
    assumptionMap["onboarding-base"]!,
    assumptionMap["onboarding-per-system"]!,
    assumptionMap["onboarding-per-country"]!,
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

  const fcLabels: Record<string, string> = {
    "fc1-deterministic": "Deterministic Self-Service",
    "fc2-policy": "Grounded Policy Answer",
    "fc3-multiagent": "Multi-Agent Transaction",
    "fc4-frontier": "Frontier Judgment Case",
  };
  const costLabels: Record<string, string> = {
    "ai-consumption": "AI consumption",
    infra: "Platform infrastructure",
    human: "Human-in-the-loop",
    build: "Build (amortized)",
    other: "Other",
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
    rows,
    byFlowClass: [...byFlowClass.entries()].map(([key, usd]) => ({ key, label: fcLabels[key] ?? key, usd })),
    byCostComponent: Object.entries(byCost).map(([key, usd]) => ({ key, label: costLabels[key] ?? key, usd })),
    byDomain: [...byDomain.entries()]
      .map(([key, usd]) => ({ key, label: key, usd }))
      .sort((a, b) => b.usd - a.usd),
    tierMultiplier: tier.mult,
    adoptionRate: adoption,
    knowledgeMaintenanceUsd,
    onboardingAnnualUsd,
    buildBreakdown,
    appliedAssumptions,
    confidence: computeConfidence(inputs, measuredFactorKeys),
    calibrated: !!overlay,
  };
}

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
