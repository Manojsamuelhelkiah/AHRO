import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  }
  assert.equal(queries.at(-1), "COMMIT");
});
}
