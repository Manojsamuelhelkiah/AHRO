import { db } from "@workspace/db";
import { onbCommunications } from "@workspace/db/schema";

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
  const configured = Boolean(process.env.RESEND_API_KEY);
  return {
    configured,
    provider: configured ? "resend" : "logged-only",
    target: "He***@gmail.com",
    note: configured
      ? "Outbound email is live via Resend."
      : "Email provider not connected yet — messages are composed and logged in the case timeline, not delivered.",
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
): Promise<{ status: string; failureReason: string | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { status: "logged-only", failureReason: null };
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? "Onboarding Agent <onboarding@resend.dev>",
        to: [to],
        subject,
        text: body,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      return { status: "failed", failureReason: `Resend ${resp.status}: ${detail.slice(0, 300)}` };
    }
    return { status: "sent", failureReason: null };
  } catch (err) {
    return { status: "failed", failureReason: String(err).slice(0, 300) };
  }
}

async function sendWhatsApp(
  toPhone: string,
  body: string,
): Promise<{ status: string; failureReason: string | null }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) {
    return { status: "logged-only", failureReason: null };
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
      return { status: "failed", failureReason: `Twilio ${resp.status}: ${detail.slice(0, 300)}` };
    }
    return { status: "sent", failureReason: null };
  } catch (err) {
    return { status: "failed", failureReason: String(err).slice(0, 300) };
  }
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
  let result: { status: string; failureReason: string | null };
  if (opts.channel === "email") {
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
    })
    .returning({ id: onbCommunications.id });
  return { id: row.id, ...result };
}
