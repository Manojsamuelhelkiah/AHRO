import { and, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbApprovalHistory,
  onbApprovalNotifications,
  onbApprovals,
  onbEvents,
  type OnbRecordsEvidenceItem,
} from "@workspace/db/schema";
import type { OnboardingDbTransaction } from "./settings";

export type ApprovalDecision = "approved" | "rejected";
export type ApprovalHistoryEvent = "decision" | "reopened";

export type ApprovalReference = {
  approvalId: number;
  version: number;
  /** True when the text used legacy AP-<id> syntax. */
  legacy: boolean;
};

/** Legacy rows and pre-enrollment callers are interpreted as cycle one. */
export function approvalVersion(value: number | null | undefined): number {
  return Number.isInteger(value) && value! > 0 ? value! : 1;
}

export function approvalRef(approvalId: number, version = 1): string {
  if (!Number.isInteger(approvalId) || approvalId < 1) {
    throw new Error("approval id must be a positive integer");
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("approval version must be a positive integer");
  }
  return `AP-${approvalId}-V${version}`;
}

/**
 * Parse all references in a message.  A bare AP-id means V1 only.  Repeated
 * equivalent references are harmless; different ids or versions fail closed.
 */
export function parseApprovalReference(text: string): ApprovalReference | null {
  const refs: ApprovalReference[] = [];
  const versioned = /\bAP-(\d{1,9})-V(\d{1,9})\b/gi;
  const legacy = /\bAP-(\d{1,9})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = versioned.exec(text)) !== null) {
    const id = Number(match[1]);
    const version = Number(match[2]);
    if (Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(version) && version > 0) {
      refs.push({ approvalId: id, version, legacy: false });
    }
  }
  // Do not let the prefix of AP-id-Vversion also become a legacy ref.
  const withoutVersioned = text.replace(versioned, " ");
  while ((match = legacy.exec(withoutVersioned)) !== null) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) refs.push({ approvalId: id, version: 1, legacy: true });
  }
  if (refs.length === 0) return null;
  const first = refs[0];
  return refs.every(
    (ref) =>
      ref.approvalId === first.approvalId &&
      ref.version === first.version,
  )
    ? {
        approvalId: first.approvalId,
        version: first.version,
        legacy: refs.some((ref) => ref.legacy),
      }
    : null;
}

type ApprovalSnapshot = {
  agent: string;
  ruleRef: string | null;
  hitlPattern: string;
  recommendation: string;
  rationale: string;
  recordsEvidence: OnbRecordsEvidenceItem[] | null;
  resumeAction: string | null;
  idempotencyKey: string | null;
  authorityScope: string | null;
  requestedByUserId: string | null;
  decidedAuthorityId: string | null;
  decidedAuthorityRevision: number | null;
  authorityReviewStatus: string;
};

function snapshotOf(approval: typeof onbApprovals.$inferSelect): ApprovalSnapshot {
  return {
    agent: approval.agent,
    ruleRef: approval.ruleRef,
    hitlPattern: approval.hitlPattern,
    recommendation: approval.recommendation,
    rationale: approval.rationale,
    recordsEvidence: approval.recordsEvidence,
    resumeAction: approval.resumeAction,
    idempotencyKey: approval.idempotencyKey,
    authorityScope: approval.authorityScope,
    requestedByUserId: approval.requestedByUserId,
    decidedAuthorityId: approval.decidedAuthorityId,
    decidedAuthorityRevision: approval.decidedAuthorityRevision,
    authorityReviewStatus: approval.authorityReviewStatus,
  };
}

export async function appendApprovalDecisionHistory(
  tx: OnboardingDbTransaction,
  approval: typeof onbApprovals.$inferSelect,
  decision: ApprovalDecision,
  decidedBy: string,
  comment: string | null,
  decidedAt: Date,
  reason = "Human approval decision recorded",
): Promise<void> {
  await tx.insert(onbApprovalHistory).values({
    organizationId: approval.organizationId,
    approvalId: approval.id,
    caseId: approval.caseId,
    version: approvalVersion(approval.version),
    eventType: "decision",
    status: decision,
    decidedBy,
    comment,
    decidedAt,
    reason,
    snapshot: snapshotOf(approval),
  }).onConflictDoNothing({
    target: [
      onbApprovalHistory.organizationId,
      onbApprovalHistory.approvalId,
      onbApprovalHistory.version,
      onbApprovalHistory.eventType,
    ],
  });
}

export type ReopenApprovalOptions = {
  organizationId: string;
  caseId: number;
  approvalId?: number;
  idempotencyKey?: string;
  reason: string;
  actor?: string;
  /** Breaches may reopen either a prior approval or rejection. */
  reopenStatuses?: readonly string[];
  /** A legacy row may have no scope at all; the renewed cycle must be
   * decidable by a real specialist rather than remaining null-scoped. */
  authorityScope?: typeof onbApprovals.$inferInsert.authorityScope;
};

export type ReopenApprovalResult = {
  reopened: boolean;
  previousVersion: number;
  version: number;
};

