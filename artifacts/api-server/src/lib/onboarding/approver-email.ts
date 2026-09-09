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
import { sendAdministrativeEmail } from "./channels";
import { getSetting, isValidEmail, HR_APPROVER_EMAIL_KEY } from "./settings";
import { logEvent, resumeAfterDecision } from "./engine";
import { makeSharedTick } from "./shared-tick";

/**
 * Remote HR approver over email — lets a demo volunteer play the
 * human-in-the-loop from their own inbox.
 *
 * Outbound: whenever the agent escalates (an approval is created) and an
 * HR approver address is configured in Settings, that person is emailed
 * the recommendation with a reference like [AP-42] and asked to reply
 * "approve" or "reject".
 *
 * Inbound: a dedicated Gmail poll searches for replies from that exact
 * sender. Trust and safety mirror the email status channel:
 *  - sender allowlist check FIRST — only the configured address (exact,
 *    case-insensitive) can ever decide anything; everyone else is ignored;
 *  - status-guarded: the decision is a conditional UPDATE that only
 *    transitions pending -> approved/rejected, so retries, duplicate
 *    deliveries and a concurrent in-app decision cannot double-apply;
 *  - apply-then-record: the state change happens first, then the Gmail
 *    message id is recorded (onb_communications.external_message_id) so
 *    later polls skip it — a crash in between re-applies harmlessly;
 *  - the audit trail records the decision as decided-by that person.
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

/** The reference the approver's reply must quote, e.g. "AP-42". */
export function approvalRef(approvalId: number): string {
  return `AP-${approvalId}`;
}

/** Extract the approval id from an "AP-<id>" reference in the text, or null. */
export function matchApprovalRef(text: string): number | null {
  const m = text.match(/\bAP-(\d{1,9})\b/i);
  return m ? Number(m[1]) : null;
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
  workerName: string;
  caseId: number;
  agent: string;
  hitlPattern: string;
  recommendation: string;
  rationale: string;
}): { subject: string; body: string } {
  const ref = approvalRef(opts.approvalId);
  const kind = opts.hitlPattern === "hard-block" ? "HARD-BLOCK" : "Approval needed";
  return {
    subject: `[${ref}] ${kind}: ${opts.workerName} (case #${opts.caseId})`,
    body: [
      `The onboarding agent has escalated a decision to you.`,
      ``,
      `Case: #${opts.caseId} — ${opts.workerName}`,
      `Raised by: ${opts.agent} agent (${opts.hitlPattern})`,
      ``,
      `Recommendation: ${opts.recommendation}`,
      `Rationale: ${opts.rationale}`,
      ``,
      `To decide, simply reply to this email with "approve" or "reject".`,
      `(Keep the reference ${ref} in the subject or body so your reply can be matched.)`,
      ``,
      `Only replies from this exact email address are honored.`,
    ].join("\n"),
  };
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
    const { subject, body } = composeApprovalEmail({
      approvalId: approval.id,
      workerName: c?.workerName ?? "worker",
      caseId: approval.caseId,
      agent: approval.agent,
      hitlPattern: approval.hitlPattern,
      recommendation: approval.recommendation,
      rationale: approval.rationale,
    });
    // Goes through sendOutbound so the established safe-delivery boundary
    // applies: recipient allowlist (the approver address is only on it
    // because it was explicitly saved in Settings), hourly live-send rate
    // limit, and the persisted communication row (whose stored Gmail
    // message id also keeps a same-account demo inbox from echoing this
    // notification back as an inbound reply).
    const result = await sendAdministrativeEmail({
      caseId: approval.caseId,
      toAddress: to,
      subject,
      body,
      idempotencyKey: `approval-notification:${approval.id}`,
    });
    await logEvent(
      approval.caseId,
      "channel",
      "system",
      result.status === "sent" ? "HR approver emailed" : "HR approver email failed",
      result.status === "sent"
        ? `The pending approval ${approvalRef(approval.id)} was emailed to the configured HR approver. A reply containing "approve" or "reject" from that address will decide it.`
        : `Emailing the HR approver about ${approvalRef(approval.id)} failed: ${result.failureReason ?? "unknown"}. The approval remains available in the in-app queue.`,
      { idempotencyKey: `approval-notification:${approval.id}:event` },
    );
  } catch (err) {
    console.error(`[approver-email] notify failed for approval ${approval.id}:`, String(err));
  }
}

