import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import {
  phaseBTenantTables,
  tenantTables,
} from "./tenant-safeguards-manifest.mjs";
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

function planIndexNames(plan) {
  const names = new Set();
  const visit = (node) => {
    if (node?.["Index Name"]) names.add(node["Index Name"]);
    for (const child of node?.Plans ?? []) visit(child);
  };
  visit(plan);
  return names;
}

function schemaTableBlocks(source) {
  const blocks = [];
  const tableStart = /\bpgTable\s*\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(tableStart)) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let end = match.index;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    blocks.push({ table: match[1], source: source.slice(match.index, end) });
  }
  return blocks;
}

test("tenant safeguard manifest covers every organization-owned schema table", async () => {
  const schemaDirectory = new URL("../../lib/db/src/schema/", import.meta.url);
  const schemaIndex = await readFile(new URL("index.ts", schemaDirectory), "utf8");
  const schemaFiles = [
    ...schemaIndex.matchAll(/export \* from ["']\.\/([^"']+)["']/g),
  ].map((match) => `${match[1]}.ts`);
  const schemaSources = await Promise.all(
    schemaFiles.map((file) => readFile(new URL(file, schemaDirectory), "utf8")),
  );
  const organizationOwnedTables = schemaSources
    .flatMap(schemaTableBlocks)
    .filter(({ source }) => /text\s*\(\s*["']organization_id["']\s*\)/.test(source))
    .map(({ table }) => table)
    .sort();

  assert.deepEqual([...tenantTables].sort(), organizationOwnedTables);
});

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

test("tenant Phase A keeps the publish target data-preserving and legacy-compatible", async () => {
  const migrationUrl = new URL(
    "../../lib/db/drizzle/0022_application_organizations_phase_a.sql",
    import.meta.url,
  );
  const phaseASql = await readFile(migrationUrl, "utf8");
  const applicationOrganizations0021 = await readFile(
    new URL(
      "../../lib/db/drizzle/0021_application_organizations.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(
    createHash("sha256").update(applicationOrganizations0021).digest("hex"),
    "877e19bb3df8758688ab44039bd0196eeaa4e51ff1b1587ac9c19366de1a5adf",
    "0021 must remain byte-for-byte unchanged",
  );
  assert.doesNotMatch(
    phaseASql,
    /^\s*(?:DELETE|TRUNCATE|UPDATE|INSERT)\b/im,
  );

  for (const table of phaseBTenantTables) {
    assert.match(
      phaseASql,
      new RegExp(
        `ALTER TABLE "${table}" ALTER COLUMN "organization_id" SET DEFAULT 'demo'`,
      ),
    );
  }

  for (const phaseAIdentity of [
    `PRIMARY KEY ("organization_id", "label")`,
    `PRIMARY KEY ("organization_id", "key")`,
    `PRIMARY KEY ("organization_id", "logical_operation_key")`,
    `PRIMARY KEY ("organization_id", "token")`,
    `"organization_id", "idempotency_key"`,
    `"organization_id", "external_message_id"`,
    `"organization_id", "case_id", "system"`,
    `"organization_id", "case_id", "key"`,
    `"organization_id", "dedupe_key"`,
    `"organization_id", "call_sid"`,
    `"organization_id", "gmail_message_id"`,
  ]) {
    assert.ok(
      applicationOrganizations0021.includes(phaseAIdentity) ||
        phaseASql.includes(phaseAIdentity),
      `missing Phase A identity ${phaseAIdentity}`,
    );
  }

  assert.doesNotMatch(phaseASql, /ADD CONSTRAINT "[^"]*organization[^"]*_fk"/i);
  assert.match(
    phaseASql,
    /DROP CONSTRAINT IF EXISTS "onb_watch_emails_organization_case_fk"/,
  );
  assert.match(
    phaseASql,
    /DROP CONSTRAINT IF EXISTS "onb_watch_emails_organization_check_fk"/,
  );
});

test("tenant Phase B restores fail-closed defaults and all deferred foreign keys", async () => {
  const phaseBSql = await readFile(
    new URL(
      "../../lib/db/drizzle/0023_application_organizations_phase_b.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    phaseBSql,
    /^\s*(?:DELETE|TRUNCATE|UPDATE|INSERT|DROP\s+TABLE|ALTER\s+TABLE\b.*\bDROP\s+COLUMN)\b/im,
  );
  for (const table of phaseBTenantTables) {
    assert.match(
      phaseBSql,
      new RegExp(
        `ALTER TABLE "${table}" ALTER COLUMN "organization_id" DROP DEFAULT`,
      ),
    );
    assert.match(
      phaseBSql,
      new RegExp(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_organization_id_organizations_id_fk" FOREIGN KEY \\("organization_id"\\) REFERENCES "organizations"\\("id"\\)`,
      ),
    );
  }
  assert.match(
    phaseBSql,
    /ADD CONSTRAINT "onb_watch_emails_organization_case_fk" FOREIGN KEY \("organization_id", "case_id"\) REFERENCES "onb_cases"\("organization_id", "id"\)/,
  );
  assert.match(
    phaseBSql,
    /ADD CONSTRAINT "onb_watch_emails_organization_check_fk" FOREIGN KEY \("organization_id", "check_id"\) REFERENCES "onb_system_checks"\("organization_id", "id"\)/,
  );
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
      await adminPool.query(
        `
          UPDATE "${schema}".__api_test_schema_migrations
          SET hash = $1
          WHERE tag = '0030_candidate_portal'
        `,
        [
          "8f113f159680a086acc79b46cac772f7543f1cd72125f14921cc97ec113dc9af",
        ],
      );
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

      const candidateIndexes = await adminPool.query(
        `
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = $1
            AND indexname = ANY($2::text[])
        `,
        [
          schema,
          [
            "onb_candidate_links_unrevoked_expires_idx",
            "onb_candidate_links_revoked_at_idx",
            "onb_candidate_sessions_expires_at_idx",
          ],
        ],
      );
      assert.deepEqual(
        candidateIndexes.rows.map(({ indexname }) => indexname).sort(),
        [
          "onb_candidate_links_revoked_at_idx",
          "onb_candidate_links_unrevoked_expires_idx",
          "onb_candidate_sessions_expires_at_idx",
        ],
      );

      const planClient = await adminPool.connect();
      try {
        await planClient.query("BEGIN");
        await planClient.query("SET LOCAL enable_seqscan = off");
        const sessionPlan = await planClient.query(
          `
            EXPLAIN (FORMAT JSON)
            SELECT id_hash
            FROM "${schema}".onb_candidate_sessions
            WHERE expires_at <= now()
            LIMIT 500
          `,
        );
        assert.ok(
          planIndexNames(sessionPlan.rows[0]["QUERY PLAN"][0].Plan).has(
            "onb_candidate_sessions_expires_at_idx",
          ),
        );

        const linkPlan = await planClient.query(
          `
            EXPLAIN (FORMAT JSON)
            SELECT id
            FROM "${schema}".onb_candidate_links
            WHERE (
              (revoked_at IS NULL AND expires_at <= now() - interval '90 days')
              OR revoked_at <= now() - interval '90 days'
            )
            LIMIT 500
          `,
        );
        const linkPlanIndexes = planIndexNames(
          linkPlan.rows[0]["QUERY PLAN"][0].Plan,
        );
        assert.ok(
          linkPlanIndexes.has("onb_candidate_links_unrevoked_expires_idx"),
        );
        assert.ok(linkPlanIndexes.has("onb_candidate_links_revoked_at_idx"));
      } finally {
        await planClient.query("ROLLBACK");
        planClient.release();
      }

      const tenantEnforcement = await adminPool.query(
        `
          SELECT
            count(*) FILTER (WHERE column_default IS NOT NULL)::integer AS default_count,
            count(*)::integer AS tenant_column_count
          FROM information_schema.columns
          WHERE table_schema = $1
            AND column_name = 'organization_id'
            AND table_name = ANY($2::text[])
        `,
        [
          schema,
          tenantTables,
        ],
      );
      assert.equal(
        tenantEnforcement.rows[0].tenant_column_count,
        tenantTables.length,
      );
      assert.equal(tenantEnforcement.rows[0].default_count, 0);
      await assert.rejects(
        adminPool.query(
          `INSERT INTO "${schema}".scenarios (name, inputs) VALUES ('missing-tenant', '{}'::jsonb)`,
        ),
        /null value in column "organization_id"/,
      );
      await assert.rejects(
        adminPool.query(
          `INSERT INTO "${schema}".scenarios (organization_id, name, inputs) VALUES ('orphan', 'orphan-tenant', '{}'::jsonb)`,
        ),
        /violates foreign key constraint/,
      );
      await assert.rejects(
        adminPool.query(
          `
            INSERT INTO "${schema}".onb_watch_emails (
              organization_id, gmail_message_id, case_id, system,
              from_address, parsed_status, action
            )
            VALUES ('demo', 'orphan-watch-case', -1, 'payroll',
                    'sender@example.test', 'update', 'recorded')
          `,
        ),
        /violates foreign key constraint "onb_watch_emails_organization_case_fk"/,
      );
      await assert.rejects(
        adminPool.query(
          `
            INSERT INTO "${schema}".onb_watch_emails (
              organization_id, gmail_message_id, check_id, system,
              from_address, parsed_status, action
            )
            VALUES ('demo', 'orphan-watch-check', -1, 'payroll',
                    'sender@example.test', 'update', 'recorded')
          `,
        ),
        /violates foreign key constraint "onb_watch_emails_organization_check_fk"/,
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
            organization_id,
            gmail_message_id,
            system,
            from_address,
            parsed_status,
            action,
            received_at
          )
          VALUES ('demo', 'migration-adoption-test', 'payroll', 'sender@example.test',
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

      const legacyForeignKeyName =
        "legacy_scenarios_organization_relationship_that_postgresql_must_truncate_before_storing_fk";
      await adminPool.query(
        `ALTER TABLE "${reviewedSchema}".scenarios
         ADD CONSTRAINT "${legacyForeignKeyName}"
         FOREIGN KEY (organization_id) REFERENCES "${reviewedSchema}".organizations(id)`,
      );
      await assert.rejects(
        reconcileDevelopmentDatabase({
          connectionString: schemaConnection(reviewedSchema),
          migrations: postReviewedMigrations,
        }),
        /unexpected foreign key .*"columns":\["organization_id"\].*"referencedColumns":\["id"\].*"referencedTable":"organizations".*"table":"scenarios"/,
      );
      const storedLegacyForeignKey = await adminPool.query(
        `
          SELECT constraint_record.conname
          FROM pg_constraint constraint_record
          JOIN pg_class relation ON relation.oid = constraint_record.conrelid
          JOIN pg_namespace namespace_record ON namespace_record.oid = relation.relnamespace
          WHERE namespace_record.nspname = $1
            AND relation.relname = 'scenarios'
            AND constraint_record.conname LIKE 'legacy_scenarios_organization_relationship%'
        `,
        [reviewedSchema],
      );
      assert.equal(storedLegacyForeignKey.rowCount, 1);
      assert.equal(storedLegacyForeignKey.rows[0].conname.length, 63);
      await adminPool.query(
        `ALTER TABLE "${reviewedSchema}".scenarios
         DROP CONSTRAINT "${storedLegacyForeignKey.rows[0].conname}"`,
      );
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

test(
  "preserves populated recovery workspaces and quarantines mismatched uploads",
  { skip: !hasDb },
  async () => {
    const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `api_test_private_scenario_${process.pid}`;
    const schemaConnection = () => {
      const url = new URL(process.env.DATABASE_URL);
      url.searchParams.set("options", `-csearch_path=${schema}`);
      return url.toString();
    };
    const ownerUserId = `historical-owner-${process.pid}`;

    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = await loadCheckedInMigrations();
      const preOrganizationMigrations = migrations.filter(
        ({ tag }) =>
          tag !== "0021_application_organizations" &&
          tag !== "0022_application_organizations_phase_a" &&
          tag !== "0023_application_organizations_phase_b" &&
          tag !== "0025_private_scenario_tenancy" &&
          tag !== "0026_preserve_scenario_context" &&
          tag !== "0027_quarantine_scenario_file_ownership" &&
           tag !== "0028_restore_staged_scenario_context" &&
           tag !== "0030_candidate_portal" &&
           tag !== "0037_document_malware_quarantine" &&
           tag !== "0039_weighted_readiness_sla" &&
           tag !== "0040_versioned_approvals" &&
           tag !== "0041_readiness_snapshot_joining_date" &&
           tag !== "0043_demo_controller_setup" &&
           tag !== "0044_action_center" &&
           tag !== "0045_context_aware_workforce_policies" &&
           tag !== "0046_batch_intake_reconciliation" &&
           tag !== "0045_protected_onboarding_audit" &&
           tag !== "0047_verified_decision_authority" &&
           tag !== "0048_authority_case_creator_principal" &&
           tag !== "0049_nonwaivable_safety_policy" &&
           tag !== "0050_authority_governance_withdrawn" &&
            tag !== "0051_separate_migration_review_from_medical_safety" &&
            tag !== "0047_external_audit_anchoring" &&
            tag !== "0048_external_audit_anchor_provider_transition" &&
            tag !== "0047_governance_decision_register" &&
            tag !== "0048_governance_authority_requests" &&
            tag !== "0049_governance_requirement_coverage_state" &&
            tag !== "0050_governance_dispatch_fence" &&
            tag !== "0051_trusted_connector_evidence" &&
            tag !== "0052_organization_membership_lifecycle" &&
             tag !== "0052_sensitive_lifecycle_controls" &&
             tag !== "0053_sensitive_relational_lifecycle" &&
             tag !== "0054_sensitive_relational_inventory" &&
             tag !== "0055_correct_communication_lifecycle_backfill" &&
             tag !== "0056_correct_null_communication_lifecycle_backfill" &&
             tag !== "0057_case_derived_sensitive_lifecycle" &&
             tag !== "0058_case_derived_lifecycle_scan_cursor" &&
             tag !== "0059_remove_cursor_tenant_cleanup_fk" &&
            tag !== "0053_organization_membership_revision" &&
             tag !== "0060_governed_minimal_approval_history" &&
             tag !== "0061_candidate_upload_reservations" &&
              tag !== "0062_candidate_upload_reservation_context_version" &&
              // Standard intake/provider tables are born after the legacy
              // workspace's organizations migration. They cannot be applied
              // to the deliberately pre-organization fixture below.
              tag !== "0063_standard_onboarding_intake" &&
              tag !== "0064_standard_provider_contracts" &&
              tag !== "0065_standard_intake_scheduled_activation" &&
              tag !== "0066_standard_intake_case_tombstones" &&
               tag !== "0067_hris_attestation_source_binding" &&
                tag !== "0068_early_tenure_core" &&
                tag !== "0069_outcome_reporting_evidence" &&
                tag !== "0070_early_tenure_checkin_reminder_lead" &&
                tag !== "0071_early_tenure_probation_decided_at" &&
                tag !== "0072_outcome_reporting_evidence_corrections" &&
                tag !== "0073_early_tenure_anchor_revision_fence" &&
                tag !== "0074_outcome_authority_receipts" &&
                tag !== "0075_early_tenure_probation_anchor_revision" &&
                tag !== "0076_early_tenure_checkin_owners" &&
             tag !== "0053_governed_hr_policy_library" &&
             tag !== "0053_external_audit_anchor_receipt_generation" &&
             tag !== "0054_external_audit_anchor_receipt_constraints" &&
             tag !== "0054_hr_policy_review_authority_category" &&
             tag !== "0055_hr_policy_publication_receipts_and_excerpts" &&
             tag !== "0056_hr_policy_reminders",
      );
      await prepareDatabaseBackedTests({
        connectionString: schemaConnection(),
        migrations: preOrganizationMigrations,
      });
      const inserted = await adminPool.query(
        `
          INSERT INTO "${schema}".scenarios
            (owner_user_id, name, inputs)
          VALUES (
            $1,
            'Historical private scenario',
            '{"annualTransactions":120000}'::jsonb
          )
          RETURNING id
        `,
        [ownerUserId],
      );
      const mismatchedOwner = `mismatched-file-owner-${process.pid}`;
      const insertedFile = await adminPool.query(
        `
          INSERT INTO "${schema}".scenario_files (
            owner_user_id,
            scenario_id,
            object_path,
            original_name,
            content_type,
            size_bytes
          )
          VALUES ($1, $2, $3, 'historical.txt', 'text/plain', 4)
          RETURNING id
        `,
        [
          mismatchedOwner,
          inserted.rows[0].id,
          `private/scenarios/${mismatchedOwner}/historical.txt`,
        ],
      );
      const uploadIntentId = "00000000-0000-4000-8000-000000000025";
      await adminPool.query(
        `
          INSERT INTO "${schema}".scenario_upload_intents (
            id,
            owner_user_id,
            object_path,
            original_name,
            content_type,
            size_bytes,
            expires_at
          )
          VALUES ($1, $2, $3, 'pending.txt', 'text/plain', 4, now() + interval '1 hour')
        `,
        [
          uploadIntentId,
          mismatchedOwner,
          `private/scenario-uploads/${mismatchedOwner}/pending.txt`,
        ],
      );

      const throughPrivateMigration = migrations.filter(
        ({ tag }) =>
          tag !== "0026_preserve_scenario_context" &&
          tag !== "0027_quarantine_scenario_file_ownership" &&
          tag !== "0028_restore_staged_scenario_context",
      );
      await prepareDatabaseBackedTests({
        connectionString: schemaConnection(),
        migrations: throughPrivateMigration,
      });
      const isolatedScenario = await adminPool.query(
        `
          SELECT organization_id
          FROM "${schema}".scenarios
          WHERE id = $1
        `,
        [inserted.rows[0].id],
      );
      const privateOrganizationId =
        isolatedScenario.rows[0].organization_id;
      assert.match(privateOrganizationId, /^legacy-private-/);
      await adminPool.query(
        `
          INSERT INTO "${schema}".onb_settings
            (organization_id, key, value)
          VALUES ($1, 'staged-private-record', 'preserved')
        `,
        [privateOrganizationId],
      );
      const stagedCustomIntentKey = `staged-custom-${process.pid}`;
      await adminPool.query(
        `
          INSERT INTO "${schema}".custom_intents (
            organization_id,
            key,
            name,
            domain,
            flow_class,
            description,
            as_is_handling_min,
            to_be_human_min,
            base_weight,
            act_get_actions,
            act_put_actions,
            source,
            author
          )
          VALUES (
            $1,
            $2,
            'Staged private intent',
            'test',
            'fc1-deterministic',
            'Created after private workspace migration',
            10,
            2,
            1,
            1,
            0,
            'migration-test',
            'migration-test'
          )
        `,
        [privateOrganizationId, stagedCustomIntentKey],
      );
      await adminPool.query(
        `
          INSERT INTO "${schema}".flow_overrides (
            organization_id,
            intent_key,
            version,
            status,
            author,
            rationale,
            flow_class
          )
          VALUES (
            $1,
            $2,
            1,
            'approved',
            'migration-test',
            'Keep staged override with its scenario',
            'fc3-multiagent'
          )
        `,
        [privateOrganizationId, stagedCustomIntentKey],
      );
      await adminPool.query(
        `
          INSERT INTO "${schema}".pricing_rate_sets (
            organization_id,
            effective_date,
            rationale,
            rates,
            created_by
          )
          VALUES (
            $1,
            '2025-01-01',
            'Staged private rates',
            '{"marker":"private"}'::jsonb,
            'migration-test'
          )
        `,
        [privateOrganizationId],
      );
      const stagedScenario = await adminPool.query(
        `
          INSERT INTO "${schema}".scenarios (
            organization_id,
            owner_user_id,
            name,
            inputs
          )
          VALUES (
            $1,
            $2,
            'Staged private scenario',
            jsonb_build_object(
              'annualTransactions',
              240000,
              'intentShareOverrides',
              jsonb_build_object($3::text, 0.1)
            )
          )
          RETURNING id
        `,
        [privateOrganizationId, ownerUserId, stagedCustomIntentKey],
      );

      const ordinaryOrganizationId = `ordinary-tenant-${process.pid}`;
      await adminPool.query(
        `
          INSERT INTO "${schema}".organizations
            (id, name, slug, join_code_hash, created_by_user_id)
          VALUES ($1, 'Ordinary tenant', $1, $2, $3)
        `,
        [
          ordinaryOrganizationId,
          `ordinary-tenant-join-${process.pid}`,
          ownerUserId,
        ],
      );
      const ordinaryScenario = await adminPool.query(
        `
          INSERT INTO "${schema}".scenarios
            (organization_id, owner_user_id, name, inputs)
          VALUES ($1, $2, 'Ordinary private scenario', '{}'::jsonb)
          RETURNING id
        `,
        [ordinaryOrganizationId, ownerUserId],
      );
      const ordinaryFile = await adminPool.query(
        `
          INSERT INTO "${schema}".scenario_files (
            organization_id,
            owner_user_id,
            scenario_id,
            object_path,
            original_name,
            content_type,
            size_bytes
          )
          VALUES ($1, $2, $3, $4, 'ordinary.txt', 'text/plain', 4)
          RETURNING id
        `,
        [
          ordinaryOrganizationId,
          mismatchedOwner,
          ordinaryScenario.rows[0].id,
          `private/scenarios/${mismatchedOwner}/ordinary.txt`,
        ],
      );

      await prepareDatabaseBackedTests({
        connectionString: schemaConnection(),
        migrations,
      });

      const migrated = await adminPool.query(
        `
          SELECT
            scenario.organization_id,
            scenario.owner_user_id,
            scenario.inputs,
            file.organization_id AS file_organization_id,
            file.scenario_id AS file_scenario_id,
            upload.organization_id AS upload_organization_id
          FROM "${schema}".scenarios scenario
          JOIN "${schema}".scenario_files file
            ON file.id = $2
          JOIN "${schema}".scenario_upload_intents upload
            ON upload.id = $3
          WHERE scenario.id = $1
        `,
        [inserted.rows[0].id, insertedFile.rows[0].id, uploadIntentId],
      );
      assert.equal(migrated.rowCount, 1);
      assert.equal(migrated.rows[0].organization_id, "demo");
      assert.equal(migrated.rows[0].owner_user_id, ownerUserId);
      assert.deepEqual(migrated.rows[0].inputs, {
        annualTransactions: 120000,
      });
      assert.equal(migrated.rows[0].file_organization_id, "demo");
      assert.equal(migrated.rows[0].file_scenario_id, null);
      assert.equal(migrated.rows[0].upload_organization_id, "demo");

      const preservedWorkspace = await adminPool.query(
        `
          SELECT
            setting.value,
            membership.role,
            demo_membership.role AS demo_role
          FROM "${schema}".onb_settings setting
          JOIN "${schema}".organization_memberships membership
            ON membership.organization_id = setting.organization_id
           AND membership.clerk_user_id = $2
          JOIN "${schema}".organization_memberships demo_membership
            ON demo_membership.organization_id = 'demo'
           AND demo_membership.clerk_user_id = $2
          WHERE setting.organization_id = $1
            AND setting.key = 'staged-private-record'
        `,
        [privateOrganizationId, ownerUserId],
      );
      assert.equal(preservedWorkspace.rowCount, 1);
      assert.equal(preservedWorkspace.rows[0].value, "preserved");
      assert.equal(preservedWorkspace.rows[0].role, "owner");
      assert.equal(preservedWorkspace.rows[0].demo_role, "member");

      const quarantinedOrdinaryFile = await adminPool.query(
        `
          SELECT organization_id, scenario_id
          FROM "${schema}".scenario_files
          WHERE id = $1
        `,
        [ordinaryFile.rows[0].id],
      );
      assert.equal(quarantinedOrdinaryFile.rowCount, 1);
      assert.equal(
        quarantinedOrdinaryFile.rows[0].organization_id,
        ordinaryOrganizationId,
      );
      assert.equal(quarantinedOrdinaryFile.rows[0].scenario_id, null);

      const stagedContext = await adminPool.query(
        `
          SELECT
            scenario.organization_id AS scenario_organization_id,
            custom_intent.organization_id AS intent_organization_id,
            flow_override.organization_id AS override_organization_id,
            rate_set.organization_id AS rate_organization_id,
            scenario.inputs -> 'intentShareOverrides' ->> $3 AS custom_share
          FROM "${schema}".scenarios scenario
          JOIN "${schema}".custom_intents custom_intent
            ON custom_intent.key = $3
          JOIN "${schema}".flow_overrides flow_override
            ON flow_override.intent_key = $3
           AND flow_override.status = 'approved'
          JOIN "${schema}".pricing_rate_sets rate_set
            ON rate_set.rationale = 'Staged private rates'
          WHERE scenario.id = $1
            AND scenario.owner_user_id = $2
        `,
        [stagedScenario.rows[0].id, ownerUserId, stagedCustomIntentKey],
      );
      assert.equal(stagedContext.rowCount, 1);
      assert.equal(
        stagedContext.rows[0].scenario_organization_id,
        privateOrganizationId,
      );
      assert.equal(
        stagedContext.rows[0].intent_organization_id,
        privateOrganizationId,
      );
      assert.equal(
        stagedContext.rows[0].override_organization_id,
        privateOrganizationId,
      );
      assert.equal(
        stagedContext.rows[0].rate_organization_id,
        privateOrganizationId,
      );
      assert.equal(stagedContext.rows[0].custom_share, "0.1");
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    }
  },
);