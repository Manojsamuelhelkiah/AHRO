import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTHORITY_ROLES, ROLE_SCOPE_MATRIX } from "./decision-authority";
import { syntheticDemoAuthorityRows } from "./demo-admin-access";
import {
  isSyntheticDemoAuthority,
  SYNTHETIC_DEMO_AUTHORITY_SOURCE,
  SYNTHETIC_OFFLINE_MARKER,
} from "./synthetic-offline";

test("demo administrator grants cover every role only for synthetic cases", () => {
  const rows = syntheticDemoAuthorityRows("user_demo_admin", [
    { id: 11, notes: SYNTHETIC_OFFLINE_MARKER, scenarioKey: "demo-case" },
    { id: 12, notes: null, scenarioKey: "UAT-CLIENT-01" },
    { id: 13, notes: null, scenarioKey: "ordinary-case" },
  ]);

  assert.equal(rows.length, AUTHORITY_ROLES.length * 2);
  assert.deepEqual(new Set(rows.map((row) => row.caseId)), new Set([11, 12]));
  assert.ok(rows.every((row) => row.organizationId === "demo"));
  assert.ok(rows.every((row) => row.personUserId === "user_demo_admin"));
  assert.ok(rows.every((row) => row.emailResponderAuthorized === false));
  assert.ok(rows.every((row) => row.source === SYNTHETIC_DEMO_AUTHORITY_SOURCE));
  for (const row of rows) {
    assert.deepEqual(row.scopes, ROLE_SCOPE_MATRIX[row.authorityRole]);
  }
});

test("synthetic authority cannot cross tenant, case, or source boundaries", () => {
  const syntheticCase = { scenarioKey: "UAT-CLIENT-01", notes: null };
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
    caseRow: { scenarioKey: "ordinary-case", notes: null },
    source: SYNTHETIC_DEMO_AUTHORITY_SOURCE,
  }), false);
  assert.equal(isSyntheticDemoAuthority({
    organizationId: "demo",
    caseRow: syntheticCase,
    source: "governance-approved",
  }), false);
});