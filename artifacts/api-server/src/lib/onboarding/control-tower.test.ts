import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, onbCases, onbEvents, onbDocuments, onbSettings, organizationsTable,
  organizationMembershipsTable, accessNamedGrants, onbCommunications, onbApprovals } from "@workspace/db";
import { GetControlTowerExamplesResponse } from "@workspace/api-zod";
import { controlTowerInventorySlots, eligibleControlTowerExample, projectControlTowerExamples, loadControlTowerExamples } from "./control-tower-examples";
import { provisionControlTowerExamples, CONTROL_TOWER_PROVISION_CONFIRMATION } from "./control-tower-example-provisioning";
import controlTowerRouter from "../../routes/control-tower";
import actionCenterRouter from "../../routes/action-center";
import onboardingRouter from "../../routes/onboarding";

const owner = "control-tower-fixture-owner", reader = "control-tower-fixture-reader";
let server: Server, url: string;
const slots = controlTowerInventorySlots();
const authoredRows = slots.map((s, i) => ({ id: i + 1, organizationId: "demo", ...s.values })) as unknown as (typeof onbCases.$inferSelect)[];

test("fixed inventory has seven complementary cases and honest expected-answer arithmetic", () => {
  const before = JSON.stringify(authoredRows);
  const items = projectControlTowerExamples(authoredRows);
  assert.equal(items.length, 7);
  assert.equal(new Set(items.map(i => i.category)).size, 7);
  assert.equal(new Set(items.map(i => i.caseId)).size, 7);
  const samples = items.filter(i => i.matched !== null);
  assert.equal(samples.length, 2);
  assert.equal(samples.filter(i => i.matched).length, 1);
  assert.equal(samples.find(i => i.category === "human-correction")?.matched, false,
    "a corrected answer must not become an initial-answer match");
  assert.match(items.find(i => i.category === "fairness-review")!.limitations, /One authored pair.*no.*certification/);
  assert.ok(items.every(i => i.caseHref === `/cases/${i.caseId}#operational-reliability`));
  assert.equal(JSON.stringify(authoredRows), before);
});

test("no authored finding overlays genuine, prepared, activated, altered, duplicate or run-owned history", () => {
  const source = authoredRows[0];
  for (const patch of [
    { organizationId: "client" }, { workerEmail: "employee@example.org" }, { workerPhone: "+15550000000" },
    { operationalPreparation: {} }, { operationalActivation: {} }, { workerName: "Actual employee" },
    { notes: `${source.notes}\n[demo-controller-run:old]` }, { checklistProfileId: "demo-controller" },
    { orchestrationStatus: "running" },
  ]) assert.equal(eligibleControlTowerExample({ ...source, ...patch } as typeof source), false);
  assert.equal(eligibleControlTowerExample(source, true), false);
  assert.equal(projectControlTowerExamples([source, { ...source, id: 88 }]).length, 0);
  assert.equal(projectControlTowerExamples(authoredRows, new Set([1])).length, 6);
});

before(async () => {
  // run-tests owns a disposable migrated schema; never create Demo fixtures in Preview.
  assert.equal(process.env.REQUIRE_ISOLATED_TEST_SCHEMA, "true");
  await db.insert(organizationsTable).values([
    { id: "demo", slug: "demo", name: "Demo Organization", joinCodeHash: "ct-fixture", createdByUserId: owner },
    { id: "ct-other", slug: "ct-other", name: "Other fixture", joinCodeHash: "ct-other", createdByUserId: owner },
  ]).onConflictDoNothing();
  await db.insert(organizationMembershipsTable).values([
    { organizationId: "demo", clerkUserId: owner, role: "owner" },
    { organizationId: "demo", clerkUserId: reader, role: "member" },
    { organizationId: "ct-other", clerkUserId: owner, role: "owner" },
    { organizationId: "ct-other", clerkUserId: reader, role: "member" },
  ]);
  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = String(req.headers["x-test-user"] || owner);
    req.organizationId = String(req.headers["x-test-org"] || "demo");
    req.organizationRole = req.authUserId === owner ? "owner" : "member";
    req.log = { warn() {}, info() {}, error() {} } as any;
    next();
  });
  app.use(controlTowerRouter, actionCenterRouter, onboardingRouter);
  server = app.listen(0);
  await new Promise<void>(r => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { if (server) await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); await pool.end(); });

const provision = async () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try { return await db.transaction(tx => provisionControlTowerExamples(tx, "demo", CONTROL_TOWER_PROVISION_CONFIRMATION)); }
  finally { process.env.NODE_ENV = old; }
};

