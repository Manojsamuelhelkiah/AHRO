import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { batchIntakePayloadFingerprint, eligibleForExplicitBatchRelease } from "./batch-intake";

describe("batch intake retry fencing", () => {
  test("reconciles an equivalent person payload despite row ordering", () => {
    const first = [{ personKey: "b", workerName: "Bee", workforceContext: { site: "A" } }, { personKey: "a", workerName: "Aye" }];
    const retry = [{ workerName: "Aye", personKey: "a" }, { workforceContext: { site: "A" }, workerName: "Bee", personKey: "b" }];
    assert.equal(batchIntakePayloadFingerprint("April", first), batchIntakePayloadFingerprint("April", retry));
  });

  test("rejects a retry key when an individual payload changes", () => {
    const original = batchIntakePayloadFingerprint("April", [{ personKey: "a", workerEmail: "a@company.test" }]);
    const changed = batchIntakePayloadFingerprint("April", [{ personKey: "a", workerEmail: "other@company.test" }]);
    assert.notEqual(original, changed);
  });

  test("only non-Gate-A cohorts are eligible for explicit batch release", () => {
    assert.equal(eligibleForExplicitBatchRelease("internal-transfer"), true);
    assert.equal(eligibleForExplicitBatchRelease("external-fte"), false);
    assert.equal(eligibleForExplicitBatchRelease("contractor"), false);
  });
});