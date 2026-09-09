/**
 * Pricing Rate Set — definition, validation, baseline seeding, and snapshot loading.
 *
 * A PricingRateSnapshot is a complete, immutable capture of every quote-critical
 * numeric rate used by computeRollup. Every key must be present and finite; any
 * missing or unsafe value blocks quote generation.
 */

import { assumptionMap } from "../data/assumptions";
import { modelCatalog } from "../data/model-catalog";
import { flowClasses } from "../data/flow-classes";

// ─── Canonical rate-key groups ─────────────────────────────────────────────

/**
 * AI call cost keys (global, one per model tier).
 */
export const AI_CALL_COST_KEYS = ["slm-call-cost", "llm-call-cost", "frontier-call-cost", "data-call-cost"] as const;

/**
 * Azure platform unit rate keys.
 */
export const AZURE_UNIT_RATE_KEYS = ["mcp-action-cost", "infra-per-txn"] as const;

/**
 * Model catalog option keys — one per model entry.
 * Each model has: pricePerCallUsd, inputPricePerMillionTokens, outputPricePerMillionTokens.
 */
export const MODEL_CATALOG_KEYS: string[] = modelCatalog.map((m) => m.key);

/**
 * Flow-class build cost keys (four flow classes).
 */
export const FLOW_BUILD_COST_KEYS = [
  "fc1-deterministic",
  "fc2-policy",
  "fc3-multiagent",
  "fc4-frontier",
] as const;

/**
 * Onboarding cost keys.
 */
export const ONBOARDING_KEYS = [
  "onboarding-base",
  "onboarding-per-system",
  "onboarding-per-country",
] as const;

/**
 * Knowledge maintenance key.
 */
export const KNOWLEDGE_MAINTENANCE_KEYS = ["knowledge-maintenance-country"] as const;

/**
 * Commercial support default keys.
 */
export const SUPPORT_DEFAULT_KEYS = [
  "support-team-fte",
  "support-hourly-cost-usd",
  "support-tooling-annual-usd-per-client",
] as const;

// ─── Snapshot shape ────────────────────────────────────────────────────────

/** Per-model rates embedded in the snapshot. */
export interface ModelRates {
  pricePerCallUsd: number;
  inputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
}

/** Per-flow-class build decomposition rates for reconciliation. */
export interface FlowBuildRates {
  /** Total one-time build cost for this flow class. */
  buildCostUsd: number;
  /** Amortization transaction denominator. */
  amortizationTransactions: number;
}

/**
 * Complete pricing rate snapshot. Every field is required.
 * The snapshot drives computeRollup when injected via rateSnapshot argument.
 */
export interface PricingRateSnapshot {
  // Global AI call costs (USD per call, pre-averaged over a typical HRO call profile)
  slmCallCost: number;
  llmCallCost: number;
  frontierCallCost: number;
  dataCallCost: number;

  // Azure MCP and infra unit rates
  mcpActionCost: number;
  infraPerTxn: number;

  // Per-model rates (keyed by model catalog key)
  modelRates: Record<string, ModelRates>;

  // Per-flow-class build costs
  flowBuildRates: Record<string, FlowBuildRates>;

  // Onboarding rates
  onboardingBase: number;
  onboardingPerSystem: number;
  onboardingPerCountry: number;

  // Knowledge maintenance
  knowledgeMaintenancePerCountry: number;

