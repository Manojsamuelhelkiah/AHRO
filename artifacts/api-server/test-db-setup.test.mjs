import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { loadCheckedInMigrations } from "./test-db-setup.mjs";
import { prepareDatabaseBackedTests } from "./test-db-setup.mjs";

test("loads every journal migration with a stable hash", async () => {
  const migrations = await loadCheckedInMigrations();

  assert.ok(migrations.length > 0);
  assert.equal(new Set(migrations.map(({ tag }) => tag)).size, migrations.length);
  for (const migration of migrations) {
    assert.match(migration.hash, /^[a-f0-9]{64}$/);
    assert.ok(migration.statements.length > 0);
  }
});

const hasDb = Boolean(process.env.DATABASE_URL);

test(
  "prepares fresh and interrupted schemas, repeats safely, and rejects drift",
  { skip: !hasDb },
  async () => {
    const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `api_test_setup_${process.pid}`;
    const partialSchema = `${schema}_partial`;
    const schemaConnection = (schemaName) => {
      const url = new URL(process.env.DATABASE_URL);
      url.searchParams.set("options", `-csearch_path=${schemaName}`);
      return url.toString();
    };
    const nonUtcSchemaConnection = (schemaName) => {
      const url = new URL(process.env.DATABASE_URL);
      url.searchParams.set(
        "options",
        `-csearch_path=${schemaName} -cTimeZone=America/New_York`,
      );
      return url.toString();
    };

    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.query(`DROP SCHEMA IF EXISTS "${partialSchema}" CASCADE`);
      await adminPool.query(`CREATE SCHEMA "${schema}"`);
      await prepareDatabaseBackedTests({
        connectionString: schemaConnection(schema),
      });
      await prepareDatabaseBackedTests({
        connectionString: schemaConnection(schema),
      });

      const prepared = await adminPool.query(
        `
          SELECT
            to_regclass($1) IS NOT NULL AS has_scenarios,
            to_regclass($2) IS NOT NULL AS has_latest_table,
            (
              SELECT count(*)::integer
              FROM "${schema}".__api_test_schema_migrations
            ) AS migration_count
        `,
        [`${schema}.scenarios`, `${schema}.onb_effect_journal`],
      );
      assert.equal(prepared.rows[0].has_scenarios, true);
      assert.equal(prepared.rows[0].has_latest_table, true);
      assert.equal(
        prepared.rows[0].migration_count,
        (await loadCheckedInMigrations()).length,
      );

      const migrations = await loadCheckedInMigrations();
      await adminPool.query(
        `ALTER TABLE "${schema}".custom_intents DROP COLUMN registry_version`,
      );
      await adminPool.query(
        `
          DELETE FROM "${schema}".__api_test_schema_migrations
          WHERE tag = '0018_custom_intent_routing_contract'
        `,
      );
      await prepareDatabaseBackedTests({
        connectionString: schemaConnection(schema),
      });
      const repairedAdditiveColumn = await adminPool.query(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = 'custom_intents'
            AND column_name = 'registry_version'
        `,
        [schema],
      );
      assert.equal(repairedAdditiveColumn.rowCount, 1);

      await adminPool.query(
        `
          UPDATE "${schema}".__api_test_schema_migrations
          SET hash = 'tampered'
          WHERE tag = $1
        `,
        [migrations[0].tag],
      );
      await assert.rejects(
        prepareDatabaseBackedTests({
          connectionString: schemaConnection(schema),
        }),
        /changed or partially recorded migration/,
      );
      await adminPool.query(
        `
          UPDATE "${schema}".__api_test_schema_migrations
          SET hash = $1
          WHERE tag = $2
        `,
        [migrations[0].hash, migrations[0].tag],
      );

      const receiptInstant = "2026-09-08T00:00:00.000Z";
      await adminPool.query(
        `
          INSERT INTO "${schema}".onb_watch_emails (
            gmail_message_id,
            system,
            from_address,
            parsed_status,
            action,
            received_at
          )
          VALUES ('migration-adoption-test', 'payroll', 'sender@example.test',
                  'update', 'recorded', $1::timestamptz)
        `,
        [receiptInstant],
      );
      await adminPool.query(
        `DROP TABLE "${schema}".__api_test_schema_migrations`,
      );
      await prepareDatabaseBackedTests({
        connectionString: nonUtcSchemaConnection(schema),
      });
      await prepareDatabaseBackedTests({
        connectionString: nonUtcSchemaConnection(schema),
      });
      const preservedReceipt = await adminPool.query(
        `
          SELECT received_at
          FROM "${schema}".onb_watch_emails
          WHERE gmail_message_id = 'migration-adoption-test'
        `,
      );
      assert.equal(
        preservedReceipt.rows[0].received_at.toISOString(),
        receiptInstant,
      );

      await adminPool.query(`DROP TABLE "${schema}".scenarios CASCADE`);
      await assert.rejects(
        prepareDatabaseBackedTests({
          connectionString: schemaConnection(schema),
        }),
        /incomplete or incompatible schema: missing table scenarios/,
      );

      await adminPool.query(`CREATE SCHEMA "${partialSchema}"`);
      await adminPool.query(`
        CREATE TABLE "${partialSchema}".scenarios (
          id serial PRIMARY KEY NOT NULL,
          name text NOT NULL
        )
      `);
      await assert.rejects(
        prepareDatabaseBackedTests({
          connectionString: schemaConnection(partialSchema),
        }),
        /incomplete or incompatible schema: missing column scenarios\./,
      );
      const partialLedger = await adminPool.query(
        `
          SELECT count(*)::integer AS migration_count
          FROM "${partialSchema}".__api_test_schema_migrations
        `,
      );
      assert.equal(partialLedger.rows[0].migration_count, 0);
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.query(
        `DROP SCHEMA IF EXISTS "${partialSchema}" CASCADE`,
      );
      await adminPool.end();
    }
  },
);