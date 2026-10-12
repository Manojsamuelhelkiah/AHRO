import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSyntheticOfflineCase,
  isSyntheticDemoAuthority,
  isUatRunIsolatedCase,
  SYNTHETIC_DEMO_AUTHORITY_SOURCE,
  sampleCandidateEmailEligible,
  SYNTHETIC_OFFLINE_MARKER,
} from "./synthetic-offline";

test("clearing mutable notes cannot reactivate a reserved UAT scenario", () => {
  const minimizedUatCase = {
    scenarioKey: "UAT-STD-01",
    notes: null,
  };
  assert.equal(isUatRunIsolatedCase(minimizedUatCase), true);
  assert.equal(isSyntheticOfflineCase(minimizedUatCase), true);
});

test("historical email exceptions stay retired even for deliverable addresses and coverage provenance", () => {
  const sample = { notes: SYNTHETIC_OFFLINE_MARKER, syntheticProvenance: "synthetic-reset" as const, workerEmail: "candidate@mailhost.com" };
  assert.equal(sampleCandidateEmailEligible(sample), false);
  assert.equal(isSyntheticOfflineCase(sample), true);
  assert.equal(sampleCandidateEmailEligible({ ...sample, workerEmail: "sample@hro.invalid" }), false);
  assert.equal(sampleCandidateEmailEligible({ ...sample, scenarioKey: "UAT-REAL-RUN" }), false);
  assert.equal(sampleCandidateEmailEligible({ ...sample, scenarioKey: "UAT-DEMO-COVERAGE:standard-fte" }), false);
  assert.equal(sampleCandidateEmailEligible({ ...sample, syntheticProvenance: "demo-full-coverage", scenarioKey: "UAT-DEMO-COVERAGE:standard-fte" }), false);
  assert.equal(sampleCandidateEmailEligible({ workerEmail: "candidate@fake-provider.mailhost.com", notes: null }), true,
    "the compatibility helper must preserve ordinary authenticated email eligibility");
});

test("synthetic demo authority requires the exact tenant, source, and server marker", () => {
  const syntheticCase = {
    scenarioKey: "UAT-STD-01",
    notes: null,
  };
  assert.equal(isSyntheticDemoAuthority({
    organizationId: "demo",
    caseRow: syntheticCase,
    source: SYNTHETIC_DEMO_AUTHORITY_SOURCE,
  }), true);
  assert.equal(isSyntheticDemoAuthority({
    organizationId: "client",
    caseRow: syntheticCase,
    source: SYNTHETIC_DEMO_AUTHORITY_SOURCE,
  }), false);
  assert.equal(isSyntheticDemoAuthority({
    organizationId: "demo",
    caseRow: { scenarioKey: "normal", notes: null },
    source: SYNTHETIC_DEMO_AUTHORITY_SOURCE,
  }), false);
  assert.equal(isSyntheticDemoAuthority({
    organizationId: "demo",
    caseRow: syntheticCase,
    source: "governance-approved",
  }), false);
});