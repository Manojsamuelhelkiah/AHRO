import { createHash } from "node:crypto";
import { intents } from "../data/intents";
import { flowClassMap } from "../data/flow-classes";
import { InputValidationError } from "./validate-inputs";
import { ResolveScenarioFlowBasisResponse } from "@workspace/api-zod";
import type { z } from "zod";
type ScenarioFlowBasis = z.infer<typeof ResolveScenarioFlowBasisResponse>;

export const SETUP_DOMAINS: Record<string, string> = {
  Hire: "hire", Pay: "pay", Leave: "leave", Benefits: "benefits", Time: "time",
  Mobility: "mobility", Develop: "develop", Retire: "retire", "Data/Admin": "data-admin", Policy: "policy",
};

type Override = { intentKey: string; version: number; flowClass: string | null;
  toBeHumanMin: number | null; actGetActions: number | null; actPutActions: number | null };

export function resolveSetupFlowBasis(domains: string[], overrides: Override[], definitions = intents): ScenarioFlowBasis {
  const selectedDomains = [...new Set(domains)].sort();
  if (!selectedDomains.length || selectedDomains.some((domain) => !SETUP_DOMAINS[domain])) {
    throw new InputValidationError("Select supported process domains before resolving the base flows.");
  }
  const selected = definitions.filter((intent) => selectedDomains.some((domain) => SETUP_DOMAINS[domain] === intent.domain))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const domain of selectedDomains) {
    if (!selected.some((intent) => intent.domain === SETUP_DOMAINS[domain])) {
      throw new InputValidationError(`Base definitions for ${domain} are unavailable. Restore the product catalog before continuing.`);
    }
  }
  if (selected.some((intent) => !flowClassMap[intent.flowClass] || !Number.isFinite(intent.baseWeight) || intent.baseWeight <= 0)) {
    throw new InputValidationError("The selected base definitions are incomplete. Repair the product catalog before continuing.");
  }
  const active = overrides.filter((override) => selected.some((intent) => intent.key === override.intentKey))
    .sort((a, b) => a.intentKey.localeCompare(b.intentKey) || a.version - b.version)
    .filter((override, index, rows) => rows[index + 1]?.intentKey !== override.intentKey);
  if (active.some((override) => override.flowClass && !flowClassMap[override.flowClass])) {
    throw new InputValidationError("A selected approved override references an unavailable flow class. Review the override before continuing.");
  }
  const total = selected.reduce((sum, intent) => sum + intent.baseWeight, 0);
  let assigned = 0;
  const intentWeights = Object.fromEntries(selected.map((intent, index) => {
    const weight = index === selected.length - 1 ? 1 - assigned : intent.baseWeight / total;
    assigned += weight;
    return [intent.key, weight];
  }));
  return {
    source: active.length ? "product-base-with-overrides" : "product-base",
    selectedDomains,
    intentWeights,
    overrideRefs: active.map((override) => `${override.intentKey}:v${override.version}`),
    fingerprint: createHash("sha256").update(JSON.stringify({
      selected, active, classes: Object.values(flowClassMap),
    })).digest("hex"),
  };
}

export function validateSetupFlowBasis(saved: ScenarioFlowBasis, current: ScenarioFlowBasis, inputs: { intentShareOverrides?: Record<string, number> }) {
  if (saved.fingerprint !== current.fingerprint || saved.source !== current.source ||
      JSON.stringify([...saved.selectedDomains].sort()) !== JSON.stringify(current.selectedDomains) ||
      JSON.stringify([...saved.overrideRefs].sort()) !== JSON.stringify([...current.overrideRefs].sort())) {
    throw new InputValidationError("The flow basis changed. Resolve and review the current definitions before saving or estimating.");
  }
  const weights = inputs.intentShareOverrides ?? {};
  if (Object.keys(saved.intentWeights).length !== Object.keys(current.intentWeights).length ||
      Object.entries(current.intentWeights).some(([key, value]) => saved.intentWeights[key] !== value) ||
      Object.keys(weights).length !== Object.keys(current.intentWeights).length ||
      Object.entries(current.intentWeights).some(([key, value]) => weights[key] !== value)) {
    throw new InputValidationError("The estimate intent scope does not match the reviewed flow basis.");
  }
}
