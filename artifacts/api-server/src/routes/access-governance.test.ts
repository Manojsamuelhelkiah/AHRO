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
  accessUserGroups,
  accessGovernanceHistory,
  db,
  onbCases,
  onbConnectors,
  onbSettings,
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

async function deleteGovernanceFixture(id: string) {
  await deleteTestOrganizations(eq(organizationsTable.id, id), async (tx) => {
    // The live development workers may seed inert tenant defaults mid-test.
    // Delete only this fixture's bootstrap rows under the parent's FK lock.
    await tx.delete(onbConnectors).where(eq(onbConnectors.organizationId, id));
    await tx.delete(onbSettings).where(eq(onbSettings.organizationId, id));
  });
}

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
  tenantId = organizationId,
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}/organizations/current/access${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": userId,
      "x-organization-id": tenantId,
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

test("owner-created starters persist once per tenant without changing existing access or lifecycle", { skip: !hasDb }, async () => {
  const otherOrganizationId = `${suffix}-starter-other`;
  const adminUserId = `${suffix}-admin`;
  await db.insert(organizationsTable).values({
    id: otherOrganizationId, name: "Starter isolation", slug: otherOrganizationId,
    joinCodeHash: `${otherOrganizationId}-join`, createdByUserId: managerUserId,
  });
  await db.insert(organizationMembershipsTable).values([
    { organizationId: otherOrganizationId, clerkUserId: managerUserId, role: "owner" },
    { organizationId, clerkUserId: adminUserId, role: "admin" },
  ]);
  try {
    expectStatus(await mutate("/user-groups", "POST", adminUserId, { starterId: "hr" }), 403);
    expectStatus(await mutate("/user-groups", "POST", humanMemberUserId, { starterId: "hr" }), 403);
    for (const body of [{ starterId: "owner" }, { starterId: null }, { starterId: "HR" },
      { starterId: "hr", name: "Override" }, { starterId: "custom" }, {}, { name: " " }]) {
      expectStatus(await mutate("/user-groups", "POST", managerUserId, body), 400);
    }
    const custom = await mutate("/user-groups", "POST", userGroupOwnerUserId, { name: " HR " });
    expectStatus(custom, 201);
    const legacyId = custom.body.userGroup.id;
    const security = await mutate("/security-groups", "POST", securityGroupOwnerUserId, {
      name: "Starter preservation policy", allows: ["flow.case.read"],
    });
    expectStatus(security, 201);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    expectStatus(await mutate(`/user-groups/${legacyId}/members`, "PUT", managerUserId, {
      principalType: "user", principalId: humanMemberUserId, active: true, expiresAt,
    }), 200);
    expectStatus(await mutate(`/user-groups/${legacyId}/security-groups`, "PUT", managerUserId, {
      securityGroupId: security.body.securityGroup.id, active: true, expiresAt,
    }), 200);
    const before = await currentSnapshot();
    const legacyBefore = before.userGroups.find((group: JsonRecord) => group.id === legacyId);
    const membersBefore = await db.select().from(accessUserGroupMembers).where(eq(accessUserGroupMembers.organizationId, organizationId));
    const linksBefore = await db.select().from(accessSecurityGroupUserGroups).where(eq(accessSecurityGroupUserGroups.organizationId, organizationId));
    const hrRequests = await Promise.all(Array.from({ length: 6 }, () =>
      mutate("/user-groups", "POST", managerUserId, { starterId: "hr" })));
    hrRequests.forEach((result) => { expectStatus(result, 200); assert.equal(result.body.userGroup.id, legacyId); });
    assert.equal(hrRequests.filter((result) => result.body.reusedLegacy).length, 1);
    const hr = (await currentSnapshot()).userGroups.find((group: JsonRecord) => group.id === legacyId);
    assert.deepEqual(hr, { ...legacyBefore, starterId: "hr" });
    assert.deepEqual(await db.select().from(accessUserGroupMembers).where(eq(accessUserGroupMembers.organizationId, organizationId)), membersBefore);
    assert.deepEqual(await db.select().from(accessSecurityGroupUserGroups).where(eq(accessSecurityGroupUserGroups.organizationId, organizationId)), linksBefore);

    const requests = await Promise.all(Array.from({ length: 8 }, () =>
      mutate("/user-groups", "POST", managerUserId, { starterId: "ai-agents" })));
    assert.equal(requests.filter((result) => result.response.status === 201).length, 1);
    assert.equal(new Set(requests.map((result) => result.body.userGroup.id)).size, 1);
    requests.forEach((result) => assert.ok([200, 201].includes(result.response.status)));
    const agentGroupId = requests[0].body.userGroup.id;
    for (const starterId of ["hiring-managers", "it-operations", "payroll", "compliance-reviewers"]) {
      expectStatus(await mutate("/user-groups", "POST", managerUserId, { starterId }), 201);
    }
    const after = await currentSnapshot();
    assert.equal(after.userGroupStarters.length, 6);
    assert.equal(after.userGroups.filter((group: JsonRecord) => group.starterId).length, 6);
    assert.deepEqual(after.agents, before.agents);
    assert.deepEqual(after.securityGroups, before.securityGroups);
    assert.deepEqual(after.grants, before.grants);
    for (const group of after.userGroups.filter((group: JsonRecord) => group.starterId && group.id !== legacyId)) {
      assert.deepEqual(group.members, []);
      assert.deepEqual(group.securityGroups, []);
      assert.deepEqual(group.securityGroupAttachments, []);
    }
    const events = await db.select().from(accessGovernanceHistory).where(eq(accessGovernanceHistory.organizationId, organizationId));
    assert.equal(events.filter((event) => event.entityId === agentGroupId && event.eventType === "user-group.created").length, 1);
    assert.equal(events.filter((event) => event.entityId === legacyId && event.eventType === "user-group.starter-linked").length, 1);
    assert.ok(before.history.every((event: JsonRecord) => after.history.some((later: JsonRecord) => later.id === event.id)));

    expectStatus(await mutate(`/user-groups/${agentGroupId}`, "PATCH", managerUserId, {
      name: "Renamed automation team", expectedVersion: 1,
    }), 200);
    const renamed = await mutate("/user-groups", "POST", managerUserId, { starterId: "ai-agents" });
    expectStatus(renamed, 200);
    assert.equal(renamed.body.userGroup.id, agentGroupId);
    assert.equal(renamed.body.userGroup.name, "Renamed automation team");
    assert.equal(renamed.body.userGroup.version, 2);
    expectStatus(await mutate(`/user-groups/${agentGroupId}`, "PATCH", managerUserId, {
      status: "retired", expectedVersion: 2,
    }), 200);
    const retired = await mutate("/user-groups", "POST", managerUserId, { starterId: "ai-agents" });
    expectStatus(retired, 200);
    assert.equal(retired.body.userGroup.id, agentGroupId);
    assert.equal(retired.body.userGroup.status, "retired");
    assert.equal(retired.body.userGroup.version, 3);

    const foreign = await mutate("/user-groups", "POST", managerUserId, { starterId: "hr" }, otherOrganizationId);
    expectStatus(foreign, 201);
    assert.notEqual(foreign.body.userGroup.id, legacyId);
    const retiredLegacy = await mutate("/user-groups", "POST", managerUserId, { name: "Payroll" }, otherOrganizationId);
    expectStatus(retiredLegacy, 201);
    expectStatus(await mutate(`/user-groups/${retiredLegacy.body.userGroup.id}`, "PATCH", managerUserId,
      { expectedVersion: 1, status: "retired" }, otherOrganizationId), 200);
    const reusedRetired = await mutate("/user-groups", "POST", managerUserId, { starterId: "payroll" }, otherOrganizationId);
    expectStatus(reusedRetired, 200);
    assert.equal(reusedRetired.body.userGroup.status, "retired");
    assert.equal(reusedRetired.body.userGroup.id, retiredLegacy.body.userGroup.id);
    for (const name of ["IT Operations", "it operations"]) {
      expectStatus(await mutate("/user-groups", "POST", managerUserId, { name }, otherOrganizationId), 201);
    }
    expectStatus(await mutate("/user-groups", "POST", managerUserId, { starterId: "it-operations" }, otherOrganizationId), 409);
    const otherGroups = await db.select().from(accessUserGroups).where(eq(accessUserGroups.organizationId, otherOrganizationId));
    assert.equal(otherGroups.filter((group) => group.starterId === "it-operations").length, 0);
  } finally {
    await deleteGovernanceFixture(otherOrganizationId);
    await db.delete(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId), eq(organizationMembershipsTable.clerkUserId, adminUserId),
    ));
  }
});

