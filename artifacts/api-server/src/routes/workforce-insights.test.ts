import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import { db, organizationsTable, organizationMembershipsTable, onbCases, onbSettings } from "@workspace/db";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import { createWorkforceInsightsRouter } from "./workforce-insights";
import { WORKFORCE_INSIGHTS_KEY } from "../lib/workforce-insights";

test("client-scoped persisted review lifecycle, deduplication, conflicts and revoked administration", async () => {
  const orgA = `warning-a-${randomUUID()}`, orgB = `warning-b-${randomUUID()}`;
  const adminA = `warning-admin-a-${randomUUID()}`, adminB = `warning-admin-b-${randomUUID()}`;
  const member = `warning-member-${randomUUID()}`;
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Isolated warning client A", slug: orgA, joinCodeHash: orgA, createdByUserId: adminA },
    { id: orgB, name: "Isolated warning client B", slug: orgB, joinCodeHash: orgB, createdByUserId: adminB },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: adminA, role: "admin" },
    { organizationId: orgB, clerkUserId: adminB, role: "owner" },
    { organizationId: orgA, clerkUserId: member, role: "member" },
  ]);
  const source = (organizationId: string, workerName: string) => ({
    organizationId, workerName, workerEmail: "fictional@fixture.invalid", hireType: "standard",
    department: "Fixture", managerName: "Fixture manager", recruiterName: "Fixture recruiter",
    joiningDate: "2030-10-01", controllerRetired: true, workerCategory: "employee",
    role: "Fixture role", geography: "India", legalEntity: "Fixture entity",
  });
  const [caseA, caseB] = await db.insert(onbCases).values([
    source(orgA, "Warning fixture A"), source(orgB, "Private warning fixture B"),
  ]).returning();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = req.header("x-fixture-user") ?? adminA; next(); });
  app.use(createTenantContextMiddleware(lookupMembership));
  app.use("/api", createWorkforceInsightsRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/workforce-insights`;
  async function request(path = "", method = "GET", body?: unknown, actor = adminA, org = orgA) {
    const response = await fetch(url + path, { method, headers: {
      "content-type": "application/json", "x-fixture-user": actor, "x-organization-id": org,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cache: response.headers.get("cache-control") };
  }
  try {
    const initial = await request();
    assert.equal(initial.status, 200);
    assert.equal(initial.data.modelStatus, "not-connected");
    assert.deepEqual(initial.data.assessments, []);
    assert.equal(initial.data.subjects.length, 1);
    assert.equal(initial.data.subjects[0].caseId, caseA.id);
    assert.equal(initial.cache, "no-store");
    assert.equal((await request("", "GET", undefined, member)).status, 403);
    const input = { version: 0, caseId: caseA.id, kind: "talent-risk", priority: "critical",
      reason: "Source-backed concern", recommendedAction: "Human supportive follow-up",
      ownerUserId: adminA, dueDate: "2026-11-02" };
    assert.equal((await request("/reviews", "POST", { ...input, caseId: caseB.id })).status, 404);
    assert.equal((await request("/reviews", "POST", { ...input, ownerUserId: adminB })).status, 404);
    assert.equal((await request("/reviews", "POST", { ...input, caseId: 1.25 })).status, 400);
    const created = await request("/reviews", "POST", input);
    assert.equal(created.status, 200);
    assert.equal(created.data.version, 1);
    assert.equal(created.data.reviews.length, 1);
    assert.equal(created.data.reviews[0].origin, "human");
    assert.deepEqual(created.data.assessments, []);
    const id = created.data.reviews[0].id;
    const persisted = await request();
    assert.equal(persisted.data.reviews[0].id, id);
    assert.equal((await request("", "GET", undefined, adminB, orgB)).data.reviews.length, 0);
    const duplicate = await request("/reviews", "POST", { ...input, version: 1 });
    assert.equal(duplicate.data.version, 1);
    assert.equal(duplicate.data.reviews.length, 1);
    assert.equal((await request("/reviews", "POST", input)).status, 409);
    assert.equal((await request(`/reviews/${id}`, "PATCH", {
      version: 1, status: "resolved", ownerUserId: adminA, dueDate: input.dueDate, outcome: " ",
    })).status, 400);
    const update = { version: 1, status: "in-progress", ownerUserId: adminA, dueDate: input.dueDate, outcome: "HR reviewing evidence" };
    const concurrent = await Promise.all([request(`/reviews/${id}`, "PATCH", update), request(`/reviews/${id}`, "PATCH", update)]);
    assert.deepEqual(concurrent.map(row => row.status).sort(), [200, 409]);
    const resolved = await request(`/reviews/${id}`, "PATCH", { ...update, version: 2, status: "resolved", outcome: "Concern clarified with employee" });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.reviews[0].history.length, 3);
    assert.equal(resolved.data.reviews[0].status, "resolved");
    assert.equal((await request(`/reviews/${id}`, "PATCH", { ...update, version: 3 }, adminB, orgB)).status, 404);
    const [stored] = await db.select().from(onbSettings).where(and(eq(onbSettings.organizationId, orgA), eq(onbSettings.key, WORKFORCE_INSIGHTS_KEY)));
    assert.equal(JSON.parse(stored.value).reviews[0].status, "resolved");
    await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
      eq(organizationMembershipsTable.organizationId, orgA), eq(organizationMembershipsTable.clerkUserId, adminA),
    ));
    assert.equal((await request()).status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // The entire disposable test schema is dropped by the registered harness.
  }
});
