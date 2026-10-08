import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbGovernanceAuthorityAssignments,
  onbHrPolicyReminders,
  onbHrPolicySources,
  onbHrPolicyVersions,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { HrPolicyError, listPolicyReminders, revisePolicy } from "./hr-policy-library";

const suffix = `${process.pid}-${randomUUID()}`;
const organizationId = `policy-reminders-${suffix}`;
const otherOrganizationId = `policy-reminders-other-${suffix}`;
const userId = `policy-reminders-user-${suffix}`;
const fixedNow = new Date("2026-03-10T19:45:00.000Z");

async function insertPublishedPolicy(
  targetOrganizationId: string,
  overrides: {
    policyId?: string;
    title?: string;
    audience?: Array<"owner" | "admin" | "member">;
    reviewBy?: string | null;
    effectiveUntil?: string | null;
    status?: "published" | "superseded" | "retired";
  } = {},
) {
  const policyId = overrides.policyId ?? randomUUID();
  await db.insert(onbHrPolicySources).values({
    organizationId: targetOrganizationId,
    policyId,
    createdByUserId: userId,
  });
  await db.insert(onbHrPolicyVersions).values({
    organizationId: targetOrganizationId,
    policyId,
    version: 1,
    title: overrides.title ?? `Reminder ${policyId}`,
    sourceReference: "reminder-test",
    text: "Reminder test source.",
    audience: overrides.audience ?? ["owner"],
    applicability: {},
    effectiveFrom: "2020-01-01",
    effectiveUntil: overrides.effectiveUntil ?? null,
    reviewBy: overrides.reviewBy ?? null,
    reviewAuthorityRole: "hr-compliance",
    status: overrides.status ?? "published",
    createdByUserId: userId,
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  return policyId;
}

async function expectForbidden(action: () => Promise<unknown>) {
  await assert.rejects(action, (error: unknown) =>
    error instanceof HrPolicyError && error.statusCode === 403,
  );
}

before(async () => {
  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: "Policy reminders",
      slug: organizationId,
      joinCodeHash: `hash-${organizationId}`,
      createdByUserId: userId,
    },
    {
      id: otherOrganizationId,
      name: "Other policy reminders",
      slug: otherOrganizationId,
      joinCodeHash: `hash-${otherOrganizationId}`,
      createdByUserId: userId,
    },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId, clerkUserId: userId, role: "owner" },
    { organizationId: otherOrganizationId, clerkUserId: userId, role: "owner" },
  ]);
  await db.insert(onbGovernanceAuthorityAssignments).values([
    {
      organizationId,
      authorityRole: "hr-policy-maintain",
      assigneeUserId: userId,
      verifiedByUserId: "operator",
      verificationReference: "reminders-test",
    },
    {
      organizationId: otherOrganizationId,
      authorityRole: "hr-policy-maintain",
      assigneeUserId: userId,
      verifiedByUserId: "operator",
      verificationReference: "reminders-test",
    },
  ]);
});

after(async () => {
  await db.delete(onbHrPolicyReminders).where(inArray(onbHrPolicyReminders.organizationId, [
    organizationId, otherOrganizationId,
  ]));
  await db.delete(onbHrPolicyVersions).where(inArray(onbHrPolicyVersions.organizationId, [
    organizationId, otherOrganizationId,
  ]));
  await db.delete(onbHrPolicySources).where(inArray(onbHrPolicySources.organizationId, [
    organizationId, otherOrganizationId,
  ]));
  await db.delete(onbGovernanceAuthorityAssignments).where(inArray(onbGovernanceAuthorityAssignments.organizationId, [
    organizationId, otherOrganizationId,
  ]));
  await db.delete(organizationMembershipsTable).where(inArray(organizationMembershipsTable.organizationId, [
    organizationId, otherOrganizationId,
  ]));
  await deleteTestOrganizations(inArray(organizationsTable.id, [
    organizationId, otherOrganizationId,
  ]));
});

test("generates both date kinds, includes overdue, and includes the 30-day boundary only", { concurrency: false }, async () => {
  const boundaryId = await insertPublishedPolicy(organizationId, {
    title: "Boundary policy",
    reviewBy: "2026-04-09",
    effectiveUntil: "2026-03-09",
  });
  const outsideId = await insertPublishedPolicy(organizationId, {
    title: "Outside horizon",
    reviewBy: "2026-04-10",
    effectiveUntil: "2026-04-10",
  });
  const reminders = await listPolicyReminders(organizationId, userId, fixedNow);

  assert.deepEqual(
    reminders.filter((row) => row.policyId === boundaryId).map(({ kind, dueOn, daysRemaining }) => ({
      kind, dueOn, daysRemaining,
    })),
    [
      { kind: "effective_end", dueOn: "2026-03-09", daysRemaining: -1 },
      { kind: "review_due", dueOn: "2026-04-09", daysRemaining: 30 },
    ],
  );
  assert.equal(reminders.some((row) => row.policyId === outsideId), false);
  assert.equal(reminders.every((row) => row.createdAt.endsWith("Z")), true);
});

