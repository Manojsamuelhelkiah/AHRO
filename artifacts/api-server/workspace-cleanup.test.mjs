import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createIsolatedTestDatabase } from "./isolated-test-database.mjs";
import { cleanupWorkspaces, HCLTECH_ID, inventoryWorkspaces, validateScope } from "./workspace-cleanup.mjs";

test("explicit scope rejects protected, unverified, duplicate and broad requests", () => {
  const manifest = [{ id: "fixture", evidence: "reviewed" }];
  for (const id of ["demo", HCLTECH_ID, "platform-audit"])
    assert.throws(() => validateScope([id], manifest), /Protected/);
  assert.throws(() => validateScope(["unknown"], manifest), /Unverified/);
  for (const ids of [[], ["fixture", "fixture"], Array(9).fill("fixture"), "*", undefined])
    assert.throws(() => validateScope(ids, manifest), /explicit/);
});

test("isolated cleanup is empty-only, rollback-safe, privately recoverable and idempotent", async () => {
  const owned = await createIsolatedTestDatabase(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: owned.connectionString });
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-cleanup-"));
  let snapshot = 0;
  const manifest = [
    { id: "empty-fixture", name: "Empty fixture", slug: "empty-fixture", creator: "test-owner", evidence: "owned test" },
    { id: "changed-fixture", name: "Changed fixture", slug: "changed-fixture", creator: "test-owner", evidence: "owned test" },
    { id: "substantive-fixture", name: "Substantive fixture", slug: "substantive-fixture", creator: "test-owner", evidence: "owned test" },
  ];
  const clean = (ids, options = {}) => cleanupWorkspaces(pool, {
    ids, manifest, snapshotPath: path.join(directory, `${snapshot++}.json`), ...options,
  });
  try {
    await pool.query(`INSERT INTO organizations(id,name,slug,join_code_hash,created_by_user_id)
      VALUES($1,'HCLTech','hcltech','protected-hash','genuine-owner')`, [HCLTECH_ID]);
    for (const row of manifest) await pool.query(
      "INSERT INTO organizations(id,name,slug,join_code_hash,created_by_user_id) VALUES($1,$2,$3,$1,$4)",
      [row.id, row.name, row.slug, row.creator]);
    await pool.query("UPDATE organizations SET created_by_user_id='unverified' WHERE id='changed-fixture'");
    await pool.query("CREATE TABLE cleanup_hold_fixture (organization_id text REFERENCES organizations(id) ON DELETE CASCADE, held boolean)");
    await pool.query("INSERT INTO cleanup_hold_fixture VALUES('substantive-fixture',true)");
    await pool.query("INSERT INTO onb_settings(organization_id,key,value) VALUES($1,'preserved-configuration','keep')", [HCLTECH_ID]);
    const before = (await pool.query("SELECT * FROM organizations ORDER BY id")).rows;
    await assert.rejects(clean(["empty-fixture", "changed-fixture"]), /provenance changed/);
    await assert.rejects(clean(["empty-fixture", "substantive-fixture"]), /dependencies/);
    assert.deepEqual((await pool.query("SELECT * FROM organizations ORDER BY id")).rows, before);
    await assert.rejects(clean(["empty-fixture"], { failAfterDelete: true }), /Injected failure/);
    assert.deepEqual((await pool.query("SELECT * FROM organizations ORDER BY id")).rows, before);
    const inventory = await inventoryWorkspaces(pool, manifest);
    assert.equal(inventory.find(row => row.id === "changed-fixture").disposition, "retain");
    assert.equal(inventory.find(row => row.id === "substantive-fixture").disposition, "retain");
    const recovery = path.join(directory, "recovery.json");
    assert.deepEqual((await clean(["empty-fixture"], { snapshotPath: recovery })).removed, ["empty-fixture"]);
    assert.equal((await stat(recovery)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(recovery, "utf8"));
    assert.equal(saved.rows[0].id, "empty-fixture");
    assert.deepEqual((await clean(["empty-fixture"])).alreadyAbsent, ["empty-fixture"]);
    assert.equal((await pool.query("SELECT value FROM onb_settings WHERE organization_id=$1", [HCLTECH_ID])).rows[0].value, "keep");
    // Exercise private snapshot recovery using parameters, not generated SQL.
    const row = saved.rows[0];
    await pool.query(`INSERT INTO organizations(id,name,slug,primary_country,join_code_hash,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.id,row.name,row.slug,row.primary_country,row.join_code_hash,row.created_by_user_id,row.created_at,row.updated_at]);
    assert.deepEqual((await pool.query("SELECT * FROM organizations ORDER BY id")).rows, before);
    await pool.query("UPDATE organizations SET name='Renamed protected client' WHERE id=$1", [HCLTECH_ID]);
    await assert.rejects(clean(["empty-fixture"]), /false == true|assertion/i);
  } finally {
    await pool.end();
    await owned.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned schema disposal removes created workspace IDs even after an assertion failure", async () => {
  const owned = await createIsolatedTestDatabase(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: owned.connectionString });
  try {
    await pool.query("INSERT INTO organizations(id,name,slug,join_code_hash,created_by_user_id) VALUES('assertion-failure','Fixture','assertion-failure','fixture','test-owner')");
    assert.throws(() => assert.fail("ordinary regression assertion failure"));
  } finally {
    await pool.end();
    await owned.dispose(); // also asserts everyday ID list is unchanged
  }
  const root = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    assert.equal((await root.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1", [owned.schema])).rows[0].n, 0);
    assert.equal((await root.query("SELECT count(*)::int n FROM organizations WHERE id='assertion-failure'")).rows[0].n, 0);
  } finally { await root.end(); }
});
