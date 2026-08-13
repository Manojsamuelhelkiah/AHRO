import { db } from "@workspace/db";
import {
  onbCases,
  onbCommunications,
  onbConnectors,
  onbEvents,
  onbSystemChecks,
  type OnbReadinessItemRow,
} from "@workspace/db/schema";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { autoEscalationCallsEnabled } from "./settings";
import {
  applicableSystems,
  completionAt,
  makeExternalRef,
  simulateVendorStatus,
  systemDef,
  WATCHED_SYSTEMS,
  type SystemDef,
  type WatchedSystem,
} from "./external-systems";
import { classifyMonitor, type MonitorState, type MonitorTelemetry } from "./inbound-email";
import { ensureConnectorsSeeded } from "./connectors";

/**
 * System Watcher agent.
 *
 * Monitors external-system checklist items (BGV clearance, ITSM access
 * provisioning, payroll setup) via the simulated vendor adapters:
 *  - push systems (BGV) deliver completion through the webhook code path;
 *  - poll systems (ITSM, payroll) are checked on a schedule.
 *
 * When a system reports done the watcher flips the matching case
 * readiness item to ready, logs a rules-tagged event, and promotes the
 * case to day1-review once every checklist item is ready. When a check
 * blows past its SLA (late/stuck, e.g. because the connector is
 * disconnected) it raises a rules-tagged escalation event exactly once.
 */

const POLL_INTERVAL_MS = 20_000;
export const WATCHER_AGENT = "system-watcher";

let timer: NodeJS.Timeout | null = null;
let ticking = false;

type SystemTelemetry = MonitorTelemetry & {
  /** push only: when the last vendor webhook was received */
  lastEventAt: Date | null;
  eventsReceived: number;
};

function freshTelemetry(): SystemTelemetry {
  return {
    running: false,
    startedAt: null,
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    lastEventAt: null,
    eventsReceived: 0,
  };
}

const telemetry: Record<WatchedSystem, SystemTelemetry> = {
  bgv: freshTelemetry(),
  itsm: freshTelemetry(),
  payroll: freshTelemetry(),
};

/** In-process timers simulating the BGV vendor's outbound webhooks. */
const scheduledPushes = new Map<number, NodeJS.Timeout>();

/* ------------------------------------------------------------------ */
/* Health classification                                               */
/* ------------------------------------------------------------------ */

export type SystemConnectorHealth = {
  key: WatchedSystem;
  label: string;
  mode: "push" | "poll";
  connectorKey: string;
  pollIntervalSeconds: number | null;
  running: boolean;
  state: MonitorState;
  healthy: boolean;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastEventAt: string | null;
  eventsReceived: number;
  lastError: string | null;
  lastErrorAt: string | null;
};

/**
 * Push adapters are "healthy" while the listener is registered and the
 * last delivery attempt didn't fail; poll adapters reuse the same
 * classification as the inbox monitor (never healthy before a first
 * successful poll, broken when stalled or failing).
 */
export function classifySystem(
  def: Pick<SystemDef, "mode">,
  s: SystemTelemetry,
  now: number,
  intervalMs = POLL_INTERVAL_MS,
): MonitorState {
  if (def.mode === "push") {
    if (!s.running) return "stopped";
    const failedLast =
      s.lastErrorAt !== null &&
      (s.lastSuccessAt === null || s.lastErrorAt > s.lastSuccessAt);
    return failedLast ? "broken" : "healthy";
  }
  return classifyMonitor(s, now, intervalMs);
}

function healthFor(def: SystemDef): SystemConnectorHealth {
  const s = telemetry[def.key];
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const state = classifySystem(def, s, Date.now());
  return {
    key: def.key,
    label: def.label,
    mode: def.mode,
    connectorKey: def.connectorKey,
    pollIntervalSeconds: def.mode === "poll" ? POLL_INTERVAL_MS / 1000 : null,
    running: s.running,
    state,
    healthy: state === "healthy",
    lastPollAt: iso(s.lastPollAt),
    lastSuccessAt: iso(s.lastSuccessAt),
    lastEventAt: iso(s.lastEventAt),
    eventsReceived: s.eventsReceived,
    lastError: s.lastError,
    lastErrorAt: iso(s.lastErrorAt),
  };
}

