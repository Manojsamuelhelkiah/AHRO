import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const migrationsUrl = new URL("../../lib/db/drizzle/", import.meta.url);
const journalUrl = new URL("meta/_journal.json", migrationsUrl);
const migrationTable = "__api_test_schema_migrations";
const statementBreakpoint = "--> statement-breakpoint";
const advisoryLockKey = 1_514_151;

// These errors mean an old migration's individual DDL statement is already
// represented in a database that predates the test migration ledger.
const adoptablePostgresErrors = new Set([
  "42P07", // duplicate_table (also duplicate indexes)
  "42701", // duplicate_column
  "42710", // duplicate_object (constraints, types)
]);

function migrationHash(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function splitMigration(sql) {
  return sql
    .split(statementBreakpoint)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function rewritePublicSchema(statement, schema) {
  return statement.replaceAll('"public".', `${quoteIdentifier(schema)}.`);
}

export async function loadCheckedInMigrations() {
  const [journalSource, directoryEntries] = await Promise.all([
    readFile(journalUrl, "utf8"),
    readdir(migrationsUrl),
  ]);
  const journal = JSON.parse(journalSource);
  const sqlFiles = new Set(
    directoryEntries.filter((name) => name.endsWith(".sql")),
  );
  const migrations = [];
  const seenTags = new Set();

  for (const entry of journal.entries ?? []) {
    if (
      !entry ||
      typeof entry.tag !== "string" ||
      typeof entry.when !== "number" ||
      seenTags.has(entry.tag)
    ) {
      throw new Error(
        "Database test setup found an invalid or duplicate migration journal entry",
      );
    }
    seenTags.add(entry.tag);

    const filename = `${entry.tag}.sql`;
    if (!sqlFiles.delete(filename)) {
      throw new Error(
        `Database test setup cannot find journal migration ${filename}`,
      );
    }
    const sql = await readFile(new URL(filename, migrationsUrl), "utf8");
    migrations.push({
      tag: entry.tag,
      createdAt: entry.when,
      hash: migrationHash(sql),
      statements: splitMigration(sql),
    });
  }

  if (sqlFiles.size > 0) {
    throw new Error(
      `Database test setup found migrations missing from the journal: ${[...sqlFiles].sort().join(", ")}`,
    );
  }

  return migrations;
}

async function executeForAdoption(client, migration, statement, index) {
  const savepoint = `api_test_migration_${index}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(statement);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    if (!adoptablePostgresErrors.has(error?.code)) {
      throw new Error(
        `Database test setup could not apply ${migration.tag} (statement ${index + 1})`,
        { cause: error },
      );
    }
  }
}

async function applyMigration(client, migration) {
  for (const [index, statement] of migration.statements.entries()) {
    await executeForAdoption(client, migration, statement, index);
  }
  await client.query(
    `
      INSERT INTO ${migrationTable} (tag, hash, created_at)
      VALUES ($1, $2, $3)
    `,
    [migration.tag, migration.hash, migration.createdAt],
  );
}

function normalizeSchemaReference(value, schema) {
  if (value == null) return value;
  return value
    .replaceAll(`"${schema}".`, "")
    .replaceAll(`${schema}.`, "");
}

async function describeSchema(client, schema) {
  const tables = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    `,
    [schema],
  );
  const columns = await client.query(
    `
      SELECT table_name, column_name, data_type, udt_name, is_nullable,
             column_default, character_maximum_length, numeric_precision,
             numeric_scale, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = $1
    `,
    [schema],
  );
  const constraints = await client.query(
    `
      SELECT relation.relname AS table_name,
             constraint_record.conname AS constraint_name,
             constraint_record.contype AS constraint_type,
             pg_get_constraintdef(constraint_record.oid, true) AS definition
      FROM pg_constraint constraint_record
      JOIN pg_class relation ON relation.oid = constraint_record.conrelid
      JOIN pg_namespace namespace_record
        ON namespace_record.oid = relation.relnamespace
      WHERE namespace_record.nspname = $1
    `,
    [schema],
  );
  const indexes = await client.query(
    `
      SELECT relation.relname AS table_name,
             index_relation.relname AS index_name,
             index_record.indisunique AS is_unique,
             index_record.indisprimary AS is_primary,
             pg_get_indexdef(index_record.indexrelid, 0, true) AS definition,
             pg_get_expr(
               index_record.indpred,
               index_record.indrelid,
               true
             ) AS predicate
      FROM pg_index index_record
      JOIN pg_class relation ON relation.oid = index_record.indrelid
      JOIN pg_class index_relation
        ON index_relation.oid = index_record.indexrelid
      JOIN pg_namespace namespace_record
        ON namespace_record.oid = relation.relnamespace
      WHERE namespace_record.nspname = $1
    `,
    [schema],
  );

  return {
    tables: new Set(tables.rows.map(({ table_name }) => table_name)),
    columns: new Map(
      columns.rows.map((row) => [
        `${row.table_name}.${row.column_name}`,
        {
          dataType: row.data_type,
          udtName: row.udt_name,
          nullable: row.is_nullable,
          default: normalizeSchemaReference(row.column_default, schema),
          characterMaximumLength: row.character_maximum_length,
          numericPrecision: row.numeric_precision,
          numericScale: row.numeric_scale,
          datetimePrecision: row.datetime_precision,
        },
      ]),
    ),
    constraints: new Map(
      constraints.rows.map((row) => [
        `${row.table_name}.${row.constraint_name}`,
        {
          type: row.constraint_type,
          definition: normalizeSchemaReference(row.definition, schema),
        },
      ]),
    ),
    indexes: new Map(
      indexes.rows.map((row) => [
        `${row.table_name}.${row.index_name}`,
        {
          unique: row.is_unique,
          primary: row.is_primary,
          definition: normalizeSchemaReference(row.definition, schema),
          predicate: normalizeSchemaReference(row.predicate, schema),
        },
      ]),
    ),
  };
}

function findSchemaDifferences(expected, actual) {
  const differences = [];
  const singularNames = {
    columns: "column",
    constraints: "constraint",
    indexes: "index",
  };

  for (const table of expected.tables) {
    if (!actual.tables.has(table)) differences.push(`missing table ${table}`);
  }
  for (const collection of ["columns", "constraints", "indexes"]) {
    const singularName = singularNames[collection];
    for (const [key, expectedValue] of expected[collection]) {
      const actualValue = actual[collection].get(key);
      if (!actualValue) {
        differences.push(`missing ${singularName} ${key}`);
      } else if (
        JSON.stringify(actualValue) !== JSON.stringify(expectedValue)
      ) {
        differences.push(
          `incompatible ${singularName} ${key} ` +
            `(expected ${JSON.stringify(expectedValue)}, found ${JSON.stringify(actualValue)})`,
        );
      }
    }
  }

  return differences;
}

async function verifyCheckedInSchema(client, migrations, actualSchema) {
  const backendPid = await client.query("SELECT pg_backend_pid() AS pid");
  const expectedSchema = `__api_test_expected_${backendPid.rows[0].pid}`;
  const quotedExpectedSchema = quoteIdentifier(expectedSchema);
  const originalSearchPath = await client.query(
    "SELECT current_setting('search_path') AS search_path",
  );

  await client.query("SAVEPOINT api_test_schema_verification");
  try {
    await client.query(`CREATE SCHEMA ${quotedExpectedSchema}`);
    await client.query(
      "SELECT set_config('search_path', quote_ident($1), false)",
      [expectedSchema],
    );
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        await client.query(rewritePublicSchema(statement, expectedSchema));
      }
    }

    const [expected, actual] = await Promise.all([
      describeSchema(client, expectedSchema),
      describeSchema(client, actualSchema),
    ]);
    const differences = findSchemaDifferences(expected, actual);
    if (differences.length > 0) {
      const preview = differences.slice(0, 10).join(", ");
      const remaining =
        differences.length > 10
          ? ` (and ${differences.length - 10} more)`
          : "";
      throw new Error(
        `Database test setup found an incomplete or incompatible schema: ${preview}${remaining}`,
      );
    }
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT api_test_schema_verification");
    throw error;
  } finally {
    await client.query("SELECT set_config('search_path', $1, false)", [
      originalSearchPath.rows[0].search_path,
    ]);
    await client.query(`DROP SCHEMA IF EXISTS ${quotedExpectedSchema} CASCADE`);
    await client.query("RELEASE SAVEPOINT api_test_schema_verification");
  }
}

