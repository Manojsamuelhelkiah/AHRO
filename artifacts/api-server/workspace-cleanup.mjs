import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { quoteIdentifier as q } from "./isolated-test-database.mjs";

export const HCLTECH_ID = "org_654eb2bb-23cb-489a-9cc3-50faeddcfd3c";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validateScope(ids, manifest) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length)
    throw new Error("Cleanup requires 1–8 distinct explicit reviewed IDs");
  const verified = new Map(manifest.map(row => [row.id, row]));
  for (const id of ids) {
    if (id === "demo" || id === HCLTECH_ID || id === "platform-audit")
      throw new Error("Protected workspace cannot be removed");
    if (!verified.has(id) || !verified.get(id).evidence)
      throw new Error("Unverified workspace cannot be removed");
  }
}

async function dependencies(client, schema) {
  // Include tenant columns even without FKs and every incoming FK, including
  // accidental cross-schema references from historical isolated harnesses.
  const result = await client.query(`
    SELECT DISTINCT table_schema AS schema, table_name AS table, column_name AS column
    FROM information_schema.columns
    WHERE table_schema=$1 AND column_name IN ('organization_id','tenant_id')
    UNION
    SELECT ns.nspname, rel.relname, a.attname
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid=c.conrelid
    JOIN pg_namespace ns ON ns.oid=rel.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.contype='f' AND c.confrelid=($1 || '.organizations')::regclass
    ORDER BY 1,2,3`, [schema]);
  return result.rows;
}

async function countsFor(client, refs, id) {
  const counts = {};
  for (const ref of refs) {
    const n = (await client.query(
      `SELECT count(*)::int n FROM ${q(ref.schema)}.${q(ref.table)} WHERE ${q(ref.column)}::text=$1`,
      [id])).rows[0].n;
    if (n) counts[`${ref.schema}.${ref.table}.${ref.column}`] = n;
  }
  return counts;
}

async function protectedFingerprint(client, refs) {
  const fingerprints = [];
  for (const ref of refs) {
    const row = (await client.query(`
      SELECT md5(coalesce(string_agg(md5(row_to_json(record)::text), ''
        ORDER BY md5(row_to_json(record)::text)), '')) AS fingerprint
      FROM ${q(ref.schema)}.${q(ref.table)} record
      WHERE ${q(ref.column)}::text=ANY($1::text[])`, [["demo", HCLTECH_ID]])).rows[0];
    fingerprints.push([ref, row.fingerprint]);
  }
  return digest(fingerprints);
}

async function verifyProtected(client, schema) {
  const rows = (await client.query(
    `SELECT id,name,slug,created_by_user_id FROM ${q(schema)}.organizations
     WHERE id=ANY($1::text[]) OR lower(name)=ANY($2::text[])`,
    [["demo", HCLTECH_ID], ["demo organization", "demo organisation", "hcltech"]])).rows;
  assert.equal(rows.length, 2, "Protected workspaces must be uniquely identified");
  assert(rows.some(row => row.id === "demo" && row.slug === "demo" &&
    row.created_by_user_id === "system" && /^Demo Organi[sz]ation$/.test(row.name)));
  assert(rows.some(row => row.id === HCLTECH_ID && row.name === "HCLTech"));
}

export async function inventoryWorkspaces(client, manifest) {
  const schema = (await client.query("SELECT current_schema() s")).rows[0].s;
  await verifyProtected(client, schema);
  const refs = await dependencies(client, schema);
  const rows = (await client.query(`SELECT * FROM ${q(schema)}.organizations ORDER BY id`)).rows;
  const reviewed = new Map(manifest.map(row => [row.id, row]));
  const inventory = [];
  for (const row of rows) {
    const counts = await countsFor(client, refs, row.id);
    const proof = reviewed.get(row.id);
    const match = proof && row.name === proof.name && row.slug === proof.slug &&
      row.created_by_user_id === proof.creator;
    const protectedId = ["demo", HCLTECH_ID, "platform-audit"].includes(row.id);
    inventory.push({
      id: row.id, name: row.name, counts,
      disposition: protectedId ? "protected" :
        match && !Object.keys(counts).length ? "verified-empty-fixture" : "retain",
      reason: protectedId ? "Explicitly protected" :
        Object.keys(counts).length ? "Dependent records/configuration/history; not eligible for empty-only cleanup" :
        match ? proof.evidence : "Uncertain provenance; names alone are not evidence",
    });
  }
  return inventory;
}

/** Empty-only local maintenance; no API endpoint, cascade cleanup or providers. */
export async function cleanupWorkspaces(pool, { ids, manifest, snapshotPath, failAfterDelete = false }) {
  validateScope(ids, manifest);
  if (!snapshotPath) throw new Error("Private recovery snapshot required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout='10s'");
    const schema = (await client.query("SELECT current_schema() s")).rows[0].s;
    // Avoid concurrent schema changes, no-FK writes, and new child inserts
    // while classifying and committing. FKs and append-only triggers stay on.
    await client.query(`LOCK TABLE ${q(schema)}.organizations IN SHARE ROW EXCLUSIVE MODE`);
    await verifyProtected(client, schema);
    const refs = await dependencies(client, schema);
    for (const table of [...new Set(refs.map(ref => `${q(ref.schema)}.${q(ref.table)}`))].sort())
      await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    const rows = (await client.query(
      `SELECT * FROM ${q(schema)}.organizations WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, [ids])).rows;
    const reviewed = new Map(manifest.map(row => [row.id, row]));
    for (const row of rows) {
      const proof = reviewed.get(row.id);
      assert(row.name === proof.name && row.slug === proof.slug && row.created_by_user_id === proof.creator,
        "Fixture provenance changed");
      assert.deepEqual(await countsFor(client, refs, row.id), {}, "Unexpected/substantive dependencies: retain workspace");
    }
    // Only parent rows are deleted; all other rows must remain byte-identical.
    const remainingBefore = (await client.query(
      `SELECT * FROM ${q(schema)}.organizations WHERE NOT(id=ANY($1::text[])) ORDER BY id`, [ids])).rows;
    const protectedRecordsBefore = await protectedFingerprint(client, refs);
    await mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
    const file = await open(snapshotPath, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ schema, rows, preservedParentsDigest: digest(remainingBefore),
        protectedRecordsDigest: protectedRecordsBefore }));
      await file.sync();
    } finally { await file.close(); }
    await client.query(`DELETE FROM ${q(schema)}.organizations WHERE id=ANY($1::text[])`, [ids]);
    if (failAfterDelete) throw new Error("Injected failure before commit");
    const remainingAfter = (await client.query(
      `SELECT * FROM ${q(schema)}.organizations ORDER BY id`)).rows;
    assert.equal(digest(remainingAfter), digest(remainingBefore), "Retained workspaces changed");
    assert.equal(await protectedFingerprint(client, refs), protectedRecordsBefore, "Protected records/configuration/access changed");
    await verifyProtected(client, schema);
    await client.query("COMMIT");
    return { removed: rows.map(row => row.id), alreadyAbsent: ids.filter(id => !rows.some(row => row.id === id)),
      retainedCount: remainingAfter.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
