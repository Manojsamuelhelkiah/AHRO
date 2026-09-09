import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { assertAutomaticMigrationIsSafe } from "./test-db-setup.mjs";
import { applyReviewedMigration } from "./test-db-setup.mjs";
import { assertReviewedMigrationKeepsTransactionControl } from "./test-db-setup.mjs";
import { loadCheckedInMigrations } from "./test-db-setup.mjs";
import { prepareDatabaseBackedTests } from "./test-db-setup.mjs";
import { reconcileDevelopmentDatabase } from "./test-db-setup.mjs";
import { reviewedMigrationApproval } from "./test-db-setup.mjs";
import { selectReviewedMigration } from "./test-db-setup.mjs";
import { splitMigration } from "./test-db-setup.mjs";

function migrationWith(statement) {
  return {
    tag: "test_migration",
    hash: "not-a-reviewed-hash",
    statements: [statement],
  };
}

test("allows additive migrations during automatic reconciliation", () => {
  for (const statement of [
    `CREATE TABLE "widgets" ("id" integer PRIMARY KEY)`,
    `CREATE TABLE "children" (
       "parent_id" integer REFERENCES "widgets"("id") ON DELETE SET NULL
     )`,
    `ALTER TABLE "widgets" ADD COLUMN "name" text`,
    `ALTER TABLE "widgets"
       ADD COLUMN "channel" text DEFAULT 'email' NOT NULL`,
    `ALTER TABLE "widgets"
       ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL`,
    `ALTER TABLE "widgets" ADD CONSTRAINT "widgets_name_unique" UNIQUE ("name")`,
    `ALTER TABLE "widgets"
       ADD COLUMN "created_at" timestamp,
       ADD COLUMN "updated_at" timestamp`,
    `CREATE INDEX "widgets_name_idx" ON "widgets" ("name")`,
  ]) {
    assert.doesNotThrow(() =>
      assertAutomaticMigrationIsSafe(migrationWith(statement)),
    );
  }
});

test("rejects destructive migrations during automatic reconciliation", () => {
  for (const statement of [
    `DROP TABLE "widgets"`,
    `TRUNCATE TABLE "widgets"`,
    `ALTER TABLE "widgets" DROP COLUMN "name"`,
    `ALTER TABLE "widgets" ALTER COLUMN "id" TYPE bigint`,
    `ALTER TABLE "widgets" ALTER "id" TYPE bigint`,
    `ALTER TABLE "widgets" RENAME TO "old_widgets"`,
    `ALTER TABLE "widgets"
       ADD COLUMN "label" text,
       ALTER "id" TYPE varchar(1) USING left("id"::text, 1)`,
    `ALTER TABLE "widgets"
       ADD COLUMN "label" text,
       DISABLE TRIGGER ALL`,
    `ALTER TABLE "widgets"
       ADD COLUMN "sequence_value" bigint DEFAULT setval('widget_id_seq', 1)`,
    `ALTER TABLE "widgets"
       ADD COLUMN "sequence_ok" boolean
       DEFAULT NOT (setval('widget_id_seq', 1) = 0)`,
    `ALTER TABLE "widgets"
       ADD CONSTRAINT "reset_sequence"
       CHECK (setval('widget_id_seq', 1) > 0)`,
    `ALTER TABLE "safe--name" DROP COLUMN "name"`,
    `DELETE FROM "widgets"`,
    `UPDATE "widgets" SET "id" = 1`,
    `CREATE OR REPLACE VIEW "widget_view" AS SELECT * FROM "widgets"`,
    `CREATE TABLE "deleted_widgets" AS
       WITH deleted AS (DELETE FROM "widgets" RETURNING *)
       SELECT * FROM deleted`,
    `CREATE RULE "discard_widget_inserts" AS
       ON INSERT TO "widgets" DO INSTEAD NOTHING`,
    `CREATE TABLE "sequence_reset" AS
       SELECT setval('widget_id_seq', 1)`,
    `CREATE TABLE "sequence_reset" ("value") AS
       SELECT setval('widget_id_seq', 1)`,
    `CREATE TEMP TABLE "sequence_reset" ("value") AS
       SELECT setval('widget_id_seq', 1)`,
    `CREATE UNLOGGED TABLE "deleted_widgets" ("id") AS
       WITH deleted AS (DELETE FROM "widgets" RETURNING "id")
       SELECT "id" FROM deleted`,
    `INSERT INTO "widgets" ("id") VALUES (1)`,
    `INSERT INTO "widgets" ("id") VALUES (1)
       ON CONFLICT ("id") DO UPDATE SET "id" = excluded."id"`,
    `DO $$ BEGIN EXECUTE 'DROP TABLE widgets'; END $$`,
    `CREATE FUNCTION unsafe() RETURNS void AS $$
       BEGIN EXECUTE 'TRUNCATE widgets'; END
     $$ LANGUAGE plpgsql`,
  ]) {
    assert.throws(
      () => assertAutomaticMigrationIsSafe(migrationWith(statement)),
      /refused destructive or unsupported migration test_migration.*separate reviewed migration process/,
    );
  }
});