export function getSystemWatcherHealth(): SystemConnectorHealth[] {
  return WATCHED_SYSTEMS.map(healthFor);
}

/* ------------------------------------------------------------------ */
/* Case-side effects                                                   */
/* ------------------------------------------------------------------ */

async function logEvent(
  caseId: number,
  title: string,
  detail: string,
  ruleRef: string,
) {
  await db.insert(onbEvents).values({
    caseId,
    agent: WATCHER_AGENT,
    engine: "system",
    hitlPattern: "notify-only",
    ruleRef,
    title,
    detail,
  });
}

/** Close a check as done and update the case checklist. Idempotent. Exported for tests. */
export async function completeCheck(
  check: typeof onbSystemChecks.$inferSelect,
  source: "webhook push" | "scheduled poll" | "status email",
): Promise<void> {
  const def = systemDef(check.system);
  if (!def) return;

  // Guard against tracking-mode retag races: a completion may only land
  // through the channel the check is *currently* tracked on. If HR
  // switched a connector between API and email tracking after this
  // check was read, a stale poll result or already-fetched email must
  // not close it through the old channel.
  const expectedMode: Record<typeof source, string> = {
    "webhook push": "push",
    "scheduled poll": "poll",
    "status email": "email",
  };

  const noteBySystem: Record<WatchedSystem, string> = {
    bgv: `BGV cleared by vendor (${check.externalRef}) — statutory pack complete`,
    itsm: `Access provisioning completed in ITSM (${check.externalRef})`,
    payroll: `Payroll setup confirmed by payroll platform (${check.externalRef})`,
  };

  // One atomic unit: close the check AND flip the readiness item (plus
  // promotion + events). If anything fails the whole thing rolls back, so
  // a check can never be marked done while its readiness item is stuck.
  // The case row is locked FOR UPDATE because concurrent completions
  // (e.g. a BGV webhook and an ITSM poll at the same instant) both rewrite
  // the whole readiness JSON array — without serialization one write wins
  // and the other completion is silently lost.
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(onbSystemChecks)
      .set({
        status: "done",
        completedAt: new Date(),
        lastCheckedAt: new Date(),
        note: `Confirmed via ${source} (${check.externalRef})`,
      })
      .where(
        and(
          eq(onbSystemChecks.id, check.id),
          sql`${onbSystemChecks.status} in ('pending', 'overdue')`,
          eq(onbSystemChecks.mode, expectedMode[source]),
        ),
      )
      .returning();
    if (!updated) return; // already closed by a concurrent path

    const [c] = await tx
      .select()
      .from(onbCases)
      .where(eq(onbCases.id, check.caseId))
      .for("update");
    let promoted = false;
    if (c) {
      const readiness = c.readiness as OnbReadinessItemRow[];
      const item = readiness.find((r) => r.key === def.readinessKey);
      if (item) {
        item.status = "ready";
        item.note = noteBySystem[def.key];
        const allReady = readiness.every((r) => r.status === "ready");
        promoted = allReady && c.lifecycleStage === "preboarding";
        await tx
          .update(onbCases)
          .set({
            readiness,
            updatedAt: new Date(),
            ...(promoted ? { lifecycleStage: "day1-review" } : {}),
          })
          .where(eq(onbCases.id, check.caseId));
      }
    }

    const events = [
      {
        caseId: check.caseId,
        agent: WATCHER_AGENT,
        engine: "system" as const,
        hitlPattern: "notify-only",
        ruleRef: def.completionRuleRef,
        title: `${def.label} reported complete`,
        detail: `${def.label} (${check.externalRef}) reported done via ${source}. Checklist item "${def.readinessKey}" marked ready by the System Watcher.`,
      },
      ...(promoted
        ? [
            {
              caseId: check.caseId,
              agent: WATCHER_AGENT,
              engine: "system" as const,
              hitlPattern: "notify-only",
              ruleRef: "4.7 Readiness Rule 10",
              title: "All readiness checkpoints confirmed by source systems",
              detail:
                "Every checklist item is now ready — external systems have confirmed BGV, access and payroll where applicable. Case promoted to Day-1 review.",
            },
          ]
        : []),
    ];
    await tx.insert(onbEvents).values(events);
  });
}

