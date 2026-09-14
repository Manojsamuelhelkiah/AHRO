/*
 * This is deliberately a standalone database test rather than part of the
 * application test bundle.  Run it with the development connection only:
 *
 *   NODE_ENV=development DATABASE_URL="$DATABASE_URL" \
 *     node --test ./transfer-custody-migration.test.mjs
 *
 * The fixture schema and every object in it are created inside one
 * transaction and rolled back before the connection is released.  This test
 * must never be pointed at a production database.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  loadCheckedInMigrations,
} from "./test-db-setup.mjs";
import {
  TRANSFER_CUSTODY_FUNCTION_DEFINITIONS,
  TRANSFER_CUSTODY_FUNCTION_NAMES,
  TRANSFER_CUSTODY_MIGRATION_TAG,
  TRANSFER_CUSTODY_PGCRYPTO_PROBE_INPUT,
  TRANSFER_CUSTODY_PGCRYPTO_PROBE_SHA256,
  TRANSFER_CUSTODY_TRIGGER_DEFINITIONS,
  TRANSFER_CUSTODY_TRIGGER_NAMES,
  findTransferCustodyReadinessFailures,
  transferCustodyDigestProbeQuery,
  transferCustodyFunctionsQuery,
  transferCustodyPgcryptoQuery,
  transferCustodyResolutionQuery,
  transferCustodyTriggersQuery,
} from "./transfer-custody-readiness.mjs";

const hasDatabase = Boolean(process.env.DATABASE_URL);

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function uniqueSchemaName() {
  return `api_test_custody_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function migrationByTag(migrations, tag) {
  const migration = migrations.find((candidate) => candidate.tag === tag);
  assert.ok(migration, `checked-in migration ${tag} is missing`);
  return migration;
}

async function assertExpectedFailure(client, sql, values, pattern, label) {
  const savepoint = `custody_negative_${assertExpectedFailure.counter++}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let error;
  try {
    await client.query(sql, values);
  } catch (candidate) {
    error = candidate;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert.ok(error, `${label} unexpectedly succeeded`);
  assert.match(String(error.message), pattern, label);
}
assertExpectedFailure.counter = 0;

test(
  "migration 0084 enforces custody semantics and readiness on isolated PostgreSQL catalogs",
  { skip: !hasDatabase },
  async () => {
    assert.equal(
      process.env.NODE_ENV,
      "development",
      "refusing to run custody database tests unless NODE_ENV=development",
    );

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    const schema = uniqueSchemaName();
    const qualifiedSchema = quoteIdentifier(schema);
    let transactionOpen = false;

    try {
      // Discover the real extension location without changing the shared
      // database.  The migration itself is still executed byte-for-byte.
      const installedExtension = await client.query(`
        SELECT namespace_record.nspname AS schema_name
        FROM pg_extension extension_record
        JOIN pg_namespace namespace_record
          ON namespace_record.oid = extension_record.extnamespace
        WHERE extension_record.extname = 'pgcrypto'
      `);
      const installedExtensionSchema =
        installedExtension.rows[0]?.schema_name;

      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(`CREATE SCHEMA ${qualifiedSchema}`);
      const searchPath = [
        schema,
        installedExtensionSchema,
        "public",
        "pg_catalog",
      ]
        .filter((candidate, index, candidates) =>
          candidate && candidates.indexOf(candidate) === index,
        )
        .map(quoteIdentifier)
        .join(", ");
      await client.query(`SET LOCAL search_path TO ${searchPath}`);

      // These are the smallest useful pre-0084 shapes.  In particular, the
      // source-fingerprint columns do not exist until the checked-in
      // migration adds them, so the UPDATE backfills real legacy rows.
      await client.query(`
        CREATE TABLE "onb_transfer_data_governance" (
          "id" text NOT NULL,
          "lawful_basis_reference" text NOT NULL,
          "retention_reference" text NOT NULL,
          "retention_until" timestamp with time zone NOT NULL,
          "authority_assignment_id" text NOT NULL,
          "authority_assignment_revision" integer NOT NULL
        );
        CREATE TABLE "onb_transfer_workers" (
          "organization_id" text NOT NULL,
          "id" text NOT NULL,
          "source_payload" jsonb NOT NULL,
          "original_hire_date" timestamp with time zone NOT NULL,
          "continuous_service_date" timestamp with time zone NOT NULL
        );
        CREATE TABLE "onb_transfer_cutover_reconciliations" (
          "id" text NOT NULL,
          "organization_id" text NOT NULL,
          "worker_id" text NOT NULL,
          "stream" text NOT NULL
        );
        CREATE TABLE "onb_sensitive_lifecycle_deletion_jobs" (
          "id" text NOT NULL
        );
      `);

      const baselineGovernance = {
        lawful_basis_reference: "basis-v1",
        retention_reference: "retention-v1",
        retention_until: new Date("2030-01-01T00:00:00.000Z"),
        authority_assignment_id: "authority-v1",
        authority_assignment_revision: 1,
      };
      const governanceCases = [
        {
          field: "lawful_basis_reference",
          value: "basis-v2",
          type: "text",
        },
        {
          field: "retention_reference",
          value: "retention-v2",
          type: "text",
        },
        {
          field: "retention_until",
          value: new Date("2031-01-01T00:00:00.000Z"),
          type: "date",
        },
        {
          field: "authority_assignment_id",
          value: "authority-v2",
          type: "text",
        },
        {
          field: "authority_assignment_revision",
          value: 2,
          type: "integer",
        },
      ];

      for (const { field, value } of governanceCases) {
        await client.query(
          `
            INSERT INTO "onb_transfer_data_governance"
              ("id", "lawful_basis_reference", "retention_reference",
               "retention_until", "authority_assignment_id",
               "authority_assignment_revision")
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            `bump-${field}`,
            baselineGovernance.lawful_basis_reference,
            baselineGovernance.retention_reference,
            baselineGovernance.retention_until,
            baselineGovernance.authority_assignment_id,
            baselineGovernance.authority_assignment_revision,
          ],
        );
        await client.query(
          `
            INSERT INTO "onb_transfer_data_governance"
              ("id", "lawful_basis_reference", "retention_reference",
               "retention_until", "authority_assignment_id",
               "authority_assignment_revision")
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            `noop-${field}`,
            baselineGovernance.lawful_basis_reference,
            baselineGovernance.retention_reference,
            baselineGovernance.retention_until,
            baselineGovernance.authority_assignment_id,
            baselineGovernance.authority_assignment_revision,
          ],
        );
      }

      await client.query(
        `
          INSERT INTO "onb_transfer_workers"
            ("organization_id", "id", "source_payload",
             "original_hire_date", "continuous_service_date")
          VALUES
            ('org-a', 'worker-legacy',
             '{"name":"legacy","source":1}'::jsonb,
             '2020-01-02T00:00:00Z', '2020-01-03T00:00:00Z')
        `,
      );
      await client.query(
        `
          INSERT INTO "onb_transfer_cutover_reconciliations"
            ("id", "organization_id", "worker_id", "stream")
          VALUES ('reconciliation-legacy', 'org-a', 'worker-legacy', 'migration')
        `,
      );
      await client.query(
        `INSERT INTO "onb_sensitive_lifecycle_deletion_jobs" ("id")
         VALUES ('job-legacy')`,
      );

      const migrations = await loadCheckedInMigrations();
      const custodyMigration = migrationByTag(
        migrations,
        TRANSFER_CUSTODY_MIGRATION_TAG,
      );
      assert.ok(
        custodyMigration.statements.some((statement) =>
          statement.includes(
            'CREATE OR REPLACE FUNCTION "onb_transfer_worker_source_custody"',
          ),
        ),
        "the test must execute the checked-in worker custody function",
      );
      assert.ok(
        custodyMigration.statements.some((statement) =>
          statement.includes(
            'CREATE TRIGGER "onb_transfer_workers_source_custody"',
          ),
        ),
        "the test must execute the checked-in worker custody trigger",
      );

      // Do not re-create this SQL in the test: execute every statement parsed
      // from the checked-in 0084 file in its original order.
      for (const statement of custodyMigration.statements) {
        await client.query(statement);
      }

      const fingerprintForWorker = async (workerId) => {
        const result = await client.query(
          `
            SELECT
              "source_fingerprint",
              encode(digest("source_payload"::text, 'sha256'), 'hex')
                AS expected_fingerprint
            FROM "onb_transfer_workers"
            WHERE "organization_id" = 'org-a' AND "id" = $1
          `,
          [workerId],
        );
        assert.equal(result.rowCount, 1, `worker ${workerId} should exist`);
        return result.rows[0];
      };

      const legacyWorker = await fingerprintForWorker("worker-legacy");
      assert.equal(
        legacyWorker.source_fingerprint,
        legacyWorker.expected_fingerprint,
        "0084 must backfill legacy worker custody fingerprints",
      );
      const legacyReconciliation = await client.query(
        `
          SELECT "source_fingerprint"
          FROM "onb_transfer_cutover_reconciliations"
          WHERE "id" = 'reconciliation-legacy'
        `,
      );
      assert.equal(
        legacyReconciliation.rows[0].source_fingerprint,
        legacyWorker.source_fingerprint,
        "0084 must bind legacy reconciliations to the worker fingerprint",
      );

      const governanceDefaults = await client.query(`
        SELECT
          (SELECT "revision" FROM "onb_transfer_data_governance"
           WHERE "id" = 'bump-lawful_basis_reference') AS revision,
          (SELECT "transfer_retention_snapshot"
           FROM "onb_sensitive_lifecycle_deletion_jobs"
           WHERE "id" = 'job-legacy') AS transfer_retention_snapshot
      `);
      assert.equal(governanceDefaults.rows[0].revision, 1);
      assert.deepEqual(
        governanceDefaults.rows[0].transfer_retention_snapshot,
        {},
        "the migration must install the empty retention snapshot default",
      );

      const forgedWorkerInsert = await client.query(`
        INSERT INTO "onb_transfer_workers"
          ("organization_id", "id", "source_payload",
           "original_hire_date", "continuous_service_date",
           "source_fingerprint")
        VALUES
          ('org-a', 'worker-forged', '{"name":"forged"}'::jsonb,
           '2021-02-01T00:00:00Z', '2021-02-02T00:00:00Z',
           'forged-worker-fingerprint')
        RETURNING "source_fingerprint"
      `);
      const forgedWorker = await fingerprintForWorker("worker-forged");
      assert.notEqual(
        forgedWorkerInsert.rows[0].source_fingerprint,
        "forged-worker-fingerprint",
        "a forged fingerprint must not be accepted on worker INSERT",
      );
      assert.equal(
        forgedWorker.source_fingerprint,
        forgedWorker.expected_fingerprint,
      );

      const originalForgedWorker = await client.query(
        `
          SELECT "source_payload", "original_hire_date",
                 "continuous_service_date", "source_fingerprint"
          FROM "onb_transfer_workers"
          WHERE "organization_id" = 'org-a' AND "id" = 'worker-forged'
        `,
      );
      const immutableWorker = originalForgedWorker.rows[0];
      await assertExpectedFailure(
        client,
        `
          UPDATE "onb_transfer_workers"
          SET "source_payload" = '{"name":"tampered"}'::jsonb
          WHERE "organization_id" = 'org-a' AND "id" = 'worker-forged'
        `,
        [],
        /source payload and preserved service dates are immutable custody evidence/,
        "source payload mutation",
      );
      await assertExpectedFailure(
        client,
        `
          UPDATE "onb_transfer_workers"
          SET "original_hire_date" = '2021-03-01T00:00:00Z'
          WHERE "organization_id" = 'org-a' AND "id" = 'worker-forged'
        `,
        [],
        /source payload and preserved service dates are immutable custody evidence/,
        "original hire date mutation",
      );
      await assertExpectedFailure(
        client,
        `
          UPDATE "onb_transfer_workers"
          SET "continuous_service_date" = '2021-03-03T00:00:00Z'
          WHERE "organization_id" = 'org-a' AND "id" = 'worker-forged'
        `,
        [],
        /source payload and preserved service dates are immutable custody evidence/,
        "continuous service date mutation",
      );
      await assertExpectedFailure(
        client,
        `
          UPDATE "onb_transfer_workers"
          SET "source_fingerprint" = 'forged-update-fingerprint'
          WHERE "organization_id" = 'org-a' AND "id" = 'worker-forged'
        `,
        [],
        /source payload and preserved service dates are immutable custody evidence/,
        "source fingerprint mutation",
      );
      const unchangedWorker = await client.query(
        `
          SELECT "source_payload", "original_hire_date",
                 "continuous_service_date", "source_fingerprint"
          FROM "onb_transfer_workers"
          WHERE "organization_id" = 'org-a' AND "id" = 'worker-forged'
        `,
      );
      assert.deepEqual(unchangedWorker.rows[0], immutableWorker);

      await client.query(`
        INSERT INTO "onb_transfer_workers"
          ("organization_id", "id", "source_payload",
           "original_hire_date", "continuous_service_date",
           "source_fingerprint")
        VALUES
          ('org-a', 'worker-second', '{"name":"second"}'::jsonb,
           '2022-03-01T00:00:00Z', '2022-03-02T00:00:00Z',
           'forged-second-fingerprint')
      `);
      const secondWorker = await fingerprintForWorker("worker-second");
      assert.notEqual(
        secondWorker.source_fingerprint,
        "forged-second-fingerprint",
      );

      const reconciliationInsert = await client.query(`
        INSERT INTO "onb_transfer_cutover_reconciliations"
          ("id", "organization_id", "worker_id", "stream",
           "source_fingerprint")
        VALUES
          ('reconciliation-forged', 'org-a', 'worker-forged', 'payroll',
           'forged-reconciliation-fingerprint')
        RETURNING "source_fingerprint"
      `);
      assert.equal(
        reconciliationInsert.rows[0].source_fingerprint,
        forgedWorker.source_fingerprint,
        "reconciliation INSERT must bind to the worker fingerprint",
      );
      const reboundReconciliation = await client.query(`
        UPDATE "onb_transfer_cutover_reconciliations"
        SET "worker_id" = 'worker-second',
            "source_fingerprint" = 'forged-reconciliation-update'
        WHERE "id" = 'reconciliation-forged'
        RETURNING "source_fingerprint"
      `);
      assert.equal(
        reboundReconciliation.rows[0].source_fingerprint,
        secondWorker.source_fingerprint,
        "reconciliation UPDATE must rebind to the new worker fingerprint",
      );
      await assertExpectedFailure(
        client,
        `
          UPDATE "onb_transfer_cutover_reconciliations"
          SET "worker_id" = 'worker-does-not-exist'
          WHERE "id" = 'reconciliation-forged'
        `,
        [],
        /transfer reconciliation requires immutable source worker custody/,
        "missing worker reconciliation update",
      );
      await assertExpectedFailure(
        client,
        `
          INSERT INTO "onb_transfer_cutover_reconciliations"
            ("id", "organization_id", "worker_id", "stream",
             "source_fingerprint")
          VALUES
            ('reconciliation-missing', 'org-a', 'worker-does-not-exist',
             'benefits', 'forged-missing-worker')
        `,
        [],
        /transfer reconciliation requires immutable source worker custody/,
        "missing worker reconciliation insert",
      );

      for (const { field, value, type } of governanceCases) {
        const bump = await client.query(
          `
            UPDATE "onb_transfer_data_governance"
            SET ${quoteIdentifier(field)} = $1
            WHERE "id" = $2
            RETURNING "revision"
          `,
          [value, `bump-${field}`],
        );
        assert.equal(
          bump.rows[0].revision,
          2,
          `${type} governance field ${field} must bump revision`,
        );
        const noOp = await client.query(
          `
            UPDATE "onb_transfer_data_governance"
            SET ${quoteIdentifier(field)} = ${quoteIdentifier(field)}
            WHERE "id" = $1
            RETURNING "revision"
          `,
          [`noop-${field}`],
        );
        assert.equal(
          noOp.rows[0].revision,
          1,
          `${type} governance field ${field} no-op must not bump revision`,
        );
      }

      const readCatalog = async () => {
        const functions = await client.query(transferCustodyFunctionsQuery, [
          schema,
          TRANSFER_CUSTODY_FUNCTION_NAMES,
        ]);
        const triggers = await client.query(transferCustodyTriggersQuery, [
          schema,
          TRANSFER_CUSTODY_TRIGGER_NAMES,
        ]);
        const pgcrypto = await client.query(transferCustodyPgcryptoQuery);
        const pgcryptoRow = pgcrypto.rows.find(
          (row) => row.extname === "pgcrypto",
        );
        const resolution = transferCustodyResolutionQuery.includes("$1")
          ? await client.query(transferCustodyResolutionQuery, [
              schema,
              pgcryptoRow?.digest_function_oid ?? null,
            ])
          : await client.query(transferCustodyResolutionQuery);
        const digestProbe = pgcryptoRow?.digest_function_found
          ? (
              await client.query(
                transferCustodyDigestProbeQuery(),
                [TRANSFER_CUSTODY_PGCRYPTO_PROBE_INPUT],
              )
            ).rows[0]
          : undefined;
        return {
          functions: functions.rows,
          triggers: triggers.rows,
          pgcrypto: pgcrypto.rows,
          digestProbe,
          resolution: resolution.rows[0],
        };
      };

      const readiness = async () => {
        const catalog = await readCatalog();
        return {
          catalog,
          failures: findTransferCustodyReadinessFailures({
            schema,
            functions: catalog.functions,
            triggers: catalog.triggers,
            pgcrypto: catalog.pgcrypto,
            digestProbe: catalog.digestProbe,
            resolution: catalog.resolution,
          }),
        };
      };

      const installedReadiness = await readiness();
      assert.deepEqual(
        installedReadiness.failures,
        [],
        installedReadiness.failures.join("; "),
      );
      assert.equal(
        installedReadiness.catalog.digestProbe.sha256_hex,
        TRANSFER_CUSTODY_PGCRYPTO_PROBE_SHA256,
        "readiness must probe the real installed pgcrypto digest function",
      );
      assert.equal(
        installedReadiness.catalog.functions.length,
        TRANSFER_CUSTODY_FUNCTION_DEFINITIONS.length,
      );
      assert.equal(
        installedReadiness.catalog.triggers.length,
        TRANSFER_CUSTODY_TRIGGER_DEFINITIONS.length,
      );

      const sabotage = async (name, setup, expectedFailure) => {
        const savepoint = `custody_readiness_${name}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          await setup();
          const result = await readiness();
          assert.match(
            result.failures.join("; "),
            expectedFailure,
            `${name} safeguard did not report a catalog mismatch`,
          );
        } finally {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        }
      };

      await sabotage(
        "disabled_worker_trigger",
        () =>
          client.query(
            `ALTER TABLE ${qualifiedSchema}."onb_transfer_workers"
             DISABLE TRIGGER ${quoteIdentifier(
               "onb_transfer_workers_source_custody",
             )}`,
          ),
        /is not enabled for origin sessions/,
      );
      await sabotage(
        "missing_reconciliation_trigger",
        () =>
          client.query(
            `DROP TRIGGER ${quoteIdentifier(
              "onb_transfer_reconciliations_source_custody",
            )} ON ${qualifiedSchema}."onb_transfer_cutover_reconciliations"`,
          ),
        /transfer custody trigger missing/,
      );
      await sabotage(
        "wrong_function_body",
        () =>
          client.query(`
            CREATE OR REPLACE FUNCTION ${qualifiedSchema}."onb_transfer_worker_source_custody"()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $wrong_body$
            BEGIN
              RETURN NEW;
            END;
            $wrong_body$
          `),
        /body differs from migration 0084/,
      );
      await sabotage(
        "wrong_trigger_function",
        async () => {
          await client.query(`
            CREATE FUNCTION ${qualifiedSchema}."wrong_transfer_custody"()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $wrong_trigger$
            BEGIN
              RETURN NEW;
            END;
            $wrong_trigger$
          `);
          await client.query(
            `DROP TRIGGER ${quoteIdentifier(
              "onb_transfer_workers_source_custody",
            )} ON ${qualifiedSchema}."onb_transfer_workers"`,
          );
          await client.query(`
            CREATE TRIGGER "onb_transfer_workers_source_custody"
            BEFORE INSERT OR UPDATE ON ${qualifiedSchema}."onb_transfer_workers"
            FOR EACH ROW
            EXECUTE FUNCTION ${qualifiedSchema}."wrong_transfer_custody"()
          `);
        },
        /executes an unexpected function/,
      );

      await client.query("ROLLBACK");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        await client.query("ROLLBACK").catch(() => {});
      }
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  },
);