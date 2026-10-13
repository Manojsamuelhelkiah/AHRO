import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool, onbCases, onbEvents, onbCommunications, onbApprovals, organizationsTable, organizationMembershipsTable, onbSettings, accessNamedGrants } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { OFFLINE_CASE_EXAMPLES, OFFLINE_EXAMPLE_PREFIX } from "./offline-example-inventory";
import { CURATED_OFFLINE_EXAMPLES, OFFLINE_EXTENSION_EXAMPLES, OFFLINE_EXTENSION_PREFIX } from "./offline-example-extension";
import { assertOfflineExampleProvisioning, OFFLINE_EXAMPLE_CONFIRMATION, OFFLINE_EXTENSION_CONFIRMATION, provisionOfflineExtensionInTransaction, provisionOfflineExamplesInTransaction, provisionOfflineExampleReadAccess } from "./offline-case-examples";
import { demoPrincipalSettingKey } from "../demo-principal";
import { isFictionalOfflineExampleCase } from "./offline-example-display";
import { HRO_BATCH_TEMPLATES, readHroBatchRequest } from "./hro-batch-templates";
import { isHistoricalTestRecord } from "./historical-test-record";
import { isSyntheticOfflineCase, sampleCandidateEmailEligible } from "./synthetic-offline";
import { calculateOutcomeKpis } from "./outcome-kpis";

