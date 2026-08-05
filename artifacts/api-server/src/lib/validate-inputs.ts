import { intentMap } from "../data/intents";
import { flowClassMap } from "../data/flow-classes";
import { profileMap } from "../data/profiles";
import { MODEL_ROLES, modelCatalogMap } from "../data/model-catalog";
import { systems } from "../data/systems";
import type { ScenarioInputs } from "./rollup";
import { OVERRIDABLE_ASSUMPTION_KEYS } from "./rollup";
import type { ActualsOverlay } from "../data/types";

export class InputValidationError extends Error {
  status = 400;
}

const COMPANY_TYPES = new Set(["single-country", "multi-country", "global"]);
const TIERS = new Set(["pooled", "siloed", "dedicated"]);

const FLOW_CLASSES = new Set(["fc1-deterministic", "fc2-policy", "fc3-multiagent", "fc4-frontier"]);
function requirePositive(name: string, value: number, max: number) {
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new InputValidationError(
      `${name} must be a positive number no greater than ${max}`,
    );
  }
}

function requirePositiveInt(name: string, value: number, max: number) {
  requirePositive(name, value, max);
  if (!Number.isInteger(value)) {
    throw new InputValidationError(`${name} must be a whole number`);
  }
}

/**
 * Validates scenario inputs beyond structural typing; throws InputValidationError.
 * Pass `extraValidIntentKeys` to allow custom intent keys in intentShareOverrides.
 */
export function validateScenarioInputs(inputs: ScenarioInputs, extraValidIntentKeys?: Set<string>): void {
  requirePositiveInt("numSystems", inputs.numSystems, 100);
  requirePositiveInt("annualTransactions", inputs.annualTransactions, 100_000_000);
  requirePositiveInt("employees", inputs.employees, 10_000_000);
  requirePositive("hrHourlyCostUsd", inputs.hrHourlyCostUsd, 10_000);
  requirePositive("hitlHourlyCostUsd", inputs.hitlHourlyCostUsd, 10_000);
  requirePositiveInt("countries", inputs.countries, 250);

  if (!profileMap[inputs.sector]) {
    throw new InputValidationError(
      `Unknown sector "${inputs.sector}". Valid sectors: ${Object.keys(profileMap).join(", ")}`,
    );
  }
  if (!COMPANY_TYPES.has(inputs.companyType)) {
    throw new InputValidationError(
      `companyType must be one of: single-country, multi-country, global`,
    );
  }
  if (!TIERS.has(inputs.isolationTier)) {
    throw new InputValidationError(
      `isolationTier must be one of: pooled, siloed, dedicated`,
    );
  }

  const overrides = inputs.intentShareOverrides;
  if (overrides) {
    let total = 0;
    for (const [key, share] of Object.entries(overrides)) {
      if (!intentMap[key] && !extraValidIntentKeys?.has(key)) {
        throw new InputValidationError(`Unknown intent key in intentShareOverrides: "${key}"`);
      }
      if (!Number.isFinite(share) || share < 0 || share > 1) {
        throw new InputValidationError(
          `Override share for "${key}" must be between 0 and 1`,
        );
      }
      total += share;
    }
    if (total > 1 + 1e-9) {
      throw new InputValidationError(
        `intentShareOverrides sum to ${total.toFixed(3)}; they must not exceed 1`,
      );
    }
  }

  const assumptionOverrides = inputs.assumptionOverrides;
  if (assumptionOverrides) {
    for (const [key, value] of Object.entries(assumptionOverrides)) {
      if (!OVERRIDABLE_ASSUMPTION_KEYS.has(key)) {
        throw new InputValidationError(
          `"${key}" is not an overridable assumption key. Allowed keys: ${[...OVERRIDABLE_ASSUMPTION_KEYS].join(", ")}`,
        );
      }
      if (!Number.isFinite(value) || value < 0) {
        throw new InputValidationError(
          `assumptionOverrides["${key}"] must be a non-negative finite number`,
        );
      }
    }
  }

  requireFractionIfPresent("adoptionRate", inputs.adoptionRate);
  requireFractionIfPresent("hitlSamplingRate", inputs.hitlSamplingRate);

  const containment = inputs.containmentOverrides;
  if (containment) {
    for (const [key, rate] of Object.entries(containment)) {
      if (!flowClassMap[key]) {
        throw new InputValidationError(
          `Unknown flow class in containmentOverrides: "${key}". Valid keys: ${Object.keys(flowClassMap).join(", ")}`,
        );
      }
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        throw new InputValidationError(
          `Containment rate for "${key}" must be between 0 and 1`,
        );
      }
    }
  }

  if (inputs.landscapeMaturity !== undefined && !MATURITIES.has(inputs.landscapeMaturity)) {
    throw new InputValidationError(
      `landscapeMaturity must be one of: clean, mixed, legacy`,
    );
  }
  if (inputs.contractYears !== undefined) {
    requirePositiveInt("contractYears", inputs.contractYears, 10);
  }
  if (inputs.reworkRatePct !== undefined) {
    if (!Number.isFinite(inputs.reworkRatePct) || inputs.reworkRatePct < 0 || inputs.reworkRatePct > 20) {
      throw new InputValidationError(`reworkRatePct must be between 0 and 20`);
    }
  }
  if (inputs.peakLoadFactor !== undefined) {
    if (!Number.isFinite(inputs.peakLoadFactor) || inputs.peakLoadFactor < 1 || inputs.peakLoadFactor > 1.5) {
      throw new InputValidationError(`peakLoadFactor must be between 1 and 1.5`);
    }
  }

  const selection = inputs.modelSelection;
  if (selection) {
    for (const [role, key] of Object.entries(selection)) {
      if (!(MODEL_ROLES as readonly string[]).includes(role)) {
        throw new InputValidationError(
          `Unknown model role "${role}". Valid roles: ${MODEL_ROLES.join(", ")}`,
        );
      }
      const model = modelCatalogMap[key];
      if (!model || model.role !== role) {
        throw new InputValidationError(
          `Unknown model "${key}" for role "${role}". See /model-catalog for options.`,
        );
      }
    }
  }

  const nonIntegrated = inputs.nonIntegratedSystems;
  if (nonIntegrated !== undefined) {
    for (const key of nonIntegrated) {
      if (!systems.some((s) => s.key === key)) {
        throw new InputValidationError(
          `Unknown system "${key}" in nonIntegratedSystems. See /systems for valid keys.`,
        );
      }
    }
  }
}