/* ------------------------------------------------------------------ */
/* Inbound: apply a reply from the approver                            */
/* ------------------------------------------------------------------ */

export type ApplyReplyResult =
  | "not-approver"
  | "no-ref"
  | "no-decision"
  | "not-found"
  | "already-decided"
  | "decided";

/**
 * Apply one inbound email as an approval decision. Guards in order:
 * sender allowlist first, then reference match, then decision parse,
 * then the status-guarded conditional update. Idempotent — retries and
 * duplicates cannot decide twice.
 */
export async function applyApproverReply(opts: {
  organizationId: string;
  fromAddress: string;
  subject: string | null;
  bodyText: string;
  approver: string | null;
}): Promise<{ outcome: ApplyReplyResult; approvalId: number | null }> {
  // 1. Allowlist check FIRST — nobody but the configured approver may act.
  const configuredApprover = await approverEmailAddress(opts.organizationId);
  if (
    !senderIsApprover(opts.fromAddress, opts.approver) ||
    !senderIsApprover(opts.fromAddress, configuredApprover)
  ) {
    return { outcome: "not-approver", approvalId: null };
  }
  const text = `${opts.subject ?? ""}\n${opts.bodyText}`;
  const approvalId = matchApprovalRef(text);
  if (approvalId === null) return { outcome: "no-ref", approvalId: null };

  const decision = parseApproverDecision(opts.bodyText || (opts.subject ?? ""));

  const [a] = await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.id, approvalId),
    eq(onbApprovals.organizationId, opts.organizationId),
  ));
  if (!a) return { outcome: "not-found", approvalId };

  if (decision === null) {
    await logEvent(
      a.caseId,
      "channel",
      "system",
      "Approver reply not understood",
      `An email reply from the HR approver referenced ${approvalRef(approvalId)} but contained no clear "approve" or "reject" — no decision applied. They can reply again with a single clear word.`,
    );
    return { outcome: "no-decision", approvalId };
  }

  const decidedBy = `${opts.approver} (HR approver via email)`;
  // 2. Status-guarded conditional update: only transitions from pending,
  // so a concurrent in-app decision or a duplicate delivery cannot both win.
  const [updated] = await db
    .update(onbApprovals)
    .set({
      status: decision,
      decidedBy,
      comment: opts.bodyText ? opts.bodyText.slice(0, 500) : null,
      decidedAt: new Date(),
    })
    .where(and(
      eq(onbApprovals.id, approvalId),
      eq(onbApprovals.organizationId, opts.organizationId),
      eq(onbApprovals.status, "pending"),
    ))
    .returning();
  if (!updated) return { outcome: "already-decided", approvalId };

  resumeAfterDecision({
    caseId: a.caseId,
    approved: decision === "approved",
    decidedBy,
    comment: opts.bodyText ? opts.bodyText.slice(0, 500) : null,
    recommendation: a.recommendation,
    hitlPattern: a.hitlPattern,
    resumeAction: a.resumeAction ?? "none",
  });
  return { outcome: "decided", approvalId };
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

    const { outcome, approvalId } = await applyApproverReply({
      organizationId,
      fromAddress,
      subject,
      bodyText,
      approver,
    });
    // Messages that can't belong to any approval are left unrecorded (they
    // may be a hire reply handled by the main inbound poller). Everything
    // else is recorded (apply-then-record) so the message is not reprocessed.
    if (outcome === "not-approver" || outcome === "no-ref" || outcome === "not-found") continue;

    const [a] = await db
      .select({ caseId: onbApprovals.caseId, organizationId: onbApprovals.organizationId })
      .from(onbApprovals)
      .where(and(
        eq(onbApprovals.id, approvalId!),
        eq(onbApprovals.organizationId, organizationId),
      ));
    if (!a) continue;
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
      `[approver-email] reply from approver for ${approvalRef(approvalId!)}: ${outcome} (gmail ${msg.id})`,
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
