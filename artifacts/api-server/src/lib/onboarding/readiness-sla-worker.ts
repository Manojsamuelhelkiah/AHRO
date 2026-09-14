import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbApprovals,
  onbCases,
  onbEvents,
  onbReadinessSlaCaseState,
  onbReadinessSlaLedger,
  onbReadinessSlaOutbox,
  onbReadinessSlaSnapshots,
} from "@workspace/db/schema";
import {
  actionStatusAt,
  type ReadinessSlaActionTiming,
} from "./readiness-sla";
import {
  ensureReadinessSlaEnrollment,
  getReadinessSlaView,
  reopenGateCApprovalInTransaction,
  readinessSlaGateForCase,
  suppressReadinessSlaOutboxInTransaction,
  type ReadinessSlaActionView,
  type ReadinessSlaView,
} from "./readiness-sla-policy";
import { approvalRef, approvalVersion, reopenApprovalInTransaction } from "./approval-version";
import type { OnboardingDbTransaction } from "./settings";
import { isValidEmail } from "./settings";
import { sendAdministrativeEmail } from "./channels";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import {
  assertCaseDerivedLifecycleWriteAllowedInTransaction,
  withCaseDerivedLifecycleWrite,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

export const READINESS_SLA_WORKER = "readiness-sla-worker";

type TickOptions = { now?: Date; owner?: string };
type TickResult = {
  cases: number;
  enrolled: number;
  warnings: number;
  breaches: number;
  escalations: number;
  resolved: number;
  notifications: number;
  notificationFailures: number;
};

function timingFromView(action: ReadinessSlaActionView): ReadinessSlaActionTiming {
  if (!action.dueAt) {
    return {
      status: "needs-configuration",
      dueAt: null,
      warningAt: null,
      escalationAt: null,
      reason: action.reason,
    };
  }
  return {
    status: "scheduled",
    dueAt: new Date(action.dueAt),
    warningAt: action.warningAt ? new Date(action.warningAt) : null,
    escalationAt: action.escalationAt ? new Date(action.escalationAt) : null,
    reason: action.reason,
  };
}

function rationale(
  action: ReadinessSlaActionView,
  state: "warning" | "breach" | "escalated",
  now: Date,
): string {
  const due = action.dueAt ?? "not configured";
  const overdueMs = action.dueAt ? Math.max(0, now.getTime() - new Date(action.dueAt).getTime()) : 0;
  const overdueHours = (overdueMs / 3600_000).toFixed(1);
  return [
    `Owner: ${action.owner}${action.backupEmail ? ` (backup ${action.backupEmail})` : ""}.`,
    `Action: ${action.label}.`,
    `Due: ${due}.`,
    `Current time: ${now.toISOString()}.`,
    `${state === "warning" ? "Warning window is open" : `Overdue by ${overdueHours} hours (${state})`}.`,
    "A human owner must review the readiness action; no employment decision was made automatically.",
  ].join(" ");
}

function historyEntry(
  state: "warned" | "breached" | "escalated" | "resolved",
  at: Date,
  detail: string,
) {
  return { state, at: at.toISOString(), rationale: detail };
}

async function reopenGateCIfNeeded(
  organizationId: string,
  caseId: number,
  view: ReadinessSlaView,
  action: ReadinessSlaActionView,
  now: Date,
): Promise<void> {
  await withSensitiveLifecycleFence(organizationId, () => db.transaction(async (tx) => {
  const [c] = await tx.select().from(onbCases).where(and(
      eq(onbCases.id, caseId),
      eq(onbCases.organizationId, organizationId),
    )).for("update");
    if (!c || (c.lifecycleStage !== "complete" && c.lifecycleStage !== "day1-review")) return;
    await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, { organizationId, caseId });
    // Re-read every source under the case lock. The view used to schedule the
    // tick may be stale while a source webhook/attestation is racing it.
    const fresh = await readinessSlaGateForCase(tx, organizationId, caseId);
    if (fresh.streams.every((stream) => !stream.applicable || stream.status === "complete")) return;
    await reopenGateCApprovalInTransaction(
      tx,
      organizationId,
      caseId,
      "Gate C reopened because weighted readiness regressed; fresh readiness review is required.",
      READINESS_SLA_WORKER,
    );
    await tx.update(onbCases).set({
      lifecycleStage: "preboarding",
      orchestrationStatus: "checklist-blocked",
      orchestrationCheckpoint: "blocked:weighted-readiness-regression",
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
      updatedAt: now,
    }).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId)));
    await tx.insert(onbEvents).values({
      organizationId,
      caseId,
      agent: READINESS_SLA_WORKER,
      engine: "rules",
      hitlPattern: "hard-block",
      ruleRef: "Gate C — weighted readiness regression",
      title: "Gate C reopened after readiness regression",
      detail: `${action.label} is ${action.status}; weighted readiness is no longer complete. A fresh human Gate C review is required.`,
      idempotencyKey: `readiness-sla:${caseId}:gate-c-regression:${view.snapshotVersion}:${action.key}`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
  }));
}