const MATURITIES = new Set(["clean", "mixed", "legacy"]);

function requireFractionIfPresent(name: string, value: number | undefined) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new InputValidationError(`${name} must be greater than 0 and at most 1`);
  }
}

export interface ActualsValidationResult {
  valid: boolean;
  errors: string[];
  intentRowCount: number;
  measuredFields: string[];
}

/**
 * Validates an actuals overlay payload. Returns a structured result rather than
 * throwing so callers can surface all errors at once. Throws InputValidationError
 * only on fatal structural issues (use validateActualsOverlayOrThrow for that).
 *
 * @param extraValidIntentKeys  Keys of currently-active custom intents. When
 *   supplied, overlay entries referencing those keys are treated as valid even
 *   though they are not in the static reference intentMap. Pass the key-set from
 *   loadActiveCustomIntents() in any route that persists or validates overlays so
 *   that an overlay can legitimately reference a custom intent while it is active.
 */
export function validateActualsOverlay(
  overlay: ActualsOverlay,
  extraValidIntentKeys?: Set<string>,
): ActualsValidationResult {
  const errors: string[] = [];
  const measuredFields = new Set<string>();
  let intentRowCount = 0;

  // Per-intent rows
  if (overlay.intents !== undefined) {
    if (!Array.isArray(overlay.intents)) {
      errors.push("intents must be an array");
    } else {
      for (let idx = 0; idx < overlay.intents.length; idx++) {
        const row = overlay.intents[idx]!;
        if (!row.intentKey || typeof row.intentKey !== "string") {
          errors.push(`intents[${idx}]: intentKey is required and must be a string`);
          continue;
        }
        const knownKey = !!intentMap[row.intentKey] || !!extraValidIntentKeys?.has(row.intentKey);
        if (!knownKey) {
          errors.push(
            `intents[${idx}]: unknown intentKey "${row.intentKey}". Check /intents or /custom-intents for valid keys.`,
          );
          continue; // skip field validation for unknown intent
        }
        intentRowCount++;
        if (row.measuredContainmentRate !== undefined) {
          if (
            !Number.isFinite(row.measuredContainmentRate) ||
            row.measuredContainmentRate < 0 ||
            row.measuredContainmentRate > 1
          ) {
            errors.push(
              `intents[${idx}] (${row.intentKey}): measuredContainmentRate must be between 0 and 1`,
            );
          } else {
            measuredFields.add("containment");
          }
        }
        if (row.avgHitlMinutes !== undefined) {
          if (!Number.isFinite(row.avgHitlMinutes) || row.avgHitlMinutes < 0 || row.avgHitlMinutes > 600) {
            errors.push(
              `intents[${idx}] (${row.intentKey}): avgHitlMinutes must be between 0 and 600`,
            );
          } else {
            measuredFields.add("hitlMinutes");
          }
        }
        if (
          row.measuredContainmentRate === undefined &&
          row.avgHitlMinutes === undefined
        ) {
          errors.push(
            `intents[${idx}] (${row.intentKey}): at least one measurement field required (measuredContainmentRate or avgHitlMinutes)`,
          );
        }
      }
    }
  }

  // Flow-class containment
  if (overlay.measuredContainmentByFlowClass !== undefined) {
    for (const [fcKey, rate] of Object.entries(overlay.measuredContainmentByFlowClass)) {
      if (!FLOW_CLASSES.has(fcKey)) {
        errors.push(
          `measuredContainmentByFlowClass: unknown flow class "${fcKey}". Valid: ${[...FLOW_CLASSES].join(", ")}`,
        );
      } else if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        errors.push(`measuredContainmentByFlowClass["${fcKey}"]: must be between 0 and 1`);
      } else {
        measuredFields.add("containment");
      }
    }
  }

  // HITL sampling rate
  if (overlay.measuredHitlSamplingRate !== undefined) {
    if (
      !Number.isFinite(overlay.measuredHitlSamplingRate) ||
      overlay.measuredHitlSamplingRate <= 0 ||
      overlay.measuredHitlSamplingRate > 1
    ) {
      errors.push("measuredHitlSamplingRate must be greater than 0 and at most 1");
    } else {
      measuredFields.add("hitlSampling");
    }
  }

  // Token actuals per role
  if (overlay.tokenActualsByRole !== undefined) {
    for (const [role, tokens] of Object.entries(overlay.tokenActualsByRole)) {
      if (!(MODEL_ROLES as readonly string[]).includes(role)) {
        errors.push(
          `tokenActualsByRole: unknown role "${role}". Valid: ${MODEL_ROLES.join(", ")}`,
        );
        continue;
      }
      if (!Number.isFinite(tokens.avgInputTokens) || tokens.avgInputTokens < 0) {
        errors.push(`tokenActualsByRole["${role}"].avgInputTokens must be a non-negative number`);
      }
      if (!Number.isFinite(tokens.avgOutputTokens) || tokens.avgOutputTokens < 0) {
        errors.push(`tokenActualsByRole["${role}"].avgOutputTokens must be a non-negative number`);
      }
      if (
        Number.isFinite(tokens.avgInputTokens) &&
        tokens.avgInputTokens >= 0 &&
        Number.isFinite(tokens.avgOutputTokens) &&
        tokens.avgOutputTokens >= 0
      ) {
        measuredFields.add("tokenPricing");
      }
    }
  }

  // Must have at least one measurement
  if (errors.length === 0 && measuredFields.size === 0 && intentRowCount === 0) {
    errors.push("Overlay contains no measurements. Provide at least one measured value.");
  }

  return {
    valid: errors.length === 0,
    errors,
    intentRowCount,
    measuredFields: [...measuredFields],
  };
}

/**
 * Validates overlay and throws InputValidationError with the first error message if invalid.
 * Pass `extraValidIntentKeys` (keys of active custom intents) so overlay entries that
 * reference active custom intents are accepted rather than rejected as unknown.
 */
export function validateActualsOverlayOrThrow(
  overlay: ActualsOverlay,
  extraValidIntentKeys?: Set<string>,
): void {
  const result = validateActualsOverlay(overlay, extraValidIntentKeys);
  if (!result.valid) {
    throw new InputValidationError(result.errors[0]!);
  }
}
