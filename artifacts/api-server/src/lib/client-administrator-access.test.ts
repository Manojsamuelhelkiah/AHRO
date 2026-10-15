import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, organizationsTable, organizationMembershipsTable, onbCases, onbSettings,
  accessAgents, accessNamedGrants } from "@workspace/db";
import { ACCESS_GOVERNANCE_CATALOG, resolveEffectiveAccess, resolveEffectiveAccessForCases } from "./access-governance";
import { demoPrincipalSettingKey } from "./demo-principal";
import { hasHumanPermissions } from "./human-permissions";

test("client administration is live, tenant-bound, human-only and consistent for case batches", async () => {
  const schema = (await db.execute(sql`select current_schema() as s`)).rows[0] as { s: string };
  assert.match(schema.s, /^workspace_regression_/);
  const org = `admin-${randomUUID()}`, other = `${org}-other`;
  const admin = `${org}-admin`, owner = `${org}-owner`, member = `${org}-member`, shared = `${org}-shared`;
  const agent = `${org}-agent`;
  const keys = [...ACCESS_GOVERNANCE_CATALOG.fields, ...ACCESS_GOVERNANCE_CATALOG.flows, ...ACCESS_GOVERNANCE_CATALOG.tools];
  const effective = (actor: string, organizationId = org, caseId?: number) =>
    resolveEffectiveAccess({ organizationId, principalType: "human", principalId: actor, caseId });
  try {
    for (const id of [org, other, "demo"]) await db.insert(organizationsTable).values({
      id, slug: id, name: id, joinCodeHash: `unused-${id}`, createdByUserId: owner,
    }).onConflictDoNothing();
    await db.insert(organizationMembershipsTable).values([
      { organizationId: org, clerkUserId: admin, role: "admin" },
      { organizationId: org, clerkUserId: owner, role: "owner" },
      { organizationId: org, clerkUserId: member, role: "member" },
      // Even a stale accidentally elevated public Demo row cannot confer this exception.
      { organizationId: org, clerkUserId: shared, role: "admin" },
    ]);
    await db.insert(onbSettings).values({ organizationId: "demo", key: demoPrincipalSettingKey(shared), value: "administrator" });
    const createCase = async (organizationId: string) => (await db.insert(onbCases).values({
      organizationId, workerName: "Fictional access fixture", workerEmail: "fixture@example.invalid",
      hireType: "service-request", workerCategory: "employee", role: "Fixture", department: "Fixture",
      geography: "US", legalEntity: "Fixture", managerName: "Fixture", recruiterName: "Fixture",
      joiningDate: "2030-01-01",
    }).returning({ id: onbCases.id }))[0].id;
    const caseId = await createCase(org), foreignCaseId = await createCase(other);
    assert.deepEqual((await effective(admin)).allows.sort(), [...keys].sort());
    assert.deepEqual((await effective(owner, org, caseId)).allows.sort(), [...keys].sort());
    assert.deepEqual((await effective(member)).allows, []);
    assert.deepEqual((await effective(shared)).allows, []);
    assert.deepEqual((await effective(admin, other)).allows, [], "client admin is not a platform admin");
    assert.deepEqual((await effective(admin, org, foreignCaseId)).allows, [], "foreign case scope remains denied");
    assert.deepEqual((await effective(admin, org, caseId + 100000)).allows, [], "missing case is not authorized");
    const batch = await resolveEffectiveAccessForCases({ organizationId: org, principalType: "human", principalId: admin }, [caseId, foreignCaseId]);
    assert.deepEqual(batch.get(caseId)?.allows.sort(), [...keys].sort());
    assert.deepEqual(batch.get(foreignCaseId)?.allows, []);
    assert.equal(await db.transaction(tx => hasHumanPermissions(tx, {
      organizationId: org, actorUserId: admin, caseId,
      requiredKeys: ["flow.case.edit", "data.case.profile.edit", "tool.notification.send", "tool.external.dispatch"],
    })), true, "named admin satisfies the existing offboarding prerequisites");

    await db.insert(accessAgents).values({ organizationId: org, id: agent, name: "Fixture agent",
      ownerUserId: admin, createdByUserId: admin });
    const agentAccess = () => resolveEffectiveAccess({ organizationId: org, principalType: "agent", principalId: agent,
      initiatorUserId: admin, caseId });
    assert.deepEqual((await agentAccess()).allows, [], "agent cannot inherit its owner's admin permissions");
    await db.insert(accessNamedGrants).values(["flow.case.read", "tool.approval.decide"].map(resourceKey => ({
      organizationId: org, principalType: "agent" as const, principalId: agent, scope: "tenant" as const,
      resourceType: resourceKey.startsWith("flow.") ? "flow" as const : "tool" as const, resourceKey,
      source: "named" as const, effect: "allow" as const, status: "active" as const,
      createdByUserId: "fixture-grantor", approvedByUserId: "fixture-independent-approver", approvedAt: new Date(),
    })));
    assert.deepEqual((await agentAccess()).allows, ["flow.case.read"], "explicit delegation intersects the admin initiator; approval remains human-only");

    await db.update(organizationMembershipsTable).set({ role: "member" }).where(and(
      eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, admin),
    ));
    assert.deepEqual((await effective(admin)).allows, [], "role downgrade removes administrative rights immediately");
    assert.deepEqual((await agentAccess()).allows, [], "downgrade also removes the agent's initiator intersection");
    await db.update(organizationMembershipsTable).set({ role: "admin", revokedAt: new Date() }).where(and(
      eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, admin),
    ));
    assert.deepEqual((await effective(admin)).allows, [], "revoked admin membership cannot authorize access");
    const revokedBatch = await resolveEffectiveAccessForCases({ organizationId: org, principalType: "human", principalId: admin }, [caseId]);
    assert.deepEqual(revokedBatch.get(caseId)?.allows, []);
  } finally {
    await pool.end();
  }
});