/** Escalate a late/stuck check exactly once. Exported for the watch-mailbox tracker. */
export async function escalateCheck(
  check: typeof onbSystemChecks.$inferSelect,
  reason: string,
  expectedMode?: string,
): Promise<void> {
  const def = systemDef(check.system);
  if (!def) return;
  const [updated] = await db
    .update(onbSystemChecks)
    .set({ status: "overdue", escalatedAt: new Date(), note: reason })
    .where(
      and(
        eq(onbSystemChecks.id, check.id),
        eq(onbSystemChecks.status, "pending"),
        ...(expectedMode ? [eq(onbSystemChecks.mode, expectedMode)] : []),
      ),
    )
    .returning();
  if (!updated) return; // already escalated

  await logEvent(
    check.caseId,
    `${def.label} is late — SLA breached`,
    `${def.label} (${check.externalRef}) has not reported completion within its ${def.slaSeconds}s SLA. ${reason} Owner notified; the checklist item stays open until the source system confirms.`,
    def.slaRuleRef,
  );

  // Opt-in follow-through: place the escalation voice call automatically
  // when the hire has also gone quiet. Never allowed to break escalation
  // itself — the SLA event above must land even if calling fails.
  try {
    await maybeAutoEscalationCall(updated, def, reason);
  } catch (err) {
    console.error(
      `[system-watcher] auto escalation call failed for case ${check.caseId}:`,
      String(err).slice(0, 300),
    );
  }
}

/**
 * If the auto-call setting is on AND the hire has not sent any inbound
 * message (email/WhatsApp) since this check started tracking, place the
 * SLA escalation voice call. The voice module's own guardrails still
 * apply unchanged: recipient allowlist, one live call per case, and the
 * hourly live-call rate limit. Exported for tests.
 */
