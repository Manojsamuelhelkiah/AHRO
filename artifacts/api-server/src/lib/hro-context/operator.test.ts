import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db, pool, organizationsTable, organizationMembershipsTable, accessNamedGrants,
  hroContextTransactions, onbSettings, DEMO_ORGANIZATION_ID,
  accessSecurityGroups, accessSecurityGroupPolicies, accessSecurityGroupAttachments,
  accessPrincipalSecurityGroupAttachments, accessUserGroups, accessUserGroupMembers,
  accessSecurityGroupUserGroups,
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

for (const expiringPath of ['direct attachment', 'tenant attachment', 'group link', 'group membership'] as const) {
  test(`operator history denies timed ${expiringPath} expiry without revocation`, async t => {
    const start = Date.parse('2026-10-08T12:00:00Z');
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const expiry = new Date(start + 60_000);
    const organizationId = `operator-expiry-${randomUUID()}`;
    const actor = `operator-${randomUUID()}`, owner = `owner-${randomUUID()}`;
    const securityGroupId = `security-${randomUUID()}`, userGroupId = `users-${randomUUID()}`;
    const app = express();
    app.use((req, _res, next) => { req.authUserId = req.header('x-test-user') || actor; next(); });
    app.use(createTenantContextMiddleware());
    app.use(contextRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const get = (view = 'operator', user = actor) => fetch(
      `http://127.0.0.1:${address.port}/context-manager/transactions?view=${view}`,
      { headers: { 'x-organization-id': organizationId, 'x-test-user': user } },
    );
    try {
      await db.insert(organizationsTable).values({
        id: organizationId, name: 'Temporary operator regression', slug: organizationId,
        joinCodeHash: organizationId, createdByUserId: owner,
      });
      await db.insert(organizationMembershipsTable).values([actor, owner].map(clerkUserId => ({
        organizationId, clerkUserId, role: 'member' as const,
      })));
      await db.insert(accessSecurityGroups).values({
        organizationId, id: securityGroupId, name: 'Temporary metadata', ownerUserId: owner, createdByUserId: actor,
      });
      await db.insert(accessSecurityGroupPolicies).values({
        organizationId, securityGroupId, version: 1,
        policy: { fields: ['data.context.metadata.read'], flows: [], tools: [] },
        createdByUserId: actor, approvedByUserId: owner, approvedAt: new Date(start),
      });
      const approval = {
        status: 'active' as const, attachedByUserId: actor, requiresApproval: 'yes' as const,
        approvedByUserId: owner, approvedAt: new Date(start), approvedPolicyVersion: 1,
      };
      if (expiringPath === 'direct attachment') {
        await db.insert(accessPrincipalSecurityGroupAttachments).values({
          organizationId, securityGroupId, principalType: 'human', principalId: actor,
          scope: 'tenant', expiresAt: expiry, ...approval,
        });
      } else {
        await db.insert(accessUserGroups).values({
          organizationId, id: userGroupId, name: 'Temporary operators', ownerUserId: owner, createdByUserId: actor,
        });
        await db.insert(accessUserGroupMembers).values({
          organizationId, groupId: userGroupId, principalType: 'human', principalId: actor,
          status: 'active', attachedByUserId: actor, requiresApproval: 'yes',
          approvedByUserId: owner, approvedAt: new Date(start),
          expiresAt: expiringPath === 'group membership' ? expiry : null,
        });
        await db.insert(accessSecurityGroupUserGroups).values({
          organizationId, securityGroupId, userGroupId, ...approval,
          expiresAt: expiringPath === 'group link' ? expiry : null,
        });
        await db.insert(accessSecurityGroupAttachments).values({
          organizationId, securityGroupId, scope: 'tenant', ...approval,
          expiresAt: expiringPath === 'tenant attachment' ? expiry : null,
        });
      }
      const own = await openHroContext({
        organizationId, workflow: 'onboarding', subjectType: 'tenant', subjectId: organizationId,
        initiatingUserId: actor,
      });
      const background = await openHroContext({
        organizationId, workflow: 'documents', subjectType: 'tenant', subjectId: organizationId,
      });
      assert.equal((await get('operator', owner)).status, 403);
      t.mock.timers.setTime(expiry.getTime() - 1);
      const before = await get();
      assert.equal(before.status, 200, 'access is live one millisecond before expiry');
      assert.equal(before.headers.get('cache-control'), 'no-store');
      assert.deepEqual(new Set((await readHistory(before)).transactions.map(row => row.id)), new Set([own.id, background.id]));
      for (const now of [expiry.getTime(), expiry.getTime() + 1]) {
        t.mock.timers.setTime(now);
        const access = await resolveEffectiveAccess({ organizationId, principalType: 'human', principalId: actor });
        assert(!access.allows.includes('data.context.metadata.read'), 'live evaluator excludes timed grant at equality');
        const denied = await get();
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.get('cache-control'), 'no-store');
        const body = await denied.json();
        assert(body && typeof body === 'object');
        assert.deepEqual(Object.keys(body), ['message'], 'no stale metadata in a denied response');
        assert(!JSON.stringify(body).includes(background.id));
        const personal = await readHistory(await get('personal'));
        assert.equal(personal.operatorAvailable, false);
        assert.deepEqual(personal.transactions.map(row => row.id), [own.id], 'own history remains available, not background history');
      }
      const [membership] = await db.select().from(organizationMembershipsTable).where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, actor),
      ));
      assert.equal(membership?.revokedAt, null, 'expiry needs no tenant membership revocation');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
    }
  });
}

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
    // More than two pages, including exact ties and timestamps inside the same
    // JS millisecond: neither newer inserts nor a deleted boundary may shift a seek.
    const paginationCorrelation = randomUUID();
    const fixtureIds = Array.from({ length: 67 }, () => randomUUID());
    await db.insert(hroContextTransactions).values(fixtureIds.map((id, index) => ({
      id, organizationId: orgA, anchorId: background.anchorId, correlationId: paginationCorrelation,
      workflow: "documents", status: "running", initiatorType: "system", executorType: "system",
      startedAt: sql`${index < 35 ? "2026-01-01T00:00:00.123456Z" : "2026-01-01T00:00:00.123455Z"}::timestamptz`,
    })));
    const expected = [
      ...fixtureIds.slice(0, 35).sort().reverse(),
      ...fixtureIds.slice(35).sort().reverse(),
    ];
    const pageQuery = `?view=operator&workflow=documents&status=running&correlationId=${paginationCorrelation}`;
    const firstPage = await readHistory(await get(pageQuery));
    assert.equal(firstPage.transactions.length, 30);
    assert.deepEqual(firstPage.transactions.map(t => t.id), expected.slice(0, 30));
    assert(firstPage.nextCursor);
    const olderQuery = `${pageQuery}&cursor=${firstPage.nextCursor}`;
    // The cursor remains bound to all filters, principal and tenant, without
    // replacing the normal live authorization checks on the next request.
    for (const changed of [
      olderQuery.replace("workflow=documents", "workflow=agent"),
      olderQuery.replace("status=running", "status=failed"),
      olderQuery.replace(paginationCorrelation, randomUUID()),
      `?view=operator&cursor=${firstPage.nextCursor}`,
      `?cursor=${firstPage.nextCursor}`,
      `${pageQuery}&cursor=not-a-cursor`,
      `${pageQuery}&cursor=${"a".repeat(2049)}`,
    ]) assert.equal((await get(changed)).status, 400, changed);
    const tenantBGrant = await grant(orgB);
    try {
      assert.equal((await get(olderQuery, orgB)).status, 400, "cannot reuse tenant A seek in authorized tenant B");
    } finally { await db.delete(accessNamedGrants).where(eq(accessNamedGrants.id, tenantBGrant.id)); }
    const newId = randomUUID();
    await db.insert(hroContextTransactions).values({
      id: newId, organizationId: orgA, anchorId: background.anchorId, correlationId: paginationCorrelation,
      workflow: "documents", status: "running", initiatorType: "system", executorType: "system",
    });
    // Simulate retention removing the exact boundary row, not just fresh arrivals.
    await db.delete(hroContextTransactions).where(eq(hroContextTransactions.id, expected[29]!));
    const secondPage = await readHistory(await get(olderQuery));
    assert.equal(secondPage.transactions.length, 30);
    assert.deepEqual(secondPage.transactions.map(t => t.id), expected.slice(30, 60));
    assert(secondPage.nextCursor);
    const thirdPage = await readHistory(await get(`${pageQuery}&cursor=${secondPage.nextCursor}`));
    assert.deepEqual(thirdPage.transactions.map(t => t.id), expected.slice(60));
    assert.equal(thirdPage.nextCursor, null);
    assert.equal(new Set([...firstPage.transactions, ...secondPage.transactions, ...thirdPage.transactions]
      .map(t => t.id)).size, 67, "no duplicate or skipped original attempts");
    assert.equal((await readHistory(await get(pageQuery))).transactions[0]?.id, newId, "refresh sees new arrivals");
    assert(!JSON.stringify(secondPage).includes("cursorStartedAt"), "internal seek timestamp stays out of projections");
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL enable_seqscan = off");
      for (const filter of ["", "AND workflow = 'documents'", "AND status = 'running'",
        "AND workflow = 'documents' AND status = 'running'", "AND correlation_id = $2"]) {
        const plan = await connection.query(`EXPLAIN SELECT id, started_at FROM hro_context_transactions
          WHERE organization_id = $1 ${filter}
          AND (started_at, id) < ('2026-01-01T00:00:00.123456Z'::timestamptz, 'ffffffff-ffff-ffff-ffff-ffffffffffff')
          ORDER BY started_at DESC, id DESC LIMIT 31`,
        filter.includes("$2") ? [orgA, paginationCorrelation] : [orgA]);
        const text = plan.rows.map(row => row["QUERY PLAN"]).join("\n");
        assert.match(text, /Index (Only )?Scan using hro_context_history_/);
        assert.doesNotMatch(text, /Sort|Seq Scan/, "seek ordering is supported directly by an index");
      }
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
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
    assert.equal((await get(olderQuery)).status, 403, "explicit deny applies on older pages");
    await db.delete(accessNamedGrants).where(eq(accessNamedGrants.id, deny!.id));
    await db.update(accessNamedGrants).set({ revokedAt: new Date(), revokedByUserId: actor })
      .where(eq(accessNamedGrants.id, permission.id));
    assert.equal((await get("?view=operator")).status, 403, "grant revocation is live");
    assert.equal((await get(olderQuery)).status, 403, "a cursor never preserves revoked authority");
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
      assert.equal((await get(olderQuery, DEMO_ORGANIZATION_ID, demoActor)).status, 403,
        "shared demo cannot use older-page cursors");
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

