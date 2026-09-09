import assert from "node:assert/strict";
import { test } from "node:test";
import { actionableCorrectionReason, decideValidationOutcome, documentationGateReady, normalizeBgvStatus, reminderEligible } from "./document-validation-policy";
import { candidateEmailDeliveryDecision, candidateEmailMaySend } from "./channel-routing";

test("BGV normalization is provider-neutral and never treats unknown as clear", () => {
  assert.equal(normalizeBgvStatus("done"), "clear");
  assert.equal(normalizeBgvStatus("rejected"), "rejected");
  assert.equal(normalizeBgvStatus("vendor-success"), "manual_review");
});

test("reminders require required, stale pending evidence", () => {
  const now = Date.parse("2030-01-03T00:00:00Z");
  assert.equal(reminderEligible({ required: true, status: "pending", updatedAt: new Date("2030-01-01T00:00:00Z"), now }), true);
  assert.equal(reminderEligible({ required: true, status: "pending", updatedAt: new Date("2030-01-02T12:00:00Z"), now }), false);
  assert.equal(reminderEligible({ required: false, status: "pending", updatedAt: new Date("2029-01-01"), now }), false);
});

test("validation outcome gives local safety failures precedence", () => {
  assert.equal(decideValidationOutcome([{ code: "checksum_mismatch" }], "verified"), "correction_requested");
  assert.equal(decideValidationOutcome([{ code: "duplicate_identity" }], "verified"), "passed");
  assert.equal(decideValidationOutcome([], "verified"), "passed");
});

test("provider outcomes are conservative and provider errors are reviewable", () => {
  assert.equal(decideValidationOutcome([], "rejected"), "rejected");
  assert.equal(decideValidationOutcome([], "manual_review"), "manual_review");
  assert.equal(decideValidationOutcome([], "unavailable"), "manual_review");
  assert.equal(decideValidationOutcome([], "error"), "manual_review");
});

test("candidate guidance only exposes actionable local correction reasons", () => {
  assert.equal(actionableCorrectionReason({ code: "checksum_mismatch" }), true);
  assert.equal(actionableCorrectionReason({ code: "active_content_check", evidence: "clear" }), false);
  assert.equal(actionableCorrectionReason({ code: "expiry_check_unavailable", evidence: "unavailable" }), false);
  assert.equal(actionableCorrectionReason({ code: "duplicate_identity" }), false);
});

test("documentation gate requires BGV and every required document", () => {
  assert.equal(documentationGateReady({ bgvApplicable: true, bgvClear: false, requiredDocuments: 2, verifiedDocuments: 2 }), false);
  assert.equal(documentationGateReady({ bgvApplicable: true, bgvClear: true, requiredDocuments: 2, verifiedDocuments: 1 }), false);
  assert.equal(documentationGateReady({ bgvApplicable: true, bgvClear: true, requiredDocuments: 2, verifiedDocuments: 2 }), true);
  assert.equal(documentationGateReady({ bgvApplicable: false, bgvClear: false, requiredDocuments: 1, verifiedDocuments: 1 }), true);
});

test("legacy checksum initialization is not an actionable correction", () => {
  assert.equal(actionableCorrectionReason({ code: "legacy_checksum_initialized", evidence: "initialized" }), false);
});

test("candidate reminders are authorized per case and WhatsApp-only cases stay logged-only", () => {
  assert.equal(candidateEmailMaySend({
    channelPreference: "email", caseAuthorized: true, explicitlyAllowlisted: false, validEmail: true,
  }), true);
  assert.equal(candidateEmailMaySend({
    channelPreference: "email", caseAuthorized: false, explicitlyAllowlisted: false, validEmail: true,
  }), false);
  assert.equal(candidateEmailMaySend({
    channelPreference: "whatsapp", caseAuthorized: true, explicitlyAllowlisted: false, validEmail: true,
  }), false);
  assert.equal(candidateEmailDeliveryDecision({
    workerEmail: "candidate@example.com", channelPreference: "whatsapp", candidateEmailAuthorizedAt: new Date(),
  }).allowed, false);
  assert.match(candidateEmailDeliveryDecision({
    workerEmail: "candidate@example.com", channelPreference: "whatsapp", candidateEmailAuthorizedAt: new Date(),
  }).reason ?? "", /logged, not delivered/);
});