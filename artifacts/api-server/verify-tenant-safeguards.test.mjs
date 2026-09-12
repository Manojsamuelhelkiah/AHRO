import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import {
  expectedForeignKeys,
  findTenantSafeguardFailures,
  organizationOrphanQuery,
  organizationParentValidatedTenantTables,
  STARTUP_FAILURE_REASONS,
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
