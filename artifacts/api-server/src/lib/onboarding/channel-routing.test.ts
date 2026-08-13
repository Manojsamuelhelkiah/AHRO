import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePreference,
  resolveReplyChannel,
  resolveWelcomeChannels,
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
