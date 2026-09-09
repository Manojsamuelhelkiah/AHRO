import { db } from "@workspace/db";
import { onbCases, onbCommunications, onbEffectJournal } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { recordGuardrailEvent } from "./guardrails";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { candidateEmailDeliveryDecision, candidateEmailMaySend, isRetryableCandidateEmail } from "./channel-routing";
import { isValidEmail } from "./settings";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { externalProviderDispatchDenied } from "./provider-policy";
import {
  claimEffectDispatch,
  ensureEffectJournalEntry,
} from "./effect-journal";
import {
  blockedPublishBackupRequired,
  invalidBlockedPublishBackupCategories,
  missingBlockedPublishBackupCategories,
} from "../../../blocked-publish-backup-readiness.mjs";

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

export type BlockedPublishBackupReadiness = {
  ready: boolean;
  required: boolean;
  destination: string | null;
  sender: string | null;
  missing: string[];
  invalid: string[];
  note: string;
};

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

export function maskPhone(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 4)}•••${phone.slice(-2)}` : "•••";
}

function whatsappPhone(value: string): string {
  return value.replace(/^whatsapp:/, "").trim();
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

export function blockedPublishBackupReadiness(): BlockedPublishBackupReadiness {
  const destination = whatsappPhone(
    process.env.ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP ?? "",
  );
  const sender = whatsappPhone(process.env.TWILIO_WHATSAPP_FROM ?? "");
  const required = blockedPublishBackupRequired(process.env);
  const missing = missingBlockedPublishBackupCategories(process.env);
  const invalid = invalidBlockedPublishBackupCategories(process.env);

  return {
    ready: missing.length === 0 && invalid.length === 0,
    required,
    destination: destination ? maskPhone(destination) : null,
    sender: sender ? maskPhone(sender) : null,
    missing,
    invalid,
    note:
      !required
        ? "Backup WhatsApp alerts are optional in this environment."
        : missing.length === 0 && invalid.length === 0
          ? "Backup WhatsApp alerts are ready if Gmail rejects a blocked-release alert."
          : [
              missing.length > 0 ? `Configuration needed: ${missing.join(", ")}.` : null,
              invalid.length > 0
                ? `Fix ${invalid.join(" and ")} to use E.164 format (for example, +15551234567).`
                : null,
            ].filter(Boolean).join(" "),
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

export function twilioHttpFailure(status: number, detail: string) {
  return {
    status: "failed",
    failureReason: `Twilio ${status}: ${detail.slice(0, 300)}`,
    externalMessageId: null,
  };
}

export function twilioAmbiguousFailure(err: unknown) {
  return {
    status: "sending",
    failureReason: `Delivery outcome unknown: Twilio request did not complete cleanly (${String(err).slice(0, 240)}). Do not retry automatically.`,
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
      return twilioHttpFailure(resp.status, detail);
    }
    const sent = (await resp.json().catch(() => null)) as { sid?: string } | null;
    return { status: "sent", failureReason: null, externalMessageId: sent?.sid ?? null };
  } catch (err) {
    return twilioAmbiguousFailure(err);
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

export function addCandidateReplyReference(body: string): string {
  return `${body}\n\n[Reply reference: CR-${randomBytes(16).toString("hex")}]`;
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
  /** Optional redacted timeline copy when the delivered body contains an ephemeral secret. */
  persistedBody?: string;
  sensitive?: boolean;
  idempotencyKey?: string;
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
  let body =
    opts.channel === "email" && candidateEmail
      ? addCandidateReplyReference(opts.body)
      : opts.body;
  let subject = opts.subject ?? null;
  const masked =
    opts.channel === "email" ? maskEmail(actualAddress) : maskPhone(actualAddress);
  let dispatch:
    | { owner: string; fencingToken: number; logicalOperationKey: string; communicationId: number }
    | undefined;
  if (opts.idempotencyKey) {
    const logicalOperationKey = `candidate-communication:${opts.idempotencyKey}`;
    // The first caller durably freezes the exact payload before any effect
    // identity or provider dispatch. Retries reuse it even if an LLM proposes
    // different text.
    await db.insert(onbCommunications).values({
      organizationId: caseRow.organizationId,
      caseId: opts.caseId,
      channel: opts.channel,
      direction: "outbound",
      audience: "candidate",
      toAddress: masked,
      subject: opts.subject ?? null,
      body,
      status: "sending",
      failureReason: null,
      sensitive: opts.sensitive ?? false,
      idempotencyKey: opts.idempotencyKey,
    }).onConflictDoNothing({
      target: [onbCommunications.organizationId, onbCommunications.idempotencyKey],
    });
    const [payload] = await db.select().from(onbCommunications).where(and(
      eq(onbCommunications.organizationId, caseRow.organizationId),
      eq(onbCommunications.idempotencyKey, opts.idempotencyKey),
    ));
    if (!payload || payload.caseId !== opts.caseId || payload.channel !== opts.channel) {
      throw new Error("Communication idempotency key is bound to another payload");
    }
    body = payload.body;
    subject = payload.subject;
    const argumentsHash = createHash("sha256").update(JSON.stringify({
      channel: payload.channel,
      toAddress: payload.toAddress,
      subject: payload.subject,
      body: payload.body,
    })).digest("hex");
    const identity = {
      logicalOperationKey,
      organizationId: caseRow.organizationId,
      tenantId: caseRow.organizationId,
      caseId: opts.caseId,
      toolName: `send-${opts.channel}`,
      argumentsHash,
      providerIdempotency: false,
    };
    const entry = await ensureEffectJournalEntry(identity);
    const owner = randomUUID();
    const claim = await claimEffectDispatch({
      ...identity,
      owner,
      expectedFencingToken: entry.fencingToken,
    });
    const ensureCommunication = async (failureReason: string | null) => {
      if (failureReason) {
        await db.update(onbCommunications).set({ failureReason }).where(eq(onbCommunications.id, payload.id));
      }
      return payload.id;
    };
    if (claim.kind === "reuse_confirmed") {
      const id = await ensureCommunication(null);
      const [existing] = await db.select().from(onbCommunications).where(eq(onbCommunications.id, id));
      return { id, status: existing.status, failureReason: existing.failureReason };
    }
    if (claim.kind === "manual_repair_required") {
      const id = await ensureCommunication("Delivery outcome unknown; manual reconciliation required. Automatic resend is disabled.");
      await db.update(onbCommunications).set({
        status: "sending",
        failureReason: "Delivery outcome unknown; manual reconciliation required. Automatic resend is disabled.",
      }).where(eq(onbCommunications.id, id));
      return { id, status: "sending", failureReason: "Delivery outcome unknown; manual reconciliation required. Automatic resend is disabled." };
    }
    if (claim.kind !== "claimed") {
      const id = await ensureCommunication("Delivery is currently being dispatched by another worker.");
      return { id, status: "sending", failureReason: "Delivery is currently being dispatched by another worker." };
    }
    dispatch = {
      owner,
      fencingToken: claim.fencingToken,
      logicalOperationKey,
      communicationId: await ensureCommunication(null),
    };
  }
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
    result = await sendEmail(actualAddress, subject ?? "Onboarding update", body);
  } else {
    result = await sendWhatsApp(actualAddress, body);
  }
  if (dispatch) {
    const ambiguous = result.status === "sending";
    const committed = await db.transaction(async (tx) => {
      const [effect] = await tx.update(onbEffectJournal).set(ambiguous
        ? {
            status: "unknown_effect_manual_repair",
            lastError: result.failureReason ?? "Provider delivery outcome unknown",
            claimUntil: null,
            updatedAt: sql`now()`,
          }
        : {
            status: "confirmed",
            externalEffectId: result.externalMessageId,
            confirmedAt: sql`now()`,
            claimUntil: null,
            updatedAt: sql`now()`,
          }).where(and(
            eq(onbEffectJournal.logicalOperationKey, dispatch!.logicalOperationKey),
            eq(onbEffectJournal.organizationId, caseRow.organizationId),
            eq(onbEffectJournal.status, "dispatching"),
            eq(onbEffectJournal.claimOwner, dispatch!.owner),
            eq(onbEffectJournal.fencingToken, dispatch!.fencingToken),
          )).returning({ key: onbEffectJournal.logicalOperationKey });
      if (!effect) return false;
      await tx.update(onbCommunications).set({
        status: result.status,
        failureReason: result.failureReason,
        externalMessageId: result.externalMessageId,
      }).where(eq(onbCommunications.id, dispatch!.communicationId));
      return true;
    });
    if (!committed) {
      return {
        id: dispatch.communicationId,
        status: "sending",
        failureReason: "Dispatch claim expired before confirmation; manual reconciliation required.",
      };
    }
    return {
      id: dispatch.communicationId,
      status: result.status,
      failureReason: result.failureReason,
    };
  }
  const [row] = await db
    .insert(onbCommunications)
    .values({
      organizationId: caseRow.organizationId,
      caseId: opts.caseId,
      channel: opts.channel,
      direction: "outbound",
      audience: "candidate",
      toAddress: masked,
      subject,
      body: opts.persistedBody ?? body,
      status: result.status,
      failureReason: result.failureReason,
      sensitive: opts.sensitive ?? false,
      externalMessageId: result.externalMessageId,
      idempotencyKey: null,
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
  idempotencyKey?: string;
}): Promise<{ id: number; status: string; failureReason: string | null }> {
  const [caseRow] = await db.select({ organizationId: onbCases.organizationId }).from(onbCases)
    .where(eq(onbCases.id, opts.caseId));
  if (!caseRow) throw new Error(`case ${opts.caseId} not found`);
  if (opts.idempotencyKey) {
    const [claimedRow] = await db.insert(onbCommunications).values({
      organizationId: caseRow.organizationId,
      caseId: opts.caseId,
      channel: "email",
      direction: "outbound",
      audience: "admin",
      toAddress: maskEmail(opts.toAddress),
      subject: opts.subject,
      body: opts.body,
      status: "sending",
      failureReason: null,
      idempotencyKey: opts.idempotencyKey,
    }).onConflictDoNothing({
      target: [onbCommunications.organizationId, onbCommunications.idempotencyKey],
    }).returning();
    if (!claimedRow) {
      const [existing] = await db.select().from(onbCommunications).where(and(
        eq(onbCommunications.organizationId, caseRow.organizationId),
        eq(onbCommunications.idempotencyKey, opts.idempotencyKey),
      ));
      if (!existing) throw new Error("Administrative communication claim disappeared");
      return { id: existing.id, status: existing.status, failureReason: existing.failureReason };
    }
    const logicalOperationKey = `administrative-communication:${opts.idempotencyKey}`;
    const identity = {
      logicalOperationKey,
      organizationId: caseRow.organizationId,
      tenantId: caseRow.organizationId,
      caseId: opts.caseId,
      toolName: "send-administrative-email",
      argumentsHash: createHash("sha256").update(JSON.stringify({
        toAddress: claimedRow.toAddress,
        subject: claimedRow.subject,
        body: claimedRow.body,
      })).digest("hex"),
      providerIdempotency: false,
    };
    const entry = await ensureEffectJournalEntry(identity);
    const owner = randomUUID();
    const effectClaim = await claimEffectDispatch({
      ...identity,
      owner,
      expectedFencingToken: entry.fencingToken,
    });
    if (effectClaim.kind !== "claimed") {
      await db.update(onbCommunications).set({
        failureReason: "Administrative delivery requires manual reconciliation; automatic resend is disabled.",
      }).where(eq(onbCommunications.id, claimedRow.id));
      return {
        id: claimedRow.id,
        status: "sending",
        failureReason: "Administrative delivery requires manual reconciliation; automatic resend is disabled.",
      };
    }
    // Continue below as the sole durable dispatch owner; completion is
    // atomically committed with the journal transition.
    (opts as typeof opts & { __dispatch?: { owner: string; token: number; key: string; id: number } }).__dispatch = {
      owner,
      token: effectClaim.fencingToken,
      key: logicalOperationKey,
      id: claimedRow.id,
    };
  }
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
  const dispatch = (opts as typeof opts & { __dispatch?: { owner: string; token: number; key: string; id: number } }).__dispatch;
  if (dispatch) {
    const committed = await db.transaction(async (tx) => {
      const [effect] = await tx.update(onbEffectJournal).set({
        status: result.status === "sending" ? "unknown_effect_manual_repair" : "confirmed",
        externalEffectId: result.externalMessageId,
        confirmedAt: result.status === "sending" ? null : sql`now()`,
        claimUntil: null,
        lastError: result.status === "sending" ? result.failureReason : null,
        updatedAt: sql`now()`,
      }).where(and(
        eq(onbEffectJournal.logicalOperationKey, dispatch.key),
        eq(onbEffectJournal.organizationId, caseRow.organizationId),
        eq(onbEffectJournal.claimOwner, dispatch.owner),
        eq(onbEffectJournal.fencingToken, dispatch.token),
        eq(onbEffectJournal.status, "dispatching"),
      )).returning({ key: onbEffectJournal.logicalOperationKey });
      if (!effect) return false;
      await tx.update(onbCommunications).set({
        status: result.status,
        failureReason: result.failureReason,
        externalMessageId: result.externalMessageId,
      }).where(eq(onbCommunications.id, dispatch.id));
      return true;
    });
    return {
      id: dispatch.id,
      status: committed ? result.status : "sending",
      failureReason: committed ? result.failureReason : "Administrative delivery outcome is unknown; manual reconciliation required.",
    };
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
