import { db } from "@workspace/db";
import {
  onbCases,
  onbSystemChecks,
  onbWatchEmails,
} from "@workspace/db/schema";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { desc, eq, sql } from "drizzle-orm";
import {
  classifyMonitor,
  extractAddress,
  findPlainText,
  header,
  stripQuotedReply,
  type GmailMessage,
  type MonitorState,
  type MonitorTelemetry,
} from "./inbound-email";
import { completeCheck, escalateCheck } from "./system-watcher";
import { recordGuardrailEvent } from "./guardrails";
import { makeSharedTick } from "./shared-tick";
import { systemDef } from "./external-systems";

/**
 * Watch-mailbox tracker — the System Watcher's "shallow integration"
 * channel. When a vendor or client system can't give us an API or
 * webhook, humans (or the system's own notification emails) simply CC
 * the connected Gmail watch mailbox. Every status email quoting a
 * tracked check's external reference (e.g. "RITM-1042") becomes a
 * status change:
 *
 *  - completed-sounding emails close the check and flip the readiness
 *    item, exactly like a webhook would;
 *  - exception-sounding emails escalate the check for human review;
 *  - anything else is logged as a progress update on the audit trail.
 *
 * Processing is idempotent and retry-safe: the state change is applied
 * first (each apply is itself guarded on the check's current status and
 * mode), then the Gmail message id is recorded in onb_watch_emails so
 * later polls skip it. If the process dies between the two, the retry
 * re-applies harmlessly and then records.
 *
 * Trust: email is an unauthenticated channel, so status-changing emails
 * are only honored from trusted senders. Set WATCH_EMAIL_TRUSTED_SENDERS
 * to a comma-separated list of addresses and/or domains (e.g.
 * "status@vendor.com, vendor-notifications.example"). Emails from other
 * senders are logged on the audit trail but never complete or escalate
 * a check. If the variable is unset, no external sender is trusted —
 * only the in-app demo simulator can change state.
 */

const connectors = new ReplitConnectors();

export const POLL_INTERVAL_MS = 30_000;
const SEARCH_WINDOW = "newer_than:2d";

let timer: NodeJS.Timeout | null = null;

const telemetry: MonitorTelemetry = {
  running: false,
  startedAt: null,
  lastPollAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastErrorAt: null,
};

let cachedMailbox: string | null = null;

