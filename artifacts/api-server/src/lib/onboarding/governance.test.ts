import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisionReviews,
  onbGovernanceDecisions,
  onbGovernanceDispatchMarkers,
  onbGovernanceHistory,
  onbGovernanceReminders,
  onbGovernanceRequirements,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import {
  assignGovernanceAuthority,
  createGovernanceDecision,
  dispatchDueGovernanceReminders,
  GovernanceConflictError,
  GovernancePermissionError,
  listGovernanceAssignments,
  reviewGovernanceDecision,
  reconcileGovernanceDispatch,
  requestGovernanceAuthority,
  reviseGovernanceDecision,
  revokeGovernanceAuthority,
  updateGovernanceRequirementCoverage,
  verifyGovernanceAuthority,
  getSensitiveLifecycleAuthorityContext,
} from "./governance";
import {
  GovernanceDispatchBlockedError,
  withGovernanceDispatch,
} from "./governance-dispatch";

const suffix = `${process.pid}-${randomUUID()}`;
const organizationId = `governance-${suffix}`;
const otherOrganizationId = `governance-other-${suffix}`;
const contextOrganizationId = `governance-context-${suffix}`;
const adminId = `governance-admin-${suffix}`;
const operatorId = `governance-operator-${suffix}`;
const specialistId = `governance-specialist-${suffix}`;
const contextMemberId = `governance-context-member-${suffix}`;
const organizations = [organizationId, otherOrganizationId, contextOrganizationId];
let priorOperators: string | undefined;

const admin = { userId: adminId, organizationRole: "admin" as const };
const operator = { userId: operatorId, organizationRole: "member" as const };
const specialist = { userId: specialistId, organizationRole: "member" as const };

function decisionInput(key: string, due?: string) {
  return {
    key,
    title: "Governance regression decision",
    proposedValue: { provisional: true },
    rationale: "Regression coverage for revision and authority controls.",
    risk: "An unverified approval could authorize a live action.",
    accountableRole: "Legal",
    impactedWorkflows: ["legal-test-workflow"],
    reviewDueAt: due,
    sourceReference: "test-only",
  };
}

before(async () => {
  priorOperators = process.env.GOVERNANCE_VERIFIED_OPERATOR_IDS;
  process.env.GOVERNANCE_VERIFIED_OPERATOR_IDS = operatorId;
  await db.insert(organizationsTable).values(organizations.map((id) => ({
    id,
    name: id,
    slug: id,
    joinCodeHash: `hash-${id}`,
    createdByUserId: adminId,
  })));
  await db.insert(organizationMembershipsTable).values([
    { organizationId, clerkUserId: adminId, role: "admin" },
    { organizationId, clerkUserId: operatorId, role: "member" },
    { organizationId, clerkUserId: specialistId, role: "member" },
    { organizationId: otherOrganizationId, clerkUserId: adminId, role: "admin" },
    { organizationId: contextOrganizationId, clerkUserId: contextMemberId, role: "member" },
  ]);
});

after(async () => {
  if (priorOperators === undefined) delete process.env.GOVERNANCE_VERIFIED_OPERATOR_IDS;
  else process.env.GOVERNANCE_VERIFIED_OPERATOR_IDS = priorOperators;
  await db.delete(onbGovernanceDecisionReviews).where(inArray(onbGovernanceDecisionReviews.organizationId, organizations));
  await db.delete(onbGovernanceReminders).where(inArray(onbGovernanceReminders.organizationId, organizations));
  await db.delete(onbGovernanceHistory).where(inArray(onbGovernanceHistory.organizationId, organizations));
  await db.delete(onbGovernanceDispatchMarkers).where(inArray(onbGovernanceDispatchMarkers.organizationId, organizations));
  await db.delete(onbGovernanceRequirements).where(inArray(onbGovernanceRequirements.organizationId, organizations));
  await db.delete(onbGovernanceDecisions).where(inArray(onbGovernanceDecisions.organizationId, organizations));
  await db.delete(onbGovernanceAuthorityAssignments).where(inArray(onbGovernanceAuthorityAssignments.organizationId, organizations));
  await db.delete(organizationMembershipsTable).where(inArray(organizationMembershipsTable.organizationId, organizations));
  await deleteTestOrganizations(inArray(organizationsTable.id, organizations));
});

