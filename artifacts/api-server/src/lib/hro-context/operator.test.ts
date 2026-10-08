import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  db, pool, organizationsTable, organizationMembershipsTable, accessNamedGrants,
  hroContextTransactions, onbSettings, DEMO_ORGANIZATION_ID,
} from "@workspace/db";
import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import { createTenantContextMiddleware } from "../../middlewares/tenant-context";
import { registerDemoPrincipal, demoPrincipalSettingKey } from "../demo-principal";
import { resolveEffectiveAccess } from "../access-governance";
import { openHroContext, closeHroContext, recordHroContextStep } from "./manager";
import { runInHroContext } from "./core";
import contextRouter from "../../routes/hro-context";
import { ListHroContextTransactionsResponse } from "@workspace/api-zod";

// Validate the generated response contract without stripping unknown properties
// from the object used by the privacy/projection assertions.
type History = ReturnType<typeof ListHroContextTransactionsResponse.parse>;
async function readHistory(response: Response): Promise<History> {
  const body: unknown = await response.json();
  ListHroContextTransactionsResponse.parse(body);
  return body as History;
}

after(async () => { await pool.end(); });

test("operator history is live, human-only, tenant-scoped metadata and never replay authority", async () => {
  const actor = `operator-${randomUUID()}`;
  const orgA = `operator-org-${randomUUID()}`, orgB = `operator-org-${randomUUID()}`;
  const demoActor = `operator-demo-${randomUUID()}`;
  for (const id of [orgA, orgB]) {
    await db.insert(organizationsTable).values({
      id, name: "Operator regression", slug: id, joinCodeHash: id, createdByUserId: actor,
    });
    await db.insert(organizationMembershipsTable).values({
      organizationId: id, clerkUserId: actor, role: "owner",
    });
  }
  const app = express();
  app.use((req, _res, next) => { req.authUserId = req.header("x-test-user") || actor; next(); });
  app.use(createTenantContextMiddleware());
  app.use(contextRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const get = (query = "", organization = orgA, user = actor, method = "GET") =>
    fetch(`http://127.0.0.1:${address.port}/context-manager/transactions${query}`, {
      method, headers: { "x-organization-id": organization, "x-test-user": user },
    });
  const grant = async (organizationId: string, principalId = actor) => {
    const [row] = await db.insert(accessNamedGrants).values({
      organizationId, principalType: "human", principalId, scope: "tenant",
      resourceType: "field", resourceKey: "data.context.metadata.read",
      source: "named", effect: "allow", createdByUserId: actor,
    }).returning();
    return row!;
  };
  try {
    const background = await openHroContext({
      organizationId: orgA, workflow: "documents", subjectType: "case", subjectId: "private-case",
    });
    await db.update(hroContextTransactions).set({ startedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(hroContextTransactions.id, background.id));
    await runInHroContext(background, () =>
      recordHroContextStep("checkpoint-recorded", { reference: "private-provider-ref", metrics: { inputBytes: 10 } }));
    const failed = await openHroContext({
      organizationId: orgA, workflow: "documents", subjectType: "case", subjectId: "private-case",
    });
    await closeHroContext(failed, "failed");
    const own = await openHroContext({
      organizationId: orgA, workflow: "onboarding", subjectType: "tenant", subjectId: orgA, initiatingUserId: actor,
    });
    await closeHroContext(own, "completed");
    const other = await openHroContext({
      organizationId: orgA, workflow: "agent", subjectType: "tenant", subjectId: orgA, initiatingUserId: "other-human",
    });
    await closeHroContext(other, "completed");
    // Deliberately reuse a correlation across tenants: permission still scopes every lookup.
    const crossTenant = await openHroContext({
      organizationId: orgB, workflow: "documents", subjectType: "case", subjectId: "private-case",
    });
    await db.update(hroContextTransactions).set({ correlationId: background.correlationId })
      .where(eq(hroContextTransactions.id, crossTenant.id));

    for (const role of ["owner", "admin", "member"] as const) {
      await db.update(organizationMembershipsTable).set({ role }).where(and(
        eq(organizationMembershipsTable.organizationId, orgA), eq(organizationMembershipsTable.clerkUserId, actor),
      ));
      assert.equal((await get("?view=operator")).status, 403, `${role} is not an operator grant`);
    }
    const personal = await readHistory(await get());
    assert.equal(personal.operatorAvailable, false);
    assert.deepEqual(personal.transactions.map((t: { id: string }) => t.id), [own.id]);
    const permission = await grant(orgA);
    const access = await resolveEffectiveAccess({ organizationId: orgA, principalType: "human", principalId: actor });
    assert.deepEqual(access.allows, ["data.context.metadata.read"], "metadata grants no evidence or workflow authority");

    const response = await get("?view=operator");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await readHistory(response);
    assert.equal(body.operatorAvailable, true);
    assert.deepEqual(new Set(body.transactions.map((t: { id: string }) => t.id)), new Set([background.id, failed.id, own.id, other.id]));
    const unfinished = body.transactions.find((t: { id: string }) => t.id === background.id);
    assert(unfinished);
    assert.equal(unfinished.status, "running", "old unfinished is not inferred failure");
    assert.equal(unfinished.finishedAt, null);
    assert.equal(unfinished.initiatorType, "system");
    assert(unfinished.ageSeconds >= 86_400);
    assert.equal(body.transactions.find((t: { id: string }) => t.id === failed.id)?.status, "failed");
    assert.deepEqual(Object.keys(unfinished).sort(), [
      "id", "anchorId", "correlationId", "parentTransactionId", "workflow", "status",
      "version", "executorType", "initiatorType", "startedAt", "finishedAt", "ageSeconds", "steps",
    ].sort());
    assert(!JSON.stringify(body).includes("private-case"));
    assert(!JSON.stringify(body).includes("private-provider-ref"));
    assert(!JSON.stringify(body).includes("other-human"));
    for (const [query, ids] of [
      ["?view=operator&workflow=documents&status=running", [background.id]],
      ["?view=operator&status=failed", [failed.id]],
      ["?view=operator&workflow=readiness", []],
      [`?view=operator&correlationId=${background.correlationId}`, [background.id]],
      [`?correlationId=${background.correlationId}`, []],
    ] as const) {
      const filtered = await readHistory(await get(query));
      assert.deepEqual(filtered.transactions.map((t: { id: string }) => t.id), ids);
    }
    assert.equal((await get("?view=operator", orgB)).status, 403, "tenant A grant never grants tenant B");
    assert.equal((await get("?view=operator", `unverified-${randomUUID()}`)).status, 403);
    for (const query of ["?view=admin", "?workflow=unknown", "?status=interrupted",
      "?correlationId=not-a-uuid", "?status=running&status=failed", "?organizationId=spoofed"]) {
      assert.equal((await get(query)).status, 400, query);
    }
    assert.equal((await get("?view=operator", orgA, actor, "POST")).status, 404, "no replay endpoint");
    // Explicit denies override a positive grant on the next request.
    const [deny] = await db.insert(accessNamedGrants).values({
      organizationId: orgA, principalType: "human", principalId: actor, scope: "tenant",
      resourceType: "field", resourceKey: "data.context.metadata.read", source: "named",
      effect: "deny", createdByUserId: actor,
    }).returning();
    assert.equal((await get("?view=operator")).status, 403);
    await db.delete(accessNamedGrants).where(eq(accessNamedGrants.id, deny!.id));
    await db.update(accessNamedGrants).set({ revokedAt: new Date(), revokedByUserId: actor })
      .where(eq(accessNamedGrants.id, permission.id));
    assert.equal((await get("?view=operator")).status, 403, "grant revocation is live");
    assert.equal((await readHistory(await get())).operatorAvailable, false);
    await db.update(accessNamedGrants).set({ revokedAt: null, revokedByUserId: null })
      .where(eq(accessNamedGrants.id, permission.id));
    await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
      eq(organizationMembershipsTable.organizationId, orgA), eq(organizationMembershipsTable.clerkUserId, actor),
    ));
    assert.equal((await get("?view=operator")).status, 403, "membership revocation is live");

    await db.insert(organizationMembershipsTable).values({
      organizationId: DEMO_ORGANIZATION_ID, clerkUserId: demoActor, role: "owner",
    });
    await registerDemoPrincipal(demoActor, "administrator");
    const demoGrant = await grant(DEMO_ORGANIZATION_ID, demoActor);
    try {
      assert.equal((await get("?view=operator", DEMO_ORGANIZATION_ID, demoActor)).status, 403,
        "shared demo cannot investigate even with an accidental operator grant");
      const demo = await (await get("", DEMO_ORGANIZATION_ID, demoActor)).json();
      assert.deepEqual(demo, { available: false, operatorAvailable: false, transactions: [] });
      assert.equal((await get("?view=operator", orgB, demoActor)).status, 403);
    } finally {
      await db.delete(accessNamedGrants).where(eq(accessNamedGrants.id, demoGrant.id));
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(onbSettings).where(and(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID), eq(onbSettings.key, demoPrincipalSettingKey(demoActor)),
    ));
    await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.clerkUserId, demoActor));
    for (const id of [orgA, orgB]) await deleteTestOrganizations(eq(organizationsTable.id, id));
  }
});
