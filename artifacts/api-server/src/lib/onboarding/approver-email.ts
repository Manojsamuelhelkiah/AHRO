import { db } from "@workspace/db";
import { onbApprovals, onbCases, onbSettings } from "@workspace/db/schema";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, eq } from "drizzle-orm";
import {
  alreadyRecorded,
  extractAddress,
  findPlainText,
  header,
  persistInbound,
  stripQuotedReply,
  type GmailMessage,
} from "./inbound-email";
import { getSetting, isValidEmail, HR_APPROVER_EMAIL_KEY } from "./settings";
import { logEvent } from "./engine";
import { makeSharedTick } from "./shared-tick";
import {
  approvalRef as versionedApprovalRef,
  parseApprovalReference,
} from "./approval-version";
import {
  decideApproval,
  enqueueEmailReplyNoDecisionReceipt,
  enqueueApprovalRequestNotification,
} from "./approval-decisions";
import {
  composeApprovalRequestEmail,
} from "./approval-email-templates";
import {
  verifyGmailApprovalTransport,
  type VerifiedGmailDkimTransport,
} from "./verified-email-transport";

/**
 * Approval email notifications and remote-reply receipt handling.
 *
 * Outbound: whenever the agent escalates (an approval is created) and an
 * HR approver address is configured in Settings, that person is emailed
 * the recommendation with a reference like [AP-42] and told to sign in to
 * the organization and decide in the Action Center.
 *
 * Inbound: a dedicated Gmail poll searches for replies from the configured
 * sender. A decision is accepted only after the exact sender is re-bound to
 * its verified Clerk account and a current governance assignment.
 */

const connectors = new ReplitConnectors();

const POLL_INTERVAL_MS = 60_000;
const SEARCH_WINDOW = "newer_than:2d";

let timer: NodeJS.Timeout | null = null;

