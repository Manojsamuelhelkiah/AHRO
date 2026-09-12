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
export const STARTUP_FAILURE_REASONS = Object.freeze({
  BACKUP_ALERT_CONFIGURATION: "BACKUP_ALERT_CONFIGURATION",
  CONNECTION_TIMEOUT: "CONNECTION_TIMEOUT",
  STATEMENT_TIMEOUT: "STATEMENT_TIMEOUT",
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

async function connectWithTimeout(pool, timeoutMs) {
  let timer;
  const connection = pool.connect();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          timeoutError(
            "database connection",
            timeoutMs,
            STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });

  try {
    return await Promise.race([connection, timeout]);
  } catch (error) {
    connection.then((lateClient) => lateClient.release(), () => {});
    if (isConnectionTimeoutError(error)) {
      throw timeoutError(
        "database connection",
        timeoutMs,
        STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function queryWithTimeout(client, text, values, timeoutMs) {
  let timer;
  const query = client.query({
    text,
    values,
    // This wrapper owns the client deadline so pg cannot reject first with an
    // unclassified "Query read timeout". PostgreSQL's server-side timeout
    // remains enabled separately and is normalized below.
    query_timeout: 0,
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          timeoutError(
            "database statement",
            timeoutMs,
            STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });

  try {
    return await Promise.race([query, timeout]);
  } catch (error) {
    if (isStatementTimeoutError(error)) {
      throw timeoutError(
        "database statement",
        timeoutMs,
        STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

export function findTenantSafeguardFailures({
  columns,
  foreignKeys,
  demoOrganizationCount,
  organizationOrphanCount,
  watchCaseOrphanCount,
  watchCheckOrphanCount,
}) {
  const failures = [];
  const columnsByTable = new Map(columns.map((row) => [row.table_name, row]));

  for (const table of tenantTables) {
    const column = columnsByTable.get(table);
    if (!column) {
      failures.push(`tenant column missing: ${table}.organization_id`);
    } else if (column.column_default !== null) {
      failures.push(
        `tenant default present: ${table}.organization_id has default ${column.column_default}`,
      );
    }
  }

  for (const expected of expectedForeignKeys) {
    const found = foreignKeys.some(
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
  const connectionTimeoutMs =
    options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  const statementTimeoutMs =
    options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required to verify tenant safeguards against the target database",
    );
  }

  const pool =
    options.pool ??
    new Pool({
      connectionString,
      // Keep pg's timer so stalled handshakes destroy their socket. Both its
      // timeout and the wrapper deadline normalize to the same public reason.
      connectionTimeoutMillis: connectionTimeoutMs,
      statement_timeout: statementTimeoutMs,
    });
  const ownsPool = !options.pool;
  let client;
  try {
    client = await connectWithTimeout(pool, connectionTimeoutMs);
  } catch (error) {
    if (ownsPool) await pool.end();
    throw error;
  }
  let transactionOpen = false;
  let discardClient = false;
  try {
    await queryWithTimeout(
      client,
      "BEGIN TRANSACTION READ ONLY",
      undefined,
      statementTimeoutMs,
    );
    transactionOpen = true;
    await queryWithTimeout(
      client,
      "SELECT set_config('statement_timeout', $1, true)",
      [`${statementTimeoutMs}ms`],
      statementTimeoutMs,
    );
    const schemaResult = await queryWithTimeout(
      client,
      "SELECT current_schema() AS schema_name",
      undefined,
      statementTimeoutMs,
    );
    const schema = schemaResult.rows[0]?.schema_name;
    if (!schema) {
      throw new Error("cannot determine the target database schema");
    }

    const columns = await queryWithTimeout(
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
    );
    const foreignKeys = await queryWithTimeout(
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
    );
    const demoOrganization = await queryWithTimeout(
      client,
      "SELECT count(*)::integer AS row_count FROM organizations WHERE id = 'demo'",
      undefined,
      statementTimeoutMs,
    );
    const organizationOrphans = await queryWithTimeout(
      client,
      organizationOrphanQuery,
      undefined,
      statementTimeoutMs,
    );
    const watchOrphans = await queryWithTimeout(
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
    );

    const failures = findTenantSafeguardFailures({
      columns: columns.rows,
      foreignKeys: foreignKeys.rows,
      demoOrganizationCount: demoOrganization.rows[0].row_count,
      organizationOrphanCount: organizationOrphans.rows[0].orphan_count,
      watchCaseOrphanCount: watchOrphans.rows[0].case_orphan_count,
      watchCheckOrphanCount: watchOrphans.rows[0].check_orphan_count,
    });
    await queryWithTimeout(
      client,
      "COMMIT",
      undefined,
      statementTimeoutMs,
    );
    transactionOpen = false;
    return { schema, failures };
  } catch (error) {
    discardClient = error?.code === "TENANT_SAFEGUARD_TIMEOUT";
    if (transactionOpen) {
      try {
        await queryWithTimeout(
          client,
          "ROLLBACK",
          undefined,
          statementTimeoutMs,
        );
      } catch {
        // Preserve the verification failure; releasing the client discards
        // unusable transaction state from this one-shot production gate.
      }
    }
    throw error;
  } finally {
    client.release(discardClient);
    if (ownsPool) await pool.end();
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
