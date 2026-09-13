import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  expectedForeignKeys,
  organizationParentValidatedTenantTables,
  tenantTables,
} from "./tenant-safeguards-manifest.mjs";

export {
  expectedForeignKeys,
  organizationParentValidatedTenantTables,
  tenantTables,
};

export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_VERIFICATION_DEADLINE_MS = 40_000;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 250;
export const STARTUP_FAILURE_REASONS = Object.freeze({
  BACKUP_ALERT_CONFIGURATION: "BACKUP_ALERT_CONFIGURATION",
  CONNECTION_TIMEOUT: "CONNECTION_TIMEOUT",
  STATEMENT_TIMEOUT: "STATEMENT_TIMEOUT",
  VERIFICATION_TIMEOUT: "VERIFICATION_TIMEOUT",
  SAFEGUARD_MISMATCH: "SAFEGUARD_MISMATCH",
});

function timeoutError(kind, timeoutMs, reasonCategory) {
  const error = new Error(
    `tenant safeguard ${kind} timed out after ${timeoutMs}ms; production is not trusted`,
  );
  error.code = "TENANT_SAFEGUARD_TIMEOUT";
  error.reasonCategory = reasonCategory;
  return error;
}

function verificationTimeoutError(timeoutMs) {
  return timeoutError(
    "verification",
    timeoutMs,
    STARTUP_FAILURE_REASONS.VERIFICATION_TIMEOUT,
  );
}

function isStatementTimeoutError(error) {
  return (
    error?.message === "Query read timeout" ||
    (error?.code === "57014" && /statement timeout/i.test(error.message ?? ""))
  );
}

function isConnectionTimeoutError(error) {
  return (
    error?.message === "timeout expired" ||
    error?.message === "Connection terminated due to connection timeout"
  );
}

function positiveTimeout(value, fallback, optionName) {
  const timeoutMs = value ?? fallback;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`${optionName} must be a non-negative finite number`);
  }
  return Math.floor(timeoutMs);
}

function remainingBudget(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

function operationBudget(timeoutMs, deadlineAt, timeoutReason) {
  const remainingMs = remainingBudget(deadlineAt);
  if (remainingMs <= 0) {
    throw verificationTimeoutError(0);
  }
  if (timeoutMs <= remainingMs) {
    return {
      timeoutMs,
      timeoutReason,
    };
  }
  return {
    timeoutMs: remainingMs,
    timeoutReason: STARTUP_FAILURE_REASONS.VERIFICATION_TIMEOUT,
  };
}

async function runWithTimeout(operation, timeoutMs, timeoutFactory) {
  let timer;
  if (timeoutMs <= 0) {
    throw timeoutFactory();
  }
  let operationResult;
  try {
    operationResult = Promise.resolve().then(operation);
  } catch (error) {
    operationResult = Promise.reject(error);
  }
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(timeoutFactory()),
      timeoutMs,
    );
    timer.unref?.();
  });

  try {
    return await Promise.race([operationResult, timeout]);
  } finally {
    clearTimeout(timer);
    // A timed-out pg operation may reject or resolve after verification has
    // already failed. Keep that late settlement from becoming unhandled, but
    // never wait for it as part of the startup gate.
    operationResult.catch(() => {});
  }
}

async function connectWithTimeout(pool, timeoutMs, deadlineAt) {
  const budget = operationBudget(
    timeoutMs,
    deadlineAt,
    STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT,
  );
  const rawConnection = Promise.resolve().then(() => pool.connect());
  const connection = runWithTimeout(
    () => rawConnection,
    budget.timeoutMs,
    () =>
      budget.timeoutReason === STARTUP_FAILURE_REASONS.VERIFICATION_TIMEOUT
        ? verificationTimeoutError(budget.timeoutMs)
        : timeoutError(
            "database connection",
            budget.timeoutMs,
            STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT,
          ),
  );

  try {
    return await connection;
  } catch (error) {
    if (
      error?.reasonCategory === STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT ||
      error?.reasonCategory === STARTUP_FAILURE_REASONS.VERIFICATION_TIMEOUT
    ) {
      rawConnection.then(
        (lateClient) => lateClient?.release?.(true),
        () => {},
      );
    }
    if (
      budget.timeoutReason === STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT &&
      isConnectionTimeoutError(error)
    ) {
      throw timeoutError(
        "database connection",
        budget.timeoutMs,
        STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT,
      );
    }
    throw error;
  }
}

