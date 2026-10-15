import assert from "node:assert/strict";
import { before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { db, onbCases, organizationMembershipsTable, organizationsTable, onbSettings, caseListVisibility,
  caseListVisibilityChanges, onbEvents, onbCommunications, onbActionCenterActions } from "@workspace/db";
import { requireOwnedOrganizationTestSchema } from "../../test-support/organization-fixtures";
import { caseListVisibilityProjection, updateCaseListVisibility, CaseListVisibilityError } from "./case-list-visibility";
import { demoPrincipalSettingKey } from "../demo-principal";
import { executeSyntheticReset, DEFAULT_SYNTHETIC_RESET_MANIFEST } from "./synthetic-reset";

const actor = "visibility-named-owner";
let cases: (typeof onbCases.$inferSelect)[];
before(async () => {
  await requireOwnedOrganizationTestSchema();
  await db.insert(organizationsTable).values(["demo", "visibility-other"].map(id => ({
    id, name: "Isolated visibility fixture", slug: id, joinCodeHash: id, createdByUserId: actor,
  }))).onConflictDoNothing();
  await db.insert(organizationMembershipsTable).values([
    { organizationId: "demo", clerkUserId: actor, role: "owner" },
    { organizationId: "demo", clerkUserId: "visibility-shared", role: "admin" },
    { organizationId: "visibility-other", clerkUserId: actor, role: "owner" },
  ]);
  await db.insert(onbSettings).values({
    organizationId: "demo", key: demoPrincipalSettingKey("visibility-shared"),
    value: "administrator",
  });
  const common = { organizationId: "demo", workerName: "Isolated case", workerEmail: "never-send@example.invalid",
    workerCategory: "employee", role: "Test", department: "Test", geography: "US",
    legalEntity: "Test", managerName: "Test", recruiterName: "Test", joiningDate: "2031-01-01",
    controllerRetired: true };
  cases = await db.insert(onbCases).values([
    { ...common, hireType: "employee" }, { ...common, hireType: "offboarding" },
    { ...common, hireType: "internal-transfer" },
    { ...common, organizationId: "visibility-other", hireType: "employee" },
    { ...common, hireType: "employee" },
  ]).returning();
  await db.insert(onbActionCenterActions).values({ organizationId: "demo", caseId: cases[0]!.id,
    kind: "assign", status: "open", actorUserId: actor, actorName: "Fixture", requestId: "visibility-fixture" });
});
const item = (index: number, expectedVersion = 0) => ({ caseId: cases[index]!.id, expectedVersion,
  caseFamily: index === 1 ? "Offboarding" : "Onboarding" });
const input = (selection: ReturnType<typeof item>[], hidden = true) => ({ hidden, confirmWorkingListOnly: true, selection });
async function reject(status: number, operation: Promise<unknown>) {
  await assert.rejects(operation, error => error instanceof CaseListVisibilityError && error.status === status);
}
test("uninitialized rollout/new cases stay visible; exact named authorization and entire batch validation", async () => {
  assert.equal((await caseListVisibilityProjection("demo", actor, cases.map(row => row.id))).byCase.size, 0);
  await reject(403, updateCaseListVisibility("demo", "visibility-shared", input([item(0)])));
  await reject(403, updateCaseListVisibility("demo", "unknown", input([item(0)])));
  await reject(403, updateCaseListVisibility("visibility-other", actor, input([item(3)])));
  await reject(403, updateCaseListVisibility("demo", actor, input([item(0), item(3)])));
  await reject(409, updateCaseListVisibility("demo", actor, input([item(0), item(2)])));
  await reject(400, updateCaseListVisibility("demo", actor, input([item(0), item(0)])));
  await reject(400, updateCaseListVisibility("demo", actor, input([{ ...item(0), expectedVersion: 0.5 }])));
  await reject(400, updateCaseListVisibility("demo", actor, { ...input([item(0)]), confirmWorkingListOnly: false }));
  assert.equal((await db.select().from(caseListVisibility)).length, 0);
  assert.equal((await db.select().from(caseListVisibilityChanges)).length, 0);
});
test("hide/restore is durable and shared; no case, evidence, effects, alerts, action eligibility or reporting source changes", async () => {
  const snapshot = async () => ({
    cases: await db.select().from(onbCases).orderBy(onbCases.id),
    events: await db.select().from(onbEvents), communications: await db.select().from(onbCommunications),
    actions: await db.select().from(onbActionCenterActions),
  });
  const before = await snapshot();
  assert.deepEqual(await updateCaseListVisibility("demo", actor, input([item(0), item(1)])), { updatedCount: 2 });
  const shared = await caseListVisibilityProjection("demo", "another-reader", [cases[0]!.id, cases[1]!.id, cases[4]!.id]);
  assert.equal(shared.byCase.get(cases[0]!.id)?.hidden, true);
  assert.equal(shared.byCase.get(cases[1]!.id)?.version, 1);
  assert.equal(shared.byCase.has(cases[4]!.id), false);
  assert.equal(shared.administrator, false);
  assert.equal((await caseListVisibilityProjection("visibility-other", actor, [cases[0]!.id])).byCase.size, 0);
  assert.equal((await caseListVisibilityProjection("demo", actor, [cases[4]!.id])).byCase.size, 0);
  await reject(409, updateCaseListVisibility("demo", actor, input([item(0)], false)));
  await updateCaseListVisibility("demo", actor, input([item(0, 1), item(1, 1)], false));
  assert.equal((await caseListVisibilityProjection("demo", actor, [cases[0]!.id])).byCase.get(cases[0]!.id)?.hidden, false);
  assert.deepEqual(await snapshot(), before);
  const audit = await db.select().from(caseListVisibilityChanges);
  assert.equal(audit.length, 4);
  assert.deepEqual(audit.map(row => row.version), [1, 1, 2, 2]);
});
test("downgrade and revocation remove administration, including previously selected rows", async () => {
  const membership = and(eq(organizationMembershipsTable.organizationId, "demo"), eq(organizationMembershipsTable.clerkUserId, actor));
  await db.update(organizationMembershipsTable).set({ role: "member" }).where(membership);
  await reject(403, updateCaseListVisibility("demo", actor, input([item(0, 2)])));
  await db.update(organizationMembershipsTable).set({ role: "owner", revokedAt: new Date() }).where(membership);
  await reject(403, updateCaseListVisibility("demo", actor, input([item(0, 2)])));
  await db.update(organizationMembershipsTable).set({ revokedAt: null }).where(membership);
});
test("concurrent administrators cannot overwrite a newer decision, including hide/restore ABA", async () => {
  const results = await Promise.allSettled([
    updateCaseListVisibility("demo", actor, input([item(0, 2)])),
    updateCaseListVisibility("demo", actor, input([item(0, 2), item(1, 2)])),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409);
  const state = (await caseListVisibilityProjection("demo", actor, [cases[0]!.id])).byCase.get(cases[0]!.id)!;
  await updateCaseListVisibility("demo", actor, input([item(0, state.version)], false));
  await reject(409, updateCaseListVisibility("demo", actor, input([item(0, 2)])));
  await db.execute(sql`select 1`);
});
test("retired reset stays unavailable; authorized case deletion can remove curated targets while keeping change history", async () => {
  const common = { organizationId: "demo", workerName: "Deletion compatibility fixture",
    workerEmail: "no-delivery@example.invalid", hireType: "employee", workerCategory: "employee",
    role: "Test", department: "Test", geography: "US", legalEntity: "Test", managerName: "Test",
    recruiterName: "Test", joiningDate: "2031-01-01", syntheticProvenance: "synthetic-reset" as const,
    controllerRetired: true };
  const targets = await db.insert(onbCases).values([common, common]).returning({ id: onbCases.id });
  const [hidden, restored] = targets;
  assert.ok(hidden && restored);
  const one = (id: number, expectedVersion: number) => ({
    caseId: id, expectedVersion, caseFamily: "Onboarding",
  });
  await updateCaseListVisibility("demo", actor, input([one(hidden.id, 0), one(restored.id, 0)]));
  await updateCaseListVisibility("demo", actor, input([one(restored.id, 1)], false));
  await assert.rejects(executeSyntheticReset({
    organizationId: "demo", actorId: actor, expectedRevision: "current",
    manifest: DEFAULT_SYNTHETIC_RESET_MANIFEST,
  }), { name: "RetiredCaseCapabilityError", status: 410 });
  // The retired endpoint cannot be revived just for a test. Exercise its
  // case-deletion boundary against the same migrated FK constraints instead.
  const deleted = await db.delete(onbCases).where(and(
    eq(onbCases.organizationId, "demo"),
    sql`${onbCases.id} IN (${hidden.id}, ${restored.id})`,
  )).returning({ id: onbCases.id });
  assert.equal(deleted.length, 2);
  const remaining = await db.select().from(caseListVisibility).where(sql`${caseListVisibility.caseId} IN (${hidden.id}, ${restored.id})`);
  assert.equal(remaining.length, 0);
  const history = await db.select().from(caseListVisibilityChanges).where(sql`${caseListVisibilityChanges.caseId} IN (${hidden.id}, ${restored.id})`);
  assert.deepEqual(history.map(row => row.hidden), [true, true, false]);
});
