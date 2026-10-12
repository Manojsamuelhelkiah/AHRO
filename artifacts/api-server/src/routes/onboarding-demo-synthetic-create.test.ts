import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, DEMO_ORGANIZATION_ID, organizationsTable, organizationMembershipsTable, accessNamedGrants,
  onbCases, onbCommunications, onbEvents, onbEffectJournal, onbAuthorityAssignments, onbSettings, onbSensitiveLifecyclePolicies, onbReadinessSlaPolicies,
} from "@workspace/db";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import { caseRetirementFence } from "../middlewares/case-retirement";
import { demoPrincipalSettingKey } from "../lib/demo-principal";
import { SYNTHETIC_OFFLINE_MARKER } from "../lib/onboarding/synthetic-offline";
import { withCaseDispatchGuard } from "../lib/onboarding/dispatch-guard";
import { startOrchestration } from "../lib/onboarding/engine";
import { errorHandler } from "../middlewares/error-handler";
import { SENSITIVE_DATA_CLASSES } from "../lib/onboarding/sensitive-lifecycle";
import onboardingRouter from "./onboarding";

const suffix = `retirement-${randomUUID()}`;
const admin = `${suffix}-admin`, reviewer = `${suffix}-reviewer`, ordinary = `${suffix}-ordinary`;
const foreign = `${suffix}-foreign`;
let server: Server, base: string, caseId: number;
async function request(actor: string | null, tenant: string, path: string, method = "POST", data: unknown = {}) {
  return fetch(`${base}${path}`, { method, headers: {
    "content-type": "application/json", "x-organization-id": tenant, ...(actor ? { "x-test-user": actor } : {}),
  }, ...(method === "GET" ? {} : { body: JSON.stringify(data) }) });
}
async function snapshot() {
  const rows = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
  const comms = await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseId));
  const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId));
  const effects = await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.caseId, caseId));
  const grants = await db.select().from(onbAuthorityAssignments).where(eq(onbAuthorityAssignments.caseId, caseId));
  return JSON.stringify({ rows, comms, events, effects, grants });
}
describe("authenticated case retirement and historical isolation", { skip: !process.env.DATABASE_URL }, () => {
  before(async () => {
    await db.insert(organizationsTable).values({ id: DEMO_ORGANIZATION_ID, name: "Demo", slug: "development-demo", joinCodeHash: suffix, createdByUserId: admin }).onConflictDoNothing();
    await db.insert(organizationsTable).values({ id: foreign, name: foreign, slug: foreign, joinCodeHash: foreign, createdByUserId: ordinary });
    await db.insert(organizationMembershipsTable).values([
      { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: admin, role: "member" },
      { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: reviewer, role: "member" },
      { organizationId: foreign, clerkUserId: admin, role: "owner" },
      { organizationId: foreign, clerkUserId: ordinary, role: "owner" },
    ]);
    await db.insert(onbSettings).values([
      { organizationId: DEMO_ORGANIZATION_ID, key: demoPrincipalSettingKey(admin), value: "administrator" },
      { organizationId: DEMO_ORGANIZATION_ID, key: demoPrincipalSettingKey(reviewer), value: "reviewer" },
    ]);
    await db.insert(accessNamedGrants).values(["data.case.profile.read", "data.case.profile.edit", "data.case.notes.read", "data.case.notes.edit", "flow.case.read", "flow.case.edit"].map(resourceKey => ({
      organizationId: foreign, principalType: "human" as const, principalId: ordinary,
      scope: "tenant" as const, resourceType: resourceKey.startsWith("flow") ? "flow" as const : "field" as const,
      resourceKey, source: "named" as const, effect: "allow" as const,
      createdByUserId: ordinary, approvedByUserId: `${suffix}-independent`, approvedAt: new Date(),
    })));
    await db.insert(onbSensitiveLifecyclePolicies).values(SENSITIVE_DATA_CLASSES.map(dataClass => ({
      organizationId: foreign, dataClass, jurisdiction: "US", revision: 1, purpose: "Disposable regression fixture",
      lawfulBasis: "Test-only fixture", retentionDays: 1, providerSharingApproved: false, permittedProviders: [],
      policyReference: suffix, approvalReference: suffix, approvedByUserId: ordinary,
      approvedAuthorityAssignmentId: 1, isCurrent: true,
    })));
    const [row] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID, workerName: "Retained private test fixture",
      workerEmail: `${suffix}@example.invalid`, joiningDate: "2035-01-01",
      workerCategory: "employee", role: "History fixture", department: "Testing", geography: "US",
      legalEntity: "Demo", managerName: "Fixture manager", recruiterName: "Fixture recruiter",
      syntheticProvenance: "onboarding-demo-fictional", notes: SYNTHETIC_OFFLINE_MARKER,
      orchestrationStatus: "paused", hireType: "external-fte",
    }).returning();
    caseId = row.id;
    await db.insert(accessNamedGrants).values(["data.case.profile.read", "data.case.notes.read", "flow.case.read"].map(resourceKey => ({
      organizationId: DEMO_ORGANIZATION_ID, principalType: "human" as const, principalId: admin,
      scope: "case" as const, caseId, resourceType: resourceKey.startsWith("flow") ? "flow" as const : "field" as const,
      resourceKey, source: "named" as const, effect: "allow" as const,
      createdByUserId: admin, approvedByUserId: `${suffix}-independent`, approvedAt: new Date(),
    })));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.authUserId = req.header("x-test-user"); next(); });
    app.use(createTenantContextMiddleware(lookupMembership));
    app.use(caseRetirementFence);
    app.use(onboardingRouter);
    app.post("/ordinary-control", (_req, res) => res.json({ allowed: true }));
    app.use(errorHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await db.delete(onbCases).where(eq(onbCases.id, caseId));
    await db.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, foreign));
    await db.delete(onbCases).where(eq(onbCases.organizationId, foreign));
    await db.delete(accessNamedGrants).where(eq(accessNamedGrants.organizationId, foreign));
    await db.delete(onbReadinessSlaPolicies).where(eq(onbReadinessSlaPolicies.organizationId, foreign));
    await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, foreign));
    await db.delete(onbEvents).where(eq(onbEvents.organizationId, foreign));
    await db.delete(onbCommunications).where(eq(onbCommunications.organizationId, foreign));
    await db.delete(onbSettings).where(eq(onbSettings.organizationId, foreign));
    await db.delete(accessNamedGrants).where(inArray(accessNamedGrants.principalId, [admin, reviewer]));
    await db.delete(onbSettings).where(and(eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID), inArray(onbSettings.key, [demoPrincipalSettingKey(admin), demoPrincipalSettingKey(reviewer)])));
    await db.delete(organizationMembershipsTable).where(inArray(organizationMembershipsTable.clerkUserId, [admin, reviewer, ordinary]));
    await deleteTestOrganizations(eq(organizationsTable.id, foreign), async (tx, ids) => {
      assert.deepEqual(ids, [foreign]);
      assert.match(foreign, /^retirement-[a-f0-9-]+-foreign$/);
      // Dispose only this newly created developer fixture's remaining children.
      // Discover current schema tables so new case-governance children cannot
      // strand a fixture or require touching any pre-existing tenant evidence.
      const tables = await tx.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'organization_id'
          AND left(table_name, 4) = 'onb_'
      `);
      let pending = tables.rows.map(row => row.table_name);
      while (pending.length) {
        const postponed: string[] = [];
        for (const table of pending) {
          await tx.execute(sql`SAVEPOINT retirement_fixture_cleanup`);
          try {
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE organization_id = ${foreign}`);
            await tx.execute(sql`RELEASE SAVEPOINT retirement_fixture_cleanup`);
          } catch (error) {
            await tx.execute(sql`ROLLBACK TO SAVEPOINT retirement_fixture_cleanup`);
            await tx.execute(sql`RELEASE SAVEPOINT retirement_fixture_cleanup`);
            const code = (error as { code?: string; cause?: { code?: string } }).cause?.code
              ?? (error as { code?: string }).code;
            if (code !== "23503") throw error;
            postponed.push(table);
          }
        }
        assert.ok(postponed.length < pending.length, `Fixture FK cycle: ${postponed.join(", ")}`);
        pending = postponed;
      }
    });
  });
  test("stale actions and shared Demo intake cannot create, replace, progress, approve or delete", async () => {
    const before = await snapshot();
    for (const actor of [admin, reviewer]) {
      for (const [path, method] of [
        ["/onboarding/cases", "POST"], ["/onboarding/standard-intake/events", "POST"], ["/onboarding/batch-intake/commit", "POST"],
        ["/onboarding/scenarios/standard-fte/run", "POST"], ["/onboarding/synthetic-reset", "POST"],
        [`/onboarding/cases/${caseId}/simulation/simulate-next`, "POST"],
        [`/onboarding/cases/${caseId}/readiness`, "PATCH"], [`/onboarding/cases/${caseId}`, "DELETE"],
      ]) {
        const response = await request(actor, DEMO_ORGANIZATION_ID, path, method);
        assert.equal(response.status, 410, path);
        assert.equal((await response.json() as { code: string }).code, "CASE_TEST_CAPABILITY_RETIRED");
      }
    }
    assert.equal(await snapshot(), before);
  });
  test("anonymous and foreign-tenant requests cannot obtain history or retirement details", async () => {
    assert.equal((await request(null, DEMO_ORGANIZATION_ID, "/onboarding/synthetic-reset")).status, 401);
    assert.equal((await request(admin, foreign, "/onboarding/cases")).status, 403);
    const response = await request(ordinary, foreign, `/onboarding/cases/${caseId}`, "GET");
    assert.equal(response.status, 404);
    assert.equal((await request(ordinary, foreign, "/ordinary-control")).status, 200);
  });
  test("authorized historical reads remain scoped and read-only; dispatch and orchestration cannot manufacture outcomes", async () => {
    const before = await snapshot();
    const response = await request(admin, DEMO_ORGANIZATION_ID, `/onboarding/cases/${caseId}`, "GET");
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as { controllerRetired: boolean }).controllerRetired, true);
    assert.equal((await request(reviewer, DEMO_ORGANIZATION_ID, `/onboarding/cases/${caseId}`, "GET")).status, 403);
    let calls = 0;
    await withCaseDispatchGuard(caseId, async () => { calls++; }, { onOffline: async () => { calls++; } });
    await startOrchestration(caseId);
    assert.equal(calls, 0);
    assert.equal(await snapshot(), before);
  });
  test("ordinary scoped intake still creates a real case without inheriting test provenance or demo authority", async () => {
    const response = await request(ordinary, foreign, "/onboarding/cases", "POST", {
      workerName: "Ordinary intake fixture", workerEmail: `${suffix}-real@example.invalid`,
      channelPreference: "both", hireType: "external-fte", workerCategory: "employee",
      role: "Engineer", department: "Testing", geography: "US", legalEntity: "Fixture",
      managerName: "Manager", recruiterName: "Recruiter", joiningDate: "2035-01-01",
      urgency: "normal", offerAcceptanceComplete: false,
      workforceContext: { workCountry: "US", workEnvironment: "office", siteExposure: false, safetyCritical: false },
    });
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json() as { id: number; controllerRetired: boolean };
    const [row] = await db.select().from(onbCases).where(eq(onbCases.id, result.id));
    assert.equal(row.syntheticProvenance, null);
    assert.equal(row.scenarioKey, null);
    assert.equal(result.controllerRetired, false);
    // No provider dispatch is permitted by the fixture's collection-only policies
    // and unaccepted offer. Let its immediate gate settlement finish before cleanup.
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});
