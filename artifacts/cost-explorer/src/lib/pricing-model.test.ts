import assert from "node:assert/strict";
import test from "node:test";
import { calculatePricingModel, DEFAULT_PRICING_INPUTS, normalizePricingInputs } from "./pricing-model";

test("pricing model keeps the four commercial cost buckets distinct", () => {
  const result = calculatePricingModel(DEFAULT_PRICING_INPUTS);

  assert.equal(result.platformBuild, 331_200);
  assert.equal(result.clientImplementation, 78_470);
  assert.equal(result.annualHostingAndAi, 75_360);
  assert.equal(result.annualSupport, 42_200);
  assert.equal(result.annualSharedBuildAllocation, 9_200);
  assert.equal(result.annualRunRate, 126_760);
});

test("recommended prices apply the configured gross margin", () => {
  const result = calculatePricingModel(DEFAULT_PRICING_INPUTS);

  assert.equal(result.recommendedMonthlySubscription, 30_180.95238095238);
  assert.equal(result.recommendedAnnualCommitment, 362_171.4285714286);
  assert.equal(result.recommendedImplementationFee, 224_200);
  assert.ok(Math.abs(result.recommendedTransactionPrice - 3.018095238095238) < 1e-12);
  assert.ok(Math.abs(result.recommendedOveragePrice - 0.13571428571428573) < 1e-12);
});

test("dedicated enterprise architecture increases both one-time and recurring costs", () => {
  const baseline = calculatePricingModel(DEFAULT_PRICING_INPUTS);
  const dedicated = calculatePricingModel({
    ...DEFAULT_PRICING_INPUTS,
    tenantTier: "dedicated",
    securityTier: "enterprise",
  });

  assert.ok(dedicated.clientImplementation > baseline.clientImplementation);
  assert.ok(dedicated.annualHostingAndAi > baseline.annualHostingAndAi);
  assert.ok(dedicated.platformBuild > baseline.platformBuild);
  assert.ok(dedicated.recommendedMonthlySubscription > baseline.recommendedMonthlySubscription);
});

test("more clients lowers the per-client shared build allocation without changing the platform build", () => {
  const baseline = calculatePricingModel(DEFAULT_PRICING_INPUTS);
  const scaled = calculatePricingModel({ ...DEFAULT_PRICING_INPUTS, clientsInCohort: 24 });

  assert.equal(scaled.platformBuild, baseline.platformBuild);
  assert.equal(scaled.annualSharedBuildAllocation, baseline.annualSharedBuildAllocation / 2);
  assert.ok(scaled.recommendedAnnualCommitment < baseline.recommendedAnnualCommitment);
});

test("invalid numeric inputs are clamped to safe minimums", () => {
  const result = calculatePricingModel({
    ...DEFAULT_PRICING_INPUTS,
    annualTransactions: 0,
    clientsInCohort: 0,
    grossMarginPct: 100,
    buildAmortizationYears: 0,
  });

  assert.ok(Number.isFinite(result.unitTransactionCost));
  assert.ok(Number.isFinite(result.recommendedMonthlySubscription));
  assert.ok(result.recommendedMonthlySubscription > 0);
});

test("input normalization keeps displayed count assumptions whole and within valid bounds", () => {
  const normalized = normalizePricingInputs({
    ...DEFAULT_PRICING_INPUTS,
    clientsInCohort: 4.6,
    annualTransactions: Number.NaN,
    channels: -2,
    integrations: 2.4,
    agents: 0,
    workflows: 3.7,
    grossMarginPct: 100,
    buildAmortizationYears: 0,
  });

  assert.deepEqual(normalized, {
    ...DEFAULT_PRICING_INPUTS,
    clientsInCohort: 5,
    annualTransactions: 1,
    channels: 0,
    integrations: 2,
    agents: 1,
    workflows: 4,
    grossMarginPct: 90,
    buildAmortizationYears: 1,
  });
});

test("transaction entitlement is an exact annual pool with a derived monthly average", () => {
  const result = calculatePricingModel({ ...DEFAULT_PRICING_INPUTS, annualTransactions: 100_001 });

  assert.equal(result.includedAnnualTransactions, 100_001);
  assert.equal(result.averageMonthlyTransactions * 12, result.includedAnnualTransactions);
});