async function createOrUpdateApproval(
  organizationId: string,
  caseId: number,
  snapshotVersion: number,
  action: ReadinessSlaActionView,
  state: "warning" | "breach" | "escalated",
  now: Date,
  allowResolvedReopen = false,
): Promise<void> {
  const key = `readiness-sla:${caseId}:${snapshotVersion}:${action.key}:decision`;
  const detail = rationale(action, state, now);
  await withSensitiveLifecycleFence(organizationId, () => db.transaction(async (tx) => {
    await tx.select({ id: onbCases.id }).from(onbCases).where(and(
      eq(onbCases.organizationId, organizationId),
      eq(onbCases.id, caseId),
    )).for("update");
    await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, { organizationId, caseId });
    const [existing] = await tx.select().from(onbApprovals).where(and(
      eq(onbApprovals.organizationId, organizationId),
      eq(onbApprovals.caseId, caseId),
      eq(onbApprovals.idempotencyKey, key),
    )).for("update");
    if (!existing) {
      await tx.insert(onbApprovals).values({
        organizationId,
        caseId,
        agent: READINESS_SLA_WORKER,
        ruleRef: `Weighted readiness SLA — ${action.key}`,
        hitlPattern: "hard-block",
        recommendation: `Review ${action.label} and record the safe next step`,
        rationale: detail,
        status: "pending",
        resumeAction: "none",
        authorityScope: "hr-compliance-approve",
        idempotencyKey: key,
      }).onConflictDoNothing({
        target: [onbApprovals.organizationId, onbApprovals.idempotencyKey],
      });
      return;
    }
    if (existing.status === "pending") {
      await tx.update(onbApprovals).set({
        rationale: detail,
        recommendation: `Review ${action.label} and record the safe next step`,
        resumeAction: "none",
      }).where(and(
        eq(onbApprovals.organizationId, organizationId),
        eq(onbApprovals.id, existing.id),
        eq(onbApprovals.status, "pending"),
      ));
      return;
    }
    // A breach after a warning decision is a new human decision cycle on the
    // same action. Source completion is terminal for that occurrence: never
    // reopen the resolved row merely because a stale timer/email arrives.
    const reopenStatuses = allowResolvedReopen && existing.status === "resolved"
      ? ["resolved"]
      : ["approved", "rejected"];
    if ((state === "breach" || state === "escalated") &&
      (reopenStatuses.includes(existing.status))) {
      const reopened = await reopenApprovalInTransaction(tx, {
        organizationId,
        caseId,
        approvalId: existing.id,
        reason: detail,
        actor: READINESS_SLA_WORKER,
        reopenStatuses,
      });
      if (reopened.reopened) {
        await tx.update(onbApprovals).set({
          rationale: detail,
          recommendation: `Review ${action.label} and record the safe next step`,
          resumeAction: "none",
        }).where(and(
          eq(onbApprovals.organizationId, organizationId),
          eq(onbApprovals.id, existing.id),
          eq(onbApprovals.status, "pending"),
          eq(onbApprovals.version, reopened.version),
        ));
      }
    }
  }));
}

async function resolveApprovalInTransaction(
  tx: OnboardingDbTransaction,
  organizationId: string,
  caseId: number,
  snapshotVersion: number,
  actionKey: string,
  now: Date,
): Promise<void> {
  const key = `readiness-sla:${caseId}:${snapshotVersion}:${actionKey}:decision`;
  await tx.update(onbApprovals).set({
    status: "resolved",
    decidedBy: READINESS_SLA_WORKER,
    decidedAt: now,
    comment: "Source completion resolved the readiness SLA action; no employment decision was fabricated.",
    resumeAction: "none",
  }).where(and(
    eq(onbApprovals.organizationId, organizationId),
    eq(onbApprovals.caseId, caseId),
    eq(onbApprovals.idempotencyKey, key),
    eq(onbApprovals.status, "pending"),
  ));
}

