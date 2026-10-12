import assert from "node:assert/strict";
import { test } from "node:test";
import { createUatRun, applyUatAction, fixturePack, getLearningCatalog } from "./uat-test-center";
test("direct UAT creation and every old action reject before initialization, credentials or provider calls", async () => {
  for (const organizationId of ["demo", "client"]) {
    await assert.rejects(createUatRun(organizationId, "actor", { scenarioId: "UAT-STD-01", requestId: "old" }), { name: "RetiredCaseCapabilityError", status: 410 });
    for (const kind of ["record-evidence", "exchange", "advance-clock", "pause", "resume", "cleanup", "issue-candidate-portal", "inject-harmless-scanner-fact", "evaluate-workflow"] as const) {
      await assert.rejects(applyUatAction(organizationId, "actor", "old", { kind, expectedVersion: 0, requestId: "retry" }), { name: "RetiredCaseCapabilityError", status: 410 });
    }
  }
});
test("fixture distribution is retired even for retained run identifiers", () => {
  assert.throws(() => fixturePack({ runId: "old", scenarioId: "UAT-STD-01", fixtureSeed: "old" }), { name: "RetiredCaseCapabilityError" });
});
test("learning catalog describes current controls without fictional execution entry points", () => {
  const catalog = getLearningCatalog();
  assert.deepEqual(catalog.scenarios, []);
  assert.equal(catalog.features.some(f => ["PFC-037", "PFC-040", "PFC-041", "PFC-042", "PFC-043"].includes(f.id)), false);
  assert.ok(catalog.guideSections.some(g => g.title.includes("privacy")));
  assert.ok(catalog.guideSections.some(g => g.title.includes("Policy")));
  assert.equal(catalog.denominators.features.executedAssertions, 0);
  assert.equal(catalog.denominators.requirements.executedAssertions, 0);
});
