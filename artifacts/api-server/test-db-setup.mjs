import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const routingMigrationUrl = new URL(
  "../../lib/db/drizzle/0018_custom_intent_routing_contract.sql",
  import.meta.url,
);

const requiredCustomIntentColumns = [
  "registry_version",
  "parent_intent_key",
  "exact_aliases",
  "accountable_specialist",
  "risk_class",
  "action_schema",
  "evidence_contract",
  "maturity",
];

export async function prepareDatabaseBackedTests() {
  if (!process.env.DATABASE_URL) return;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const migrationSql = await readFile(routingMigrationUrl, "utf8");
    await pool.query(migrationSql);

    const schemaCheck = await pool.query(
      `
        select
          to_regclass('custom_intent_routing_labels') is not null as routing_table_exists,
          coalesce(
            array_agg(column_name order by column_name)
              filter (where column_name = any($1::text[])),
            '{}'::text[]
          )::text[] as present_columns
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'custom_intents'
      `,
      [requiredCustomIntentColumns],
    );
    const row = schemaCheck.rows[0];
    const presentColumns = new Set(row?.present_columns ?? []);
    const missingColumns = requiredCustomIntentColumns.filter(
      (column) => !presentColumns.has(column),
    );

    if (!row?.routing_table_exists || missingColumns.length > 0) {
      const missing = [
        ...(!row?.routing_table_exists ? ["custom_intent_routing_labels table"] : []),
        ...missingColumns.map((column) => `custom_intents.${column}`),
      ];
      throw new Error(
        `Database test setup is missing the custom-intent routing schema: ${missing.join(", ")}`,
      );
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareDatabaseBackedTests();
}