async function recordActionState(
  organizationId: string,
  caseId: number,
  snapshotVersion: number,
  action: ReadinessSlaActionView,
  timing: ReadinessSlaActionTiming,
  view: ReadinessSlaView,
  now: Date,
): Promise<{ state: "warning" | "breach" | "escalated" | "resolved" | "none"; changed: boolean }> {
  return withSensitiveLifecycleFence(organizationId, async () => {
    await withCaseDerivedLifecycleWrite({ organizationId, caseId }, async () => undefined);
    return recordActionStateUnlocked(organizationId, caseId, snapshotVersion, action, timing, view, now);
  });
}

async function recordActionStateUnlocked(
  organizationId: string,
  caseId: number,
  snapshotVersion: number,
  action: ReadinessSlaActionView,
  timing: ReadinessSlaActionTiming,
  view: ReadinessSlaView,
  now: Date,
): Promise<{ state: "warning" | "breach" | "escalated" | "resolved" | "none"; changed: boolean }> {
  const [latest] = await db.select().from(onbReadinessSlaLedger).where(and(
    eq(onbReadinessSlaLedger.organizationId, organizationId),
    eq(onbReadinessSlaLedger.caseId, caseId),
    eq(onbReadinessSlaLedger.snapshotVersion, snapshotVersion),
    eq(onbReadinessSlaLedger.actionKey, action.key),
  )).orderBy(desc(onbReadinessSlaLedger.occurrence)).limit(1);
  const stream = view.streams.find((item) => item.key === action.streamKey);
  const complete = stream?.status === "complete" || stream?.status === "not-applicable";
  if (complete) {
    return db.transaction(async (tx) => {
      await tx.select({ id: onbCases.id }).from(onbCases).where(and(
        eq(onbCases.organizationId, organizationId),
        eq(onbCases.id, caseId),
      )).for("update");
      await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, { organizationId, caseId });
      const [lockedLatest] = await tx.select().from(onbReadinessSlaLedger).where(and(
        eq(onbReadinessSlaLedger.organizationId, organizationId),
        eq(onbReadinessSlaLedger.caseId, caseId),
        eq(onbReadinessSlaLedger.snapshotVersion, snapshotVersion),
        eq(onbReadinessSlaLedger.actionKey, action.key),
      )).orderBy(desc(onbReadinessSlaLedger.occurrence)).limit(1).for("update");
      if (!lockedLatest || lockedLatest.state === "resolved" || lockedLatest.state === "not-applicable") {
        return { state: "resolved", changed: false };
      }
      const detail = "Source completion resolved the SLA action without making an employment decision.";
      const [updated] = await tx.update(onbReadinessSlaLedger).set({
        state: "resolved",
        resolvedAt: now,
        lastRationale: detail,
        history: [...lockedLatest.history, historyEntry("resolved", now, detail)],
        updatedAt: now,
      }).where(and(
        eq(onbReadinessSlaLedger.organizationId, organizationId),
        eq(onbReadinessSlaLedger.id, lockedLatest.id),
        sql`${onbReadinessSlaLedger.state} <> 'resolved'`,
      )).returning({ id: onbReadinessSlaLedger.id });
      if (!updated) return { state: "resolved", changed: false };
      await suppressReadinessSlaOutboxInTransaction(
        tx,
        organizationId,
        caseId,
        "source completion resolved the linked SLA obligation",
        lockedLatest.id,
      );
      await resolveApprovalInTransaction(tx, organizationId, caseId, snapshotVersion, action.key, now);
      return { state: "resolved", changed: true };
    });
  }
  if (timing.status === "needs-configuration") {
    if (!latest) {
      await db.insert(onbReadinessSlaLedger).values({
        organizationId,
        caseId,
        snapshotVersion,
        actionKey: action.key,
        state: "needs-configuration",
        dueAt: null,
        warningAt: null,
        history: [],
      });
    }
    return { state: "none", changed: false };
  }
  const stage = actionStatusAt(timing, now);
  if (stage === "scheduled") {
    if (!latest) {
      await db.insert(onbReadinessSlaLedger).values({
        organizationId,
        caseId,
        snapshotVersion,
        actionKey: action.key,
        state: "scheduled",
        dueAt: timing.dueAt,
        warningAt: timing.warningAt,
        history: [],
      });
    }
    return { state: "none", changed: false };
  }
  const nextState = stage === "warning" ? "warning" : stage === "breach" ? "breach" : "escalated";
  const ledgerState = nextState === "warning" ? "warned" : nextState === "breach" ? "breached" : "escalated";
  const detail = rationale(action, nextState, now);
  const allowResolvedReopen = latest?.state === "resolved";
  let row = latest;
  // A source regression after resolution creates a new occurrence. Old
  // breaches and notifications remain immutable history.
  if (!row || row.state === "resolved" || row.state === "needs-configuration") {
    const occurrence = (latest?.occurrence ?? 0) + 1;
    const [inserted] = await db.insert(onbReadinessSlaLedger).values({
      organizationId,
      caseId,
      snapshotVersion,
      actionKey: action.key,
      occurrence,
      state: ledgerState,
      dueAt: timing.dueAt,
      warningAt: timing.warningAt,
      breachAt: ledgerState === "breached" || ledgerState === "escalated" ? now : null,
      escalatedAt: ledgerState === "escalated" ? now : null,
      lastRationale: detail,
      history: [historyEntry(ledgerState, now, detail)],
    }).returning();
    row = inserted;
  } else if (row.state !== ledgerState && row.state !== "escalated") {
    const history = [...row.history];
    if (ledgerState === "breached" || ledgerState === "escalated") {
      history.push(historyEntry(ledgerState, now, detail));
    } else if (row.state === "scheduled") {
      history.push(historyEntry("warned", now, detail));
    }
    const [updated] = await db.update(onbReadinessSlaLedger).set({
      state: ledgerState,
      breachAt: ledgerState === "breached" || ledgerState === "escalated" ? now : row.breachAt,
      escalatedAt: ledgerState === "escalated" ? now : row.escalatedAt,
      lastRationale: detail,
      history,
      updatedAt: now,
    }).where(and(
      eq(onbReadinessSlaLedger.organizationId, organizationId),
      eq(onbReadinessSlaLedger.id, row.id),
      sql`${onbReadinessSlaLedger.state} <> 'resolved'`,
    )).returning();
    row = updated ?? row;
  } else {
    return { state: nextState, changed: false };
  }
  await createOrUpdateApproval(
    organizationId,
    caseId,
    snapshotVersion,
    action,
    nextState,
    now,
    allowResolvedReopen,
  );
  await reopenGateCIfNeeded(organizationId, caseId, view, action, now);
  return { state: nextState, changed: true };
}

