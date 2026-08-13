import { db } from "@workspace/db";
import { onbCases, onbCommunications, onbEvents } from "@workspace/db/schema";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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

/**
 * Outage alerting: after FAILURE_ALERT_THRESHOLD consecutive poll failures,
 * write one system-level event (caseId null) into the audit feed so the
 * dashboard surfaces the outage; write a recovery event when polling succeeds
 * again. Exactly one alert per outage — the flag resets only on success.
 */
const FAILURE_ALERT_THRESHOLD = 3;

export type OutageDecision = "none" | "alert" | "recover";

/** Pure outage-alert state machine (exported for tests). */
export function createOutageTracker(threshold: number = FAILURE_ALERT_THRESHOLD) {
  let consecutiveFailures = 0;
  let alerted = false;
  return {
    recordSuccess(): OutageDecision {
      consecutiveFailures = 0;
      if (alerted) {
        alerted = false;
        return "recover";
      }
      return "none";
    },
    recordFailure(): { decision: OutageDecision; consecutiveFailures: number } {
      consecutiveFailures += 1;
      if (consecutiveFailures >= threshold && !alerted) {
        alerted = true;
        return { decision: "alert", consecutiveFailures };
      }
      return { decision: "none", consecutiveFailures };
    },
  };
}

const outageTracker = createOutageTracker();

export const MONITOR_DOWN_TITLE = "Inbox monitoring is down";
export const MONITOR_RECOVERED_TITLE = "Inbox monitoring recovered";

/**
 * Durable dedup: decide whether to write a down/recovered event given the
 * in-process decision and the most recent monitor event already persisted.
 * This keeps "one alert per outage" true across server restarts — a restart
 * mid-outage must not produce a second down event, and the first success
 * after a restart must still record the recovery. Pure, exported for tests.
 */
export function planMonitorEventWrite(
  decision: OutageDecision | "startup-success",
  latestDurableTitle: string | null,
): "down" | "recovered" | null {
  if (decision === "alert") {
    return latestDurableTitle === MONITOR_DOWN_TITLE ? null : "down";
  }
  if (decision === "recover" || decision === "startup-success") {
    return latestDurableTitle === MONITOR_DOWN_TITLE ? "recovered" : null;
  }
  return null;
}

/** Title of the most recent persisted monitor event, or null. */
async function latestMonitorEventTitle(): Promise<string | null> {
  try {
    const [row] = await db
      .select({ title: onbEvents.title })
      .from(onbEvents)
      .where(
        and(
          isNull(onbEvents.caseId),
          eq(onbEvents.engine, "system"),
          inArray(onbEvents.title, [MONITOR_DOWN_TITLE, MONITOR_RECOVERED_TITLE]),
        ),
      )
      .orderBy(desc(onbEvents.createdAt), desc(onbEvents.id))
      .limit(1);
    return row?.title ?? null;
  } catch (err) {
    console.error("[onboarding inbound-email] failed to read monitor events:", String(err));
    return null;
  }
}

async function logMonitorEvent(title: string, detail: string): Promise<void> {
  try {
    await db.insert(onbEvents).values({
      caseId: null,
      agent: "channel",
      engine: "system",
      hitlPattern: "notify-only",
      title,
      detail,
    });
  } catch (err) {
    // Never let alerting break the poll loop itself.
    console.error("[onboarding inbound-email] failed to record monitor event:", String(err));
  }
}

/** Health telemetry for the poller, surfaced on the control tower. */
const monitorStatus = {
  running: false,
  startedAt: null as Date | null,
  lastPollAt: null as Date | null,
  lastSuccessAt: null as Date | null,
  lastError: null as string | null,
  lastErrorAt: null as Date | null,
};

export type MonitorTelemetry = typeof monitorStatus;

export type MonitorState = "healthy" | "initializing" | "broken" | "stopped";

export type InboundEmailMonitorStatus = {
  running: boolean;
  pollIntervalSeconds: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  state: MonitorState;
  healthy: boolean;
};

/**
 * Pure health classification (exported for tests):
 * - stopped: the loop was never started in this process
 * - broken: the most recent completed poll failed, or no poll has
 *   succeeded within three intervals (stalled loop / hung first poll)
 * - initializing: started recently, no poll has completed yet
 * - healthy: a poll succeeded recently and nothing failed since
 * A poller that has never proven itself with a successful poll is never
 * reported healthy.
 */
export function classifyMonitor(
  s: MonitorTelemetry,
  now: number,
  intervalMs: number = POLL_INTERVAL_MS,
): MonitorState {
  if (!s.running) return "stopped";
  const staleMs = intervalMs * 3;
  const failedLast =
    s.lastErrorAt !== null &&
    (s.lastSuccessAt === null || s.lastErrorAt > s.lastSuccessAt);
  if (failedLast) return "broken";
  if (s.lastSuccessAt !== null) {
    return now - s.lastSuccessAt.getTime() > staleMs ? "broken" : "healthy";
  }
  // Never succeeded: still initializing within the staleness window
  // (measured from start), broken once that window is exceeded — this
  // catches a first poll that hangs forever.
  const since = s.startedAt ? now - s.startedAt.getTime() : Infinity;
  return since > staleMs ? "broken" : "initializing";
}

