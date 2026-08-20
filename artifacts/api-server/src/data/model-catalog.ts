import { assumptionMap } from "./assumptions";
import type { TokenRoleActuals } from "./types";

export interface ModelOption {
  key: string;
  label: string;
  role: string; // router | reasoning | frontier | data
  pricePerCallUsd: number;
  /**
   * Published input (prompt) price per million tokens.
   * Used only when an actuals overlay supplies measured avg token counts
   * for this role; otherwise pricePerCallUsd is used unchanged.
   */
  inputPricePerMillionTokens: number;
  /**
   * Published output (completion) price per million tokens.
   * Same conditions as inputPricePerMillionTokens.
   */
  outputPricePerMillionTokens: number;
  description: string;
  isDefault: boolean;
}

/**
 * Per-call prices are derived from published per-token list prices applied to
 * a typical HRO call profile (router ~1.5k in / 200 out tokens; reasoning
 * ~6k in / 1k out; frontier ~20k in / 4k out with multi-turn planning).
 * The default option in each role matches the registered *-call-cost
 * assumption so scenarios without a model selection are unchanged.
 *
 * Per-token rates (inputPricePerMillionTokens / outputPricePerMillionTokens)
 * are the published list prices used when an actuals overlay supplies measured
 * average token counts, enabling exact repricing from real production logs.
 */
export const modelCatalog: ModelOption[] = [
  // Router / classification (small models)
  {
    key: "gpt-5-mini",
    label: "GPT-5 mini",
    role: "router",
    pricePerCallUsd: assumptionMap["slm-call-cost"]!.value,
    inputPricePerMillionTokens: 0.6,
    outputPricePerMillionTokens: 2.4,
    description: "Default small model for intent routing and classification.",
    isDefault: true,
  },
  {
    key: "gemini-flash",
    label: "Gemini Flash",
    role: "router",
    pricePerCallUsd: 0.001,
    inputPricePerMillionTokens: 0.35,
    outputPricePerMillionTokens: 1.4,
    description: "Lower-cost router option at comparable routing accuracy.",
    isDefault: false,
  },
  {
    key: "phi-onprem",
    label: "Phi (provisioned)",
    role: "router",
    pricePerCallUsd: 0.0008,
    inputPricePerMillionTokens: 0.4,
    outputPricePerMillionTokens: 1.6,
    description: "Provisioned small model on dedicated capacity; cheapest per call at high volume.",
    isDefault: false,
  },
  // Reasoning (grounded answers, agent steps)
  {
    key: "gpt-5",
    label: "GPT-5",
    role: "reasoning",
    pricePerCallUsd: assumptionMap["llm-call-cost"]!.value,
    inputPricePerMillionTokens: 2.5,
    outputPricePerMillionTokens: 10.0,
    description: "Default reasoning model for grounded policy answers and agent steps.",
    isDefault: true,
  },
  {
    key: "claude-sonnet",
    label: "Claude Sonnet",
    role: "reasoning",
    pricePerCallUsd: 0.018,
    inputPricePerMillionTokens: 3.0,
    outputPricePerMillionTokens: 15.0,
    description: "Comparable reasoning quality; slightly lower per-call cost at the HRO token profile.",
    isDefault: false,
  },
  {
    key: "gemini-pro",
    label: "Gemini Pro",
    role: "reasoning",
    pricePerCallUsd: 0.014,
    inputPricePerMillionTokens: 1.25,
    outputPricePerMillionTokens: 5.0,
    description: "Lowest-cost mainstream reasoning option; validate quality on policy-heavy intents.",
    isDefault: false,
  },
  // Frontier (high-judgment cases)
  {
    key: "claude-opus",
    label: "Claude Opus",
    role: "frontier",
    pricePerCallUsd: assumptionMap["frontier-call-cost"]!.value,
    inputPricePerMillionTokens: 15.0,
    outputPricePerMillionTokens: 75.0,
    description: "Default frontier model for cross-border and high-judgment cases.",
    isDefault: true,
  },
  {
    key: "gpt-5-pro",
    label: "GPT-5 Pro",
    role: "frontier",
    pricePerCallUsd: 0.15,
    inputPricePerMillionTokens: 20.0,
    outputPricePerMillionTokens: 80.0,
    description: "Premium frontier option with longer planning chains.",
    isDefault: false,
  },
  {
    key: "o-series",
    label: "o-series reasoning",
    role: "frontier",
    pricePerCallUsd: 0.1,
    inputPricePerMillionTokens: 10.0,
    outputPricePerMillionTokens: 40.0,
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
    inputPricePerMillionTokens: 2.5,
    outputPricePerMillionTokens: 10.0,
    description: "Default structured-data model: NL2SQL with live schema catalog grounding, lineage inference and entity resolution for broken/legacy databases.",
    isDefault: true,
  },
  {
    key: "nl2sql-slm",
    label: "NL2SQL small model",
    role: "data",
    pricePerCallUsd: 0.006,
    inputPricePerMillionTokens: 0.6,
    outputPricePerMillionTokens: 2.4,
    description: "Fine-tuned small model for well-mapped schemas; cheap but needs curated semantic-layer metadata — weak on undocumented legacy estates.",
    isDefault: false,
  },
  {
    key: "frontier-data-agent",
    label: "Frontier data agent",
    role: "data",
    pricePerCallUsd: 0.06,
    inputPricePerMillionTokens: 15.0,
    outputPricePerMillionTokens: 60.0,
    description: "Frontier-class model with exploratory querying and self-correction; strongest on undocumented schemas and missing lineage, at a premium per call.",
    isDefault: false,
  },
];

