import { test } from "node:test";
import assert from "node:assert/strict";
import { explicitlyAllowlistedCandidateAddress, gmailAmbiguousFailure, gmailHttpFailure, systemEmailTestAddress } from "./channels";

test("Gmail HTTP rejection is definitive failed with the provider reason", () => {
  const result = gmailHttpFailure(403, "recipient rejected");
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "Gmail 403: recipient rejected");
});

test("Gmail transport exception remains ambiguous sending and is not auto-retryable", () => {
  const result = gmailAmbiguousFailure(new Error("connection reset"));
  assert.equal(result.status, "sending");
  assert.match(result.failureReason, /outcome unknown/i);
  assert.match(result.failureReason, /do not retry automatically/i);
});

test("channel Settings test path requires a separate explicitly allowlisted system address", () => {
  const oldTest = process.env.ONBOARDING_CHANNEL_TEST_EMAIL;
  const oldAllowed = process.env.ONBOARDING_ALLOWED_RECIPIENTS;
  try {
    process.env.ONBOARDING_CHANNEL_TEST_EMAIL = "system-test@example.com";
    process.env.ONBOARDING_ALLOWED_RECIPIENTS = "different@example.com";
    assert.equal(systemEmailTestAddress(), null);
    process.env.ONBOARDING_ALLOWED_RECIPIENTS = "different@example.com, system-test@example.com";
    assert.equal(systemEmailTestAddress(), "system-test@example.com");
  } finally {
    if (oldTest === undefined) delete process.env.ONBOARDING_CHANNEL_TEST_EMAIL;
    else process.env.ONBOARDING_CHANNEL_TEST_EMAIL = oldTest;
    if (oldAllowed === undefined) delete process.env.ONBOARDING_ALLOWED_RECIPIENTS;
    else process.env.ONBOARDING_ALLOWED_RECIPIENTS = oldAllowed;
  }
});

test("candidate legacy fallback honors only explicit environment authorization", () => {
  const oldAllowed = process.env.ONBOARDING_ALLOWED_RECIPIENTS;
  try {
    delete process.env.ONBOARDING_ALLOWED_RECIPIENTS;
    // The old module default is deliberately not an automatic seed authorization.
    assert.equal(explicitlyAllowlistedCandidateAddress("helkiah@gmail.com"), false);
    process.env.ONBOARDING_ALLOWED_RECIPIENTS = "Subash@example.com";
    assert.equal(explicitlyAllowlistedCandidateAddress("subash@example.com"), true);
  } finally {
    if (oldAllowed === undefined) delete process.env.ONBOARDING_ALLOWED_RECIPIENTS;
    else process.env.ONBOARDING_ALLOWED_RECIPIENTS = oldAllowed;
  }
});