import { db } from "@workspace/db";
import {
  onbCases,
  onbConnectors,
  onbEvents,
  type OnbReadinessItemRow,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

/**
 * System Watcher agent — monitors external systems of record (BGV, ITSM /
 * ServiceNow, payroll, e-signature, LMS, HRIS, IAM) for the status of open
 * checklist items and reconciles the case checklist automatically.
 *
 * Real-world access patterns this mirrors:
 *  - push (webhooks): vendors call us when status changes — simulated via
 *    the /onboarding/watcher/push endpoint.
 *  - pull (API polling): a scheduled loop queries each system's API —
 *    simulated deterministically by per-system turnaround times.
 * All decisions here are deterministic (Rules engine) — no LLM involved.
 */

const POLL_INTERVAL_MS = 30_000;
const AGENT = "system-watcher";

/**
 * Which external systems each readiness checklist item depends on, plus the
 * simulated turnaround (seconds after case creation until the system reports
 * done). An item completes only when ALL of its source systems report done.
 */
const ITEM_SOURCES: Record<string, Array<{ connector: string; turnaroundSec: number }>> = {
  profile: [{ connector: "hris", turnaroundSec: 45 }],
  documentation: [
    { connector: "esignature", turnaroundSec: 90 },
    { connector: "bgv", turnaroundSec: 180 },
  ],
  payroll: [{ connector: "payroll", turnaroundSec: 150 }],
  access: [
    { connector: "identity", turnaroundSec: 100 },
    { connector: "itsm", turnaroundSec: 130 },
  ],
  assets: [{ connector: "itsm", turnaroundSec: 160 }],
  learning: [{ connector: "lms", turnaroundSec: 75 }],
  // checkpoints: owned by the orchestrator, not an external system.
};

/** SLA breach = item still open after this multiple of its slowest turnaround. */
const SLA_MULTIPLIER = 3;

const SLA_NOTE_MARKER = "[watcher] SLA breach flagged";

type SystemTelemetry = {
  key: string;
  lastCheckedAt: Date | null;
  itemsCompleted: number;
  pushesReceived: number;
};

const systemTelemetry = new Map<string, SystemTelemetry>();

function telemetryFor(key: string): SystemTelemetry {
  let t = systemTelemetry.get(key);
  if (!t) {
    t = { key, lastCheckedAt: null, itemsCompleted: 0, pushesReceived: 0 };
    systemTelemetry.set(key, t);
  }
  return t;
}

const monitorStatus = {
  running: false,
  startedAt: null as Date | null,
  lastPollAt: null as Date | null,
  lastSuccessAt: null as Date | null,
  lastError: null as string | null,
  lastErrorAt: null as Date | null,
};

let timer: NodeJS.Timeout | null = null;
let polling = false;

async function logEvent(
  caseId: number,
  title: string,
  detail: string,
  opts?: { hitlPattern?: string; ruleRef?: string },
) {
  await db.insert(onbEvents).values({
    caseId,
    agent: AGENT,
    engine: "ldm",
    hitlPattern: opts?.hitlPattern ?? null,
    ruleRef: opts?.ruleRef ?? null,
    title,
    detail,
  });
}

function connectorLabel(key: string, labels: Map<string, string>): string {
  return labels.get(key) ?? key.toUpperCase();
}

/**
 * One reconciliation cycle: for every open case, ask each (simulated)
 * external system for the status of the checklist items it owns, complete
 * items whose systems all report done, and flag SLA breaches once.
 * Returns the number of checklist items updated.
 */
export async function watcherPollOnce(now = new Date()): Promise<number> {
  const connectors = await db.select().from(onbConnectors);
  const connected = new Set(connectors.filter((c) => c.status === "connected").map((c) => c.key));
  const labels = new Map(connectors.map((c) => [c.key, c.label]));

  const cases = await db
    .select()
    .from(onbCases)
    .where(sql`${onbCases.lifecycleStage} not in ('complete')`);

  let updates = 0;

  for (const c of cases) {
    // Don't race an actively running orchestration pass — it rewrites the
    // readiness JSON wholesale. The next cycle will pick the case up.
    if (c.orchestrationStatus === "running") continue;

    const readiness: OnbReadinessItemRow[] = JSON.parse(JSON.stringify(c.readiness ?? []));
    const elapsedSec = (now.getTime() - c.createdAt.getTime()) / 1000;
    let changed = false;

    for (const item of readiness) {
      const sources = ITEM_SOURCES[item.key];
      if (!sources) continue;
      if (item.status !== "pending" && item.status !== "in-progress") continue;

      const reachable = sources.filter((s) => connected.has(s.connector));
      for (const s of reachable) telemetryFor(s.connector).lastCheckedAt = now;
      if (reachable.length !== sources.length) continue; // a source system is offline — cannot confirm

      const allDone = sources.every((s) => elapsedSec >= s.turnaroundSec);
      const slowest = Math.max(...sources.map((s) => s.turnaroundSec));

      if (allDone) {
        // "ready" is the documented terminal readiness status used across
        // the API contract — never introduce undocumented states here.
        item.status = "ready";
        item.note = `Confirmed by ${sources.map((s) => connectorLabel(s.connector, labels)).join(" + ")} via System Watcher`;
        for (const s of sources) telemetryFor(s.connector).itemsCompleted += 1;
        changed = true;
        updates += 1;
        await logEvent(
          c.id,
          "External system confirmed completion",
          `${item.label}: ${sources.map((s) => connectorLabel(s.connector, labels)).join(" and ")} report${sources.length > 1 ? "" : "s"} the work is done. Checklist item marked ready.`,
          { hitlPattern: "notify-only", ruleRef: "Watcher poll" },
        );
      } else if (
        elapsedSec > slowest * SLA_MULTIPLIER &&
        !(item.note ?? "").includes(SLA_NOTE_MARKER)
      ) {
        const overdue = sources.filter((s) => elapsedSec < s.turnaroundSec);
        item.note = `${SLA_NOTE_MARKER}: waiting on ${overdue.map((s) => connectorLabel(s.connector, labels)).join(", ") || "external system"}`;
        changed = true;
        updates += 1;
        await logEvent(
          c.id,
          "Checklist item past SLA",
          `${item.label} is still open after ${Math.round(elapsedSec / 60)} min. Waiting on: ${overdue.map((s) => connectorLabel(s.connector, labels)).join(", ") || "unknown"}. Owner notified for follow-up.`,
          { hitlPattern: "notify-only", ruleRef: "Watcher SLA" },
        );
      }
    }

    if (changed) {
      // Optimistic concurrency: only write if nobody (orchestrator, push,
      // another poll) touched the case since we read it. On conflict the
      // next cycle re-reads and reconciles again — events already logged
      // stay valid because the underlying system facts don't change.
      const result = await db
        .update(onbCases)
        .set({ readiness, updatedAt: new Date() })
        .where(and(eq(onbCases.id, c.id), eq(onbCases.updatedAt, c.updatedAt)))
        .returning({ id: onbCases.id });
      if (result.length === 0) updates -= 1;
    }
  }

  // Record the sync on every connected connector we consulted this cycle.
  for (const key of connected) {
    await db
      .update(onbConnectors)
      .set({ lastSyncAt: now })
      .where(eq(onbConnectors.key, key));
  }

  return updates;
}

/**
 * Simulated vendor webhook (push): an external system proactively reports a
 * status for a checklist item. status "complete" closes the item(s) owned by
 * that system; "exception" blocks them and raises a hard-block for human
 * review (e.g. a BGV discrepancy).
 */
export const WATCHED_CONNECTORS = ["hris", "esignature", "bgv", "payroll", "identity", "itsm", "lms"] as const;

export async function watcherPush(opts: {
  caseId: number;
  connector: string;
  status: "complete" | "exception";
  note?: string;
}): Promise<{ ok: boolean; detail: string }> {
  if (!(WATCHED_CONNECTORS as readonly string[]).includes(opts.connector)) {
    return { ok: false, detail: `Unknown system '${opts.connector}'. Watched systems: ${WATCHED_CONNECTORS.join(", ")}.` };
  }

  const [c] = await db.select().from(onbCases).where(eq(onbCases.id, opts.caseId));
  if (!c) return { ok: false, detail: `Case ${opts.caseId} not found.` };
  if (c.orchestrationStatus === "running") {
    return { ok: false, detail: "Case orchestration is actively running — retry the push in a moment." };
  }

  const connectors = await db.select().from(onbConnectors);
  const labels = new Map(connectors.map((x) => [x.key, x.label]));
  const connected = new Set(connectors.filter((x) => x.status === "connected").map((x) => x.key));
  const label = connectorLabel(opts.connector, labels);
  if (!connected.has(opts.connector)) {
    return { ok: false, detail: `${label} is disconnected — reconnect the adapter before it can push status updates.` };
  }

  const readiness: OnbReadinessItemRow[] = JSON.parse(JSON.stringify(c.readiness ?? []));
  const owned = readiness.filter(
    (item) =>
      (ITEM_SOURCES[item.key] ?? []).some((s) => s.connector === opts.connector) &&
      item.status !== "ready",
  );
  if (owned.length === 0) {
    return { ok: false, detail: `${label} owns no open checklist items on case ${opts.caseId}.` };
  }

  const tel = telemetryFor(opts.connector);
  tel.pushesReceived += 1;
  tel.lastCheckedAt = new Date();

  const saveReadiness = async (): Promise<boolean> => {
    const result = await db
      .update(onbCases)
      .set({ readiness, updatedAt: new Date() })
      .where(and(eq(onbCases.id, c.id), eq(onbCases.updatedAt, c.updatedAt)))
      .returning({ id: onbCases.id });
    return result.length > 0;
  };

  if (opts.status === "complete") {
    let completed = 0;
    const nowSec = (new Date().getTime() - c.createdAt.getTime()) / 1000;
    for (const item of owned) {
      const sources = ITEM_SOURCES[item.key] ?? [];
      // A push only proves THIS system is done; multi-source items stay open
      // until the other systems confirm too (connected AND turnaround met).
      const others = sources.filter((s) => s.connector !== opts.connector);
      const othersDone = others.every((s) => connected.has(s.connector) && nowSec >= s.turnaroundSec);
      if (othersDone) {
        item.status = "ready";
        item.note = `Confirmed by ${label} webhook${opts.note ? ` — ${opts.note}` : ""}`;
        completed += 1;
        tel.itemsCompleted += 1;
      } else {
        item.note = `${label} reports done via webhook; waiting on ${others.map((s) => connectorLabel(s.connector, labels)).join(", ")}`;
      }
    }
    if (!(await saveReadiness())) {
      return { ok: false, detail: "The case changed while processing the push — retry." };
    }
    await logEvent(
      c.id,
      "Webhook status update received",
      `${label} pushed a completion notification${opts.note ? ` (${opts.note})` : ""}. ${completed > 0 ? `${completed} checklist item(s) marked ready.` : "Recorded; other systems still pending."}`,
      { hitlPattern: "notify-only", ruleRef: "Watcher push" },
    );
    return { ok: true, detail: `${label} push processed — ${completed} item(s) marked ready.` };
  }

  // Exception path: mark the items as exceptions and raise ONE hard-block
  // for a human. Webhook retries must not create duplicate approvals.
  const { onbApprovals } = await import("@workspace/db/schema");
  const ruleRef = `Watcher exception: ${opts.connector}`;
  const [existing] = await db
    .select({ id: onbApprovals.id })
    .from(onbApprovals)
    .where(
      and(
        eq(onbApprovals.caseId, c.id),
        eq(onbApprovals.agent, AGENT),
        eq(onbApprovals.ruleRef, ruleRef),
        eq(onbApprovals.status, "pending"),
      ),
    );
  if (existing) {
    return { ok: true, detail: `${label} exception already pending human review (approval #${existing.id}) — duplicate push ignored.` };
  }

  for (const item of owned) {
    item.status = "exception";
    item.note = `${label} reported an exception${opts.note ? `: ${opts.note}` : ""}`;
  }
  if (!(await saveReadiness())) {
    return { ok: false, detail: "The case changed while processing the push — retry." };
  }
  await db.insert(onbApprovals).values({
    caseId: c.id,
    agent: AGENT,
    ruleRef,
    hitlPattern: "hard-block",
    recommendation: `Review ${label} exception before onboarding continues`,
    rationale: `${label} reported an exception${opts.note ? `: ${opts.note}` : ""}. Affected: ${owned.map((i) => i.label).join("; ")}.`,
    resumeAction: "none",
  });
  await logEvent(
    c.id,
    "Hard-block raised from system exception",
    `${label} pushed an exception${opts.note ? ` (${opts.note})` : ""}. ${owned.length} checklist item(s) flagged as exceptions pending human review.`,
    { hitlPattern: "hard-block", ruleRef },
  );
  return { ok: true, detail: `${label} exception recorded — case hard-blocked for human review.` };
}

export function getSystemWatcherStatus() {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const staleMs = POLL_INTERVAL_MS * 3;
  const now = Date.now();
  let state: "healthy" | "initializing" | "broken" | "stopped";
  if (!monitorStatus.running) state = "stopped";
  else if (
    monitorStatus.lastErrorAt &&
    (!monitorStatus.lastSuccessAt || monitorStatus.lastErrorAt > monitorStatus.lastSuccessAt)
  )
    state = "broken";
  else if (monitorStatus.lastSuccessAt)
    state = now - monitorStatus.lastSuccessAt.getTime() > staleMs ? "broken" : "healthy";
  else
    state =
      (monitorStatus.startedAt ? now - monitorStatus.startedAt.getTime() : Infinity) > staleMs
        ? "broken"
        : "initializing";

  const watched = ["hris", "esignature", "bgv", "payroll", "identity", "itsm", "lms"];
  return {
    running: monitorStatus.running,
    pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
    lastPollAt: iso(monitorStatus.lastPollAt),
    lastSuccessAt: iso(monitorStatus.lastSuccessAt),
    lastError: monitorStatus.lastError,
    lastErrorAt: iso(monitorStatus.lastErrorAt),
    state,
    healthy: state === "healthy",
    systems: watched.map((key) => {
      const t = telemetryFor(key);
      return {
        key,
        mode: "poll+push",
        lastCheckedAt: iso(t.lastCheckedAt),
        itemsCompleted: t.itemsCompleted,
        pushesReceived: t.pushesReceived,
      };
    }),
  };
}

/**
 * Run one cycle under the same mutex as the background loop, so a manual
 * "Poll now" can never run concurrently with a scheduled poll.
 */
export async function runWatcherCycleGuarded(): Promise<number | null> {
  if (polling) return null;
  polling = true;
  try {
    return await watcherPollOnce();
  } finally {
    polling = false;
  }
}

export function startSystemWatcher(): void {
  if (timer) return;
  const tick = async () => {
    if (polling) return;
    polling = true;
    monitorStatus.lastPollAt = new Date();
    try {
      await watcherPollOnce();
      monitorStatus.lastSuccessAt = new Date();
      monitorStatus.lastError = null;
      monitorStatus.lastErrorAt = null;
    } catch (err) {
      monitorStatus.lastError = String(err).slice(0, 300);
      monitorStatus.lastErrorAt = new Date();
      console.error("[onboarding system-watcher] poll failed:", monitorStatus.lastError);
    } finally {
      polling = false;
    }
  };
  monitorStatus.running = true;
  monitorStatus.startedAt = new Date();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  void tick();
  console.log(`[onboarding system-watcher] started (every ${POLL_INTERVAL_MS / 1000}s)`);
}
