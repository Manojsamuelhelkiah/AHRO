import { db } from "@workspace/db";
import { onbCases, onbCommunications } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { recordGuardrailEvent } from "./guardrails";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { candidateEmailDeliveryDecision, candidateEmailMaySend, isRetryableCandidateEmail } from "./channel-routing";
import { isValidEmail } from "./settings";
import { randomBytes } from "node:crypto";
import { externalProviderDispatchDenied } from "./provider-policy";

const connectors = new ReplitConnectors();

export type ChannelInfo = {
  configured: boolean;
  provider: string;
  target: string;
  note: string;
  /** WhatsApp only: the sandbox sender number hires must message (e.g. "+14155238886"). */
  sandboxNumber?: string | null;
  /** WhatsApp only: the sandbox join keyword hires send as "join <keyword>", when configured. */
  sandboxJoinKeyword?: string | null;
};

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

export function maskPhone(phone: string): string {
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
  // The sandbox sender number is what hires message to (re)join a session.
  // It is a public Twilio number (not a credential), so it is safe to surface.
  const from = (process.env.TWILIO_WHATSAPP_FROM ?? "").replace(/^whatsapp:/, "").trim();
  const joinKeyword = (process.env.TWILIO_SANDBOX_JOIN_KEYWORD ?? "").trim();
  return {
    configured,
    provider: configured ? "twilio" : "logged-only",
    target: "workerPhone on each case",
    note: configured
      ? "Outbound WhatsApp is live via Twilio."
      : "Twilio WhatsApp not connected yet — messages are composed and logged in the case timeline, not delivered.",
    sandboxNumber: from || null,
    sandboxJoinKeyword: joinKeyword || null,
  };
}

export function gmailHttpFailure(status: number, detail: string) {
  return { status: "failed", failureReason: `Gmail ${status}: ${detail.slice(0, 300)}`, externalMessageId: null };
}

export function gmailAmbiguousFailure(err: unknown) {
  return {
    status: "sending",
    failureReason: `Delivery outcome unknown: Gmail request did not complete cleanly (${String(err).slice(0, 240)}). Do not retry automatically.`,
    externalMessageId: null,
  };
}

/**
 * Send a plain email via the connected Gmail account. Exported so system
 * alerting (e.g. the inbox-monitor outage notifier) can reuse the same
 * delivery path without creating a case communication row.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
): Promise<{ status: string; failureReason: string | null; externalMessageId: string | null }> {
  if (externalProviderDispatchDenied()) {
    return {
      status: "logged-only",
      failureReason: "External email delivery is denied by the active execution safety policy.",
      externalMessageId: null,
    };
  }
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
      return gmailHttpFailure(resp.status, detail);
    }
    // Store the Gmail message id so the inbound poller can recognise (and
    // skip) our own outbound messages when the demo recipient is the same
    // Gmail account — otherwise self-sent mail would echo back as "inbound".
    const sent = (await resp.json().catch(() => null)) as { id?: string } | null;
    return { status: "sent", failureReason: null, externalMessageId: sent?.id ?? null };
  } catch (err) {
    return gmailAmbiguousFailure(err);
  }
}

/**
 * Public URL Twilio should POST MessageStatus callbacks to. Prefers the
 * published domain (REPLIT_DOMAINS), falls back to the dev domain — both are
 * publicly reachable. Returns null when no domain is available (e.g. tests).
 */
export function whatsappStatusCallbackUrl(): string | null {
  const domain =
    process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ||
    process.env.REPLIT_DEV_DOMAIN?.trim();
  if (!domain) return null;
  return `https://${domain}/api/onboarding/webhooks/twilio/whatsapp-status`;
}

