import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCases,
  onbEarlyTenureAssignments,
  onbEarlyTenureCaseSnapshots,
  onbEarlyTenureEvidence,
  onbEarlyTenureCheckins,
  onbEarlyTenurePolicyVersions,
  onbEarlyTenureReminders,
  onbConnectors,
  onbEvents,
  onbSensitiveLifecyclePolicies,
  onbSensitiveLifecycleDeletionJobs,
  organizationMembershipsTable,
  organizationsTable,
  type OnbEarlyTenurePolicy,
} from "@workspace/db";
import {
  enrollEarlyTenureCase,
  assignEarlyTenureCheckinOwner,
  assignEarlyTenureAssignmentOwner,
  getEarlyTenureReminderInbox,
  recordEarlyTenureEvidence,
  recordMyEarlyTenureEvidence,
  recordProbationDecision,
  reviseEarlyTenureAssignment,
  setActualJoiningAnchor,
  runEarlyTenureReminderTick,
  saveEarlyTenurePolicy,
} from "./early-tenure";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";
import { runSensitiveLifecycleDeletionWorker } from "./sensitive-lifecycle";

const suffix = `${process.pid}-${randomUUID()}`;
const organizationId = `early-tenure-db-${suffix}`;
const actorUserId = `early-tenure-reviewer-${suffix}`;
const creatorUserId = `early-tenure-creator-${suffix}`;
let caseId: number;

const policy: OnbEarlyTenurePolicy = {
  applicability: {},
  probationLengthDays: 120,
  decisionAuthorityScope: "hr-compliance-approve",
  obligations: [
    { key: "induction", kind: "induction", label: "Induction", offsetDays: 0, required: true, ownerRole: "HR", requireEvidence: true },
    { key: "learning-enrollment", kind: "learning-enrollment", label: "Learning enrollment", offsetDays: 0, required: true, ownerRole: "HR", requireEvidence: true },
    { key: "compliance", kind: "compliance-training", label: "Compliance", offsetDays: 1, required: true, ownerRole: "HR", requireEvidence: true },
    { key: "buddy", kind: "buddy-acknowledgement", label: "Buddy acknowledgement", offsetDays: 1, required: true, ownerRole: "HR", requireEvidence: true },
    { key: "manager", kind: "manager-connect", label: "Manager connect", offsetDays: 2, required: true, ownerRole: "manager", requireEvidence: true, structuredAgenda: ["goals"] },
    { key: "calendar", kind: "calendar-delivery", label: "Calendar delivery", offsetDays: 0, required: true, ownerRole: "HR", requireEvidence: true },
  ],
  checkIns: [
    { key: "day-30", label: "30 day", offsetDays: 30, required: true, reminderLeadDays: 3 },
    { key: "day-60", label: "60 day", offsetDays: 60, required: true, reminderLeadDays: 3 },
    { key: "day-90", label: "90 day", offsetDays: 90, required: true, reminderLeadDays: 3 },
  ],
};

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId, name: "Early tenure DB", slug: organizationId,
    joinCodeHash: `hash-${organizationId}`, createdByUserId: creatorUserId,
  });
  await db.insert(onbAuthorityGovernance).values({
    organizationId, status: "governance-approved", approvedByUserId: "test",
    approvedAt: new Date(), governanceSource: "test", revision: 1,
  });
  await db.insert(organizationMembershipsTable).values({
    organizationId, clerkUserId: actorUserId, role: "admin",
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `early-tenure-authority-${suffix}`, organizationId, personUserId: actorUserId,
    authorityRole: "hr-compliance", scopes: ["hr-compliance-approve"],
    validFrom: new Date(Date.now() - 60_000), validUntil: new Date(Date.now() + 60_000),
    status: "active", revision: 1, grantorUserId: "test", source: "test",
    governanceDecisionRef: "EARLY-TENURE-DB-TEST",
  });
  await seedApprovedSensitiveLifecyclePolicies(organizationId);
  const [created] = await db.insert(onbCases).values({
    organizationId, workerName: "Early tenure subject", workerEmail: `subject-${suffix}@example.com`,
    channelPreference: "whatsapp", hireType: "external-fte", workerCategory: "employee",
    role: "Engineer", department: "Engineering", geography: "US", legalEntity: "Test Co",
    managerName: "Manager", recruiterName: "Recruiter", joiningDate: "2024-01-01",
    workforceContext: { workCountry: "US" }, createdByUserId: creatorUserId,
  }).returning({ id: onbCases.id });
  caseId = created!.id;
  await db.insert(onbEarlyTenurePolicyVersions).values({
    organizationId, version: 1, policy: structuredClone(policy), createdByUserId: actorUserId, createdBy: "Test HR",
  });
});

