import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockedPublishBackupReadiness,
  explicitlyAllowlistedCandidateAddress,
  gmailAmbiguousFailure,
  gmailHttpFailure,
  systemEmailTestAddress,
  twilioAmbiguousFailure,
  twilioHttpFailure,
} from "./channels";

const BACKUP_ENV_KEYS = [
  "ONBOARDING_BLOCKED_PUBLISH_BACKUP_REQUIRED",
  "ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
] as const;

function withBackupEnvironment(
  values: Partial<Record<(typeof BACKUP_ENV_KEYS)[number], string>>,
  run: () => void,
) {
  const previous = Object.fromEntries(BACKUP_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of BACKUP_ENV_KEYS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    run();
  } finally {
    for (const key of BACKUP_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

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

test("Twilio distinguishes definite HTTP rejection from ambiguous transport failure", () => {
  assert.equal(twilioHttpFailure(503, "provider rejected").status, "failed");
  const ambiguous = twilioAmbiguousFailure(new Error("connection reset"));
  assert.equal(ambiguous.status, "sending");
  assert.match(ambiguous.failureReason, /do not retry automatically/i);
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

test("blocked-publish backup readiness masks phone values and never exposes credentials", () => {
  withBackupEnvironment({
    ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP: "whatsapp:+15551234567",
    TWILIO_ACCOUNT_SID: "AC-private-account",
    TWILIO_AUTH_TOKEN: "private-auth-token",
    TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886",
  }, () => {
    const status = blockedPublishBackupReadiness();
    assert.deepEqual(status, {
      ready: true,
      required: true,
      destination: "+155•••67",
      sender: "+141•••86",
      missing: [],
      invalid: [],
      note: "Backup WhatsApp alerts are ready if Gmail rejects a blocked-release alert.",
    });
    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /AC-private-account|private-auth-token|15551234567|14155238886/);
  });
});

test("blocked-publish backup readiness names only missing setting categories", () => {
  withBackupEnvironment({
    ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP: "+15551234567",
  }, () => {
    const status = blockedPublishBackupReadiness();
    assert.equal(status.ready, false);
    assert.equal(status.required, true);
    assert.deepEqual(status.missing, [
      "Twilio account configuration",
      "Twilio WhatsApp sender",
    ]);
    assert.equal(status.destination, "+155•••67");
    assert.equal(status.sender, null);
    assert.deepEqual(status.invalid, []);
    assert.doesNotMatch(status.note, /SID|token|credential/i);
  });
});

test("blocked-publish backup readiness reports an intentional opt-out", () => {
  withBackupEnvironment({
    ONBOARDING_BLOCKED_PUBLISH_BACKUP_REQUIRED: "false",
  }, () => {
    const status = blockedPublishBackupReadiness();
    assert.equal(status.ready, true);
    assert.equal(status.required, false);
    assert.deepEqual(status.missing, []);
    assert.deepEqual(status.invalid, []);
    assert.match(status.note, /optional in this environment/i);
  });
});

test("blocked-publish backup readiness rejects malformed phone formats without sending", () => {
  withBackupEnvironment({
    ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP: "whatsapp:555-123-4567",
    TWILIO_ACCOUNT_SID: "AC-private-account",
    TWILIO_AUTH_TOKEN: "private-auth-token",
    TWILIO_WHATSAPP_FROM: "whatsapp:+01234567890",
  }, () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("readiness must not contact Twilio");
    }) as typeof fetch;
    try {
      const status = blockedPublishBackupReadiness();
      assert.equal(status.ready, false);
      assert.equal(status.required, true);
      assert.deepEqual(status.missing, []);
      assert.deepEqual(status.invalid, [
        "Backup WhatsApp destination",
        "Twilio WhatsApp sender",
      ]);
      assert.equal(status.destination, "555-•••67");
      assert.equal(status.sender, "+012•••90");
      assert.match(status.note, /E\.164 format/);
      assert.equal(fetchCalls, 0);
      const serialized = JSON.stringify(status);
      assert.doesNotMatch(serialized, /555-123-4567|01234567890|AC-private-account|private-auth-token/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});