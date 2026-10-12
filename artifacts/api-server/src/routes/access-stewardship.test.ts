import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db, organizationsTable, organizationMembershipsTable,
  accessAgents, accessUserGroups, accessUserGroupMembers,
  accessSecurityGroupUserGroups, accessSecurityGroupAttachments,
  accessGovernanceHistory, onbConnectors, onbSettings,
  onbAuthorityAssignments, onbGovernanceAuthorityAssignments, onbPolicyAuthorities,
} from "@workspace/db";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import { errorHandler } from "../middlewares/error-handler";
import router from "./access-governance";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `stewardship-${randomUUID()}`;
const organizationId = `${suffix}-org`;
const former = `${suffix}-former`;
const actor = `${suffix}-actor`;
const steward = `${suffix}-steward`;
const policyOwner = `${suffix}-policy-owner`;
const human = `${suffix}-human`;
const agent = `${suffix}-agent`;
let server: Server | undefined;
let baseUrl = "";
type Result = { status: number; body: any };

async function request(path: string, userId = actor, body?: unknown, method = body === undefined ? "GET" : "POST", tenant = organizationId): Promise<Result> {
  const response = await fetch(`${baseUrl}/organizations/current/access${path}`, {
    method, headers: { "content-type": "application/json", "x-test-user": userId, "x-organization-id": tenant },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
function expectStatus(result: Result, status = 200) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}
async function snapshot() { return expectStatus(await request("/")); }
async function version(id: string) { return (await snapshot()).userGroups.find((group: any) => group.id === id).version as number; }
async function createGroup(name: string) {
  return expectStatus(await request("/user-groups", former, { name }), 201).userGroup.id as string;
}
async function transfer(id: string, destination = steward, userId = actor, expectedVersion?: number) {
  return request(`/user-groups/${id}/owner`, userId, {
    ownerUserId: destination, expectedVersion: expectedVersion ?? await version(id), acknowledgeAccessImpact: true,
  });
}
async function preview(principalId = human, type = "user") {
  return expectStatus(await request(`/preview?principalType=${type}&principalId=${principalId}${type === "agent" ? `&initiatorUserId=${human}` : ""}`)).allows as string[];
}
async function member(id: string, principalId = human, active = true, expiresAt?: string, userId = actor, type = "user") {
  return request(`/user-groups/${id}/members`, userId, {
    principalType: type, principalId, active, ...(expiresAt === undefined ? {} : { expiresAt }),
  }, "PUT");
}
async function approve(id: string, principalId = human, userId = steward, type = "user") {
  return request(`/user-groups/${id}/members/approve`, userId, {
    principalType: type, principalId, expectedVersion: await version(id),
  });
}
const groupWhere = (id: string) => and(eq(accessUserGroups.organizationId, organizationId), eq(accessUserGroups.id, id));
const memberWhere = (id: string) => and(eq(accessUserGroupMembers.organizationId, organizationId), eq(accessUserGroupMembers.groupId, id));
async function cleanup(tenant: string) {
  await deleteTestOrganizations(eq(organizationsTable.id, tenant), async (tx) => {
    await tx.delete(onbConnectors).where(eq(onbConnectors.organizationId, tenant));
    await tx.delete(onbSettings).where(eq(onbSettings.organizationId, tenant));
  });
}
async function authorities() {
  return Promise.all([
    db.select().from(onbAuthorityAssignments).where(eq(onbAuthorityAssignments.organizationId, organizationId)),
    db.select().from(onbGovernanceAuthorityAssignments).where(eq(onbGovernanceAuthorityAssignments.organizationId, organizationId)),
    db.select().from(onbPolicyAuthorities).where(eq(onbPolicyAuthorities.organizationId, organizationId)),
  ]);
}
async function policy(name: string, allows: string[], id: string, expiresAt?: string) {
  const group = expectStatus(await request("/security-groups", actor, { name, allows, ownerUserId: policyOwner }), 201).securityGroup;
  const sensitive = allows.some((key) => key.startsWith("data.identity"));
  if (sensitive) expectStatus(await request(`/security-groups/${group.id}/approve`, policyOwner, { expectedVersion: group.version }));
  expectStatus(await request(`/user-groups/${id}/security-groups`, actor, { securityGroupId: group.id, active: true, expiresAt: expiresAt ?? null }, "PUT"));
  if (sensitive) {
    const latest = (await snapshot()).securityGroups.find((item: any) => item.id === group.id);
    expectStatus(await request(`/user-groups/${id}/security-groups/approve`, policyOwner, { securityGroupId: group.id, expectedVersion: latest.version }));
  }
  return group.id as string;
}

before(async () => {
  if (!hasDb) return;
  await db.insert(organizationsTable).values({
    id: organizationId, name: "Stewardship tests", slug: organizationId,
    joinCodeHash: `${suffix}-join`, createdByUserId: actor,
  });
  await db.insert(organizationMembershipsTable).values([
    ...[former, actor, steward, policyOwner].map((clerkUserId) => ({ organizationId, clerkUserId, role: "owner" as const })),
    { organizationId, clerkUserId: human, role: "member" },
  ]);
  await db.insert(accessAgents).values({
    organizationId, id: agent, name: "Stewardship agent", ownerUserId: human, createdByUserId: actor,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = String(req.header("x-test-user") ?? ""); next(); });
  app.use("/organizations/current/access", createTenantContextMiddleware(lookupMembership), router);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  if (hasDb) await cleanup(organizationId);
});

test("transfer retains records, expiry and starter identity without reviving departed-owner paths", { skip: !hasDb }, async () => {
  const id = expectStatus(await request("/user-groups", former, { starterId: "hr" }), 201).userGroup.id;
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  expectStatus(await member(id, human, true, expiry));
  expectStatus(await member(id, agent, true, expiry, actor, "agent"));
  await db.insert(accessUserGroupMembers).values({
    organizationId, groupId: id, principalType: "human", principalId: former,
    attachedByUserId: actor, status: "active", expiresAt: new Date(expiry),
  });
  await policy("Retained low policy", ["flow.document-review.edit"], id, expiry);
  const [original] = await db.select().from(accessUserGroups).where(groupWhere(id));
  const attachments = await db.select().from(accessSecurityGroupUserGroups).where(and(
    eq(accessSecurityGroupUserGroups.organizationId, organizationId), eq(accessSecurityGroupUserGroups.userGroupId, id),
  ));
  const scopes = await db.select().from(accessSecurityGroupAttachments).where(eq(accessSecurityGroupAttachments.organizationId, organizationId));
  const authorityBefore = await authorities();
  assert.ok((await preview()).includes("flow.document-review.edit"));
  await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId), eq(organizationMembershipsTable.clerkUserId, former),
  ));
  try {
    assert.ok(!(await preview()).includes("flow.document-review.edit"));
    expectStatus(await transfer(id));
    const [updated] = await db.select().from(accessUserGroups).where(groupWhere(id));
    assert.deepEqual(updated, { ...original, ownerUserId: steward, version: original.version + 1 });
    assert.deepEqual(await db.select().from(accessSecurityGroupUserGroups).where(and(
      eq(accessSecurityGroupUserGroups.organizationId, organizationId), eq(accessSecurityGroupUserGroups.userGroupId, id),
    )), attachments);
    assert.deepEqual(await db.select().from(accessSecurityGroupAttachments).where(eq(accessSecurityGroupAttachments.organizationId, organizationId)), scopes);
    assert.deepEqual(await authorities(), authorityBefore);
    const rows = await db.select().from(accessUserGroupMembers).where(memberWhere(id));
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.status, "pending");
      assert.equal(row.requiresApproval, "yes");
      assert.equal(row.approvedByUserId, null);
      assert.equal(row.expiresAt?.toISOString(), expiry);
    }
    for (const [principal, type] of [[human, "user"], [agent, "agent"], [former, "user"], [steward, "user"]]) {
      assert.ok(!(await preview(principal, type)).includes("flow.document-review.edit"));
    }
    const event = (await snapshot()).history.find((entry: any) => entry.entityId === id && entry.eventType === "user-group.owner.transferred");
    assert.equal(event.actorUserId, actor);
    assert.equal(event.detail.formerOwnerUserId, former);
    assert.equal(event.detail.ownerUserId, steward);
    assert.equal(event.detail.previousVersion, original.version);
  } finally {
    await db.update(organizationMembershipsTable).set({ revokedAt: null }).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId), eq(organizationMembershipsTable.clerkUserId, former),
    ));
  }
  expectStatus(await approve(id, human, former), 403);
  expectStatus(await approve(id));
  expectStatus(await approve(id, agent, steward, "agent"));
  assert.ok((await preview(agent, "agent")).includes("flow.document-review.edit"));
  // Transferring back cannot reuse either stewardship generation's approval.
  expectStatus(await transfer(id, former));
  assert.ok(!(await preview()).includes("flow.document-review.edit"));
  expectStatus(await approve(id, former, former), 403);
  await db.delete(accessUserGroups).where(groupWhere(id));
});

