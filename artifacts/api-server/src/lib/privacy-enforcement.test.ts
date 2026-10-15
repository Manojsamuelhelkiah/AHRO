import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pool, organizationsTable, organizationMembershipsTable, accessNamedGrants,
  onbSettings, onbSensitiveLifecycleDeletionJobs } from "@workspace/db";
import { defaultPrivacyEnforcementMode, PRIVACY_ENFORCEMENT_KEY, getPrivacyEnforcement,
  savePrivacyEnforcement, privacyRequirementsDeferredInTransaction } from "./privacy-enforcement";
import { evaluateCaseDerivedLifecycleGateInTransaction, evaluateSensitiveLifecycleGate,
  sensitiveLifecycleDestructionHeld, runSensitiveLifecycleDeletionWorker } from "./onboarding/sensitive-lifecycle";
import { pruneContextOrganization } from "./hro-context/retention";

test("privacy deferral preserves authority, scope, revisions, unapproved state and queued data", async () => {
  const schema = (await db.execute((await import("drizzle-orm")).sql`select current_schema() as s`)).rows[0] as { s: string };
  assert.match(schema.s, /^workspace_regression_/);
  const org = `privacy-phase-${randomUUID()}`, other = `privacy-other-${randomUUID()}`;
  const owner = "privacy-phase-owner", member = "privacy-phase-reader";
  const originalDefault = process.env.HRO_PRIVACY_ENFORCEMENT_DEFAULT;
  try {
    for (const nodeEnv of ["development", "production"]) {
      // Product default has no NODE_ENV branch.
      assert.equal(defaultPrivacyEnforcementMode({ NODE_ENV: nodeEnv }), "deferred", nodeEnv);
    }
    process.env.HRO_PRIVACY_ENFORCEMENT_DEFAULT = "active";
    await db.insert(organizationsTable).values([org, other].map(id => ({
      id, slug: id, name: "Privacy phase fixture", joinCodeHash: `unused-${id}`, createdByUserId: owner,
    })));
    await db.insert(organizationMembershipsTable).values([
      { organizationId: org, clerkUserId: owner, role: "owner" },
      { organizationId: org, clerkUserId: member, role: "member" },
    ]);
    await db.insert(accessNamedGrants).values({
      organizationId: org, principalType: "human", principalId: owner, scope: "tenant",
      resourceType: "tool", resourceKey: "tool.policy.manage", source: "named", effect: "allow",
      status: "active", createdByUserId: owner, approvedByUserId: owner, approvedAt: new Date(),
    });
    const initial = await getPrivacyEnforcement(org, owner);
    assert.equal(initial.mode, "active");
    assert.equal(initial.canManage, true);
    assert.equal((await getPrivacyEnforcement(org, member)).canManage, false);
    await assert.rejects(savePrivacyEnforcement(org, member, { expectedRevision: 1, mode: "deferred" }), /administrator/);
    await assert.rejects(getPrivacyEnforcement(other, owner), /membership/);
    await assert.rejects(savePrivacyEnforcement(org, owner, { expectedRevision: 1.5, mode: "deferred" }), /current revision/);
    assert.equal((await evaluateSensitiveLifecycleGate({ organizationId: org, jurisdiction: "US", dataClass: "identity", disclosure: true, providerId: "gmail" })).allowed, false);
    const deferred = await savePrivacyEnforcement(org, owner, { expectedRevision: 1, mode: "deferred" });
    assert.equal(deferred.revision, 2);
    const caseGate = await db.transaction(tx => evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: null }));
    assert.equal(caseGate.allowed, true);
    assert.deepEqual(caseGate.policies, {}, "no fabricated policy approvals");
    const disclosure = await evaluateSensitiveLifecycleGate({ organizationId: org, jurisdiction: null, dataClass: "medical", disclosure: true, providerId: "gmail" });
    assert.equal(disclosure.allowed, true);
    assert.equal(disclosure.policy, undefined);
    assert.equal(await sensitiveLifecycleDestructionHeld(org, "identity"), true);
    assert.equal((await evaluateSensitiveLifecycleGate({ organizationId: org, jurisdiction: "US", dataClass: "identity", disclosure: false, collection: false })).allowed, false);
    const [job] = await db.insert(onbSensitiveLifecycleDeletionJobs).values({
      organizationId: org, dataClass: "identity", recordKind: "communication",
      recordId: "private-existing-fixture", policyId: 123, policyRevision: 1,
    }).returning();
    await runSensitiveLifecycleDeletionWorker({ organizationId: org });
    const [retained] = await db.select().from(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
    assert.equal(retained.status, "queued");
    assert.equal(retained.attempts, 0);
    assert.equal((await pruneContextOrganization(org)).outcome, "paused");
    await assert.rejects(savePrivacyEnforcement(org, owner, { expectedRevision: 1, mode: "active" }), /changed/);
    await savePrivacyEnforcement(org, owner, { expectedRevision: 2, mode: "active" });
    assert.equal((await evaluateSensitiveLifecycleGate({ organizationId: org, jurisdiction: "US", dataClass: "identity", disclosure: true, providerId: "gmail" })).allowed, false,
      "activation does not approve previously missing policies");
    assert.equal(await db.transaction(tx => privacyRequirementsDeferredInTransaction(tx, other)), false,
      "client changes do not change another tenant's configuration");
    await db.update(onbSettings).set({ value: "malformed" }).where(and(eq(onbSettings.organizationId, org), eq(onbSettings.key, PRIVACY_ENFORCEMENT_KEY)));
    await assert.rejects(getPrivacyEnforcement(org, owner), /configuration is invalid/);
  } finally {
    if (originalDefault === undefined) delete process.env.HRO_PRIVACY_ENFORCEMENT_DEFAULT;
    else process.env.HRO_PRIVACY_ENFORCEMENT_DEFAULT = originalDefault;
    await pool.end();
  }
});