after(async () => {
  await db.delete(onbCases).where(and(
    eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
  ));
  await db.delete(onbEarlyTenurePolicyVersions).where(eq(onbEarlyTenurePolicyVersions.organizationId, organizationId));
  await db.delete(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.organizationId, organizationId));
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, organizationId));
  await db.delete(onbEvents).where(eq(onbEvents.organizationId, organizationId));
  await db.delete(onbAuthorityAssignments).where(eq(onbAuthorityAssignments.organizationId, organizationId));
  await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, organizationId));
  await db.delete(onbAuthorityGovernance).where(eq(onbAuthorityGovernance.organizationId, organizationId));
  await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
});

test("database fences concurrent anchor updates and re-anchors untouched overdue planned work", async () => {
  await enrollEarlyTenureCase({ organizationId, caseId, actorUserId, enrolledBy: "Test HR" });
  const outcomes = await Promise.allSettled([
    setActualJoiningAnchor({ organizationId, caseId, actorUserId, recordedBy: "Test HR", expectedAnchorRevision: 0, actualJoinedAt: "2024-01-02T00:00:00.000Z" }),
    setActualJoiningAnchor({ organizationId, caseId, actorUserId, recordedBy: "Test HR", expectedAnchorRevision: 0, actualJoinedAt: "2024-01-03T00:00:00.000Z" }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
  const [snapshot] = await db.select().from(onbEarlyTenureCaseSnapshots).where(and(
    eq(onbEarlyTenureCaseSnapshots.organizationId, organizationId), eq(onbEarlyTenureCaseSnapshots.caseId, caseId),
  ));
  assert.equal(snapshot!.anchorRevision, 1);
  // Simulate rows created before 0073: their revision-1 predecessor link is
  // the only evidence that this null-fenced revision-2 schedule was automatic.
  await db.update(onbEarlyTenureAssignments).set({ anchorRevision: null }).where(and(
    eq(onbEarlyTenureAssignments.organizationId, organizationId),
    eq(onbEarlyTenureAssignments.caseId, caseId), eq(onbEarlyTenureAssignments.status, "pending"),
  ));
  await db.update(onbEarlyTenureCheckins).set({ anchorRevision: null }).where(and(
    eq(onbEarlyTenureCheckins.organizationId, organizationId),
    eq(onbEarlyTenureCheckins.caseId, caseId), eq(onbEarlyTenureCheckins.status, "scheduled"),
  ));
  await setActualJoiningAnchor({
    organizationId, caseId, actorUserId, recordedBy: "Test HR",
    expectedAnchorRevision: 1, actualJoinedAt: "2024-01-04T00:00:00.000Z",
  });
  const current = await db.select().from(onbEarlyTenureAssignments).where(and(
    eq(onbEarlyTenureAssignments.organizationId, organizationId),
    eq(onbEarlyTenureAssignments.caseId, caseId), eq(onbEarlyTenureAssignments.status, "pending"),
  ));
  assert.equal(current.length, policy.obligations.length);
  assert.ok(current.every((row) => row.revision === 3), "sequential corrections must re-anchor overdue untouched auto-scheduled work");
});

test("database tenant FK blocks evidence from another tenant and writer rejects future provenance dates", async () => {
  const [assignment] = await db.select().from(onbEarlyTenureAssignments).where(and(
    eq(onbEarlyTenureAssignments.organizationId, organizationId), eq(onbEarlyTenureAssignments.caseId, caseId),
    eq(onbEarlyTenureAssignments.status, "pending"),
  )).limit(1);
  assert.ok(assignment);
  await assert.rejects(db.insert(onbEarlyTenureEvidence).values({
    organizationId: `wrong-${suffix}`, caseId, assignmentId: assignment!.id, evidenceReference: "cross-tenant",
    provenance: "human-authorized", recordedByUserId: actorUserId, recordedBy: "Test HR", observedAt: new Date(),
  }), (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23503");
  await assert.rejects(recordEarlyTenureEvidence({
    organizationId, assignmentId: assignment!.id, actorUserId, recordedBy: "Test HR",
    evidenceReference: "future", provenance: "human-authorized",
    observedAt: new Date(Date.now() + 600_000).toISOString(),
  }), /observedAt cannot be in the future/);
});

test("compliance completion is blocked until separate learning enrollment has dated evidence", async () => {
  const [learning] = await db.select().from(onbEarlyTenureAssignments).where(and(
    eq(onbEarlyTenureAssignments.organizationId, organizationId),
    eq(onbEarlyTenureAssignments.kind, "learning-enrollment"),
    eq(onbEarlyTenureAssignments.status, "pending"),
  )).limit(1);
  const [compliance] = await db.select().from(onbEarlyTenureAssignments).where(and(
    eq(onbEarlyTenureAssignments.organizationId, organizationId),
    eq(onbEarlyTenureAssignments.kind, "compliance-training"),
    eq(onbEarlyTenureAssignments.status, "pending"),
  )).limit(1);
  assert.ok(learning);
  assert.ok(compliance);
  const observedAt = new Date().toISOString();
  await assert.rejects(recordEarlyTenureEvidence({
    organizationId, assignmentId: compliance!.id, actorUserId, recordedBy: "Test HR",
    evidenceReference: "compliance-without-enrollment", observedAt,
  }), /learning-enrollment obligation is completed/);
  await recordEarlyTenureEvidence({
    organizationId, assignmentId: learning!.id, actorUserId, recordedBy: "Test HR",
    evidenceReference: "learning-enrollment", observedAt,
  });
  await recordEarlyTenureEvidence({
    organizationId, assignmentId: compliance!.id, actorUserId, recordedBy: "Test HR",
    evidenceReference: "compliance-completed", observedAt,
  });
});

test("policy publish accepts a tenant custom distinct check-in cadence", async () => {
  await db.insert(onbAuthorityAssignments).values({
    id: `early-tenure-policy-authority-${suffix}`, organizationId, personUserId: actorUserId,
    authorityRole: "governance", scopes: ["authority-administration"],
    validFrom: new Date(Date.now() - 60_000), validUntil: new Date(Date.now() + 60_000),
    status: "active", revision: 1, grantorUserId: "test", source: "test",
    governanceDecisionRef: "EARLY-TENURE-POLICY-TEST",
  });
  const published = await saveEarlyTenurePolicy({
    organizationId, actorUserId, createdBy: "Test HR", expectedVersion: 1,
    policy: {
      ...structuredClone(policy),
      checkIns: [
        { key: "week-2", label: "Two weeks", offsetDays: 14, required: true, reminderLeadDays: 2 },
        { key: "day-45", label: "45 days", offsetDays: 45, required: true, reminderLeadDays: 3 },
      ],
    },
  });
  assert.deepEqual(published.policy.checkIns.map((item) => item.offsetDays), [14, 45]);
});

test("probation confirmation respects snapshot maturity, same-anchor extensions, and anchor fencing", async () => {
  const base = {
    organizationId, caseId, actorUserId, decidedBy: "Test HR", expectedSnapshotVersion: 1,
    disposition: "confirmed" as const, rationale: "Reviewed", evidenceReference: "probation-review",
  };
  await assert.rejects(recordProbationDecision({
    ...base, expectedAnchorRevision: 1, expectedDecisionVersion: 0, effectiveAt: "2024-01-05T00:00:00.000Z",
  }), /anchor changed/i);
  await assert.rejects(recordProbationDecision({
    ...base, expectedAnchorRevision: 2, expectedDecisionVersion: 0, effectiveAt: "2024-01-05T00:00:00.000Z",
  }), /before the current governed probation end/i);
  await recordProbationDecision({
    ...base, disposition: "extended", expectedAnchorRevision: 2, expectedDecisionVersion: 0,
    effectiveAt: "2024-01-05T00:00:00.000Z", extensionEndsAt: "2024-06-01T00:00:00.000Z",
  });
  await assert.rejects(recordProbationDecision({
    ...base, expectedAnchorRevision: 2, expectedDecisionVersion: 1, effectiveAt: "2024-05-03T00:00:00.000Z",
  }), /before the current governed probation end/i);
  await recordProbationDecision({
    ...base, expectedAnchorRevision: 2, expectedDecisionVersion: 1, effectiveAt: "2024-06-01T00:00:00.000Z",
  });
});

test("database write boundary rejects arbitrary external email recipients", async () => {
  const [future] = await db.insert(onbEarlyTenureAssignments).values({
    organizationId, caseId, snapshotVersion: 1, obligationKey: "manual-email-test",
    revision: 1, kind: "induction", title: "Manual recipient test", ownerName: "HR",
    dueAt: new Date(Date.now() + 86_400_000), taskDetails: {},
  }).returning({ id: onbEarlyTenureAssignments.id });
  await assert.rejects(reviseEarlyTenureAssignment({
    organizationId, assignmentId: future!.id, expectedRevision: 1, actorUserId,
    ownerName: "Unverified recipient", ownerUserId: actorUserId,
    dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    notificationRecipientEmail: "unverified@example.com",
  }), /authoritative membership-email mapping/);
});

test("assigned member inbox returns only a minimal projection before marking in-app delivery sent", async () => {
  const [assignment] = await db.insert(onbEarlyTenureAssignments).values({
    organizationId, caseId, snapshotVersion: 1, obligationKey: "inbox-test",
    revision: 1, kind: "induction", title: "Inbox task", ownerName: "HR", ownerUserId: actorUserId,
    dueAt: new Date(Date.now() + 86_400_000), taskDetails: {},
  }).returning({ id: onbEarlyTenureAssignments.id });
  const [reminder] = await db.insert(onbEarlyTenureReminders).values({
    organizationId, caseId, targetType: "assignment", targetId: assignment!.id,
    targetRevision: 1, eventKey: `inbox-${suffix}`, intendedRecipient: "HR",
    dueAt: new Date(), availableAt: new Date(),
  }).returning({ id: onbEarlyTenureReminders.id });
  const inbox = await getEarlyTenureReminderInbox(organizationId, actorUserId);
  const item = inbox.find((row) => row.id === reminder!.id);
  assert.deepEqual(Object.keys(item ?? {}).sort(), [
    "availableAt", "dueAt", "evidenceCompletionPath", "id", "obligationLabel", "targetId", "targetType", "taskReference",
  ]);
  const [stored] = await db.select().from(onbEarlyTenureReminders).where(eq(onbEarlyTenureReminders.id, reminder!.id));
  assert.equal(stored!.status, "sent");
  assert.ok((await getEarlyTenureReminderInbox(organizationId, actorUserId)).some((row) => row.id === reminder!.id));
});

test("check-in ownership is revisioned and makes the check-in visible to that member", async () => {
  const [scheduled] = await db.select().from(onbEarlyTenureCheckins).where(and(
    eq(onbEarlyTenureCheckins.organizationId, organizationId),
    eq(onbEarlyTenureCheckins.status, "scheduled"),
  )).limit(1);
  assert.ok(scheduled);
  await assignEarlyTenureCheckinOwner({
    organizationId, checkinId: scheduled!.id, expectedRevision: scheduled!.revision,
    ownerUserId: actorUserId, actorUserId,
  });
  const [assigned] = await db.select().from(onbEarlyTenureCheckins).where(and(
    eq(onbEarlyTenureCheckins.organizationId, organizationId),
    eq(onbEarlyTenureCheckins.checkinKey, scheduled!.checkinKey),
    eq(onbEarlyTenureCheckins.status, "scheduled"),
  ));
  assert.equal(assigned!.ownerUserId, actorUserId);
  const [reminder] = await db.insert(onbEarlyTenureReminders).values({
    organizationId, caseId, targetType: "checkin", targetId: assigned!.id,
    targetRevision: assigned!.revision, eventKey: `checkin-inbox-${suffix}`,
    intendedRecipient: "Assigned HR compliance owner", dueAt: assigned!.dueAt, availableAt: new Date(),
  }).returning({ id: onbEarlyTenureReminders.id });
  const inbox = await getEarlyTenureReminderInbox(organizationId, actorUserId);
  assert.ok(inbox.some((row) => row.id === reminder!.id && row.targetType === "checkin"));
});

test("an authorized owner-only handoff makes a Day-0 overdue assignment deliverable", async () => {
  const lateDueAt = new Date(Date.now() - 60_000);
  const [late] = await db.insert(onbEarlyTenureAssignments).values({
    organizationId, caseId, snapshotVersion: 1, obligationKey: "late-owner-handoff",
    revision: 1, kind: "induction", title: "Day 0 induction", ownerName: "HR",
    dueAt: lateDueAt, taskDetails: {},
  }).returning({ id: onbEarlyTenureAssignments.id });
  await assignEarlyTenureAssignmentOwner({
    organizationId, assignmentId: late!.id, expectedRevision: 1, ownerUserId: actorUserId, actorUserId,
  });
  await runEarlyTenureReminderTick({ now: new Date(), owner: `late-owner-${suffix}` });
  const [current] = await db.select().from(onbEarlyTenureAssignments).where(and(
    eq(onbEarlyTenureAssignments.organizationId, organizationId),
    eq(onbEarlyTenureAssignments.obligationKey, "late-owner-handoff"),
    eq(onbEarlyTenureAssignments.status, "pending"),
  ));
  const [reminder] = await db.select().from(onbEarlyTenureReminders).where(and(
    eq(onbEarlyTenureReminders.organizationId, organizationId),
    eq(onbEarlyTenureReminders.targetId, current!.id),
  ));
  assert.equal(current!.dueAt.getTime(), lateDueAt.getTime());
  assert.equal(reminder!.status, "pending");
  assert.ok((await getEarlyTenureReminderInbox(organizationId, actorUserId)).some((row) => row.id === reminder!.id));
});

test("bounded reminder scans skip already-outboxed work and reach a later tenant", async () => {
  const dueAt = new Date(Date.now() - 60_000);
  const existing = await db.insert(onbEarlyTenureAssignments).values(Array.from({ length: 500 }, (_, index) => ({
    organizationId, caseId, snapshotVersion: 1, obligationKey: `already-outboxed-${index}`, revision: 1,
    kind: "induction" as const, title: "Already outboxed", ownerName: "HR", ownerUserId: actorUserId, dueAt, taskDetails: {},
  }))).returning({ id: onbEarlyTenureAssignments.id });
  await db.insert(onbEarlyTenureReminders).values(existing.map(({ id }) => ({
    organizationId, caseId, targetType: "assignment" as const, targetId: id, targetRevision: 1,
    eventKey: `early-tenure:assignment:${id}:revision:1:due`, intendedRecipient: "HR", dueAt, availableAt: dueAt,
  })));
  const laterTenant = `early-tenure-later-${suffix}`;
  let laterCaseId: number | undefined;
  try {
    await db.insert(organizationsTable).values({ id: laterTenant, name: "Later tenant", slug: laterTenant, joinCodeHash: `hash-${laterTenant}`, createdByUserId: creatorUserId });
    await db.insert(organizationMembershipsTable).values({ organizationId: laterTenant, clerkUserId: actorUserId, role: "admin" });
    await seedApprovedSensitiveLifecyclePolicies(laterTenant);
    const [laterCase] = await db.insert(onbCases).values({
      organizationId: laterTenant, workerName: "Later worker", workerEmail: `later-${suffix}@example.com`,
      channelPreference: "whatsapp", hireType: "external-fte", workerCategory: "employee", role: "Engineer",
      department: "Engineering", geography: "US", legalEntity: "Test Co", managerName: "Manager", recruiterName: "Recruiter",
      joiningDate: "2024-01-01", workforceContext: { workCountry: "US" }, createdByUserId: creatorUserId,
    }).returning({ id: onbCases.id });
    laterCaseId = laterCase!.id;
    const [laterAssignment] = await db.insert(onbEarlyTenureAssignments).values({
      organizationId: laterTenant, caseId: laterCaseId!, snapshotVersion: 1, obligationKey: "later-eligible",
      revision: 1, kind: "induction", title: "Later eligible", ownerName: "HR", ownerUserId: actorUserId, dueAt, taskDetails: {},
    }).returning({ id: onbEarlyTenureAssignments.id });
    await runEarlyTenureReminderTick({ now: new Date(), owner: `fairness-${suffix}` });
    const [laterReminder] = await db.select().from(onbEarlyTenureReminders).where(and(
      eq(onbEarlyTenureReminders.organizationId, laterTenant), eq(onbEarlyTenureReminders.targetId, laterAssignment!.id),
    ));
    assert.ok(laterReminder, "later tenant must not be starved by 500 existing outbox rows");
  } finally {
    if (laterCaseId) await db.delete(onbCases).where(and(eq(onbCases.organizationId, laterTenant), eq(onbCases.id, laterCaseId)));
    await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, laterTenant));
    await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, laterTenant));
    await deleteTestOrganizations(eq(organizationsTable.id, laterTenant));
  }
});

test("owner evidence completion fences a concurrent membership revocation", async () => {
  const [assignment] = await db.insert(onbEarlyTenureAssignments).values({
    organizationId, caseId, snapshotVersion: 1, obligationKey: "revocation-race",
    revision: 1, kind: "induction", title: "Revocation race task", ownerName: "HR", ownerUserId: actorUserId,
    dueAt: new Date(Date.now() + 86_400_000), taskDetails: {},
  }).returning({ id: onbEarlyTenureAssignments.id });
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
  let membershipLocked!: () => void;
  const membershipIsLocked = new Promise<void>((resolve) => { membershipLocked = resolve; });
  const revoker = db.transaction(async (tx) => {
    await tx.select({ id: organizationMembershipsTable.id }).from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, actorUserId),
    )).for("update");
    membershipLocked();
    await lockReleased;
    await tx.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, actorUserId),
    ));
  });
  await membershipIsLocked;
  const completion = recordMyEarlyTenureEvidence({
    organizationId, assignmentId: assignment!.id, actorUserId, recordedBy: "Test HR",
    evidenceReference: "owner-evidence", observedAt: new Date().toISOString(),
  });
  releaseLock();
  await revoker;
  await assert.rejects(completion, /assigned tenant member/);
  const [stored] = await db.select().from(onbEarlyTenureAssignments).where(eq(onbEarlyTenureAssignments.id, assignment!.id));
  assert.equal(stored!.status, "pending");
  // Subsequent lifecycle-minimization assertions use the same seeded tenant.
  await db.update(organizationMembershipsTable).set({ revokedAt: null }).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, actorUserId),
  ));
});