export const modelCatalogMap: Record<string, ModelOption> = Object.fromEntries(
  modelCatalog.map((m) => [m.key, m]),
);

export const MODEL_ROLES = ["router", "reasoning", "frontier", "data"] as const;

/**
 * Architecture planning profiles used to expose estimated token consumption
 * before production telemetry exists. Calibration overlays replace these
 * role-level averages with measured input/output token counts.
 */
export const ESTIMATED_TOKEN_PROFILE_BY_ROLE: Record<
  (typeof MODEL_ROLES)[number],
  { avgInputTokens: number; avgOutputTokens: number }
> = {
  router: { avgInputTokens: 1_500, avgOutputTokens: 200 },
  reasoning: { avgInputTokens: 6_000, avgOutputTokens: 1_000 },
  frontier: { avgInputTokens: 20_000, avgOutputTokens: 4_000 },
  data: { avgInputTokens: 6_000, avgOutputTokens: 1_000 },
};

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

/**
 * Resolves the per-call price for a role, repricing from measured token counts
 * when the actuals overlay provides them. Falls back to pricePerCall behaviour
 * (no overlay, or no token data for this role) so existing logic is unchanged.
 *
 * Returns { price, model, fromTokens } where fromTokens indicates whether the
 * per-token path was used (for appliedAssumptions tagging).
 */
export function pricePerCallWithOverlay(
  role: string,
  selection: Record<string, string> | undefined,
  tokenActuals: Record<string, TokenRoleActuals> | undefined,
): { price: number; model: ModelOption; fromTokens: boolean } {
  const { model } = pricePerCall(role, selection);
  const tokens = tokenActuals?.[role];
  if (
    !tokens ||
    !Number.isFinite(tokens.avgInputTokens) ||
    !Number.isFinite(tokens.avgOutputTokens) ||
    tokens.avgInputTokens < 0 ||
    tokens.avgOutputTokens < 0
  ) {
    return { price: model.pricePerCallUsd, model, fromTokens: false };
  }
  const tokenPrice =
    (tokens.avgInputTokens * model.inputPricePerMillionTokens +
      tokens.avgOutputTokens * model.outputPricePerMillionTokens) /
    1_000_000;
  return { price: tokenPrice, model, fromTokens: true };
}