test("developer provisioning is concurrent/replay safe, bounded, and produces no effect or outcome records", async () => {
  const [a, b] = await Promise.all([provision(), provision()]);
  assert.equal(a.created + b.created, 7);
  assert.equal((await provision()).created, 0);
  const rows = await db.select().from(onbCases).where(eq(onbCases.organizationId, "demo"));
  assert.equal(rows.length, 7);
  assert.ok(rows.every(r => eligibleControlTowerExample(r)));
  for (const table of [onbEvents, onbCommunications, onbApprovals]) {
    assert.equal((await db.select().from(table).where(eq(table.organizationId, "demo"))).length, 0);
  }
  const payload = await loadControlTowerExamples("demo", owner);
  GetControlTowerExamplesResponse.parse(payload);
  assert.equal(payload.available, 7);
  assert.equal(payload.answerSamples, 2);
  assert.equal(payload.answerMatches, 1);
  const response = await fetch(`${url}/onboarding/control-tower/examples`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as typeof payload;
  assert.equal(body.items.length, 7);
  for (const item of body.items) {
    assert.ok(rows.some(r => r.id === item.caseId && `S${r.id}` === item.reference));
    const detail = await fetch(`${url}/onboarding/cases/${item.caseId}`);
    assert.equal(detail.status, 200, "link target must be a genuinely readable persisted case");
  }
});

test("authorization, revocation and run ownership shrink authored sample denominators, never disclose cached examples", async () => {
  const [row] = await db.select().from(onbCases).where(eq(onbCases.scenarioKey, slots[4].key));
  assert.equal((await loadControlTowerExamples("demo", reader)).available, 0);
  const keys = ["flow.case.read", "data.case.profile.read", "data.case.notes.read"];
  await db.insert(accessNamedGrants).values(keys.map(resourceKey => ({
    organizationId: "demo", principalType: "human" as const, principalId: reader,
    scope: "case" as const, caseId: row.id, resourceType: resourceKey.startsWith("flow.") ? "flow" as const : "field" as const,
    resourceKey, effect: "allow" as const, source: "named" as const, createdByUserId: owner,
  })));
  const allowed = await loadControlTowerExamples("demo", reader);
  assert.equal(allowed.available, 1); assert.equal(allowed.answerSamples, 1); assert.equal(allowed.answerMatches, 1);
  await db.delete(accessNamedGrants).where(eq(accessNamedGrants.principalId, reader));
  assert.equal((await loadControlTowerExamples("demo", reader)).available, 0);
  assert.equal((await loadControlTowerExamples("ct-other", owner)).available, 0);
  await db.insert(onbSettings).values({ organizationId: "demo", key: "onboarding-uat.run.v1:ct-owned",
    value: JSON.stringify({ runId: "ct-owned", linkedCaseIds: [row.id] }) });
  assert.equal((await loadControlTowerExamples("demo", owner)).answerSamples, 1);
  await assert.rejects(provision(), /no overlay or replacement/);
  await db.delete(onbSettings).where(eq(onbSettings.key, "onboarding-uat.run.v1:ct-owned"));
});

test("provisioning refuses changed or prepared slots and never repairs them", async () => {
  const [row] = await db.select().from(onbCases).where(eq(onbCases.scenarioKey, slots[0].key));
  await db.update(onbCases).set({ workerName: "Changed reserved row" }).where(eq(onbCases.id, row.id));
  await assert.rejects(provision(), /no overlay or replacement/);
  const [after] = await db.select().from(onbCases).where(eq(onbCases.id, row.id));
  assert.equal(after.workerName, "Changed reserved row");
  await db.update(onbCases).set({ workerName: row.workerName }).where(eq(onbCases.id, row.id));
});

test("offboarding source outage leaves unrelated authorized Action Center work available", async () => {
  const [row] = await db.insert(onbCases).values({
    organizationId: "ct-other", workerName: "Uncontactable fixture", workerEmail: "",
    hireType: "external", workerCategory: "full-time", role: "Fixture", department: "Fixture",
    geography: "US", legalEntity: "Fixture", managerName: "", recruiterName: "", joiningDate: "2099-01-01",
    readiness: [], workstreams: [], checklistSnapshot: [], workforceContext: { workCountry: "US" },
  }).returning();
  await db.insert(onbDocuments).values({ organizationId: "ct-other", caseId: row.id,
    key: "fixture", label: "Review fixture", category: "identity", status: "pending", required: true });
  await db.execute(sql`ALTER TABLE offb_cases RENAME TO ct_unavailable_offb_cases`);
  try {
    const response = await fetch(`${url}/onboarding/action-center?scope=all&limit=200`, { headers: { "x-test-org": "ct-other" } });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.offboardingSource, "unavailable");
    assert.ok(body.documentFollowups.some((d: any) => d.caseId === row.id));
  } finally { await db.execute(sql`ALTER TABLE ct_unavailable_offb_cases RENAME TO offb_cases`); }
});

test("hidden recent events cannot starve a visible case's activity", async () => {
  const rows = await db.select().from(onbCases).where(eq(onbCases.organizationId, "ct-other"));
  const visible = rows[0];
  const [hidden] = await db.insert(onbCases).values({ ...slots[0].values, organizationId: "ct-other", scenarioKey: null }).returning();
  await db.insert(accessNamedGrants).values(["flow.case.read", "data.case.profile.read", "data.case.notes.read"].map(resourceKey => ({
    organizationId: "ct-other", principalType: "human" as const, principalId: reader,
    scope: "case" as const, caseId: visible.id, resourceType: resourceKey.startsWith("flow.") ? "flow" as const : "field" as const,
    resourceKey, effect: "allow" as const, source: "named" as const, createdByUserId: owner,
  })));
  const [event] = await db.insert(onbEvents).values({ organizationId: "ct-other", caseId: visible.id,
    agent: "human", engine: "human", title: "Visible recorded action", detail: "No effects", createdAt: new Date("2025-01-01") }).returning();
  await db.insert(onbEvents).values(Array.from({ length: 65 }, (_, i) => ({ organizationId: "ct-other", caseId: hidden.id,
    agent: "human", engine: "human", title: "Hidden action", detail: "Private", createdAt: new Date(Date.now() + i) })));
  const response = await fetch(`${url}/onboarding/dashboard`, { headers: { "x-test-org": "ct-other", "x-test-user": reader } });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.deepEqual(body.recentEvents.map((e: any) => e.id), [event.id]);
});
