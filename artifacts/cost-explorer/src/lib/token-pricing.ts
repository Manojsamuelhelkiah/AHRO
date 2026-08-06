/**
 * Per-role pricing constants used to reprice overlay token actuals into USD/call.
 *
 * Source of truth: artifacts/api-server/src/data/model-catalog.ts
 * These values mirror the default model in each role. If a default model or its
 * published rates change in model-catalog.ts, update the entries below to match.
 *
 * Formula (from pricePerCallWithOverlay in model-catalog.ts):
 *   tokenPrice = (avgInputTokens × inputPricePerMillionTokens
 *               + avgOutputTokens × outputPricePerMillionTokens) / 1_000_000
 */

/** Per-role pricing data needed to convert token actuals to USD/call. */
export interface RolePricingEntry {
  /** Published input-token rate (USD per million tokens) for the default model. */
  inputPricePerMillionTokens: number;
  /** Published output-token rate (USD per million tokens) for the default model. */
  outputPricePerMillionTokens: number;
  /**
   * Baked per-call price for the default model (USD).
   * Used as the drift estimate baseline — i.e. what the model was assumed to
   * cost before measured token counts were available.
   * Mirrors model.pricePerCallUsd / assumptionMap["*-call-cost"].value.
   */
  defaultPricePerCallUsd: number;
  /** Human-readable label for the default model in this role. */
  label: string;
}

export type RolePricingMap = Record<string, RolePricingEntry>;

/**
 * Default model pricing per role.
 *
 * router    → GPT-5 mini    (slm-call-cost assumption)
 * reasoning → GPT-5         (llm-call-cost assumption)
 * frontier  → Claude Opus   (frontier-call-cost assumption)
 * data      → LDM schema-grounded (data-call-cost assumption)
 *
 * Rates: published list prices as recorded in model-catalog.ts at time of writing.
 */
export const DEFAULT_ROLE_PRICING: RolePricingMap = {
  router: {
    label: "Router / Classification (GPT-5 mini)",
    inputPricePerMillionTokens: 0.6,   // model-catalog: gpt-5-mini.inputPricePerMillionTokens
    outputPricePerMillionTokens: 2.4,  // model-catalog: gpt-5-mini.outputPricePerMillionTokens
    defaultPricePerCallUsd: 0.002,     // assumptions: slm-call-cost.value
  },
  reasoning: {
    label: "Reasoning / Grounded Answers (GPT-5)",
    inputPricePerMillionTokens: 2.5,   // model-catalog: gpt-5.inputPricePerMillionTokens
    outputPricePerMillionTokens: 10.0, // model-catalog: gpt-5.outputPricePerMillionTokens
    defaultPricePerCallUsd: 0.02,      // assumptions: llm-call-cost.value
  },
  frontier: {
    label: "Frontier / High-Judgment (Claude Opus)",
    inputPricePerMillionTokens: 15.0,  // model-catalog: claude-opus.inputPricePerMillionTokens
    outputPricePerMillionTokens: 75.0, // model-catalog: claude-opus.outputPricePerMillionTokens
    defaultPricePerCallUsd: 0.12,      // assumptions: frontier-call-cost.value
  },
  data: {
    label: "Data Access / Legacy DB (LDM)",
    inputPricePerMillionTokens: 2.5,   // model-catalog: ldm-schema-grounded.inputPricePerMillionTokens
    outputPricePerMillionTokens: 10.0, // model-catalog: ldm-schema-grounded.outputPricePerMillionTokens
    defaultPricePerCallUsd: 0.02,      // assumptions: data-call-cost.value
  },
};

/**
 * Reprice one role's measured token actuals to USD/call.
 * Mirrors pricePerCallWithOverlay() in artifacts/api-server/src/data/model-catalog.ts.
 *
 * @param actuals  Measured average token counts for this role.
 * @param pricing  Catalog rates for this role's default model.
 * @returns        USD per call, repriced from token actuals × per-token rates.
 */
export function repriceRole(
  actuals: { avgInputTokens: number; avgOutputTokens: number },
  pricing: RolePricingEntry,
): number {
  return (
    (actuals.avgInputTokens * pricing.inputPricePerMillionTokens +
      actuals.avgOutputTokens * pricing.outputPricePerMillionTokens) /
    1_000_000
  );
}

/**
 * Format a USD/call value dynamically:
 * - Always shows the "$" prefix.
 * - Uses enough decimal places to display at least 2 significant figures
 *   for sub-cent values (e.g. $0.0015, $0.12, $0.0001200).
 * - Caps at 6 decimal places to avoid runaway trailing zeros.
 */
export function formatUsdPerCall(value: number): string {
  if (value === 0) return "$0.00";
  const abs = Math.abs(value);
  // How many decimal places needed so we see at least 2 significant digits?
  // e.g. 0.0015 → ceil(-log10(0.0015)) = ceil(2.82) = 3, +1 = 4 → "$0.0015"
  const magDecimals = abs < 1 ? Math.ceil(-Math.log10(abs)) + 1 : 2;
  const decimals = Math.min(Math.max(magDecimals, 2), 6);
  return `$${value.toFixed(decimals)}`;
}