async function queryWithTimeout(
  client,
  text,
  values,
  timeoutMs,
  deadlineAt,
) {
  const budget = operationBudget(
    timeoutMs,
    deadlineAt,
    STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT,
  );
  const query = runWithTimeout(
    () =>
      client.query({
        text,
        values,
        // This wrapper owns the client deadline so pg cannot reject first with
        // an unclassified "Query read timeout". PostgreSQL's server-side
        // timeout remains enabled separately and is normalized below.
        query_timeout: 0,
      }),
    budget.timeoutMs,
    () =>
      budget.timeoutReason === STARTUP_FAILURE_REASONS.VERIFICATION_TIMEOUT
        ? verificationTimeoutError(budget.timeoutMs)
        : timeoutError(
            "database statement",
            budget.timeoutMs,
            STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT,
          ),
  );

  try {
    return await query;
  } catch (error) {
    if (
      budget.timeoutReason === STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT &&
      isStatementTimeoutError(error)
    ) {
      throw timeoutError(
        "database statement",
        budget.timeoutMs,
        STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT,
      );
    }
    throw error;
  }
}

function defaultStageLogger(event) {
  console.log(JSON.stringify(event));
}

function emitStage(stageLogger, stage, phase, verificationStartedAt) {
  try {
    const result = stageLogger({
      event: "tenant_safeguard_stage",
      phase,
      stage,
      elapsedMs: Math.max(0, Date.now() - verificationStartedAt),
    });
    result?.catch?.(() => {});
  } catch {
    // Diagnostics must never change the trust decision or extend the
    // verification deadline.
  }
}

async function runStage(
  stage,
  operation,
  stageLogger,
  verificationStartedAt,
) {
  emitStage(stageLogger, stage, "begin", verificationStartedAt);
  try {
    return await operation();
  } finally {
    emitStage(stageLogger, stage, "end", verificationStartedAt);
  }
}

async function endPoolWithDeadline(pool, deadlineAt, cleanupTimeoutMs) {
  if (typeof pool?.end !== "function") return;
  const timeoutMs = Math.min(
    remainingBudget(deadlineAt),
    cleanupTimeoutMs,
  );
  if (timeoutMs <= 0) return;
  await runWithTimeout(
    () => pool.end(),
    timeoutMs,
    () => verificationTimeoutError(timeoutMs),
  ).catch(() => {
    // Cleanup is best effort and cannot replace the verification decision.
  });
}

function sameColumns(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((column, index) => column === expected[index])
  );
}

function foreignKeyLabel(foreignKey) {
  return (
    `${foreignKey.table}(${foreignKey.columns.join(", ")}) -> ` +
    `${foreignKey.referencedTable}(${foreignKey.referencedColumns.join(", ")})`
  );
}

