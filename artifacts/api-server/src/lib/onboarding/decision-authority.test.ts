import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db, accessNamedGrants, onbApprovals, onbCases, onbAuthorityAssignments, onbSensitiveLifecyclePolicies,
  onbAuthorityGovernance, onbSettings, organizationMembershipsTable, organizationsTable,
  DEMO_ORGANIZATION_ID,
} from "@workspace/db";
import { clerkClient } from "@clerk/express";
import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";
import { decideApproval } from "./approval-decisions";
import {
  authorityScopeForApproval, decisionAuthorityStillCurrent, remoteMemberBindingKey,
  verifiedBoundEmailMember, verifyDecisionAuthorityInTransaction,
} from "./decision-authority";
import type { HumanPermissionReceipt } from "../human-permissions";
import { permissionReceiptStillCurrent } from "../human-permissions";
import { demoPrincipalSettingKey } from "../demo-principal";

const organizations: string[] = [];
async function fixture() {
  const organizationId = `permission-review-${randomUUID()}`;
  organizations.push(organizationId);
  await db.insert(organizationsTable).values({
    id: organizationId, name: "Isolated human permission review", slug: organizationId,
    joinCodeHash: `${organizationId}:unused`, createdByUserId: "requester",
  });
  await seedApprovedSensitiveLifecyclePolicies(organizationId);
  const actor = `${organizationId}:reviewer`;
  await db.insert(organizationMembershipsTable).values({ organizationId, clerkUserId: actor, role: "member" });
  const grants = await db.insert(accessNamedGrants).values(
    ["tool.approval.decide", "flow.case.edit"].map(key => ({
      organizationId, principalType: "human" as const, principalId: actor, scope: "tenant" as const,
      resourceType: key.startsWith("tool.") ? "tool" as const : "flow" as const, resourceKey: key,
      source: "named" as const, effect: "allow" as const, status: "active" as const,
      createdByUserId: "independent-access-owner", approvedByUserId: "independent-access-owner", approvedAt: new Date(),
    })),
  ).returning();
  const [caseRow] = await db.insert(onbCases).values({
    organizationId, workerName: "Permission review fixture", workerEmail: `${randomUUID()}@example.test`,
    hireType: "employee", workerCategory: "employee", role: "Engineer", department: "Test",
    geography: "US", workforceContext: { workCountry: "US" }, legalEntity: "Fixture US",
    managerName: "Manager", recruiterName: "Requester", joiningDate: "2031-01-01",
    createdByUserId: "requester", lifecycleStage: "preboarding", orchestrationStatus: "waiting-approval",
  }).returning();
  const [approval] = await db.insert(onbApprovals).values({
    organizationId, caseId: caseRow.id, agent: "human-review", ruleRef: "Permission regression review",
    hitlPattern: "hard-block", recommendation: "Review current fixture evidence", rationale: "Fixture only",
    resumeAction: "none", requestedByUserId: "requester", idempotencyKey: randomUUID(),
    authorityScope: "legal-approve", authorityReviewStatus: "current",
  }).returning();
  const verify = (user = actor, org = organizationId) => db.transaction(tx =>
    verifyDecisionAuthorityInTransaction(tx, { organizationId: org, approval, actorUserId: user }));
  return { organizationId, actor, caseRow, approval, grants, verify };
}

