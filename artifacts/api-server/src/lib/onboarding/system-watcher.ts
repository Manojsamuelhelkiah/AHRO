import { db } from "@workspace/db";
import { randomUUID } from "node:crypto";
import {
  onbCases,
  onbCommunications,
  onbConnectors,
  onbEvents,
  onbApprovals,
  onbSystemChecks,
  onbDocuments,
  onbStandardIntakeEvents,
  type OnbReadinessItemRow,
} from "@workspace/db/schema";
import { and, eq, gt, inArray, lte, ne, or, sql } from "drizzle-orm";
import {
  autoEscalationCallsEnabled,
  checklistStageBlockers,
  mandatoryChecklistReady,
} from "./settings";
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
import {
  classifyMonitor,
  type MonitorState,
  type MonitorTelemetry,
} from "./inbound-email";
import { ensureConnectorsSeeded } from "./connectors";
import { makeSharedTick } from "./shared-tick";
import { sweepExpiredNonIdempotentEffects } from "./effect-journal";
import { runDocumentReminderTick, runDocumentValidationTick } from "./document-validation";
import { runGovernanceReminderTick } from "./governance";
import {
  assertCaseDerivedLifecycleWriteAllowedInTransaction,
  runSensitiveLifecycleDeletionTick,
  SensitiveLifecycleConflictError,
  withCaseDerivedLifecycleWrite,
} from "./sensitive-lifecycle";
import { runDocumentMalwareTick } from "./document-malware";
import { documentMalwareGateSql } from "./document-malware-gate";
import { runMalwareScannerMonitorTick } from "./malware-scanner-monitor";
import { logger } from "../logger";
import { documentationGateReady } from "./document-validation-policy";
import { reopenApprovalInTransaction } from "./approval-version";
import { hasReadinessSlaEnrollment, readinessSlaDueAtForSystem } from "./readiness-sla-policy";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import type { OnboardingDbTransaction } from "./settings";
import { recoverWorkforceConnectorContinuations } from "./operational-requests";
import { runFrontlineReleaseHeartbeat } from "./frontline-operations";
import { ConnectorDispatchRejectedError } from "./connector-adapters";
import {
  recordBgvBlockedEpisode,
  recordBgvReleaseEpisode,
  reconcileCurrentBgvNotifications,
  withBgvNotificationCaseFence,
  type BgvNotificationProvenance,
  type BgvNotificationSource,
  type BgvNotificationClassification,
} from "./bgv-notifications";

/**
 * System Watcher agent.
 *
 * Monitors external-system checklist items (BGV clearance, ITSM access
 * provisioning, payroll setup) via the simulated vendor adapters:
 *  - push systems (BGV) deliver completion through the webhook code path;
 *  - poll systems (ITSM, payroll) are checked on a schedule.
 *
 * Only a trusted-provider system completion may flip the matching case
 * readiness item to ready or promote a case. Simulated notifications remain
 * communications/status telemetry and never become canonical readiness. When a check
 * blows past its SLA (late/stuck, e.g. because the connector is
 * disconnected) it raises a rules-tagged escalation event exactly once.
 */

const POLL_INTERVAL_MS = 20_000;
export const WATCHER_AGENT = "system-watcher";

function reportRestrictedLifecycleRecovery(
  operation: string,
  input: { organizationId: string; caseId: number; checkId?: number },
  error: SensitiveLifecycleConflictError,
): void {
  logger.warn({
    component: "system-watcher",
    operation,
    organizationId: input.organizationId,
    caseId: input.caseId,
    ...(input.checkId === undefined ? {} : { checkId: input.checkId }),
    reason: error.message.slice(0, 300),
  }, "case recovery restricted by sensitive lifecycle policy; skipped");
}

function classificationsForProviderStatus(
  status: string,
): BgvNotificationClassification[] {
  return ["exception", "adverse", "unknown", "failed", "rejected"].includes(status)
    ? ["discrepancy", "review-required"]
    : ["delay"];
}

let timer: NodeJS.Timeout | null = null;

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

/**
 * Synthetic provider outcomes are test/development telemetry only. Production
 * must wait for an authenticated provider callback or a real adapter result;
 * a connected display status is never permission to manufacture completion.
 */
export function simulatedProviderCompletionsAllowed(): boolean {
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

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
  organizationId: string,
  title: string,
  detail: string,
  ruleRef: string,
  hitlPattern: string = "notify-only",
  tx?: OnboardingDbTransaction,
) {
  if (tx) {
    await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, { organizationId, caseId });
    await tx.insert(onbEvents).values({
      caseId,
      organizationId,
      agent: WATCHER_AGENT,
      engine: "system",
      hitlPattern,
      ruleRef,
      title,
      detail,
    });
    return;
  }
  await withCaseDerivedLifecycleWrite({ organizationId, caseId }, (tx) => tx.insert(onbEvents).values({
    caseId,
    organizationId,
    agent: WATCHER_AGENT,
    engine: "system",
    hitlPattern,
    ruleRef,
    title,
    detail,
  }));
}

