import { and, asc, desc, eq, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbApprovalHistory,
  onbApprovalNotifications,
  onbApprovals,
  onbAuthorityAssignments,
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
  approvalVersion,
  type ApprovalDecision,
} from "./approval-version";
import {
  ACTION_IDENTITY_SETTING_KEY,
  approvalStakeholderFromActionIdentity,
  type NamedStakeholder,
  type RequesterKind,
} from "./email-identity";
import {
  composeApprovalDecisionEmail,
  composeApprovalRequestEmail,
} from "./approval-email-templates";
import type { OnboardingDbTransaction } from "./settings";
import { appendProtectedAuditInTransaction } from "./protected-audit";
import { roleMayExerciseScope, verifyDecisionAuthorityInTransaction } from "./decision-authority";
import {
  isVerifiedGmailDkimTransport,
  type VerifiedGmailDkimTransport,
} from "./verified-email-transport";

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
  | { outcome: "unauthorized"; reason: string }
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
  | "authorityScope"
  | "comment"
  | "decidedAt"
>;
type ApprovalRequestLike = Pick<
  typeof onbApprovals.$inferSelect,
  "id" | "caseId" | "organizationId" | "version"
>;
type ApprovalRequestCopyInput = Pick<
  ApprovalLike,
  "id" | "version" | "caseId" | "agent" | "hitlPattern" | "recommendation" | "rationale"
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
): Promise<{
  approver: string | null;
  hrAlert: string | null;
  stakeholder: NamedStakeholder;
}> {
  const rows = await tx.select({
    key: onbSettings.key,
    value: onbSettings.value,
  }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId),
    sql`${onbSettings.key} in (${HR_APPROVER_EMAIL_KEY}, ${HR_ALERT_EMAIL_KEY}, ${ACTION_IDENTITY_SETTING_KEY})`,
  ));
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    approver: normalizedConfiguredAddress(values.get(HR_APPROVER_EMAIL_KEY)),
    hrAlert: normalizedConfiguredAddress(values.get(HR_ALERT_EMAIL_KEY)),
    stakeholder: approvalStakeholderFromActionIdentity(values.get(ACTION_IDENTITY_SETTING_KEY)),
  };
}

export function composeApprovalRequestNotificationCopy(
  input: {
    approval: ApprovalRequestCopyInput;
    workerName: string;
    stakeholderName: string;
    stakeholderRole: string;
    deliveryAddress: string | null;
    emailResponderAuthorized?: boolean;
  },
): { subject: string; body: string } {
  return composeApprovalRequestEmail({
    approvalId: input.approval.id,
    version: input.approval.version,
    workerName: input.workerName,
    caseId: input.approval.caseId,
    agent: input.approval.agent,
    hitlPattern: input.approval.hitlPattern,
    recommendation: input.approval.recommendation,
    rationale: input.approval.rationale,
    stakeholder: {
      name: input.stakeholderName,
      role: input.stakeholderRole,
    },
    deliveryAddress: input.deliveryAddress,
    deliveryMode: "real",
    deliveryState: "queued",
    emailResponderAuthorized: input.emailResponderAuthorized,
  });
}

