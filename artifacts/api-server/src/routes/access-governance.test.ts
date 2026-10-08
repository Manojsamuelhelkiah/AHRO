import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  accessNamedGrants,
  accessPrincipalSecurityGroupAttachments,
  accessSecurityGroupPolicies,
  accessSecurityGroupAttachments,
  accessSecurityGroupUserGroups,
  accessUserGroupMembers,
  db,
  onbCases,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { errorHandler } from "../middlewares/error-handler";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import accessGovernanceRouter from "./access-governance";


const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `access-governance-route-${process.pid}-${randomUUID()}`;
const organizationId = `${suffix}-org`;
const managerUserId = `${suffix}-manager`;
const userGroupOwnerUserId = `${suffix}-user-group-owner`;
const securityGroupOwnerUserId = `${suffix}-security-group-owner`;
const humanMemberUserId = `${suffix}-human-member`;
let server: Server | undefined;
let baseUrl = "";
let caseId: number;

type JsonRecord = Record<string, any>;
type ApiResult = { response: Response; body: JsonRecord };

async function api(path: string, userId: string, body?: unknown): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}/organizations/current/access${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-test-user": userId,
      "x-organization-id": organizationId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
  }
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), text);
  return { response, body: parsed as JsonRecord };
}

async function mutate(
  path: string,
  method: "POST" | "PUT" | "PATCH",
  userId: string,
  body: unknown,
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}/organizations/current/access${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": userId,
      "x-organization-id": organizationId,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
  }
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), text);
  return { response, body: parsed as JsonRecord };
}

function expectStatus(result: ApiResult, status: number): void {
  assert.equal(result.response.status, status, JSON.stringify(result.body));
}

async function currentSnapshot(userId = managerUserId): Promise<JsonRecord> {
  const result = await api("/", userId);
  expectStatus(result, 200);
  return result.body;
}

async function currentUserGroupVersion(userGroupId: string): Promise<number> {
  const snapshot = await currentSnapshot();
  const group = snapshot.userGroups.find((item: JsonRecord) => item.id === userGroupId);
  assert.ok(group);
  return group.version as number;
}

before(async () => {
  if (!hasDb) return;
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Access Governance Route Regression",
    slug: organizationId,
    joinCodeHash: `${organizationId}-join`,
    createdByUserId: managerUserId,
  });
  await db.insert(organizationMembershipsTable).values([
    { organizationId, clerkUserId: managerUserId, role: "owner" },
    { organizationId, clerkUserId: userGroupOwnerUserId, role: "owner" },
    { organizationId, clerkUserId: securityGroupOwnerUserId, role: "owner" },
    { organizationId, clerkUserId: humanMemberUserId, role: "member" },
  ]);
  const [testCase] = await db.insert(onbCases).values({
    organizationId,
    workerName: "Access Preview Case",
    workerEmail: `${suffix}@example.test`,
    hireType: "new-hire",
    workerCategory: "employee",
    role: "Analyst",
    department: "Operations",
    geography: "London",
    legalEntity: "Example Ltd",
    managerName: "Test Manager",
    recruiterName: "Test Recruiter",
    joiningDate: "2026-01-01",
  }).returning({ id: onbCases.id });
  caseId = testCase.id;
  await db.insert(accessNamedGrants).values([
    {
      organizationId,
      principalType: "human",
      principalId: humanMemberUserId,
      scope: "tenant",
      resourceType: "field",
      resourceKey: "data.case.notes.read",
      source: "named",
      effect: "allow",
      status: "active",
      requiresApproval: "no",
      createdByUserId: managerUserId,
    },
    {
      organizationId,
      principalType: "human",
      principalId: humanMemberUserId,
      scope: "tenant",
      resourceType: "field",
      resourceKey: "data.case.profile.read",
      source: "named",
      effect: "deny",
      status: "active",
      requiresApproval: "no",
      createdByUserId: managerUserId,
    },
    {
      organizationId,
      principalType: "human",
      principalId: humanMemberUserId,
      scope: "case",
      caseId,
      resourceType: "field",
      resourceKey: "data.documents.read",
      source: "named",
      effect: "allow",
      status: "active",
      requiresApproval: "no",
      createdByUserId: managerUserId,
    },
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = String(req.header("x-test-user") ?? "");
    next();
  });
  app.use(
    "/organizations/current/access",
    createTenantContextMiddleware(lookupMembership),
    accessGovernanceRouter,
  );
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server!.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!hasDb) return;
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => error ? reject(error) : resolve()),
    );
  }
  if (caseId) await db.delete(onbCases).where(eq(onbCases.id, caseId));
  await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
});

