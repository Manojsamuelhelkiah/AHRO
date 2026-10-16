import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, pool, onbJobProfiles, organizationsTable } from "@workspace/db";
import onboardingRouter from "../../routes/onboarding";
import { assertDemoJobProfileDevelopment, DEMO_JOB_PROFILE_PROVENANCE, DEMO_JOB_PROFILE_STARTERS, provisionDemoJobProfiles } from "./demo-job-profiles";

after(() => pool.end());

test("starters are additive, development-only, isolated, race-safe and maintainable via normal catalog routes", async () => {
  assert.match(String((await db.execute(sql`select current_schema() as name`)).rows[0].name), /^workspace_regression_/);
  assert.throws(() => assertDemoJobProfileDevelopment({ NODE_ENV: "production" }));
  assert.throws(() => assertDemoJobProfileDevelopment({ NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" }));
  assert.throws(() => assertDemoJobProfileDevelopment({}));
  process.env.NODE_ENV = "development";
  await db.insert(organizationsTable).values(["demo", "other"].map(id => ({
    id, name: id === "demo" ? "Demo Organization" : "Other client", slug: id,
    joinCodeHash: `test-${id}`, createdByUserId: "fixture",
  }))).onConflictDoNothing();
  await db.delete(onbJobProfiles);
  const beforeOther = await db.select().from(onbJobProfiles).where(eq(onbJobProfiles.organizationId, "other"));
  const concurrent = await Promise.all([provisionDemoJobProfiles(), provisionDemoJobProfiles()]);
  assert.deepEqual(concurrent.map(r => r.added.length).sort(), [0, 5]);
  const first = await db.select().from(onbJobProfiles).where(eq(onbJobProfiles.organizationId, "demo"));
  assert.equal(first.length, 5);
  for (const starter of DEMO_JOB_PROFILE_STARTERS) {
    const row = first.find(r => r.profileId === starter.profileId)!;
    assert.equal(row.name, starter.name);
    assert.equal(row.version, 1);
    assert.equal(row.enabled, true);
    assert.equal(row.createdBy, DEMO_JOB_PROFILE_PROVENANCE);
    assert.deepEqual(row.context, { roleFamily: starter.name });
  }
  assert.equal((await provisionDemoJobProfiles()).added.length, 0);
  assert.deepEqual(await db.select().from(onbJobProfiles).where(eq(onbJobProfiles.organizationId, "demo")), first);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = req.header("X-Test-Tenant") ?? "demo";
    req.organizationRole = req.header("X-Test-Role") === "member" ? "member" : "owner";
    req.authUserId = "fixture-owner";
    next();
  });
  app.use(onboardingRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/onboarding/job-profiles`;
  const save = (body: unknown, headers = {}) => fetch(base, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  try {
    const catalog = await (await fetch(base)).json() as typeof first;
    assert.equal(catalog.length, 5);
    assert.ok(catalog.some(r => r.profileId === "JP-OPS-1047" && r.enabled));
    const edited = { profileId: "JP-OPS-1047", expectedVersion: 1, name: "Edited operations", context: { roleFamily: "Operations support" }, enabled: false };
    assert.equal((await save(edited, { "X-Test-Role": "member" })).status, 403);
    assert.equal((await save(edited)).status, 201);
    assert.equal((await save(edited)).status, 409);
    assert.equal((await save({ name: "Added by owner", context: { roleFamily: "Support" }, enabled: true })).status, 201);
    assert.deepEqual(await (await fetch(base, { headers: { "X-Test-Tenant": "other" } })).json(), []);
    // Even an existing ID with no version-one row must remain wholly untouched.
    await db.delete(onbJobProfiles).where(and(eq(onbJobProfiles.organizationId, "demo"), eq(onbJobProfiles.profileId, "JP-HR-1001")));
    await db.insert(onbJobProfiles).values({ ...first.find(r => r.profileId === "JP-HR-1001")!, version: 7, enabled: false });
    const editedRows = await db.select().from(onbJobProfiles).where(eq(onbJobProfiles.organizationId, "demo")).orderBy(onbJobProfiles.profileId, desc(onbJobProfiles.version));
    assert.equal((await provisionDemoJobProfiles()).added.length, 0);
    assert.deepEqual(await db.select().from(onbJobProfiles).where(eq(onbJobProfiles.organizationId, "demo")).orderBy(onbJobProfiles.profileId, desc(onbJobProfiles.version)), editedRows);
    assert.deepEqual(await db.select().from(onbJobProfiles).where(eq(onbJobProfiles.organizationId, "other")), beforeOther);
    // A manual insert can already be uncommitted when provisioning begins.
    // Waiting on its ordinary INSERT lock must reveal it, not add version one.
    await db.delete(onbJobProfiles).where(and(eq(onbJobProfiles.organizationId, "demo"), eq(onbJobProfiles.profileId, "JP-CS-1001")));
    let release!: () => void;
    let inserted!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { inserted = resolve; });
    const manual = db.transaction(async tx => {
      await tx.insert(onbJobProfiles).values({
        ...first.find(r => r.profileId === "JP-CS-1001")!, version: 9,
        name: "Manual retired profile", enabled: false, createdBy: "fixture-owner",
      });
      inserted();
      await hold;
    });
    await ready;
    const provision = provisionDemoJobProfiles();
    release();
    await manual;
    assert.equal((await provision).added.length, 0);
    const manualRows = await db.select().from(onbJobProfiles).where(and(eq(onbJobProfiles.organizationId, "demo"), eq(onbJobProfiles.profileId, "JP-CS-1001")));
    assert.equal(manualRows.length, 1);
    assert.equal(manualRows[0].version, 9);
    assert.equal(manualRows[0].enabled, false);
    assert.equal(manualRows[0].name, "Manual retired profile");
    await db.update(organizationsTable).set({ name: "Not Demo" }).where(eq(organizationsTable.id, "demo"));
    await assert.rejects(provisionDemoJobProfiles(), /identity/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
