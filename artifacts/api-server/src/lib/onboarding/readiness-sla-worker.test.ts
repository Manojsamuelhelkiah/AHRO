import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  onbApprovals,
  onbGovernanceAuthorityAssignments,
  onbCases,
  onbReadinessSlaCaseState,
  onbReadinessSlaLedger,
  onbReadinessSlaOutbox,
  onbReadinessSlaSnapshots,
  onbSensitiveLifecyclePolicies,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { approvalRef } from "./approval-version";
import { defaultReadinessSlaPolicy, readinessSlaApplicability } from "./readiness-sla";
import { claimReadinessSlaOutbox } from "./readiness-sla-worker";
import { rebaseReadinessSlaCase } from "./readiness-sla-policy";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `readiness-sla-worker-${process.pid}-${randomUUID()}`;
const organizationId = `${suffix}-organization`;
const caseIds: number[] = [];

describe("readiness SLA outbox claim fencing (real DB)", { skip: !hasDb }, () => {
  before(async () => {
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Readiness SLA lifecycle fixture",
      slug: organizationId,
      joinCodeHash: `${organizationId}-join`,
      createdByUserId: `${suffix}-owner`,
    });
    await db.insert(organizationMembershipsTable).values({
      organizationId,
      clerkUserId: `${suffix}-owner`,
      role: "owner",
    });
    await db.insert(onbGovernanceAuthorityAssignments).values({
      organizationId,
      authorityRole: "privacy",
      assigneeUserId: `${suffix}-owner`,
      verificationStatus: "verified",
      verifiedByUserId: "test-verifier",
      verificationReference: "test-sensitive-lifecycle-fixture",
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
    await db.delete(onbSensitiveLifecyclePolicies).where(
      eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    );
    await db.delete(onbGovernanceAuthorityAssignments).where(
      eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    );
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  });

  async function createFixture() {
    const [c] = await db.insert(onbCases).values({
      organizationId,
      workerName: "SLA outbox claim fixture",
      workerEmail: `${suffix}-${caseIds.length}@example.com`,
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Engineer",
      department: "Engineering",
      geography: "US",
      workforceContext: { workCountry: "US" },
      legalEntity: "Test Co",
      managerName: "Manager",
      recruiterName: "Recruiter",
      joiningDate: "2030-01-01",
      lifecycleStage: "preboarding",
      orchestrationStatus: "idle",
      orchestrationCheckpoint: "test",
    }).returning();
    caseIds.push(c.id);
    const base = defaultReadinessSlaPolicy();
    const action = {
      ...base.actions.find((item) => item.key === "documentation")!,
      owner: `${suffix}@example.com`,
      notifyEmail: true,
      notifyInApp: false,
    };
    const policy = {
      ...base,
      actions: base.actions.map((item) => item.key === action.key ? action : item),
    };
    const applicability = readinessSlaApplicability({
      hireType: "new-hire",
      workerCategory: "employee",
    });
    const [snapshot] = await db.insert(onbReadinessSlaSnapshots).values({
      organizationId,
      caseId: c.id,
      snapshotVersion: 1,
      policyVersion: 1,
      joiningDate: c.joiningDate,
      policy,
      applicability,
      createdBy: "readiness-sla-worker-test",
    }).returning();
    await db.insert(onbReadinessSlaCaseState).values({
      organizationId,
      caseId: c.id,
      snapshotVersion: snapshot.snapshotVersion,
    });
    const [ledger] = await db.insert(onbReadinessSlaLedger).values({
      organizationId,
      caseId: c.id,
      snapshotVersion: 1,
      actionKey: action.key,
      state: "warned",
      dueAt: new Date("2029-12-25T00:00:00.000Z"),
      warningAt: new Date("2029-12-23T00:00:00.000Z"),
      history: [],
    }).returning();
    const [approval] = await db.insert(onbApprovals).values({
      organizationId,
      caseId: c.id,
      agent: "readiness-sla-worker",
      ruleRef: `Weighted readiness SLA — ${action.key}`,
      hitlPattern: "hard-block",
      recommendation: "Acknowledge the SLA warning",
      rationale: "Outbox claim fixture",
      status: "pending",
      resumeAction: "none",
      idempotencyKey: `readiness-sla:${c.id}:1:${action.key}:decision`,
    }).returning();
    const ref = approvalRef(approval.id, approval.version);
    const [outbox] = await db.insert(onbReadinessSlaOutbox).values({
      organizationId,
      caseId: c.id,
      ledgerId: ledger.id,
      eventKey: `${suffix}:${c.id}:${randomUUID()}`,
      channel: "email",
      recipient: action.owner,
      payload: {
        title: `Documents warning — ${ref}`,
        body: `Approval acknowledgment reference: ${ref}.`,
        owner: action.owner,
        approvalId: approval.id,
        approvalVersion: approval.version,
        approvalRef: ref,
      },
    }).returning();
    return { caseId: c.id, ledgerId: ledger.id, outboxId: outbox.id, approvalId: approval.id };
  }

  test("queued email is suppressed when fresh source resolution wins at claim", async () => {
    const fixture = await createFixture();
    const claimed = await claimReadinessSlaOutbox(
      fixture.outboxId,
      `${suffix}:resolution`,
      new Date("2029-12-26T00:00:00.000Z"),
    );
    assert.equal(claimed, null);
    const [outbox] = await db.select().from(onbReadinessSlaOutbox).where(eq(onbReadinessSlaOutbox.id, fixture.outboxId));
    const [ledger] = await db.select().from(onbReadinessSlaLedger).where(eq(onbReadinessSlaLedger.id, fixture.ledgerId));
    assert.equal(outbox.status, "failed");
    assert.match(outbox.deliveryInfo ?? "", /fresh source evidence completed/);
    assert.equal(ledger.state, "resolved");
  });

  test("queued email is terminally suppressed when explicit rebase supersedes it", async () => {
    const fixture = await createFixture();
    await rebaseReadinessSlaCase({
      organizationId,
      caseId: fixture.caseId,
      expectedSnapshotVersion: 1,
      reason: "Test policy correction",
      changedBy: "readiness-sla-worker-test",
    });
    const claimed = await claimReadinessSlaOutbox(
      fixture.outboxId,
      `${suffix}:rebase`,
      new Date("2029-12-26T00:00:00.000Z"),
    );
    assert.equal(claimed, null);
    const [outbox] = await db.select().from(onbReadinessSlaOutbox).where(eq(onbReadinessSlaOutbox.id, fixture.outboxId));
    assert.equal(outbox.status, "failed");
    assert.match(outbox.deliveryInfo ?? "", /snapshot rebased/);
  });
});