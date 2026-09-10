import { and, asc, desc, eq, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbApprovalHistory,
  onbApprovalNotifications,
  onbApprovals,
  onbCases,
  onbSettings,
} from "@workspace/db/schema";
import { sendAdministrativeEmail } from "./channels";
import {
  HR_ALERT_EMAIL_KEY,
  HR_APPROVER_EMAIL_KEY,
  isValidEmail,
} from "./settings";
import {
  appendApprovalDecisionHistory,
  approvalRef,
  approvalVersion,
  type ApprovalDecision,
} from "./approval-version";
import type { OnboardingDbTransaction } from "./settings";

export type { ApprovalDecision };
export type DecisionStaleReason = "version-mismatch" | "already-decided" | "not-pending";

export type DecisionResult =
  | {
      outcome: "decided";
      approval: typeof onbApprovals.$inferSelect;
      /** False until the dedicated gateway reconciliation commits release. */
      released: false;
    }
  | { outcome: "stale"; reason: DecisionStaleReason; currentVersion: number; status: string }
  | { outcome: "not-found" };

export type ApprovalNotificationKind =
  | "request"
  | "decision"
  | "stale"
  | "outstanding"
  | "hr-alert";

const NOTIFICATION_LEASE_MS = 5 * 60_000;
const MAX_DEFINITE_FAILURE_ATTEMPTS = 5;
const READINESS_SLA_AGENT = "readiness-sla-worker";
const READINESS_SLA_RULE_PREFIX = "Weighted readiness SLA —";

type ApprovalLike = Pick<
  typeof onbApprovals.$inferSelect,
  | "id"
  | "caseId"
  | "organizationId"
  | "version"
  | "agent"
  | "hitlPattern"
  | "recommendation"
  | "rationale"
  | "recordsEvidence"
  | "ruleRef"
  | "resumeAction"
  | "status"
  | "decidedBy"
  | "comment"
  | "decidedAt"
>;
type ApprovalRequestLike = Pick<
  typeof onbApprovals.$inferSelect,
  "id" | "caseId" | "organizationId" | "version"
>;
type NotificationValues = {
  organizationId: string;
  approvalId: number;
  caseId: number;
  version: number;
  kind: ApprovalNotificationKind;
  recipient: string;
  subject: string;
  body: string;
  idempotencyKey: string;
  sourceMessageId?: string | null;
};

function normalizedConfiguredAddress(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed && isValidEmail(trimmed) ? trimmed : null;
}

async function configuredRecipients(
  tx: OnboardingDbTransaction,
  organizationId: string,
): Promise<{ approver: string | null; hrAlert: string | null }> {
  const rows = await tx.select({
    key: onbSettings.key,
    value: onbSettings.value,
  }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId),
    sql`${onbSettings.key} in (${HR_APPROVER_EMAIL_KEY}, ${HR_ALERT_EMAIL_KEY})`,
  ));
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    approver: normalizedConfiguredAddress(values.get(HR_APPROVER_EMAIL_KEY)),
    hrAlert: normalizedConfiguredAddress(values.get(HR_ALERT_EMAIL_KEY)),
  };
}

function requestContent(
  approval: ApprovalLike,
  workerName: string,
): { subject: string; body: string } {
  const ref = approvalRef(approval.id, approvalVersion(approval.version));
  const kind = approval.hitlPattern === "hard-block" ? "HARD-BLOCK" : "Approval needed";
  return {
    subject: `[${ref}] ${kind}: ${workerName} (case #${approval.caseId})`,
    body: [
      "The onboarding agent has escalated a decision to you.",
      "",
      `Case: #${approval.caseId} — ${workerName}`,
      `Raised by: ${approval.agent} agent (${approval.hitlPattern})`,
      `Approval cycle: ${ref}`,
      "",
      `Recommendation: ${approval.recommendation}`,
      `Rationale: ${approval.rationale}`,
      "",
      `Reply with exactly "approve" or "reject" to decide ${ref}.`,
      `Only the configured approver address is authorized to decide this approval.`,
    ].join("\n"),
  };
}