async function hasEnabledEmailResponder(
  tx: OnboardingDbTransaction,
  approval: ApprovalLike,
  address: string,
): Promise<boolean> {
  if (!approval.authorityScope) return false;
  const [c] = await tx.select({
    geography: onbCases.geography,
    legalEntity: onbCases.legalEntity,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, approval.organizationId),
    eq(onbCases.id, approval.caseId),
  ));
  if (!c) return false;
  const now = new Date();
  const rows = await tx.select().from(onbAuthorityAssignments).where(and(
    eq(onbAuthorityAssignments.organizationId, approval.organizationId),
    sql`lower(${onbAuthorityAssignments.personEmail}) = lower(${address})`,
    eq(onbAuthorityAssignments.emailResponderAuthorized, true),
    eq(onbAuthorityAssignments.status, "active"),
    lte(onbAuthorityAssignments.validFrom, now),
    or(sql`${onbAuthorityAssignments.validUntil} is null`, sql`${onbAuthorityAssignments.validUntil} > ${now}`),
  ));
  return rows.filter((row) =>
    row.scopes.includes(approval.authorityScope!) &&
    roleMayExerciseScope(row.authorityRole, approval.authorityScope!) &&
    (row.caseId === null || row.caseId === approval.caseId) &&
    (!row.siteScope || row.siteScope === c.geography) &&
    (!row.jurisdictionScope || row.jurisdictionScope === c.legalEntity),
  ).length === 1;
}
function decisionContent(opts: {
  approval: ApprovalLike;
  workerName: string;
  decidedBy: string;
  decision: ApprovalDecision;
  decidedAt: Date;
  stakeholder: NamedStakeholder;
  deliveryAddress: string | null;
  decidedByKind: RequesterKind;
  stale?: boolean;
}): { subject: string; body: string } {
  return composeApprovalDecisionEmail({
    approvalId: opts.approval.id,
    version: opts.approval.version,
    workerName: opts.workerName,
    caseId: opts.approval.caseId,
    decidedBy: opts.decidedBy,
    decision: opts.decision,
    decidedAt: opts.decidedAt,
    decidedByKind: opts.decidedByKind,
    stakeholder: opts.stakeholder,
    deliveryAddress: opts.deliveryAddress,
    deliveryMode: "real",
    deliveryState: "queued",
    stale: opts.stale,
  });
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

const emailReplyReceiptKey = (sourceMessageId: string) =>
  `approval-email-receipt:${sourceMessageId}`;
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
  const content = composeApprovalRequestNotificationCopy({
    approval,
    workerName,
    stakeholderName: recipients.stakeholder.name,
    stakeholderRole: recipients.stakeholder.role,
    deliveryAddress: recipients.approver,
    emailResponderAuthorized: await hasEnabledEmailResponder(tx, approval, recipients.approver),
  });
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
  decidedByKind?: RequesterKind;
  /** Authenticated Clerk principal for in-app decisions; never client supplied. */
  actorUserId?: string | null;
  /** Exact allowlisted remote address, resolved only by the inbound adapter. */
  responderEmail?: string | null;
  /**
   * Opaque runtime-branded proof from raw Gmail RFC822 DKIM verification.
   * This is required for a remote email decision and cannot be a caller flag.
   */
  transport?: VerifiedGmailDkimTransport | null;
  auditCorrelationId?: string | null;
}): Promise<DecisionResult> {
  const expectedVersion = approvalVersion(opts.expectedVersion);
  let decided: {
    approval: ApprovalLike;
    caseWorkerName: string;
    decidedAt: Date;
    decisionActor: string;
  } | null = null;
  const result = await db.transaction(async (tx) => {
    // Must precede approval/case locks: revocation, withdrawal, authority
    // grants, and connector dispatch all take this tenant fence first.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${opts.organizationId}))`);
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
    // A direct invocation cannot turn an arbitrary From string into a remote
    // authority. Only the raw-Gmail verifier can manufacture this proof.
    if (opts.responderEmail && !isRemoteEmailReply(opts)) {
      return {
        outcome: "unauthorized",
        reason: "A remote email decision requires verified raw Gmail DKIM transport evidence. Sign in to Action Center → Approvals.",
      } as const;
    }
    const remoteReply = isRemoteEmailReply(opts)
      ? {
          sourceMessageId: opts.sourceMessageId,
          sourceAddress: opts.sourceAddress,
        }
      : null;
    if (remoteReply) {
      const originalOutcome = await emailReplyReceiptOutcomeTx(
        tx,
        approval,
        remoteReply.sourceMessageId,
      );
      if (originalOutcome) {
        // Keep the established public result shape. `decided` is intentionally
        // returned without setting `decided` continuation state, so a replay
        // never invokes gateway reconciliation a second time.
        if (originalOutcome === "decided") {
          return { outcome: "decided", approval, released: false } as const;
        }
        return {
          outcome: "stale",
          reason: "already-decided",
          currentVersion: approvalVersion(approval.version),
          status: approval.status,
        } as const;
      }
    }
    const currentVersion = approvalVersion(approval.version);
    if (currentVersion !== expectedVersion || approval.status !== "pending") {
      const reason = staleReason(approval.status, currentVersion, expectedVersion);
      const recipient = normalizedConfiguredAddress(opts.sourceAddress);
      if (remoteReply && recipient) {
        await enqueueEmailReplyReceiptTx(tx, {
          approval,
          sourceMessageId: remoteReply.sourceMessageId,
          recipient,
        });
      } else if (recipient) {
        const content = decisionContent({
          approval,
          decidedBy: opts.decidedBy,
          decision: opts.decision,
          decidedAt: new Date(),
          workerName: currentCase.workerName,
          stakeholder: (await configuredRecipients(tx, approval.organizationId)).stakeholder,
          deliveryAddress: recipient,
           decidedByKind: opts.decidedByKind ?? (opts.sourceAddress ? "shared-mailbox" : "human"),
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
    // Check current, scoped authority inside the case/approval lock, so a
    // concurrent grant revocation cannot authorize this decision.
    const authority = await verifyDecisionAuthorityInTransaction(tx, {
      organizationId: opts.organizationId,
      approval,
      actorUserId: opts.actorUserId,
      responderEmail: opts.responderEmail,
    });
    if (!authority.allowed) {
      const recipient = normalizedConfiguredAddress(opts.sourceAddress);
      if (remoteReply && recipient) {
        await enqueueEmailReplyReceiptTx(tx, {
          approval,
          sourceMessageId: remoteReply.sourceMessageId,
          recipient,
        });
      }
      return { outcome: "unauthorized", reason: authority.reason } as const;
    }
    const decidedAt = new Date();
    // Never persist a caller-controlled display label as a decision actor.
    // Both app and email paths have been bound to this actual current
    // authority principal by the live verifier.
    const decisionActor = authority.personUserId;
    const decisionActorKind: RequesterKind = "human";
    const [updated] = await tx.update(onbApprovals).set({
      status: opts.decision,
      decidedBy: decisionActor,
      comment: opts.comment ?? null,
      decidedAt,
      version: currentVersion,
      decidedAuthorityId: authority.authorityId,
      decidedAuthorityRevision: authority.revision,
    }).where(and(
      eq(onbApprovals.organizationId, opts.organizationId),
      eq(onbApprovals.id, opts.approvalId),
      eq(onbApprovals.status, "pending"),
      eq(onbApprovals.version, currentVersion),
    )).returning();
    if (!updated) {
      const recipient = normalizedConfiguredAddress(opts.sourceAddress);
      if (remoteReply && recipient) {
        await enqueueEmailReplyReceiptTx(tx, {
          approval,
          sourceMessageId: remoteReply.sourceMessageId,
          recipient,
        });
      } else if (recipient) {
        const content = decisionContent({
          approval,
          decidedBy: opts.decidedBy,
          decision: opts.decision,
          decidedAt,
          workerName: currentCase.workerName,
          stakeholder: (await configuredRecipients(tx, approval.organizationId)).stakeholder,
          deliveryAddress: recipient,
           decidedByKind: opts.decidedByKind ?? (opts.sourceAddress ? "shared-mailbox" : "human"),
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
      updated,
      opts.decision,
      decisionActor,
      opts.comment ?? null,
      decidedAt,
    );
    // This commits together with the verified authority-bound decision and
    // immutable approval-history snapshot.
    await appendProtectedAuditInTransaction(tx, {
      organizationId: approval.organizationId,
      actorId: authority.personUserId,
      actorKind: "authenticated",
      actorAuthority: `verified-authority:${authority.authorityId}:v${authority.revision}`,
      action: "onboarding.approval.decision-recorded",
      outcome: "success",
      objectType: "approval",
      objectId: String(approval.id),
      caseReference: `case:${approval.caseId}`,
      reviewedRevision: currentVersion,
      source: opts.sourceAddress ? "approval-email" : "approval-decision",
      correlationId: opts.auditCorrelationId ?? opts.sourceMessageId ?? null,
      payload: { decision: opts.decision, approvalVersion: currentVersion },
    });
    const [c] = await tx.select({ workerName: onbCases.workerName }).from(onbCases).where(and(
      eq(onbCases.organizationId, approval.organizationId),
      eq(onbCases.id, approval.caseId),
    ));
    const recipients = await configuredRecipients(tx, approval.organizationId);
    const receiptRecipient = normalizedConfiguredAddress(opts.sourceAddress) ?? recipients.approver;
    const content = decisionContent({
      approval: updated,
      decidedBy: decisionActor,
      decision: opts.decision,
      decidedAt,
      workerName: c?.workerName ?? "worker",
      stakeholder: recipients.stakeholder,
      deliveryAddress: receiptRecipient,
      decidedByKind: decisionActorKind,
    });
    if (remoteReply && receiptRecipient) {
      await enqueueEmailReplyReceiptTx(tx, {
        approval: updated,
        sourceMessageId: remoteReply.sourceMessageId,
        recipient: receiptRecipient,
        decision: opts.decision,
      });
    } else if (receiptRecipient) {
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
    decided = {
      approval: updated,
      caseWorkerName: c?.workerName ?? "worker",
      decidedAt,
      decisionActor,
    };
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
    decisionActor: string;
  } | null;
  if (result.outcome === "decided" && continuation) {
    // The database transaction above is committed before any continuation can
    // change case state or invoke gateway-specific reconciliation.
    const { resumeAfterDecision } = await import("./engine");
    resumeAfterDecision({
      caseId: continuation.approval.caseId,
      approved: opts.decision === "approved",
      decidedBy: continuation.decisionActor,
      comment: opts.comment ?? null,
      recommendation: continuation.approval.recommendation,
      ruleRef: continuation.approval.ruleRef,
      hitlPattern: continuation.approval.hitlPattern,
      resumeAction: continuation.approval.resumeAction ?? "none",
      authorityScope: continuation.approval.authorityScope,
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

async function emailReplyReceiptOutcomeTx(
  tx: OnboardingDbTransaction,
  approval: RemoteEmailReceiptApproval,
  sourceMessageId: string,
): Promise<"decided" | "no-decision" | null> {
  // This is deliberately tenant + approval + provider-message scoped. A
  // Gmail retry must replay the original durable result, rather than being
  // evaluated against a later decision/reopen cycle.
  const [row] = await tx.select({
    kind: onbApprovalNotifications.kind,
  }).from(onbApprovalNotifications).where(and(
    eq(onbApprovalNotifications.organizationId, approval.organizationId),
    eq(onbApprovalNotifications.approvalId, approval.id),
    eq(onbApprovalNotifications.sourceMessageId, sourceMessageId),
    eq(onbApprovalNotifications.idempotencyKey, emailReplyReceiptKey(sourceMessageId)),
  ));
  if (!row) return null;
  return row.kind === "decision" ? "decided" : "no-decision";
}

async function enqueueEmailReplyReceiptTx(
  tx: OnboardingDbTransaction,
  input: {
    approval: RemoteEmailReceiptApproval;
    sourceMessageId: string;
    recipient: string;
    decision?: ApprovalDecision;
  },
): Promise<void> {
  const content = remoteEmailReceiptContent(input);
  await enqueueNotificationTx(tx, {
    organizationId: input.approval.organizationId,
    approvalId: input.approval.id,
    caseId: input.approval.caseId,
    version: approvalVersion(input.approval.version),
    // A recorded remote decision and a no-decision response are both sent by
    // the existing approval outbox. `kind` also records the original outcome.
    kind: input.decision ? "decision" : "stale",
    recipient: input.recipient,
    subject: content.subject,
    body: content.body,
    sourceMessageId: input.sourceMessageId,
    idempotencyKey: content.idempotencyKey,
  });
}

function remoteEmailReceiptContent(input: {
  approval: RemoteEmailReceiptApproval;
  sourceMessageId: string;
  decision?: ApprovalDecision;
}): { subject: string; body: string; idempotencyKey: string } {
  const reference = `AP-${input.approval.id}-V${approvalVersion(input.approval.version)}`;
  if (input.decision) {
    const label = input.decision === "approved" ? "approved" : "rejected";
    return {
      subject: `[${reference}] Email decision recorded — ${label}`,
      body: [
        `Your ${label} decision for ${reference} was recorded after current authority verification.`,
        "The decision was attributed to your verified member account, not to a mailbox persona.",
        "Sign in to the same organization and open Action Center → Approvals to review the recorded decision.",
      ].join("\n"),
      idempotencyKey: emailReplyReceiptKey(input.sourceMessageId),
    };
  }
  return {
    subject: `[${reference}] Email reply received — no decision applied`,
    body: [
      `We received your email reply about ${reference}. No decision was applied.`,
      "",
      "This email did not pass the current authority checks, so it cannot approve or reject this onboarding review.",
      "Sign in to the same organization and open Action Center → Approvals, then locate this reference to submit a decision.",
      "This receipt does not claim source completion, a gateway release, or any provider action.",
    ].join("\n"),
    idempotencyKey: emailReplyReceiptKey(input.sourceMessageId),
  };
}

type RemoteEmailReceiptApproval = Pick<
  typeof onbApprovals.$inferSelect,
  "id" | "caseId" | "organizationId" | "version"
>;

/** Persist an invalid/unrecognized remote-reply receipt in the same outbox. */
export async function enqueueEmailReplyNoDecisionReceipt(input: {
  approval: RemoteEmailReceiptApproval;
  sourceMessageId: string;
  recipient: string;
}): Promise<void> {
  await db.transaction((tx) => enqueueEmailReplyReceiptTx(tx, input));
}

function isRemoteEmailReply(opts: {
  approvalId: number;
  expectedVersion: number;
  decision: ApprovalDecision;
  sourceMessageId?: string | null;
  sourceAddress?: string | null;
  responderEmail?: string | null;
  transport?: VerifiedGmailDkimTransport | null;
}): opts is {
  approvalId: number;
  expectedVersion: number;
  decision: ApprovalDecision;
  sourceMessageId: string;
  sourceAddress: string;
  responderEmail: string;
  transport: VerifiedGmailDkimTransport;
} {
  return Boolean(
    opts.sourceMessageId &&
    opts.sourceAddress &&
    opts.responderEmail &&
    opts.sourceAddress.trim().toLowerCase() === opts.responderEmail.trim().toLowerCase() &&
    isVerifiedGmailDkimTransport(opts.transport, {
      fromAddress: opts.responderEmail,
      sourceMessageId: opts.sourceMessageId,
      approvalReference: `AP-${opts.approvalId}-V${approvalVersion(opts.expectedVersion)}`,
      decision: opts.decision,
    }),
  );
}
