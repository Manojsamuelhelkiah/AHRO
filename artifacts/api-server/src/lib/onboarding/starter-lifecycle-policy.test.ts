import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
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
  assert.throws(() => canonicalStarterCountry("EU"));
  assert.throws(() => canonicalStarterCountry("XA"));
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
      primaryCountry: "GB",
      joinCodeHash: `hash-${organizationId}`,
      createdByUserId: actor,
    },
    {
      id: otherOrganizationId,
      name: "Other starter policy test",
      slug: otherOrganizationId,
      primaryCountry: "US",
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
    assert.equal(initial.country, "GB");
    assert.equal(initial.version, 0);
    assert.equal(initial.proposals.length, SENSITIVE_DATA_CLASSES.length);
    await db.update(organizationsTable)
      .set({ primaryCountry: "US" })
      .where(eq(organizationsTable.id, organizationId));
    const changedUnsavedDefault = await getStarterSensitiveLifecyclePolicy({ organizationId, actorUserId: actor });
    assert.equal(changedUnsavedDefault.country, "US", "unsaved proposals must follow the current organization country");
    await db.update(organizationsTable)
      .set({ primaryCountry: "GB" })
      .where(eq(organizationsTable.id, organizationId));

    const proposals = initial.proposals.map((proposal, index) =>
      index === 0 ? { ...proposal, purpose: "Reviewed internally; legal review still required." } : proposal,
    );
    const saved = await saveStarterSensitiveLifecyclePolicy({
      organizationId,
      actorUserId: actor,
      policy: { country: "GB", expectedVersion: 0, proposals },
    });
    assert.equal(saved.country, "GB");
    assert.equal(saved.version, 1);
    assert.equal(saved.proposals[0]?.purpose, "Reviewed internally; legal review still required.");

    const reloaded = await getStarterSensitiveLifecyclePolicy({ organizationId, actorUserId: actor });
    assert.equal(reloaded.version, 1);
    assert.equal(reloaded.proposals[0]?.purpose, "Reviewed internally; legal review still required.");
    await assert.rejects(
      () => saveStarterSensitiveLifecyclePolicy({
        organizationId,
        actorUserId: actor,
        policy: { country: "GB", expectedVersion: 0, proposals },
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

    await db.update(organizationsTable)
      .set({ primaryCountry: "US" })
      .where(eq(organizationsTable.id, organizationId));
    const afterOrganizationCountryChange = await getStarterSensitiveLifecyclePolicy({
      organizationId,
      actorUserId: actor,
    });
    assert.equal(afterOrganizationCountryChange.country, "GB", "saved proposals must not follow later organization changes");
    assert.equal(afterOrganizationCountryChange.proposals[0]?.purpose, "Reviewed internally; legal review still required.");
  } finally {
    await db.delete(onbSettings).where(eq(onbSettings.organizationId, organizationId));
    await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
    await db.delete(organizationMembershipsTable).where(inArray(
      organizationMembershipsTable.clerkUserId,
      [actor, otherActor],
    ));
    await deleteTestOrganizations(inArray(organizationsTable.id, [organizationId, otherOrganizationId]));
  }
});

test("starter policy reads and writes are tenant-fenced", async () => {
  const liveOrg = `starter-live-${randomUUID()}`;
  const liveOtherOrg = `starter-live-other-${randomUUID()}`;
  const liveActor = `starter-live-actor-${randomUUID()}`;
  await db.insert(organizationsTable).values([
    { id: liveOrg, name: "Live starter tenant", slug: liveOrg, joinCodeHash: `hash-${liveOrg}`, createdByUserId: liveActor },
    { id: liveOtherOrg, name: "Other live starter tenant", slug: liveOtherOrg, joinCodeHash: `hash-${liveOtherOrg}`, createdByUserId: "other" },
  ]);
  await db.insert(organizationMembershipsTable).values({ organizationId: liveOrg, clerkUserId: liveActor, role: "member" });
  try {
    await assert.rejects(
      () => getStarterSensitiveLifecyclePolicy({
        organizationId: liveOtherOrg,
        actorUserId: liveActor,
      }),
      SensitiveLifecyclePermissionError,
    );
  } finally {
    await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, liveOrg));
    await deleteTestOrganizations(inArray(organizationsTable.id, [liveOrg, liveOtherOrg]));
  }
});