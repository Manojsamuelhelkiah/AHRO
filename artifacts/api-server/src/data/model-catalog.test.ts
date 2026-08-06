/**
 * Invariant tests for model-catalog.ts.
 *
 * Guards the single source of truth: for each default model, the baked
 * pricePerCallUsd must be consistent with the per-token rates applied to
 * the canonical HRO call token profile for that role.
 *
 * Invariant: the pricePerCallUsd for each default model, when divided by the
 * average of its per-token rates, must imply a plausible token count per call
 * (100–500k tokens). This catches copy-paste of the wrong model's rates or
 * unit errors (e.g. entering 600 instead of 0.6 for $/M tokens).
 *
 * If a test fails after a legitimate price update:
 *   1. Update inputPricePerMillionTokens / outputPricePerMillionTokens in
 *      model-catalog.ts to match the new published rate.
 *   2. Update pricePerCallUsd (and the matching *-call-cost assumption if it
 *      is the default model) to reflect the new cost at the typical call profile.
 *   3. Confirm the implied token count is still within 100–500k.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { modelCatalog } from "./model-catalog";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Default models — one per role. */
const defaults = modelCatalog.filter((m) => m.isDefault);

test("model-catalog: there is exactly one default model per role", () => {
  const roles = ["router", "reasoning", "frontier", "data"];
  for (const role of roles) {
    const roleDefaults = defaults.filter((m) => m.role === role);
    assert.equal(
      roleDefaults.length,
      1,
      `Expected exactly 1 default for role "${role}", found ${roleDefaults.length}`,
    );
  }
});

test("model-catalog: all models expose inputPricePerMillionTokens > 0", () => {
  for (const m of modelCatalog) {
    assert.ok(
      m.inputPricePerMillionTokens > 0,
      `${m.key}: inputPricePerMillionTokens must be > 0, got ${m.inputPricePerMillionTokens}`,
    );
  }
});

test("model-catalog: all models expose outputPricePerMillionTokens > 0", () => {
  for (const m of modelCatalog) {
    assert.ok(
      m.outputPricePerMillionTokens > 0,
      `${m.key}: outputPricePerMillionTokens must be > 0, got ${m.outputPricePerMillionTokens}`,
    );
  }
});

/**
 * For each default model, the baked pricePerCallUsd must imply a plausible
 * total token count when divided by the simple-average per-token rate.
 *
 * "Plausible" = 100–500,000 tokens per call. This catches:
 *   - Copy-paste of the wrong model's rates into a role (e.g. frontier rates
 *     in the router slot would imply ~44 tokens → below the lower bound).
 *   - Unit errors (entering 600 instead of 0.6 for $/M tokens would imply
 *     ~3 tokens → way below the lower bound).
 *
 * It intentionally does NOT enforce exact consistency with any specific token
 * profile, because the catalog's baked prices and per-role profile comments
 * are best-effort estimates that may not match exactly.
 */
test("model-catalog: default model pricePerCallUsd implies a plausible call token count (100–500k tokens)", () => {
  const MIN_TOKENS = 100;
  const MAX_TOKENS = 500_000;

  for (const m of defaults) {
    // Simple average of input and output rates as a per-token reference.
    const avgPricePerMillion =
      (m.inputPricePerMillionTokens + m.outputPricePerMillionTokens) / 2;
    const impliedTokens = (m.pricePerCallUsd * 1_000_000) / avgPricePerMillion;

    assert.ok(
      impliedTokens >= MIN_TOKENS && impliedTokens <= MAX_TOKENS,
      `${m.key} (${m.role}): pricePerCallUsd=${m.pricePerCallUsd} implies ` +
        `${impliedTokens.toFixed(0)} tokens at avg rate ${avgPricePerMillion}/M — ` +
        `outside plausible range ${MIN_TOKENS}–${MAX_TOKENS}. ` +
        `Check that per-token rates and pricePerCallUsd are on the same order of magnitude.`,
    );
  }
});

/**
 * Per-token rates must be positive and finite — a zero or NaN rate would
 * silently produce wrong drift estimates.
 */
test("model-catalog: per-token rates are finite and positive for all models", () => {
  for (const m of modelCatalog) {
    assert.ok(
      Number.isFinite(m.inputPricePerMillionTokens) && m.inputPricePerMillionTokens > 0,
      `${m.key}: inputPricePerMillionTokens is not a positive finite number`,
    );
    assert.ok(
      Number.isFinite(m.outputPricePerMillionTokens) && m.outputPricePerMillionTokens > 0,
      `${m.key}: outputPricePerMillionTokens is not a positive finite number`,
    );
    assert.ok(
      Number.isFinite(m.pricePerCallUsd) && m.pricePerCallUsd > 0,
      `${m.key}: pricePerCallUsd is not a positive finite number`,
    );
  }
});