/** Close a check as done and update the case checklist. Idempotent. Exported for tests. */
async function completeCheckUnlocked(
  check: typeof onbSystemChecks.$inferSelect,
  source: "webhook push" | "scheduled poll" | "status email",
  notificationProvenance: BgvNotificationProvenance = "simulated",
): Promise<void> {
  const def = systemDef(check.system);
  if (!def) return;
  const trustedCompletion = notificationProvenance === "trusted-provider";

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
  let checklistResumeReady = false;
  let standardOperationsReleaseResumeReady = false;
  let offlinePaused = false;
  await db.transaction(async (tx) => {
    const [caseForGuard] = await tx
      .select()
      .from(onbCases)
      .where(and(
        eq(onbCases.id, check.caseId),
        eq(onbCases.organizationId, check.organizationId),
      ))
      .for("update");
    if (caseForGuard && isSyntheticOfflineCase(caseForGuard)) {
      offlinePaused = true;
      return;
    }
    const closableStatus = trustedCompletion
      ? sql`(
          ${onbSystemChecks.status} in ('pending', 'overdue')
          or (
            ${onbSystemChecks.status} = 'done'
            and ${onbSystemChecks.evidenceProvenance} is distinct from 'trusted-provider'
          )
        )`
      : sql`${onbSystemChecks.status} in ('pending', 'overdue')`;
    const [updated] = await tx
      .update(onbSystemChecks)
      .set({
        status: "done",
        completedAt: new Date(),
        evidenceProvenance: notificationProvenance,
        lastCheckedAt: new Date(),
        note: `Confirmed via ${source} (${check.externalRef})`,
      })
      .where(
        and(
          eq(onbSystemChecks.id, check.id),
          eq(onbSystemChecks.organizationId, check.organizationId),
          closableStatus,
          eq(onbSystemChecks.mode, expectedMode[source]),
        ),
      )
      .returning();
    if (!updated) return; // already closed by a concurrent path
    if (notificationProvenance === "trusted-provider") {
      await tx.update(onbConnectors).set({
        status: "connected",
        configurationProvenance: "trusted-provider",
        lastSyncAt: new Date(),
      }).where(and(
        eq(onbConnectors.organizationId, check.organizationId),
        eq(onbConnectors.key, def.connectorKey),
      ));
    }

    const [c] = await tx
      .select()
      .from(onbCases)
      .where(and(eq(onbCases.id, check.caseId), eq(onbCases.organizationId, check.organizationId)))
      .for("update");
    let promoted = false;
    if (c && trustedCompletion) {
      // A trusted source update can satisfy a held IAM/payroll release even
      // when no checklist boundary itself was waiting. Resume only the exact
      // durable Standard Operations checkpoint; it cannot promote Gate C.
      standardOperationsReleaseResumeReady =
        c.orchestrationStatus === "checklist-blocked" &&
        c.orchestrationCheckpoint === "waiting:standard-operations-release";
      const readiness = c.readiness as OnbReadinessItemRow[];
      const item = readiness.find((r) => r.key === def.readinessKey);
      if (item) {
        if (def.key === "bgv") {
          const requiredDocs = await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(eq(onbDocuments.organizationId, check.organizationId), eq(onbDocuments.caseId, check.caseId), eq(onbDocuments.required, true)));
          const verifiedDocs = await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(eq(onbDocuments.organizationId, check.organizationId), eq(onbDocuments.caseId, check.caseId), eq(onbDocuments.required, true), eq(onbDocuments.status, "verified"), documentMalwareGateSql()));
          const ready = documentationGateReady({ bgvApplicable: true, bgvClear: true, requiredDocuments: requiredDocs.length, verifiedDocuments: verifiedDocs.length });
          item.status = ready ? "ready" : "in-progress";
          item.note = ready
            ? noteBySystem[def.key]
            : `BGV is clear; required document verification is ${verifiedDocs.length}/${requiredDocs.length}.`;
        } else {
          item.status = "ready";
          item.note = noteBySystem[def.key];
        }
        const allReady = mandatoryChecklistReady({ ...c, readiness });
        // A gated case must resume through the exact orchestration boundary so
        // analytics/review work cannot be skipped. Direct promotion is retained
        // only for compatible idle/pre-migration cases.
        promoted =
          allReady &&
          c.lifecycleStage === "preboarding" &&
          c.orchestrationStatus === "idle" &&
          !c.orchestrationCheckpoint;
        const blockedStage = c.orchestrationCheckpoint?.replace("blocked:", "") as
          | "before-workstreams"
          | "before-employee-communications"
          | "before-day1-review"
          | undefined;
        checklistResumeReady =
          c.orchestrationStatus === "checklist-blocked" &&
          (blockedStage === "before-workstreams" ||
            blockedStage === "before-employee-communications" ||
            blockedStage === "before-day1-review") &&
          checklistStageBlockers({ ...c, readiness }, blockedStage).length === 0;
        await tx
          .update(onbCases)
          .set({
            readiness,
            updatedAt: new Date(),
            ...(promoted ? { lifecycleStage: "day1-review" } : {}),
          })
          .where(and(eq(onbCases.id, check.caseId), eq(onbCases.organizationId, check.organizationId)));
      }
    }

    const events = [
      {
        caseId: check.caseId,
        organizationId: check.organizationId,
        agent: WATCHER_AGENT,
        engine: "system" as const,
        hitlPattern: "notify-only",
        ruleRef: def.completionRuleRef,
        title: trustedCompletion
          ? `${def.label} reported complete`
          : `${def.label} simulated completion notification received`,
        detail: trustedCompletion
          ? `${def.label} (${check.externalRef}) reported done via ${source}. Checklist item "${def.readinessKey}" marked ready by the System Watcher.`
          : `${def.label} (${check.externalRef}) reported done via ${source}, but its simulated notification is communications/status telemetry only; canonical readiness and orchestration were not changed.`,
      },
      ...(promoted
        ? [
            {
              caseId: check.caseId,
              organizationId: check.organizationId,
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
  if (checklistResumeReady || standardOperationsReleaseResumeReady) {
    // Dynamic import avoids the engine -> workstream connector -> watcher
    // module cycle while still making source-system completion resume the
    // exact gated boundary through its DB-backed compare-and-set claim.
    const { resumeChecklistOrchestration } = await import("./engine");
    await resumeChecklistOrchestration(check.caseId);
  }
  if (!offlinePaused && def.key === "bgv" && check.status === "overdue") {
    const notificationSource: BgvNotificationSource =
      source === "webhook push"
        ? "webhook"
        : source === "status email"
          ? "status-email"
          : "scheduled-poll";
    await recordBgvReleaseEpisode({
      organizationId: check.organizationId,
      caseId: check.caseId,
      source: notificationSource,
      provenance: notificationProvenance,
      skipFence: true,
    });
  }
}

export async function completeCheck(
  check: typeof onbSystemChecks.$inferSelect,
  source: "webhook push" | "scheduled poll" | "status email",
  notificationProvenance: BgvNotificationProvenance = "simulated",
): Promise<void> {
  await withBgvNotificationCaseFence(check.organizationId, check.caseId, () =>
    completeCheckUnlocked(check, source, notificationProvenance),
  );
}

/** Escalate a late/stuck check exactly once. Exported for the watch-mailbox tracker. */
async function escalateCheckUnlocked(
  check: typeof onbSystemChecks.$inferSelect,
  reason: string,
  expectedMode?: string,
  notificationSource?: BgvNotificationSource,
  notificationProvenance: BgvNotificationProvenance = "simulated",
  notificationClassifications?: BgvNotificationClassification[],
): Promise<void> {
  const def = systemDef(check.system);
  if (!def) return;
  const escalationAt = new Date();
  const [updated] = await db
    .update(onbSystemChecks)
    .set({ status: "overdue", escalatedAt: escalationAt, note: reason })
    .where(
      and(
        eq(onbSystemChecks.id, check.id),
        eq(onbSystemChecks.organizationId, check.organizationId),
        // A vendor correction after an earlier clearance is safety-critical:
        // reopen the live gate rather than silently retaining a stale green.
        sql`${onbSystemChecks.status} in ('pending', 'done')`,
        ...(expectedMode ? [eq(onbSystemChecks.mode, expectedMode)] : []),
      ),
    )
    .returning();
  if (!updated) {
    // A provider may report a more severe exception after the check is
    // already overdue. Do not duplicate the approval, but still merge the
    // explicit classification and add newly eligible compliance notice(s).
    const [current] = await db.select({
      status: onbSystemChecks.status,
    }).from(onbSystemChecks).where(and(
      eq(onbSystemChecks.id, check.id),
      eq(onbSystemChecks.organizationId, check.organizationId),
    ));
    if (check.system === "bgv" && current?.status === "overdue") {
      await recordBgvBlockedEpisode({
        organizationId: check.organizationId,
        caseId: check.caseId,
        source: notificationSource ??
          (expectedMode === "push"
            ? "webhook"
            : expectedMode === "email"
              ? "status-email"
              : "overdue"),
        provenance: notificationProvenance,
        reason,
        classifications: notificationClassifications,
        skipFence: true,
      });
    }
    return;
  }

  if (check.system === "bgv") {
    await db.transaction(async (tx) => {
      const [c] = await tx.select().from(onbCases).where(and(
        eq(onbCases.id, check.caseId),
        eq(onbCases.organizationId, check.organizationId),
      )).for("update");
      if (!c) return;
      if (c.lifecycleStage === "complete" || c.lifecycleStage === "day1-review") {
        await reopenApprovalInTransaction(tx, {
          organizationId: c.organizationId,
          caseId: c.id,
          idempotencyKey: `gateway-c:${c.id}:human-queue`,
          reason: "Automatically reopened because BGV status regressed; fresh final readiness review is required.",
          actor: WATCHER_AGENT,
        });
      }
      const readiness = c.readiness.map((item) => ({ ...item }));
      const documentation = readiness.find((item) => item.key === "documentation");
      if (documentation) {
        documentation.status = "in-progress";
        documentation.note = `BGV requires human review (${check.externalRef}); no automated employment decision was made.`;
      }
      await tx.update(onbCases).set({
        readiness,
        ...(c.lifecycleStage === "complete" || c.lifecycleStage === "day1-review"
          ? {
              lifecycleStage: "preboarding",
              orchestrationStatus: "checklist-blocked",
              orchestrationCheckpoint: "blocked:re-review",
              orchestrationClaimOwner: null,
              orchestrationClaimUntil: null,
            }
          : {}),
        updatedAt: new Date(),
      }).where(and(eq(onbCases.id, c.id), eq(onbCases.organizationId, c.organizationId)));
    });
  }

  // An SLA breach or exception is a human decision boundary, never merely a
  // coloured status. The unique key makes webhook/mailbox/tick races converge
  // on one durable review item and explicitly avoids an automated adverse
  // employment decision.
  await withCaseDerivedLifecycleWrite({
    organizationId: check.organizationId, caseId: check.caseId,
  }, (tx) => tx.insert(onbApprovals).values({
    organizationId: check.organizationId,
    caseId: check.caseId,
    agent: WATCHER_AGENT,
    ruleRef: check.system === "bgv" ? "Gate B — background verification" : def.slaRuleRef,
    hitlPattern: "hard-block",
    recommendation: check.system === "bgv"
      ? "Review the BGV exception, unknown status, or SLA breach and decide the safe next step"
      : `Review the ${def.label} exception or SLA breach`,
    rationale: `${def.label} (${check.externalRef}) requires human review: ${reason} No automated adverse employment action was taken.`,
    resumeAction: "none",
    authorityScope: "hr-compliance-approve",
    // Each pending→overdue transition is a distinct recurrence. Do not let a
    // previously decided exception suppress a newly reopened human review.
    idempotencyKey: `gateway-${check.system}:${check.id}:${escalationAt.getTime()}:human-queue`,
  }).onConflictDoNothing({
    target: [onbApprovals.organizationId, onbApprovals.idempotencyKey],
  }));

  await logEvent(
    check.caseId,
    check.organizationId,
    `${def.label} is late — SLA breached`,
    `${def.label} (${check.externalRef}) has not reported completion within its ${def.slaSeconds}s SLA. ${reason} Owner notified; the checklist item stays open until the source system confirms.`,
    def.slaRuleRef,
    "hard-block",
  );

  if (check.system === "bgv") {
    await recordBgvBlockedEpisode({
      organizationId: check.organizationId,
      caseId: check.caseId,
      source: notificationSource ??
        (expectedMode === "push"
          ? "webhook"
          : expectedMode === "email"
            ? "status-email"
            : "overdue"),
      provenance: notificationProvenance,
      reason,
      classifications: notificationClassifications,
      skipFence: true,
    });
  }

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

export async function escalateCheck(
  check: typeof onbSystemChecks.$inferSelect,
  reason: string,
  expectedMode?: string,
  notificationSource?: BgvNotificationSource,
  notificationProvenance: BgvNotificationProvenance = "simulated",
  notificationClassifications?: BgvNotificationClassification[],
): Promise<void> {
  await withBgvNotificationCaseFence(check.organizationId, check.caseId, () =>
    escalateCheckUnlocked(
      check,
      reason,
      expectedMode,
      notificationSource,
      notificationProvenance,
      notificationClassifications,
    ),
  );
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
  if (!(await autoEscalationCallsEnabled(check.organizationId))) return;

  // Has the hire replied on any messaging channel since we started
  // tracking this check? If so they're responsive — no surprise call.
  const [reply] = await db
    .select({ id: onbCommunications.id })
    .from(onbCommunications)
    .where(
      and(
        eq(onbCommunications.caseId, check.caseId),
        eq(onbCommunications.organizationId, check.organizationId),
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
    check.organizationId,
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
      check.organizationId,
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
export async function trackCaseSystems(
  caseId: number,
  onlySystems?: readonly WatchedSystem[],
  tx?: OnboardingDbTransaction,
): Promise<void> {
  const executor = tx ?? db;
  const [c] = await executor.select().from(onbCases).where(eq(onbCases.id, caseId));
  if (!c) return;
  if (tx) {
    await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, {
      organizationId: c.organizationId,
      caseId,
    });
  }
  const now = new Date();
  const defs = applicableSystems(c).filter(
    (def) => !onlySystems || onlySystems.includes(def.key),
  );
  const emailTracked = await emailTrackedConnectors(c.organizationId);
  for (const def of defs) {
    const useEmail = emailTracked.has(def.connectorKey);
    const mode = useEmail ? "email" : def.mode;
    const policyManaged = await hasReadinessSlaEnrollment(c.organizationId, caseId);
    const policyDueAt = policyManaged
      ? await readinessSlaDueAtForSystem(c.organizationId, caseId, def.key)
      : null;
    const rows = await executor
      .insert(onbSystemChecks)
      .values({
        caseId,
        organizationId: c.organizationId,
        system: def.key,
        mode,
        externalRef: makeExternalRef(def, caseId),
        status: "pending",
        requestedAt: now,
        // Legacy display storage requires an instant. Missing payroll cut-off
        // is shown as needs-configuration in the policy view; the old timed
        // sweep is disabled for this enrolled case, so this is not a deadline.
        dueAt: policyDueAt ?? (policyManaged ? now : new Date(now.getTime() + def.slaSeconds * 1000)),
      })
      .onConflictDoNothing({
        target: [
          onbSystemChecks.organizationId,
          onbSystemChecks.caseId,
          onbSystemChecks.system,
        ],
      })
      .returning({ id: onbSystemChecks.id });
    if (rows.length > 0) {
      await logEvent(
        caseId,
        c.organizationId,
        `Watching ${def.label.toLowerCase()}`,
        `System Watcher is tracking ${def.label} (${makeExternalRef(def, caseId)}) via ${
          mode === "email"
            ? "the watch mailbox — vendor status emails quoting the reference"
            : def.mode === "push"
              ? "vendor webhook push"
              : `scheduled polling every ${POLL_INTERVAL_MS / 1000}s`
        }; ${policyManaged ? (policyDueAt ? `policy deadline ${policyDueAt.toISOString()}` : "deadline needs policy configuration") : `SLA ${def.slaSeconds}s`}.`,
        def.completionRuleRef,
        "notify-only",
        tx,
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
  externalRef: string;
  status: string;
  provenance?: BgvNotificationProvenance;
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
  const status = opts.status.trim().toLowerCase();
  if (!["completed", "pending", "exception", "adverse", "unknown", "failed", "rejected"].includes(status)) {
    return {
      ok: false,
        message: `Unsupported ${def.label} webhook status "${opts.status}". Supported statuses are completed, pending, exception, adverse, unknown, failed, and rejected.`,
    };
  }
  const t = telemetry[def.key];
  try {
    // The signed webhook contains no tenant identity; derive it from the
    // owning case before touching a child check.
    const [owner] = await db
      .select({ organizationId: onbCases.organizationId })
      .from(onbCases)
      .where(eq(onbCases.id, opts.caseId));
    if (!owner) return { ok: false, message: "Unknown case" };
    const [check] = await db
      .select()
      .from(onbSystemChecks)
      .where(
        and(
          eq(onbSystemChecks.caseId, opts.caseId),
          eq(onbSystemChecks.organizationId, owner.organizationId),
          eq(onbSystemChecks.system, def.key),
          eq(onbSystemChecks.externalRef, opts.externalRef),
        ),
      );
    if (!check) return { ok: false, message: "No tracked check matching the provider reference" };
    t.lastEventAt = new Date();
    t.eventsReceived += 1;
    if (status === "completed") {
      await completeCheck(check, "webhook push", opts.provenance ?? "simulated");
      t.lastSuccessAt = new Date();
      t.lastError = null;
      t.lastErrorAt = null;
    } else if (["exception", "adverse", "unknown", "failed", "rejected"].includes(status)) {
      await escalateCheck(
        check,
        `The ${def.label} vendor reported ${status} status for ${check.externalRef}; human review is required and no automated adverse action was taken.`,
        "push",
        "webhook",
        opts.provenance,
        classificationsForProviderStatus(status),
      );
      t.lastSuccessAt = new Date();
      t.lastError = null;
      t.lastErrorAt = null;
    } else {
      await db.update(onbSystemChecks).set({
        lastCheckedAt: new Date(),
        note: `${def.label} vendor reports pending (${check.externalRef})`,
      }).where(and(
        eq(onbSystemChecks.id, check.id),
        eq(onbSystemChecks.organizationId, check.organizationId),
        sql`${onbSystemChecks.status} in ('pending', 'done')`,
        eq(onbSystemChecks.mode, "push"),
      ));
      if (check.status === "done") {
        await escalateCheck(
          check,
          `${def.label} vendor regressed from completed to pending for ${check.externalRef}; fresh human review is required.`,
          "push",
          "webhook",
          opts.provenance,
          classificationsForProviderStatus(status),
        );
      }
    }
    return { ok: true, message: status === "completed" ? "Completion processed" : `Status "${status}" processed` };
  } catch (err) {
    t.lastError = String(err).slice(0, 300);
    t.lastErrorAt = new Date();
    return { ok: false, message: t.lastError };
  }
}

/** Schedule the simulated BGV vendor's push for a pending check. */
function schedulePush(check: typeof onbSystemChecks.$inferSelect): void {
  const def = systemDef(check.system);
  if (!def || def.mode !== "push" || !simulatedProviderCompletionsAllowed()) return;
  if (scheduledPushes.has(check.id)) return;
  const delay = Math.max(
    0,
    completionAt(def, check.requestedAt, check.caseId).getTime() - Date.now(),
  );
  const handle = setTimeout(() => {
    scheduledPushes.delete(check.id);
    void (async () => {
      // Vendor only pushes while its connector is connected.
      const connected = await connectorConnected(def.connectorKey, check.organizationId);
      if (!connected) return; // re-scheduled by the tick once reconnected
      await handleSystemWebhook({
        system: def.key,
        caseId: check.caseId,
        externalRef: check.externalRef,
        status: "completed",
        provenance: "simulated",
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
export async function emailTrackedConnectors(organizationId: string): Promise<Set<string>> {
  const rows = await db
    .select({ key: onbConnectors.key })
    .from(onbConnectors)
    .where(and(eq(onbConnectors.trackingMode, "email"), eq(onbConnectors.organizationId, organizationId)));
  return new Set(rows.map((r) => r.key));
}

async function connectorConnected(connectorKey: string, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: onbConnectors.status })
    .from(onbConnectors)
    .where(and(eq(onbConnectors.key, connectorKey), eq(onbConnectors.organizationId, organizationId)));
  return row?.status === "connected";
}

export function disconnectedCheckIsOverdue(
  check: Pick<typeof onbSystemChecks.$inferSelect, "dueAt">,
  now: number,
): boolean {
  return now > check.dueAt.getTime();
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

export async function recoverUntrackedCaseSystems(
  onlyCaseId?: number,
): Promise<void> {
  const untracked = await db
    .select()
    .from(onbCases)
    .where(
      and(
        sql`(${onbCases.hireType} not in ('external-fte', 'contractor', 'rehire') or ${onbCases.offerAcceptanceComplete} = true)`,
        sql`${onbCases.lifecycleStage} in ('preboarding', 'day1-review')
            and coalesce(${onbCases.orchestrationStatus}, '') <> 'checklist-blocked'
            and not exists (select 1 from ${onbSystemChecks} sc where sc.case_id = ${onbCases.id} and sc.organization_id = ${onbCases.organizationId})`,
        onlyCaseId === undefined ? undefined : eq(onbCases.id, onlyCaseId),
      ),
    );
  if (untracked.length > 0) {
    // Recovery registration must use the same approval/applicability boundary
    // as the primary engine path; a restart must never become a bypass.
    const { dispatchWorkstreamConnectorMutations } = await import(
      "./workstream-connectors"
    );
    for (const c of untracked) {
      // The recovery scanner otherwise has no orchestration owner. Claim the
      // row before dispatch so a simultaneous resume cannot replace the
      // lifecycle state between a held connector outcome and its durable
      // checkpoint. The connector journal remains the provider-effect fence.
      const owner = randomUUID();
      const [claim] = await db.update(onbCases).set({
        orchestrationClaimOwner: owner,
        orchestrationClaimToken: sql`${onbCases.orchestrationClaimToken} + 1`,
        orchestrationClaimUntil: sql`now() + interval '60 seconds'`,
        updatedAt: new Date(),
      }).where(and(
        eq(onbCases.id, c.id),
        eq(onbCases.organizationId, c.organizationId),
        sql`${onbCases.lifecycleStage} in ('preboarding', 'day1-review')`,
        sql`coalesce(${onbCases.orchestrationStatus}, '') <> 'checklist-blocked'`,
        sql`not exists (
          select 1 from ${onbSystemChecks} sc
          where sc.case_id = ${onbCases.id}
            and sc.organization_id = ${onbCases.organizationId}
        )`,
        or(
          sql`${onbCases.orchestrationClaimOwner} is null`,
          sql`${onbCases.orchestrationClaimUntil} <= now()`,
        ),
      )).returning({ token: onbCases.orchestrationClaimToken });
      if (!claim) continue;

      let parkedForRelease = false;
      try {
        const outcome = await dispatchWorkstreamConnectorMutations(c);
        if (outcome.releaseHeld) {
          // This state transition and its audit event share the recovery
          // claim fence. Once BGV registration exists, this is the only
          // durable path that keeps the case eligible for a later source-
          // driven/heartbeat retry rather than orphaning it from `untracked`.
          const parked = await db.transaction(async (tx) => {
            const [updated] = await tx.update(onbCases).set({
              lifecycleStage: "preboarding",
              orchestrationStatus: "checklist-blocked",
              orchestrationCheckpoint: "waiting:standard-operations-release",
              orchestrationClaimOwner: null,
              orchestrationClaimUntil: null,
              updatedAt: new Date(),
            }).where(and(
              eq(onbCases.id, c.id),
              eq(onbCases.organizationId, c.organizationId),
              eq(onbCases.orchestrationClaimOwner, owner),
              eq(onbCases.orchestrationClaimToken, claim.token),
            )).returning({ id: onbCases.id });
            if (!updated) return false;
            await tx.insert(onbEvents).values({
              organizationId: c.organizationId,
              caseId: c.id,
              agent: "system-watcher",
              engine: "rules",
              hitlPattern: "hard-block",
              ruleRef: "standard-operations/release-gate",
              title: "Release workstream waiting on Standard Operations",
              detail: `${outcome.heldConnectors.join(" and ")} release remains held by current Standard Operations evidence, approval, date-reconciliation, or HR Operations hold requirements. Independent workstream effects remain separately journaled and will not be duplicated on retry.`,
              idempotencyKey: `orchestration:${c.id}:workstreams:standard-operations-held`,
            }).onConflictDoNothing({
              target: [onbEvents.organizationId, onbEvents.idempotencyKey],
            });
            return true;
          });
          parkedForRelease = parked;
        }
      } catch (error) {
        if (error instanceof ConnectorDispatchRejectedError) {
          logger.warn({
            component: "system-watcher",
            operation: "untracked-workstream-recovery",
            organizationId: c.organizationId,
            caseId: c.id,
            connector: error.connector,
            reason: error.reason,
          }, "case recovery blocked by connector policy; skipped");
          continue;
        }
        if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
        // Historical rows without reviewed authority evidence stay held for
        // human migration review. One such case must not abort recovery for
        // another case or tenant in this heartbeat.
        reportRestrictedLifecycleRecovery(
          "untracked-workstream-recovery",
          { organizationId: c.organizationId, caseId: c.id },
          error,
        );
      } finally {
        if (!parkedForRelease) {
          // A successful recovery that did not hold, or any rejected/error
          // attempt, must not strand a scanner-only claim on the case.
          await db.update(onbCases).set({
            orchestrationClaimOwner: null,
            orchestrationClaimUntil: null,
            updatedAt: new Date(),
          }).where(and(
            eq(onbCases.id, c.id),
            eq(onbCases.organizationId, c.organizationId),
            eq(onbCases.orchestrationClaimOwner, owner),
            eq(onbCases.orchestrationClaimToken, claim.token),
          ));
        }
      }
    }
  }
}

/** Reclaim durable checklist boundaries abandoned by a crashed worker. */
async function recoverLegacyStandardOperationsReleaseBlocks(): Promise<void> {
  // Before the explicit release checkpoint existed, an expected IAM/payroll
  // Standard Operations denial bubbled into the generic engine catch while
  // the case was still at the exact post-plan/pre-workstreams checkpoint.
  // Restrict migration to that known-safe shape and a matching durable error;
  // never reinterpret arbitrary blocked cases as releasable work.
  const rows = await db.select({ id: onbCases.id }).from(onbCases).where(and(
    eq(onbCases.orchestrationStatus, "blocked"),
    eq(onbCases.orchestrationCheckpoint, "plan"),
    sql`exists (
      select 1 from ${onbEvents} event
      where event.case_id = ${onbCases.id}
        and event.organization_id = ${onbCases.organizationId}
        and event.title = 'Orchestration error'
        and event.detail like '%standard-operations:%'
    )`,
  ));
  for (const row of rows) {
    await db.update(onbCases).set({
      orchestrationStatus: "checklist-blocked",
      orchestrationCheckpoint: "waiting:standard-operations-release",
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
      updatedAt: new Date(),
    }).where(and(
      eq(onbCases.id, row.id),
      eq(onbCases.orchestrationStatus, "blocked"),
      eq(onbCases.orchestrationCheckpoint, "plan"),
    ));
  }
}

export async function recoverChecklistOrchestrations(): Promise<void> {
  await recoverLegacyStandardOperationsReleaseBlocks();
  const rows = await db.select({ id: onbCases.id }).from(onbCases).where(
    and(
      sql`${onbCases.orchestrationCheckpoint} in (
        'blocked:before-workstreams',
        'blocked:before-employee-communications',
        'blocked:before-day1-review',
        'blocked:re-review',
        'waiting:standard-operations-release',
        'initial',
        'plan',
        'intake-approved',
        'plan-approved',
        'workstreams-complete',
        'communications-complete'
      )`,
      or(
        eq(onbCases.orchestrationStatus, "checklist-blocked"),
        and(
          eq(onbCases.orchestrationStatus, "running"),
          sql`(${onbCases.orchestrationClaimUntil} is null or ${onbCases.orchestrationClaimUntil} <= now())`,
        ),
      ),
    ),
  );
  if (rows.length === 0) return;
  const { resumeChecklistOrchestration } = await import("./engine");
  await recoverChecklistRows(
    rows,
    resumeChecklistOrchestration,
    // resumeChecklistOrchestration already performs an owner+token-fenced
    // transition for its own failed claim. The outer recovery loop must never
    // write by case id alone because a successor or HR re-review may now own it.
    async () => {},
  );
}

export async function recoverDecidedApprovalContinuations(): Promise<void> {
  const rows = await db.select({ id: onbCases.id }).from(onbCases).where(
    eq(onbCases.orchestrationStatus, "waiting-approval"),
  );
  if (rows.length === 0) return;
  const { reconcileDecidedApprovals } = await import("./engine");
  for (const row of rows) {
    try {
      await reconcileDecidedApprovals(row.id);
    } catch (error) {
      if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
      const [caseRow] = await db.select({
        organizationId: onbCases.organizationId,
      }).from(onbCases).where(eq(onbCases.id, row.id));
      if (caseRow) {
        reportRestrictedLifecycleRecovery(
          "approval-continuation-recovery",
          { organizationId: caseRow.organizationId, caseId: row.id },
          error,
        );
      }
    }
  }
}

/** Recover only explicitly HR-confirmed Gate A releases; never bulk-email legacy rows. */
export async function recoverConfirmedOfferAcceptanceOrchestrations(): Promise<void> {
  const rows = await db.select({ id: onbCases.id }).from(onbCases).where(and(
    eq(onbCases.offerAcceptanceComplete, true),
    eq(onbCases.orchestrationStatus, "idle"),
    eq(onbCases.orchestrationCheckpoint, "offer-accepted"),
  ));
  if (rows.length === 0) return;
  const { startOrchestration } = await import("./engine");
  for (const row of rows) startOrchestration(row.id);
}

/**
 * A scheduled preboarding source event remains inert until its durable review
 * due point. The keyed approval is the staff work queue; it deliberately has
 * no resume action, because only the explicit evidence-review release route
 * may enter the onboarding engine. If a process dies between writes the next
 * heartbeat repeats the idempotent approval then marks the source event due.
 */
export async function recoverDueStandardIntakeReviews(now = new Date()): Promise<void> {
  const rows = await db.select({
    organizationId: onbStandardIntakeEvents.organizationId,
    caseId: onbStandardIntakeEvents.caseId,
    sourceId: onbStandardIntakeEvents.sourceId,
    sourceEventId: onbStandardIntakeEvents.sourceEventId,
  }).from(onbStandardIntakeEvents).where(and(
    eq(onbStandardIntakeEvents.eventType, "scheduled-preboarding"),
    eq(onbStandardIntakeEvents.activationStatus, "scheduled"),
    lte(onbStandardIntakeEvents.activationDueAt, now),
  ));
  if (!rows.length) return;
  const { createApproval } = await import("./engine");
  for (const row of rows) {
    if (row.caseId === null) continue;
    try {
      await createApproval({
        caseId: row.caseId,
        agent: WATCHER_AGENT,
        ruleRef: "Scheduled preboarding review release",
        hitlPattern: "approve-before-act",
        recommendation: "Review the restricted TA source evidence and explicitly release scheduled preboarding",
        rationale: "The persisted preboarding review due point has arrived. An authorized HR/compliance reviewer must inspect the source evidence reference and use the dedicated standard-intake release control; this queue decision cannot start onboarding by itself.",
        resumeAction: "none",
        authorityScope: "hr-compliance-approve",
        idempotencyKey: `standard-intake-scheduled-review:${row.sourceId}:${row.sourceEventId}`,
      });
      await db.update(onbStandardIntakeEvents).set({
        activationStatus: "due-review",
        activationReviewRequestedAt: now,
      }).where(and(
        eq(onbStandardIntakeEvents.organizationId, row.organizationId),
        eq(onbStandardIntakeEvents.sourceId, row.sourceId),
        eq(onbStandardIntakeEvents.sourceEventId, row.sourceEventId),
        eq(onbStandardIntakeEvents.activationStatus, "scheduled"),
      ));
    } catch (error) {
      if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
      reportRestrictedLifecycleRecovery(
        "scheduled-standard-intake-review",
        { organizationId: row.organizationId, caseId: row.caseId },
        error,
      );
    }
  }
}

/** Recover a detached explicit release if the request died before its starter ran. */
export async function recoverReleasedStandardIntakeOrchestrations(): Promise<void> {
  const rows = await db.select({ id: onbCases.id }).from(onbStandardIntakeEvents).innerJoin(onbCases, and(
    eq(onbStandardIntakeEvents.organizationId, onbCases.organizationId),
    eq(onbStandardIntakeEvents.caseId, onbCases.id),
  )).where(and(
    eq(onbStandardIntakeEvents.activationStatus, "released"),
    eq(onbCases.orchestrationStatus, "idle"),
    sql`${onbCases.orchestrationCheckpoint} is null`,
  ));
  if (!rows.length) return;
  const { startOrchestration } = await import("./engine");
  for (const row of rows) startOrchestration(row.id);
}

/** Durable recovery for an approved Gate C decision whose async handoff died. */
export async function recoverApprovedDay1ReadinessGates(): Promise<void> {
  const approvals = await db.select({ caseId: onbApprovals.caseId }).from(onbApprovals).where(and(
    eq(onbApprovals.status, "approved"),
    sql`${onbApprovals.idempotencyKey} like 'gateway-c:%:human-queue'`,
  ));
  if (approvals.length === 0) return;
  const { completeDay1ReadinessGate } = await import("./engine");
  for (const approval of approvals) {
    try {
      await completeDay1ReadinessGate(approval.caseId);
    } catch (error) {
      if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
      const [caseRow] = await db.select({
        organizationId: onbCases.organizationId,
      }).from(onbCases).where(eq(onbCases.id, approval.caseId));
      if (caseRow) {
        reportRestrictedLifecycleRecovery(
          "day1-readiness-recovery",
          { organizationId: caseRow.organizationId, caseId: approval.caseId },
          error,
        );
      }
    }
  }
}

/** Repairs the old split-write failure window: an overdue check always owns a queue item. */
export async function recoverOverdueSystemApprovalQueues(
  onlyCaseIds?: readonly number[],
): Promise<void> {
  if (onlyCaseIds?.length === 0) return;
  const overdue = await db.select().from(onbSystemChecks)
    .where(and(
      eq(onbSystemChecks.status, "overdue"),
      ...(onlyCaseIds ? [inArray(onbSystemChecks.caseId, [...onlyCaseIds])] : []),
    ))
    .orderBy(onbSystemChecks.id);
  for (const check of overdue) {
    const def = systemDef(check.system);
    if (!def) continue;
    try {
      await withCaseDerivedLifecycleWrite({
        organizationId: check.organizationId, caseId: check.caseId,
      }, (tx) => tx.insert(onbApprovals).values({
        organizationId: check.organizationId, caseId: check.caseId, agent: WATCHER_AGENT,
        ruleRef: check.system === "bgv" ? "Gate B — background verification" : def.slaRuleRef,
        hitlPattern: "hard-block", resumeAction: "none",
        recommendation: `Review the ${def.label} exception or SLA breach`,
        rationale: `${def.label} (${check.externalRef}) remains overdue and requires human review; no automated adverse action was taken.`,
        authorityScope: "hr-compliance-approve",
        idempotencyKey: `gateway-${check.system}:${check.id}:${(check.escalatedAt ?? check.dueAt).getTime()}:human-queue`,
      }).onConflictDoNothing({ target: [onbApprovals.organizationId, onbApprovals.idempotencyKey] }));
    } catch (error) {
      if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
      reportRestrictedLifecycleRecovery(
        "overdue-system-approval-recovery",
        { organizationId: check.organizationId, caseId: check.caseId, checkId: check.id },
        error,
      );
    }
  }
}

export async function recoverChecklistRows(
  rows: Array<{ id: number }>,
  resume: (id: number) => Promise<unknown>,
  suspend: (id: number, error: unknown) => Promise<void>,
): Promise<void> {
  for (const row of rows) {
    try {
      await resume(row.id);
    } catch (error) {
      // One poisoned/ambiguous effect must not abort the heartbeat or prevent
      // recovery of another tenant. Leave an explicit suspended checkpoint.
      await suspend(row.id, error).catch(() => {});
      console.error(`[system-watcher] checklist recovery suspended case ${row.id}:`, error);
    }
  }
}

async function tickOnce(): Promise<void> {
  const now = Date.now();
  // Connector configuration is tenant-owned. Seed only organizations that
  // own active work, never a global/default connector set.
  const organizations = await db
    .selectDistinct({ organizationId: onbCases.organizationId })
    .from(onbCases);
  await Promise.all(organizations.map(({ organizationId }) => ensureConnectorsSeeded(organizationId)));
  await sweepExpiredNonIdempotentEffects();
  // Document evidence is validated asynchronously from the shared heartbeat.
  // Failures are isolated so an unavailable object/provider never stops BGV monitoring.
  await runDocumentMalwareTick().catch(() => {
    logger.error({ component: "document-malware-scanner" }, "document malware scan tick failed; files remain quarantined");
  });
  // Scanner operational health is driven by the same awaited heartbeat as the
  // watcher. It has durable claims and stale-data detection, so autoscale
  // pauses and concurrent instances cannot silently leave a green result.
  await runMalwareScannerMonitorTick().catch(() => {
    logger.error(
      { component: "malware-scanner-monitor" },
      "malware scanner monitor tick failed; persisted health may become stale",
    );
  });
  await runDocumentValidationTick().catch((error) => {
    logger.error({ component: "document-validator", error: String(error).slice(0, 300) }, "document validation tick failed");
  });
  await runDocumentReminderTick().catch((error) => {
    logger.error({ component: "document-reminder", error: String(error).slice(0, 300) }, "document reminder tick failed");
  });
  // Governance review reminders use the same externally-driven durable
  // heartbeat. They only create persisted review work; no provider is called.
  await runGovernanceReminderTick().catch((error) => {
    logger.error({ component: "governance-reminder", error: String(error).slice(0, 300) }, "governance reminder tick failed");
  });
  // Timer-only lifecycle deletion can be frozen on autoscale. This shared
  // heartbeat awaits an in-flight deletion tick and therefore cannot return
  // while a claimed job is still between durable recovery boundaries.
  await runSensitiveLifecycleDeletionTick();
  await recoverChecklistOrchestrations();
  // A human task response may have committed while its guarded connector
  // continuation was refused. Retry its durable record independently of the
  // case's current orchestration status; the dispatcher rechecks real gates.
  await recoverWorkforceConnectorContinuations();
  await recoverDecidedApprovalContinuations();
  await recoverConfirmedOfferAcceptanceOrchestrations();
  await recoverDueStandardIntakeReviews();
  await recoverReleasedStandardIntakeOrchestrations();
  await recoverApprovedDay1ReadinessGates();
  await runFrontlineReleaseHeartbeat().catch((error) => {
    logger.error({ component: "frontline-release-heartbeat", error: String(error).slice(0, 300) }, "frontline release heartbeat failed");
  });
  await recoverOverdueSystemApprovalQueues();

  // Self-heal: preboarding cases that somehow have no checks yet.
  await recoverUntrackedCaseSystems();

  const checks = await openChecks();

  // Push systems only schedule synthetic vendor callbacks in explicitly
  // non-production execution. Production waits for authenticated webhooks.
  if (simulatedProviderCompletionsAllowed()) {
    for (const check of checks) {
      if (check.mode === "push") schedulePush(check);
    }
  }

  // Poll systems use the deterministic simulated adapter only outside
  // production. A production heartbeat must not synthesize provider outcomes.
  for (const def of simulatedProviderCompletionsAllowed()
    ? WATCHED_SYSTEMS.filter((d) => d.mode === "poll")
    : []) {
    const t = telemetry[def.key];
    t.lastPollAt = new Date();
    try {
      const mine = checks.filter(
        (c) => c.system === def.key && c.mode === "poll",
      );
      for (const check of mine) {
        try {
          const connected = await connectorConnected(def.connectorKey, check.organizationId);
          if (!connected) {
            // Disconnection explains a missed check, but is not itself an SLA
            // breach. Preserve the check's deadline before escalating.
            if (disconnectedCheckIsOverdue(check, now) &&
                !(await hasReadinessSlaEnrollment(check.organizationId, check.caseId))) {
              await escalateCheck(check, `${def.label} connector ("${def.connectorKey}") is disconnected — status API unreachable`, "poll");
            }
            continue;
          }
          await db
            .update(onbSystemChecks)
            .set({ lastCheckedAt: new Date() })
            .where(and(eq(onbSystemChecks.id, check.id), eq(onbSystemChecks.organizationId, check.organizationId)));
          const status = simulateVendorStatus(
            def,
            check.requestedAt,
            check.caseId,
            now,
          );
          if (status === "completed") {
            await completeCheck(check, "scheduled poll", "simulated");
          }
        } catch (error) {
          if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
          reportRestrictedLifecycleRecovery(
            "poll-check",
            { organizationId: check.organizationId, caseId: check.caseId, checkId: check.id },
            error,
          );
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
    try {
      if (check.status !== "pending") continue;
      // Enrolled cases have one deadline authority: their policy snapshot.
      // Vendor exceptions/regressions above still independently require review.
      if (await hasReadinessSlaEnrollment(check.organizationId, check.caseId)) continue;
      if (now <= check.dueAt.getTime()) continue;
      const def = systemDef(check.system);
      if (!def) continue;
      if (check.mode === "email") {
        await escalateCheck(
          check,
          `No status email quoting ${check.externalRef} has arrived in the watch mailbox.`,
          undefined,
          "overdue",
          "simulated",
        );
        continue;
      }
      const connected = await connectorConnected(def.connectorKey, check.organizationId);
      await escalateCheck(
        check,
        connected
          ? `The ${def.mode === "push" ? "vendor has not pushed a completion webhook" : "vendor status API still reports in-progress"}.`
          : `The ${def.label} connector is disconnected, so no status updates are arriving.`,
        undefined,
        "overdue",
        "simulated",
      );
    } catch (error) {
      if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
      reportRestrictedLifecycleRecovery(
        "sla-sweep",
        { organizationId: check.organizationId, caseId: check.caseId, checkId: check.id },
        error,
      );
    }
  }
}

/**
 * Run one watcher tick on demand. Safe to call from an HTTP handler:
 * idempotent, never throws, and when a tick is already in flight the
 * caller AWAITS it (returning false) so a completed tick has always
 * happened by the time the promise resolves.
 */
export const runSystemWatcherTick = makeSharedTick(async () => {
  try {
    await tickOnce();
    await reconcileCurrentBgvNotifications("heartbeat");
  } catch (err) {
    console.error("[system-watcher] tick failed:", String(err).slice(0, 300));
  }
});
export function startSystemWatcher(): void {
  if (timer) return;
  const tick = () => void runSystemWatcherTick();
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