test("requires an exact tag-and-hash approval for a reviewed destructive migration", () => {
  const migration = migrationWith(`DROP TABLE "widgets"`);
  assert.throws(
    () => selectReviewedMigration([migration], migration.tag),
    /requires the exact approval APPLY:test_migration:not-a-reviewed-hash/,
  );
  assert.throws(
    () =>
      selectReviewedMigration(
        [migration],
        migration.tag,
        "APPLY:test_migration:stale-hash",
      ),
    /requires the exact approval/,
  );
  assert.equal(
    selectReviewedMigration(
      [migration],
      migration.tag,
      reviewedMigrationApproval(migration),
    ),
    migration,
  );
  assert.throws(
    () => assertAutomaticMigrationIsSafe(migration),
    /refused destructive or unsupported migration/,
  );
});

test("rejects transaction-control SQL before reviewed execution", () => {
  for (const statement of [
    "BEGIN",
    "COMMIT",
    "END",
    "ROLLBACK",
    "ABORT",
    "SAVEPOINT unsafe",
    "RELEASE SAVEPOINT unsafe",
    "START TRANSACTION",
    "PREPARE TRANSACTION 'unsafe'",
  ]) {
    assert.throws(
      () =>
        assertReviewedMigrationKeepsTransactionControl(
          migrationWith(statement),
        ),
      /refused transaction-control SQL.*runner owns the transaction boundary/,
    );
  }
  assert.doesNotThrow(() =>
    assertReviewedMigrationKeepsTransactionControl(
      migrationWith("SELECT 'COMMIT'"),
    ),
  );
});

test("does not mistake comments or string values for destructive SQL", () => {
  assert.doesNotThrow(() =>
    assertAutomaticMigrationIsSafe(
      migrationWith(`
        -- DROP TABLE "widgets"
        CREATE TABLE "audit" ("message" text DEFAULT 'TRUNCATE widgets')
      `),
    ),
  );
});

test("matches PostgreSQL string escaping when splitting migrations", () => {
  const unsafeStatements = splitMigration(`
    ALTER TABLE "widgets" ADD COLUMN "path" text DEFAULT 'C:\\';
    DROP TABLE "widgets";
  `);
  assert.equal(unsafeStatements.length, 2);
  assert.throws(
    () =>
      assertAutomaticMigrationIsSafe({
        ...migrationWith(unsafeStatements[0]),
        statements: unsafeStatements,
      }),
    /refused destructive or unsupported migration/,
  );

  const safeEscapeStringStatements = splitMigration(`
    ALTER TABLE "widgets"
      ADD COLUMN "message" text DEFAULT E'it\\'s safe; DROP TABLE widgets';
  `);
  assert.equal(safeEscapeStringStatements.length, 1);
  assert.doesNotThrow(() =>
    assertAutomaticMigrationIsSafe({
      ...migrationWith(safeEscapeStringStatements[0]),
      statements: safeEscapeStringStatements,
    }),
  );
});

test("matches PostgreSQL nested comments when splitting migrations", () => {
  const statements = splitMigration(`
    ALTER TABLE "widgets" ADD COLUMN "note" text
      /* outer comment /* inner comment */ ' still outer */;
    TRUNCATE TABLE "widgets";
  `);
  assert.equal(statements.length, 2);
  assert.throws(
    () =>
      assertAutomaticMigrationIsSafe({
        ...migrationWith(statements[0]),
        statements,
      }),
    /refused destructive or unsupported migration/,
  );
});