async function enqueueNotification(
  organizationId: string,
  caseId: number,
  ledgerId: number,
  action: ReadinessSlaActionView,
  state: "warning" | "breach" | "escalated",
  now: Date,
): Promise<void> {
  return withSensitiveLifecycleFence(organizationId, async () => {
    await withCaseDerivedLifecycleWrite({ organizationId, caseId }, async () => undefined);
    return enqueueNotificationUnlocked(organizationId, caseId, ledgerId, action, state, now);
  });
}

async function enqueueNotificationUnlocked(
  organizationId: string,
  caseId: number,
  ledgerId: number,
  action: ReadinessSlaActionView,
  state: "warning" | "breach" | "escalated",
  now: Date,
): Promise<void> {
  const base = `readiness-sla:${caseId}:${ledgerId}:${state}`;
  const notificationBody = [
    rationale(action, state, now),
    "",
    "To acknowledge this review, sign in to the same organization and open Action Center → Approvals.",
    "Email replies are notification receipts only and do not approve, reject, or release any readiness gate.",
  ].join("\n");
  if (action.notifyInApp) {
    await db.insert(onbReadinessSlaOutbox).values({
      organizationId,
      caseId,
      ledgerId,
      eventKey: `${base}:in-app`,
      channel: "in-app",
      recipient: null,
      payload: { title: `${action.label} ${state}`, body: notificationBody, owner: action.owner },
      status: "sent",
      deliveryInfo: "Durable in-app notification queued",
    }).onConflictDoNothing({
      target: [onbReadinessSlaOutbox.organizationId, onbReadinessSlaOutbox.eventKey],
    });
    await db.update(onbReadinessSlaOutbox).set({
      status: "sent",
      deliveryInfo: "Durable in-app notification queued",
      updatedAt: now,
    }).where(and(
      eq(onbReadinessSlaOutbox.organizationId, organizationId),
      eq(onbReadinessSlaOutbox.eventKey, `${base}:in-app`),
      eq(onbReadinessSlaOutbox.channel, "in-app"),
      eq(onbReadinessSlaOutbox.status, "pending"),
    ));
  }
  // Default is email-off. Only a validated configured backup/owner address
  // enters the outbox; sendAdministrativeEmail performs the existing
  // organization allowlist check again at dispatch time.
  if (!action.notifyEmail) return;
  const recipients = [action.owner, action.backupEmail]
    .filter((value): value is string => Boolean(value && isValidEmail(value)));
  // Resolve the current approval by the linked ledger's immutable snapshot.
  const [ledger] = await db.select({ snapshotVersion: onbReadinessSlaLedger.snapshotVersion })
    .from(onbReadinessSlaLedger)
    .where(and(
      eq(onbReadinessSlaLedger.organizationId, organizationId),
      eq(onbReadinessSlaLedger.id, ledgerId),
    ));
  const [linkedApproval] = ledger
    ? await db.select({
        id: onbApprovals.id,
        version: onbApprovals.version,
        status: onbApprovals.status,
      }).from(onbApprovals).where(and(
        eq(onbApprovals.organizationId, organizationId),
        eq(onbApprovals.caseId, caseId),
        eq(onbApprovals.idempotencyKey, `readiness-sla:${caseId}:${ledger.snapshotVersion}:${action.key}:decision`),
      ))
    : [];
  if (!linkedApproval || linkedApproval.status !== "pending") return;
  const ref = approvalRef(linkedApproval.id, approvalVersion(linkedApproval.version));
  const body = [
    rationale(action, state, now),
    "",
    `Approval acknowledgment reference: ${ref}.`,
    "Sign in to the same organization and open Action Center → Approvals to acknowledge this readiness SLA warning/breach.",
    "Email replies are notification receipts only; they do not approve, reject, claim source completion, or release a gateway.",
  ].join("\n");
  for (const recipient of recipients) {
    await db.insert(onbReadinessSlaOutbox).values({
      organizationId,
      caseId,
      ledgerId,
      eventKey: `${base}:email:${recipient.toLowerCase()}`,
      channel: "email",
      recipient,
      payload: {
        title: `${action.label} ${state} — ${ref}`,
        body,
        owner: action.owner,
        approvalId: linkedApproval.id,
        approvalVersion: approvalVersion(linkedApproval.version),
        approvalRef: ref,
      },
    }).onConflictDoNothing({
      target: [onbReadinessSlaOutbox.organizationId, onbReadinessSlaOutbox.eventKey],
    });
  }
}

