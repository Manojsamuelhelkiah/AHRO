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
  candidateEmailFailureFeedback,
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

test("welcome: WhatsApp selection adds WhatsApp without duplicating default email", () => {
  const r = resolveWelcomeChannels("whatsapp", "+15550001111");
  assert.deepEqual(r.channels, ["email", "whatsapp"]);
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

test("reply: WhatsApp selection does not redirect an email reply to WhatsApp", () => {
  const r = resolveReplyChannel("whatsapp", "+15550001111", "a@b.com", "email");
  assert.equal(r.channel, "email");
  assert.equal(r.to, "a@b.com");
  assert.equal(resolveReplyChannel("whatsapp", "+15550001111", "a@b.com", "whatsapp").channel, "whatsapp");
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

test("all intake sources and channel preferences use deliverable candidate email", () => {
  assert.equal(shouldAuthorizeCandidateEmail(" Candidate@MailHost.com ", "email"), true);
  assert.equal(shouldAuthorizeCandidateEmail("candidate@mailhost.com", "both"), true);
  assert.equal(shouldAuthorizeCandidateEmail("candidate@mailhost.com", "whatsapp"), true);
  assert.equal(shouldAuthorizeCandidateEmail("not-an-email", "email"), false);
});

test("candidate email delivery is case-scoped and always resolves the stored record address", () => {
  const authorizedAt = new Date();
  assert.deepEqual(
    candidateEmailDeliveryDecision({
      workerEmail: " Current.Candidate@MailHost.com ",
      channelPreference: "email",
      candidateEmailAuthorizedAt: authorizedAt,
    }),
    { allowed: true, address: "current.candidate@mailhost.com", reason: null },
  );
  const seeded = candidateEmailDeliveryDecision({
    workerEmail: "seed@mailhost.com",
    channelPreference: "both",
    candidateEmailAuthorizedAt: null,
  });
  assert.equal(seeded.allowed, true);
  assert.equal(seeded.reason, null);
  assert.equal(candidateEmailDeliveryDecision({
    workerEmail: "candidate@mailhost.com",
    channelPreference: "whatsapp",
    candidateEmailAuthorizedAt: authorizedAt,
  }).allowed, true);
});

test("only definitive failed/logged-only outbound email can be manually retried", () => {
  for (const status of ["failed", "logged-only", "blocked"]) {
    assert.equal(isRetryableCandidateEmail({ channel: "email", direction: "outbound", status }), true);
  }
  for (const status of ["sent", "delivered", "sending", "received"]) {
    assert.equal(isRetryableCandidateEmail({ channel: "email", direction: "outbound", status }), false);
  }
  assert.equal(isRetryableCandidateEmail({ channel: "whatsapp", direction: "outbound", status: "failed" }), false);
  assert.equal(isRetryableCandidateEmail({ channel: "email", direction: "inbound", status: "failed" }), false);
  assert.equal(isRetryableCandidateEmail({ channel: "email", direction: "outbound", audience: "admin", status: "failed" }), false);
});

test("legacy allowlists cannot override address rejection and are not prerequisites", () => {
  for (const channelPreference of ["email", "both", "whatsapp"]) {
    assert.equal(candidateEmailMaySend({ channelPreference, caseAuthorized: true, explicitlyAllowlisted: false, validEmail: true }), true);
    assert.equal(candidateEmailMaySend({ channelPreference, caseAuthorized: false, explicitlyAllowlisted: true, validEmail: true }), false);
  }
});

test("missing, malformed and reserved placeholders are accurately rejected", () => {
  for (const workerEmail of ["", "  ", "bad-email", "a@hro.invalid", "a@test.example", "a@example.com", "a@sub.example.org", "a@localhost", "a@mail.test", "a@mail.invalid.", "a@-host.com", ".a@mail.com", "a..b@mail.com"]) {
    const decision = candidateEmailDeliveryDecision({ workerEmail });
    assert.equal(decision.allowed, false, workerEmail);
    assert.ok(decision.reason);
  }
});

test("legacy definitive blocks explain current eligibility without obscuring provider failures or uncertainty", () => {
  const legacy = "Candidate email is not authorized for live delivery on this case — message logged, not delivered.";
  assert.match(candidateEmailFailureFeedback("a@mailhost.com", legacy, "logged-only")!, /not been resent automatically/);
  assert.equal(candidateEmailFailureFeedback("a@mailhost.com", legacy, "sending"), legacy);
  assert.equal(candidateEmailFailureFeedback("a@example.com", legacy, "logged-only"), legacy);
  assert.equal(candidateEmailFailureFeedback("a@mailhost.com", "Gmail 500: provider unavailable", "failed"), "Gmail 500: provider unavailable");
});

test("historical HR approval and Settings test subjects are never candidate-retryable", () => {
  const base = { channel: "email", direction: "outbound", audience: "candidate", status: "failed" };
  assert.equal(isRetryableCandidateEmail({ ...base, subject: "[AP-42] Approval needed — Example" }), false);
  assert.equal(isRetryableCandidateEmail({ ...base, subject: "Onboarding channel test" }), false);
  assert.equal(isRetryableCandidateEmail({ ...base, subject: "Welcome, Sam — your onboarding has started" }), true);
});