test("temporary memberships and group/direct attachments stop granting access at expiry without cleanup", { skip: !hasDb }, async () => {
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 1_000);
  const group = (await mutate("/user-groups", "POST", userGroupOwnerUserId, { name: "Temporary review group" })).body.userGroup;
  const security = (await mutate("/security-groups", "POST", securityGroupOwnerUserId, {
    name: "Temporary review policy", allows: ["flow.onboarding.read"],
  })).body.securityGroup;
  const memberPath = `/user-groups/${group.id}/members`;
  const attachmentPath = `/user-groups/${group.id}/security-groups`;
  expectStatus(await mutate(memberPath, "PUT", managerUserId, {
    principalType: "user", principalId: humanMemberUserId, active: true, expiresAt: expiry,
  }), 200);
  expectStatus(await mutate(attachmentPath, "PUT", managerUserId, {
    securityGroupId: security.id, active: true, expiresAt: expiry,
  }), 200);
  expectStatus(await mutate(memberPath, "PUT", managerUserId, {
    principalType: "user", principalId: humanMemberUserId, active: true,
  }), 200);
  expectStatus(await mutate(attachmentPath, "PUT", managerUserId, {
    securityGroupId: security.id, active: true,
  }), 200);
  const preview = () => api(`/preview?principalType=user&principalId=${humanMemberUserId}`, managerUserId);
  assert.ok((await preview()).body.allows.includes("flow.onboarding.read"));
  let snapshot = await currentSnapshot();
  const groupSnapshot = snapshot.userGroups.find((item: JsonRecord) => item.id === group.id);
  assert.equal(groupSnapshot.members[0].expiresAt, expiry);
  assert.equal(groupSnapshot.securityGroupAttachments[0].expiresAt, expiry);
  expectStatus(await mutate(memberPath, "PUT", managerUserId, {
    principalType: "user", principalId: humanMemberUserId, active: true,
    expiresAt: "2000-01-01T00:00:00Z",
  }), 400);
  await db.update(accessUserGroupMembers).set({ expiresAt: past }).where(and(
    eq(accessUserGroupMembers.organizationId, organizationId),
    eq(accessUserGroupMembers.groupId, group.id),
  ));
  assert.ok(!(await preview()).body.allows.includes("flow.onboarding.read"));
  assert.equal((await currentSnapshot()).userGroups.find((item: JsonRecord) => item.id === group.id).members.length, 0);
  await db.update(accessUserGroupMembers).set({ expiresAt: null }).where(and(
    eq(accessUserGroupMembers.organizationId, organizationId),
    eq(accessUserGroupMembers.groupId, group.id),
  ));
  await db.update(accessSecurityGroupUserGroups).set({ expiresAt: past }).where(and(
    eq(accessSecurityGroupUserGroups.organizationId, organizationId),
    eq(accessSecurityGroupUserGroups.userGroupId, group.id),
  ));
  assert.ok(!(await preview()).body.allows.includes("flow.onboarding.read"));
  await db.update(accessSecurityGroupUserGroups).set({ expiresAt: null }).where(and(
    eq(accessSecurityGroupUserGroups.organizationId, organizationId),
    eq(accessSecurityGroupUserGroups.userGroupId, group.id),
  ));
  await db.update(accessSecurityGroupAttachments).set({ expiresAt: past }).where(and(
    eq(accessSecurityGroupAttachments.organizationId, organizationId),
    eq(accessSecurityGroupAttachments.securityGroupId, security.id),
  ));
  assert.ok(!(await preview()).body.allows.includes("flow.onboarding.read"));
  await db.update(accessSecurityGroupAttachments).set({ expiresAt: null }).where(and(
    eq(accessSecurityGroupAttachments.organizationId, organizationId),
    eq(accessSecurityGroupAttachments.securityGroupId, security.id),
  ));
  const grant = { principalType: "user", principalId: humanMemberUserId, securityGroupId: security.id, active: true, expiresAt: expiry };
  expectStatus(await mutate("/grants", "PUT", managerUserId, grant), 200);
  expectStatus(await mutate("/grants", "PUT", managerUserId, {
    principalType: "user", principalId: humanMemberUserId, securityGroupId: security.id, active: true,
  }), 200);
  assert.equal((await currentSnapshot()).grants.find((item: JsonRecord) => item.securityGroupId === security.id).expiresAt, expiry);
  assert.ok((await preview()).body.allows.includes("flow.onboarding.read"));
  await db.update(accessPrincipalSecurityGroupAttachments).set({ expiresAt: past }).where(and(
    eq(accessPrincipalSecurityGroupAttachments.organizationId, organizationId),
    eq(accessPrincipalSecurityGroupAttachments.securityGroupId, security.id),
  ));
  await db.update(accessSecurityGroupUserGroups).set({ expiresAt: past }).where(and(
    eq(accessSecurityGroupUserGroups.organizationId, organizationId),
    eq(accessSecurityGroupUserGroups.userGroupId, group.id),
  ));
  assert.ok(!(await preview()).body.allows.includes("flow.onboarding.read"));
  snapshot = await currentSnapshot();
  assert.ok(!snapshot.grants.some((item: JsonRecord) => item.securityGroupId === security.id));
});

