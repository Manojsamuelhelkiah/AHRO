import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";
import {
  expectedForeignKeys,
  buildOrganizationOrphanQuery,
  findTenantSafeguardFailures,
  organizationOrphanQuery,
  organizationParentValidatedTenantTables,
  STARTUP_FAILURE_REASONS,
  tenantTables,
  DEFAULT_VERIFICATION_DEADLINE_MS,
  findTenantMetadataFailures,
  verifyTenantSafeguards,
  TRANSFER_CUSTODY_FUNCTION_DEFINITIONS,
  TRANSFER_CUSTODY_TRIGGER_DEFINITIONS,
  TRANSFER_CUSTODY_PGCRYPTO_PROBE_SHA256,
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
      table_schema: "public",
      referenced_table_schema: "public",
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

function passingTransferCustodySnapshot() {
  return {
    functions: TRANSFER_CUSTODY_FUNCTION_DEFINITIONS.map((definition) => ({
      function_schema: "public",
      function_name: definition.name,
      argument_count: 0,
      identity_arguments: "",
      return_type: "trigger",
      language_name: "plpgsql",
      function_body: definition.body,
      function_config: null,
      is_security_definer: false,
    })),
    triggers: TRANSFER_CUSTODY_TRIGGER_DEFINITIONS.map((definition) => ({
      trigger_name: definition.name,
      relation_name: definition.relation,
      relation_schema: "public",
      function_name: definition.functionName,
      function_schema: "public",
      function_argument_count: 0,
      function_identity_arguments: "",
      trigger_type: definition.type,
      enabled: "O",
      when_is_null: true,
      trigger_columns: [],
      is_internal: false,
    })),
    pgcrypto: [
      {
        extname: "pgcrypto",
        extension_schema: "public",
        digest_function_found: true,
        digest_function_oid: 12345,
        digest_function_schema: "public",
        digest_argument_count: 2,
        digest_identity_arguments: "text, text",
        digest_return_type: "bytea",
        digest_dependency_type: "e",
      },
    ],
    digestProbe: {
      sha256_hex: TRANSFER_CUSTODY_PGCRYPTO_PROBE_SHA256,
    },
    resolution: {
      search_path: '"$user", public',
      session_replication_role: "origin",
      resolved_digest_oid: 12345,
      resolved_digest_schema: "public",
      resolved_digest_name: "digest",
      resolved_digest_identity_arguments: "text, text",
      resolved_worker_oid: 23456,
      resolved_worker_schema: "public",
      resolved_worker_name: "onb_transfer_workers",
      resolved_worker_kind: "r",
    },
  };
}

test("accepts safeguards by actual mappings without relying on constraint names", () => {
  assert.deepEqual(findTenantSafeguardFailures(passingSnapshot()), []);
});

test("rejects same-named parents in another schema for simple and composite foreign keys", () => {
  for (const columns of [1, 2]) {
    const snapshot = passingSnapshot();
    const lookalike = snapshot.foreignKeys.find((fk) => fk.column_names.length === columns);
    lookalike.referenced_table_schema = "lookalike";
    assert.deepEqual(findTenantSafeguardFailures(snapshot), [
      `foreign key missing: ${lookalike.table_name}(${lookalike.column_names.join(", ")}) -> ${lookalike.referenced_table_name}(${lookalike.referenced_column_names.join(", ")})`,
    ]);
  }
});

test("namespace evidence fails closed but NOT VALID historical constraints remain accepted", () => {
  const snapshot = passingSnapshot();
  for (const fk of snapshot.foreignKeys) fk.convalidated = false;
  assert.deepEqual(findTenantSafeguardFailures(snapshot), []);
  snapshot.foreignKeys[0].table_schema = "lookalike";
  assert.equal(findTenantSafeguardFailures(snapshot).length, 1);
  snapshot.foreignKeys[0].table_schema = "public";
  delete snapshot.foreignKeys[0].referenced_table_schema;
  assert.equal(findTenantSafeguardFailures(snapshot).length, 1);
});

test("requires the exact migration 0084 custody catalog", async () => {
  const passing = passingTransferCustodySnapshot();
  const { findTransferCustodyReadinessFailures } = await import(
    "./transfer-custody-readiness.mjs"
  );
  assert.deepEqual(
    findTransferCustodyReadinessFailures({
      schema: "public",
      ...passing,
    }),
    [],
  );
  const localSession = structuredClone(passing);
  localSession.resolution.session_replication_role = "local";
  assert.ok(
    !findTransferCustodyReadinessFailures({
      schema: "public",
      ...localSession,
    }).some((failure) => failure.includes("session_replication_role")),
  );

  const malformed = structuredClone(passing);
  malformed.functions[0].function_body += " ";
  malformed.functions[1].is_security_definer = true;
  malformed.triggers[1].trigger_type = 19;
  malformed.triggers[0].trigger_columns = [1];
  malformed.triggers[2].when_is_null = false;
  malformed.pgcrypto[0].digest_dependency_type = null;
  malformed.digestProbe.sha256_hex = "not-sha256";
  malformed.resolution.session_replication_role = "replica";
  malformed.resolution.resolved_digest_oid = 99999;
  malformed.resolution.resolved_worker_schema = "shadow";
  const failures = findTransferCustodyReadinessFailures({
    schema: "public",
    ...malformed,
  });
  assert.ok(failures.some((failure) => failure.includes("body differs")));
  assert.ok(failures.some((failure) => failure.includes("SECURITY DEFINER")));
  assert.ok(failures.some((failure) => failure.includes("timing or events")));
  assert.ok(failures.some((failure) => failure.includes("WHEN predicate")));
  assert.ok(failures.some((failure) => failure.includes("column list")));
  assert.ok(failures.some((failure) => failure.includes("not a member")));
  assert.ok(
    failures.some((failure) => failure.includes("session_replication_role")),
  );
  assert.ok(
    failures.some((failure) =>
      failure.includes("does not resolve to the pgcrypto overload"),
    ),
  );
  assert.ok(
    failures.some((failure) =>
      failure.includes("does not resolve to the target schema"),
    ),
  );
  // A non-member digest must not be accepted merely because a probe value was
  // supplied by a test double.
  assert.ok(failures.some((failure) => failure.includes("digest(text, text)")));
});

test("the custody function body manifest is byte-for-byte migration 0084", async () => {
  const migration = await readFile(
    new URL(
      "../../lib/db/drizzle/0084_workforce_transfer_lifecycle_custody.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const definition of TRANSFER_CUSTODY_FUNCTION_DEFINITIONS) {
    const escapedName = definition.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = migration.match(
      new RegExp(
        `CREATE OR REPLACE FUNCTION "${escapedName}"\\(\\)\\s+` +
          "RETURNS trigger\\s+LANGUAGE plpgsql\\s+AS \\$\\$([\\s\\S]*?)\\$\\$;",
      ),
    );
    assert.ok(match, `${definition.name} is absent from migration 0084`);
    assert.equal(match[1], definition.body, `${definition.name} body drifted`);
  }
});

test("uses a bounded total verification deadline and reports missing metadata explicitly", () => {
  assert.equal(DEFAULT_VERIFICATION_DEADLINE_MS, 40_000);
  const failures = findTenantMetadataFailures({
    tables: [{ table_name: "organizations" }],
    columns: [],
    foreignKeys: [],
  });

  assert.ok(failures.some((failure) => failure === "tenant table missing: scenarios"));
  assert.ok(
    failures.some(
      (failure) => failure === "foreign key missing: onb_cases(organization_id) -> organizations(id)",
    ),
  );
});

test("retained evidence is exempt only from parent existence checks, not tenant-column checks", () => {
  // Platform audit denials use a platform scope and historical approval/audit
  // evidence deliberately survives live organization deletion. None may be
  // counted as an ordinary organization orphan.
  for (const retained of [
    "onb_approval_history",
    "onb_audit_entries",
    "onb_audit_heads",
    "onb_audit_lifecycles",
  ]) {
    assert.ok(tenantTables.includes(retained));
    assert.ok(!organizationParentValidatedTenantTables.includes(retained));
    assert.doesNotMatch(organizationOrphanQuery, new RegExp(`"${retained}"`));
  }
  assert.ok(organizationParentValidatedTenantTables.includes("onb_cases"));
  assert.match(organizationOrphanQuery, /"onb_cases"/);
  assert.deepEqual(findTenantSafeguardFailures(passingSnapshot()), []);
});

test("covers every tenant-owned sensitive lifecycle and upload reservation table", () => {
  const lifecycleTables = [
    "onb_candidate_upload_reservations",
    "onb_sensitive_lifecycle_policies",
    "onb_sensitive_lifecycle_holds",
    "onb_sensitive_object_manifests",
    "onb_sensitive_object_derivatives",
    "onb_sensitive_lifecycle_confirmations",
    "onb_sensitive_lifecycle_deletion_jobs",
    "onb_sensitive_lifecycle_scan_cursors",
  ];
  for (const table of lifecycleTables) assert.ok(tenantTables.includes(table), `${table} is missing from tenant safeguards`);

  // Only the disposable scan cursor lacks an organization parent FK; the
  // remaining lifecycle/upload records must be orphan-checked.
  assert.ok(!organizationParentValidatedTenantTables.includes("onb_sensitive_lifecycle_scan_cursors"));
  for (const table of lifecycleTables.filter((table) => table !== "onb_sensitive_lifecycle_scan_cursors")) {
    assert.ok(organizationParentValidatedTenantTables.includes(table), `${table} must have an organization parent FK`);
  }
  assert.ok(expectedForeignKeys.some((fk) =>
    fk.table === "onb_sensitive_object_derivatives" &&
    fk.columns.join(",") === "manifest_id" &&
    fk.referencedTable === "onb_sensitive_object_manifests" &&
    fk.referencedColumns.join(",") === "id",
  ));
});

test("covers all workforce-transfer representations and their composite custody links", () => {
  const transferTables = [
    "onb_transfer_programs",
    "onb_transfer_pathways",
    "onb_transfer_data_governance",
    "onb_transfer_populations",
    "onb_transfer_import_previews",
    "onb_transfer_imports",
    "onb_transfer_workers",
    "onb_transfer_consultation_milestones",
    "onb_transfer_objections",
    "onb_transfer_integration_actions",
    "onb_transfer_operational_supersessions",
    "onb_transfer_cutover_plans",
    "onb_transfer_cutover_reconciliations",
    "onb_transfer_cutover_signoffs",
    "onb_transfer_reconciliation_repairs",
    "onb_transfer_kpi_evidence",
    "onb_transfer_kpi_definitions",
  ];
  assert.equal(transferTables.length, 17);
  for (const table of transferTables) {
    assert.ok(tenantTables.includes(table), `${table} is missing from tenant safeguards`);
    assert.ok(organizationParentValidatedTenantTables.includes(table), `${table} must have an organization parent FK`);
  }
  assert.ok(expectedForeignKeys.some((fk) =>
    fk.table === "onb_transfer_workers" &&
    fk.columns.join(",") === "organization_id,import_id" &&
    fk.referencedTable === "onb_transfer_imports",
  ));
  assert.ok(expectedForeignKeys.some((fk) =>
    fk.table === "onb_transfer_cutover_reconciliations" &&
    fk.columns.join(",") === "organization_id,plan_id" &&
    fk.referencedTable === "onb_transfer_cutover_plans",
  ));
  assert.ok(expectedForeignKeys.some((fk) =>
    fk.table === "onb_transfer_operational_supersessions" &&
    fk.columns.join(",") === "organization_id,program_id" &&
    fk.referencedTable === "onb_transfer_programs",
  ));
});

test("an orphan in an ordinary organization-owned table still fails verification", () => {
  const snapshot = passingSnapshot();
  snapshot.organizationOrphanCount = 1;
  assert.ok(
    findTenantSafeguardFailures(snapshot).includes(
      "organization orphans found: expected 0, found 1",
    ),
  );
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
    (error) => {
      assert.equal(
        error.reasonCategory,
        STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT,
      );
      assert.match(
        error.message,
        /tenant safeguard database connection timed out after 5ms; production is not trusted/,
      );
      return true;
    },
  );
});

test("a real stalled pg handshake exits promptly with a connection-timeout reason", async () => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const connectionString = `postgres://user:password@127.0.0.1:${port}/database`;
  const childSource = `
    import { startProduction } from ${JSON.stringify(
      new URL("./start-production.mjs", import.meta.url).href,
    )};
    import {
      STARTUP_FAILURE_REASONS,
      verifyTenantSafeguards,
    } from ${JSON.stringify(
      new URL("./verify-tenant-safeguards.mjs", import.meta.url).href,
    )};

    startProduction({
      validateBackupAlertReadiness: () => [],
      verify: () =>
        verifyTenantSafeguards({
          connectionTimeoutMs: 30,
        }),
      startApi: async () => {
        process.exitCode = 3;
      },
    }).catch((error) => {
      console.error(error.message);
      process.exitCode =
        error.reasonCategory === STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT
          ? 1
          : 2;
    });
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", childSource],
    {
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  let timer;
  try {
    const exit = await Promise.race([
      new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("stalled-handshake child did not exit within 2s"));
        }, 2_000);
      }),
    ]);

    assert.deepEqual(exit, { code: 1, signal: null });
    assert.match(output, /reason=CONNECTION_TIMEOUT/);
    assert.match(output, /production is not trusted/);
    assert.doesNotMatch(output, /user:password|127\.0\.0\.1|\/database/);
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
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
    query_timeout: 0,
  });
  assert.deepEqual(queries[1], {
    text: "SELECT set_config('statement_timeout', $1, true)",
    values: ["23ms"],
    query_timeout: 0,
  });
  assert.equal(queries.at(-1).text, "ROLLBACK");
  assert.equal(queries.at(-1).query_timeout, 0);
});

test("normalizes a competing pg query timer as a statement timeout", async () => {
  let releasedWithError;
  const client = {
    async query(config) {
      if (config.text === "ROLLBACK") return { rows: [] };
      throw new Error("Query read timeout");
    },
    release(error) {
      releasedWithError = error;
    },
  };

  await assert.rejects(
    verifyTenantSafeguards({
      connectionString: "postgres://unused",
      pool: { connect: async () => client },
      statementTimeoutMs: 17,
    }),
    (error) => {
      assert.equal(
        error.reasonCategory,
        STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT,
      );
      assert.match(
        error.message,
        /database statement timed out after 17ms; production is not trusted/,
      );
      return true;
    },
  );

  assert.equal(releasedWithError, true);
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
    (error) => {
      assert.equal(
        error.reasonCategory,
        STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT,
      );
      assert.match(
        error.message,
        /tenant safeguard database statement timed out after 5ms; production is not trusted/,
      );
      return true;
    },
  );

  assert.equal(releasedWithError, true);
});

test("stops before orphan queries when tenant metadata is missing", async () => {
  const queries = [];
  const stages = [];
  const client = {
    async query(config) {
      queries.push(config.text);
      if (config.text === "BEGIN TRANSACTION READ ONLY") return { rows: [] };
      if (config.text === "SELECT set_config('statement_timeout', $1, true)") {
        return { rows: [] };
      }
      if (config.text === "SELECT current_schema() AS schema_name") {
        return { rows: [{ schema_name: "public" }] };
      }
      if (config.text.includes("FROM information_schema.tables")) {
        return { rows: [] };
      }
      if (config.text.includes("FROM information_schema.columns")) {
        return { rows: [] };
      }
      if (config.text.includes("FROM pg_constraint")) {
        return { rows: [] };
      }
      if (config.text === "COMMIT") return { rows: [] };
      throw new Error(`unexpected query: ${config.text}`);
    },
    release() {},
  };

  const result = await verifyTenantSafeguards({
    connectionString: "postgres://unused",
    pool: { connect: async () => client },
    stageLogger: (event) => stages.push(event),
  });

  assert.ok(result.failures.some((failure) => failure === "tenant table missing: scenarios"));
  assert.ok(!queries.includes(organizationOrphanQuery));
  assert.equal(
    queries.some((query) => query.includes('"onb_watch_emails" watch')),
    false,
  );
  assert.ok(stages.some(({ stage, phase }) => stage === "tenant-tables" && phase === "begin"));
  assert.ok(stages.some(({ stage, phase }) => stage === "tenant-tables" && phase === "end"));
  for (const event of stages) {
    assert.deepEqual(Object.keys(event).sort(), ["elapsedMs", "event", "phase", "stage"]);
    assert.equal(event.event, "tenant_safeguard_stage");
    assert.equal(typeof event.elapsedMs, "number");
  }
});

for (const { schema, foreignParent } of [
  { schema: "public", foreignParent: false },
  { schema: 'tenant "quoted"', foreignParent: false },
  { schema: "public", foreignParent: true },
]) {
test(`verifier binds metadata and data to ${schema} (foreign parent: ${foreignParent})`, async () => {
  const queries = [];
  const custody = passingTransferCustodySnapshot();
  for (const fn of custody.functions) fn.function_schema = schema;
  for (const trigger of custody.triggers) {
    trigger.relation_schema = schema;
    trigger.function_schema = schema;
  }
  custody.resolution.resolved_worker_schema = schema;
  const qualified = (table) => `"${schema.replaceAll('"', '""')}"."${table}"`;
  const client = {
    async query(config) {
      queries.push(config.text);
      if (config.text === "BEGIN TRANSACTION READ ONLY") return { rows: [] };
      if (config.text === "SELECT set_config('statement_timeout', $1, true)") {
        return { rows: [] };
      }
      if (config.text === "SELECT current_schema() AS schema_name") {
        return { rows: [{ schema_name: schema }] };
      }
      if (config.text.includes("FROM information_schema.tables")) {
        return { rows: tenantTables.map((table_name) => ({ table_name })) };
      }
      if (config.text.includes("FROM information_schema.columns")) {
        return {
          rows: tenantTables.map((table_name) => ({
            table_name,
            column_default: null,
          })),
        };
      }
      if (config.text.includes("FROM pg_constraint")) {
        assert.deepEqual(config.values, [schema]);
        assert.match(config.text, /referenced_namespace\.oid = referenced_relation\.relnamespace/);
        assert.match(config.text, /referenced_namespace\.nspname = \$1/);
        // Historical NOT VALID constraints enforce new writes and must still
        // be considered; namespace hardening must not filter them out.
        assert.doesNotMatch(config.text, /convalidated/);
        return {
          rows: expectedForeignKeys.map((foreignKey, index) => ({
            table_schema: schema,
            referenced_table_schema: foreignParent && index === 0 ? "lookalike" : schema,
            convalidated: false,
            table_name: foreignKey.table,
            column_names: foreignKey.columns,
            referenced_table_name: foreignKey.referencedTable,
            referenced_column_names: foreignKey.referencedColumns,
          })),
        };
      }
      if (config.text.includes("FROM pg_proc procedure_record")) {
        return { rows: custody.functions };
      }
      if (config.text.includes("FROM pg_trigger trigger_record")) {
        return { rows: custody.triggers };
      }
      if (config.text.includes("FROM pg_extension extension_record")) {
        return { rows: passingTransferCustodySnapshot().pgcrypto };
      }
      if (config.text.includes("session_replication_role")) {
        return { rows: [custody.resolution] };
      }
      if (config.text.includes("AS sha256_hex")) {
        return { rows: [passingTransferCustodySnapshot().digestProbe] };
      }
      if (config.text.includes(`FROM ${qualified("organizations")} WHERE id = 'demo'`)) {
        return { rows: [{ row_count: 1 }] };
      }
      if (config.text === buildOrganizationOrphanQuery(schema)) {
        for (const table of organizationParentValidatedTenantTables) {
          assert.ok(config.text.includes(`FROM ${qualified(table)} child`));
        }
        assert.ok(config.text.includes(`LEFT JOIN ${qualified("organizations")} parent`));
        return { rows: [{ orphan_count: 0 }] };
      }
      if (config.text.includes(`FROM ${qualified("onb_watch_emails")} watch`)) {
        assert.ok(config.text.includes(`LEFT JOIN ${qualified("onb_cases")} parent_case`));
        assert.ok(config.text.includes(`LEFT JOIN ${qualified("onb_system_checks")} parent_check`));
        return {
          rows: [{ case_orphan_count: 0, check_orphan_count: 0 }],
        };
      }
      if (config.text === "COMMIT") return { rows: [] };
      throw new Error(`unexpected query: ${config.text}`);
    },
    release() {},
  };

  const result = await verifyTenantSafeguards({
    connectionString: "postgres://unused",
    pool: { connect: async () => client },
    stageLogger: () => {},
  });

  assert.equal(result.schema, schema);
  if (foreignParent) {
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /^foreign key missing:/);
    assert.ok(!queries.some((query) => /row_count|orphan_count/.test(query)));
  } else {
    assert.deepEqual(result.failures, []);
    assert.ok(queries.includes(buildOrganizationOrphanQuery(schema)));
    assert.ok(queries.some((query) => query.includes(`FROM ${qualified("onb_watch_emails")} watch`)));
    assert.ok(queries.some((query) => query.includes("session_replication_role")));
    assert.ok(queries.some((query) => query.includes("to_regprocedure('digest")));
    assert.ok(queries.some((query) => query.includes("to_regclass('onb_transfer_workers")));
  }
  assert.equal(queries.at(-1), "COMMIT");
  assert.ok(
    queries.every(
      (query) => !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(query),
    ),
  );
});
}