  // Commercial support defaults
  supportTeamFte: number;
  supportHourlyCostUsd: number;
  supportToolingAnnualUsdPerClient: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface RateSetValidationResult {
  valid: boolean;
  errors: string[];
}

const RATE_LIMITS = {
  perCallUsd: 100,
  perTransactionUsd: 100,
  perMillionTokensUsd: 100_000,
  oneTimeOrAnnualUsd: 100_000_000,
  supportFte: 100_000,
  supportHourlyUsd: 100_000,
  amortizationTransactions: 1_000_000_000_000,
} as const;

function validateNumber(
  value: unknown,
  path: string,
  errors: string[],
  options: { max: number; positive?: boolean; integer?: boolean },
): void {
  const minimum = options.positive ? Number.MIN_VALUE : 0;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > options.max ||
    (options.integer === true && !Number.isInteger(value))
  ) {
    const floor = options.positive ? "positive" : "non-negative";
    const whole = options.integer ? " integer" : "";
    errors.push(`${path} must be a finite ${floor}${whole} no greater than ${options.max}`);
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  errors: string[],
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not a recognized rate`);
  }
}

/**
 * Strict structural and bounds validation. Returns errors[] if any required key
 * is missing, non-finite, or negative. An empty errors array means valid.
 */
export function validateRateSnapshot(rates: unknown): RateSetValidationResult {
  const errors: string[] = [];

  if (!rates || typeof rates !== "object") {
    return { valid: false, errors: ["rates must be an object"] };
  }

  const r = rates as Record<string, unknown>;
  rejectUnknownKeys(
    r,
    [
      "slmCallCost",
      "llmCallCost",
      "frontierCallCost",
      "dataCallCost",
      "mcpActionCost",
      "infraPerTxn",
      "modelRates",
      "flowBuildRates",
      "onboardingBase",
      "onboardingPerSystem",
      "onboardingPerCountry",
      "knowledgeMaintenancePerCountry",
      "supportTeamFte",
      "supportHourlyCostUsd",
      "supportToolingAnnualUsdPerClient",
    ],
    "rates",
    errors,
  );

  // AI call costs
  for (const key of ["slmCallCost", "llmCallCost", "frontierCallCost", "dataCallCost"] as const) {
    validateNumber(r[key], `rates.${key}`, errors, { max: RATE_LIMITS.perCallUsd });
  }

  // Azure unit rates
  for (const key of ["mcpActionCost", "infraPerTxn"] as const) {
    validateNumber(r[key], `rates.${key}`, errors, { max: RATE_LIMITS.perTransactionUsd });
  }

  // Model rates
  if (!r["modelRates"] || typeof r["modelRates"] !== "object") {
    errors.push("rates.modelRates must be an object");
  } else {
    const mr = r["modelRates"] as Record<string, unknown>;
    rejectUnknownKeys(mr, MODEL_CATALOG_KEYS, "rates.modelRates", errors);
    for (const modelKey of MODEL_CATALOG_KEYS) {
      const m = mr[modelKey];
      if (!m || typeof m !== "object") {
        errors.push(`rates.modelRates.${modelKey} is missing`);
        continue;
      }
      const mm = m as Record<string, unknown>;
      const modelFields = ["pricePerCallUsd", "inputPricePerMillionTokens", "outputPricePerMillionTokens"] as const;
      rejectUnknownKeys(mm, modelFields, `rates.modelRates.${modelKey}`, errors);
      validateNumber(mm.pricePerCallUsd, `rates.modelRates.${modelKey}.pricePerCallUsd`, errors, {
        max: RATE_LIMITS.perCallUsd,
      });
      for (const field of ["inputPricePerMillionTokens", "outputPricePerMillionTokens"] as const) {
        validateNumber(mm[field], `rates.modelRates.${modelKey}.${field}`, errors, {
          max: RATE_LIMITS.perMillionTokensUsd,
        });
      }
    }

    const defaultCallCostByRole: Record<string, unknown> = {
      router: r.slmCallCost,
      reasoning: r.llmCallCost,
      frontier: r.frontierCallCost,
      data: r.dataCallCost,
    };
    for (const model of modelCatalog.filter((entry) => entry.isDefault)) {
      const modelRate = mr[model.key] as Record<string, unknown> | undefined;
      if (
        modelRate &&
        modelRate.pricePerCallUsd !== defaultCallCostByRole[model.role]
      ) {
        errors.push(
          `rates.modelRates.${model.key}.pricePerCallUsd must equal the ${model.role} default call cost`,
        );
      }
    }
  }

  // Flow build rates
  if (!r["flowBuildRates"] || typeof r["flowBuildRates"] !== "object") {
    errors.push("rates.flowBuildRates must be an object");
  } else {
    const fb = r["flowBuildRates"] as Record<string, unknown>;
    rejectUnknownKeys(fb, FLOW_BUILD_COST_KEYS, "rates.flowBuildRates", errors);
    for (const fcKey of FLOW_BUILD_COST_KEYS) {
      const fc = fb[fcKey];
      if (!fc || typeof fc !== "object") {
        errors.push(`rates.flowBuildRates.${fcKey} is missing`);
        continue;
      }
      const fcc = fc as Record<string, unknown>;
      rejectUnknownKeys(
        fcc,
        ["buildCostUsd", "amortizationTransactions"],
        `rates.flowBuildRates.${fcKey}`,
        errors,
      );
      validateNumber(fcc.buildCostUsd, `rates.flowBuildRates.${fcKey}.buildCostUsd`, errors, {
        max: RATE_LIMITS.oneTimeOrAnnualUsd,
      });
      validateNumber(
        fcc.amortizationTransactions,
        `rates.flowBuildRates.${fcKey}.amortizationTransactions`,
        errors,
        {
          max: RATE_LIMITS.amortizationTransactions,
          positive: true,
          integer: true,
        },
      );
    }
  }

  // Onboarding
  for (const key of ["onboardingBase", "onboardingPerSystem", "onboardingPerCountry"] as const) {
    validateNumber(r[key], `rates.${key}`, errors, { max: RATE_LIMITS.oneTimeOrAnnualUsd });
  }

  // Knowledge maintenance
  validateNumber(r.knowledgeMaintenancePerCountry, "rates.knowledgeMaintenancePerCountry", errors, {
    max: RATE_LIMITS.oneTimeOrAnnualUsd,
  });

  // Support defaults
  validateNumber(r.supportTeamFte, "rates.supportTeamFte", errors, { max: RATE_LIMITS.supportFte });
  validateNumber(r.supportHourlyCostUsd, "rates.supportHourlyCostUsd", errors, {
    max: RATE_LIMITS.supportHourlyUsd,
  });
  validateNumber(r.supportToolingAnnualUsdPerClient, "rates.supportToolingAnnualUsdPerClient", errors, {
    max: RATE_LIMITS.oneTimeOrAnnualUsd,
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a rate-set POST body (rates + rationale + effectiveDate).
 */
export interface RateSetPostBody {
  effectiveDate: string;
  rationale: string;
  rates: unknown;
}

export interface RateSetBodyValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateRateSetBody(body: unknown): RateSetBodyValidationResult {
  const errors: string[] = [];
  if (!body || typeof body !== "object") {
    return { valid: false, errors: ["body must be an object"] };
  }
  const b = body as Record<string, unknown>;

  // effectiveDate: a real calendar date in canonical YYYY-MM-DD form
  const effectiveDate = b["effectiveDate"];
  const parsedDate =
    typeof effectiveDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
      ? new Date(`${effectiveDate}T00:00:00.000Z`)
      : null;
  if (
    !parsedDate ||
    Number.isNaN(parsedDate.valueOf()) ||
    parsedDate.toISOString().slice(0, 10) !== effectiveDate
  ) {
    errors.push("effectiveDate must be a valid calendar date in YYYY-MM-DD format");
  }

  // rationale: non-blank
  if (typeof b["rationale"] !== "string" || b["rationale"].trim().length === 0) {
    errors.push("rationale must be a non-blank string");
  }

  // rates: complete snapshot
  const rateErrors = validateRateSnapshot(b["rates"]).errors;
  errors.push(...rateErrors);

  return { valid: errors.length === 0, errors };
}

// ─── Baseline seeding ───────────────────────────────────────────────────────

/**
 * Build the baseline PricingRateSnapshot from current code constants.
 * This is used as the initial seed when no rate set exists in the DB.
 */
export function buildBaselineRates(): PricingRateSnapshot {
  const modelRates: Record<string, ModelRates> = {};
  for (const m of modelCatalog) {
    modelRates[m.key] = {
      pricePerCallUsd: m.pricePerCallUsd,
      inputPricePerMillionTokens: m.inputPricePerMillionTokens,
      outputPricePerMillionTokens: m.outputPricePerMillionTokens,
    };
  }

  const flowBuildRates: Record<string, FlowBuildRates> = {};
  for (const fc of flowClasses) {
    flowBuildRates[fc.key] = {
      buildCostUsd: fc.buildCostUsd,
      amortizationTransactions: fc.amortizationTransactions,
    };
  }

  return {
    slmCallCost: assumptionMap["slm-call-cost"]!.value,
    llmCallCost: assumptionMap["llm-call-cost"]!.value,
    frontierCallCost: assumptionMap["frontier-call-cost"]!.value,
    dataCallCost: assumptionMap["data-call-cost"]!.value,

    mcpActionCost: assumptionMap["mcp-action-cost"]!.value,
    infraPerTxn: assumptionMap["infra-per-txn"]!.value,

    modelRates,
    flowBuildRates,

    onboardingBase: assumptionMap["onboarding-base"]!.value,
    onboardingPerSystem: assumptionMap["onboarding-per-system"]!.value,
    onboardingPerCountry: assumptionMap["onboarding-per-country"]!.value,

    knowledgeMaintenancePerCountry: assumptionMap["knowledge-maintenance-country"]!.value,

    supportTeamFte: 1,
    supportHourlyCostUsd: 60,
    supportToolingAnnualUsdPerClient: 5_000,
  };
}

/**
 * Resolve an assumption-register key owned by the commercial rate snapshot.
 * Returns undefined for assumptions that remain code/scenario-owned.
 */
export function rateSnapshotAssumptionValue(
  snapshot: PricingRateSnapshot,
  key: string,
): number | undefined {
  const values: Record<string, number> = {
    "slm-call-cost": snapshot.slmCallCost,
    "llm-call-cost": snapshot.llmCallCost,
    "frontier-call-cost": snapshot.frontierCallCost,
    "data-call-cost": snapshot.dataCallCost,
    "mcp-action-cost": snapshot.mcpActionCost,
    "infra-per-txn": snapshot.infraPerTxn,
    "onboarding-base": snapshot.onboardingBase,
    "onboarding-per-system": snapshot.onboardingPerSystem,
    "onboarding-per-country": snapshot.onboardingPerCountry,
    "knowledge-maintenance-country": snapshot.knowledgeMaintenancePerCountry,
  };
  return values[key];
}

// ─── Snapshot loading / resolution ─────────────────────────────────────────

import { db, pricingRateSetsTable } from "@workspace/db";
import { and, desc, eq, lte, sql } from "drizzle-orm";

/** Calendar date string for today in YYYY-MM-DD. */
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load the current pricing rate set from the DB.
 * "Current" = latest effectiveDate <= today, then highest id.
 * If no row qualifies, returns null (caller may seed or fail).
 */
export async function loadCurrentRateSet(organizationId: string): Promise<{
  id: number;
  effectiveDate: string;
  rationale: string;
  rates: PricingRateSnapshot;
  createdBy: string;
  createdAt: Date;
} | null> {
  const today = todayString();
  const rows = await db
    .select()
    .from(pricingRateSetsTable)
    .where(and(
      lte(pricingRateSetsTable.effectiveDate, today),
      eq(pricingRateSetsTable.organizationId, organizationId),
    ))
    .orderBy(desc(pricingRateSetsTable.effectiveDate), desc(pricingRateSetsTable.id))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    id: row.id,
    effectiveDate: row.effectiveDate,
    rationale: row.rationale,
    rates: row.rates as PricingRateSnapshot,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * Ensures a baseline rate set exists in the DB.
 * If no rate sets exist at all, inserts the baseline seeded from code constants.
 * Returns false if the table is empty, true if at least one row exists after the call.
 */
export async function ensureBaselineRateSet(organizationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // GET /pricing-rate-sets and POST /rollup can be the first requests after a
    // deployment. Serialize that one-time seed so concurrent requests cannot
    // append duplicate baseline versions.
    await tx.execute(sql`select pg_advisory_xact_lock(119000001)`);
    const [existing] = await tx
      .select({ id: pricingRateSetsTable.id })
      .from(pricingRateSetsTable)
      .where(eq(pricingRateSetsTable.organizationId, organizationId))
      .limit(1);
    if (existing) return;

    const baseline = buildBaselineRates();
    await tx.insert(pricingRateSetsTable).values({
      effectiveDate: "2025-01-01",
      rationale: "Initial baseline rate set seeded from code constants (v1).",
      rates: baseline as unknown as Record<string, unknown>,
      createdBy: "system",
      organizationId,
    });
  });
}

/**
 * Load and validate the current rate set. Throws with a descriptive error if:
 *   - No current rate set exists
 *   - The snapshot fails validation (incomplete/unsafe rates)
 *
 * This is the entry point for POST /rollup.
 */
export async function loadAndValidateCurrentRateSet(organizationId: string): Promise<{
  id: number;
  effectiveDate: string;
  rationale: string;
  rates: PricingRateSnapshot;
  createdBy: string;
  createdAt: Date;
}> {
  const rateSet = await loadCurrentRateSet(organizationId);
  if (!rateSet) {
    throw new Error(
      "No current pricing rate set found. A rate set with effectiveDate <= today must exist before generating quotes.",
    );
  }

  const validation = validateRateSnapshot(rateSet.rates);
  if (!validation.valid) {
    throw new Error(
      `Current pricing rate set (id=${rateSet.id}) is invalid: ${validation.errors.join("; ")}`,
    );
  }

  return rateSet;
}

// ─── Rate-set reference metadata ────────────────────────────────────────────

/** Metadata about the rate set snapshot used to generate a rollup. */
export interface RateSetReference {
  rateSetId: number;
  effectiveDate: string;
  rationale: string;
  createdBy: string;
  createdAt: string; // ISO timestamp
}