const GATE_C_AGENT = "day1-readiness-gate";
const GATE_C_RULE = "Gate C — Day-1 readiness confirmation";
const GATE_C_INVALIDATED_TITLE = "Gate C approval invalidated by changed live readiness evidence";

function isGateCApproval(approval: typeof onbApprovals.$inferSelect): boolean {
  return approval.idempotencyKey === `gateway-c:${approval.caseId}:human-queue`;
}

/**
 * Reset one live approval while the caller holds the case lock.  The
 * conditional status update makes retries and concurrent evidence mutations
 * harmless; the old decision is inserted into append-only history first in
 * the same transaction.
 */
export async function reopenOnboardingApproval(
  tx: OnboardingDbTransaction,
  opts: ReopenApprovalOptions,
): Promise<ReopenApprovalResult> {
  const reopenStatuses = opts.reopenStatuses ?? ["approved"];
  const predicates = [
    eq(onbApprovals.organizationId, opts.organizationId),
    eq(onbApprovals.caseId, opts.caseId),
    inArray(onbApprovals.status, reopenStatuses),
    ...(opts.approvalId === undefined ? [] : [eq(onbApprovals.id, opts.approvalId)]),
    ...(opts.idempotencyKey === undefined
      ? []
      : [eq(onbApprovals.idempotencyKey, opts.idempotencyKey)]),
  ];
  const [approval] = await tx.select().from(onbApprovals).where(and(...predicates)).for("update");
  if (!approval) return { reopened: false, previousVersion: 0, version: 0 };

  const previousVersion = approvalVersion(approval.version);
  const nextVersion = previousVersion + 1;
  const [updated] = await tx.update(onbApprovals).set({
    version: nextVersion,
    status: "pending",
    decidedAt: null,
    decidedBy: null,
    decidedAuthorityId: null,
    decidedAuthorityRevision: null,
    ...(opts.authorityScope === undefined ? {} : { authorityScope: opts.authorityScope }),
    comment: `${opts.reason}${opts.actor ? ` (${opts.actor})` : ""}`,
  }).where(and(
    eq(onbApprovals.organizationId, opts.organizationId),
    eq(onbApprovals.id, approval.id),
    inArray(onbApprovals.status, reopenStatuses),
    eq(onbApprovals.version, previousVersion),
  )).returning();
  if (!updated) return { reopened: false, previousVersion, version: previousVersion };

  // A request email is a snapshot of the old pending cycle. Close queued or
  // retryable rows before the new cycle can be dispatched; an already-sending
  // row remains fenced for ambiguous-outcome reconciliation.
  await tx.update(onbApprovalNotifications).set({
    status: "blocked",
    failureReason: "Approval cycle reopened; old request snapshot closed without dispatch.",
  }).where(and(
    eq(onbApprovalNotifications.organizationId, opts.organizationId),
    eq(onbApprovalNotifications.approvalId, approval.id),
    eq(onbApprovalNotifications.version, previousVersion),
    inArray(onbApprovalNotifications.kind, ["request", "outstanding"]),
    inArray(onbApprovalNotifications.status, ["queued", "failed"]),
  ));

  await tx.insert(onbApprovalHistory).values({
    organizationId: approval.organizationId,
    approvalId: approval.id,
    caseId: approval.caseId,
    version: previousVersion,
    eventType: "reopened",
    status: approval.status,
    decidedBy: approval.decidedBy,
    comment: approval.comment,
    decidedAt: approval.decidedAt,
    reason: opts.reason,
    snapshot: snapshotOf(approval),
  }).onConflictDoNothing({
    target: [
      onbApprovalHistory.organizationId,
      onbApprovalHistory.approvalId,
      onbApprovalHistory.version,
      onbApprovalHistory.eventType,
    ],
  });
  // Learning and outcome consumers recognize this exact, PII-free event.
  // Keeping it at the successful approval-cycle transition means every
  // proactive Gate C reopen path is represented, while retries that find an
  // already-pending row cannot emit a false invalidation.
  if (isGateCApproval(approval)) {
    await tx.insert(onbEvents).values({
      organizationId: approval.organizationId,
      caseId: approval.caseId,
      agent: GATE_C_AGENT,
      engine: "rules",
      hitlPattern: "approve-before-act",
      ruleRef: approval.ruleRef ?? GATE_C_RULE,
      title: GATE_C_INVALIDATED_TITLE,
      detail: "A fresh HR final-review decision is required; the prior approval was not reused.",
      idempotencyKey: `gateway-c:${approval.caseId}:reopened:v${nextVersion}`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
  }
  return { reopened: true, previousVersion, version: nextVersion };
}

/** @deprecated Use reopenOnboardingApproval for new transactional callers. */
export const reopenApprovalInTransaction = reopenOnboardingApproval;

/** Convenience wrapper for callers that do not already hold a case tx. */
export async function reopenApproval(opts: ReopenApprovalOptions): Promise<ReopenApprovalResult> {
  return db.transaction((tx) => reopenOnboardingApproval(tx, opts));
}