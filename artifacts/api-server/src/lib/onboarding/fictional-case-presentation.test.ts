import assert from "node:assert/strict";
import test from "node:test";
import { fixedFictionalPresentation, readableFictionalItems } from "./fictional-case-presentation";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { NO_SENSITIVE_ACCESS } from "./sensitive-access";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";
import type { onbCases } from "@workspace/db";

const legacy = {
  organizationId: "demo", scenarioKey: "UAT-DEMO-COVERAGE:offboarding-voluntary",
  workerName: "Demo sample — Voluntary offboarding", workerEmail: "demo-offboarding-voluntary@hro.invalid",
  workerPhone: null, candidateEmailAuthorizedAt: null, candidateEmailAuthorizedBy: null,
  notes: SYNTHETIC_OFFLINE_MARKER, syntheticProvenance: null,
} as typeof onbCases.$inferSelect;

test("legacy fixed voluntary offboarding explains the request without claiming completion", () => {
  const fixed = fixedFictionalPresentation(legacy)!;
  assert.match(fixed.summary, /resignation/);
  assert.match(fixed.summary, /pending/);
  assert.match(fixed.summary, /missing approved closure/);
  const items = readableFictionalItems([{ key: "payroll", label: fixed.readiness[2]!.label,
    status: "pending", note: "PRIVATE bank finding", owner: "PRIVATE individual" }],
  NO_SENSITIVE_ACCESS, fixed.readiness);
  assert.equal(items[0]!.label, fixed.readiness[2]!.label);
  assert.equal(items[0]!.status, "pending");
  assert.doesNotMatch(JSON.stringify(items), /PRIVATE/);
  assert.equal((items[0] as Record<string, unknown>).restricted, undefined);
});

test("all curated families use fixed definitions; arbitrary metadata remains restricted", () => {
  for (const example of CURATED_OFFLINE_EXAMPLES) {
    const row = { organizationId: "demo", ...example.values } as unknown as typeof onbCases.$inferSelect;
    const fixed = fixedFictionalPresentation(row)!;
    assert.ok(fixed, example.key);
    assert.equal(fixed.summary, example.values.planSummary);
    const items = readableFictionalItems([
      { ...example.values.readiness[0]!, note: "PRIVATE extra narrative" },
      { key: "example-review", label: "PRIVATE custom label", status: "blocked" },
      { key: "custom", label: "PRIVATE custom narrative", status: "pending" },
    ], NO_SENSITIVE_ACCESS, fixed.readiness);
    assert.equal(items[0]!.label, example.values.readiness[0]!.label);
    assert.equal(items[1]!.key, "restricted");
    assert.equal(items[1]!.status, "blocked");
    assert.equal(items[2]!.key, "restricted");
    assert.doesNotMatch(JSON.stringify(items), /PRIVATE/);
    assert.equal(fixedFictionalPresentation({ ...row, workerEmail: "real@example.com" }), null);
    assert.equal(fixedFictionalPresentation({ ...row, organizationId: "other" }), null);
    assert.equal(fixedFictionalPresentation({ ...row, workerName: "Mutable identity" }), null);
    assert.equal(fixedFictionalPresentation({ ...row, operationalPreparation: {} } as typeof row), null);
    assert.equal(fixedFictionalPresentation({ ...row, operationalActivation: {} } as typeof row), null);
  }
});

test("partial sensitive permissions do not unlock unmatched items; full permissions preserve live data", () => {
  const items = [{ key: "custom", label: "PRIVATE", status: "blocked", note: "PRIVATE finding" }];
  assert.equal(readableFictionalItems(items, { ...NO_SENSITIVE_ACCESS, identity: true })[0]!.key, "restricted");
  assert.deepEqual(readableFictionalItems(items, { identity: true, medical: true, payroll: true, bgv: true }), items);
  for (const alteration of [{ workerName: "Real person" }, { workerPhone: "123" },
    { candidateEmailAuthorizedBy: "person" }, { scenarioKey: "UAT-random" }]) {
    assert.equal(fixedFictionalPresentation({ ...legacy, ...alteration }), null);
  }
});
