import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePreference,
  resolveReplyChannel,
  resolveWelcomeChannels,
  shouldAuthorizeCandidateEmail,
  candidateEmailDeliveryDecision,
  candidateEmailMaySend,
  isRetryableCandidateEmail,
} from "./channel-routing";

test("normalizePreference defaults unknown/missing values to both", () => {
  assert.equal(normalizePreference("email"), "email");
  assert.equal(normalizePreference("whatsapp"), "whatsapp");
  assert.equal(normalizePreference("both"), "both");
  assert.equal(normalizePreference(null), "both");
  assert.equal(normalizePreference(undefined), "both");
  assert.equal(normalizePreference("carrier-pigeon"), "both");
});

test("welcome: email-only preference sends email only, even with a phone", () => {
  const r = resolveWelcomeChannels("email", "+15550001111");
  assert.deepEqual(r.channels, ["email"]);
  assert.equal(r.whatsappSkipped, false);
  assert.equal(r.emailIsFallback, false);
});

test("welcome: whatsapp-only preference with a phone sends whatsapp only", () => {
  const r = resolveWelcomeChannels("whatsapp", "+15550001111");
  assert.deepEqual(r.channels, ["whatsapp"]);
  assert.equal(r.whatsappSkipped, false);
});

test("welcome: both preference with a phone sends on both channels", () => {
  const r = resolveWelcomeChannels("both", "+15550001111");
  assert.deepEqual(r.channels, ["email", "whatsapp"]);
});

test("welcome: whatsapp-only preference without a phone falls back to email", () => {
  const r = resolveWelcomeChannels("whatsapp", null);
  assert.deepEqual(r.channels, ["email"]);
  assert.equal(r.whatsappSkipped, true);
  assert.equal(r.emailIsFallback, true);
});

test("welcome: both preference without a phone sends email and flags the skip", () => {
  const r = resolveWelcomeChannels("both", null);
  assert.deepEqual(r.channels, ["email"]);
  assert.equal(r.whatsappSkipped, true);
  assert.equal(r.emailIsFallback, false);
});

test("reply: email preference always replies via email", () => {
  const r = resolveReplyChannel("email", "+15550001111", "a@b.com", "whatsapp");
  assert.equal(r.channel, "email");
  assert.equal(r.to, "a@b.com");
});

test("reply: whatsapp preference with a phone replies via whatsapp", () => {
  const r = resolveReplyChannel("whatsapp", "+15550001111", "a@b.com", "email");
  assert.equal(r.channel, "whatsapp");
  assert.equal(r.to, "+15550001111");
});

test("reply: both preference mirrors the inbound channel", () => {
  assert.equal(resolveReplyChannel("both", "+1555", "a@b.com", "whatsapp").channel, "whatsapp");
  assert.equal(resolveReplyChannel("both", "+1555", "a@b.com", "email").channel, "email");
});

test("reply: whatsapp preference without a phone falls back to email", () => {
  const r = resolveReplyChannel("whatsapp", null, "a@b.com", "whatsapp");
  assert.equal(r.channel, "email");
  assert.equal(r.to, "a@b.com");
});

test("manual intake authorizes valid candidate email only for email-capable preferences", () => {
  assert.equal(shouldAuthorizeCandidateEmail(" Candidate@Example.com ", "email"), true);
  assert.equal(shouldAuthorizeCandidateEmail("candidate@example.com", "both"), true);
  assert.equal(shouldAuthorizeCandidateEmail("candidate@example.com", "whatsapp"), false);
  assert.equal(shouldAuthorizeCandidateEmail("not-an-email", "email"), false);
});

test("candidate email delivery is case-scoped and always resolves the stored record address", () => {
  const authorizedAt = new Date();
  assert.deepEqual(
    candidateEmailDeliveryDecision({
      workerEmail: " Current.Candidate@Example.com ",
      channelPreference: "email",
      candidateEmailAuthorizedAt: authorizedAt,
    }),
    { allowed: true, address: "current.candidate@example.com", reason: null },
  );
  const seeded = candidateEmailDeliveryDecision({
    workerEmail: "seed@example.com",
    channelPreference: "both",
    candidateEmailAuthorizedAt: null,
  });
  assert.equal(seeded.allowed, false);
  assert.match(seeded.reason!, /not authorized/i);
  assert.equal(candidateEmailDeliveryDecision({
    workerEmail: "candidate@example.com",
    channelPreference: "whatsapp",
    candidateEmailAuthorizedAt: authorizedAt,
  }).allowed, false);
});

test("only definitive failed/logged-only outbound email can be manually retried", () => {
  for (const status of ["failed", "logged-only"]) {
    assert.equal(isRetryableCandidateEmail({ channel: "email", direction: "outbound", status }), true);
  }
  for (const status of ["sent", "delivered", "sending", "received"]) {
    assert.equal(isRetryableCandidateEmail({ channel: "email", direction: "outbound", status }), false);
  }
  assert.equal(isRetryableCandidateEmail({ channel: "whatsapp", direction: "outbound", status: "failed" }), false);
  assert.equal(isRetryableCandidateEmail({ channel: "email", direction: "inbound", status: "failed" }), false);
  assert.equal(isRetryableCandidateEmail({ channel: "email", direction: "outbound", audience: "admin", status: "failed" }), false);
});

test("an explicit legacy allowlist can deliver only a valid email/both candidate case", () => {
  assert.equal(candidateEmailMaySend({ channelPreference: "email", caseAuthorized: false, explicitlyAllowlisted: true, validEmail: true }), true);
  assert.equal(candidateEmailMaySend({ channelPreference: "both", caseAuthorized: false, explicitlyAllowlisted: true, validEmail: true }), true);
  assert.equal(candidateEmailMaySend({ channelPreference: "whatsapp", caseAuthorized: false, explicitlyAllowlisted: true, validEmail: true }), false);
  assert.equal(candidateEmailMaySend({ channelPreference: "email", caseAuthorized: false, explicitlyAllowlisted: false, validEmail: true }), false);
  assert.equal(candidateEmailMaySend({ channelPreference: "email", caseAuthorized: false, explicitlyAllowlisted: true, validEmail: false }), false);
});

test("historical HR approval and Settings test subjects are never candidate-retryable", () => {
  const base = { channel: "email", direction: "outbound", audience: "candidate", status: "failed" };
  assert.equal(isRetryableCandidateEmail({ ...base, subject: "[AP-42] Approval needed — Example" }), false);
  assert.equal(isRetryableCandidateEmail({ ...base, subject: "Onboarding channel test" }), false);
  assert.equal(isRetryableCandidateEmail({ ...base, subject: "Welcome, Sam — your onboarding has started" }), true);
});