test("case minimization cancels active tenure targets and suppresses their durable reminders", async () => {
  const [assignment] = await db.select().from(onbEarlyTenureAssignments).where(and(
    eq(onbEarlyTenureAssignments.organizationId, organizationId),
    eq(onbEarlyTenureAssignments.obligationKey, "manual-email-test"),
  )).limit(1);
  assert.ok(assignment);
  const [reminder] = await db.insert(onbEarlyTenureReminders).values({
    organizationId, caseId, targetType: "assignment", targetId: assignment!.id,
    targetRevision: assignment!.revision, eventKey: `minimization-${suffix}`,
    intendedRecipient: "HR", dueAt: assignment!.dueAt, availableAt: new Date(),
  }).returning({ id: onbEarlyTenureReminders.id });
  await db.update(onbSensitiveLifecyclePolicies).set({ retentionDays: 0 })
    .where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
  await runSensitiveLifecycleDeletionWorker({
    organizationId, limit: 100, now: new Date(Date.now() + 60_000),
  });
  const [target] = await db.select().from(onbEarlyTenureAssignments).where(eq(onbEarlyTenureAssignments.id, assignment!.id));
  const [storedReminder] = await db.select().from(onbEarlyTenureReminders).where(eq(onbEarlyTenureReminders.id, reminder!.id));
  assert.equal(target!.status, "cancelled");
  assert.equal(storedReminder!.status, "suppressed");
});