test("matches PostgreSQL carriage-return line comments", () => {
  const statements = splitMigration(
    'CREATE TABLE "safe" ("id" integer); -- hidden only to CR\r' +
      'TRUNCATE TABLE "widgets";',
  );
  assert.equal(statements.length, 2);
  assert.throws(
    () =>
      assertAutomaticMigrationIsSafe({
        ...migrationWith(statements[0]),
        statements,
      }),
    /refused destructive or unsupported migration/,
  );
});

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
    const reviewedSchema = `${schema}_reviewed`;
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
      await adminPool.query(`DROP SCHEMA IF EXISTS "${reviewedSchema}" CASCADE`);
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

      await adminPool.query(`CREATE SCHEMA "${reviewedSchema}"`);
      await prepareDatabaseBackedTests({
        connectionString: schemaConnection(reviewedSchema),
      });
      const reviewedTarget = `${reviewedSchema}.reviewed_target`;
      await adminPool.query(
        `CREATE TABLE "${reviewedSchema}".reviewed_target (id integer)`,
      );
      const reviewedMigration = {
        tag: "9998_reviewed_drop",
        hash: "reviewed-drop-hash",
        createdAt: 9_998,
        statements: [
          `DROP TABLE "reviewed_target"`,
          `CREATE TYPE "reviewed_status" AS ENUM ('ready', 'done')`,
          `CREATE TABLE "reviewed_enum_table" (
            id integer PRIMARY KEY,
            status reviewed_status NOT NULL,
            CONSTRAINT reviewed_status_check CHECK (status <> 'done'::reviewed_status)
          )`,
        ],
      };
      const reviewedMigrations = [...migrations, reviewedMigration];
      await adminPool.query(
        `DROP TABLE "${reviewedSchema}".scenarios CASCADE`,
      );
      await assert.rejects(
        applyReviewedMigration({
          connectionString: schemaConnection(reviewedSchema),
          migrations: reviewedMigrations,
          tag: reviewedMigration.tag,
          approval: reviewedMigrationApproval(reviewedMigration),
        }),
        /incomplete or incompatible schema: missing table scenarios/,
      );
      assert.notEqual(
        (
          await adminPool.query("SELECT to_regclass($1) AS target", [
            reviewedTarget,
          ])
        ).rows[0].target,
        null,
      );
      await adminPool.query(`DROP SCHEMA "${reviewedSchema}" CASCADE`);
      await adminPool.query(`CREATE SCHEMA "${reviewedSchema}"`);
      await prepareDatabaseBackedTests({
        connectionString: schemaConnection(reviewedSchema),
      });
      await adminPool.query(
        `CREATE TABLE "${reviewedSchema}".reviewed_target (id integer)`,
      );
      await adminPool.query(
        `
          INSERT INTO "${reviewedSchema}".__api_test_schema_migrations
            (tag, hash, created_at)
          VALUES ('divergent_history', 'unknown-hash', 9997)
        `,
      );
      await assert.rejects(
        applyReviewedMigration({
          connectionString: schemaConnection(reviewedSchema),
          migrations: reviewedMigrations,
          tag: reviewedMigration.tag,
          approval: reviewedMigrationApproval(reviewedMigration),
        }),
        /applied migrations absent from the journal: divergent_history/,
      );
      assert.notEqual(
        (
          await adminPool.query("SELECT to_regclass($1) AS target", [
            reviewedTarget,
          ])
        ).rows[0].target,
        null,
      );
      const refusedReceipt = await adminPool.query(
        `
          SELECT tag
          FROM "${reviewedSchema}".__api_test_schema_migrations
          WHERE tag = $1
        `,
        [reviewedMigration.tag],
      );
      assert.equal(refusedReceipt.rowCount, 0);
      await adminPool.query(
        `
          DELETE FROM "${reviewedSchema}".__api_test_schema_migrations
          WHERE tag = 'divergent_history'
        `,
      );
      await applyReviewedMigration({
        connectionString: schemaConnection(reviewedSchema),
        migrations: reviewedMigrations,
        tag: reviewedMigration.tag,
        approval: reviewedMigrationApproval(reviewedMigration),
      });
      assert.equal(
        (
          await adminPool.query("SELECT to_regclass($1) AS target", [
            reviewedTarget,
          ])
        ).rows[0].target,
        null,
      );
      await reconcileDevelopmentDatabase({
        connectionString: schemaConnection(reviewedSchema),
        migrations: reviewedMigrations,
      });

      await adminPool.query(
        `CREATE TABLE "${reviewedSchema}".reviewed_shape (id text)`,
      );
      const additiveMigration = {
        tag: "9999_additive_shape",
        hash: "additive-shape-hash",
        createdAt: 9_999,
        statements: [
          `CREATE TABLE IF NOT EXISTS "reviewed_shape" (id integer)`,
        ],
      };
      await assert.rejects(
        reconcileDevelopmentDatabase({
          connectionString: schemaConnection(reviewedSchema),
          migrations: [...reviewedMigrations, additiveMigration],
        }),
        /incompatible column reviewed_shape\.id/,
      );
      const additiveReceipt = await adminPool.query(
        `
          SELECT tag
          FROM "${reviewedSchema}".__api_test_schema_migrations
          WHERE tag = $1
        `,
        [additiveMigration.tag],
      );
      assert.equal(additiveReceipt.rowCount, 0);
      await adminPool.query(
        `DROP TABLE "${reviewedSchema}".reviewed_shape`,
      );

      const postReviewAdditiveMigration = {
        tag: "9999_additive_after_review",
        hash: "additive-after-review-hash",
        createdAt: 9_999,
        statements: [
          `ALTER TABLE "scenarios" ADD COLUMN "reviewed_note" text`,
          `CREATE TABLE "reviewed_enum_usage" (
            id integer PRIMARY KEY,
            status reviewed_status NOT NULL
          )`,
        ],
      };
      const postReviewedMigrations = [
        ...reviewedMigrations,
        postReviewAdditiveMigration,
      ];
      await reconcileDevelopmentDatabase({
        connectionString: schemaConnection(reviewedSchema),
        migrations: postReviewedMigrations,
      });
      const postReviewShape = await adminPool.query(
        `
          SELECT
            (
              SELECT data_type
              FROM information_schema.columns
              WHERE table_schema = $1
                AND table_name = 'scenarios'
                AND column_name = 'reviewed_note'
            ) AS note_type,
            (
              SELECT udt_name
              FROM information_schema.columns
              WHERE table_schema = $1
                AND table_name = 'reviewed_enum_usage'
                AND column_name = 'status'
            ) AS status_type
        `,
        [reviewedSchema],
      );
      assert.equal(postReviewShape.rows[0].note_type, "text");
      assert.equal(postReviewShape.rows[0].status_type, "reviewed_status");

      await adminPool.query(
        `CREATE TABLE "${reviewedSchema}".rollback_target (id integer)`,
      );
      const failingMigration = {
        tag: "10000_reviewed_failure",
        hash: "reviewed-failure-hash",
        createdAt: 10_000,
        statements: [
          `DROP TABLE "rollback_target"`,
          `ALTER TABLE "missing_table" RENAME TO "still_missing"`,
        ],
      };
      await assert.rejects(
        applyReviewedMigration({
          connectionString: schemaConnection(reviewedSchema),
          migrations: [...postReviewedMigrations, failingMigration],
          tag: failingMigration.tag,
          approval: reviewedMigrationApproval(failingMigration),
        }),
        /could not apply 10000_reviewed_failure \(statement 2\)/,
      );
      assert.notEqual(
        (
          await adminPool.query("SELECT to_regclass($1) AS target", [
            `${reviewedSchema}.rollback_target`,
          ])
        ).rows[0].target,
        null,
      );
      const failedReceipt = await adminPool.query(
        `
          SELECT tag
          FROM "${reviewedSchema}".__api_test_schema_migrations
          WHERE tag = $1
        `,
        [failingMigration.tag],
      );
      assert.equal(failedReceipt.rowCount, 0);

      await adminPool.query(
        `CREATE TABLE "${reviewedSchema}".transaction_target (id integer)`,
      );
      const transactionEscapeMigration = {
        tag: "10000_transaction_escape",
        hash: "transaction-escape-hash",
        createdAt: 10_000,
        statements: [
          `DROP TABLE "transaction_target"`,
          `SET standard_conforming_strings = off`,
          `SELECT '\\'; COMMIT; SELECT 'concealed'`,
          `SELECT * FROM "missing_after_commit"`,
        ],
      };
      await assert.rejects(
        applyReviewedMigration({
          connectionString: schemaConnection(reviewedSchema),
          migrations: [...postReviewedMigrations, transactionEscapeMigration],
          tag: transactionEscapeMigration.tag,
          approval: reviewedMigrationApproval(transactionEscapeMigration),
        }),
        /refused transaction-control SQL.*statement 3/,
      );
      assert.notEqual(
        (
          await adminPool.query("SELECT to_regclass($1) AS target", [
            `${reviewedSchema}.transaction_target`,
          ])
        ).rows[0].target,
        null,
      );
      const escapedReceipt = await adminPool.query(
        `
          SELECT tag
          FROM "${reviewedSchema}".__api_test_schema_migrations
          WHERE tag = $1
        `,
        [transactionEscapeMigration.tag],
      );
      assert.equal(escapedReceipt.rowCount, 0);

      await adminPool.query(
        `DROP TABLE "${reviewedSchema}".scenarios CASCADE`,
      );
      await assert.rejects(
        reconcileDevelopmentDatabase({
          connectionString: schemaConnection(reviewedSchema),
          migrations: postReviewedMigrations,
        }),
        /incomplete or incompatible schema: missing table scenarios/,
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
      await adminPool.query(
        `DROP SCHEMA IF EXISTS "${reviewedSchema}" CASCADE`,
      );
      await adminPool.end();
    }
  },
);