test("access governance routes preserve independent approvals for mixed-principal multi-group access", { skip: !hasDb }, async () => {
  const groupCreated = await mutate("/user-groups", "POST", userGroupOwnerUserId, {
    name: "Mixed Access Group",
  });
  expectStatus(groupCreated, 201);
  const userGroup = groupCreated.body.userGroup as JsonRecord;
  assert.equal(userGroup.ownerUserId, userGroupOwnerUserId);

  const agentCreated = await mutate("/agents", "POST", managerUserId, {
    name: "Mixed Group Agent",
    ownerUserId: humanMemberUserId,
  });
  expectStatus(agentCreated, 201);
  const agentId = agentCreated.body.agent.id as string;

  const pendingGroupResponse = await mutate("/security-groups", "POST", managerUserId, {
    name: "Pending non-sensitive direct binding",
    allows: ["data.case.notes.edit"],
  });
  expectStatus(pendingGroupResponse, 201);
  const pendingGroup = pendingGroupResponse.body.securityGroup as JsonRecord;
  await db.insert(accessPrincipalSecurityGroupAttachments).values({
    organizationId,
    principalType: "human",
    principalId: humanMemberUserId,
    securityGroupId: pendingGroup.id,
    scope: "tenant",
    caseId: null,
    status: "pending",
    version: 1,
    requiresApproval: "no",
    attachedByUserId: managerUserId,
  });
  const pendingPreview = await api(
    `/preview?principalType=user&principalId=${humanMemberUserId}`,
    managerUserId,
  );
  expectStatus(pendingPreview, 200);
  assert.ok(!pendingPreview.body.allows.includes("data.case.notes.edit"));

  const tenantGrantPreview = await api(
    `/preview?principalType=user&principalId=${humanMemberUserId}`,
    managerUserId,
  );
  expectStatus(tenantGrantPreview, 200);
  assert.ok(tenantGrantPreview.body.allows.includes("data.case.notes.read"));
  assert.ok(!tenantGrantPreview.body.allows.includes("data.case.profile.read"));
  assert.ok(!tenantGrantPreview.body.allows.includes("data.documents.read"));
  const caseGrantPreview = await api(
    `/preview?principalType=user&principalId=${humanMemberUserId}&caseId=${caseId}`,
    managerUserId,
  );
  expectStatus(caseGrantPreview, 200);
  assert.ok(caseGrantPreview.body.allows.includes("data.documents.read"));
  const unverifiedCasePreview = await api(
    `/preview?principalType=user&principalId=${humanMemberUserId}&caseId=999999999`,
    managerUserId,
  );
  expectStatus(unverifiedCasePreview, 200);
  assert.ok(!unverifiedCasePreview.body.allows.includes("data.documents.read"));

  const namedFieldAccess = await api("/field-access?field=data.case.notes.read", managerUserId);
  expectStatus(namedFieldAccess, 200);
  assert.ok(namedFieldAccess.body.principals.some((principal: JsonRecord) =>
    principal.principalType === "user" && principal.principalId === humanMemberUserId,
  ));
  const caseFieldAccess = await api(
    `/field-access?field=data.documents.read&caseId=${caseId}`,
    managerUserId,
  );
  expectStatus(caseFieldAccess, 200);
  assert.ok(caseFieldAccess.body.principals.some((principal: JsonRecord) =>
    principal.principalType === "user" && principal.principalId === humanMemberUserId,
  ));

  for (const member of [
    { principalType: "user", principalId: humanMemberUserId },
    { principalType: "agent", principalId: agentId },
  ]) {
    const added = await mutate(`/user-groups/${userGroup.id}/members`, "PUT", userGroupOwnerUserId, {
      ...member,
      active: true,
    });
    expectStatus(added, 200);
    assert.equal(added.body.status, "active");
  }

  const identityPolicy = ["data.identity.read"];
  const medicalPolicy = ["data.medical.read"];
  const firstSecurityGroupResponse = await mutate("/security-groups", "POST", managerUserId, {
    name: "Identity Review Group",
    ownerUserId: securityGroupOwnerUserId,
    allows: identityPolicy,
  });
  expectStatus(firstSecurityGroupResponse, 201);
  const firstSecurityGroup = firstSecurityGroupResponse.body.securityGroup as JsonRecord;
  assert.equal(firstSecurityGroup.ownerUserId, securityGroupOwnerUserId);
  assert.equal(firstSecurityGroup.approvalStatus, "pending");

  const secondSecurityGroupResponse = await mutate("/security-groups", "POST", managerUserId, {
    name: "Medical Review Group",
    ownerUserId: securityGroupOwnerUserId,
    allows: medicalPolicy,
  });
  expectStatus(secondSecurityGroupResponse, 201);
  const secondSecurityGroup = secondSecurityGroupResponse.body.securityGroup as JsonRecord;
  assert.equal(secondSecurityGroup.ownerUserId, securityGroupOwnerUserId);
  assert.equal(secondSecurityGroup.approvalStatus, "pending");

  const pendingPolicies = await currentSnapshot();
  for (const securityGroupId of [firstSecurityGroup.id, secondSecurityGroup.id]) {
    assert.equal(
      pendingPolicies.securityGroups.find((item: JsonRecord) => item.id === securityGroupId)?.approvalStatus,
      "pending",
    );
  }
  const selfPolicyApproval = await mutate(
    `/security-groups/${firstSecurityGroup.id}/approve`,
    "POST",
    managerUserId,
    { expectedVersion: 1 },
  );
  expectStatus(selfPolicyApproval, 403);

  const firstPolicyApproval = await mutate(
    `/security-groups/${firstSecurityGroup.id}/approve`,
    "POST",
    securityGroupOwnerUserId,
    { expectedVersion: 1 },
  );
  expectStatus(firstPolicyApproval, 200);

  // Give the second group a different current version. Membership approval is
  // group-owner-bound, not tied to one version shared across all policies.
  const secondPolicyEdit = await mutate(
    `/security-groups/${secondSecurityGroup.id}`,
    "PATCH",
    managerUserId,
    { expectedVersion: 1, allows: medicalPolicy },
  );
  expectStatus(secondPolicyEdit, 200);
  const secondPolicyApproval = await mutate(
    `/security-groups/${secondSecurityGroup.id}/approve`,
    "POST",
    securityGroupOwnerUserId,
    { expectedVersion: 2 },
  );
  expectStatus(secondPolicyApproval, 200);
  const currentPolicies = await db.select().from(accessSecurityGroupPolicies)
    .where(eq(accessSecurityGroupPolicies.organizationId, organizationId));
  const currentPolicyVersions = new Map<string, number>();
  for (const policy of currentPolicies) {
    currentPolicyVersions.set(
      policy.securityGroupId,
      Math.max(currentPolicyVersions.get(policy.securityGroupId) ?? 0, policy.version),
    );
  }
  assert.notEqual(
    currentPolicyVersions.get(firstSecurityGroup.id),
    currentPolicyVersions.get(secondSecurityGroup.id),
  );

  // Both high-sensitivity links may be pending simultaneously. Each owner
  // independently approves the link after approving the current policy.
  for (const securityGroupId of [firstSecurityGroup.id, secondSecurityGroup.id]) {
    const attached = await mutate(`/user-groups/${userGroup.id}/security-groups`, "PUT", managerUserId, {
      securityGroupId,
      active: true,
    });
    expectStatus(attached, 200);
    assert.equal(attached.body.status, "pending");
  }
  const pendingLinkSnapshot = await currentSnapshot();
  assert.deepEqual(
    pendingLinkSnapshot.pendingAttachments
      .filter((item: JsonRecord) => item.userGroupId === userGroup.id)
      .map((item: JsonRecord) => item.securityGroupId).sort(),
    [firstSecurityGroup.id, secondSecurityGroup.id].sort(),
  );
  const selfLinkApproval = await mutate(
    `/user-groups/${userGroup.id}/security-groups/approve`,
    "POST",
    managerUserId,
    { securityGroupId: firstSecurityGroup.id, expectedVersion: currentPolicyVersions.get(firstSecurityGroup.id) },
  );
  expectStatus(selfLinkApproval, 403);
  for (const securityGroupId of [firstSecurityGroup.id, secondSecurityGroup.id]) {
    const approved = await mutate(
      `/user-groups/${userGroup.id}/security-groups/approve`,
      "POST",
      securityGroupOwnerUserId,
      { securityGroupId, expectedVersion: currentPolicyVersions.get(securityGroupId) },
    );
    expectStatus(approved, 200);
  }

  const pendingMembershipSnapshot = await currentSnapshot();
  assert.deepEqual(
    pendingMembershipSnapshot.pendingMembers.map((item: JsonRecord) => `${item.principalType}:${item.principalId}`).sort(),
    [`agent:${agentId}`, `user:${humanMemberUserId}`].sort(),
  );
  const membersBeforeApproval = await db.select().from(accessUserGroupMembers).where(and(
    eq(accessUserGroupMembers.organizationId, organizationId),
    eq(accessUserGroupMembers.groupId, userGroup.id),
  ));
  assert.equal(membersBeforeApproval.length, 2);
  assert.ok(membersBeforeApproval.every((member) => member.status === "pending"));

  const selfMembershipApproval = await mutate(
    `/user-groups/${userGroup.id}/members/approve`,
    "POST",
    managerUserId,
    {
      principalType: "user",
      principalId: humanMemberUserId,
      expectedVersion: pendingMembershipSnapshot.userGroups.find((item: JsonRecord) => item.id === userGroup.id).version,
    },
  );
  expectStatus(selfMembershipApproval, 403);

  for (const member of [
    { principalType: "user", principalId: humanMemberUserId },
    { principalType: "agent", principalId: agentId },
  ]) {
    const approved = await mutate(
      `/user-groups/${userGroup.id}/members/approve`,
      "POST",
      userGroupOwnerUserId,
      { ...member, expectedVersion: await currentUserGroupVersion(userGroup.id) },
    );
    expectStatus(approved, 200);
  }

  const membershipsAfterApproval = await db.select().from(accessUserGroupMembers).where(and(
    eq(accessUserGroupMembers.organizationId, organizationId),
    eq(accessUserGroupMembers.groupId, userGroup.id),
  ));
  assert.ok(membershipsAfterApproval.every((member) =>
    member.status === "active" && member.approvedByUserId === userGroupOwnerUserId,
  ));
  const humanAccess = await api(`/preview?principalType=user&principalId=${humanMemberUserId}`, managerUserId);
  expectStatus(humanAccess, 200);
  assert.ok(humanAccess.body.allows.includes("data.identity.read"));
  assert.ok(humanAccess.body.allows.includes("data.medical.read"));
  const missingInitiatorAccess = await api(
    `/preview?principalType=agent&principalId=${agentId}`,
    managerUserId,
  );
  expectStatus(missingInitiatorAccess, 400);
  const agentAccess = await api(
    `/preview?principalType=agent&principalId=${agentId}&initiatorUserId=${humanMemberUserId}`,
    managerUserId,
  );
  expectStatus(agentAccess, 200);
  assert.ok(agentAccess.body.allows.includes("data.identity.read"));
  assert.ok(agentAccess.body.allows.includes("data.medical.read"));

  const directPending = await mutate("/grants", "PUT", managerUserId, {
    principalType: "user",
    principalId: humanMemberUserId,
    securityGroupId: firstSecurityGroup.id,
    active: true,
  });
  expectStatus(directPending, 200);
  assert.equal(directPending.body.status, "pending");
  const selfDirectApproval = await mutate("/grants/approve", "POST", managerUserId, {
    principalType: "user",
    principalId: humanMemberUserId,
    securityGroupId: firstSecurityGroup.id,
    expectedVersion: 1,
  });
  expectStatus(selfDirectApproval, 403);
  const directApproved = await mutate("/grants/approve", "POST", securityGroupOwnerUserId, {
    principalType: "user",
    principalId: humanMemberUserId,
    securityGroupId: firstSecurityGroup.id,
    expectedVersion: currentPolicyVersions.get(firstSecurityGroup.id),
  });
  expectStatus(directApproved, 200);

  const directRevoked = await mutate("/grants", "PUT", managerUserId, {
    principalType: "user",
    principalId: humanMemberUserId,
    securityGroupId: firstSecurityGroup.id,
    active: false,
  });
  expectStatus(directRevoked, 200);
  assert.equal(directRevoked.body.status, "revoked");
  const membershipRevoked = await mutate(`/user-groups/${userGroup.id}/members`, "PUT", managerUserId, {
    principalType: "user",
    principalId: humanMemberUserId,
    active: false,
  });
  expectStatus(membershipRevoked, 200);
  assert.equal(membershipRevoked.body.status, "revoked");

  const renameVersion = await currentUserGroupVersion(userGroup.id);
  const renamed = await mutate(`/user-groups/${userGroup.id}`, "PATCH", userGroupOwnerUserId, {
    expectedVersion: renameVersion,
    name: "Renamed Mixed Access Group",
  });
  expectStatus(renamed, 200);
  const finalSnapshot = await currentSnapshot();
  const finalGroup = finalSnapshot.userGroups.find((item: JsonRecord) => item.id === userGroup.id);
  assert.equal(finalGroup.name, "Renamed Mixed Access Group");
  assert.deepEqual(finalGroup.members, [{ principalType: "agent", principalId: agentId, expiresAt: null }]);
});
