import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbSettings,
  onbSensitiveLifecyclePolicies,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import {
  SENSITIVE_DATA_CLASSES,
  SensitiveLifecycleConflictError,
  SensitiveLifecyclePermissionError,
} from "./sensitive-lifecycle";
import {
  canonicalStarterCountry,
  getStarterSensitiveLifecyclePolicy,
  saveStarterSensitiveLifecyclePolicy,
  starterPolicyDefaults,
} from "./starter-lifecycle-policy";

const organizationId = `starter-policy-${randomUUID()}`;
const otherOrganizationId = `starter-policy-other-${randomUUID()}`;
const actor = `starter-policy-member-${randomUUID()}`;
const otherActor = `starter-policy-other-member-${randomUUID()}`;

test("starter policy defaults are complete, conservative, and canonical", () => {
  assert.equal(canonicalStarterCountry("India"), "IN");
  assert.equal(canonicalStarterCountry("IN"), "IN");
  const starter = starterPolicyDefaults("IN");
  assert.equal(starter.version, 0);
  assert.equal(starter.inactive, true);
  assert.equal(starter.reviewRequired, true);
  assert.deepEqual(starter.proposals.map((proposal) => proposal.dataClass), [...SENSITIVE_DATA_CLASSES]);
  assert.ok(starter.proposals.every((proposal) =>
    proposal.jurisdiction === "IN" &&
    proposal.providerSharingApproved === false &&
    proposal.permittedProviders.length === 0 &&
    /review required/i.test(proposal.policyReference) &&
    /review required|no legal approval/i.test(proposal.approvalReference),
  ));
});

test("starter policy persists with optimistic versioning and never inserts approved rows", async () => {
  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: "Starter policy test",
      slug: organizationId,
      joinCodeHash: `hash-${organizationId}`,
      createdByUserId: actor,
    },
    {
      id: otherOrganizationId,
      name: "Other starter policy test",
      slug: otherOrganizationId,
      joinCodeHash: `hash-${otherOrganizationId}`,
      createdByUserId: otherActor,
    },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId, clerkUserId: actor, role: "member" },
    { organizationId: otherOrganizationId, clerkUserId: otherActor, role: "member" },
  ]);

  try {
    const initial = await getStarterSensitiveLifecyclePolicy({
      organizationId,
      actorUserId: actor,
    });
    assert.equal(initial.country, "IN");
    assert.equal(initial.version, 0);
    assert.equal(initial.proposals.length, SENSITIVE_DATA_CLASSES.length);

    const proposals = initial.proposals.map((proposal, index) =>
      index === 0 ? { ...proposal, purpose: "Reviewed internally; legal review still required." } : proposal,
    );
    const saved = await saveStarterSensitiveLifecyclePolicy({
      organizationId,
      actorUserId: actor,
      policy: { country: "India", expectedVersion: 0, proposals },
    });
    assert.equal(saved.country, "IN");
    assert.equal(saved.version, 1);
    assert.equal(saved.proposals[0]?.purpose, "Reviewed internally; legal review still required.");

    const reloaded = await getStarterSensitiveLifecyclePolicy({ organizationId, actorUserId: actor });
    assert.equal(reloaded.version, 1);
    assert.equal(reloaded.proposals[0]?.purpose, "Reviewed internally; legal review still required.");
    await assert.rejects(
      () => saveStarterSensitiveLifecyclePolicy({
        organizationId,
        actorUserId: actor,
        policy: { country: "IN", expectedVersion: 0, proposals },
      }),
      SensitiveLifecycleConflictError,
    );

    const approvedRows = await db.select({ id: onbSensitiveLifecyclePolicies.id })
      .from(onbSensitiveLifecyclePolicies)
      .where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
    assert.equal(approvedRows.length, 0, "starter save must not create an approved policy row");
    const settingsRows = await db.select({ key: onbSettings.key })
      .from(onbSettings)
      .where(and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, "privacy:lifecycle:starter-policy"),
      ));
    assert.equal(settingsRows.length, 1);
  } finally {
    await db.delete(onbSettings).where(eq(onbSettings.organizationId, organizationId));
    await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
    await db.delete(organizationMembershipsTable).where(inArray(
      organizationMembershipsTable.clerkUserId,
      [actor, otherActor],
    ));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, [organizationId, otherOrganizationId]));
  }
});

test("starter policy reads and writes are tenant-fenced", async () => {
  await assert.rejects(
    () => getStarterSensitiveLifecyclePolicy({
      organizationId: otherOrganizationId,
      actorUserId: actor,
    }),
    SensitiveLifecyclePermissionError,
  );
});