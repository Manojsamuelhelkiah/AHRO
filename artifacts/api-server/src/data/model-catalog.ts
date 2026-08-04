import { assumptionMap } from "./assumptions";

export interface ModelOption {
  key: string;
  label: string;
  role: string; // router | reasoning | frontier | data
  pricePerCallUsd: number;
  description: string;
  isDefault: boolean;
}

/**
 * Per-call prices are derived from published per-token list prices applied to
 * a typical HRO call profile (router ~1.5k in / 200 out tokens; reasoning
 * ~6k in / 1k out; frontier ~20k in / 4k out with multi-turn planning).
 * The default option in each role matches the registered *-call-cost
 * assumption so scenarios without a model selection are unchanged.
 */
export const modelCatalog: ModelOption[] = [
  // Router / classification (small models)
  {
    key: "gpt-5-mini",
    label: "GPT-5 mini",
    role: "router",
    pricePerCallUsd: assumptionMap["slm-call-cost"]!.value,
    description: "Default small model for intent routing and classification.",
    isDefault: true,
  },
  {
    key: "gemini-flash",
    label: "Gemini Flash",
    role: "router",
    pricePerCallUsd: 0.001,
    description: "Lower-cost router option at comparable routing accuracy.",
    isDefault: false,
  },
  {
    key: "phi-onprem",
    label: "Phi (provisioned)",
    role: "router",
    pricePerCallUsd: 0.0008,
    description: "Provisioned small model on dedicated capacity; cheapest per call at high volume.",
    isDefault: false,
  },
  // Reasoning (grounded answers, agent steps)
  {
    key: "gpt-5",
    label: "GPT-5",
    role: "reasoning",
    pricePerCallUsd: assumptionMap["llm-call-cost"]!.value,
    description: "Default reasoning model for grounded policy answers and agent steps.",
    isDefault: true,
  },
  {
    key: "claude-sonnet",
    label: "Claude Sonnet",
    role: "reasoning",
    pricePerCallUsd: 0.018,
    description: "Comparable reasoning quality; slightly lower per-call cost at the HRO token profile.",
    isDefault: false,
  },
  {
    key: "gemini-pro",
    label: "Gemini Pro",
    role: "reasoning",
    pricePerCallUsd: 0.014,
    description: "Lowest-cost mainstream reasoning option; validate quality on policy-heavy intents.",
    isDefault: false,
  },
  // Frontier (high-judgment cases)
  {
    key: "claude-opus",
    label: "Claude Opus",
    role: "frontier",
    pricePerCallUsd: assumptionMap["frontier-call-cost"]!.value,
    description: "Default frontier model for cross-border and high-judgment cases.",
    isDefault: true,
  },
  {
    key: "gpt-5-pro",
    label: "GPT-5 Pro",
    role: "frontier",
    pricePerCallUsd: 0.15,
    description: "Premium frontier option with longer planning chains.",
    isDefault: false,
  },
  {
    key: "o-series",
    label: "o-series reasoning",
    role: "frontier",
    pricePerCallUsd: 0.1,
    description: "Cheaper frontier-class option; test on complex multi-thread cases first.",
    isDefault: false,
  },
  // Data access (structured data: NL2SQL, schema mapping, entity resolution
  // across legacy databases with poor lineage)
  {
    key: "ldm-schema-grounded",
    label: "LDM (schema-grounded)",
    role: "data",
    pricePerCallUsd: assumptionMap["data-call-cost"]!.value,
    description: "Default structured-data model: NL2SQL with live schema catalog grounding, lineage inference and entity resolution for broken/legacy databases.",
    isDefault: true,
  },
  {
    key: "nl2sql-slm",
    label: "NL2SQL small model",
    role: "data",
    pricePerCallUsd: 0.006,
    description: "Fine-tuned small model for well-mapped schemas; cheap but needs curated semantic-layer metadata — weak on undocumented legacy estates.",
    isDefault: false,
  },
  {
    key: "frontier-data-agent",
    label: "Frontier data agent",
    role: "data",
    pricePerCallUsd: 0.06,
    description: "Frontier-class model with exploratory querying and self-correction; strongest on undocumented schemas and missing lineage, at a premium per call.",
    isDefault: false,
  },
];

export const modelCatalogMap: Record<string, ModelOption> = Object.fromEntries(
  modelCatalog.map((m) => [m.key, m]),
);

export const MODEL_ROLES = ["router", "reasoning", "frontier", "data"] as const;

/** Resolves the per-call price for a role given an optional scenario selection. */
export function pricePerCall(
  role: string,
  selection: Record<string, string> | undefined,
): { price: number; model: ModelOption } {
  const selectedKey = selection?.[role];
  const model = selectedKey
    ? modelCatalogMap[selectedKey]!
    : modelCatalog.find((m) => m.role === role && m.isDefault)!;
  return { price: model.pricePerCallUsd, model };
}
