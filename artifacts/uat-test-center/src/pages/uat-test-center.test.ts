import assert from "node:assert/strict";
import test from "node:test";
import { canRequestUatCleanup, exchangeStatePresets, fixtureVariants, syntheticFixturePayload, syntheticPdf, uatCoverageCsv, uatTraceabilityCsv } from "./uat-test-center";

test("UAT exports preserve a real PDF header and scenario coverage gaps", () => {
  assert.match(syntheticPdf(), /^%PDF-1\.4/);
  assert.match(syntheticPdf(), /SYNTHETIC QA DOCUMENT/);
  assert.match(syntheticPdf(), /NOT A REAL IDENTITY/);
  const csv = uatCoverageCsv([{
    id: "UAT-01", title: "Provider timeout, retry", family: "providers",
    description: "Test", roles: ["system operator"], mode: "provider-sandbox",
    status: "blocked", blocker: "No sandbox", steps: [],
  }]);
  for (const value of ["UAT-01", "blocked", "No sandbox"]) assert.ok(csv.includes(`"${value}"`));
});
test("fixtures remain harmless fictional inputs with negative cases and oversized preflight", () => {
  const ids = fixtureVariants.map(f => f.id);
  for (const id of ["valid", "missing-information", "expired", "inconsistent-name", "unsupported-format", "oversized", "corrupt", "changed-bytes"]) assert.ok(ids.includes(id as typeof ids[number]));
  assert.match(syntheticFixturePayload("missing-information").body, /Required field: intentionally absent/);
  assert.match(syntheticFixturePayload("expired").body, /Expiry: 2000-01-01/);
  assert.match(syntheticFixturePayload("corrupt").body, /deliberately not a valid PDF stream/);
  assert.ok(syntheticFixturePayload("oversized").body.length > 10 * 1024 * 1024);
  assert.match(syntheticFixturePayload("valid", "Taylor Fictional").body, /Fictional person: Taylor Fictional/);
  assert.match(syntheticFixturePayload("inconsistent-name", "Taylor Fictional").body, /Name: Different Fictional Person/);
});
test("traceability preserves denominators, manual gaps and newer tenant evidence", () => {
  const csv = uatTraceabilityCsv({
    catalogVersion: "catalog-test", baselineRevision: "BRD test", guideSections: [],
    features: [{ id: "PFC-001", title: "Feature", values: { scenarioIds: ["UAT-01"], verification: "manual" } }],
    requirements: [{ id: "REQ-01", title: "Requirement", values: { scenarioIds: ["UAT-01"], availability: "partial", latestResult: "manual" } }],
    denominators: { features: { denominator: 44, withScenario: 44 }, requirements: { denominator: 81, withScenario: 80 } },
  }, [{
    scenarioId: "UAT-01", updatedAt: "2026-09-14T12:00:00.000Z",
    evidence: [{ id: "evidence-1", at: "2026-09-14T11:00:00.000Z", stepId: "step-1", result: "blocked", provenance: "manual-evidence", note: "Observed blocked." }],
  }]);
  assert.match(csv, /"feature-summary","features","Feature coverage denominator","44"/);
  assert.match(csv, /"requirement-summary","requirements","BRD\/product requirement coverage denominator","81"/);
  assert.match(csv, /"PFC-001".*"blocked"/);
  assert.match(csv, /"REQ-01".*"manual","blocked"/);
  assert.match(csv, /"manual-evidence"/);
});
test("presets preserve failure families and cleanup remains run-scoped", () => {
  const values = exchangeStatePresets.map(p => p.value);
  for (const value of ["delayed", "pending", "timeout", "failed", "unavailable", "identity-mismatch", "duplicate", "quarantined", "infected", "out-of-order", "queued"]) assert.ok(values.includes(value as typeof values[number]));
  for (const status of ["active", "paused", "blocked", "completed"] as const) assert.equal(canRequestUatCleanup(status, false), true);
  assert.equal(canRequestUatCleanup("cleaned", false), false);
  assert.equal(canRequestUatCleanup("blocked", true), false);
});
