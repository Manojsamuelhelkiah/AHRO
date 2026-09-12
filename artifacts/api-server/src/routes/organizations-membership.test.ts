import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  onbAuditEntries,
  onbAuthorityAssignments,
  onbGovernanceDispatchMarkers,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import organizationsRouter from "./organizations";
import { errorHandler } from "../middlewares/error-handler";
import { lookupMembership } from "../middlewares/tenant-context";
import { verifiedAuditAuthority } from "../lib/onboarding/protected-audit";

const suffix = `${process.pid}-${Date.now()}`;
const organizationId = `membership-lifecycle-${suffix}`;
const ownerUserId = `membership-owner-${suffix}`;
const adminUserId = `membership-admin-${suffix}`;
const targetUserId = `membership-target-${suffix}`;
const joinCode = `JOIN-${suffix}`;
let server: Server;
let baseUrl: string;

function hashJoinCode(value: string): string {
  return createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
}

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Membership lifecycle test",
    slug: organizationId,
    joinCodeHash: hashJoinCode(joinCode),
    createdByUserId: ownerUserId,
  });
  await db.insert(organizationMembershipsTable).values([
    { organizationId, clerkUserId: ownerUserId, role: "owner" },
    { organizationId, clerkUserId: adminUserId, role: "admin" },
    { organizationId, clerkUserId: targetUserId, role: "member" },
  ]);
  await db.insert(onbAuthorityAssignments).values({
    id: `specialist-${suffix}`,
    organizationId,
    personUserId: targetUserId,
    authorityRole: "hr-compliance",
    scopes: ["hr-compliance-approve"],
    validFrom: new Date(),
    status: "active",
    revision: 1,
    grantorUserId: ownerUserId,
    source: "test",
    governanceDecisionRef: "test-membership-removal",
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = req.header("x-test-user") ?? undefined;
    next();
  });
  app.use(organizationsRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await db.delete(organizationMembershipsTable)
    .where(eq(organizationMembershipsTable.organizationId, organizationId));
  await db.delete(onbAuthorityAssignments)
    .where(eq(onbAuthorityAssignments.organizationId, organizationId));
  await db.delete(onbGovernanceDispatchMarkers)
    .where(eq(onbGovernanceDispatchMarkers.organizationId, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
});

function request(
  path: string,
  userId: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-test-user", userId);
  if (path !== "/organizations/current") headers.set("x-organization-id", organizationId);
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

test("member administration enforces owner-only CAS mutations and active listing", { concurrency: false }, async () => {
  const adminList = await request("/organizations/members", adminUserId);
  assert.equal(adminList.status, 200);
  assert.deepEqual(
    (await adminList.json() as Array<{ clerkUserId: string }>)
      .map((row) => row.clerkUserId)
      .sort(),
    [ownerUserId, adminUserId, targetUserId].sort(),
  );

  const adminAttempt = await request(`/organizations/members/${targetUserId}`, adminUserId, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRole: "member", role: "admin" }),
  });
  assert.equal(adminAttempt.status, 403);

  const stale = await request(`/organizations/members/${targetUserId}`, ownerUserId, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRole: "admin", role: "member" }),
  });
  assert.equal(stale.status, 409);

  const changed = await request(`/organizations/members/${targetUserId}`, ownerUserId, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRole: "member", role: "admin" }),
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json() as { role: string }).role, "admin");

  const selfChange = await request(`/organizations/members/${ownerUserId}`, ownerUserId, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRole: "owner", role: "member" }),
  });
  assert.equal(selfChange.status, 409);
});

test("removal tombstones membership, revokes access, and blocks join-code resurrection", { concurrency: false }, async () => {
  const [marker] = await db.insert(onbGovernanceDispatchMarkers).values({
    organizationId,
    dispatchId: `membership-dispatch-${suffix}`,
    operation: "test-removal-ordering",
    status: "dispatching",
    claimOwner: ownerUserId,
    fence: {},
  }).returning();
  assert.ok(marker);
  const blockedRemoval = await request(`/organizations/members/${targetUserId}`, ownerUserId, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRole: "admin" }),
  });
  assert.equal(blockedRemoval.status, 409);
  assert.equal((await blockedRemoval.json() as { code: string }).code, "GOVERNANCE_DISPATCH_IN_FLIGHT");
  assert.equal(await verifiedAuditAuthority(organizationId, targetUserId), "admin");
  await db.delete(onbGovernanceDispatchMarkers)
    .where(eq(onbGovernanceDispatchMarkers.id, marker.id));

  const removed = await request(`/organizations/members/${targetUserId}`, ownerUserId, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRole: "admin" }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as { revokedAt?: string }).revokedAt !== undefined, true);

  const removedList = await request("/organizations/members", targetUserId);
  assert.equal(removedList.status, 403);
  assert.deepEqual(await lookupMembership(targetUserId, organizationId), null);

  const join = await request("/organizations/join", targetUserId, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ joinCode }),
  });
  assert.equal(join.status, 403);
  assert.equal((await join.json() as { code: string }).code, "ORGANIZATION_MEMBERSHIP_REVOKED");

  const ownerRemoval = await request(`/organizations/members/${ownerUserId}`, ownerUserId, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRole: "owner" }),
  });
  assert.equal(ownerRemoval.status, 409);

  const activeRows = await db.select({
    clerkUserId: organizationMembershipsTable.clerkUserId,
    revokedAt: organizationMembershipsTable.revokedAt,
  }).from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, targetUserId),
  ));
  assert.equal(activeRows.length, 1);
  assert.ok(activeRows[0]?.revokedAt);
  assert.equal(await verifiedAuditAuthority(organizationId, targetUserId), null);
  const [authority] = await db.select({
    status: onbAuthorityAssignments.status,
    revokedByUserId: onbAuthorityAssignments.revokedByUserId,
  }).from(onbAuthorityAssignments).where(and(
    eq(onbAuthorityAssignments.organizationId, organizationId),
    eq(onbAuthorityAssignments.personUserId, targetUserId),
  ));
  assert.deepEqual(authority, {
    status: "revoked",
    revokedByUserId: ownerUserId,
  });

  const audit = await db.select({ action: onbAuditEntries.action })
    .from(onbAuditEntries)
    .where(eq(onbAuditEntries.organizationId, organizationId));
  assert.ok(audit.some(({ action }) => action === "organization.membership.role-changed"));
  assert.ok(audit.some(({ action }) => action === "organization.membership.revoked"));
});