export async function maybeAutoEscalationCall(
  check: typeof onbSystemChecks.$inferSelect,
  def: SystemDef,
  reason: string,
): Promise<void> {
  if (!(await autoEscalationCallsEnabled())) return;

  // Has the hire replied on any messaging channel since we started
  // tracking this check? If so they're responsive — no surprise call.
  const [reply] = await db
    .select({ id: onbCommunications.id })
    .from(onbCommunications)
    .where(
      and(
        eq(onbCommunications.caseId, check.caseId),
        eq(onbCommunications.direction, "inbound"),
        ne(onbCommunications.channel, "voice"),
        gt(onbCommunications.createdAt, check.requestedAt),
      ),
    )
    .limit(1);
  if (reply) return;

  // Audit trail: record why the watcher is placing this call before dialing.
  await logEvent(
    check.caseId,
    "Automatic escalation call triggered",
    `${def.label} (${check.externalRef}) breached its SLA and the hire has not replied to any message since tracking began — auto escalation calls are enabled in Settings, so the System Watcher is placing the SLA escalation voice call. ${reason}`,
    def.slaRuleRef,
  );

  // Dynamic import keeps the watcher testable without pulling in the
  // voice/LLM stack, mirroring the channels import pattern in voice.ts.
  const { startVoiceCall } = await import("./voice");
  const result = await startVoiceCall({
    caseId: check.caseId,
    scenario: "sla-escalation",
    reason: `${def.label} (${check.externalRef}) is overdue: ${reason} The hire has not replied to recent messages, and automatic escalation calls are enabled.`,
  });

  // startVoiceCall logs its own events for "calling" and allowlist
  // withholds; record the outcome for the remaining failure paths.
  if (result.status === "failed") {
    await logEvent(
      check.caseId,
      "Automatic escalation call not placed",
      `The System Watcher tried to place the SLA escalation call but it was not placed: ${result.note}`,
      def.slaRuleRef,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Tracking registration                                               */
/* ------------------------------------------------------------------ */

/**
 * Start tracking the applicable external systems for a case. Called by
 * the engine when workstreams kick off; the watcher tick also calls it
 * for any preboarding case that has no checks yet (self-healing after
 * restarts or for pre-existing cases).
 */
export async function trackCaseSystems(caseId: number): Promise<void> {
  const [c] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
  if (!c) return;
  const now = new Date();
  const defs = applicableSystems(c);
  const emailTracked = await emailTrackedConnectors();
  for (const def of defs) {
    const useEmail = emailTracked.has(def.connectorKey);
    const mode = useEmail ? "email" : def.mode;
    const rows = await db
      .insert(onbSystemChecks)
      .values({
        caseId,
        system: def.key,
        mode,
        externalRef: makeExternalRef(def, caseId),
        status: "pending",
        requestedAt: now,
        dueAt: new Date(now.getTime() + def.slaSeconds * 1000),
      })
      .onConflictDoNothing({
        target: [onbSystemChecks.caseId, onbSystemChecks.system],
      })
      .returning({ id: onbSystemChecks.id });
    if (rows.length > 0) {
      await logEvent(
        caseId,
        `Watching ${def.label.toLowerCase()}`,
        `System Watcher is tracking ${def.label} (${makeExternalRef(def, caseId)}) via ${
          mode === "email"
            ? "the watch mailbox — vendor status emails quoting the reference"
            : def.mode === "push"
              ? "vendor webhook push"
              : `scheduled polling every ${POLL_INTERVAL_MS / 1000}s`
        }; SLA ${def.slaSeconds}s.`,
        def.completionRuleRef,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Webhook push path (BGV)                                             */
/* ------------------------------------------------------------------ */

/**
 * Shared handler for vendor status webhooks. The HTTP route and the
 * simulated in-process vendor both call this — same code path a real
 * BGV vendor's push notification would take.
 */
export async function handleSystemWebhook(opts: {
  system: string;
  caseId: number;
  status: string;
}): Promise<{ ok: boolean; message: string }> {
  const def = systemDef(opts.system);
  if (!def) return { ok: false, message: `Unknown system "${opts.system}"` };
  // Poll-mode systems (ITSM, payroll) do not push — only the scheduled
  // poller may complete them. Accepting them here would let anyone with
  // the shared webhook token bypass polling and mark items ready.
  if (def.mode !== "push") {
    return {
      ok: false,
      message: `System "${def.key}" reports via scheduled polling, not webhooks`,
    };
  }
  const t = telemetry[def.key];
  try {
    const [check] = await db
      .select()
      .from(onbSystemChecks)
      .where(
        and(
          eq(onbSystemChecks.caseId, opts.caseId),
          eq(onbSystemChecks.system, def.key),
        ),
      );
    if (!check) return { ok: false, message: "No tracked check for this case" };
    t.lastEventAt = new Date();
    t.eventsReceived += 1;
    if (opts.status === "completed") {
      await completeCheck(check, "webhook push");
      t.lastSuccessAt = new Date();
      t.lastError = null;
      t.lastErrorAt = null;
    }
    return { ok: true, message: "Processed" };
  } catch (err) {
    t.lastError = String(err).slice(0, 300);
    t.lastErrorAt = new Date();
    return { ok: false, message: t.lastError };
  }
}

/** Schedule the simulated BGV vendor's push for a pending check. */
function schedulePush(check: typeof onbSystemChecks.$inferSelect): void {
  const def = systemDef(check.system);
  if (!def || def.mode !== "push") return;
  if (scheduledPushes.has(check.id)) return;
  const delay = Math.max(
    0,
    completionAt(def, check.requestedAt, check.caseId).getTime() - Date.now(),
  );
  const handle = setTimeout(() => {
    scheduledPushes.delete(check.id);
    void (async () => {
      // Vendor only pushes while its connector is connected.
      const connected = await connectorConnected(def.connectorKey);
      if (!connected) return; // re-scheduled by the tick once reconnected
      await handleSystemWebhook({
        system: def.key,
        caseId: check.caseId,
        status: "completed",
      });
      console.log(
        `[system-watcher] simulated ${def.label} webhook delivered for case ${check.caseId} (${check.externalRef})`,
      );
    })();
  }, delay);
  handle.unref?.();
  scheduledPushes.set(check.id, handle);
}

/** Connector keys currently switched to email (watch-mailbox) tracking. */
export async function emailTrackedConnectors(): Promise<Set<string>> {
  const rows = await db
    .select({ key: onbConnectors.key })
    .from(onbConnectors)
    .where(eq(onbConnectors.trackingMode, "email"));
  return new Set(rows.map((r) => r.key));
}

async function connectorConnected(connectorKey: string): Promise<boolean> {
  const [row] = await db
    .select({ status: onbConnectors.status })
    .from(onbConnectors)
    .where(eq(onbConnectors.key, connectorKey));
  return row?.status === "connected";
}

/* ------------------------------------------------------------------ */
/* Poll loop                                                           */
/* ------------------------------------------------------------------ */

async function openChecks() {
  return db
    .select()
    .from(onbSystemChecks)
    .where(sql`${onbSystemChecks.status} in ('pending', 'overdue')`);
}

async function tickOnce(): Promise<void> {
  const now = Date.now();
  await ensureConnectorsSeeded();

  // Self-heal: preboarding cases that somehow have no checks yet.
  const untracked = await db
    .select({ id: onbCases.id })
    .from(onbCases)
    .where(
      sql`${onbCases.lifecycleStage} in ('preboarding', 'day1-review')
          and not exists (select 1 from ${onbSystemChecks} sc where sc.case_id = ${onbCases.id})`,
    );
  for (const c of untracked) await trackCaseSystems(c.id);

  const checks = await openChecks();

  // Push systems: (re-)schedule the simulated vendor webhook.
  for (const check of checks) {
    if (check.mode === "push") schedulePush(check);
  }

  // Poll systems: call the simulated vendor status API.
  for (const def of WATCHED_SYSTEMS.filter((d) => d.mode === "poll")) {
    const t = telemetry[def.key];
    t.lastPollAt = new Date();
    try {
      const mine = checks.filter((c) => c.system === def.key && c.mode === "poll");
      const connected = await connectorConnected(def.connectorKey);
      if (!connected) {
        throw new Error(
          `${def.label} connector ("${def.connectorKey}") is disconnected — status API unreachable`,
        );
      }
      for (const check of mine) {
        await db
          .update(onbSystemChecks)
          .set({ lastCheckedAt: new Date() })
          .where(eq(onbSystemChecks.id, check.id));
        const status = simulateVendorStatus(def, check.requestedAt, check.caseId, now);
        if (status === "completed") {
          await completeCheck(check, "scheduled poll");
        }
      }
      t.lastSuccessAt = new Date();
      t.lastError = null;
      t.lastErrorAt = null;
    } catch (err) {
      t.lastError = String(err).slice(0, 300);
      t.lastErrorAt = new Date();
      console.error(`[system-watcher] ${def.key} poll failed:`, t.lastError);
    }
  }

  // SLA sweep across every mode: late or stuck → escalate once.
  for (const check of await openChecks()) {
    if (check.status !== "pending") continue;
    if (now <= check.dueAt.getTime()) continue;
    const def = systemDef(check.system);
    if (!def) continue;
    if (check.mode === "email") {
      await escalateCheck(
        check,
        `No status email quoting ${check.externalRef} has arrived in the watch mailbox.`,
      );
      continue;
    }
    const connected = await connectorConnected(def.connectorKey);
    await escalateCheck(
      check,
      connected
        ? `The ${def.mode === "push" ? "vendor has not pushed a completion webhook" : "vendor status API still reports in-progress"}.`
        : `The ${def.label} connector is disconnected, so no status updates are arriving.`,
    );
  }
}

export function startSystemWatcher(): void {
  if (timer) return;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tickOnce();
    } catch (err) {
      console.error("[system-watcher] tick failed:", String(err).slice(0, 300));
    } finally {
      ticking = false;
    }
  };
  const startedAt = new Date();
  for (const def of WATCHED_SYSTEMS) {
    telemetry[def.key].running = true;
    telemetry[def.key].startedAt = startedAt;
    if (def.mode === "push") {
      // Listener registered: the push channel is live even before events.
      telemetry[def.key].lastSuccessAt = startedAt;
    }
  }
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  void tick();
  console.log(
    `[system-watcher] watching ${WATCHED_SYSTEMS.map((s) => `${s.key} (${s.mode})`).join(", ")} every ${POLL_INTERVAL_MS / 1000}s`,
  );
}