function decisionContent(opts: {
  approval: ApprovalLike;
  decidedBy: string;
  decision: ApprovalDecision;
  decidedAt: Date;
  stale?: boolean;
}): { subject: string; body: string } {
  const ref = approvalRef(opts.approval.id, approvalVersion(opts.approval.version));
  const verb = opts.stale ? "was not applied" : "was recorded";
  return {
    subject: `[${ref}] Decision ${opts.stale ? "stale" : "recorded"}: ${opts.decision}`,
    body: [
      opts.stale
        ? `A reply for ${ref} ${verb}; the current approval cycle was already decided or superseded.`
        : `The decision for ${ref} ${verb}.`,
      "",
      `Actor: ${opts.decidedBy}`,
      `Time: ${opts.decidedAt.toISOString()}`,
      `Version: ${approvalVersion(opts.approval.version)}`,
      `Decision: ${opts.decision}`,
      "",
      "This message reports the approval record only. An approval does not by itself claim that a gateway was released.",
      "Any Gate A or Gate C release is reported separately after its dedicated, current-evidence reconciliation commits.",
    ].join("\n"),
  };
}

async function enqueueNotificationTx(
  tx: OnboardingDbTransaction,
  values: NotificationValues,
): Promise<void> {
  await tx.insert(onbApprovalNotifications).values({
    ...values,
    sourceMessageId: values.sourceMessageId ?? null,
  }).onConflictDoNothing({
    target: [
      onbApprovalNotifications.organizationId,
      onbApprovalNotifications.idempotencyKey,
    ],
  });
}

async function enqueueRequestTx(
  tx: OnboardingDbTransaction,
  approval: ApprovalLike,
  workerName: string,
  kind: "request" | "outstanding" = "request",
): Promise<void> {
  // Readiness SLA actions own their warning/breach dispatch in the SLA
  // outbox, including each action's notifyEmail policy. Approval reconciliation
  // must not create a second generic HR request email for those rows.
  if (
    approval.agent === READINESS_SLA_AGENT ||
    approval.ruleRef?.startsWith(READINESS_SLA_RULE_PREFIX)
  ) return;
  const recipients = await configuredRecipients(tx, approval.organizationId);
  if (!recipients.approver) return;
  const content = requestContent(approval, workerName);
  const version = approvalVersion(approval.version);
  await enqueueNotificationTx(tx, {
    organizationId: approval.organizationId,
    approvalId: approval.id,
    caseId: approval.caseId,
    version,
    kind,
    recipient: recipients.approver,
    subject: content.subject,
    body: content.body,
    idempotencyKey: `approval-notification:${approval.id}:v${version}:${kind}`,
  });
}

/**
 * Ensure a direct Gate C/SLA insert has a durable request notification.  This
 * is also used by createApproval; the watcher worker repeats it as recovery.
 */
export async function enqueueApprovalRequestNotification(
  approval: ApprovalRequestLike,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(onbApprovals).where(and(
      eq(onbApprovals.id, approval.id),
      eq(onbApprovals.organizationId, approval.organizationId),
    ));
    if (!current || current.status !== "pending") return;
    const [c] = await tx.select({ workerName: onbCases.workerName }).from(onbCases).where(and(
      eq(onbCases.id, current.caseId),
      eq(onbCases.organizationId, current.organizationId),
    ));
    await enqueueRequestTx(tx, current, c?.workerName ?? "worker");
  });
}

function staleReason(status: string, currentVersion: number, expectedVersion: number): DecisionStaleReason {
  if (currentVersion !== expectedVersion) return "version-mismatch";
  return status === "pending" ? "not-pending" : "already-decided";
}

/**
 * The only decision write boundary used by both in-app and email channels.
 * Case and approval locks serialize against evidence-triggered reopens.
 */
