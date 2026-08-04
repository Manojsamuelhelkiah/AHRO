import { intents } from "../data/intents";
import { flowClassMap } from "../data/flow-classes";
import { profileMap, profiles } from "../data/profiles";
import { assumptionMap } from "../data/assumptions";
import type { GlobalAssumption, Intent } from "../data/types";

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
 */
export function computeShares(inputs: ScenarioInputs): Map<string, number> {
  const profile = profileMap[inputs.sector] ?? profiles[0]!;
  const band = sizeBand(inputs.employees);
  const sizeAdj = profile.sizeAdjustments[band] ?? 1;
  const overrides = inputs.intentShareOverrides ?? {};

  const weights = new Map<string, number>();
  for (const it of intents) {
    if (overrides[it.key] !== undefined) continue;
    const dw = profile.domainWeights[it.domain] ?? 1;
    const complexAdj = COMPLEX_CLASSES.has(it.flowClass) ? sizeAdj : 1;
    weights.set(it.key, it.baseWeight * dw * complexAdj);
  }

  const overrideTotal = Object.entries(overrides).reduce(
    (s, [k, v]) => (intents.some((i) => i.key === k) ? s + Math.max(0, v) : s),
    0,
  );
  const remaining = Math.max(0, 1 - Math.min(1, overrideTotal));
  const weightSum = [...weights.values()].reduce((a, b) => a + b, 0) || 1;

  const shares = new Map<string, number>();
  for (const it of intents) {
    const ov = overrides[it.key];
    if (ov !== undefined) shares.set(it.key, Math.max(0, ov));
    else shares.set(it.key, ((weights.get(it.key) ?? 0) / weightSum) * remaining);
  }
  return shares;
}

function tierMultiplierFor(tier: string): { mult: number; assumption: GlobalAssumption } {
  const key = tier === "dedicated" ? "tier-dedicated" : tier === "siloed" ? "tier-siloed" : "tier-pooled";
  const a = assumptionMap[key]!;
  return { mult: a.value, assumption: a };
}

function companyMultiplierFor(companyType: string): { mult: number; assumption?: GlobalAssumption } {
  if (companyType === "multi-country") return { mult: assumptionMap["company-multi-country"]!.value, assumption: assumptionMap["company-multi-country"]! };
  if (companyType === "global") return { mult: assumptionMap["company-global"]!.value, assumption: assumptionMap["company-global"]! };
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
function perTransaction(it: Intent, inputs: ScenarioInputs): PerTxnCost {
  const fc = flowClassMap[it.flowClass];
  const fanout = assumptionMap["landscape-fanout"]!.value;
  const mcpCost = assumptionMap["mcp-action-cost"]!.value;

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
        // MCP action costs are intent-specific: replace the template's nominal
        // action cost with (get+put actions × mcp-action-cost).
        if (isActStep && c.label.toLowerCase().includes("mcp")) {
          unit = (it.actGetActions + it.actPutActions) * mcpCost;
        }
        const scaled = unit * (scales ? landscapeFactor : 1);
        if (c.type === "ai-consumption") ai += scaled;
        else if (c.type === "infra") infra += scaled;
        else if (c.type === "other") other += scaled;
        // c.type === "human" carries no unit cost; residual human minutes are
        // intent-level (toBeHumanMin) and priced below.
      }
      for (const b of step.benefits) {
        if (b.dollarized) benefit += b.unitBenefitUsd;
      }
    }
  }

  const human = (it.toBeHumanMin / 60) * inputs.hitlHourlyCostUsd;
  // Core dollarized benefit: human handling time eliminated.
  benefit += ((it.asIsHandlingMin - it.toBeHumanMin) / 60) * inputs.hrHourlyCostUsd;

  return { ai, infra, human, other, benefit };
}

export function computeRollup(inputs: ScenarioInputs) {
  const shares = computeShares(inputs);
  const tier = tierMultiplierFor(inputs.isolationTier);
  const company = companyMultiplierFor(inputs.companyType);
  const costMult = tier.mult * company.mult;

  // Localization uplift: each extra country (capped at 20) adds AI/infra run
  // cost to knowledge-grounded (fc2) and frontier (fc4) flows.
  const localization = assumptionMap["country-localization"]!;
  const localizationMult =
    1 + localization.value * Math.min(Math.max(0, inputs.countries - 1), 20);
  const LOCALIZED_CLASSES = new Set(["fc2-policy", "fc4-frontier"]);

  const rows = [];
  const byFlowClass = new Map<string, number>();
  const byDomain = new Map<string, number>();
  const byCost = { "ai-consumption": 0, infra: 0, human: 0, build: 0, other: 0 };

  let runCostUsd = 0;
  let buildCostUsd = 0;
  let benefitUsd = 0;
  let humanMinutesSaved = 0;

  for (const it of intents) {
    const share = shares.get(it.key) ?? 0;
    const txns = share * inputs.annualTransactions;
    const per = perTransaction(it, inputs);
    const fc = flowClassMap[it.flowClass];

    const localMult = LOCALIZED_CLASSES.has(it.flowClass) ? localizationMult : 1;
    const aiCost = per.ai * txns * costMult * localMult;
    const infraCost = per.infra * txns * costMult * localMult;
    const humanCost = per.human * txns;
    const otherCost = per.other * txns;
    const runCost = aiCost + infraCost + humanCost + otherCost;
    const buildPerTxn = fc ? fc.buildCostUsd / fc.amortizationTransactions : 0;
    const buildCost = buildPerTxn * txns;
    const benefit = per.benefit * txns;
    const minutesSaved = Math.max(0, it.asIsHandlingMin - it.toBeHumanMin) * txns;

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
    });
  }

  rows.sort((a, b) => b.transactions - a.transactions);

  const totalCostUsd = runCostUsd + buildCostUsd;
  const workingHours = assumptionMap["working-hours-year"]!.value;
  const humanHoursSaved = humanMinutesSaved / 60;
  const txnTotal = inputs.annualTransactions || 1;

  const appliedAssumptions: GlobalAssumption[] = [
    assumptionMap["slm-call-cost"]!,
    assumptionMap["llm-call-cost"]!,
    assumptionMap["frontier-call-cost"]!,
    assumptionMap["mcp-action-cost"]!,
    assumptionMap["infra-per-txn"]!,
    assumptionMap["landscape-fanout"]!,
    ...(inputs.countries > 1 ? [localization] : []),
    tier.assumption,
    ...(company.assumption ? [company.assumption] : []),
    assumptionMap["working-hours-year"]!,
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
    appliedAssumptions,
  };
}
