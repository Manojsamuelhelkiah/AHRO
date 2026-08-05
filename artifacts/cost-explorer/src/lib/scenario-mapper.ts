/**
 * Support exports for the scenario mapper ecosystem.
 *
 * This module owns:
 *   - OVERRIDABLE_ASSUMPTION_KEYS / OverridableKey   — the assumption key registry
 *   - buildAssumptionOverrides                       — shared helper used by scenario-form.ts
 *
 * The canonical toApiInputs / fromApiInputs pair and the Zod form schema live in
 * @/lib/scenario-form.  Do NOT add mapper functions here.
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
// Shared helper
// ---------------------------------------------------------------------------

/**
 * Collapse the form's _assumptionOverrides into a ScenarioInputs override
 * record. Empty strings and undefined values are treated as "not set".
 * Returns undefined when no active overrides remain (i.e. all cleared).
 */
export function buildAssumptionOverrides(
  raw: Partial<Record<OverridableKey, number | "">> | undefined,
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

// Silence unused-import warning — ScenarioInputs is imported only for JSDoc
// type references that keep editor tooling accurate without a runtime cost.
type _ScenarioInputsRef = ScenarioInputs;
