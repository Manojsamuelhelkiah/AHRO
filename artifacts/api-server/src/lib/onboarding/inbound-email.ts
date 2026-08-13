import { db } from "@workspace/db";
import { onbCases, onbCommunications } from "@workspace/db/schema";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { desc, eq, sql } from "drizzle-orm";
import { handleInbound } from "./engine";

/**
 * Gmail inbox polling — closes the loop on real email replies.
 *
 * Every POLL_INTERVAL_MS the poller searches the connected Gmail inbox for
 * recent messages from the email addresses of active onboarding cases,
 * records each new message on the case timeline (deduplicated by the Gmail
 * message id) and routes it through the same handleInbound pipeline used by
 * simulated messages, so auto-replies and sensitive-topic escalation apply
 * to real inbound mail.
 */

const connectors = new ReplitConnectors();

const POLL_INTERVAL_MS = 60_000;
const SEARCH_WINDOW = "newer_than:2d";

let timer: NodeJS.Timeout | null = null;
let polling = false;

type GmailHeader = { name: string; value: string };
type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
  id: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
};

function header(msg: GmailMessage, name: string): string {
  return (
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function extractAddress(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

function findPlainText(part: GmailPart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = findPlainText(child);
    if (found) return found;
  }
  // Fallback: some simple messages put data on the root payload without a mimeType match.
  if (part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  return null;
}

/** Strip quoted reply history so the agent only sees the new content. */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .{0,200}wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (line.trimStart().startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export async function alreadyRecorded(externalMessageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: onbCommunications.id })
    .from(onbCommunications)
    .where(eq(onbCommunications.externalMessageId, externalMessageId));
  return Boolean(row);
}

export type InboundMessage = {
  caseId: number;
  channel: "email" | "whatsapp";
  fromAddress: string;
  subject: string | null;
  body: string;
  externalMessageId: string;
};

/**
 * Persist an inbound message on the case timeline. Returns false when the
 * provider message id was already recorded (duplicate delivery, webhook
 * retry, or one of our own outbound messages echoing back).
 */
export async function persistInbound(opts: InboundMessage): Promise<boolean> {
  const rows = await db
    .insert(onbCommunications)
    .values({
      caseId: opts.caseId,
      channel: opts.channel,
      direction: "inbound",
      toAddress: opts.fromAddress,
      subject: opts.subject,
      body: opts.body,
      status: "received",
      sensitive: false,
      externalMessageId: opts.externalMessageId,
    })
    .onConflictDoNothing({ target: onbCommunications.externalMessageId })
    .returning({ id: onbCommunications.id });
  return rows.length > 0;
}

/** Record an inbound message and route it to the agent. Dedup-safe. */
export async function recordInbound(opts: InboundMessage): Promise<boolean> {
  const recorded = await persistInbound(opts);
  if (!recorded) return false;
  handleInbound(opts.caseId, opts.channel, opts.body);
  return true;
}

async function pollOnce(): Promise<void> {
  // Active cases only; map each email to its most recent active case.
  const cases = await db
    .select({ id: onbCases.id, workerEmail: onbCases.workerEmail })
    .from(onbCases)
    .where(sql`${onbCases.lifecycleStage} not in ('complete')`)
    .orderBy(desc(onbCases.id));
  if (cases.length === 0) return;

  const caseByEmail = new Map<string, number>();
  for (const c of cases) {
    const email = c.workerEmail.trim().toLowerCase();
    if (!caseByEmail.has(email)) caseByEmail.set(email, c.id);
  }

  const fromClause = Array.from(caseByEmail.keys())
    .map((e) => `from:${e}`)
    .join(" OR ");
  const q = `in:inbox ${SEARCH_WINDOW} (${fromClause})`;

  const listResp = await connectors.proxy(
    "google-mail",
    `/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=25`,
    { method: "GET" },
  );
  if (!listResp.ok) {
    throw new Error(`Gmail search failed: ${listResp.status} ${(await listResp.text()).slice(0, 200)}`);
  }
  const list = (await listResp.json()) as { messages?: Array<{ id: string }> };
  for (const ref of list.messages ?? []) {
    if (await alreadyRecorded(ref.id)) continue;

    const msgResp = await connectors.proxy(
      "google-mail",
      `/gmail/v1/users/me/messages/${ref.id}?format=full`,
      { method: "GET" },
    );
    if (!msgResp.ok) continue;
    const msg = (await msgResp.json()) as GmailMessage;

    const fromAddress = extractAddress(header(msg, "From"));
    const caseId = caseByEmail.get(fromAddress);
    if (!caseId) continue;

    const raw = findPlainText(msg.payload) ?? "";
    const body = stripQuotedReply(raw);
    if (!body) continue;

    const recorded = await recordInbound({
      caseId,
      channel: "email",
      fromAddress,
      subject: header(msg, "Subject") || null,
      body: body.slice(0, 4000),
      externalMessageId: msg.id,
    });
    if (recorded) {
      console.log(
        `[onboarding inbound-email] new reply from ${fromAddress} routed to case ${caseId} (gmail ${msg.id})`,
      );
    }
  }
}

export function startInboundEmailPolling(): void {
  if (timer) return;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      await pollOnce();
    } catch (err) {
      console.error("[onboarding inbound-email] poll failed:", String(err).slice(0, 300));
    } finally {
      polling = false;
    }
  };
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  void tick();
  console.log(`[onboarding inbound-email] Gmail inbox polling started (every ${POLL_INTERVAL_MS / 1000}s)`);
}
