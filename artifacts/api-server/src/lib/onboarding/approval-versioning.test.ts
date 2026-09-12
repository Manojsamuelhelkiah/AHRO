import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  onbApprovalHistory,
  onbApprovalNotifications,
  onbApprovals,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCases,
  onbEvents,
  onbSettings,
  organizationMembershipsTable,
  organizationsTable,
  onbSensitiveLifecyclePolicies,
} from "@workspace/db";
import { HR_APPROVER_EMAIL_KEY } from "./settings";
import {
  decideApproval,
  enqueueApprovalRequestNotification,
  claimApprovalNotification,
  recoverExpiredApprovalNotifications,
} from "./approval-decisions";
import { reopenApprovalInTransaction } from "./approval-version";
import { resumeAfterDecision } from "./engine";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `approval-versioning-${process.pid}-${randomUUID()}`;
const organizationId = `${suffix}-organization`;
const caseIds: number[] = [];
const approverUserId = `${suffix}-hr-specialist`;
const requesterUserId = `${suffix}-requester`;

describe("versioned approval transaction boundaries (real DB)", { skip: !hasDb }, () => {
  let previousApproverSetting: string | null | undefined;

  before(async () => {
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Approval versioning lifecycle fixture",
      slug: organizationId,
      joinCodeHash: `${organizationId}-join`,
      createdByUserId: requesterUserId,
    });
    await db.insert(organizationMembershipsTable).values({
      organizationId,
      clerkUserId: requesterUserId,
      role: "owner",
    });
    await seedApprovedSensitiveLifecyclePolicies(organizationId);
  });

  after(async () => {
    for (const caseId of caseIds) {
      await db.delete(onbCases).where(and(
        eq(onbCases.organizationId, organizationId),
        eq(onbCases.id, caseId),
      ));
    }
    if (previousApproverSetting !== undefined && previousApproverSetting === null) {
      await db.delete(onbSettings).where(and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, HR_APPROVER_EMAIL_KEY),
      ));
    } else if (previousApproverSetting !== undefined) {
      await db.update(onbSettings).set({ value: previousApproverSetting }).where(and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, HR_APPROVER_EMAIL_KEY),
      ));
    }
    await db.delete(onbAuthorityAssignments).where(eq(onbAuthorityAssignments.id, `${suffix}-authority`));
    await db.delete(onbSensitiveLifecyclePolicies).where(
      eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    );
    await db.delete(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, approverUserId),
    ));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  });

  async function ensureDecisionAuthority() {
    await db.insert(onbAuthorityGovernance).values({
      organizationId, status: "governance-approved", approvedByUserId: "test-governance",
      approvedAt: new Date(), governanceSource: "test", revision: 1,
    }).onConflictDoUpdate({
      target: onbAuthorityGovernance.organizationId,
      set: { status: "governance-approved", approvedAt: new Date(), governanceSource: "test" },
    });
    await db.insert(organizationMembershipsTable).values({
      organizationId, clerkUserId: approverUserId, role: "member",
    }).onConflictDoNothing();
    await db.insert(onbAuthorityAssignments).values({
      id: `${suffix}-authority`, organizationId, personUserId: approverUserId,
      authorityRole: "hr-compliance", scopes: ["hr-compliance-approve"],
      validFrom: new Date(Date.now() - 60_000), status: "active", revision: 1,
      grantorUserId: "test-governance", source: "test", governanceDecisionRef: "test",
    }).onConflictDoNothing();
  }

  async function createFixture() {
    await ensureDecisionAuthority();
    const [created] = await db.insert(onbCases).values({
      organizationId,
      workerName: "Versioned approval test",
      workerEmail: `${suffix}-${caseIds.length}@example.com`,
      hireType: "internal-transfer",
      workerCategory: "employee",
      role: "Engineer",
      department: "Engineering",
      geography: "US",
      workforceContext: { workCountry: "US" },
      legalEntity: "Test Co",
      managerName: "Manager",
      recruiterName: "Recruiter",
      // Approval authority and the durable requestor must be distinct. Do not
      // let a legacy/null creator accidentally make the approval valid.
      createdByUserId: requesterUserId,
      joiningDate: "2030-01-01",
      lifecycleStage: "preboarding",
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: "waiting:test-approval",
    }).returning();
    caseIds.push(created.id);
    const [approval] = await db.insert(onbApprovals).values({
      organizationId,
      caseId: created.id,
      agent: "approval-version-test",
      ruleRef: "versioned-approval-test",
      hitlPattern: "approve-before-act",
      recommendation: "Proceed",
      rationale: "Versioned transaction fixture",
      resumeAction: "none",
      idempotencyKey: `${suffix}:${created.id}`,
      status: "pending",
      authorityScope: "hr-compliance-approve",
      requestedByUserId: requesterUserId,
    }).returning();
    return { caseId: created.id, approval };
  }

  async function settleContinuation() {
    // decideApproval deliberately resumes after commit without holding the
    // request open. Let its audit event finish before assertions/cleanup.
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  test("same-version concurrent decisions have one winner and one stale loser", async () => {
    const { caseId, approval } = await createFixture();
    const decisions = [
      {
        decision: "approved" as const,
        comment: "first",
      },
      {
        decision: "rejected" as const,
        comment: "losing race",
      },
    ];
    const results = await Promise.all(decisions.map(({ decision, comment }) =>
      decideApproval({
        organizationId,
        approvalId: approval.id,
        expectedVersion: 1,
        decision,
        decidedBy: approverUserId,
        actorUserId: approverUserId,
        comment,
      }),
    ));
    await settleContinuation();

    assert.equal(results.filter((result) => result.outcome === "decided").length, 1);
    assert.equal(results.filter((result) => result.outcome === "stale").length, 1);
    const winningIndex = results.findIndex((result) => result.outcome === "decided");
    assert.notEqual(winningIndex, -1);
    const winningDecision = decisions[winningIndex]!.decision;
    const winningResult = results[winningIndex]!;
    assert.equal(winningResult.outcome, "decided");
    if (winningResult.outcome === "decided") {
      assert.equal(winningResult.approval.status, winningDecision);
    }
    const [current] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval.id));
    assert.equal(current.status, winningDecision);
    assert.equal(current.version, 1);
    const history = await db.select().from(onbApprovalHistory).where(and(
      eq(onbApprovalHistory.organizationId, organizationId),
      eq(onbApprovalHistory.approvalId, approval.id),
    ));
    assert.deepEqual(
      history.map((row) => [row.version, row.eventType, row.status]),
      [[1, "decision", winningDecision]],
    );
    assert.equal(caseId, current.caseId);
  });

  test("a legacy/stale version cannot decide a reopened cycle", async () => {
    const { approval } = await createFixture();
    const decided = await decideApproval({
      organizationId,
      approvalId: approval.id,
      expectedVersion: 1,
      decision: "approved",
      decidedBy: approverUserId,
      actorUserId: approverUserId,
      comment: null,
    });
    assert.equal(decided.outcome, "decided");
    await settleContinuation();

    const reopened = await db.transaction((tx) => reopenApprovalInTransaction(tx, {
      organizationId,
      caseId: approval.caseId,
      approvalId: approval.id,
      reason: "Evidence changed",
      actor: "approval-version-test",
    }));
    assert.deepEqual(reopened, { reopened: true, previousVersion: 1, version: 2 });

    const stale = await decideApproval({
      organizationId,
      approvalId: approval.id,
      expectedVersion: 1,
      decision: "rejected",
      decidedBy: "old-email",
      comment: "old reply",
      sourceMessageId: `${suffix}:old-reply`,
    });
    assert.equal(stale.outcome, "stale");
    if (stale.outcome === "stale") assert.equal(stale.currentVersion, 2);
    const history = await db.select().from(onbApprovalHistory).where(and(
      eq(onbApprovalHistory.organizationId, organizationId),
      eq(onbApprovalHistory.approvalId, approval.id),
    ));
    assert.deepEqual(
      history.map((row) => [row.version, row.eventType, row.status]),
      [[1, "decision", "approved"], [1, "reopened", "approved"]],
    );
  });

  test("a later SLA breach can reopen a rejected decision as a new version", async () => {
    const { approval } = await createFixture();
    const decided = await decideApproval({
      organizationId,
      approvalId: approval.id,
      expectedVersion: 1,
      decision: "rejected",
      decidedBy: approverUserId,
      actorUserId: approverUserId,
      comment: "warning acknowledged",
    });
    assert.equal(decided.outcome, "decided");
    await settleContinuation();
    const reopened = await db.transaction((tx) => reopenApprovalInTransaction(tx, {
      organizationId,
      caseId: approval.caseId,
      approvalId: approval.id,
      reason: "SLA breach requires a fresh decision",
      actor: "readiness-sla-worker",
      reopenStatuses: ["approved", "rejected"],
    }));
    assert.deepEqual(reopened, { reopened: true, previousVersion: 1, version: 2 });
    const [current] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval.id));
    assert.equal(current.status, "pending");
    assert.equal(current.version, 2);
    const history = await db.select().from(onbApprovalHistory).where(and(
      eq(onbApprovalHistory.organizationId, organizationId),
      eq(onbApprovalHistory.approvalId, approval.id),
    ));
    assert.deepEqual(history.map((row) => [row.version, row.eventType, row.status]), [
      [1, "decision", "rejected"],
      [1, "reopened", "rejected"],
    ]);
  });

  test("warning acknowledgement then breach creates a fresh version on the same action", async () => {
    const { approval } = await createFixture();
    const decided = await decideApproval({
      organizationId,
      approvalId: approval.id,
      expectedVersion: 1,
      decision: "approved",
      decidedBy: approverUserId,
      actorUserId: approverUserId,
      comment: "warning acknowledged",
    });
    assert.equal(decided.outcome, "decided");
    await settleContinuation();
    const reopened = await db.transaction((tx) => reopenApprovalInTransaction(tx, {
      organizationId,
      caseId: approval.caseId,
      approvalId: approval.id,
      reason: "SLA deadline breached after warning acknowledgement",
      actor: "readiness-sla-worker",
      reopenStatuses: ["approved", "rejected"],
    }));
    assert.equal(reopened.version, 2);
    const [current] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval.id));
    assert.equal(current.status, "pending");
    assert.equal(current.version, 2);
  });

  test("request outbox retries preserve one deterministic row without sending", async () => {
    if (previousApproverSetting === undefined) {
      const [setting] = await db.select().from(onbSettings).where(and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, HR_APPROVER_EMAIL_KEY),
      ));
      previousApproverSetting = setting?.value ?? null;
    }
    await db.insert(onbSettings).values({
      organizationId,
      key: HR_APPROVER_EMAIL_KEY,
      value: "approval-test-approver@example.com",
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: "approval-test-approver@example.com" },
    });

    const { approval } = await createFixture();
    await enqueueApprovalRequestNotification(approval);
    await enqueueApprovalRequestNotification(approval);
    const key = `approval-notification:${approval.id}:v1:request`;
    const [queued] = await db.select().from(onbApprovalNotifications).where(and(
      eq(onbApprovalNotifications.organizationId, organizationId),
      eq(onbApprovalNotifications.idempotencyKey, key),
    ));
    assert.ok(queued);
    await db.update(onbApprovalNotifications).set({
      status: "failed",
      attempts: 1,
      failureReason: "simulated definite provider failure",
    }).where(eq(onbApprovalNotifications.id, queued.id));
    await enqueueApprovalRequestNotification(approval);
    const rows = await db.select().from(onbApprovalNotifications).where(and(
      eq(onbApprovalNotifications.organizationId, organizationId),
      eq(onbApprovalNotifications.idempotencyKey, key),
    ));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].attempts, 1);
  });

  test("policy-owned SLA approval requests skip the generic HR request outbox", async () => {
    const { approval } = await createFixture();
    await db.update(onbApprovals).set({
      agent: "readiness-sla-worker",
      ruleRef: "Weighted readiness SLA — payroll",
    }).where(eq(onbApprovals.id, approval.id));

    await enqueueApprovalRequestNotification(approval);

    const rows = await db.select().from(onbApprovalNotifications).where(and(
      eq(onbApprovalNotifications.organizationId, organizationId),
      eq(onbApprovalNotifications.approvalId, approval.id),
    ));
    assert.equal(rows.length, 0);
  });

  test("standalone SLA acknowledgement cannot release a hard-block", async () => {
    const { caseId } = await createFixture();
    resumeAfterDecision({
      caseId,
      approved: true,
      decidedBy: "hr",
      comment: "Acknowledged",
      recommendation: "Review source completion",
      ruleRef: "Weighted readiness SLA — payroll",
      hitlPattern: "hard-block",
      resumeAction: "none",
    });
    await settleContinuation();

    const [current] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
    assert.equal(current.lifecycleStage, "preboarding");
    const [event] = await db.select().from(onbEvents).where(and(
      eq(onbEvents.organizationId, organizationId),
      eq(onbEvents.caseId, caseId),
      eq(onbEvents.title, "Review acknowledged — source completion/mandatory gates still required"),
    ));
    assert.ok(event);
    assert.match(event.detail, /source completion\/mandatory gates still required/);
    assert.doesNotMatch(event.detail, /authorised onboarding to proceed/);
  });

  test("expired claims are fenced and stale request snapshots close before dispatch", async () => {
    if (previousApproverSetting === undefined) {
      const [setting] = await db.select().from(onbSettings).where(and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, HR_APPROVER_EMAIL_KEY),
      ));
      previousApproverSetting = setting?.value ?? null;
    }
    await db.insert(onbSettings).values({
      organizationId,
      key: HR_APPROVER_EMAIL_KEY,
      value: "approval-test-approver@example.com",
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: "approval-test-approver@example.com" },
    });

    const { approval } = await createFixture();
    const [expired] = await db.insert(onbApprovalNotifications).values({
      organizationId,
      approvalId: approval.id,
      caseId: approval.caseId,
      version: 1,
      kind: "request",
      recipient: "approval-test-approver@example.com",
      subject: "expired",
      body: "expired",
      status: "sending",
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 1_000),
      idempotencyKey: `${suffix}:expired:${approval.id}`,
    }).returning();
    assert.equal(await recoverExpiredApprovalNotifications(), 1);
    const [fenced] = await db.select().from(onbApprovalNotifications).where(
      eq(onbApprovalNotifications.id, expired.id),
    );
    assert.equal(fenced.status, "unknown_effect_manual_repair");
    assert.match(fenced.failureReason ?? "", /lease expired/i);

    const stale = await createFixture();
    await enqueueApprovalRequestNotification(stale.approval);
    await db.update(onbApprovals).set({
      status: "approved",
      decidedBy: "test",
      decidedAt: new Date(),
    }).where(eq(onbApprovals.id, stale.approval.id));
    const staleKey = `approval-notification:${stale.approval.id}:v1:request`;
    const [queuedStale] = await db.select().from(onbApprovalNotifications).where(and(
      eq(onbApprovalNotifications.organizationId, organizationId),
      eq(onbApprovalNotifications.idempotencyKey, staleKey),
    ));
    assert.ok(queuedStale);
    assert.equal(await claimApprovalNotification(queuedStale.id, new Date()), null);
    const [closed] = await db.select().from(onbApprovalNotifications).where(and(
      eq(onbApprovalNotifications.organizationId, organizationId),
      eq(onbApprovalNotifications.idempotencyKey, staleKey),
    ));
    assert.equal(closed.status, "blocked");
    assert.match(closed.failureReason ?? "", /stale|already decided/i);
  });
});