import assert from "node:assert/strict";
import { test } from "node:test";
import { seedDemoFullCoverage, demoFullCoverageScenarioKey, originalDemoFullCoverageScenarioKey } from "./demo-full-coverage";
test("CLI and service seeds are permanently denied for every tenant, actor and retry", async () => {
  for (const tenant of ["demo", "client", "fixture-tenant"]) {
    for (const actor of [null, "administrator", "development-demo-seed"]) {
      await assert.rejects(seedDemoFullCoverage(tenant, actor), { name: "RetiredCaseCapabilityError", status: 410 });
    }
  }
});
test("historical coverage identifiers remain readable without creating or replacing cases", () => {
  const key = demoFullCoverageScenarioKey("standard-fte");
  assert.equal(originalDemoFullCoverageScenarioKey(key), "standard-fte");
  assert.equal(originalDemoFullCoverageScenarioKey("ordinary"), null);
});