export function findTenantMetadataFailures({
  tables,
  columns,
  foreignKeys,
}) {
  const failures = [];
  const columnsByTable = new Map(
    (Array.isArray(columns) ? columns : []).map((row) => [
      row.table_name,
      row,
    ]),
  );
  // The optional tables argument preserves the old pure-snapshot API while
  // allowing the database verifier to distinguish an absent table from an
  // existing table with a missing organization_id column.
  const knownTables =
    tables === undefined
      ? null
      : new Set(
          (Array.isArray(tables) ? tables : []).map((row) =>
            typeof row === "string" ? row : row.table_name,
          ),
        );

  for (const table of tenantTables) {
    if (knownTables && !knownTables.has(table)) {
      failures.push(`tenant table missing: ${table}`);
      continue;
    }
    const column = columnsByTable.get(table);
    if (!column) {
      failures.push(`tenant column missing: ${table}.organization_id`);
    } else if (
      column.column_default !== null &&
      column.column_default !== undefined
    ) {
      failures.push(
        `tenant default present: ${table}.organization_id has default ${column.column_default}`,
      );
    }
  }

  for (const expected of expectedForeignKeys) {
    const found = (Array.isArray(foreignKeys) ? foreignKeys : []).some(
      (actual) =>
        actual.table_name === expected.table &&
        sameColumns(actual.column_names, expected.columns) &&
        actual.referenced_table_name === expected.referencedTable &&
        sameColumns(actual.referenced_column_names, expected.referencedColumns),
    );
    if (!found) {
      failures.push(`foreign key missing: ${foreignKeyLabel(expected)}`);
    }
  }

  return failures;
}

export function findTenantSafeguardFailures({
  tables,
  columns,
  foreignKeys,
  demoOrganizationCount,
  organizationOrphanCount,
  watchCaseOrphanCount,
  watchCheckOrphanCount,
}) {
  const failures = findTenantMetadataFailures({ tables, columns, foreignKeys });
  if (demoOrganizationCount !== 1) {
    failures.push(
      `demo organization missing: expected 1 organizations row with id demo, found ${demoOrganizationCount}`,
    );
  }
  if (organizationOrphanCount !== 0) {
    failures.push(
      `organization orphans found: expected 0, found ${organizationOrphanCount}`,
    );
  }
  if (watchCaseOrphanCount !== 0) {
    failures.push(
      `watch-case orphans found: expected 0, found ${watchCaseOrphanCount}`,
    );
  }
  if (watchCheckOrphanCount !== 0) {
    failures.push(
      `watch-check orphans found: expected 0, found ${watchCheckOrphanCount}`,
    );
  }

  return failures;
}

export const organizationOrphanQuery = `
  SELECT count(*)::integer AS orphan_count
  FROM (
    ${organizationParentValidatedTenantTables
      .map(
        (table) => `
          SELECT child.organization_id
          FROM "${table}" child
          LEFT JOIN organizations parent ON parent.id = child.organization_id
          WHERE parent.id IS NULL
        `,
      )
      .join(" UNION ALL ")}
  ) organization_orphans
`;

