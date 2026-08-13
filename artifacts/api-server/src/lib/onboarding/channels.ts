import { db } from "@workspace/db";
import { onbCommunications } from "@workspace/db/schema";
import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();

export type ChannelInfo = {
  configured: boolean;
  provider: string;
  target: string;
  note: string;
};

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

function maskPhone(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 4)}•••${phone.slice(-2)}` : "•••";
}

export function emailChannelInfo(): ChannelInfo {
  return {
    configured: true,
    provider: "gmail",
    target: "He***@gmail.com",
    note: "Outbound email is live via the connected Gmail account.",
  };
}

export function whatsappChannelInfo(): ChannelInfo {
  const configured = Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_FROM,
  );
  return {
    configured,
    provider: configured ? "twilio" : "logged-only",
    target: "workerPhone on each case",
    note: configured
      ? "Outbound WhatsApp is live via Twilio."
      : "Twilio WhatsApp not connected yet — messages are composed and logged in the case timeline, not delivered.",
  };
}

async function sendEmail(
  to: string,
  subject: string,
  body: string,
): Promise<{ status: string; failureReason: string | null; externalMessageId: string | null }> {
  try {
    const rfc2822 = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      body,
    ].join("\r\n");
    const raw = Buffer.from(rfc2822).toString("base64url");
    const resp = await connectors.proxy(
      "google-mail",
      "/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      },
    );
    if (!resp.ok) {
      const detail = await resp.text();
      return { status: "failed", failureReason: `Gmail ${resp.status}: ${detail.slice(0, 300)}`, externalMessageId: null };
    }
    // Store the Gmail message id so the inbound poller can recognise (and
    // skip) our own outbound messages when the demo recipient is the same
    // Gmail account — otherwise self-sent mail would echo back as "inbound".
    const sent = (await resp.json().catch(() => null)) as { id?: string } | null;
    return { status: "sent", failureReason: null, externalMessageId: sent?.id ?? null };
  } catch (err) {
    return { status: "failed", failureReason: String(err).slice(0, 300), externalMessageId: null };
  }
}

async function sendWhatsApp(
  toPhone: string,
  body: string,
): Promise<{ status: string; failureReason: string | null; externalMessageId: string | null }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) {
    return { status: "logged-only", failureReason: null, externalMessageId: null };
  }
  try {
    const params = new URLSearchParams({
      From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
      To: toPhone.startsWith("whatsapp:") ? toPhone : `whatsapp:${toPhone}`,
      Body: body,
    });
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
    );
    if (!resp.ok) {
      const detail = await resp.text();
      return { status: "failed", failureReason: `Twilio ${resp.status}: ${detail.slice(0, 300)}`, externalMessageId: null };
    }
    const sent = (await resp.json().catch(() => null)) as { sid?: string } | null;
    return { status: "sent", failureReason: null, externalMessageId: sent?.sid ?? null };
  } catch (err) {
    return { status: "failed", failureReason: String(err).slice(0, 300), externalMessageId: null };
  }
}

/* ------------------------------------------------------------------ */
/* Abuse controls for live delivery                                     */
/*                                                                      */
/* The POC API is not behind a login yet, so live sends are restricted  */
/* server-side: only allow-listed recipients receive real messages      */
/* (everything else is composed and logged only), and total live sends  */
/* are rate-limited per hour. Set ONBOARDING_ALLOWED_RECIPIENTS to a    */
/* comma-separated list of emails/phone numbers to change the list.     */
/* ------------------------------------------------------------------ */

const DEFAULT_ALLOWED_RECIPIENTS = ["helkiah@gmail.com"];
const MAX_LIVE_SENDS_PER_HOUR = 30;
let sendWindowStart = Date.now();
let sendWindowCount = 0;

function recipientAllowed(address: string): boolean {
  const configured = (process.env.ONBOARDING_ALLOWED_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowed = configured.length > 0 ? configured : DEFAULT_ALLOWED_RECIPIENTS;
  const normalized = address.trim().toLowerCase().replace(/^whatsapp:/, "");
  return allowed.includes(normalized);
}

function withinRateLimit(): boolean {
  const now = Date.now();
  if (now - sendWindowStart > 3600_000) {
    sendWindowStart = now;
    sendWindowCount = 0;
  }
  if (sendWindowCount >= MAX_LIVE_SENDS_PER_HOUR) return false;
  sendWindowCount += 1;
  return true;
}

/**
 * Send an outbound message on a channel and persist it to the case timeline.
 * Never throws — delivery failures are recorded on the communication row.
 */
export async function sendOutbound(opts: {
  caseId: number;
  channel: "email" | "whatsapp";
  toAddress: string;
  subject?: string | null;
  body: string;
  sensitive?: boolean;
}): Promise<{ id: number; status: string; failureReason: string | null }> {
  let result: { status: string; failureReason: string | null; externalMessageId: string | null };
  if (!recipientAllowed(opts.toAddress)) {
    result = {
      status: "logged-only",
      failureReason:
        "Recipient is not on the demo allowlist — message composed and logged, not delivered (set ONBOARDING_ALLOWED_RECIPIENTS to change).",
      externalMessageId: null,
    };
  } else if (!withinRateLimit()) {
    result = {
      status: "logged-only",
      failureReason: "Hourly live-send limit reached — message logged, not delivered.",
      externalMessageId: null,
    };
  } else if (opts.channel === "email") {
    result = await sendEmail(opts.toAddress, opts.subject ?? "Onboarding update", opts.body);
  } else {
    result = await sendWhatsApp(opts.toAddress, opts.body);
  }
  const masked =
    opts.channel === "email" ? maskEmail(opts.toAddress) : maskPhone(opts.toAddress);
  const [row] = await db
    .insert(onbCommunications)
    .values({
      caseId: opts.caseId,
      channel: opts.channel,
      direction: "outbound",
      toAddress: masked,
      subject: opts.subject ?? null,
      body: opts.body,
      status: result.status,
      failureReason: result.failureReason,
      sensitive: opts.sensitive ?? false,
      externalMessageId: result.externalMessageId,
    })
    .returning({ id: onbCommunications.id });
  return { id: row.id, status: result.status, failureReason: result.failureReason };
}
