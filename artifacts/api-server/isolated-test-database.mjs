import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";

export const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`;

/** No shared search_path fallback, including in historical qualified FKs. */
export async function createIsolatedTestDatabase(connectionString, prefix = "workspace_regression") {
  if (process.env.NODE_ENV === "production") throw new Error("Test database requires a non-production process");
  assert(/^[a-z_]+$/.test(prefix));
  const schema = `${prefix}_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString });
  let created = false;
  let interrupted = false;
  const interruptStartup = () => { interrupted = true; };
  process.once("SIGINT", interruptStartup);
  process.once("SIGTERM", interruptStartup);
  let baseline;
  async function dispose() {
    try {
      if (created) {
        await root.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
        created = false;
      }
      if (baseline) assert.deepEqual((await root.query("SELECT id FROM organizations ORDER BY id")).rows, baseline,
        "Everyday organization IDs changed during isolated regression");
    } finally {
      await root.end();
    }
  }
  try {
    baseline = (await root.query("SELECT id FROM organizations ORDER BY id")).rows;
    await root.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    const crypto = (await root.query(`
      SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
      WHERE e.extname='pgcrypto'`)).rows[0]?.nspname;
    if (crypto) await root.query(`
      CREATE FUNCTION ${quoteIdentifier(schema)}.digest(text,text) RETURNS bytea
      LANGUAGE sql IMMUTABLE STRICT AS 'SELECT ${quoteIdentifier(crypto)}.digest($1,$2)'`);
    const url = new URL(connectionString);
    url.searchParams.set("options", `-c search_path=${quoteIdentifier(schema)}`);
    const pool = new Pool({ connectionString: url.toString() });
    try {
      const database = drizzle(pool);
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(new URL("../../lib/db/drizzle", import.meta.url)),
      }).map(migration => ({
        ...migration,
        // Replay copies only: never edit historical migration bytes/ledgers.
        sql: migration.sql.map(sql => sql.replaceAll('"public".', `${quoteIdentifier(schema)}.`)),
      }));
      await database.dialect.migrate(migrations, database.session, { migrationsSchema: schema });
      assert.equal((await pool.query("SELECT current_schema() AS s")).rows[0].s, schema);
      const escaped = await pool.query(`
        SELECT c.conname FROM pg_constraint c
        JOIN pg_class child ON child.oid=c.conrelid
        JOIN pg_namespace cn ON cn.oid=child.relnamespace
        JOIN pg_class parent ON parent.oid=c.confrelid
        JOIN pg_namespace pn ON pn.oid=parent.relnamespace
        WHERE c.contype='f' AND cn.nspname=$1 AND pn.nspname<>$1`, [schema]);
      assert.equal(escaped.rowCount, 0, "Disposable test foreign keys escaped their schema");
    } finally {
      await pool.end();
    }
    if (interrupted) throw new Error("Isolated test startup interrupted; owned schema discarded");
    return { schema, connectionString: url.toString(), dispose };
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    process.removeListener("SIGINT", interruptStartup);
    process.removeListener("SIGTERM", interruptStartup);
  }
}