export async function verifyTenantSafeguards(options = {}) {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  const connectionTimeoutMs = positiveTimeout(
    options.connectionTimeoutMs,
    DEFAULT_CONNECTION_TIMEOUT_MS,
    "connectionTimeoutMs",
  );
  const statementTimeoutMs = positiveTimeout(
    options.statementTimeoutMs,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    "statementTimeoutMs",
  );
  const verificationDeadlineMs = positiveTimeout(
    options.verificationDeadlineMs,
    DEFAULT_VERIFICATION_DEADLINE_MS,
    "verificationDeadlineMs",
  );
  const cleanupTimeoutMs = positiveTimeout(
    options.cleanupTimeoutMs,
    DEFAULT_CLEANUP_TIMEOUT_MS,
    "cleanupTimeoutMs",
  );
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required to verify tenant safeguards against the target database",
    );
  }

  const verificationStartedAt = Date.now();
  const deadlineAt = verificationStartedAt + verificationDeadlineMs;
  const stageLogger =
    options.stageLogger ?? options.onStage ?? defaultStageLogger;
  const pool =
    options.pool ??
    new Pool({
      connectionString,
      // Keep pg's timer so stalled handshakes destroy their socket. Both its
      // timeout and the wrapper deadline normalize to the same public reason.
      connectionTimeoutMillis: Math.min(
        connectionTimeoutMs,
        verificationDeadlineMs,
      ),
      statement_timeout: Math.min(
        statementTimeoutMs,
        verificationDeadlineMs,
      ),
    });
  const ownsPool = !options.pool;
  let client;
  let transactionOpen = false;
  let discardClient = false;

  try {
    client = await runStage(
      "connection",
      () => connectWithTimeout(pool, connectionTimeoutMs, deadlineAt),
      stageLogger,
      verificationStartedAt,
    );
  } catch (error) {
    if (ownsPool) {
      await endPoolWithDeadline(pool, deadlineAt, cleanupTimeoutMs);
    }
    throw error;
  }

  try {
    await runStage(
      "transaction",
      async () => {
        await queryWithTimeout(
          client,
          "BEGIN TRANSACTION READ ONLY",
          undefined,
          statementTimeoutMs,
          deadlineAt,
        );
        transactionOpen = true;
        await queryWithTimeout(
          client,
          "SELECT set_config('statement_timeout', $1, true)",
          [`${Math.min(statementTimeoutMs, verificationDeadlineMs)}ms`],
          statementTimeoutMs,
          deadlineAt,
        );
      },
      stageLogger,
      verificationStartedAt,
    );

    const schemaResult = await runStage(
      "schema",
      () =>
        queryWithTimeout(
          client,
          "SELECT current_schema() AS schema_name",
          undefined,
          statementTimeoutMs,
          deadlineAt,
        ),
      stageLogger,
      verificationStartedAt,
    );
    const schema = schemaResult.rows[0]?.schema_name;
    if (!schema) {
      throw new Error("cannot determine the target database schema");
    }

    const tables = await runStage(
      "tenant-tables",
      () =>
        queryWithTimeout(
          client,
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = $1
              AND table_name = ANY($2::text[])
              AND table_type = 'BASE TABLE'
          `,
          [schema, tenantTables],
          statementTimeoutMs,
          deadlineAt,
        ),
      stageLogger,
      verificationStartedAt,
    );

    const columns = await runStage(
      "tenant-columns",
      () =>
        queryWithTimeout(
          client,
          `
            SELECT table_name, column_default
            FROM information_schema.columns
            WHERE table_schema = $1
              AND column_name = 'organization_id'
              AND table_name = ANY($2::text[])
          `,
          [schema, tenantTables],
          statementTimeoutMs,
          deadlineAt,
        ),
      stageLogger,
      verificationStartedAt,
    );

    const foreignKeys = await runStage(
      "tenant-foreign-keys",
      () =>
        queryWithTimeout(
          client,
          `
            SELECT
              relation.relname AS table_name,
              referenced_relation.relname AS referenced_table_name,
              ARRAY(
                SELECT attribute.attname
                FROM unnest(constraint_record.conkey) WITH ORDINALITY key(attnum, position)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = constraint_record.conrelid
                 AND attribute.attnum = key.attnum
                ORDER BY key.position
              )::text[] AS column_names,
              ARRAY(
                SELECT attribute.attname
                FROM unnest(constraint_record.confkey) WITH ORDINALITY key(attnum, position)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = constraint_record.confrelid
                 AND attribute.attnum = key.attnum
                ORDER BY key.position
              )::text[] AS referenced_column_names
            FROM pg_constraint constraint_record
            JOIN pg_class relation ON relation.oid = constraint_record.conrelid
            JOIN pg_namespace namespace_record
              ON namespace_record.oid = relation.relnamespace
            JOIN pg_class referenced_relation
              ON referenced_relation.oid = constraint_record.confrelid
            WHERE namespace_record.nspname = $1
              AND constraint_record.contype = 'f'
          `,
          [schema],
          statementTimeoutMs,
          deadlineAt,
        ),
      stageLogger,
      verificationStartedAt,
    );

    const metadataFailures = findTenantMetadataFailures({
      tables: tables.rows,
      columns: columns.rows,
      foreignKeys: foreignKeys.rows,
    });
    if (metadataFailures.length > 0) {
      await runStage(
        "commit",
        () =>
          queryWithTimeout(
            client,
            "COMMIT",
            undefined,
            statementTimeoutMs,
            deadlineAt,
          ),
        stageLogger,
        verificationStartedAt,
      );
      transactionOpen = false;
      return { schema, failures: metadataFailures };
    }

    const demoOrganization = await runStage(
      "demo-organization",
      () =>
        queryWithTimeout(
          client,
          "SELECT count(*)::integer AS row_count FROM organizations WHERE id = 'demo'",
          undefined,
          statementTimeoutMs,
          deadlineAt,
        ),
      stageLogger,
      verificationStartedAt,
    );

    const organizationOrphans = await runStage(
      "organization-orphans",
      () =>
        queryWithTimeout(
          client,
          organizationOrphanQuery,
          undefined,
          statementTimeoutMs,
          deadlineAt,
        ),
      stageLogger,
      verificationStartedAt,
    );

    const watchOrphans = await runStage(
      "watch-orphans",
      () =>
        queryWithTimeout(
          client,
          `
          SELECT
            count(*) FILTER (
              WHERE watch.case_id IS NOT NULL AND parent_case.id IS NULL
            )::integer AS case_orphan_count,
            count(*) FILTER (
              WHERE watch.check_id IS NOT NULL AND parent_check.id IS NULL
            )::integer AS check_orphan_count
          FROM onb_watch_emails watch
          LEFT JOIN onb_cases parent_case
            ON parent_case.organization_id = watch.organization_id
           AND parent_case.id = watch.case_id
          LEFT JOIN onb_system_checks parent_check
            ON parent_check.organization_id = watch.organization_id
           AND parent_check.id = watch.check_id
        `,
          undefined,
          statementTimeoutMs,
          deadlineAt,
        ),
      stageLogger,
      verificationStartedAt,
    );

    const failures = findTenantSafeguardFailures({
      tables: tables.rows,
      columns: columns.rows,
      foreignKeys: foreignKeys.rows,
      demoOrganizationCount: demoOrganization.rows[0].row_count,
      organizationOrphanCount: organizationOrphans.rows[0].orphan_count,
      watchCaseOrphanCount: watchOrphans.rows[0].case_orphan_count,
      watchCheckOrphanCount: watchOrphans.rows[0].check_orphan_count,
    });
    await runStage(
      "commit",
      () =>
        queryWithTimeout(
          client,
          "COMMIT",
          undefined,
          statementTimeoutMs,
          deadlineAt,
        ),
      stageLogger,
      verificationStartedAt,
    );
    transactionOpen = false;
    return { schema, failures };
  } catch (error) {
    discardClient =
      error?.reasonCategory === STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT ||
      error?.reasonCategory === STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT ||
      error?.reasonCategory === STARTUP_FAILURE_REASONS.VERIFICATION_TIMEOUT ||
      remainingBudget(deadlineAt) <= 0;
    if (transactionOpen) {
      try {
        await runStage(
          "rollback",
          () =>
            queryWithTimeout(
              client,
              "ROLLBACK",
              undefined,
              Math.min(statementTimeoutMs, cleanupTimeoutMs),
              deadlineAt,
            ),
          stageLogger,
          verificationStartedAt,
        );
      } catch {
        // Preserve the verification failure; releasing the client discards
        // unusable transaction state from this one-shot production gate.
      }
    }
    throw error;
  } finally {
    try {
      client.release(discardClient);
    } catch {
      // A one-shot startup client is not reusable after a failed verification.
    }
    if (ownsPool) {
      await runStage(
        "pool-cleanup",
        () => endPoolWithDeadline(pool, deadlineAt, cleanupTimeoutMs),
        stageLogger,
        verificationStartedAt,
      );
    }
  }
}

async function main() {
  const result = await verifyTenantSafeguards();
  if (result.failures.length > 0) {
    console.error(
      `Tenant safeguard verification failed for schema ${result.schema}:`,
    );
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Tenant safeguard verification passed for schema ${result.schema}: ` +
      `${tenantTables.length} defaults absent, ` +
      `${expectedForeignKeys.length} foreign keys present, ` +
      "demo organization present, and all orphan counts are zero.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `Tenant safeguard verification could not run: ${error.message}`,
    );
    process.exitCode = 1;
  });
}