test("low-sensitivity PUT, expiry edits, and remove/re-add cannot bypass transfer review", { skip: !hasDb }, async () => {
  const id = await createGroup("Low admission fence");
  expectStatus(await member(id));
  await policy("Low admission policy", ["flow.onboarding.edit"], id);
  expectStatus(await transfer(id));
  for (const requester of [actor, policyOwner]) {
    const pending = expectStatus(await member(id, human, true, undefined, requester));
    assert.equal(pending.status, "pending");
    assert.ok(!(await preview()).includes("flow.onboarding.edit"));
  }
  expectStatus(await member(id, human, true, undefined, steward), 403);
  expectStatus(await member(id, human, true, undefined, human), 403);
  const expiry = new Date(Date.now() + 1_800_000).toISOString();
  assert.equal(expectStatus(await member(id, human, true, expiry)).status, "pending");
  expectStatus(await member(id, human, false));
  assert.equal(expectStatus(await member(id, human)).status, "pending");
  assert.ok(!(await preview()).includes("flow.onboarding.edit"));
  expectStatus(await approve(id, human, actor), 403);
  expectStatus(await approve(id));
  assert.ok((await preview()).includes("flow.onboarding.edit"));
  // No-op PUT preserves the current independent approval, rather than
  // downgrading the admission to an ungated membership.
  expectStatus(await member(id));
  let [row] = await db.select().from(accessUserGroupMembers).where(memberWhere(id));
  assert.equal(row.requiresApproval, "yes");
  assert.equal(row.approvedByUserId, steward);
  const laterExpiry = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(expectStatus(await member(id, human, true, laterExpiry)).status, "pending");
  assert.ok(!(await preview()).includes("flow.onboarding.edit"));
  expectStatus(await approve(id));
  expectStatus(await member(id, human, false));
  assert.equal(expectStatus(await member(id, human)).status, "pending");
  [row] = await db.select().from(accessUserGroupMembers).where(memberWhere(id));
  assert.equal(row.requiresApproval, "yes");
  assert.equal(row.approvedByUserId, null);
  assert.ok(!(await preview()).includes("flow.onboarding.edit"));
  await db.delete(accessUserGroups).where(groupWhere(id));
});

