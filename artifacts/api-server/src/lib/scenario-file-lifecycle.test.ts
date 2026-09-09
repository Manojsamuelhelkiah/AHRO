import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PENDING_UPLOAD_BYTES_PER_OWNER,
  MAX_PENDING_UPLOAD_INTENTS_PER_OWNER,
  pendingUploadQuotaExceeded,
  uploadTransitionAllowed,
  cleanupFenceEligible,
} from "./scenario-file-lifecycle";

test("pending upload quota rejects count and declared-byte exhaustion", () => {
  assert.equal(pendingUploadQuotaExceeded(0, 0, 1), false);
  assert.equal(pendingUploadQuotaExceeded(MAX_PENDING_UPLOAD_INTENTS_PER_OWNER, 0, 1), true);
  assert.equal(pendingUploadQuotaExceeded(0, MAX_PENDING_UPLOAD_BYTES_PER_OWNER - 10, 10), false);
  assert.equal(pendingUploadQuotaExceeded(0, MAX_PENDING_UPLOAD_BYTES_PER_OWNER - 10, 11), true);
});

test("one-time upload lifecycle permits only forward claims and explicit upload retry", () => {
  assert.equal(uploadTransitionAllowed("pending", "uploading"), true);
  assert.equal(uploadTransitionAllowed("uploading", "pending"), true);
  assert.equal(uploadTransitionAllowed("uploading", "uploaded"), true);
  assert.equal(uploadTransitionAllowed("uploaded", "processing"), true);
  assert.equal(uploadTransitionAllowed("processing", "finalized"), true);
  assert.equal(uploadTransitionAllowed("uploaded", "uploading"), false);
  assert.equal(uploadTransitionAllowed("finalized", "processing"), false);
  assert.equal(uploadTransitionAllowed("finalized", "uploading"), false);
  assert.equal(uploadTransitionAllowed("uploaded", "cleaning"), true);
});

test("cleanup fencing claims only expired or stale observed states", () => {
  const now = 1_000_000;
  assert.equal(cleanupFenceEligible("pending", now - 1, null, null, now), true);
  assert.equal(cleanupFenceEligible("uploaded", now + 1, null, null, now), false);
  assert.equal(cleanupFenceEligible("processing", now, now - 300_001, null, now), true);
  assert.equal(cleanupFenceEligible("processing", now, now - 1, null, now), false);
  assert.equal(cleanupFenceEligible("cleaning", now, null, now - 300_001, now), true);
  assert.equal(cleanupFenceEligible("cleaning", now, null, now - 1, now), false);
  assert.equal(cleanupFenceEligible("finalized", now + 1, null, null, now), true);
});