export async function prepareDatabaseBackedTests(options = {}) {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) return;

  const migrations = await loadCheckedInMigrations();
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [advisoryLockKey]);
    const schemaResult = await client.query(
      "SELECT current_schema() AS schema_name",
    );
    const actualSchema = schemaResult.rows[0]?.schema_name;
    if (!actualSchema) {
      throw new Error(
        "Database test setup cannot determine the target database schema",
      );
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${migrationTable} (
        tag text PRIMARY KEY NOT NULL,
        hash text NOT NULL,
        created_at bigint NOT NULL,
        applied_at timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    await client.query("BEGIN");
    transactionOpen = true;

    const appliedResult = await client.query(
      `SELECT tag, hash, created_at FROM ${migrationTable}`,
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.tag, row]));
    const checkedInTags = new Set(migrations.map(({ tag }) => tag));
    const unknownTags = [...applied.keys()].filter(
      (tag) => !checkedInTags.has(tag),
    );
    if (unknownTags.length > 0) {
      throw new Error(
        `Database test setup found applied migrations absent from the journal: ${unknownTags.sort().join(", ")}`,
      );
    }

    for (const migration of migrations) {
      const existing = applied.get(migration.tag);
      if (existing) {
        if (
          existing.hash !== migration.hash ||
          Number(existing.created_at) !== migration.createdAt
        ) {
          throw new Error(
            `Database test setup found a changed or partially recorded migration: ${migration.tag}`,
          );
        }
        continue;
      }
      const rewrittenMigration = {
        ...migration,
        statements: migration.statements.map((statement) =>
          rewritePublicSchema(statement, actualSchema),
        ),
      };
      await applyMigration(client, rewrittenMigration);
    }
    await verifyCheckedInSchema(client, migrations, actualSchema);
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareDatabaseBackedTests();
}