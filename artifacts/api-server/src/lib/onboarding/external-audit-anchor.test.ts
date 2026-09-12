import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareLocalAndExternalCheckpoint,
  currentExternalAuditAnchorProvider,
  resetExternalAuditAnchorProviderForTests,
} from "./external-audit-anchor";
import { regulatedProductionAuditLaunchBlocked } from "./protected-audit";

test("the default simulation exercises receipt flow but is never independent", () => {
  resetExternalAuditAnchorProviderForTests();
  const provider = currentExternalAuditAnchorProvider();
  assert.equal(provider.kind, "simulated");
  assert.equal(provider.independent, false);
});

test("restore comparison distinguishes match, backlog, and divergence", () => {
  assert.equal(compareLocalAndExternalCheckpoint(null, null), "empty");
  assert.equal(compareLocalAndExternalCheckpoint({ sequence: 1, hash: "a" }, null), "missing");
  assert.equal(
    compareLocalAndExternalCheckpoint({ sequence: 2, hash: "b" }, { sequence: 2, hash: "b" }),
    "match",
  );
  assert.equal(
    compareLocalAndExternalCheckpoint({ sequence: 3, hash: "c" }, { sequence: 2, hash: "b" }),
    "external-behind",
  );
  assert.equal(
    compareLocalAndExternalCheckpoint({ sequence: 2, hash: "b" }, { sequence: 3, hash: "c" }),
    "external-ahead",
  );
  assert.equal(
    compareLocalAndExternalCheckpoint({ sequence: 2, hash: "b" }, { sequence: 2, hash: "c" }),
    "mismatch",
  );
});

test("a broken or empty local chain can never be launch-unblocked", () => {
  assert.equal(regulatedProductionAuditLaunchBlocked("broken", false), true);
  assert.equal(regulatedProductionAuditLaunchBlocked("empty", false), true);
  assert.equal(regulatedProductionAuditLaunchBlocked("verified", true), true);
  assert.equal(regulatedProductionAuditLaunchBlocked("verified", false), false);
});