export function getInboundEmailMonitorStatus(): InboundEmailMonitorStatus {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const state = classifyMonitor(monitorStatus, Date.now());
  return {
    running: monitorStatus.running,
    pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
    lastPollAt: iso(monitorStatus.lastPollAt),
    lastSuccessAt: iso(monitorStatus.lastSuccessAt),
    lastError: monitorStatus.lastError,
    lastErrorAt: iso(monitorStatus.lastErrorAt),
    state,
    healthy: state === "healthy",
  };
}

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

export type DetailFetchResult = { ok: boolean; json: () => Promise<unknown> };

export type ProcessDeps = {
  fetchDetail: (id: string) => Promise<DetailFetchResult>;
  alreadyRecorded: (id: string) => Promise<boolean>;
  recordInbound: (opts: InboundMessage) => Promise<boolean>;
};

/**
 * Process a page of Gmail message refs. Returns how many message-detail
 * fetches failed so the caller can fail the poll — silently skipping them
 * would leave the monitor "healthy" while replies are not being picked up.
 * Deps are injectable for tests.
 */
export async function processMessageRefs(
  refs: Array<{ id: string }>,
  caseByEmail: Map<string, number>,
  deps: ProcessDeps,
): Promise<number> {
  let detailFailures = 0;
  for (const ref of refs) {
    if (await deps.alreadyRecorded(ref.id)) continue;

    const msgResp = await deps.fetchDetail(ref.id);
    if (!msgResp.ok) {
      detailFailures += 1;
      continue;
    }
    const msg = (await msgResp.json()) as GmailMessage;

    const fromAddress = extractAddress(header(msg, "From"));
    const caseId = caseByEmail.get(fromAddress);
    if (!caseId) continue;

    const raw = findPlainText(msg.payload) ?? "";
    const body = stripQuotedReply(raw);
    if (!body) continue;

    const recorded = await deps.recordInbound({
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
  return detailFailures;
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
  const refs = list.messages ?? [];
  const detailFailures = await processMessageRefs(refs, caseByEmail, {
    fetchDetail: (id) =>
      connectors.proxy("google-mail", `/gmail/v1/users/me/messages/${id}?format=full`, {
        method: "GET",
      }),
    alreadyRecorded,
    recordInbound,
  });
  if (detailFailures > 0) {
    throw new Error(
      `Gmail message detail fetch failed for ${detailFailures} of ${refs.length} messages`,
    );
  }
}

let startupRecoveryChecked = false;

export function startInboundEmailPolling(): void {
  if (timer) return;
  const tick = async () => {
    if (polling) return;
    polling = true;
    monitorStatus.lastPollAt = new Date();
    try {
      await pollOnce();
      monitorStatus.lastSuccessAt = new Date();
      monitorStatus.lastError = null;
      monitorStatus.lastErrorAt = null;
      const decision = outageTracker.recordSuccess();
      // On the first success after startup, also check durable state: if the
      // process died mid-outage, the persisted down event still needs its
      // recovery event even though this process never alerted.
      if (decision === "recover" || !startupRecoveryChecked) {
        startupRecoveryChecked = true;
        const write = planMonitorEventWrite(
          decision === "recover" ? "recover" : "startup-success",
          await latestMonitorEventTitle(),
        );
        if (write === "recovered") {
          await logMonitorEvent(
            MONITOR_RECOVERED_TITLE,
            "The Gmail reply monitor is polling successfully again. Replies from hires are being picked up.",
          );
        }
      }
    } catch (err) {
      monitorStatus.lastError = String(err).slice(0, 300);
      monitorStatus.lastErrorAt = new Date();
      console.error("[onboarding inbound-email] poll failed:", monitorStatus.lastError);
      const { decision, consecutiveFailures } = outageTracker.recordFailure();
      if (decision === "alert") {
        // Durable dedup: a restart mid-outage must not write a second alert.
        const write = planMonitorEventWrite("alert", await latestMonitorEventTitle());
        if (write === "down") {
          await logMonitorEvent(
            MONITOR_DOWN_TITLE,
            `The Gmail reply monitor has failed ${consecutiveFailures} polls in a row. Replies from hires are NOT being picked up. Latest error: ${monitorStatus.lastError}`,
          );
        }
      }
    } finally {
      polling = false;
    }
  };
  monitorStatus.running = true;
  monitorStatus.startedAt = new Date();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  void tick();
  console.log(`[onboarding inbound-email] Gmail inbox polling started (every ${POLL_INTERVAL_MS / 1000}s)`);
}
