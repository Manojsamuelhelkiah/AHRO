import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedForeignKeys,
  findTenantSafeguardFailures,
  tenantTables,
  verifyTenantSafeguards,
} from "./verify-tenant-safeguards.mjs";

function passingSnapshot() {
  return {
    columns: tenantTables.map((table_name) => ({
      table_name,
      column_default: null,
    })),
    foreignKeys: expectedForeignKeys.map((foreignKey, index) => ({
      constraint_name:
        index === 0
          ? "a_constraint_name_that_postgresql_shortened_because_it_was_far_too_long"
          : `constraint_${index}`,
      table_name: foreignKey.table,
      column_names: foreignKey.columns,
      referenced_table_name: foreignKey.referencedTable,
      referenced_column_names: foreignKey.referencedColumns,
    })),
    demoOrganizationCount: 1,
    organizationOrphanCount: 0,
    watchCaseOrphanCount: 0,
    watchCheckOrphanCount: 0,
  };
}

test("accepts safeguards by actual mappings without relying on constraint names", () => {
  assert.deepEqual(findTenantSafeguardFailures(passingSnapshot()), []);
});

test("clearly names every failed tenant safeguard", () => {
  const snapshot = passingSnapshot();
  snapshot.columns = snapshot.columns.filter(
    ({ table_name }) => table_name !== "scenarios",
  );
  snapshot.columns.find(
    ({ table_name }) => table_name === "custom_intents",
  ).column_default = "'demo'::text";
  snapshot.foreignKeys = snapshot.foreignKeys.filter(
    ({ table_name, column_names }) =>
      !(
        table_name === "onb_watch_emails" &&
        column_names.join(",") === "organization_id,case_id"
      ),
  );
  snapshot.demoOrganizationCount = 0;
  snapshot.organizationOrphanCount = 2;
  snapshot.watchCaseOrphanCount = 3;
  snapshot.watchCheckOrphanCount = 4;

  const failures = findTenantSafeguardFailures(snapshot);
  assert.deepEqual(failures, [
    "tenant column missing: scenarios.organization_id",
    "tenant default present: custom_intents.organization_id has default 'demo'::text",
    "foreign key missing: onb_watch_emails(organization_id, case_id) -> onb_cases(organization_id, id)",
    "demo organization missing: expected 1 organizations row with id demo, found 0",
    "organization orphans found: expected 0, found 2",
    "watch-case orphans found: expected 0, found 3",
    "watch-check orphans found: expected 0, found 4",
  ]);
});

test("fails a stalled database connection within the configured deadline", async () => {
  const pool = {
    connect: () => new Promise(() => {}),
  };

  await assert.rejects(
    verifyTenantSafeguards({
      connectionString: "postgres://unused",
      pool,
      connectionTimeoutMs: 5,
    }),
    /tenant safeguard database connection timed out after 5ms; production is not trusted/,
  );
});

test("applies a client and server timeout to verification statements", async () => {
  const queries = [];
  const client = {
    async query(config) {
      queries.push(config);
      if (config.text === "BEGIN TRANSACTION READ ONLY") return { rows: [] };
      if (config.text === "SELECT set_config('statement_timeout', $1, true)") {
        return { rows: [] };
      }
      throw new Error("query timeout");
    },
    release() {},
  };

  await assert.rejects(
    verifyTenantSafeguards({
      connectionString: "postgres://unused",
      pool: { connect: async () => client },
      statementTimeoutMs: 23,
    }),
    /query timeout/,
  );

  assert.deepEqual(queries[0], {
    text: "BEGIN TRANSACTION READ ONLY",
    values: undefined,
    query_timeout: 23,
  });
  assert.deepEqual(queries[1], {
    text: "SELECT set_config('statement_timeout', $1, true)",
    values: ["23ms"],
    query_timeout: 23,
  });
  assert.equal(queries.at(-1).text, "ROLLBACK");
  assert.equal(queries.at(-1).query_timeout, 23);
});

test("fails a stalled statement within the configured deadline and discards its client", async () => {
  let releasedWithError;
  const client = {
    async query(config) {
      if (config.text === "BEGIN TRANSACTION READ ONLY") return { rows: [] };
      if (config.text === "SELECT set_config('statement_timeout', $1, true)") {
        return { rows: [] };
      }
      if (config.text === "ROLLBACK") return { rows: [] };
      return new Promise(() => {});
    },
    release(error) {
      releasedWithError = error;
    },
  };

  await assert.rejects(
    verifyTenantSafeguards({
      connectionString: "postgres://unused",
      pool: { connect: async () => client },
      statementTimeoutMs: 5,
    }),
    /tenant safeguard database statement timed out after 5ms; production is not trusted/,
  );

  assert.equal(releasedWithError, true);
});