type ReadinessSlaOutboxPayload = {
  title?: string;
  body?: string;
  owner?: string;
  approvalId?: number;
  approvalVersion?: number;
  approvalRef?: string;
};

async function suppressOutboxRowInTransaction(
  tx: OnboardingDbTransaction,
  rowId: number,
  now: Date,
  reason: string,
): Promise<void> {
  await tx.update(onbReadinessSlaOutbox).set({
    status: "failed",
    deliveryInfo: `Suppressed: ${reason}. Terminal; no automatic retry.`,
    lastError: `sla-obligation-suppressed: ${reason}`.slice(0, 500),
    claimOwner: null,
    claimUntil: null,
    updatedAt: now,
  }).where(and(
    eq(onbReadinessSlaOutbox.id, rowId),
    eq(onbReadinessSlaOutbox.status, "pending"),
  ));
}

/**
 * The claim boundary is also an evidence boundary. A pending email can sit
 * behind a source webhook, worker tick, or explicit rebase, so re-read the
 * case, current snapshot, linked ledger, approval cycle, and source stream
 * while holding the case lock before allowing a provider call.
 */
export async function claimReadinessSlaOutbox(
  rowId: number,
  owner: string,
  now: Date,
): Promise<typeof onbReadinessSlaOutbox.$inferSelect | null> {
  const [initial] = await db.select({ organizationId: onbReadinessSlaOutbox.organizationId })
    .from(onbReadinessSlaOutbox).where(eq(onbReadinessSlaOutbox.id, rowId));
  if (!initial) return null;
  return withSensitiveLifecycleFence(initial.organizationId, () => db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(onbReadinessSlaOutbox).where(
      eq(onbReadinessSlaOutbox.id, rowId),
    );
    if (!candidate) return null;
    // Lock order matches source-resolution and rebase writers: case first,
    // then the outbox row. This makes the claim itself case-scoped.
    const [c] = await tx.select().from(onbCases).where(and(
      eq(onbCases.organizationId, candidate.organizationId),
      eq(onbCases.id, candidate.caseId),
    )).for("update");
    if (c && isSyntheticOfflineCase(c)) return null;
    const [row] = c
      ? await tx.select().from(onbReadinessSlaOutbox).where(and(
          eq(onbReadinessSlaOutbox.organizationId, candidate.organizationId),
          eq(onbReadinessSlaOutbox.id, rowId),
          eq(onbReadinessSlaOutbox.caseId, candidate.caseId),
        )).for("update")
      : [];
    if (!row || row.status !== "pending" || row.channel !== "email" || row.availableAt > now) return null;

    const [state] = c
      ? await tx.select().from(onbReadinessSlaCaseState).where(and(
          eq(onbReadinessSlaCaseState.organizationId, row.organizationId),
          eq(onbReadinessSlaCaseState.caseId, row.caseId),
        )).for("update")
      : [];
    const [ledger] = row.ledgerId
      ? await tx.select().from(onbReadinessSlaLedger).where(and(
          eq(onbReadinessSlaLedger.organizationId, row.organizationId),
          eq(onbReadinessSlaLedger.id, row.ledgerId),
          eq(onbReadinessSlaLedger.caseId, row.caseId),
        )).for("update")
      : [];
    const suppress = async (reason: string) => {
      await suppressOutboxRowInTransaction(tx, row.id, now, reason);
    };
    if (!c || !state || !ledger) {
      await suppress("case, current SLA state, or linked ledger is missing");
      return null;
    }
    if (state.snapshotVersion !== ledger.snapshotVersion) {
      await suppress(`linked ledger snapshot ${ledger.snapshotVersion} is superseded by current snapshot ${state.snapshotVersion}`);
      return null;
    }
    const [snapshot] = await tx.select().from(onbReadinessSlaSnapshots).where(and(
      eq(onbReadinessSlaSnapshots.organizationId, row.organizationId),
      eq(onbReadinessSlaSnapshots.caseId, row.caseId),
      eq(onbReadinessSlaSnapshots.snapshotVersion, state.snapshotVersion),
    ));
    const action = snapshot?.policy.actions.find((item) => item.key === ledger.actionKey && item.enabled);
    if (!snapshot || !action) {
      await suppress("linked SLA action is missing from the current snapshot");
      return null;
    }
    if (!action.notifyEmail) {
      await suppress("current SLA action policy disables email notification");
      return null;
    }
    const payload = (row.payload ?? {}) as ReadinessSlaOutboxPayload;
    const [approval] = await tx.select().from(onbApprovals).where(and(
      eq(onbApprovals.organizationId, row.organizationId),
      eq(onbApprovals.caseId, row.caseId),
      eq(onbApprovals.idempotencyKey, `readiness-sla:${row.caseId}:${ledger.snapshotVersion}:${ledger.actionKey}:decision`),
    )).for("update");
    const currentApprovalVersion = approval ? approvalVersion(approval.version) : null;
    if (!approval || approval.status !== "pending" ||
        payload.approvalId !== approval.id ||
        payload.approvalVersion !== currentApprovalVersion ||
        payload.approvalRef !== approvalRef(approval.id, currentApprovalVersion)) {
      await suppress("linked approval cycle is missing, decided, or no longer the queued AP-id-Vversion");
      return null;
    }

    // Source truth wins over a stale ledger tick. Resolve and suppress in this
    // same case transaction, so the provider can never see a false current
    // obligation.
    const fresh = await readinessSlaGateForCase(tx, row.organizationId, row.caseId);
    const stream = fresh.streams.find((item) => item.key === action.streamKey);
    if (stream?.status === "complete" || stream?.status === "not-applicable") {
      const detail = "Fresh source evidence resolved the SLA action before notification claim.";
      if (ledger.state !== "resolved") {
        await tx.update(onbReadinessSlaLedger).set({
          state: "resolved",
          resolvedAt: now,
          lastRationale: detail,
          history: [...ledger.history, historyEntry("resolved", now, detail)],
          updatedAt: now,
        }).where(and(
          eq(onbReadinessSlaLedger.organizationId, row.organizationId),
          eq(onbReadinessSlaLedger.id, ledger.id),
          sql`${onbReadinessSlaLedger.state} <> 'resolved'`,
        ));
        await resolveApprovalInTransaction(
          tx,
          row.organizationId,
          row.caseId,
          ledger.snapshotVersion,
          ledger.actionKey,
          now,
        );
      }
      await suppressReadinessSlaOutboxInTransaction(
        tx,
        row.organizationId,
        row.caseId,
        "fresh source evidence completed the linked obligation",
        ledger.id,
      );
      return null;
    }
    if (!["warned", "breached", "escalated"].includes(ledger.state)) {
      await suppress(`linked ledger is terminal or not currently actionable (${ledger.state})`);
      return null;
    }

    const [claimed] = await tx.update(onbReadinessSlaOutbox).set({
      status: "claimed",
      claimOwner: owner,
      claimUntil: new Date(now.getTime() + 60_000),
      attempts: sql`${onbReadinessSlaOutbox.attempts} + 1`,
      updatedAt: now,
    }).where(and(
      eq(onbReadinessSlaOutbox.id, row.id),
      eq(onbReadinessSlaOutbox.status, "pending"),
      lte(onbReadinessSlaOutbox.availableAt, now),
    )).returning();
    return claimed ?? null;
  }));
}

