/**
 * Twilio's WhatsApp sandbox drops a hire's session after 72 hours without an
 * inbound message from them — outbound sends then silently queue or fail.
 * Pure helpers so the case-detail warning logic is unit-testable.
 */

export const SANDBOX_SESSION_MS = 72 * 60 * 60 * 1000;

export type CommLike = {
  id: number;
  channel: string;
  direction: string;
  createdAt: string;
};

/** The most recent inbound WhatsApp message from the hire, if any. */
export function latestInboundWhatsApp(comms: CommLike[] | undefined): CommLike | null {
  if (!comms) return null;
  let latest: CommLike | null = null;
  for (const m of comms) {
    if (m.channel !== "whatsapp" || m.direction !== "inbound") continue;
    if (!latest || new Date(m.createdAt).getTime() > new Date(latest.createdAt).getTime()) {
      latest = m;
    }
  }
  return latest;
}

/**
 * True when the case uses WhatsApp and the hire's sandbox session has likely
 * expired: no inbound WhatsApp message at all, or the latest one is older
 * than 72 hours. Returns false while communications are still loading
 * (comms === undefined) to avoid a false-positive flash.
 */
export function sandboxSessionExpired(opts: {
  channelPreference?: string;
  comms?: CommLike[];
  now?: number;
}): boolean {
  const usesWhatsApp =
    opts.channelPreference === "whatsapp" || opts.channelPreference === "both";
  if (!usesWhatsApp || opts.comms === undefined) return false;
  const lastInbound = latestInboundWhatsApp(opts.comms);
  if (!lastInbound) return true;
  const now = opts.now ?? Date.now();
  return now - new Date(lastInbound.createdAt).getTime() > SANDBOX_SESSION_MS;
}

/**
 * localStorage key for the per-case dismissal. Keyed by the latest inbound
 * WhatsApp message id so the warning reappears if the session goes stale
 * again after the hire re-joins (a newer inbound changes the key).
 */
export function sandboxDismissKey(caseId: number, lastInboundId: number | null): string {
  return `wa-sandbox-warning-dismissed:${caseId}:${lastInboundId ?? "none"}`;
}

/**
 * The re-join instruction shown to HR. Uses the server-provided sandbox
 * sender number and join keyword when configured, with safe fallbacks.
 */
export function sandboxJoinInstruction(sandbox?: {
  sandboxNumber?: string | null;
  sandboxJoinKeyword?: string | null;
}): { joinText: string; number: string; keywordKnown: boolean } {
  const keyword = sandbox?.sandboxJoinKeyword?.trim() || null;
  const number = sandbox?.sandboxNumber?.trim() || "+1 415 523 8886";
  return {
    joinText: keyword ? `join ${keyword}` : "join <your sandbox keyword>",
    number,
    keywordKnown: Boolean(keyword),
  };
}
