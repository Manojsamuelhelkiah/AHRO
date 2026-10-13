import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import {
  db, organizationsTable, organizationMembershipsTable, accessUserGroups,
  onbCases, onbActionCenterActions,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import clientOperationsRouter from "../../routes/client-operations-settings";
import { createTenantContextMiddleware, lookupMembership } from "../../middlewares/tenant-context";
import {
  assertBatchFamilyEnabled, defaultClientOperations, loadClientOperations,
  nextClientBusinessDate, saveClientOperations, selectClientRoutingRule,
  validateClientOperations, resolveClientActionRouting,
} from "./client-operations-settings";
import { getDay1LogisticsDefault, setDay1LogisticsDefault } from "./settings";
import { HRO_BATCH_TEMPLATES, hroRequestForRow } from "./hro-batch-templates";
import { recordWorkItem } from "./action-center";

test("configuration validates complete families, immutable template compatibility, weekdays and dates", () => {
  const config = defaultClientOperations();
  assert.equal(config.families.length, 12);
  assert.deepEqual(validateClientOperations(config), config);
  for (const bad of [
    { ...config, families: config.families.slice(1) },
    { ...config, families: config.families.map((family, i) => i ? family : { ...family, defaultTemplateId: "leave-request" }) },
    { ...config, defaults: { ...config.defaults, businessDays: [1.5] } },
    { ...config, defaults: { ...config.defaults, businessDays: [] } },
    { ...config, defaults: { ...config.defaults, timezone: "Invalid/Zone" } },
    { ...config, defaults: { ...config.defaults, holidays: ["2026-02-30"] } },
    { ...config, defaults: { ...config.defaults, holidays: ["2026-12-25", "2026-12-25"] } },
    { ...config, routingRules: [
      { family: "Payroll", country: null, owner: "hr", groupId: null },
      { family: "Payroll", country: null, owner: "operations", groupId: null },
    ] },
  ]) assert.throws(() => validateClientOperations(bad));
  assert.equal(nextClientBusinessDate("2026-12-25", {
    ...config.defaults, holidays: ["2026-12-25"],
  }), "2026-12-28");
  assert.equal(nextClientBusinessDate("2026-12-25", { ...config.defaults, businessDays: [6] }), "2026-12-26");
});

test("routing precedence is family+country, family, country, then global; unknown countries are not inferred", () => {
  const config = defaultClientOperations();
  config.routingRules = [
    { family: null, country: null, owner: "hr", groupId: null },
    { family: null, country: "IN", owner: "operations", groupId: null },
    { family: "Payroll", country: null, owner: "documentation", groupId: null },
    { family: "Payroll", country: "IN", owner: "compliance", groupId: null },
  ];
  assert.equal(selectClientRoutingRule(config, "Payroll", "IN")?.owner, "compliance");
  assert.equal(selectClientRoutingRule(config, "Payroll", null)?.owner, "documentation");
  assert.equal(selectClientRoutingRule(config, "Benefits", "IN")?.owner, "operations");
  assert.equal(selectClientRoutingRule(config, "Benefits", null)?.owner, "hr");
});

test("tenant-scoped settings persist, reject stale/cross-client writes, and affect batch/default logistics and real work assignments", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const suffix = randomUUID();
  const orgA = `operations-a-${suffix}`, orgB = `operations-b-${suffix}`;
  const owner = `operations-owner-${suffix}`, member = `operations-member-${suffix}`;
  for (const id of [orgA, orgB]) await db.insert(organizationsTable).values({
    id, name: "Isolated client operations fixture", slug: id, joinCodeHash: id, createdByUserId: owner,
  });
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: owner, role: "owner" },
    { organizationId: orgA, clerkUserId: member, role: "member" },
    { organizationId: orgB, clerkUserId: owner, role: "owner" },
  ]);
  const [groupA] = await db.insert(accessUserGroups).values({
    id: randomUUID(), organizationId: orgA, name: "Fixture payroll queue",
    ownerUserId: owner, createdByUserId: owner, status: "active",
  }).returning();
  const [groupB] = await db.insert(accessUserGroups).values({
    id: randomUUID(), organizationId: orgB, name: "Other client private group",
    ownerUserId: owner, createdByUserId: owner, status: "active",
  }).returning();
  const initial = await loadClientOperations(orgA);
  assert.equal(initial.version, 0);
  const config = initial.configuration;
  config.defaults.timezone = "Europe/London";
  config.defaults.dateFormat = "dd/MM/yyyy";
  config.families.find(f => f.family === "Leave")!.batchEnabled = false;
  config.families.find(f => f.family === "Onboarding")!.defaultTemplateId = "onboarding-contractor";
  config.routingRules = [{ family: "Payroll", country: "IN", owner: "operations", groupId: groupA.id }];
  const saved = await saveClientOperations(orgA, owner, 0, config);
  assert.equal(saved.version, 1);
  assert.deepEqual((await loadClientOperations(orgA)).configuration, config);
  assert.equal((await loadClientOperations(orgB)).version, 0);
  await assert.rejects(saveClientOperations(orgA, owner, 0, config), { status: 409 });
  await assert.rejects(saveClientOperations(orgA, member, 1, config), { status: 403 });
  await assert.rejects(saveClientOperations(orgA, owner, 1, { ...config,
    routingRules: [{ ...config.routingRules[0], groupId: groupB.id }],
  }), /another client/);
  await assert.rejects(assertBatchFamilyEnabled(orgA, "leave-request"), { status: 409 });
  await assertBatchFamilyEnabled(orgB, "leave-request");
  assert.equal((await getDay1LogisticsDefault(orgA)).timezone, "Europe/London");
  const logistics = await getDay1LogisticsDefault(orgA);
  await setDay1LogisticsDefault(orgA, { ...logistics, timezone: "Asia/Kolkata" });
  assert.equal((await getDay1LogisticsDefault(orgA)).timezone, "Asia/Kolkata");
  const definition = HRO_BATCH_TEMPLATES.find(t => t.family === "Payroll")!;
  const request = hroRequestForRow(definition, {
    request_id: "fixture-request", work_country: "IN", employee_id: "fictional-reference",
  });
  const [record] = await db.insert(onbCases).values({
    organizationId: orgA, workerName: "Fictional operations fixture", workerEmail: "fixture@hro.invalid",
    hireType: "employee-service", workerCategory: "white-collar", role: "Fixture", department: "Fixture", geography: "IN",
    legalEntity: "Fixture", managerName: "Fixture", recruiterName: "Fixture",
    joiningDate: "2030-01-01", processPolicySnapshot: { batchIntake: request },
  }).returning();
  const route = await resolveClientActionRouting(orgA, record);
  assert.equal(route.owner, "operations"); assert.equal(route.assignee, groupA.name);
  const work = { organizationId: orgA, actorUserId: owner, actorName: "Fixture owner",
    organizationRole: "owner", requestId: `fixture-${suffix}`, caseId: record.id,
    kind: "assign" as const, expectedVersion: 0 };
  const assigned = await recordWorkItem(work);
  assert.equal((await recordWorkItem(work)).idempotent, true);
  const rows = await db.select().from(onbActionCenterActions).where(eq(onbActionCenterActions.caseId, record.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner, "operations");
  assert.equal(rows[0].assignee, groupA.name);
  assert.deepEqual(rows[0].payload.clientRouting, { settingsVersion: 1, groupId: groupA.id });
  await db.update(accessUserGroups).set({ status: "retired" }).where(eq(accessUserGroups.id, groupA.id));
  const fallback = await resolveClientActionRouting(orgA, record);
  assert.equal(fallback.owner, config.fallbackOwner); assert.equal(fallback.assignee, null);
  assert.match(fallback.reason, /unavailable/);

  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = req.header("x-fixture-user") || member; next(); });
  app.use(createTenantContextMiddleware(lookupMembership), clientOperationsRouter);
  const server = app.listen(0); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/organizations/current/settings/operations`;
  try {
    const read = await fetch(base, { headers: { "x-organization-id": orgA } });
    assert.equal(read.status, 200);
    const body = await read.json() as { canEdit: boolean; groups: unknown[]; configuration: { routingRules: unknown[] } };
    assert.equal(body.canEdit, false); assert.deepEqual(body.groups, []);
    assert.deepEqual(body.configuration.routingRules, []);
    const denied = await fetch(base, { method: "PUT", headers: {
      "content-type": "application/json", "x-organization-id": orgA,
    }, body: JSON.stringify({ expectedVersion: 1, configuration: config }) });
    assert.equal(denied.status, 403);
    const editable = { ...config, routingRules: [{ ...config.routingRules[0], groupId: null }] };
    const ownerHeaders = {
      "content-type": "application/json", "x-organization-id": orgA, "x-fixture-user": owner,
    };
    const updated = await fetch(base, { method: "PUT", headers: ownerHeaders,
      body: JSON.stringify({ expectedVersion: 1, configuration: editable }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { version: number }).version, 2);
    const stale = await fetch(base, { method: "PUT", headers: ownerHeaders,
      body: JSON.stringify({ expectedVersion: 1, configuration: editable }) });
    assert.equal(stale.status, 409);
    const concurrent = await Promise.all([
      saveClientOperations(orgA, owner, 2, editable),
      saveClientOperations(orgA, owner, 2, { ...editable, fallbackOwner: "operations" }),
    ].map(promise => promise.then(result => ({ ok: true, version: result.version }))
      .catch((error: { status: number }) => ({ ok: false, status: error.status }))));
    assert.equal(concurrent.filter(result => result.ok).length, 1);
    assert.equal(concurrent.filter(result => !result.ok && "status" in result && result.status === 409).length, 1);
    const cross = await fetch(base, { headers: { "x-organization-id": orgB } });
    assert.equal(cross.status, 403);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