async function deliverPendingOutbox(
  owner: string,
  now: Date,
): Promise<{ sent: number; failures: number }> {
  // A lease expiry means the provider outcome is ambiguous. Do not reclaim
  // it for replay; manual reconciliation is the only safe path.
  await db.update(onbReadinessSlaOutbox).set({
    status: "unknown",
    deliveryInfo: "Claim lease expired; provider outcome is unknown and requires manual reconciliation",
    lastError: "expired-claim-lease",
    claimOwner: null,
    claimUntil: null,
    updatedAt: now,
  }).where(and(
    eq(onbReadinessSlaOutbox.status, "claimed"),
    lte(onbReadinessSlaOutbox.claimUntil, now),
  ));
  if (process.env.NODE_ENV === "test" || process.env.ONBOARDING_DISABLE_NOTIFICATIONS === "1") {
    return { sent: 0, failures: 0 };
  }
  const rows = await db.select().from(onbReadinessSlaOutbox).where(and(
    eq(onbReadinessSlaOutbox.status, "pending"),
    lte(onbReadinessSlaOutbox.availableAt, now),
    eq(onbReadinessSlaOutbox.channel, "email"),
  )).orderBy(asc(onbReadinessSlaOutbox.id)).limit(100);
  let sent = 0;
  let failures = 0;
  for (const row of rows) {
    const claimed = await claimReadinessSlaOutbox(row.id, owner, now);
    if (!claimed || !row.recipient) continue;
    try {
      const payload = claimed.payload as ReadinessSlaOutboxPayload;
      const result = await sendAdministrativeEmail({
        caseId: row.caseId,
        toAddress: row.recipient,
        subject: `[Onboarding readiness] ${payload.title ?? "SLA update"}`,
        body: `${payload.body ?? ""}\nOwner: ${payload.owner ?? "HR"}`,
        idempotencyKey: `readiness-sla-outbox:${row.organizationId}:${row.eventKey}`,
      });
      if (result.status === "sent") {
        const [markedSent] = await db.update(onbReadinessSlaOutbox).set({
          status: "sent",
          deliveryInfo: "Administrative email dispatch accepted by the configured provider",
          claimUntil: null,
          updatedAt: now,
        }).where(and(
          eq(onbReadinessSlaOutbox.organizationId, row.organizationId),
          eq(onbReadinessSlaOutbox.id, row.id),
          eq(onbReadinessSlaOutbox.status, "claimed"),
          eq(onbReadinessSlaOutbox.claimOwner, owner),
          eq(onbReadinessSlaOutbox.claimUntil, claimed.claimUntil!),
        )).returning({ id: onbReadinessSlaOutbox.id });
        if (markedSent) sent += 1;
        else failures += 1;
      } else if (result.status === "sending") {
        await db.update(onbReadinessSlaOutbox).set({
          status: "unknown",
          deliveryInfo: result.failureReason ?? "Provider outcome is unknown; manual reconciliation required",
          lastError: result.failureReason,
          claimUntil: null,
          updatedAt: now,
        }).where(and(
          eq(onbReadinessSlaOutbox.organizationId, row.organizationId),
          eq(onbReadinessSlaOutbox.id, row.id),
          eq(onbReadinessSlaOutbox.status, "claimed"),
          eq(onbReadinessSlaOutbox.claimOwner, owner),
          eq(onbReadinessSlaOutbox.claimUntil, claimed.claimUntil!),
        ));
        failures += 1;
      } else {
        await db.update(onbReadinessSlaOutbox).set({
          status: "failed",
          deliveryInfo: result.failureReason ?? "Delivery was blocked or failed; automatic replay is disabled",
          lastError: result.failureReason,
          claimUntil: null,
          updatedAt: now,
        }).where(and(
          eq(onbReadinessSlaOutbox.organizationId, row.organizationId),
          eq(onbReadinessSlaOutbox.id, row.id),
          eq(onbReadinessSlaOutbox.status, "claimed"),
          eq(onbReadinessSlaOutbox.claimOwner, owner),
          eq(onbReadinessSlaOutbox.claimUntil, claimed.claimUntil!),
        ));
        failures += 1;
      }
    } catch (error) {
      // A thrown error may mean the provider was reached. Unknown outcomes
      // are terminal for this worker and must not be replayed automatically.
      await db.update(onbReadinessSlaOutbox).set({
        status: "unknown",
        deliveryInfo: "Delivery outcome is unknown; manual reconciliation required",
        lastError: String(error).slice(0, 500),
        claimUntil: null,
        updatedAt: now,
      }).where(and(
        eq(onbReadinessSlaOutbox.organizationId, row.organizationId),
        eq(onbReadinessSlaOutbox.id, row.id),
        eq(onbReadinessSlaOutbox.status, "claimed"),
        eq(onbReadinessSlaOutbox.claimOwner, owner),
        eq(onbReadinessSlaOutbox.claimUntil, claimed.claimUntil!),
      ));
      failures += 1;
    }
  }
  return { sent, failures };
}