/** Effective approver address, or null when unset/invalid. */
export async function approverEmailAddress(organizationId: string): Promise<string | null> {
  try {
    const stored = (await getSetting(organizationId, HR_APPROVER_EMAIL_KEY))?.trim() ?? "";
    return stored.length > 0 && isValidEmail(stored) ? stored : null;
  } catch (err) {
    console.error("[approver-email] failed to read approver setting:", String(err));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/** The reference the approver's reply must quote, e.g. "AP-42-V2". */
export function approvalRef(approvalId: number, version?: number): string {
  // Preserve the historical pure-helper contract for callers that omitted a
  // cycle. Every outbound composer passes an explicit version and therefore
  // emits the unambiguous AP-<id>-V<version> form.
  return version === undefined ? `AP-${approvalId}` : versionedApprovalRef(approvalId, version);
}

/** Extract the approval id from an "AP-<id>" reference in the text, or null. */
export function matchApprovalRef(text: string): number | null {
  return parseApprovalReference(text)?.approvalId ?? null;
}

/** Parse an approval id and cycle, rejecting contradictory references. */
export function matchApprovalVersionRef(text: string): {
  approvalId: number;
  version: number;
  legacy: boolean;
} | null {
  return parseApprovalReference(text);
}

export type ApproverDecision = "approved" | "rejected";

/**
 * Parse the approver's reply into a decision. Deliberately strict: the
 * reply must contain approve/reject (or a close variant) and must not
 * contain BOTH — an ambiguous reply decides nothing.
 */
export function parseApproverDecision(text: string): ApproverDecision | null {
  // Negated approvals ("do not approve") are rejections — remove them
  // before looking for a positive approve so they don't count as both.
  const negated = /\b(do not|don'?t|cannot|can'?t|won'?t|not)\s+approve[ds]?\b/i;
  const cleaned = text.replace(new RegExp(negated.source, "gi"), " ");
  const approve = /\b(approve[ds]?|approval granted|lgtm|yes,?\s*approve)\b/i.test(cleaned);
  const reject =
    negated.test(text) || /\b(reject(s|ed)?|rejection|denied|deny)\b/i.test(text);
  if (approve && !reject) return "approved";
  if (reject && !approve) return "rejected";
  return null;
}

/** Is this sender the configured approver? Exact address, case-insensitive. */
export function senderIsApprover(fromAddress: string, approver: string | null): boolean {
  if (!approver) return false;
  return fromAddress.trim().toLowerCase() === approver.trim().toLowerCase();
}

/** Compose the notification email for a new pending approval (pure). */
export function composeApprovalEmail(opts: {
  approvalId: number;
  version?: number;
  workerName: string;
  caseId: number;
  agent: string;
  hitlPattern: string;
  recommendation: string;
  rationale: string;
  stakeholderName?: string | null;
  stakeholderRole?: string;
  deliveryAddress?: string | null;
  deliveryMode?: "real" | "simulated";
  emailResponderAuthorized?: boolean;
}): { subject: string; body: string } {
  return composeApprovalRequestEmail({
    approvalId: opts.approvalId,
    version: opts.version,
    workerName: opts.workerName,
    caseId: opts.caseId,
    agent: opts.agent,
    hitlPattern: opts.hitlPattern,
    recommendation: opts.recommendation,
    rationale: opts.rationale,
    stakeholder: {
      name: opts.stakeholderName?.trim() ?? "",
      role: opts.stakeholderRole?.trim() || "HR approval stakeholder",
    },
    deliveryAddress: opts.deliveryAddress,
    deliveryMode: opts.deliveryMode ?? "real",
    deliveryState: "queued",
    emailResponderAuthorized: opts.emailResponderAuthorized,
  });
}

/* ------------------------------------------------------------------ */
/* Outbound: notify the approver of a new pending approval             */
/* ------------------------------------------------------------------ */

/**
 * Email the configured approver about a newly created approval. No-op when
 * no approver is configured. Never throws — a notification failure must not
 * break the escalation itself. The sent message is recorded on the case
 * timeline (with the Gmail message id, so a same-account demo inbox does
 * not echo it back as an inbound reply).
 */
export async function notifyApproverOfApproval(approval: {
  id: number;
  caseId: number;
  organizationId: string;
  version?: number | null;
  agent: string;
  hitlPattern: string;
  recommendation: string;
  rationale: string;
}): Promise<void> {
  try {
    const to = await approverEmailAddress(approval.organizationId);
    if (!to) return;
    const [c] = await db
      .select({ workerName: onbCases.workerName })
      .from(onbCases)
      .where(and(
        eq(onbCases.id, approval.caseId),
        eq(onbCases.organizationId, approval.organizationId),
      ));
    // Queue first. The heartbeat-owned worker applies the existing
    // administrative allowlist, rate limit, and ambiguous-send fencing.
    await enqueueApprovalRequestNotification({
      ...approval,
      version: approval.version ?? 1,
    });
    await logEvent(
      approval.caseId,
      "channel",
      "system",
      "HR approver notification queued",
      `The pending approval ${approvalRef(approval.id, approval.version ?? 1)} is queued as an email notification. A decision requires either the authenticated Action Center → Approvals workflow or an exact governance-authorized, Clerk-verified email responder whose live authority is confirmed at processing.`,
      { idempotencyKey: `approval-notification:${approval.id}:event` },
    );
  } catch (err) {
    console.error(`[approver-email] notify failed for approval ${approval.id}:`, String(err));
  }
}

/* ------------------------------------------------------------------ */
/* Inbound: record a reply and send an explicit no-decision receipt    */
/* ------------------------------------------------------------------ */

export type ApplyReplyResult =
  | "not-approver"
  | "unverified-transport"
  | "not-authorized"
  | "no-ref"
  | "no-decision"
  | "not-found"
  | "already-decided"
  | "stale"
  | "decided";

export function emailDecisionDisabledReceipt(input: {
  approvalId: number;
  version: number;
  sourceMessageId: string;
}): { subject: string; body: string; idempotencyKey: string } {
  const reference = approvalRef(input.approvalId, input.version);
  return {
    subject: `[${reference}] Email reply received — no decision applied`,
    body: [
      `We received your email reply about ${reference}. No decision was applied.`,
      "",
      "This email did not pass the current authority checks, so it cannot approve or reject this onboarding review.",
      "Sign in to the same organization and open Action Center → Approvals, then locate this reference to submit a decision.",
      "This receipt does not claim source completion, a gateway release, or any provider action.",
    ].join("\n"),
    idempotencyKey: `approval-email-receipt:${input.sourceMessageId}`,
  };
}

export function emailDecisionRecordedReceipt(input: {
  approvalId: number;
  version: number;
  sourceMessageId: string;
  decision: ApproverDecision;
}): { subject: string; body: string; idempotencyKey: string } {
  const reference = approvalRef(input.approvalId, input.version);
  const label = input.decision === "approved" ? "approved" : "rejected";
  return {
    subject: `[${reference}] Email decision recorded — ${label}`,
    body: [
      `Your ${label} decision for ${reference} was recorded after current authority verification.`,
      "The decision was attributed to your verified member account, not to a mailbox persona.",
      "Sign in to the same organization and open Action Center → Approvals to review the recorded decision.",
    ].join("\n"),
    idempotencyKey: `approval-email-receipt:${input.sourceMessageId}`,
  };
}

/**
 * A remote decision is accepted only for an exact governance-authorized,
 * Clerk-verified current authority assignment and an independently verified
 * raw Gmail DKIM transport. Every other reply receives a durable no-decision
 * receipt and is handed off to the signed-in app.
 */
export async function applyApproverReply(opts: {
  organizationId: string;
  fromAddress: string;
  subject: string | null;
  bodyText: string;
  approver: string | null;
  sourceMessageId: string;
  /** Private branded proof made only from Gmail's raw RFC822 fetch. */
  transport?: VerifiedGmailDkimTransport | null;
}): Promise<{ outcome: ApplyReplyResult; approvalId: number | null }> {
  // 1. Delivery allowlist first. It is only an inbox-routing control; the
  // decision verifier separately binds the sender to a verified Clerk member.
  const configuredApprover = await approverEmailAddress(opts.organizationId);
  if (
    !senderIsApprover(opts.fromAddress, opts.approver) ||
    !senderIsApprover(opts.fromAddress, configuredApprover)
  ) {
    return { outcome: "not-approver", approvalId: null };
  }
  const text = `${opts.subject ?? ""}\n${opts.bodyText}`;
  const reference = matchApprovalVersionRef(text);
  if (reference === null) return { outcome: "no-ref", approvalId: null };
  const approvalId = reference.approvalId;

  const [a] = await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.id, approvalId),
    eq(onbApprovals.organizationId, opts.organizationId),
  ));
  if (!a) return { outcome: "not-found", approvalId };

  const decision = parseApproverDecision(opts.bodyText || (opts.subject ?? ""));
  if (!decision) {
    await enqueueEmailReplyNoDecisionReceipt({
      approval: a,
      sourceMessageId: opts.sourceMessageId,
      recipient: opts.fromAddress,
    });
    await logEvent(
      a.caseId, "channel", "system", "Approval email reply not understood",
      `An email reply referenced ${approvalRef(approvalId, reference.version)} but no unambiguous decision was applied.`,
      { idempotencyKey: `approval-email-received:${opts.sourceMessageId}` },
    );
    return { outcome: "no-decision", approvalId };
  }
  // Do not let a parsed From header, a Gmail query match, or an injected
  // Authentication-Results field represent sender identity. The branded proof
  // is generated only by DNS-backed DKIM verification of the raw RFC822 mail.
  if (!opts.transport) {
    await enqueueEmailReplyNoDecisionReceipt({
      approval: a,
      sourceMessageId: opts.sourceMessageId,
      recipient: opts.fromAddress,
    });
    await logEvent(
      a.caseId,
      "channel",
      "system",
      "Approval email reply requires signed-in handoff",
      `An email reply referenced ${approvalRef(approvalId, reference.version)} but raw Gmail DKIM transport identity was not verified; no decision was applied. The approver must use Action Center → Approvals.`,
      { idempotencyKey: `approval-email-received:${opts.sourceMessageId}` },
    );
    return { outcome: "unverified-transport", approvalId };
  }
  const result = await decideApproval({
    organizationId: opts.organizationId,
    approvalId,
    decision,
    expectedVersion: reference.version,
    // This untrusted display string is overwritten by decideApproval for an
    // authorized email decision with the verified Clerk personUserId.
    decidedBy: "email responder",
    comment: opts.bodyText ? opts.bodyText.slice(0, 500) : null,
    sourceMessageId: opts.sourceMessageId,
    sourceAddress: opts.fromAddress,
    decidedByKind: "human",
    responderEmail: opts.fromAddress,
    transport: opts.transport,
  });
  if (result.outcome === "decided") return { outcome: "decided", approvalId };
  if (result.outcome === "stale") {
    return { outcome: result.reason === "already-decided" ? "already-decided" : "stale", approvalId };
  }
  if (result.outcome === "not-found") return { outcome: "not-found", approvalId };
  await logEvent(
    a.caseId,
    "channel",
    "system",
    "Approval email reply received — no decision applied",
    `An email reply referenced ${approvalRef(approvalId, reference.version)} but current verified member authority was not established; no decision was applied.`,
    { idempotencyKey: `approval-email-received:${opts.sourceMessageId}` },
  );
  return { outcome: "not-authorized", approvalId };
}

