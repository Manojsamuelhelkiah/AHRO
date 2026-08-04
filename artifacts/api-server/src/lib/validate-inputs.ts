import { intentMap } from "../data/intents";
import { flowClassMap } from "../data/flow-classes";
import { profileMap } from "../data/profiles";
import type { ScenarioInputs } from "./rollup";

export class InputValidationError extends Error {
  status = 400;
}

const COMPANY_TYPES = new Set(["single-country", "multi-country", "global"]);
const TIERS = new Set(["pooled", "siloed", "dedicated"]);

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

/** Validates scenario inputs beyond structural typing; throws InputValidationError. */
export function validateScenarioInputs(inputs: ScenarioInputs): void {
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
      if (!intentMap[key]) {
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
}

const MATURITIES = new Set(["clean", "mixed", "legacy"]);

function requireFractionIfPresent(name: string, value: number | undefined) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new InputValidationError(`${name} must be greater than 0 and at most 1`);
  }
}