export async function decideApproval(opts: {
  organizationId: string;
  approvalId: number;
  decision: ApprovalDecision;
  /** Required compare-and-set token for every in-app or email decision. */
  expectedVersion: number;
  decidedBy: string;
  comment?: string | null;
  sourceMessageId?: string | null;
  sourceAddress?: string | null;
}): Promise<DecisionResult> {
  const expectedVersion = approvalVersion(opts.expectedVersion);
  let decided: {
    approval: ApprovalLike;
    caseWorkerName: string;
    decidedAt: Date;
  } | null = null;
  const result = await db.transaction(async (tx) => {
    const [ownership] = await tx.select({ caseId: onbApprovals.caseId }).from(onbApprovals).where(and(
      eq(onbApprovals.organizationId, opts.organizationId),
      eq(onbApprovals.id, opts.approvalId),
    ));
    // Case ownership is derived from the approval, never from request input.
    if (!ownership) {
      return { outcome: "not-found" } as const;
    }
    const [currentCase] = await tx.select().from(onbCases).where(and(
      eq(onbCases.organizationId, opts.organizationId),
      eq(onbCases.id, ownership.caseId),
    )).for("update");
    if (!currentCase) {
      return { outcome: "not-found" } as const;
    }
    const [approval] = await tx.select().from(onbApprovals).where(and(
        eq(onbApprovals.organizationId, opts.organizationId),
        eq(onbApprovals.id, opts.approvalId),
    )).for("update");
    if (!approval) return { outcome: "not-found" } as const;
    const currentVersion = approvalVersion(approval.version);
    if (currentVersion !== expectedVersion || approval.status !== "pending") {
      const reason = staleReason(approval.status, currentVersion, expectedVersion);
      const recipient = normalizedConfiguredAddress(opts.sourceAddress);
      if (recipient) {
        const content = decisionContent({
          approval,
          decidedBy: opts.decidedBy,
          decision: opts.decision,
          decidedAt: new Date(),
          stale: true,
        });
        await enqueueNotificationTx(tx, {
          organizationId: approval.organizationId,
          approvalId: approval.id,
          caseId: approval.caseId,
          version: currentVersion,
          kind: "stale",
          recipient,
          subject: content.subject,
          body: content.body,
          sourceMessageId: opts.sourceMessageId,
          idempotencyKey: `approval-notification:${approval.id}:v${currentVersion}:stale:${opts.sourceMessageId ?? `request-${expectedVersion}`}`,
        });
      }
      return { outcome: "stale", reason, currentVersion, status: approval.status } as const;
    }
    const decidedAt = new Date();
    const [updated] = await tx.update(onbApprovals).set({
      status: opts.decision,
      decidedBy: opts.decidedBy,
      comment: opts.comment ?? null,
      decidedAt,
      version: currentVersion,
    }).where(and(
      eq(onbApprovals.organizationId, opts.organizationId),
      eq(onbApprovals.id, opts.approvalId),
      eq(onbApprovals.status, "pending"),
      eq(onbApprovals.version, currentVersion),
    )).returning();
    if (!updated) {
      const content = decisionContent({
        approval,
        decidedBy: opts.decidedBy,
        decision: opts.decision,
        decidedAt,
        stale: true,
      });
      const recipient = normalizedConfiguredAddress(opts.sourceAddress);
      if (recipient) {
        await enqueueNotificationTx(tx, {
          organizationId: approval.organizationId,
          approvalId: approval.id,
          caseId: approval.caseId,
          version: currentVersion,
          kind: "stale",
          recipient,
          subject: content.subject,
          body: content.body,
          sourceMessageId: opts.sourceMessageId,
          idempotencyKey: `approval-notification:${approval.id}:v${currentVersion}:stale:${opts.sourceMessageId ?? "race"}`,
        });
      }
      return {
        outcome: "stale",
        reason: "not-pending",
        currentVersion,
        status: approval.status,
      } as const;
    }
    await tx.update(onbApprovalNotifications).set({
      status: "blocked",
      failureReason: "Approval request cycle was decided; request snapshot closed without dispatch.",
    }).where(and(
      eq(onbApprovalNotifications.organizationId, approval.organizationId),
      eq(onbApprovalNotifications.approvalId, approval.id),
      eq(onbApprovalNotifications.version, currentVersion),
      or(
        eq(onbApprovalNotifications.kind, "request"),
        eq(onbApprovalNotifications.kind, "outstanding"),
      ),
      or(
        eq(onbApprovalNotifications.status, "queued"),
        eq(onbApprovalNotifications.status, "failed"),
      ),
    ));
    await appendApprovalDecisionHistory(
      tx,
      approval,
      opts.decision,
      opts.decidedBy,
      opts.comment ?? null,
      decidedAt,
    );
    const [c] = await tx.select({ workerName: onbCases.workerName }).from(onbCases).where(and(
      eq(onbCases.organizationId, approval.organizationId),
      eq(onbCases.id, approval.caseId),
    ));
    const content = decisionContent({
      approval: updated,
      decidedBy: opts.decidedBy,
      decision: opts.decision,
      decidedAt,
    });
    const recipients = await configuredRecipients(tx, approval.organizationId);
    const receiptRecipient = normalizedConfiguredAddress(opts.sourceAddress) ?? recipients.approver;
    if (receiptRecipient) {
      await enqueueNotificationTx(tx, {
        organizationId: approval.organizationId,
        approvalId: approval.id,
        caseId: approval.caseId,
        version: currentVersion,
        kind: "decision",
        recipient: receiptRecipient,
        subject: content.subject,
        body: content.body,
        sourceMessageId: opts.sourceMessageId,
        idempotencyKey: `approval-notification:${approval.id}:v${currentVersion}:decision:${opts.sourceMessageId ?? "recorded"}`,
      });
    }
    if (recipients.hrAlert && recipients.hrAlert.toLowerCase() !== receiptRecipient?.toLowerCase()) {
      await enqueueNotificationTx(tx, {
        organizationId: approval.organizationId,
        approvalId: approval.id,
        caseId: approval.caseId,
        version: currentVersion,
        kind: "hr-alert",
        recipient: recipients.hrAlert,
        subject: content.subject,
        body: content.body,
        idempotencyKey: `approval-notification:${approval.id}:v${currentVersion}:hr-alert`,
      });
    }
    const pending = await tx.select().from(onbApprovals).where(and(
      eq(onbApprovals.organizationId, approval.organizationId),
      eq(onbApprovals.caseId, approval.caseId),
      eq(onbApprovals.status, "pending"),
    ));
    for (const outstanding of pending) {
      await enqueueRequestTx(tx, outstanding, c?.workerName ?? "worker", "outstanding");
    }
    decided = { approval: updated, caseWorkerName: c?.workerName ?? "worker", decidedAt };
    return {
      outcome: "decided",
      approval: updated,
      released: false,
    } as const;
  });

  const continuation = decided as {
    approval: ApprovalLike;
    caseWorkerName: string;
    decidedAt: Date;
  } | null;
  if (result.outcome === "decided" && continuation) {
    // The database transaction above is committed before any continuation can
    // change case state or invoke gateway-specific reconciliation.
    const { resumeAfterDecision } = await import("./engine");
    resumeAfterDecision({
      caseId: continuation.approval.caseId,
      approved: opts.decision === "approved",
      decidedBy: opts.decidedBy,
      comment: opts.comment ?? null,
      recommendation: continuation.approval.recommendation,
      ruleRef: continuation.approval.ruleRef,
      hitlPattern: continuation.approval.hitlPattern,
      resumeAction: continuation.approval.resumeAction ?? "none",
    });
  }
  return result;
}