test("sensitive human and agent approvals are replaced, never specialist appointments", { skip: !hasDb }, async () => {
  const id = await createGroup("Sensitive transfer");
  expectStatus(await member(id));
  expectStatus(await member(id, agent, true, undefined, actor, "agent"));
  await policy("Sensitive transfer policy", ["data.identity.read"], id);
  expectStatus(await approve(id, human, former));
  expectStatus(await approve(id, agent, former, "agent"));
  assert.ok((await preview(agent, "agent")).includes("data.identity.read"));
  const authorityBefore = await authorities();
  expectStatus(await transfer(id));
  assert.ok(!(await preview()).includes("data.identity.read"));
  assert.ok(!(await preview(agent, "agent")).includes("data.identity.read"));
  expectStatus(await approve(id, human, former), 403);
  expectStatus(await approve(id));
  expectStatus(await approve(id, agent, steward, "agent"));
  assert.ok((await preview(agent, "agent")).includes("data.identity.read"));
  assert.deepEqual(await authorities(), authorityBefore);
  await db.delete(accessUserGroups).where(groupWhere(id));
});

test("invalid owners, retired groups, stale versions and cross-tenant transfers fail atomically", { skip: !hasDb }, async () => {
  const id = await createGroup("Transfer validation");
  const body = { ownerUserId: steward, expectedVersion: 1, acknowledgeAccessImpact: true };
  for (const invalid of [
    { ...body, ownerUserId: " " }, { ...body, acknowledgeAccessImpact: false },
    { ...body, expectedVersion: 0 }, { ...body, expectedVersion: 1.5 }, { ...body, expectedVersion: undefined },
  ]) expectStatus(await request(`/user-groups/${id}/owner`, actor, invalid), 400);
  expectStatus(await transfer(id, steward, human, 1), 403);
  expectStatus(await transfer(id, human, actor, 1), 400);
  expectStatus(await transfer(id, former, actor, 1), 409);
  const otherTenant = `${suffix}-other`;
  const outsider = `${suffix}-outsider`;
  await db.insert(organizationsTable).values({
    id: otherTenant, name: "Other transfer tenant", slug: otherTenant, joinCodeHash: `${otherTenant}-join`, createdByUserId: actor,
  });
  await db.insert(organizationMembershipsTable).values([
    { organizationId: otherTenant, clerkUserId: actor, role: "owner" },
    { organizationId: otherTenant, clerkUserId: outsider, role: "owner" },
  ]);
  try {
    expectStatus(await transfer(id, outsider, actor, 1), 400);
    expectStatus(await request(`/user-groups/${id}/owner`, actor, body, "POST", otherTenant), 404);
    const concurrent = await Promise.all([transfer(id, steward, actor, 1), transfer(id, policyOwner, actor, 1)]);
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
    expectStatus(await request(`/user-groups/${id}`, actor, { name: "Stale rename", expectedVersion: 1 }, "PATCH"), 409);
    const events = await db.select().from(accessGovernanceHistory).where(and(
      eq(accessGovernanceHistory.organizationId, organizationId), eq(accessGovernanceHistory.entityId, id),
      eq(accessGovernanceHistory.eventType, "user-group.owner.transferred"),
    ));
    assert.equal(events.length, 1);
    expectStatus(await request(`/user-groups/${id}`, actor, { status: "retired", expectedVersion: 2 }, "PATCH"));
    expectStatus(await transfer(id, former, actor, 3), 409);
  } finally { await cleanup(otherTenant); }
});

test("revocation or owner-role loss while waiting for the fence blocks transfer", { skip: !hasDb }, async () => {
  for (const mode of ["actor-revoked", "target-revoked", "target-demoted"]) {
    const racingActor = `${suffix}-${mode}-actor`;
    const racingTarget = `${suffix}-${mode}-target`;
    await db.insert(organizationMembershipsTable).values([
      { organizationId, clerkUserId: racingActor, role: "owner" },
      { organizationId, clerkUserId: racingTarget, role: "owner" },
    ]);
    const id = await createGroup(`Racing transfer ${mode}`);
    let release!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const mutation = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      locked();
      await released;
      await tx.update(organizationMembershipsTable).set(mode === "target-demoted" ? { role: "admin" } : { revokedAt: new Date() }).where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, mode === "actor-revoked" ? racingActor : racingTarget),
      ));
    });
    await lockReady;
    const attempt = transfer(id, racingTarget, racingActor, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await mutation;
    expectStatus(await attempt, mode === "actor-revoked" ? 403 : 400);
    const [unchanged] = await db.select().from(accessUserGroups).where(groupWhere(id));
    assert.equal(unchanged.ownerUserId, former);
    assert.equal(unchanged.version, 1);
  }
});