export async function runReadinessSlaTick(options: TickOptions = {}): Promise<TickResult> {
  const now = options.now ?? new Date();
  const owner = options.owner ?? `readiness-sla:${randomUUID()}`;
  // Completed cases are included only so an already-enrolled case can be
  // revoked when fresh source evidence regresses. ensure... returns null for
  // historical completed cases without a snapshot, so they are never silently
  // enrolled by this sweep.
  const cases = (await db.select().from(onbCases))
    .filter((caseRow) => !isSyntheticOfflineCase(caseRow));
  const result: TickResult = {
    cases: cases.length,
    enrolled: 0,
    warnings: 0,
    breaches: 0,
    escalations: 0,
    resolved: 0,
    notifications: 0,
    notificationFailures: 0,
  };
  for (const c of cases) {
    const enrollment = await ensureReadinessSlaEnrollment(c.organizationId, c.id);
    if (!enrollment) continue;
    result.enrolled += 1;
    const view = await getReadinessSlaView(c.organizationId, c.id);
    if (!view?.enrolled || view.snapshotVersion === null) continue;
    for (const action of view.actions) {
      const timing = timingFromView(action);
      const outcome = await recordActionState(
        c.organizationId,
        c.id,
        view.snapshotVersion,
        action,
        timing,
        view,
        now,
      );
      if (outcome.state === "warning") result.warnings += outcome.changed ? 1 : 0;
      if (outcome.state === "breach") result.breaches += outcome.changed ? 1 : 0;
      if (outcome.state === "escalated") result.escalations += outcome.changed ? 1 : 0;
      if (outcome.state === "resolved") result.resolved += outcome.changed ? 1 : 0;
      if (outcome.changed && (outcome.state === "warning" || outcome.state === "breach" || outcome.state === "escalated")) {
        const [ledger] = await db.select().from(onbReadinessSlaLedger).where(and(
          eq(onbReadinessSlaLedger.organizationId, c.organizationId),
          eq(onbReadinessSlaLedger.caseId, c.id),
          eq(onbReadinessSlaLedger.snapshotVersion, view.snapshotVersion),
          eq(onbReadinessSlaLedger.actionKey, action.key),
        )).orderBy(desc(onbReadinessSlaLedger.occurrence)).limit(1);
        if (ledger) {
          await enqueueNotification(c.organizationId, c.id, ledger.id, action, outcome.state, now);
        }
      }
    }
    await reopenGateCIfNeeded(
      c.organizationId,
      c.id,
      view,
      view.actions[0] ?? {
        key: "weighted-readiness",
        streamKey: "weighted-readiness",
        label: "Weighted readiness",
        owner: READINESS_SLA_WORKER,
        backupEmail: null,
        notifyEmail: false,
        notifyInApp: true,
        mandatory: true,
        status: "scheduled",
        dueAt: null,
        warningAt: null,
        escalationAt: null,
        reason: view.reason,
      },
      now,
    );
  }
  const delivery = await deliverPendingOutbox(owner, now);
  result.notifications = delivery.sent;
  result.notificationFailures = delivery.failures;
  return result;
}