/** Tenant-scoped immutable audit history for the approval detail view. */
export async function getApprovalHistory(opts: {
  organizationId: string;
  approvalId: number;
}): Promise<Array<typeof onbApprovalHistory.$inferSelect>> {
  return db.select().from(onbApprovalHistory).where(and(
    eq(onbApprovalHistory.organizationId, opts.organizationId),
    eq(onbApprovalHistory.approvalId, opts.approvalId),
  )).orderBy(desc(onbApprovalHistory.createdAt), desc(onbApprovalHistory.id));
}

export type ApprovalNotificationTickResult = {
  processed: number;
  skipped: boolean;
};

/**
 * Claim and dispatch notification rows.  Sending is disabled in tests and an
 * ambiguous provider outcome is never automatically retried.
 */
export async function runApprovalNotificationsTick(): Promise<ApprovalNotificationTickResult> {
  if (process.env.NODE_ENV === "test" || process.env.ONBOARDING_DISABLE_NOTIFICATIONS === "1") {
    return { processed: 0, skipped: true };
  }
  // Reconcile direct SLA/Gate C inserts and reopened cycles before claiming.
  const pending = await db.select().from(onbApprovals).where(eq(onbApprovals.status, "pending"));
  for (const approval of pending) await enqueueApprovalRequestNotification(approval);

  const now = new Date();
  // A process crash after claiming but before learning the provider outcome
  // leaves a sending row. That outcome is ambiguous: fence it for manual
  // reconciliation rather than replaying the email.
  const expired = await recoverExpiredApprovalNotifications(now);

  const rows = await db.select().from(onbApprovalNotifications).where(and(
    or(
      eq(onbApprovalNotifications.status, "queued"),
      and(
        eq(onbApprovalNotifications.status, "failed"),
        lt(onbApprovalNotifications.attempts, MAX_DEFINITE_FAILURE_ATTEMPTS),
      ),
    ),
    lte(onbApprovalNotifications.nextAttemptAt, now),
  )).orderBy(asc(onbApprovalNotifications.id)).limit(50);
  let processed = expired;
  for (const row of rows) {
    const claimed = await claimApprovalNotification(row.id, now);
    if (!claimed) continue;
    let result: { status: string; failureReason: string | null };
    try {
      result = await sendAdministrativeEmail({
        caseId: claimed.caseId,
        toAddress: claimed.recipient,
        subject: claimed.subject,
        body: claimed.body,
        // The outbox key is stable; a new attempt gets a distinct timeline/effect
        // key only after a definite provider failure. Ambiguous sends never
        // reach this branch again.
        idempotencyKey: `${claimed.idempotencyKey}:attempt:${claimed.attempts}`,
      });
    } catch (error) {
      // A provider/client exception does not prove that no message was sent.
      // Keep the row fenced as ambiguous instead of treating it as retryable.
      result = {
        status: "unknown_effect_manual_repair",
        failureReason: `Notification provider outcome is unknown: ${String(error)}`,
      };
    }
    const status =
      result.status === "sent"
        ? "sent"
        : result.status === "sending"
          ? "unknown_effect_manual_repair"
          : result.status === "failed"
            ? "failed"
            : "blocked";
    const retryAt = status === "failed"
      ? new Date(now.getTime() + Math.min(3_600_000, 30_000 * 2 ** Math.max(0, claimed.attempts - 1)))
      : new Date();
    const retryExhausted = status === "failed" && claimed.attempts >= MAX_DEFINITE_FAILURE_ATTEMPTS;
    await db.update(onbApprovalNotifications).set({
      status: retryExhausted ? "failed" : status,
      failureReason: retryExhausted
        ? `${result.failureReason ?? "Definite notification provider failure"} Retry limit reached; manual retry required.`
        : result.failureReason,
      providerMessageId: null,
      nextAttemptAt: retryAt,
      sentAt: status === "sent" ? new Date() : null,
    }).where(and(
      eq(onbApprovalNotifications.id, claimed.id),
      eq(onbApprovalNotifications.status, "sending"),
    ));
    processed += 1;
  }
  return { processed, skipped: false };
}

