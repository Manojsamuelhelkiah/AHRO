import { test } from "node:test";
import assert from "node:assert/strict";
import { deletedSourceDigest, receiptBlocksSource } from "./deleted-source";

test("deleted source matches only the exact tenant, channel and source reference", () => {
  const digest = deletedSourceDigest("demo", "hr-request", "source-1");
  const receipt = JSON.stringify({ version: 1, organizationId: "demo", offboardingSourceTombstones: [digest] });
  assert.equal(receiptBlocksSource(receipt, digest), true);
  for (const args of [
    ["another-client", "hr-request", "source-1"],
    ["demo", "manager-request", "source-1"],
    ["demo", "hr-request", "source-2"],
  ]) assert.equal(receiptBlocksSource(receipt, deletedSourceDigest(args[0], args[1], args[2])), false);
});

test("missing or malformed retained tombstones fail explicitly", () => {
  assert.throws(() => receiptBlocksSource("invalid", "abc"));
  assert.throws(() => receiptBlocksSource(JSON.stringify({ version: 1, organizationId: "demo" }), "abc"));
  assert.throws(() => receiptBlocksSource(JSON.stringify({
    version: 1, organizationId: "another-client", offboardingSourceTombstones: [],
  }), "abc"));
});
