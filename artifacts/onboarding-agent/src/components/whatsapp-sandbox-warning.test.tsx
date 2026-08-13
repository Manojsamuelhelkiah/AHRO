import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WhatsAppSandboxWarning } from "./whatsapp-sandbox-warning";
import {
  sandboxSessionExpired,
  sandboxDismissKey,
  latestInboundWhatsApp,
  sandboxJoinInstruction,
  SANDBOX_SESSION_MS,
  type CommLike,
} from "../lib/sandbox-session";

// The component itself uses the real clock, so anchor test times to it too.
const NOW = Date.now();

function comm(partial: Partial<CommLike> & { id: number }): CommLike {
  return {
    channel: "whatsapp",
    direction: "inbound",
    createdAt: new Date(NOW - 1000).toISOString(),
    ...partial,
  };
}

function render(props: React.ComponentProps<typeof WhatsAppSandboxWarning>): string {
  return renderToStaticMarkup(<WhatsAppSandboxWarning {...props} />);
}

/* ------------------------- expiry evaluation ------------------------- */

test("email-only cases never warn, even with no inbound WhatsApp", () => {
  assert.equal(sandboxSessionExpired({ channelPreference: "email", comms: [], now: NOW }), false);
  assert.equal(render({ caseId: 1, channelPreference: "email", comms: [] }), "");
});

test("whatsapp case with no inbound message at all warns", () => {
  assert.equal(sandboxSessionExpired({ channelPreference: "whatsapp", comms: [], now: NOW }), true);
  const html = render({ caseId: 1, channelPreference: "whatsapp", comms: [] });
  assert.match(html, /sandbox session may be expired/);
  assert.match(html, /No inbound WhatsApp message/);
});

test("'both' preference is treated as using WhatsApp", () => {
  assert.equal(sandboxSessionExpired({ channelPreference: "both", comms: [], now: NOW }), true);
  assert.match(render({ caseId: 1, channelPreference: "both", comms: [] }), /sandbox session may be expired/);
});

test("fresh inbound WhatsApp (< 72h) suppresses the warning", () => {
  const comms = [comm({ id: 1, createdAt: new Date(NOW - SANDBOX_SESSION_MS + 60_000).toISOString() })];
  assert.equal(sandboxSessionExpired({ channelPreference: "whatsapp", comms, now: NOW }), false);
  assert.equal(render({ caseId: 1, channelPreference: "whatsapp", comms }), "");
});

test("stale inbound WhatsApp (> 72h) warns and mentions the last-contact time", () => {
  const comms = [comm({ id: 1, createdAt: new Date(NOW - SANDBOX_SESSION_MS - 3600_000).toISOString() })];
  assert.equal(sandboxSessionExpired({ channelPreference: "whatsapp", comms, now: NOW }), true);
  const html = render({ caseId: 1, channelPreference: "whatsapp", comms });
  assert.match(html, /more than 72 hours ago/);
});

test("only inbound whatsapp messages count — outbound and email are ignored", () => {
  const comms = [
    comm({ id: 1, direction: "outbound", createdAt: new Date(NOW - 1000).toISOString() }),
    comm({ id: 2, channel: "email", createdAt: new Date(NOW - 1000).toISOString() }),
  ];
  assert.equal(latestInboundWhatsApp(comms), null);
  assert.equal(sandboxSessionExpired({ channelPreference: "whatsapp", comms, now: NOW }), true);
});

test("no warning while communications are still loading (undefined)", () => {
  assert.equal(sandboxSessionExpired({ channelPreference: "whatsapp", comms: undefined, now: NOW }), false);
  assert.equal(render({ caseId: 1, channelPreference: "whatsapp", comms: undefined }), "");
});

/* --------------------------- join instruction ------------------------ */

test("renders the configured join keyword and sandbox number", () => {
  const html = render({
    caseId: 1,
    channelPreference: "whatsapp",
    comms: [],
    sandbox: { sandboxNumber: "+14155238886", sandboxJoinKeyword: "brave-tiger" },
  });
  assert.match(html, /join brave-tiger/);
  assert.match(html, /\+14155238886/);
  assert.doesNotMatch(html, /Twilio Console/); // no fallback hint when keyword is known
});

test("falls back to a placeholder + console hint when keyword is not configured", () => {
  const html = render({ caseId: 1, channelPreference: "whatsapp", comms: [], sandbox: { sandboxNumber: null, sandboxJoinKeyword: null } });
  assert.match(html, /join &lt;your sandbox keyword&gt;/);
  assert.match(html, /Twilio Console/);
  assert.match(html, /\+1 415 523 8886/); // default public sandbox number
  const instr = sandboxJoinInstruction({ sandboxJoinKeyword: "  " });
  assert.equal(instr.keywordKnown, false);
});

/* ----------------------- per-case dismissal keys ---------------------- */

test("dismiss key is per case and per latest inbound message", () => {
  assert.notEqual(sandboxDismissKey(1, null), sandboxDismissKey(2, null));
  // A newer inbound message changes the key, so a prior dismissal no longer
  // applies once the session goes stale again after a re-join.
  assert.notEqual(sandboxDismissKey(1, 10), sandboxDismissKey(1, 42));
  assert.equal(sandboxDismissKey(1, null), "wa-sandbox-warning-dismissed:1:none");
});

test("a stored dismissal hides the warning; a newer inbound id re-shows it", () => {
  // Minimal localStorage stub for the node test environment.
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  };
  try {
    const staleAt = new Date(NOW - SANDBOX_SESSION_MS - 3600_000).toISOString();
    const comms = [comm({ id: 7, createdAt: staleAt })];
    // Dismissed for latest inbound id 7 → hidden.
    store.set(sandboxDismissKey(3, 7), "1");
    assert.equal(render({ caseId: 3, channelPreference: "whatsapp", comms }), "");
    // Hire re-joined (id 8, later than id 7), then went stale again → warning returns.
    const comms2 = [...comms, comm({ id: 8, createdAt: new Date(new Date(staleAt).getTime() + 60_000).toISOString() })];
    assert.match(render({ caseId: 3, channelPreference: "whatsapp", comms: comms2 }), /sandbox session may be expired/);
    // Different case is unaffected by case 3's dismissal.
    assert.match(render({ caseId: 4, channelPreference: "whatsapp", comms }), /sandbox session may be expired/);
  } finally {
    delete (globalThis as any).localStorage;
  }
});