// Private schema, not a tenant in the running application's tables. Workers
// cannot see these fixtures; the provisioning helper still verifies Demo identity.
const namespace = `offline_examples_${randomUUID().replaceAll("-", "")}`;
let fixturePool: pg.Pool;
let fixtureDb: typeof db;
before(async () => {
  await pool.query(`CREATE SCHEMA "${namespace}"`);
  await pool.query(`CREATE TABLE "${namespace}".organizations (LIKE public.organizations INCLUDING ALL)`);
  // Do not copy the public serial sequence: private test IDs must not consume live IDs.
  await pool.query(`CREATE TABLE "${namespace}".onb_cases (LIKE public.onb_cases INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
  await pool.query(`CREATE SEQUENCE "${namespace}".case_ids`);
  await pool.query(`ALTER TABLE "${namespace}".onb_cases ALTER COLUMN id SET DEFAULT nextval('"${namespace}".case_ids')`);
  for (const table of ["onb_events", "onb_communications", "onb_approvals", "organization_memberships", "access_named_grants"]) {
    await pool.query(`CREATE TABLE "${namespace}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    await pool.query(`CREATE SEQUENCE "${namespace}"."${table}_ids"`);
    await pool.query(`ALTER TABLE "${namespace}"."${table}" ALTER COLUMN id SET DEFAULT nextval('"${namespace}"."${table}_ids"')`);
  }
  await pool.query(`CREATE TABLE "${namespace}".onb_settings (LIKE public.onb_settings INCLUDING ALL)`);
  fixturePool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${namespace},public` });
  fixtureDb = drizzle(fixturePool, { schema });
  await fixtureDb.insert(organizationsTable).values({
    id: "demo", slug: "demo", name: "Demo Organization", joinCodeHash: namespace, createdByUserId: "fixture",
  });
  for (const user of ["registered-reviewer", "registered-administrator", "ordinary-member", "revoked-reviewer"]) {
    await fixtureDb.insert(organizationMembershipsTable).values({
      organizationId: "demo", clerkUserId: user, role: "member",
      revokedAt: user === "revoked-reviewer" ? new Date() : null,
    });
    if (user !== "ordinary-member") await fixtureDb.insert(onbSettings).values({
      organizationId: "demo", key: demoPrincipalSettingKey(user),
      value: user === "registered-administrator" ? "administrator" : "reviewer",
    });
  }
});
after(async () => {
  await fixturePool?.end();
  await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
});

test("inventory has sixty distinct additional slots, five per supported family, with conservative offline evidence", () => {
  assert.equal(createHash("sha256").update(JSON.stringify(OFFLINE_CASE_EXAMPLES)).digest("hex"),
    "1ffa394863d131de213b7c0f94b9ba7618bcc2fdc4556e47a421c7e87f99614b",
    "Original fixed inventory values and identities must remain unchanged");
  assert.equal(OFFLINE_CASE_EXAMPLES.length, 60);
  assert.equal(new Set(OFFLINE_CASE_EXAMPLES.map(item => item.key)).size, 60);
  assert.equal(new Set(OFFLINE_CASE_EXAMPLES.map(item => item.values.workerName)).size, 60);
  const counts = new Map<string, number>();
  for (const item of OFFLINE_CASE_EXAMPLES) {
    counts.set(item.family, (counts.get(item.family) ?? 0) + 1);
    const request = readHroBatchRequest(item.values.processPolicySnapshot);
    assert.equal(request?.family, item.family);
    assert.equal(request?.requestType, item.title);
    assert.match(item.values.workerEmail, /@hro\.invalid$/);
    assert.equal(item.values.workerPhone, null);
    assert.equal(item.values.controllerRetired, true);
    assert.equal(item.values.offerAcceptanceComplete, false);
    assert.equal(isHistoricalTestRecord(item.values), true);
    assert.equal(isSyntheticOfflineCase({ ...item.values, notes: null }), true);
    assert.equal(sampleCandidateEmailEligible({ ...item.values, notes: null, workerEmail: "real@provider.com" }), false);
    assert.equal(isFictionalOfflineExampleCase({ organizationId: "demo", ...item.values }), true);
    assert.equal(isFictionalOfflineExampleCase({ organizationId: "client", ...item.values }), false);
    assert.equal(isFictionalOfflineExampleCase({ organizationId: "demo", ...item.values, workerEmail: "volunteer@provider.com" }), false);
    assert.equal(isFictionalOfflineExampleCase({ organizationId: "demo", ...item.values, candidateEmailAuthorizedAt: new Date() }), false);
    assert.ok(item.values.readiness.every(row => row.status === "pending"));
    assert.ok(item.values.workstreams.every(row => row.status === "pending"));
    assert.ok(item.key.startsWith(OFFLINE_EXAMPLE_PREFIX));
  }
  assert.equal(counts.size, 12);
  assert.ok([...counts.values()].every(count => count === 5));
  assert.equal(calculateOutcomeKpis({
    cases: OFFLINE_CASE_EXAMPLES.map((item, index) => ({ ...item.values, id: index, createdAt: new Date() })),
    asOf: new Date(),
  }).caseCount, 0);
});

test("wrong tenant and missing confirmation fail before any database operation", () => {
  for (const tenant of ["client", "", "Demo", "demo-copy"]) {
    assert.throws(() => assertOfflineExampleProvisioning(tenant, OFFLINE_EXAMPLE_CONFIRMATION));
  }
  assert.throws(() => assertOfflineExampleProvisioning("demo", ""));
});

test("extension CLI rejects published mode and unconfirmed development before building or provisioning", () => {
  for (const [mode, confirmation] of [
    ["production", OFFLINE_EXTENSION_CONFIRMATION],
    ["test", OFFLINE_EXTENSION_CONFIRMATION],
    ["development", "unconfirmed"],
  ]) {
    const result = spawnSync(process.execPath, ["run-offline-examples.mjs", confirmation!], {
      env: { ...process.env, NODE_ENV: mode },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Development-only operation/);
  }
});

test("extension has ten substantive curated scenarios per family using supported template attributes", () => {
  assert.equal(OFFLINE_EXTENSION_EXAMPLES.length, 60);
  assert.equal(CURATED_OFFLINE_EXAMPLES.length, 120);
  assert.equal(new Set(CURATED_OFFLINE_EXAMPLES.map(item => item.key)).size, 120);
  assert.equal(new Set(CURATED_OFFLINE_EXAMPLES.map(item => item.values.workerName)).size, 120);
  for (const family of new Set(CURATED_OFFLINE_EXAMPLES.map(item => item.family))) {
    const examples = CURATED_OFFLINE_EXAMPLES.filter(item => item.family === family);
    assert.equal(examples.length, 10);
    assert.equal(new Set(examples.map(item => item.title)).size, 10);
    assert.equal(new Set(examples.map(item => item.summary)).size, 10);
    const added = OFFLINE_EXTENSION_EXAMPLES.filter(item => item.family === family);
    const shapes = added.map(item => {
      const { request_id, worker_name, worker_email, work_country, legal_entity, department, employee_id, ...specific } =
        item.values.processPolicySnapshot.batchIntake.data;
      return JSON.stringify(specific);
    });
    assert.equal(new Set(shapes).size, 5, `${family} must vary meaningful structured request attributes`);
  }
  for (const item of OFFLINE_EXTENSION_EXAMPLES) {
    const request = readHroBatchRequest(item.values.processPolicySnapshot)!;
    const template = HRO_BATCH_TEMPLATES.find(template => template.id === request.templateId)!;
    assert.equal(request.family, item.family);
    assert.equal(request.requestType, item.title);
    assert.deepEqual(Object.keys(request.data).sort(), template.columns.map(column => column.key).sort());
    assert.equal(item.values.hireType, template.hireType ?? OFFLINE_CASE_EXAMPLES.find(base => base.family === item.family)!.values.hireType);
    assert.ok(item.key.startsWith(OFFLINE_EXTENSION_PREFIX));
    assert.match(item.values.workerEmail, /@hro\.invalid$/);
    assert.equal(item.values.workerPhone, null);
    assert.equal(item.values.controllerRetired, true);
    assert.equal(item.values.orchestrationStatus, "blocked");
    assert.equal(item.values.offerAcceptanceComplete, false);
    assert.equal(item.values.candidateEmailAuthorizedAt, null);
    assert.equal(isHistoricalTestRecord(item.values), true);
    assert.equal(isSyntheticOfflineCase({ ...item.values, notes: null }), true);
    assert.equal(sampleCandidateEmailEligible({ ...item.values, workerEmail: "real@provider.com", notes: null }), false);
    assert.equal(isFictionalOfflineExampleCase({ organizationId: "demo", ...item.values }), true);
    assert.ok(item.values.readiness.every(row => row.status === "pending"));
    assert.ok(item.values.workstreams.every(row => row.status === "pending"));
    assert.deepEqual(item.values.checklistSnapshot, []);
    assert.match(item.values.planSummary, /all evidence and human decisions remain pending/);
    if (item.family === "Offboarding") assert.match(item.summary, /closure is unavailable/i);
  }
  assert.deepEqual(OFFLINE_EXTENSION_EXAMPLES.filter(item => item.family === "Onboarding")
    .map(item => item.values.hireType), ["contractor", "rehire", "campus-cohort", "expedited", "external-fte"]);
  assert.equal(calculateOutcomeKpis({
    cases: CURATED_OFFLINE_EXAMPLES.map((item, index) => ({ ...item.values, id: index, createdAt: new Date() })),
    asOf: new Date(),
  }).caseCount, 0);
});

test("legacy display recognizes only the exact reserved coverage identity, never mutable markers alone", () => {
  const row = {
    organizationId: "demo", scenarioKey: "UAT-DEMO-COVERAGE:standard-fte",
    syntheticProvenance: null, workerName: "Demo sample — Standard external FTE",
    workerEmail: "demo-standard-fte@hro.invalid", workerPhone: null, notes: null,
    candidateEmailAuthorizedAt: null, candidateEmailAuthorizedBy: null,
  };
  assert.equal(isFictionalOfflineExampleCase(row), true);
  assert.equal(isFictionalOfflineExampleCase({ ...row, scenarioKey: "UAT-OTHER" }), false);
  assert.equal(isFictionalOfflineExampleCase({ ...row, workerName: "Unverified person" }), false);
  assert.equal(isFictionalOfflineExampleCase({ ...row, workerEmail: "person@mailhost.com" }), false);
  assert.equal(isFictionalOfflineExampleCase({ ...row, scenarioKey: null, notes: "[synthetic-offline-reset:v1]" }), false);
});

test("concurrent attempts and reruns add exactly sixty rows, never count or modify old coverage", async () => {
  const [old] = await fixtureDb.insert(onbCases).values({
    organizationId: "demo", ...OFFLINE_CASE_EXAMPLES[0]!.values,
    scenarioKey: "UAT-DEMO-COVERAGE:standard-fte",
    syntheticProvenance: null,
    workerName: "Demo sample — Standard external FTE",
    workerEmail: "demo-standard-fte@hro.invalid",
    notes: "Historical evidence with retained private file reference",
    checklistSnapshot: [{ id: "old", label: "Existing evidence", order: 1, enabled: true, mandatory: true, enforcementStage: "before-workstreams" }],
  }).returning();
  const [oldEvent] = await fixtureDb.insert(onbEvents).values({
    organizationId: "demo", caseId: old!.id, agent: "fixture", engine: "fixture",
    title: "Retained evidence", detail: "private://fixture/old-file-reference",
  }).returning();
  const [oldCommunication] = await fixtureDb.insert(onbCommunications).values({
    organizationId: "demo", caseId: old!.id, channel: "email", direction: "inbound",
    toAddress: "old@hro.invalid", body: "Retained historical content", status: "received",
  }).returning();
  const [oldApproval] = await fixtureDb.insert(onbApprovals).values({
    organizationId: "demo", caseId: old!.id, agent: "fixture", recommendation: "Retained proposal",
    rationale: "Retained evidence", status: "pending",
  }).returning();
  const run = () => fixtureDb.transaction(tx => provisionOfflineExamplesInTransaction(tx, "demo", OFFLINE_EXAMPLE_CONFIRMATION));
  const results = await Promise.all([run(), run(), run()]);
  assert.deepEqual(results.map(result => result.created).sort((a, b) => a - b), [0, 0, 60]);
  assert.equal((await run()).created, 0);
  assert.equal((await fixtureDb.select().from(onbCases)).length, 61);
  assert.deepEqual((await fixtureDb.select().from(onbCases).where(eq(onbCases.id, old!.id)))[0], old);
  assert.deepEqual(await fixtureDb.select().from(onbEvents), [oldEvent]);
  assert.deepEqual(await fixtureDb.select().from(onbCommunications), [oldCommunication]);
  assert.deepEqual(await fixtureDb.select().from(onbApprovals), [oldApproval]);
  const { rows: [counts] } = await fixtureDb.execute(sql`SELECT count(*)::int AS count FROM onb_cases WHERE organization_id <> 'demo'`);
  assert.equal(counts?.count, 0);
});

test("extension rejects wrong confirmation, wrong tenant, and a missing original baseline", async () => {
  const run = (tenant: string, confirmation: string) => fixtureDb.transaction(tx =>
    provisionOfflineExtensionInTransaction(tx, tenant, confirmation));
  const beforeRows = await fixtureDb.select().from(onbCases);
  for (const tenant of ["client", "", "Demo", "demo-copy"]) {
    await assert.rejects(run(tenant, OFFLINE_EXTENSION_CONFIRMATION), /explicitly confirmed/);
  }
  await assert.rejects(run("demo", OFFLINE_EXAMPLE_CONFIRMATION), /explicitly confirmed/);
  const first = OFFLINE_CASE_EXAMPLES[0]!;
  await fixtureDb.update(onbCases).set({ scenarioKey: "fixture-temporary-key" }).where(eq(onbCases.scenarioKey, first.key));
  await assert.rejects(run("demo", OFFLINE_EXTENSION_CONFIRMATION), /original sixty/);
  await fixtureDb.update(onbCases).set({ scenarioKey: first.key }).where(eq(onbCases.scenarioKey, "fixture-temporary-key"));
  assert.deepEqual(await fixtureDb.select().from(onbCases).orderBy(onbCases.id), beforeRows.sort((a, b) => a.id - b.id));
});

test("concurrent extension creates exactly sixty additions; original cases, grants and evidence remain unchanged", async () => {
  const beforeRows = await fixtureDb.select().from(onbCases).orderBy(onbCases.id);
  const evidence = await Promise.all([
    fixtureDb.select().from(onbEvents), fixtureDb.select().from(onbCommunications), fixtureDb.select().from(onbApprovals),
  ]);
  const grants = await fixtureDb.select().from(accessNamedGrants).orderBy(accessNamedGrants.id);
  const run = () => fixtureDb.transaction(tx => provisionOfflineExtensionInTransaction(tx, "demo", OFFLINE_EXTENSION_CONFIRMATION));
  const results = await Promise.all([run(), run(), run()]);
  assert.deepEqual(results.map(result => result.created).sort((a, b) => a - b), [0, 0, 60]);
  assert.ok(Object.values(results[0]!.families).every(count => count === 10));
  assert.equal((await run()).created, 0);
  const rows = await fixtureDb.select().from(onbCases).orderBy(onbCases.id);
  assert.equal(rows.length, 121);
  assert.deepEqual(rows.filter(row => beforeRows.some(old => old.id === row.id)), beforeRows);
  assert.deepEqual(await Promise.all([
    fixtureDb.select().from(onbEvents), fixtureDb.select().from(onbCommunications), fixtureDb.select().from(onbApprovals),
  ]), evidence);
  assert.deepEqual((await fixtureDb.select().from(accessNamedGrants).orderBy(accessNamedGrants.id))
    .filter(row => grants.some(old => old.id === row.id)), grants);
  assert.equal((await fixtureDb.transaction(tx => provisionOfflineExamplesInTransaction(tx, "demo", OFFLINE_EXAMPLE_CONFIRMATION))).total, 60,
    "Original command must keep its original meaning");
});

test("extension duplicate, cross-tenant and conflicting slots fail closed without touching evidence", async () => {
  const first = OFFLINE_EXTENSION_EXAMPLES[0]!;
  const [row] = await fixtureDb.select().from(onbCases).where(eq(onbCases.scenarioKey, first.key));
  const beforeRows = await fixtureDb.select().from(onbCases).orderBy(onbCases.id);
  const run = () => fixtureDb.transaction(tx => provisionOfflineExtensionInTransaction(tx, "demo", OFFLINE_EXTENSION_CONFIRMATION));
  const [duplicate] = await fixtureDb.insert(onbCases).values({ organizationId: "demo", ...first.values }).returning();
  await assert.rejects(run(), /duplicated or has conflicting/);
  await fixtureDb.delete(onbCases).where(eq(onbCases.id, duplicate!.id));
  for (const change of [{ organizationId: "client" }, { notes: "Retained conflicting evidence" }]) {
    await fixtureDb.update(onbCases).set(change).where(eq(onbCases.id, row!.id));
    await assert.rejects(run(), /duplicated or has conflicting/);
    await fixtureDb.update(onbCases).set({ organizationId: row!.organizationId, notes: row!.notes }).where(eq(onbCases.id, row!.id));
  }
  assert.deepEqual(await fixtureDb.select().from(onbCases).orderBy(onbCases.id), beforeRows);
});

test("conflicting slots fail closed without repairing or replacing existing evidence", async () => {
  const first = OFFLINE_CASE_EXAMPLES[0]!;
  await fixtureDb.update(onbCases).set({ notes: "Retained conflicting evidence" }).where(eq(onbCases.scenarioKey, first.key));
  const beforeRows = await fixtureDb.select().from(onbCases);
  await assert.rejects(fixtureDb.transaction(tx => provisionOfflineExamplesInTransaction(tx, "demo", OFFLINE_EXAMPLE_CONFIRMATION)), /conflicting data/);
  assert.deepEqual(await fixtureDb.select().from(onbCases), beforeRows);
});

test("only active registered Demo profiles receive exact read grants; retries never revive revoked access", async () => {
  const grants = await fixtureDb.select().from(accessNamedGrants);
  assert.equal(grants.length, 121 * 4 * 2);
  assert.ok(grants.every(grant => ["registered-reviewer", "registered-administrator"].includes(grant.principalId)));
  assert.ok(grants.every(grant => grant.scope === "case" && grant.effect === "allow" && grant.source === "named" &&
    ["flow.case.read", "data.case.profile.read", "data.case.notes.read", "data.case.readiness.read"].includes(grant.resourceKey)));
  for (const grant of [grants[0]!, grants.at(-1)!]) {
    await fixtureDb.update(accessNamedGrants).set({ revokedAt: new Date(), effect: "deny" }).where(eq(accessNamedGrants.id, grant.id));
  }
  const before = await fixtureDb.select().from(accessNamedGrants);
  assert.equal(await fixtureDb.transaction(tx => provisionOfflineExampleReadAccess(tx, "demo", OFFLINE_EXAMPLE_CONFIRMATION)), 0);
  await assert.rejects(fixtureDb.transaction(tx => provisionOfflineExtensionInTransaction(tx, "demo", OFFLINE_EXTENSION_CONFIRMATION)), /conflicting data/);
  assert.deepEqual(await fixtureDb.select().from(accessNamedGrants), before);
});

test("Demo identity mismatch is denied, even with the exact reserved tenant ID", async () => {
  await fixtureDb.update(organizationsTable).set({ name: "Real client" }).where(eq(organizationsTable.id, "demo"));
  await assert.rejects(fixtureDb.transaction(tx => provisionOfflineExamplesInTransaction(tx, "demo", OFFLINE_EXAMPLE_CONFIRMATION)), /identity could not be verified/);
  await assert.rejects(fixtureDb.transaction(tx => provisionOfflineExtensionInTransaction(tx, "demo", OFFLINE_EXTENSION_CONFIRMATION)), /identity could not be verified/);
});