test("deduplicates concurrent authenticated reads at the database unique key", { concurrency: false }, async () => {
  const policyId = await insertPublishedPolicy(organizationId, {
    reviewBy: "2026-03-11",
    effectiveUntil: "2026-03-12",
  });
  const [first, second] = await Promise.all([
    listPolicyReminders(organizationId, userId, fixedNow),
    listPolicyReminders(organizationId, userId, fixedNow),
  ]);
  assert.equal(first.filter((row) => row.policyId === policyId).length, 2);
  assert.equal(second.filter((row) => row.policyId === policyId).length, 2);
  const durableRows = await db.select().from(onbHrPolicyReminders).where(and(
    eq(onbHrPolicyReminders.organizationId, organizationId),
    eq(onbHrPolicyReminders.policyId, policyId),
  ));
  assert.equal(durableRows.length, 2);
});

test("enforces tenant scope, live membership, active maintenance authority, and each version audience", { concurrency: false }, async () => {
  const visibleId = await insertPublishedPolicy(organizationId, {
    audience: ["owner"],
    reviewBy: "2026-03-11",
  });
  const audienceDeniedId = await insertPublishedPolicy(organizationId, {
    audience: ["admin"],
    reviewBy: "2026-03-11",
  });
  const otherTenantId = await insertPublishedPolicy(otherOrganizationId, {
    reviewBy: "2026-03-11",
  });
  const reminders = await listPolicyReminders(organizationId, userId, fixedNow);
  assert.equal(reminders.some((row) => row.policyId === visibleId), true);
  assert.equal(reminders.some((row) => row.policyId === audienceDeniedId), false);
  assert.equal(reminders.some((row) => row.policyId === otherTenantId), false);

  await db.update(onbGovernanceAuthorityAssignments).set({ revokedAt: new Date() }).where(and(
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    eq(onbGovernanceAuthorityAssignments.assigneeUserId, userId),
    eq(onbGovernanceAuthorityAssignments.authorityRole, "hr-policy-maintain"),
  ));
  await expectForbidden(() => listPolicyReminders(organizationId, userId, fixedNow));
  await db.update(onbGovernanceAuthorityAssignments).set({ revokedAt: null }).where(and(
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    eq(onbGovernanceAuthorityAssignments.assigneeUserId, userId),
    eq(onbGovernanceAuthorityAssignments.authorityRole, "hr-policy-maintain"),
  ));

  await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, userId),
  ));
  await expectForbidden(() => listPolicyReminders(organizationId, userId, fixedNow));
  await db.update(organizationMembershipsTable).set({ revokedAt: null }).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, userId),
  ));
});

test("hides durable rows after a version is superseded or retired", { concurrency: false }, async () => {
  const supersededId = await insertPublishedPolicy(organizationId, {
    reviewBy: "2026-03-11",
  });
  const retiredId = await insertPublishedPolicy(organizationId, {
    reviewBy: "2026-03-11",
  });
  assert.equal((await listPolicyReminders(organizationId, userId, fixedNow))
    .filter((row) => [supersededId, retiredId].includes(row.policyId)).length, 2);

  await db.update(onbHrPolicyVersions).set({ status: "superseded" }).where(and(
    eq(onbHrPolicyVersions.organizationId, organizationId),
    eq(onbHrPolicyVersions.policyId, supersededId),
  ));
  await db.update(onbHrPolicyVersions).set({ status: "retired" }).where(and(
    eq(onbHrPolicyVersions.organizationId, organizationId),
    eq(onbHrPolicyVersions.policyId, retiredId),
  ));
  const current = await listPolicyReminders(organizationId, userId, fixedNow);
  assert.equal(current.some((row) => row.policyId === supersededId), false);
  assert.equal(current.some((row) => row.policyId === retiredId), false);
});

test("does not deadlock a reminder read against membership-first draft revision", { concurrency: false }, async () => {
  const policyId = await insertPublishedPolicy(organizationId, {
    reviewBy: "2026-03-11",
  });
  // The read and revise paths intentionally acquire their locks in different
  // lifecycle orders. They must still complete because the three reminder
  // phases never hold version and authority locks together.
  const read = listPolicyReminders(organizationId, userId, fixedNow);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const lifecycle = revisePolicy(organizationId, userId, policyId, {
    expectedVersion: 1,
    title: "Successor reminder policy",
    sourceReference: "reminder-successor",
    text: "Successor reminder source.",
    audience: ["owner"],
    applicability: {},
    reviewAuthorityRole: "hr-compliance",
    effectiveFrom: "2020-01-01",
    reviewBy: "2026-03-12",
  });
  const [reminders, successor] = await Promise.all([read, lifecycle]);

  assert.equal(successor.version, 2);
  assert.ok(Array.isArray(reminders));
  assert.equal((await listPolicyReminders(organizationId, userId, fixedNow))
    .some((row) => row.policyId === policyId), true);
});