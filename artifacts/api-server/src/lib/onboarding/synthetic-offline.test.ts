import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSyntheticOfflineCase,
  isSyntheticDemoAuthority,
  isUatRunIsolatedCase,
  SYNTHETIC_DEMO_AUTHORITY_SOURCE,
} from "./synthetic-offline";

test("clearing mutable notes cannot reactivate a reserved UAT scenario", () => {
  const minimizedUatCase = {
    scenarioKey: "UAT-STD-01",
    notes: null,
  };
  assert.equal(isUatRunIsolatedCase(minimizedUatCase), true);
  assert.equal(isSyntheticOfflineCase(minimizedUatCase), true);
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