describe("governance decision register", { concurrency: false }, () => {
  test("projects missing, nominated, verified, revoked, and expired authority safely", async () => {
    let context = await getSensitiveLifecycleAuthorityContext(contextOrganizationId);
    assert.equal(context.authorityStatus, "missing");
    assert.equal(context.reviewer, null);
    assert.equal(context.nomination, null);

    const [nomination] = await db.insert(onbGovernanceAuthorityAssignments).values({
      organizationId: contextOrganizationId,
      authorityRole: "privacy",
      assigneeUserId: contextMemberId,
      verificationStatus: "pending",
      verifiedByUserId: "operator-pending",
      verificationReference: "owner-nomination",
    }).returning();
    context = await getSensitiveLifecycleAuthorityContext(contextOrganizationId);
    assert.equal(context.authorityStatus, "nominated");
    assert.equal(context.nomination?.assignmentId, nomination!.id);
    assert.match(context.nomination?.memberDisplay ?? "", /Organization member/);
    assert.doesNotMatch(context.nomination?.memberDisplay ?? "", /@/);

    await db.update(onbGovernanceAuthorityAssignments)
      .set({ verificationStatus: "verified", verifiedByUserId: operatorId, verificationReference: "operator-check" })
      .where(eq(onbGovernanceAuthorityAssignments.id, nomination!.id));
    context = await getSensitiveLifecycleAuthorityContext(contextOrganizationId);
    assert.equal(context.authorityStatus, "verified");
    assert.equal(context.reviewer?.assignmentId, nomination!.id);
    assert.equal(context.nomination, null);

    await db.update(onbGovernanceAuthorityAssignments)
      .set({ revokedAt: new Date(), revokedByUserId: operatorId })
      .where(eq(onbGovernanceAuthorityAssignments.id, nomination!.id));
    context = await getSensitiveLifecycleAuthorityContext(contextOrganizationId);
    assert.equal(context.authorityStatus, "revoked");
    assert.equal(context.reviewer, null);

    await db.update(onbGovernanceAuthorityAssignments)
      .set({ revokedAt: null, expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(onbGovernanceAuthorityAssignments.id, nomination!.id));
    context = await getSensitiveLifecycleAuthorityContext(contextOrganizationId);
    assert.equal(context.authorityStatus, "expired");
    assert.equal(context.reviewer, null);
  });

  test("rejects admin self-declaration and verifies an owner nomination separately", async () => {
    await assert.rejects(
      assignGovernanceAuthority(organizationId, admin, {
        role: "Legal", assigneeUserId: adminId, verificationReference: "forged-admin-claim",
      }),
      GovernancePermissionError,
    );
    const nomination = await requestGovernanceAuthority(organizationId, admin, {
      role: "Legal", assigneeUserId: specialistId, assignmentReason: "Legal reviewer nomination",
    });
    assert.equal(nomination.verificationStatus, "pending");
    const assignment = await verifyGovernanceAuthority(
      organizationId, operator, nomination.id, "operator-verification-001",
    );
    assert.equal(assignment.verificationStatus, "verified");
    assert.equal(assignment.role, "legal");
    assert.equal(assignment.assigneeUserId, specialistId);
    assert.deepEqual(await listGovernanceAssignments(otherOrganizationId), []);
  });

  test("requires current revision and active specialist authority for review", async () => {
    const key = `GD-${suffix}-revision`;
    await createGovernanceDecision(organizationId, admin, decisionInput(key));
    await assert.rejects(
      reviseGovernanceDecision(organizationId, admin, key, {
        expectedRevision: 1, accountableRole: "EHS / Occupational Health",
      }),
      GovernancePermissionError,
    );
    const firstReview = await reviewGovernanceDecision(organizationId, specialist, key, {
      revision: 1, outcome: "approved", reason: "Reviewed by assigned legal specialist.",
      verificationReference: "legal-review-001",
    });
    assert.equal(firstReview.decision.status, "approved");
    const revised = await reviseGovernanceDecision(organizationId, admin, key, {
      expectedRevision: 1, rationale: "A revised, still provisional working assumption.",
    });
    assert.equal(revised.revision, 2);
    await assert.rejects(
      reviewGovernanceDecision(organizationId, specialist, key, {
        revision: 1, outcome: "approved", reason: "Stale retry.", verificationReference: "legal-review-002",
      }),
      GovernanceConflictError,
    );
    const assignments = await listGovernanceAssignments(organizationId);
    await revokeGovernanceAuthority(organizationId, operator, assignments[0]!.id);
    await assert.rejects(
      reviewGovernanceDecision(organizationId, specialist, key, {
        revision: 2, outcome: "approved", reason: "Authority was revoked.", verificationReference: "legal-review-003",
      }),
      GovernancePermissionError,
    );
  });

  test("keeps coverage dimensions independent and claims a due reminder once", async () => {
    await db.insert(onbGovernanceRequirements).values({
      organizationId,
      key: `REQ-${suffix}`,
      title: "Requirement coverage regression",
      sourceReference: "test-only",
      reviewOwnerRole: "legal",
    });
    const reassigned = await assignGovernanceAuthority(organizationId, operator, {
      role: "legal", assigneeUserId: specialistId, verificationReference: "operator-verification-002",
    });
    assert.ok(reassigned.id > 0);
    const requirement = await updateGovernanceRequirementCoverage(organizationId, specialist, `REQ-${suffix}`, {
      expectedVersion: 1, implemented: true, tested: false, configured: false, approvedForLive: false,
      evidenceReference: "test evidence reference",
    });
    assert.deepEqual(requirement.coverage, {
      implemented: true, tested: false, configured: false, approvedForLive: false,
    });

    await createGovernanceDecision(
      organizationId,
      admin,
      decisionInput(`GD-${suffix}-reminder`, "2000-01-01T00:00:00.000Z"),
    );
    const first = await dispatchDueGovernanceReminders(organizationId, new Date("2001-01-01T00:00:00.000Z"));
    const second = await dispatchDueGovernanceReminders(organizationId, new Date("2001-01-01T00:00:00.000Z"));
    assert.equal(first.dispatched, 1);
    assert.equal(second.dispatched, 0);
    const history = await db.select().from(onbGovernanceHistory).where(eq(
      onbGovernanceHistory.eventType, "review-reminder-due",
    ));
    assert.equal(history.filter((row) => row.organizationId === organizationId).length, 1);
  });

  test("fails closed when a governance provider fence interleaves a revision", async () => {
    const key = `GD-${suffix}-fenced`;
    await createGovernanceDecision(organizationId, admin, decisionInput(key));
    let releaseProvider: (() => void) | undefined;
    let providerStart!: () => void;
    const providerStarted = new Promise<void>((resolve) => { providerStart = resolve; });
    const dispatch = withGovernanceDispatch(
      { organizationId, operation: "forced-interleaving-test" },
      async (fence) => {
        assert.equal(fence.decisions.find((decision) => decision.key === key)?.revision, 1);
        providerStart();
        await new Promise<void>((done) => { releaseProvider = done; });
        return { disposition: "sent", value: "provider-effect-001" };
      },
    );
    await providerStarted;
    await assert.rejects(
      reviseGovernanceDecision(organizationId, admin, key, {
        expectedRevision: 1, rationale: "Must not commit while provider fence is active.",
      }),
      GovernanceDispatchBlockedError,
    );
    releaseProvider!();
    await dispatch;
    // The marker finalizes only after the provider result is explicit; the
    // same mutation is then allowed and observes the captured revision.
    const revised = await reviseGovernanceDecision(organizationId, admin, key, {
      expectedRevision: 1, rationale: "Safe after finalized provider fence.",
    });
    assert.equal(revised.revision, 2);
  });

  test("keeps an unknown provider result blocked until verified reconciliation", async () => {
    const key = `GD-${suffix}-ambiguous`;
    await createGovernanceDecision(organizationId, admin, decisionInput(key));
    let dispatchId = "";
    await withGovernanceDispatch(
      { organizationId, operation: "unknown-outcome-test" },
      async (fence) => {
        dispatchId = fence.dispatchId;
        return { disposition: "unknown", value: null };
      },
    );
    await assert.rejects(
      reviseGovernanceDecision(organizationId, admin, key, {
        expectedRevision: 1, rationale: "Blocked pending provider reconciliation.",
      }),
      GovernanceDispatchBlockedError,
    );
    const reconciliation = await reconcileGovernanceDispatch(
      organizationId, operator, dispatchId, "Provider confirmed no duplicate external effect.",
    );
    assert.equal(reconciliation.status, "finalized");
    const revised = await reviseGovernanceDecision(organizationId, admin, key, {
      expectedRevision: 1, rationale: "Allowed after verified reconciliation.",
    });
    assert.equal(revised.revision, 2);
  });

  test("does not create an ambiguous marker for a pre-dispatch policy denial", async () => {
    const key = `GD-${suffix}-preflight`;
    await createGovernanceDecision(organizationId, admin, decisionInput(key));
    let providerCalled = false;
    await assert.rejects(
      withGovernanceDispatch(
        {
          organizationId,
          operation: "preflight-denial-test",
          beforeDispatch: async () => { throw new Error("pending policy denies this provider action"); },
        },
        async () => {
          providerCalled = true;
          return { disposition: "sent", value: null };
        },
      ),
      /pending policy denies/,
    );
    assert.equal(providerCalled, false);
    const revised = await reviseGovernanceDecision(organizationId, admin, key, {
      expectedRevision: 1, rationale: "No provider marker was created by the preflight denial.",
    });
    assert.equal(revised.revision, 2);
  });
});