/* ------------------------------------------------------------------ */
/* Poll loop                                                           */
/* ------------------------------------------------------------------ */

async function pollOnce(organizationId: string): Promise<void> {
  const approver = await approverEmailAddress(organizationId);
  if (!approver) return;

  const q = `in:inbox ${SEARCH_WINDOW} from:${approver} "AP-"`;
  const listResp = await connectors.proxy(
    "google-mail",
    `/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=25`,
    { method: "GET" },
  );
  if (!listResp.ok) {
    throw new Error(
      `Approver inbox search failed: ${listResp.status} ${(await listResp.text()).slice(0, 200)}`,
    );
  }
  const list = (await listResp.json()) as { messages?: Array<{ id: string }> };
  for (const ref of list.messages ?? []) {
    const msgResp = await connectors.proxy(
      "google-mail",
      `/gmail/v1/users/me/messages/${ref.id}?format=full`,
      { method: "GET" },
    );
    if (!msgResp.ok) continue; // transient — retried next poll (not yet recorded)
    const msg = (await msgResp.json()) as GmailMessage;

    const fromAddress = extractAddress(header(msg, "From"));
    const subject = header(msg, "Subject") || null;
    const bodyText = stripQuotedReply(findPlainText(msg.payload) ?? "");
    if (await alreadyRecorded(ref.id, organizationId)) continue;
    const reference = matchApprovalVersionRef(`${subject ?? ""}\n${bodyText}`);
    const decision = parseApproverDecision(bodyText || subject || "");
    let transport: VerifiedGmailDkimTransport | null = null;
    // The Gmail "full" projection is convenient for display/body parsing but
    // carries no cryptographic identity assertion. Fetch the provider's raw
    // RFC822 bytes separately and verify them against DNS before allowing a
    // remote decision.
    const rawResp = await connectors.proxy(
      "google-mail",
      `/gmail/v1/users/me/messages/${ref.id}?format=raw`,
      { method: "GET" },
    );
    if (rawResp.ok && reference && decision) {
      const rawMessage = (await rawResp.json()) as { id?: string; raw?: string };
      if (rawMessage.id === msg.id && typeof rawMessage.raw === "string") {
        try {
          transport = await verifyGmailApprovalTransport({
            rawMessage: Buffer.from(rawMessage.raw, "base64url").toString("utf8"),
            sourceMessageId: msg.id,
            expectedFromAddress: fromAddress,
            expectedReference: approvalRef(reference.approvalId, reference.version),
            expectedDecisionText: bodyText,
            expectedDecision: decision,
          });
        } catch {
          // Treat malformed raw source exactly like failed DNS/signature
          // evidence: do not decide remotely, hand off to the app.
          transport = null;
        }
      }
    }
    const { outcome, approvalId } = await applyApproverReply({
      organizationId,
      fromAddress,
      subject,
      bodyText,
      approver,
      sourceMessageId: msg.id,
      transport,
    });
    // Messages that can't belong to any approval are left unrecorded (they
    // may be a hire reply handled by the main inbound poller). Everything
    // else is recorded (apply-then-record) so the message is not reprocessed.
    if (outcome === "not-approver" || outcome === "no-ref" || outcome === "not-found") continue;

    const [a] = await db
      .select({
        caseId: onbApprovals.caseId,
        organizationId: onbApprovals.organizationId,
      })
      .from(onbApprovals)
      .where(and(
        eq(onbApprovals.id, approvalId!),
        eq(onbApprovals.organizationId, organizationId),
      ));
    if (!a) continue;
    // applyApproverReply durably queues exactly one source-message keyed
    // receipt before returning. Persisting inbound may safely happen after
    // that commit: a crash in between replays the stored outcome rather than
    // reevaluating an already-decided approval or creating another receipt.
    await persistInbound({
      caseId: a.caseId,
      organizationId,
      channel: "email",
      fromAddress,
      subject,
      body: (bodyText || subject || "").slice(0, 4000),
      externalMessageId: msg.id,
    });
    console.log(
      `[approver-email] reply from approver for AP-${approvalId!}: ${outcome} (gmail ${msg.id})`,
    );
  }
}

/**
 * One shared round of approver-inbox polling. Exposed for the autoscale
 * heartbeat (watcher-tick): on a frozen deployment the interval timer never
 * fires, so the heartbeat drives this tick instead. Never rejects.
 */
export const runApproverInboxTick = makeSharedTick(async () => {
  try {
    const organizations = await db
      .select({ organizationId: onbSettings.organizationId })
      .from(onbSettings)
      .where(eq(onbSettings.key, HR_APPROVER_EMAIL_KEY));
    for (const { organizationId } of organizations) await pollOnce(organizationId);
  } catch (err) {
    console.error("[approver-email] poll failed:", String(err).slice(0, 300));
  }
});

export function startApproverInboxPolling(): void {
  if (timer) return;
  const tick = () => void runApproverInboxTick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  void tick();
  console.log(
    `[approver-email] HR approver inbox polling started (every ${POLL_INTERVAL_MS / 1000}s)`,
  );
}