async function sendWhatsApp(
  toPhone: string,
  body: string,
): Promise<{ status: string; failureReason: string | null; externalMessageId: string | null }> {
  if (externalProviderDispatchDenied()) {
    return {
      status: "logged-only",
      failureReason: "External WhatsApp delivery is denied by the active execution safety policy.",
      externalMessageId: null,
    };
  }
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
    // Ask Twilio to report final delivery status back to us so the
    // communication row can move from "sent" to "delivered"/"failed".
    const statusCallback = whatsappStatusCallbackUrl();
    if (statusCallback) params.set("StatusCallback", statusCallback);
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

/** Admin-managed demo-volunteer addresses, isolated by tenant. */
const demoAllowedByOrganization = new Map<string, ReadonlySet<string>>();

function normalizeAddress(address: string): string {
  const base = address.trim().toLowerCase().replace(/^whatsapp:/, "");
  // Only phone-like values lose separators; emails keep hyphens/dots intact
  // (stripping them would make first-last@x.com match firstlast@x.com).
  const compact = base.replace(/[\s-]/g, "");
  return /^\+?\d+$/.test(compact) ? compact : base;
}

/** Replace one tenant's demo-volunteer allowlist (emails + phone numbers). */
export function setDemoAllowlist(organizationId: string, addresses: string[]): void {
  demoAllowedByOrganization.set(
    organizationId,
    new Set(addresses.map(normalizeAddress).filter(Boolean)),
  );
}

/** True when live delivery to this email/phone is permitted. */
export function addressAllowed(address: string, organizationId?: string): boolean {
  const configured = (process.env.ONBOARDING_ALLOWED_RECIPIENTS ?? "")
    .split(",")
    .map((s) => normalizeAddress(s))
    .filter(Boolean);
  const allowed = configured.length > 0 ? configured : DEFAULT_ALLOWED_RECIPIENTS;
  const normalized = normalizeAddress(address);
  return allowed.includes(normalized) ||
    (organizationId !== undefined &&
      demoAllowedByOrganization.get(organizationId)?.has(normalized) === true);
}

/** Unlike legacy demo defaults, system test delivery requires an explicit env allowlist entry. */
export function explicitlyConfiguredAddressAllowed(address: string): boolean {
  const configured = (process.env.ONBOARDING_ALLOWED_RECIPIENTS ?? "")
    .split(",")
    .map((s) => normalizeAddress(s))
    .filter(Boolean);
  return configured.includes(normalizeAddress(address));
}

/** Explicit demo-volunteer or environment authorization for legacy candidate cases. */
export function explicitlyAllowlistedCandidateAddress(
  address: string,
  organizationId?: string,
): boolean {
  return explicitlyConfiguredAddressAllowed(address) ||
    (organizationId !== undefined &&
      demoAllowedByOrganization.get(organizationId)?.has(normalizeAddress(address)) === true);
}

/** Email channel diagnostics never borrow a candidate address. */
export function systemEmailTestAddress(): string | null {
  const address = (process.env.ONBOARDING_CHANNEL_TEST_EMAIL ?? "").trim();
  return address && explicitlyConfiguredAddressAllowed(address) ? address : null;
}

function recipientAllowed(address: string, organizationId: string): boolean {
  return addressAllowed(address, organizationId);
}

export type CandidateEmailAuthorization = {
  allowed: boolean;
  address: string;
  reason: string | null;
};

/** Resolve live candidate-email permission from the case, never from caller input. */
export function candidateEmailAuthorization(
  c: Pick<typeof onbCases.$inferSelect, "workerEmail" | "channelPreference" | "candidateEmailAuthorizedAt">,
): CandidateEmailAuthorization {
  return candidateEmailDeliveryDecision(c);
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
  const [caseRow] = await db.select().from(onbCases).where(eq(onbCases.id, opts.caseId));
  if (!caseRow) throw new Error(`case ${opts.caseId} not found`);
  // Pick up this tenant's allowlist changes saved on another process instance.
  let allowlistRefreshed = false;
  try {
    const { refreshDemoAllowlist } = await import("./demo-volunteers");
    await refreshDemoAllowlist(caseRow.organizationId);
    allowlistRefreshed = true;
  } catch (err) {
    console.error("[channels] demo allowlist refresh failed:", err);
  }
  const candidateEmail = opts.channel === "email" ? candidateEmailAuthorization(caseRow) : null;
  const actualAddress = candidateEmail?.address ?? opts.toAddress;
  // Shared-inbox replies are attributed only through this unguessable,
  // case-bound reference, never by sender address alone.
  const body =
    opts.channel === "email" && candidateEmail
      ? `${opts.body}\n\n[Reply reference: CR-${randomBytes(16).toString("hex")}]`
      : opts.body;
  // Preserve prior explicit demo/env authorization for a case candidate while
  // still deriving the target from the record. It is not a blanket bypass:
  // the address itself must be allowlisted and the case must allow email.
  const candidateMaySend = candidateEmail && candidateEmailMaySend({
    channelPreference: caseRow.channelPreference,
    caseAuthorized: candidateEmail.allowed,
    explicitlyAllowlisted: explicitlyConfiguredAddressAllowed(candidateEmail.address) ||
      (allowlistRefreshed &&
        explicitlyAllowlistedCandidateAddress(candidateEmail.address, caseRow.organizationId)),
    validEmail: isValidEmail(candidateEmail.address),
  });
  if (candidateEmail && !candidateMaySend) {
    result = {
      status: "logged-only",
      failureReason: candidateEmail.reason,
      externalMessageId: null,
    };
    void recordGuardrailEvent({
      caseId: opts.caseId,
      key: "recipient-allowlist",
      action: "blocked",
      detail: `Live email delivery to ${maskEmail(actualAddress)} withheld — case-scoped candidate authorization is absent. Message logged only.`,
    });
  } else if (
    opts.channel !== "email" &&
    !(explicitlyConfiguredAddressAllowed(actualAddress) ||
      (allowlistRefreshed && recipientAllowed(actualAddress, caseRow.organizationId)))
  ) {
    result = {
      status: "logged-only",
      failureReason:
        "WhatsApp recipient is not on the demo allowlist — message composed and logged, not delivered.",
      externalMessageId: null,
    };
    void recordGuardrailEvent({
      caseId: opts.caseId,
      key: "recipient-allowlist",
      action: "blocked",
      detail: `Live ${opts.channel} delivery to ${maskPhone(actualAddress)} withheld — recipient not authorized. Message logged only.`,
    });
  } else if (!withinRateLimit()) {
    result = {
      status: "logged-only",
      failureReason: "Hourly live-send limit reached — message logged, not delivered.",
      externalMessageId: null,
    };
    void recordGuardrailEvent({
      caseId: opts.caseId,
      key: "send-rate-cap",
      action: "rate-limited",
      detail: `Hourly live-send cap (${MAX_LIVE_SENDS_PER_HOUR}/h) reached — ${opts.channel} message logged, not delivered.`,
    });
  } else if (opts.channel === "email") {
    result = await sendEmail(actualAddress, opts.subject ?? "Onboarding update", body);
  } else {
    result = await sendWhatsApp(actualAddress, body);
  }
  const masked =
    opts.channel === "email" ? maskEmail(actualAddress) : maskPhone(actualAddress);
  const [row] = await db
    .insert(onbCommunications)
    .values({
      organizationId: caseRow.organizationId,
      caseId: opts.caseId,
      channel: opts.channel,
      direction: "outbound",
      audience: "candidate",
      toAddress: masked,
      subject: opts.subject ?? null,
      body,
      status: result.status,
      failureReason: result.failureReason,
      sensitive: opts.sensitive ?? false,
      externalMessageId: result.externalMessageId,
    })
    .returning({ id: onbCommunications.id });
  return { id: row.id, status: result.status, failureReason: result.failureReason };
}

/** Separate HR/HITL path: preserves the explicit admin allowlist and never case-routes to a candidate. */
export async function sendAdministrativeEmail(opts: {
  caseId: number;
  toAddress: string;
  subject: string;
  body: string;
}): Promise<{ id: number; status: string; failureReason: string | null }> {
  const [caseRow] = await db.select({ organizationId: onbCases.organizationId }).from(onbCases)
    .where(eq(onbCases.id, opts.caseId));
  if (!caseRow) throw new Error(`case ${opts.caseId} not found`);
  let result: { status: string; failureReason: string | null; externalMessageId: string | null };
  let allowlistRefreshed = false;
  try {
    const { refreshDemoAllowlist } = await import("./demo-volunteers");
    await refreshDemoAllowlist(caseRow.organizationId);
    allowlistRefreshed = true;
  } catch (err) {
    console.error("[channels] admin allowlist refresh failed:", err);
  }
  if (!(explicitlyConfiguredAddressAllowed(opts.toAddress) ||
    (allowlistRefreshed && recipientAllowed(opts.toAddress, caseRow.organizationId)))) {
    result = { status: "logged-only", failureReason: "HR approver address is not on the administrative allowlist — notification logged, not delivered.", externalMessageId: null };
  } else if (!withinRateLimit()) {
    result = { status: "logged-only", failureReason: "Hourly live-send limit reached — notification logged, not delivered.", externalMessageId: null };
  } else {
    result = await sendEmail(opts.toAddress, opts.subject, opts.body);
  }
  const [row] = await db.insert(onbCommunications).values({
    organizationId: caseRow.organizationId,
    caseId: opts.caseId,
    channel: "email",
    direction: "outbound",
    audience: "admin",
    toAddress: maskEmail(opts.toAddress),
    subject: opts.subject,
    body: opts.body,
    status: result.status,
    failureReason: result.failureReason,
    externalMessageId: result.externalMessageId,
  }).returning({ id: onbCommunications.id });
  return { id: row.id, status: result.status, failureReason: result.failureReason };
}

export type RetryEmailResult =
  | { ok: true; communication: typeof onbCommunications.$inferSelect }
  | { ok: false; code: "not-found" | "not-retryable" | "not-authorized"; reason: string };

/**
 * Manual email retry. The conditional status transition is the durable claim:
 * only one concurrent request can move a definitive failed/logged-only row to
 * sending. A crash leaves "sending" (ambiguous) and therefore cannot be retried.
 */
export async function retryCandidateEmail(
  caseId: number,
  communicationId: number,
  reviewer: string,
  send: typeof sendEmail = sendEmail,
  claimLiveSend: () => boolean = withinRateLimit,
): Promise<RetryEmailResult> {
  const [existing] = await db
    .select({ communication: onbCommunications, candidate: onbCases })
    .from(onbCommunications)
    .innerJoin(onbCases, eq(onbCommunications.caseId, onbCases.id))
    .where(and(eq(onbCommunications.id, communicationId), eq(onbCommunications.caseId, caseId)));
  if (!existing) return { ok: false, code: "not-found", reason: "Communication not found." };
  const msg = existing.communication;
  if (!isRetryableCandidateEmail(msg)) {
    return { ok: false, code: "not-retryable", reason: `Email with status "${msg.status}" is not safe to retry.` };
  }
  // Pick up explicit volunteer authorization changed on another process
  // before evaluating the legacy fallback path.
  let allowlistRefreshed = false;
  try {
    const { refreshDemoAllowlist } = await import("./demo-volunteers");
    await refreshDemoAllowlist(existing.candidate.organizationId);
    allowlistRefreshed = true;
  } catch (err) {
    console.error("[channels] retry allowlist refresh failed:", err);
  }
  const authorization = candidateEmailAuthorization(existing.candidate);
  const retryAuthorized = candidateEmailMaySend({
    channelPreference: existing.candidate.channelPreference,
    caseAuthorized: authorization.allowed,
    explicitlyAllowlisted: explicitlyConfiguredAddressAllowed(authorization.address) ||
      (allowlistRefreshed &&
        explicitlyAllowlistedCandidateAddress(
          authorization.address,
          existing.candidate.organizationId,
        )),
    validEmail: isValidEmail(authorization.address),
  });
  if (!retryAuthorized) {
    return { ok: false, code: "not-authorized", reason: authorization.reason! };
  }
  const claimedAt = new Date();
  const [claimed] = await db
    .update(onbCommunications)
    .set({
      status: "sending",
      failureReason: "Manual retry claimed; awaiting Gmail result.",
      toAddress: maskEmail(authorization.address),
      retriedBy: reviewer,
      retriedAt: claimedAt,
    })
    .where(and(
      eq(onbCommunications.id, communicationId),
      eq(onbCommunications.caseId, caseId),
      sql`${onbCommunications.status} in ('failed', 'logged-only')`,
    ))
    .returning();
  if (!claimed) {
    return { ok: false, code: "not-retryable", reason: "This email was already claimed for retry or its status changed." };
  }
  if (!claimLiveSend()) {
    const failureReason = "Hourly live-send limit reached — message logged, not delivered.";
    const [capped] = await db
      .update(onbCommunications)
      .set({ status: "logged-only", failureReason })
      .where(and(
        eq(onbCommunications.id, communicationId),
        eq(onbCommunications.status, "sending"),
        eq(onbCommunications.retriedAt, claimedAt),
      ))
      .returning();
    void recordGuardrailEvent({
      caseId,
      key: "send-rate-cap",
      action: "rate-limited",
      detail: `Hourly live-send cap (${MAX_LIVE_SENDS_PER_HOUR}/h) reached — email retry logged, not delivered.`,
    });
    return { ok: true, communication: capped ?? claimed };
  }
  const result = await send(authorization.address, msg.subject ?? "Onboarding update", msg.body);
  const [updated] = await db
    .update(onbCommunications)
    .set({
      status: result.status,
      failureReason: result.failureReason,
      externalMessageId: result.externalMessageId,
    })
    .where(and(eq(onbCommunications.id, communicationId), eq(onbCommunications.status, "sending"), eq(onbCommunications.retriedAt, claimedAt)))
    .returning();
  return { ok: true, communication: updated ?? claimed };
}
