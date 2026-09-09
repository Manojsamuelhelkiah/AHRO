import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedForeignKeys,
  findTenantSafeguardFailures,
  tenantTables,
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