/**
 * Claim and validate one row in the same transaction. Request notifications
 * are snapshots of a pending approval cycle; a decision or reopen can make a
 * queued/failed row obsolete before dispatch. Lock the case first (the same
 * order used by decision/reopen writers), then close obsolete rows instead of
 * sending them.
 */
export async function recoverExpiredApprovalNotifications(now = new Date()): Promise<number> {
  const expired = await db.update(onbApprovalNotifications).set({
    status: "unknown_effect_manual_repair",
    failureReason: "Notification dispatch lease expired before its provider outcome was recorded; manual reconciliation required. Automatic resend is disabled.",
    nextAttemptAt: now,
  }).where(and(
    eq(onbApprovalNotifications.status, "sending"),
    lte(onbApprovalNotifications.nextAttemptAt, now),
  )).returning({ id: onbApprovalNotifications.id });
  return expired.length;
}

/** Internal durable claim boundary exported for transaction-level tests. */
export async function claimApprovalNotification(
  notificationId: number,
  now: Date,
): Promise<typeof onbApprovalNotifications.$inferSelect | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(onbApprovalNotifications).where(
      eq(onbApprovalNotifications.id, notificationId),
    ).for("update");
    if (!row || !["queued", "failed"].includes(row.status)) return null;
    if (row.status === "failed" && row.attempts >= MAX_DEFINITE_FAILURE_ATTEMPTS) return null;
    if (row.nextAttemptAt > now) return null;

    if (row.kind === "request" || row.kind === "outstanding") {
      const [c] = await tx.select().from(onbCases).where(and(
        eq(onbCases.organizationId, row.organizationId),
        eq(onbCases.id, row.caseId),
      )).for("update");
      const [approval] = c
        ? await tx.select().from(onbApprovals).where(and(
            eq(onbApprovals.organizationId, row.organizationId),
            eq(onbApprovals.id, row.approvalId),
          )).for("update")
        : [];
      if (approval && (
        approval.agent === READINESS_SLA_AGENT ||
        approval.ruleRef?.startsWith(READINESS_SLA_RULE_PREFIX)
      )) {
        await tx.update(onbApprovalNotifications).set({
          status: "blocked",
          failureReason: "Policy-owned readiness SLA approval notification is suppressed; SLA outbox is the sole warning/breach email source.",
          nextAttemptAt: now,
        }).where(and(
          eq(onbApprovalNotifications.id, row.id),
          or(
            eq(onbApprovalNotifications.status, "queued"),
            eq(onbApprovalNotifications.status, "failed"),
          ),
        ));
        return null;
      }
      if (!approval || approval.caseId !== row.caseId ||
          approval.version !== row.version || approval.status !== "pending") {
        await tx.update(onbApprovalNotifications).set({
          status: "blocked",
          failureReason: "Approval request snapshot is stale or already decided; notification closed without dispatch.",
          nextAttemptAt: now,
        }).where(and(
          eq(onbApprovalNotifications.id, row.id),
          or(
            eq(onbApprovalNotifications.status, "queued"),
            eq(onbApprovalNotifications.status, "failed"),
          ),
        ));
        return null;
      }
    }

    const leaseUntil = new Date(now.getTime() + NOTIFICATION_LEASE_MS);
    const [claimed] = await tx.update(onbApprovalNotifications).set({
      status: "sending",
      attempts: sql`${onbApprovalNotifications.attempts} + 1`,
      failureReason: null,
      nextAttemptAt: leaseUntil,
    }).where(and(
      eq(onbApprovalNotifications.id, row.id),
      or(
        eq(onbApprovalNotifications.status, "queued"),
        eq(onbApprovalNotifications.status, "failed"),
      ),
    )).returning();
    return claimed ?? null;
  });
}