describe("permission-based human review boundaries", { skip: !process.env.DATABASE_URL }, () => {
  after(async () => {
    for (const org of organizations) {
      await db.delete(onbCases).where(eq(onbCases.organizationId, org));
      await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, org));
      await deleteTestOrganizations(eq(organizationsTable.id, org));
    }
  });

  test("shared Demo cannot decide even with otherwise sufficient ordinary client permissions", async () => {
    const f = await fixture();
    await db.insert(organizationsTable).values({
      id: DEMO_ORGANIZATION_ID, name: "Disposable Demo registry", slug: "disposable-demo-registry",
      joinCodeHash: randomUUID(), createdByUserId: "fixture",
    }).onConflictDoNothing();
    await db.insert(onbSettings).values({
      organizationId: DEMO_ORGANIZATION_ID, key: demoPrincipalSettingKey(f.actor), value: "administrator",
    });
    assert.equal((await f.verify()).allowed, false);
    const result = await decideApproval({
      organizationId: f.organizationId, approvalId: f.approval.id, expectedVersion: 1,
      actorUserId: f.actor, decidedBy: f.actor, decision: "approved",
    });
    assert.equal(result.outcome, "unauthorized");
    const [unchanged] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, f.approval.id));
    assert.equal(unchanged.status, "pending");
    assert.equal(unchanged.permissionDecision, null);
  });

  test("named member can explicitly decide without any specialist assignment or bootstrap", async () => {
    const f = await fixture();
    assert.deepEqual(await db.select().from(onbAuthorityAssignments).where(eq(onbAuthorityAssignments.organizationId, f.organizationId)), []);
    assert.deepEqual(await db.select().from(onbAuthorityGovernance).where(eq(onbAuthorityGovernance.organizationId, f.organizationId)), []);
    assert.equal((await f.verify()).allowed, true);
    const result = await decideApproval({
      organizationId: f.organizationId, approvalId: f.approval.id, expectedVersion: f.approval.version,
      actorUserId: f.actor, decidedBy: f.actor, decision: "approved",
    });
    assert.equal(result.outcome, "decided");
    assert.equal(result.outcome === "decided" && result.released, false, "recording a review is not a gateway release");
    const [row] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, f.approval.id));
    assert.equal(row.permissionDecision?.schema, "human-permission/v1");
    assert.equal(row.permissionDecision?.actorUserId, f.actor);
    assert.equal(await db.transaction(tx => decisionAuthorityStillCurrent(tx, row)), true);
    await db.update(accessNamedGrants).set({ revokedAt: new Date() }).where(eq(accessNamedGrants.id, f.grants[0].id));
    assert.equal(await db.transaction(tx => decisionAuthorityStillCurrent(tx, row)), false, "revocation before dispatch invalidates the receipt");
    assert.equal((await f.verify()).allowed, false);
  });

  test("explicit denies, tenant isolation and requester separation still apply", async () => {
    const f = await fixture();
    assert.equal((await f.verify("requester")).allowed, false);
    assert.equal((await f.verify(f.actor, `${f.organizationId}:other`)).allowed, false);
    await db.insert(accessNamedGrants).values({
      organizationId: f.organizationId, principalType: "human", principalId: f.actor, scope: "tenant",
      resourceType: "tool", resourceKey: "tool.approval.decide", source: "named", effect: "deny", status: "active",
      createdByUserId: "independent-access-owner", approvedByUserId: "independent-access-owner", approvedAt: new Date(),
    });
    assert.equal((await f.verify()).allowed, false, "an allow never overrides an explicit deny");
  });

  test("historical specialist receipts and malformed or stale permission receipts cannot release work", async () => {
    const f = await fixture();
    const legacy = { ...f.approval, status: "approved", decidedBy: f.actor,
      decidedAuthorityId: "historical-specialist-grant", decidedAuthorityRevision: 1 };
    assert.equal(await db.transaction(tx => decisionAuthorityStillCurrent(tx, legacy)), false);
    const receipt: HumanPermissionReceipt = {
      schema: "human-permission/v1", organizationId: f.organizationId, caseId: f.caseRow.id, actorUserId: f.actor,
      requiredKeys: ["tool.approval.decide", "flow.case.edit"], reviewedRevision: 1, evidenceGeneration: 1,
      decision: "approved", recordedAt: new Date().toISOString(), ownerAdminRequired: false,
    };
    const current = (r: HumanPermissionReceipt, revision = 1) => db.transaction(tx => permissionReceiptStillCurrent(tx, r, {
      organizationId: f.organizationId, caseId: f.caseRow.id, requiredKeys: ["tool.approval.decide", "flow.case.edit"],
      reviewedRevision: revision, evidenceGeneration: 1,
    }));
    assert.equal(await current(receipt), true);
    assert.equal(await current(receipt, 2), false);
    assert.equal(await current({ ...receipt, actorUserId: "requester" }), false);
    assert.equal(await current({ ...receipt, requiredKeys: ["flow.case.edit"] }), false);
    assert.equal(await current({ ...receipt, recordedAt: "not-a-date" }), false);
    assert.equal(await current({ ...receipt, caseId: null }), false);
  });

  test("remote identity requires an explicit binding and current unique verified ownership; transport cannot be a caller flag", async () => {
    const f = await fixture();
    const email = "reviewer@example.test";
    const getUserList = clerkClient.users.getUserList;
    try {
      clerkClient.users.getUserList = (async () => ({ data: [{
        id: f.actor, emailAddresses: [{ emailAddress: email, verification: { status: "verified" } }],
      }] })) as typeof getUserList;
      assert.equal(await db.transaction(tx => verifiedBoundEmailMember(tx, f.organizationId, email)), null);
      await db.insert(onbSettings).values({ organizationId: f.organizationId, key: remoteMemberBindingKey(email),
        value: JSON.stringify({ schema: "named-member-email/v1", email, userId: f.actor, consentedAt: new Date().toISOString() }) });
      assert.equal(await db.transaction(tx => verifiedBoundEmailMember(tx, f.organizationId, email)), f.actor);
      const result = await decideApproval({ organizationId: f.organizationId, approvalId: f.approval.id,
        expectedVersion: f.approval.version, decidedBy: email, responderEmail: email, decision: "approved" });
      assert.equal(result.outcome, "unauthorized", "an email string without raw verified Gmail transport is insufficient");
      clerkClient.users.getUserList = (async () => ({ data: [{
        id: "another-person", emailAddresses: [{ emailAddress: email, verification: { status: "verified" } }],
      }] })) as typeof getUserList;
      assert.equal(await db.transaction(tx => verifiedBoundEmailMember(tx, f.organizationId, email)), null);
      await db.delete(onbSettings).where(and(eq(onbSettings.organizationId, f.organizationId), eq(onbSettings.key, remoteMemberBindingKey(email))));
      assert.equal(await db.transaction(tx => verifiedBoundEmailMember(tx, f.organizationId, email)), null);
    } finally { clerkClient.users.getUserList = getUserList; }
  });

  test("reviewer routing metadata remains stable without establishing professional qualifications", () => {
    assert.equal(authorityScopeForApproval({ ruleRef: "Legal transfer review" }), "legal-approve");
    assert.equal(authorityScopeForApproval({ ruleRef: "Medical clearance review" }), "occupational-health-approve");
    assert.equal(authorityScopeForApproval({ ruleRef: "BGV adverse Legal review" }), "hr-compliance-approve");
  });
});
