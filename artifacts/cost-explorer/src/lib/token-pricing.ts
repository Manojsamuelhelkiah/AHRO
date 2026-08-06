/**
 * Types and pure functions for repricing overlay token actuals into USD/call.
 *
 * The RolePricingMap used at runtime is derived from the live /model-catalog API
 * (GET /api/model-catalog → default ModelOption per role) rather than from any
 * static constant here. See calibration.tsx for the derivation.
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
