import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockedPublishBackupCard } from "./systems";

function render(
  readiness: React.ComponentProps<typeof BlockedPublishBackupCard>["readiness"],
): string {
  return renderToStaticMarkup(<BlockedPublishBackupCard readiness={readiness} />);
}

test("shows ready backup-alert readiness with masked destination and sender", () => {
  const html = render({
    ready: true,
    destination: "+447•••42",
    sender: "+141•••86",
    missing: [],
    invalid: [],
    note: "Backup WhatsApp alerts are ready if Gmail rejects a blocked-release alert.",
  });

  assert.match(html, />READY</);
  assert.match(html, /\+447•••42/);
  assert.match(html, /\+141•••86/);
  assert.match(html, /Readiness only — this check does not send an alert\./);
  assert.doesNotMatch(html, /Missing configuration/);
  assert.doesNotMatch(html, /<button/);
});

test("shows incomplete backup-alert readiness, every missing category, and no send control", () => {
  const html = render({
    ready: false,
    destination: null,
    sender: null,
    missing: [
      "Backup WhatsApp destination",
      "Twilio account configuration",
      "Twilio WhatsApp sender",
    ],
    invalid: [],
    note: "Configuration needed: Backup WhatsApp destination, Twilio account configuration, Twilio WhatsApp sender.",
  });

  assert.match(html, /NEEDS ATTENTION/);
  assert.match(html, /Missing configuration/);
  assert.match(html, /Backup WhatsApp destination/);
  assert.match(html, /Twilio account configuration/);
  assert.match(html, /Twilio WhatsApp sender/);
  assert.match(html, /Not configured/);
  assert.match(html, /Readiness only — this check does not send an alert\./);
  assert.doesNotMatch(html, /<button/);
});

test("shows actionable guidance for malformed masked phone values", () => {
  const html = render({
    ready: false,
    destination: "555-•••67",
    sender: "+012•••90",
    missing: [],
    invalid: [
      "Backup WhatsApp destination",
      "Twilio WhatsApp sender",
    ],
    note: "Fix Backup WhatsApp destination and Twilio WhatsApp sender to use E.164 format (for example, +15551234567).",
  });

  assert.match(html, /NEEDS ATTENTION/);
  assert.match(html, /E\.164 format/);
  assert.match(html, /555-•••67/);
  assert.match(html, /\+012•••90/);
  assert.doesNotMatch(html, /555-123-4567|01234567890/);
  assert.match(html, /Readiness only — this check does not send an alert\./);
  assert.doesNotMatch(html, /<button/);
});