after(async () => {
  if (!hasDb) return;
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => error ? reject(error) : resolve()),
    );
  }
  if (caseId) await db.delete(onbCases).where(eq(onbCases.id, caseId));
  await deleteGovernanceFixture(organizationId);
});

test("custom group name conflicts are actionable, atomic, concurrent-safe and tenant-scoped", { skip: !hasDb }, async () => {
  const otherOrganizationId = `${suffix}-conflicts-other`;
  await db.insert(organizationsTable).values({
    id: otherOrganizationId, name: "Name conflict isolation", slug: otherOrganizationId,
    joinCodeHash: `${otherOrganizationId}-join`, createdByUserId: managerUserId,
  });
  await db.insert(organizationMembershipsTable).values({
    organizationId: otherOrganizationId, clerkUserId: managerUserId, role: "owner",
  });
  try {
    for (const type of ["user-group", "security-group"] as const) {
      const path = `/${type}s`;
      const key = type === "user-group" ? "userGroup" : "securityGroup";
      const name = `${type} exact conflict`;
      const createBody = (value: string) => ({ name: value, ...(type === "security-group" ? { allows: [] } : {}) });
      const parallel = await Promise.all(Array.from({ length: 3 }, () =>
        mutate(path, "POST", managerUserId, createBody(` ${name} `))));
      assert.deepEqual(parallel.map((item) => item.response.status).sort(), [201, 409, 409]);
      const group = parallel.find((item) => item.response.status === 201)!.body[key];
      const expectConflict = (result: ApiResult, status = "active", id = group.id) => {
        expectStatus(result, 409);
        assert.equal(result.body.code, "ACCESS_GROUP_NAME_CONFLICT");
        assert.deepEqual(result.body.existingGroup, { id, name, status, type });
        assert.match(result.body.message, /in this organization/);
        assert.match(result.body.message, /View the existing group or choose a different name/);
        assert.deepEqual(Object.keys(result.body).sort(), ["code", "existingGroup", "message"]);
      };
      parallel.filter((item) => item.response.status === 409).forEach((item) => expectConflict(item));
      const foreign = await mutate(path, "POST", managerUserId, createBody(name), otherOrganizationId);
      expectStatus(foreign, 201);
      assert.notEqual(foreign.body[key].id, group.id);
      expectConflict(await mutate(path, "POST", managerUserId, createBody(name), otherOrganizationId), "active", foreign.body[key].id);
      const denied = await mutate(path, "POST", humanMemberUserId, createBody(name));
      expectStatus(denied, 403);
      assert.equal(denied.body.existingGroup, undefined);
      const missing = await mutate(`${path}/${foreign.body[key].id}`, "PATCH", managerUserId, { name, expectedVersion: 1 });
      expectStatus(missing, 404);
      assert.equal(missing.body.existingGroup, undefined);
      // Self-renames and case-distinct names retain the exact DB semantics.
      expectStatus(await mutate(`${path}/${group.id}`, "PATCH", managerUserId, { name, expectedVersion: 1 }), 200);
      expectStatus(await mutate(path, "POST", managerUserId, createBody(name.toUpperCase())), 201);
      const sources = await Promise.all(["one", "two"].map((label) =>
        mutate(path, "POST", managerUserId, createBody(`${name} ${label}`))));
      sources.forEach((item) => expectStatus(item, 201));
      const before = await currentSnapshot();
      for (const source of sources) {
        expectConflict(await mutate(`${path}/${source.body[key].id}`, "PATCH", managerUserId, {
          name: ` ${name} `, expectedVersion: 1,
          ...(type === "security-group" ? { allows: ["data.case.notes.read"] } : {}),
        }));
      }
      const afterFailure = await currentSnapshot();
      assert.equal(afterFailure.history.length, before.history.length, "failed renames must not write audit history");
      for (const source of sources) {
        const saved = afterFailure[type === "user-group" ? "userGroups" : "securityGroups"]
          .find((item: JsonRecord) => item.id === source.body[key].id);
        assert.equal(saved.version, 1);
        assert.equal(saved.name, source.body[key].name);
        if (type === "security-group") {
          assert.deepEqual(saved.allows, []);
          const policies = await db.select().from(accessSecurityGroupPolicies).where(and(
            eq(accessSecurityGroupPolicies.organizationId, organizationId),
            eq(accessSecurityGroupPolicies.securityGroupId, saved.id),
          ));
          assert.equal(policies.length, 1, "conflicting rename must roll back the new policy revision");
        }
      }
      const targetName = `${name} concurrent rename`;
      const renames = await Promise.all(sources.map((source) => mutate(`${path}/${source.body[key].id}`, "PATCH",
        managerUserId, { name: targetName, expectedVersion: 1 })));
      assert.deepEqual(renames.map((item) => item.response.status).sort(), [200, 409]);
      const winner = sources[renames.findIndex((item) => item.response.status === 200)].body[key];
      assert.equal(renames.find((item) => item.response.status === 409)!.body.existingGroup.id, winner.id);
      expectStatus(await mutate(`${path}/${group.id}`, "PATCH", managerUserId, { status: "retired", expectedVersion: 2 }), 200);
      expectConflict(await mutate(path, "POST", managerUserId, createBody(name)), "retired");
      const retiredRename = await mutate(`${path}/${group.id}`, "PATCH", managerUserId, { name: targetName, expectedVersion: 3 });
      expectStatus(retiredRename, 409);
      assert.equal(retiredRename.body.code, "ACCESS_GROUP_RETIRED");
      assert.equal(retiredRename.body.existingGroup, undefined);
    }
  } finally {
    await deleteGovernanceFixture(otherOrganizationId);
  }
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