/** The Gmail address vendors should CC status emails to. Cached. */
export async function watchMailboxAddress(): Promise<string | null> {
  if (cachedMailbox) return cachedMailbox;
  try {
    const resp = await connectors.proxy(
      "google-mail",
      "/gmail/v1/users/me/profile",
      { method: "GET" },
    );
    if (!resp.ok) return null;
    const profile = (await resp.json()) as { emailAddress?: string };
    cachedMailbox = profile.emailAddress ?? null;
    return cachedMailbox;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Status parsing                                                      */
/* ------------------------------------------------------------------ */

export type ParsedStatus = "completed" | "exception" | "update";

const EXCEPTION_RE =
  /\b(exception\w*|discrepanc\w*|fail(ed|ure)?|reject(ed|ion)?|unable|declined|on hold|blocked|escalat\w*|adverse|issue found)\b/i;
const COMPLETED_RE =
  /\b(completed?|cleared?|closed|resolved|provisioned|approved|done|finished|success(ful(ly)?)?|activated|verified|processed)\b/i;

/**
 * Deterministic keyword classification of a vendor status email.
 * Exception wins over completed ("verification completed with
 * exceptions" must block, not clear).
 */
export function parseStatusEmail(text: string): ParsedStatus {
  if (EXCEPTION_RE.test(text)) return "exception";
  if (COMPLETED_RE.test(text)) return "completed";
  return "update";
}

/** Find which open check's external ref is quoted in the email. Exported for tests. */
export function matchCheckByRef<T extends { externalRef: string }>(
  checks: T[],
  text: string,
): T | undefined {
  const upper = text.toUpperCase();
  return checks.find((c) => upper.includes(c.externalRef.toUpperCase()));
}

/* ------------------------------------------------------------------ */
/* Applying a matched email                                            */
/* ------------------------------------------------------------------ */

type OpenCheck = typeof onbSystemChecks.$inferSelect;

/** Is this sender allowed to change check state via email? */
export function senderTrusted(
  fromAddress: string,
  allowlist = process.env.WATCH_EMAIL_TRUSTED_SENDERS ?? "",
): boolean {
  const from = fromAddress.trim().toLowerCase();
  const domain = from.split("@")[1] ?? "";
  return allowlist
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => (entry.includes("@") ? entry === from : entry === domain));
}

/**
 * Apply + record one status email. The state change happens first —
 * each apply is guarded on the check's *current* status AND mode, so
 * retries and tracking-mode switches are safe — then the unique Gmail
 * id is recorded so later polls skip the message. Returns the action
 * taken, or null when the message was already recorded.
 *
 * `trusted: true` is only set by the internal demo simulator; real
 * emails are checked against WATCH_EMAIL_TRUSTED_SENDERS.
 */
export async function applyWatchEmail(opts: {
  gmailMessageId: string;
  check: OpenCheck;
  fromAddress: string;
  subject: string | null;
  bodyText: string;
  trusted?: boolean;
}): Promise<string | null> {
  const [seen] = await db
    .select({ id: onbWatchEmails.id })
    .from(onbWatchEmails)
    .where(eq(onbWatchEmails.gmailMessageId, opts.gmailMessageId));
  if (seen) return null; // already processed

  const trusted = opts.trusted ?? senderTrusted(opts.fromAddress);
  const parsed = parseStatusEmail(`${opts.subject ?? ""}\n${opts.bodyText}`);
  const def = systemDef(opts.check.system);
  const label = def?.label ?? opts.check.system;

  // Re-fetch so the recorded action reflects the check's CURRENT state
  // (it may have been closed or retagged since it was read).
  const [current] = await db
    .select()
    .from(onbSystemChecks)
    .where(eq(onbSystemChecks.id, opts.check.id));
  const applicable =
    current !== undefined &&
    current.mode === "email" &&
    (current.status === "pending" || current.status === "overdue");

  const action = !trusted
    ? `Ignored — sender not on the trusted list (no status change applied)`
    : !applicable
      ? `Ignored — ${label} is no longer tracked by email or already closed`
      : parsed === "completed"
        ? `Marked ${label} complete — readiness item updated`
        : parsed === "exception"
          ? `Escalated ${label} for human review (exception reported)`
          : `Logged as progress update — ${label} still pending`;

  if (!trusted) {
    void recordGuardrailEvent({
      caseId: opts.check.caseId,
      key: "trusted-vendor-sender",
      action: "rejected",
      detail: `Status email for ${label} from an untrusted sender was ignored — no check state changed.`,
    });
  }
  if (trusted && applicable) {
    if (parsed === "completed") {
      await completeCheck(opts.check, "status email");
    } else if (parsed === "exception") {
      await escalateCheck(
        opts.check,
        `A status email from ${opts.fromAddress} reported an exception for ${opts.check.externalRef}: "${(opts.subject ?? opts.bodyText).slice(0, 120)}".`,
        "email",
      );
    } else {
      await db
        .update(onbSystemChecks)
        .set({ lastCheckedAt: new Date() })
        .where(eq(onbSystemChecks.id, opts.check.id));
    }
  }

  const rows = await db
    .insert(onbWatchEmails)
    .values({
      gmailMessageId: opts.gmailMessageId,
      checkId: opts.check.id,
      caseId: opts.check.caseId,
      system: opts.check.system,
      fromAddress: opts.fromAddress,
      subject: opts.subject,
      snippet: opts.bodyText.slice(0, 300),
      parsedStatus: parsed,
      action,
    })
    .onConflictDoNothing({ target: onbWatchEmails.gmailMessageId })
    .returning({ id: onbWatchEmails.id });
  if (rows.length === 0) return null; // lost a race with a concurrent apply

  return action;
}

/* ------------------------------------------------------------------ */
/* Poll loop                                                           */
/* ------------------------------------------------------------------ */

async function openEmailChecks(): Promise<OpenCheck[]> {
  return db
    .select()
    .from(onbSystemChecks)
    .where(
      sql`${onbSystemChecks.mode} = 'email' and ${onbSystemChecks.status} in ('pending', 'overdue')`,
    );
}

async function pollOnce(): Promise<void> {
  const checks = await openEmailChecks();
  if (checks.length === 0) return;

  const refClause = checks.map((c) => `"${c.externalRef}"`).join(" OR ");
  const q = `in:inbox ${SEARCH_WINDOW} (${refClause})`;
  const listResp = await connectors.proxy(
    "google-mail",
    `/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=25`,
    { method: "GET" },
  );
  if (!listResp.ok) {
    throw new Error(
      `Watch-mailbox search failed: ${listResp.status} ${(await listResp.text()).slice(0, 200)}`,
    );
  }
  const list = (await listResp.json()) as { messages?: Array<{ id: string }> };
  let detailFailures = 0;
  for (const ref of list.messages ?? []) {
    const [seen] = await db
      .select({ id: onbWatchEmails.id })
      .from(onbWatchEmails)
      .where(eq(onbWatchEmails.gmailMessageId, ref.id));
    if (seen) continue;

    const msgResp = await connectors.proxy(
      "google-mail",
      `/gmail/v1/users/me/messages/${ref.id}?format=full`,
      { method: "GET" },
    );
    if (!msgResp.ok) {
      detailFailures += 1;
      continue;
    }
    const msg = (await msgResp.json()) as GmailMessage;
    const subject = header(msg, "Subject") || null;
    const body = stripQuotedReply(findPlainText(msg.payload) ?? "");
    const check = matchCheckByRef(checks, `${subject ?? ""}\n${body}`);
    if (!check) continue;

    const action = await applyWatchEmail({
      gmailMessageId: msg.id,
      check,
      fromAddress: extractAddress(header(msg, "From")),
      subject,
      bodyText: body,
    });
    if (action) {
      console.log(
        `[email-watch] ${check.externalRef} (case ${check.caseId}): ${action} (gmail ${msg.id})`,
      );
    }
  }
  if (detailFailures > 0) {
    throw new Error(
      `Watch-mailbox detail fetch failed for ${detailFailures} messages`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Demo: simulated vendor status email                                 */
/* ------------------------------------------------------------------ */

/**
 * Inject a synthetic vendor status email through the exact same
 * parse-and-apply path a real watched email takes — for live demos
 * without a real vendor mailbox.
 */
export async function simulateVendorEmail(opts: {
  caseId: number;
  system: string;
  outcome: "completed" | "exception";
}): Promise<{ ok: boolean; message: string }> {
  const [check] = await db
    .select()
    .from(onbSystemChecks)
    .where(
      sql`${onbSystemChecks.caseId} = ${opts.caseId} and ${onbSystemChecks.system} = ${opts.system}`,
    );
  if (!check)
    return { ok: false, message: "No tracked check for this case/system" };
  if (check.mode !== "email") {
    return {
      ok: false,
      message: `${check.system} is tracked via ${check.mode === "push" ? "webhook" : "API polling"} for this case — switch its connector to email tracking first`,
    };
  }
  if (check.status === "done") {
    return { ok: false, message: "Check is already complete" };
  }
  const def = systemDef(check.system);
  const [c] = await db
    .select({ workerName: onbCases.workerName })
    .from(onbCases)
    .where(eq(onbCases.id, check.caseId));
  const subject =
    opts.outcome === "completed"
      ? `[${check.externalRef}] ${def?.label ?? check.system} completed for ${c?.workerName ?? "worker"}`
      : `[${check.externalRef}] Exception raised on ${def?.label ?? check.system} for ${c?.workerName ?? "worker"}`;
  const bodyText =
    opts.outcome === "completed"
      ? `Automated status notification: reference ${check.externalRef} has been completed and cleared. No further action required.`
      : `Automated status notification: reference ${check.externalRef} could not be processed — an exception was raised and requires review.`;

  const action = await applyWatchEmail({
    gmailMessageId: `simulated-${check.id}-${Date.now()}`,
    check,
    fromAddress: "no-reply@vendor-notifications.example",
    subject,
    bodyText,
    trusted: true, // internal demo path — not a real inbound email
  });
  return { ok: true, message: action ?? "Duplicate — already processed" };
}

/* ------------------------------------------------------------------ */
/* Status + startup                                                    */
/* ------------------------------------------------------------------ */

export type EmailWatchStatus = {
  running: boolean;
  state: MonitorState;
  healthy: boolean;
  pollIntervalSeconds: number;
  mailbox: string | null;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  openChecks: number;
  recent: Array<{
    id: number;
    caseId: number | null;
    system: string;
    fromAddress: string;
    subject: string | null;
    snippet: string | null;
    parsedStatus: string;
    action: string;
    receivedAt: string;
  }>;
};

export async function getEmailWatchStatus(): Promise<EmailWatchStatus> {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const state = classifyMonitor(telemetry, Date.now(), POLL_INTERVAL_MS);
  const [openCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(onbSystemChecks)
    .where(
      sql`${onbSystemChecks.mode} = 'email' and ${onbSystemChecks.status} in ('pending', 'overdue')`,
    );
  const recent = await db
    .select()
    .from(onbWatchEmails)
    .orderBy(desc(onbWatchEmails.id))
    .limit(20);
  return {
    running: telemetry.running,
    state,
    healthy: state === "healthy",
    pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
    mailbox: await watchMailboxAddress(),
    lastPollAt: iso(telemetry.lastPollAt),
    lastSuccessAt: iso(telemetry.lastSuccessAt),
    lastError: telemetry.lastError,
    lastErrorAt: iso(telemetry.lastErrorAt),
    openChecks: openCount?.n ?? 0,
    recent: recent.map((r) => ({
      id: r.id,
      caseId: r.caseId,
      system: r.system,
      fromAddress: r.fromAddress,
      subject: r.subject,
      snippet: r.snippet,
      parsedStatus: r.parsedStatus,
      action: r.action,
      receivedAt: r.receivedAt.toISOString(),
    })),
  };
}

/**
 * Run one watch-mailbox poll on demand (same telemetry accounting as the
 * interval tick). Never throws; when a poll is already in flight the
 * caller awaits it (returning false), so a completed poll has always
 * happened by the time the promise resolves.
 */
export const runEmailWatchTick = makeSharedTick(async () => {
  telemetry.lastPollAt = new Date();
  try {
    await pollOnce();
    telemetry.lastSuccessAt = new Date();
    telemetry.lastError = null;
    telemetry.lastErrorAt = null;
  } catch (err) {
    telemetry.lastError = String(err).slice(0, 300);
    telemetry.lastErrorAt = new Date();
    console.error("[email-watch] poll failed:", telemetry.lastError);
  }
});

export function startEmailWatch(): void {
  if (timer) return;
  const tick = () => void runEmailWatchTick();
  telemetry.running = true;
  telemetry.startedAt = new Date();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  void tick();
  console.log(
    `[email-watch] watch-mailbox tracker started (every ${POLL_INTERVAL_MS / 1000}s)`,
  );
}
