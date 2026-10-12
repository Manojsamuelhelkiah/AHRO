import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSyntheticReset, DEFAULT_SYNTHETIC_RESET_MANIFEST } from "./synthetic-reset";
test("old reset calls cannot delete or replace records even with an exact manifest", async () => {
  for (const organizationId of ["demo", "client", "fixture-tenant"]) {
    await assert.rejects(executeSyntheticReset({
      organizationId, actorId: "owner", expectedRevision: "stale",
      manifest: DEFAULT_SYNTHETIC_RESET_MANIFEST,
    }), { name: "RetiredCaseCapabilityError", status: 410 });
    await assert.rejects(executeSyntheticReset({
      organizationId, actorId: "owner", expectedRevision: "current", manifest: [],
    }), { name: "RetiredCaseCapabilityError", status: 410 });
  }
});
test("historical inventory remains tenant-explicit and is never broadened to all cases", () => {
  assert.ok(DEFAULT_SYNTHETIC_RESET_MANIFEST.every(entry => entry.organizationId && Number.isSafeInteger(entry.id)));
  assert.equal(new Set(DEFAULT_SYNTHETIC_RESET_MANIFEST.map(entry => `${entry.organizationId}:${entry.id}`)).size, DEFAULT_SYNTHETIC_RESET_MANIFEST.length);
});
