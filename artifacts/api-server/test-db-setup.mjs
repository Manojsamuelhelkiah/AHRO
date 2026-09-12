import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const migrationsUrl = new URL("../../lib/db/drizzle/", import.meta.url);
const journalUrl = new URL("meta/_journal.json", migrationsUrl);
const migrationTable = "__api_test_schema_migrations";
const statementBreakpoint = "--> statement-breakpoint";
const advisoryLockKey = 1_514_151;
const reviewedAutomaticPolicyExceptionHashes = new Set([
  // Historical destructive, procedural, or data migrations that predate the
  // automatic post-merge safety policy. Exact hashes prevent edited files
  // from inheriting an exception.
  "5917622b3e4cf6bf7ee235d22cfd5aeed7efc2d4d078a59f9f284970522f1e21",
  "bd63ae307e2188dd0e70798429b71724ad2f0e2992c77fa39171ad064c56906f",
  "f92be340337e84401b9b5970daffde166d6ee63059edeaafb05c07bbbf5e2ef4",
  "35a6b5024fb088435f6fdec4388a19fbfe57ac839ac4079f8b2fc13a1b125d31",
  "9041c9eb9634af39f9bfc539593c93ee7f60429772690954121ed50aa6c9aa8b",
  "2e21a48e9f8297e25e5a6513697c57258b4b1f00f6c394033c38433ac2504d60",
  // Security-reviewed organization backfill and tenant-constraint replacement.
  // The exact hash pins the approved migration; any edit fails closed.
  "877e19bb3df8758688ab44039bd0196eeaa4e51ff1b1587ac9c19366de1a5adf",
  // Reviewed development-only transition from final 0021 to the temporary,
  // publish-safe Phase A shape. It changes constraints/defaults but no rows.
  "ad9006a05088bdeda2dfc687bad1de46453040064e25a1ce7c0bae4781cb136a",
  // Security-reviewed Phase B removal of temporary tenant defaults and
  // restoration of direct organization and deferred watch-email foreign keys.
  "0937be5afda5af42fd3674d1d3c195fa822d8467709fe7b9b42ea5c41bdbdd9d",
  // Security-reviewed repair for historical private scenarios and file tenancy.
  "7da40b9a9790b096283838b348fdad8ffe41430b88f2814eeed2d9c40c61b9be",
  // Forward correction keeps legacy calculation context and quarantines
  // mismatched attachments without rewriting applied migration history.
  "3116a643308553bac85852539ae2812c07c3f4e3ef42975766a490a40af1ef85",
  // Security-reviewed quarantine for owner-mismatched scenario attachments.
  "478a75e14136fc164ae824e50bce8333dce1712c0362d23665df222a84ea2519",
  // Security-reviewed forward repair for interval-created private scenarios.
  "e15f14fd6cf4721edbd0f4be846a776cc1ef67d639939cefde16328852712656",
  // Reviewed removal of redundant legacy watch-email relationships after the
  // tenant-scoped composite foreign keys are already in place.
  "89e944c53e96b6c118f5976aa711f394bce447d13225b5364898413f6786d484",
  // Candidate portal is conditional so historical recovery databases without
  // tenant tables can safely replay the forward migration.
  "224a8e52a4e3a251ed7d54009c23f378422a179c4382bec4c07e70a8afec0025",
  // Candidate portal birth path now includes the validation queue shape so a
  // recovery that restored it after 0036 no-op still receives every column.
  "6e06caa77964ff1e851f28787a2b03f556ad4042dc1c9813ef4fa697dbca37ab",
  // Candidate cleanup indexes are conditional because the same supported
  // recovery databases intentionally omit the candidate portal tables.
  "35b0d0ef27e915807387cf9613aea529ce8d1996bf6d206e5228f766285cf935",
  // Reviewed tenant-scoped seed and non-overwriting case-logistics backfill.
  // This forward reconciliation preserves both immutable historical 0030s.
  "e91d02fb842cf47f4a9e6c32957d16025b484fa99bb58afc35d008f39c91c411",
  // Document-validation repair is conditional because supported recovery
  // schemas may intentionally omit the candidate portal tables.
  "3f174d90efe5762cfe258e2522ca08c9e7de42410d1dcf12671c61fa0dd8d1e0",
  // Reviewed protected-audit preservation migration: drops only cascading
  // references and installs append-only evidence protections. The exact hash
  // binds automatic reconciliation to the approved bytes.
  "e8bb7eafea75bae8995c5104f174e8a9d58a316d50310d231e128749e094144d",
  // Reviewed authority/governance migration includes an explicit historical
  // checklist backfill and therefore is not eligible for generic automatic
  // DDL classification.
  "714799b0378ef6bf0d8aa071c3524634350871c328c4cb4908c6f5e8ef44106f",
  // Conservative migration-review holds are data migration, not inferred
  // safety verification.
  "af7ca8b29a6e1eaf26045c057ac4b4ca0cc78f575e51719feb6f42fde40683a8",
  // Forward replacement of the legacy governance status constraint.
  "37384fcdd9f7f2d2be2c85cc7119fa524b8cd544b37963b5c471d9fb54db0a25",
  // Reviewed 0049 data correction: separates conservative migration-review
  // holds from explicitly designated occupational-health controls.
  "4472d9010d4389999c7f9a34de13b3078823451ae69c5877e9a781363487e6ec",
  // Reviewed additive anchoring queue/receipt tables and append-only receipt
  // triggers. The exact hash binds the reviewed DDL to automatic reconciliation.
  "5d50fddef1b8b074b6d22ded30477218e77a206aa369ba335bf18666a98ce37c",
  // Reviewed forward correction allowing one immutable receipt per provider
  // for the same operation, so clients can transition from simulation.
  "d4ddb9b88db2b521f4ccf397f925cfdfc44e9f90e6f555fa0c9d34eee7b1a421",
]);
// The authority migration sequence was renumbered after it landed in
// parallel with the workforce sequence. These are ledger identifiers only:
// their SQL bodies remain hash-pinned and byte-identical. Reconcile an
// already-recorded pre-rebase receipt to its canonical tag before checking
// the current journal, rather than treating that reviewed history as unknown.
const renamedMigrationTags = new Map([
  ["0045_verified_decision_authority", "0047_verified_decision_authority"],
  ["0046_authority_case_creator_principal", "0048_authority_case_creator_principal"],
  ["0047_nonwaivable_safety_policy", "0049_nonwaivable_safety_policy"],
  ["0048_authority_governance_withdrawn", "0050_authority_governance_withdrawn"],
  [
    "0049_separate_migration_review_from_medical_safety",
    "0051_separate_migration_review_from_medical_safety",
  ],
]);
const compatibleHistoricalMigrationHashes = new Map([
  [
    "0030_candidate_portal",
    new Set([
      // Exact predecessor before candidate cleanup indexes were added. The
      // forward 0034 migration repairs databases that recorded this version.
      "8f113f159680a086acc79b46cac772f7543f1cd72125f14921cc97ec113dc9af",
      // Exact predecessor before validation queue columns were added to the
      // conditional candidate-portal birth path.
      "224a8e52a4e3a251ed7d54009c23f378422a179c4382bec4c07e70a8afec0025",
    ]),
  ],
  [
    "0036_document_validation_monitoring",
    new Set([
      // Exact additive predecessor applied during development before the
      // conditional recovery guard was added.
      "9101162883625d9693b214299c5b4cf5ae0a0e41936f397c9ae3a7584205e246",
    ]),
  ],
  [
    "0047_verified_decision_authority",
    new Set([
      // Exact additive predecessor recorded by the development database before
      // the reviewed authority migration's conditional DDL was finalized.
      // The schema receipt is still verified before any tests run.
      "56663a758762ff5a4fffbeb13939b4752a87f94c2ec4441c054b12cbf2a82a6d",
    ]),
  ],
]);

// These errors mean an old migration's individual DDL statement is already
// represented in a database that predates the test migration ledger.
const adoptablePostgresErrors = new Set([
  "42P07", // duplicate_table (also duplicate indexes)
  "42701", // duplicate_column
  "42710", // duplicate_object (constraints, types)
]);

function isAdoptablePostgresError(migration, statement, error) {
  if (
    migration.tag === "0031_onboarding_communication_idempotency" &&
    /CREATE\s+UNIQUE\s+INDEX/i.test(statement) &&
    error?.code === "42703"
  ) {
    return true;
  }
  if (adoptablePostgresErrors.has(error?.code)) return true;

  // Migration 0021 deliberately replaced the old global label primary key
  // with (organization_id, label). If an existing database loses only the
  // 0018 ledger receipt, replaying 0018's historical ON CONFLICT target can no
  // longer resolve that superseded constraint. The current schema receipt is
  // verified independently after adoption, so this exact legacy DML conflict
  // is safe to treat as already represented without weakening other errors.
  return (
    migration.tag === "0018_custom_intent_routing_contract" &&
    error?.code === "42P10" &&
    /ON\s+CONFLICT\s*\(\s*"label"\s*\)\s+DO\s+NOTHING\s*;?\s*$/i.test(statement)
  );
}

function shouldSkipSupersededMigrationStatement(migration, statement) {
  return (
    migration.tag === "0026_preserve_scenario_context" &&
    statement.includes("legacy-private-%") &&
    (
      statement.includes('DELETE FROM "organization_memberships"') ||
      statement.includes('DELETE FROM "organizations"')
    )
  );
}

function migrationHash(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function migrationHashMatches(migration, appliedHash) {
  return (
    appliedHash === migration.hash ||
    compatibleHistoricalMigrationHashes
      .get(migration.tag)
      ?.has(appliedHash) === true
  );
}

async function adoptRenamedMigrationTags(client, migrations, appliedRows) {
  const migrationsByTag = new Map(
    migrations.map((migration) => [migration.tag, migration]),
  );
  const rowsByTag = new Map(appliedRows.map((row) => [row.tag, row]));

  for (const [legacyTag, canonicalTag] of renamedMigrationTags) {
    const existing = rowsByTag.get(legacyTag);
    if (!existing) continue;

    const migration = migrationsByTag.get(canonicalTag);
    if (!migration) {
      throw new Error(
        `Database test setup cannot adopt ${legacyTag}: canonical migration ${canonicalTag} is absent`,
      );
    }
    if (!migrationHashMatches(migration, existing.hash)) {
      throw new Error(
        `Database test setup refused to adopt ${legacyTag}: its hash does not match ${canonicalTag}`,
      );
    }
    if (rowsByTag.has(canonicalTag)) {
      throw new Error(
        `Database test setup found both legacy ${legacyTag} and canonical ${canonicalTag} migration receipts`,
      );
    }

    const updated = await client.query(
      `
        UPDATE ${migrationTable}
        SET tag = $1, created_at = $2
        WHERE tag = $3 AND hash = $4 AND created_at = $5
      `,
      [
        canonicalTag,
        migration.createdAt,
        legacyTag,
        existing.hash,
        existing.created_at,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error(
        `Database test setup could not atomically adopt ${legacyTag} as ${canonicalTag}`,
      );
    }

    const canonicalRow = {
      ...existing,
      tag: canonicalTag,
      created_at: migration.createdAt,
    };
    rowsByTag.delete(legacyTag);
    rowsByTag.set(canonicalTag, canonicalRow);
  }

  return [...rowsByTag.values()];
}

function singleQuoteUsesBackslashEscapes(sql, quoteIndex) {
  if (sql[quoteIndex - 1]?.toUpperCase() !== "E") return false;
  const beforePrefix = sql[quoteIndex - 2];
  return beforePrefix == null || !/[A-Za-z0-9_$]/.test(beforePrefix);
}

function isSingleCharacterStringPrefix(sql, prefixIndex) {
  if (!["B", "E", "N", "X"].includes(sql[prefixIndex]?.toUpperCase())) {
    return false;
  }
  if (sql[prefixIndex + 1] !== "'") return false;
  const beforePrefix = sql[prefixIndex - 1];
  return beforePrefix == null || !/[A-Za-z0-9_$]/.test(beforePrefix);
}

function indexAfterBlockComment(sql, commentStart) {
  let depth = 1;
  let index = commentStart + 2;
  while (index < sql.length && depth > 0) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
      depth += 1;
      index += 2;
    } else if (sql[index] === "*" && sql[index + 1] === "/") {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

function indexAfterLineComment(sql, commentStart) {
  const lineEnd = sql.slice(commentStart + 2).search(/[\r\n]/);
  return lineEnd === -1 ? sql.length : commentStart + 2 + lineEnd + 1;
}

export function splitMigration(sql) {
  const statements = [];
  let start = 0;
  let quote = null;
  let backslashEscapes = false;
  let dollarQuote = null;

  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];

    if (quote) {
      if (current === quote) {
        if (next === quote) {
          index += 1;
        } else {
          quote = null;
          backslashEscapes = false;
        }
      } else if (current === "\\" && backslashEscapes) {
        index += 1;
      }
      continue;
    }

    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        index += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }

    if (current === "'" || current === '"') {
      quote = current;
      backslashEscapes =
        current === "'" && singleQuoteUsesBackslashEscapes(sql, index);
      continue;
    }
    if (current === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuote = match[0];
        index += dollarQuote.length - 1;
        continue;
      }
    }
    if (current === "-" && next === "-") {
      index = indexAfterLineComment(sql, index) - 1;
      continue;
    }
    if (current === "/" && next === "*") {
      index = indexAfterBlockComment(sql, index) - 1;
      continue;
    }
    if (current === ";") {
      const statement = sql
        .slice(start, index)
        .replaceAll(statementBreakpoint, "")
        .trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }

  const trailing = sql
    .slice(start)
    .replaceAll(statementBreakpoint, "")
    .trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function sqlTokensForSafetyCheck(statement) {
  const tokens = [];

  for (let index = 0; index < statement.length; ) {
    const current = statement[index];
    const next = statement[index + 1];

    if (current === "-" && next === "-") {
      index = indexAfterLineComment(statement, index);
      continue;
    }
    if (current === "/" && next === "*") {
      index = indexAfterBlockComment(statement, index);
      continue;
    }
    if (current === "'") {
      const backslashEscapes = singleQuoteUsesBackslashEscapes(
        statement,
        index,
      );
      index += 1;
      while (index < statement.length) {
        if (statement[index] === "'" && statement[index + 1] === "'") {
          index += 2;
        } else if (statement[index] === "'") {
          index += 1;
          break;
        } else if (statement[index] === "\\" && backslashEscapes) {
          index += 2;
        } else {
          index += 1;
        }
      }
      tokens.push("<STRING>");
      continue;
    }
    if (current === '"') {
      index += 1;
      while (index < statement.length) {
        if (statement[index] === '"' && statement[index + 1] === '"') {
          index += 2;
        } else if (statement[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      tokens.push("<IDENTIFIER>");
      continue;
    }
    if (current === "$") {
      const match = statement
        .slice(index)
        .match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        const bodyEnd = statement.indexOf(match[0], index + match[0].length);
        index = bodyEnd === -1 ? statement.length : bodyEnd + match[0].length;
        tokens.push("<STRING>");
        continue;
      }
    }
    if (isSingleCharacterStringPrefix(statement, index)) {
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(current)) {
      const match = statement.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
      tokens.push(match[0].toUpperCase());
      index += match[0].length;
      continue;
    }
    if (/[0-9]/.test(current)) {
      const match = statement
        .slice(index)
        .match(/^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/);
      tokens.push("<NUMBER>");
      index += match[0].length;
      continue;
    }
    if (
      current === "(" ||
      current === ")" ||
      current === "," ||
      current === ";"
    ) {
      tokens.push(current);
    }
    index += 1;
  }

  return tokens;
}

function isAdditiveAlter(tokens) {
  const subject = tokens[1];
  if (subject !== "TABLE" && subject !== "TYPE") return false;

  const alterActions = new Set([
    "ADD",
    "ALTER",
    "ATTACH",
    "CLUSTER",
    "DETACH",
    "DISABLE",
    "DROP",
    "ENABLE",
    "FORCE",
    "INHERIT",
    "NO",
    "NOT",
    "OF",
    "OWNER",
    "RENAME",
    "REPLICA",
    "RESET",
    "SET",
    "VALIDATE",
  ]);
  const actionIndex = tokens.findIndex(
    (token, index) => index >= 2 && alterActions.has(token),
  );
  if (actionIndex === -1) return false;

  const subcommands = [];
  let subcommand = [];
  let depth = 0;
  for (const token of tokens.slice(actionIndex)) {
    if (token === "(") {
      depth += 1;
    } else if (token === ")") {
      depth -= 1;
    } else if (token === "," && depth === 0) {
      subcommands.push(subcommand);
      subcommand = [];
      continue;
    }
    subcommand.push(token);
  }
  subcommands.push(subcommand);

  return (
    depth === 0 &&
    subcommands.every((candidate) => isSafeAddSubcommand(candidate))
  );
}

function isSafeAddSubcommand(tokens) {
  if (tokens[0] !== "ADD") return false;
  if (
    tokens.some((token) =>
      ["CHECK", "EXCLUDE", "GENERATED", "IDENTITY"].includes(token),
    )
  ) {
    return false;
  }

  let index = 1;
  if (tokens[index] === "CONSTRAINT") {
    const constraintType = tokens[index + 2];
    return ["FOREIGN", "PRIMARY", "UNIQUE"].includes(constraintType);
  }
  if (["FOREIGN", "PRIMARY", "UNIQUE"].includes(tokens[index])) return true;

  if (tokens[index] === "COLUMN") index += 1;
  if (
    tokens[index] === "IF" &&
    tokens[index + 1] === "NOT" &&
    tokens[index + 2] === "EXISTS"
  ) {
    index += 3;
  }
  index += 1; // Column name.

  const supportedColumnTypes = new Set([
    "BIGINT",
    "BIGSERIAL",
    "BOOL",
    "BOOLEAN",
    "BYTEA",
    "CHAR",
    "CHARACTER",
    "CIDR",
    "DATE",
    "DECIMAL",
    "DOUBLE",
    "INET",
    "INTEGER",
    "INTERVAL",
    "JSON",
    "JSONB",
    "MACADDR",
    "MONEY",
    "NUMERIC",
    "REAL",
    "SERIAL",
    "SMALLINT",
    "SMALLSERIAL",
    "TEXT",
    "TIME",
    "TIMESTAMP",
    "TSQUERY",
    "TSVECTOR",
    "UUID",
    "VARCHAR",
    "XML",
  ]);
  if (!supportedColumnTypes.has(tokens[index])) return false;

  const defaultIndex = tokens.indexOf("DEFAULT", index + 1);
  if (defaultIndex === -1) return true;

  const afterDefault = tokens.slice(defaultIndex + 1);
  const singleTokenDefaults = new Set([
    "<NUMBER>",
    "<STRING>",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_TIMESTAMP",
    "FALSE",
    "LOCALTIME",
    "LOCALTIMESTAMP",
    "NULL",
    "TRUE",
  ]);
  let expressionLength = 0;
  if (singleTokenDefaults.has(afterDefault[0])) {
    expressionLength = 1;
  } else if (
    afterDefault[0] === "NOW" &&
    afterDefault[1] === "(" &&
    afterDefault[2] === ")"
  ) {
    expressionLength = 3;
  } else {
    return false;
  }

  return hasSafeColumnConstraintSuffix(afterDefault.slice(expressionLength));
}

function hasSafeColumnConstraintSuffix(tokens) {
  for (let index = 0; index < tokens.length; ) {
    if (tokens[index] === "NOT" && tokens[index + 1] === "NULL") {
      index += 2;
    } else if (tokens[index] === "NULL" || tokens[index] === "UNIQUE") {
      index += 1;
    } else if (
      tokens[index] === "PRIMARY" &&
      tokens[index + 1] === "KEY"
    ) {
      index += 2;
    } else if (
      (tokens[index] === "COLLATE" || tokens[index] === "CONSTRAINT") &&
      tokens[index + 1] != null
    ) {
      index += 2;
    } else if (tokens[index] === "REFERENCES") {
      return true;
    } else {
      return false;
    }
  }
  return true;
}

function isAllowedAutomaticStatement(tokens) {
  if (tokens.length === 0) return true;
  if (tokens.includes(";")) return false;

  if (tokens[0] === "CREATE") {
    const createsIndex =
      tokens[1] === "INDEX" ||
      (tokens[1] === "UNIQUE" && tokens[2] === "INDEX");
    if (createsIndex) return true;

    const tableIndex =
      tokens[1] === "TABLE"
        ? 1
        : ["TEMP", "TEMPORARY", "UNLOGGED"].includes(tokens[1]) &&
            tokens[2] === "TABLE"
          ? 2
          : -1;
    if (tableIndex === -1) return false;

    const definitionStart = tokens.indexOf("(", tableIndex + 1);
    if (definitionStart === -1) return false;
    const tableHeader = tokens.slice(tableIndex + 1, definitionStart);
    return (
      !tokens.includes("AS") &&
      !tableHeader.some((token) => ["OF", "PARTITION"].includes(token))
    );
  }
  if (tokens[0] === "ALTER") return isAdditiveAlter(tokens);
  return false;
}

export function assertAutomaticMigrationIsSafe(migration) {
  if (reviewedAutomaticPolicyExceptionHashes.has(migration.hash)) return;

  for (const [index, statement] of migration.statements.entries()) {
    const tokens = sqlTokensForSafetyCheck(statement);
    if (!isAllowedAutomaticStatement(tokens)) {
      throw new Error(
        `Database test setup refused destructive or unsupported migration ${migration.tag} ` +
          `(statement ${index + 1}). Automatic reconciliation permits additive ` +
          "CREATE TABLE, CREATE INDEX, and ALTER ... ADD statements. Destructive " +
          "DDL/DML, data migrations, procedural SQL, and other statement classes " +
          "require a separate reviewed migration process.",
      );
    }
  }
}

function isAutomaticMigrationSafe(migration) {
  try {
    assertAutomaticMigrationIsSafe(migration);
    return true;
  } catch {
    return false;
  }
}

function assertNoUnknownAppliedMigrations(migrations, applied) {
  const checkedInTags = new Set(migrations.map(({ tag }) => tag));
  const unknownTags = [...applied.keys()].filter(
    (tag) => !checkedInTags.has(tag),
  );
  if (unknownTags.length > 0) {
    throw new Error(
      `Database test setup found applied migrations absent from the journal: ${unknownTags.sort().join(", ")}`,
    );
  }
}

export function assertReviewedMigrationKeepsTransactionControl(migration) {
  const transactionCommands = new Set([
    "ABORT",
    "BEGIN",
    "COMMIT",
    "END",
    "RELEASE",
    "ROLLBACK",
    "SAVEPOINT",
    "START",
  ]);
  for (const [index, statement] of migration.statements.entries()) {
    const tokens = sqlTokensForSafetyCheck(statement);
    if (
      tokens.includes(";") ||
      transactionCommands.has(tokens[0]) ||
      (tokens[0] === "PREPARE" && tokens[1] === "TRANSACTION")
    ) {
      throw new Error(
        `Reviewed migration runner refused transaction-control SQL in ${migration.tag} ` +
          `(statement ${index + 1}); the runner owns the transaction boundary`,
      );
    }
  }
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function rewritePublicSchema(statement, schema) {
  return statement.replaceAll('"public".', `${quoteIdentifier(schema)}.`);
}

export async function loadCheckedInMigrations(options = {}) {
  const [journalSource, directoryEntries] = await Promise.all([
    readFile(journalUrl, "utf8"),
    readdir(migrationsUrl),
  ]);
  const journal = JSON.parse(journalSource);
  const sqlFiles = new Set(
    directoryEntries.filter((name) => name.endsWith(".sql")),
  );
  const migrations = [];
  const seenTags = new Set();
  const seenIndexes = new Set();

  for (const entry of journal.entries ?? []) {
    if (
      !entry ||
      typeof entry.tag !== "string" ||
      typeof entry.when !== "number" ||
      seenTags.has(entry.tag) ||
      !Number.isInteger(entry.idx) ||
      entry.idx < 0 ||
      seenIndexes.has(entry.idx)
    ) {
      throw new Error(
        "Database test setup found an invalid or duplicate migration journal entry",
      );
    }
    seenTags.add(entry.tag);
    seenIndexes.add(entry.idx);

    const filename = `${entry.tag}.sql`;
    if (!sqlFiles.delete(filename)) {
      throw new Error(
        `Database test setup cannot find journal migration ${filename}`,
      );
    }
    const sql = await readFile(new URL(filename, migrationsUrl), "utf8");
    const migration = {
      tag: entry.tag,
      createdAt: entry.when,
      hash: migrationHash(sql),
      statements: splitMigration(sql),
    };
    if (!options.allowReviewedDestructive) {
      assertAutomaticMigrationIsSafe(migration);
    }
    migrations.push(migration);
  }

  if (sqlFiles.size > 0) {
    throw new Error(
      `Database test setup found migrations missing from the journal: ${[...sqlFiles].sort().join(", ")}`,
    );
  }

  return migrations;
}

export function reviewedMigrationApproval(migration) {
  return `APPLY:${migration.tag}:${migration.hash}`;
}

export function selectReviewedMigration(migrations, tag, approval) {
  const migration = migrations.find((candidate) => candidate.tag === tag);
  if (!migration) {
    throw new Error(`Reviewed migration runner cannot find migration ${tag}`);
  }
  const expectedApproval = reviewedMigrationApproval(migration);
  if (approval !== expectedApproval) {
    throw new Error(
      `Reviewed migration ${migration.tag} requires the exact approval ${expectedApproval}`,
    );
  }
  return migration;
}

async function executeForAdoption(client, migration, statement, index) {
  const savepoint = `api_test_migration_${index}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(statement);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    // Historical recovery fixtures can predate the organizations parent
    // table. Preserve the additive checklist table/columns in those fixtures;
    // current schemas still apply and verify the tenant FK normally.
    if (
      migration.tag === "0030_day1_checklist_gates" &&
      index === 0 &&
      error?.code === "42P01"
    ) {
      const recoveryStatement = statement.replace(
        /,\s*CONSTRAINT\s+"onb_checklist_templates_organization_id_organizations_id_fk"\s+FOREIGN KEY\s*\("organization_id"\)\s+REFERENCES\s+(?:"[^"]+"\.)?"organizations"\s*\("id"\)/i,
        "",
      );
      await client.query(recoveryStatement);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return;
    }
    if (
      migration.tag === "0033_targeted_checklist_profiles" &&
      index === 0 &&
      error?.code === "42P01"
    ) {
      const recoveryStatement = statement.replace(
        /\s+REFERENCES\s+(?:"[^"]+"\.)?"organizations"\s*\("id"\)/i,
        "",
      );
      await client.query(recoveryStatement);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return;
    }
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    if (!isAdoptablePostgresError(migration, statement, error)) {
      throw new Error(
        `Database test setup could not apply ${migration.tag} (statement ${index + 1})`,
        { cause: error },
      );
    }
  }
}

async function applyMigration(client, migration) {
  for (const [index, statement] of migration.statements.entries()) {
    if (shouldSkipSupersededMigrationStatement(migration, statement)) continue;
    await executeForAdoption(client, migration, statement, index);
  }
  await client.query(
    `
      INSERT INTO ${migrationTable} (tag, hash, created_at)
      VALUES ($1, $2, $3)
    `,
    [migration.tag, migration.hash, migration.createdAt],
  );
}

async function applyReviewedMigrationStrictly(client, migration) {
  for (const [index, statement] of migration.statements.entries()) {
    if (shouldSkipSupersededMigrationStatement(migration, statement)) continue;
    try {
      await client.query("SET LOCAL standard_conforming_strings = on");
      await client.query(statement);
    } catch (error) {
      throw new Error(
        `Reviewed migration runner could not apply ${migration.tag} (statement ${index + 1})`,
        { cause: error },
      );
    }
  }
  await client.query(
    `
      INSERT INTO ${migrationTable} (tag, hash, created_at)
      VALUES ($1, $2, $3)
    `,
    [migration.tag, migration.hash, migration.createdAt],
  );
}

function normalizeSchemaReference(value, schema) {
  if (value == null) return value;
  const schemas = Array.isArray(schema) ? schema : [schema];
  return schemas.reduce(
    (normalized, candidate) =>
      normalized
        .replaceAll(`"${candidate}".`, "")
        .replaceAll(`${candidate}.`, ""),
    value,
  );
}

async function describeSchema(client, schema, normalizedSchemas = schema) {
  const tables = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    `,
    [schema],
  );
  const columns = await client.query(
    `
      SELECT table_name, column_name, data_type, udt_name, is_nullable,
             column_default, character_maximum_length, numeric_precision,
             numeric_scale, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = $1
    `,
    [schema],
  );
  const constraints = await client.query(
    `
      SELECT relation.relname AS table_name,
             constraint_record.conname AS constraint_name,
             constraint_record.contype AS constraint_type,
             pg_get_constraintdef(constraint_record.oid, true) AS definition,
             referenced_relation.relname AS referenced_table_name,
             ARRAY(
               SELECT local_attribute.attname
               FROM unnest(constraint_record.conkey) WITH ORDINALITY AS local_key(attnum, position)
               JOIN pg_attribute local_attribute
                 ON local_attribute.attrelid = constraint_record.conrelid
                AND local_attribute.attnum = local_key.attnum
               ORDER BY local_key.position
             )::text[] AS column_names,
             ARRAY(
               SELECT referenced_attribute.attname
               FROM unnest(constraint_record.confkey) WITH ORDINALITY AS referenced_key(attnum, position)
               JOIN pg_attribute referenced_attribute
                 ON referenced_attribute.attrelid = constraint_record.confrelid
                AND referenced_attribute.attnum = referenced_key.attnum
               ORDER BY referenced_key.position
             )::text[] AS referenced_column_names
      FROM pg_constraint constraint_record
      JOIN pg_class relation ON relation.oid = constraint_record.conrelid
      LEFT JOIN pg_class referenced_relation
        ON referenced_relation.oid = constraint_record.confrelid
      JOIN pg_namespace namespace_record
        ON namespace_record.oid = relation.relnamespace
      WHERE namespace_record.nspname = $1
    `,
    [schema],
  );
  const indexes = await client.query(
    `
      SELECT relation.relname AS table_name,
             index_relation.relname AS index_name,
             index_record.indisunique AS is_unique,
             index_record.indisprimary AS is_primary,
             pg_get_indexdef(index_record.indexrelid, 0, true) AS definition,
             pg_get_expr(
               index_record.indpred,
               index_record.indrelid,
               true
             ) AS predicate
      FROM pg_index index_record
      JOIN pg_class relation ON relation.oid = index_record.indrelid
      JOIN pg_class index_relation
        ON index_relation.oid = index_record.indexrelid
      JOIN pg_namespace namespace_record
        ON namespace_record.oid = relation.relnamespace
      WHERE namespace_record.nspname = $1
    `,
    [schema],
  );

  const foreignKeys = new Map();
  for (const row of constraints.rows) {
    if (row.constraint_type !== "f") continue;
    const identity = {
      table: row.table_name,
      columns: row.column_names,
      referencedTable: row.referenced_table_name,
      referencedColumns: row.referenced_column_names,
    };
    const key = canonicalJson(identity);
    const existing = foreignKeys.get(key);
    foreignKeys.set(key, {
      ...identity,
      count: (existing?.count ?? 0) + 1,
    });
  }

  return {
    tables: new Set(tables.rows.map(({ table_name }) => table_name)),
    columns: new Map(
      columns.rows.map((row) => [
        `${row.table_name}.${row.column_name}`,
        {
          dataType: row.data_type,
          udtName: row.udt_name,
          nullable: row.is_nullable,
          default: normalizeSchemaReference(
            row.column_default,
            normalizedSchemas,
          ),
          characterMaximumLength: row.character_maximum_length,
          numericPrecision: row.numeric_precision,
          numericScale: row.numeric_scale,
          datetimePrecision: row.datetime_precision,
        },
      ]),
    ),
    constraints: new Map(
      constraints.rows.map((row) => [
        `${row.table_name}.${row.constraint_name}`,
        {
          type: row.constraint_type,
          definition: normalizeSchemaReference(
            row.definition,
            normalizedSchemas,
          ),
        },
      ]),
    ),
    foreignKeys,
    indexes: new Map(
      indexes.rows.map((row) => [
        `${row.table_name}.${row.index_name}`,
        {
          unique: row.is_unique,
          primary: row.is_primary,
          definition: normalizeSchemaReference(
            row.definition,
            normalizedSchemas,
          ),
          predicate: normalizeSchemaReference(
            row.predicate,
            normalizedSchemas,
          ),
        },
      ]),
    ),
  };
}

function findSchemaDifferences(expected, actual) {
  const differences = [];
  const singularNames = {
    columns: "column",
    constraints: "constraint",
    indexes: "index",
  };

  for (const table of expected.tables) {
    if (!actual.tables.has(table)) differences.push(`missing table ${table}`);
  }
  for (const collection of ["columns", "constraints", "indexes"]) {
    const singularName = singularNames[collection];
    for (const [key, expectedValue] of expected[collection]) {
      const actualValue = actual[collection].get(key);
      if (!actualValue) {
        differences.push(`missing ${singularName} ${key}`);
      } else if (canonicalJson(actualValue) !== canonicalJson(expectedValue)) {
        differences.push(
          `incompatible ${singularName} ${key} ` +
            `(expected ${canonicalJson(expectedValue)}, found ${canonicalJson(actualValue)})`,
        );
      }
    }
  }
  for (const [identity, foreignKey] of expected.foreignKeys) {
    const actualForeignKey = actual.foreignKeys.get(identity);
    if (!actualForeignKey || actualForeignKey.count < foreignKey.count) {
      differences.push(`missing foreign key ${canonicalJson(foreignKey)}`);
    }
  }
  for (const [identity, foreignKey] of actual.foreignKeys) {
    const expectedForeignKey = expected.foreignKeys.get(identity);
    if (!expectedForeignKey || foreignKey.count > expectedForeignKey.count) {
      differences.push(`unexpected foreign key ${canonicalJson(foreignKey)}`);
    }
  }

  return differences;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function serializeSchema(schema) {
  return {
    tables: [...schema.tables],
    columns: [...schema.columns],
    constraints: [...schema.constraints],
    foreignKeys: [...schema.foreignKeys],
    indexes: [...schema.indexes],
  };
}

function foreignKeysFromLegacyConstraints(constraints) {
  const foreignKeys = [];
  for (const [key, constraint] of constraints) {
    if (constraint.type !== "f") continue;
    const [table] = splitSchemaKey(key);
    const match = constraint.definition.match(
      /^FOREIGN KEY \((.+)\) REFERENCES ([^( ]+)\((.+)\)/,
    );
    if (!match) {
      throw new Error(
        `Database test setup cannot recover foreign-key identity from legacy receipt constraint ${key}`,
      );
    }
    const parseColumns = (value) =>
      value.split(",").map((column) => column.trim().replace(/^"(.*)"$/, "$1"));
    const foreignKey = {
      table,
      columns: parseColumns(match[1]),
      referencedTable: match[2].replace(/^"(.*)"$/, "$1"),
      referencedColumns: parseColumns(match[3]),
    };
    const identity = canonicalJson(foreignKey);
    const existing = foreignKeys.find(([key]) => key === identity);
    if (existing) {
      existing[1].count += 1;
    } else {
      foreignKeys.push([identity, { ...foreignKey, count: 1 }]);
    }
  }
  return new Map(foreignKeys);
}

function deserializeSchema(schema) {
  if (
    !schema ||
    !Array.isArray(schema.tables) ||
    !Array.isArray(schema.columns) ||
    !Array.isArray(schema.constraints) ||
    !Array.isArray(schema.indexes)
  ) {
    throw new Error(
      "Database test setup found an invalid reviewed schema receipt",
    );
  }
  const constraints = new Map(schema.constraints);
  return {
    tables: new Set(schema.tables),
    columns: new Map(schema.columns),
    constraints,
    foreignKeys: Array.isArray(schema.foreignKeys)
      ? new Map(schema.foreignKeys)
      : foreignKeysFromLegacyConstraints(constraints),
    indexes: new Map(schema.indexes),
  };
}

async function assertSchemaMatchesReceipt(client, schema, receipt) {
  if (!receipt?.schema_snapshot) {
    throw new Error(
      `Database test setup cannot verify reviewed migration history at ${receipt?.tag ?? "unknown migration"}: schema receipt is missing`,
    );
  }
  const expected = deserializeSchema(receipt.schema_snapshot);
  const actual = await describeSchema(client, schema);
  const differences = findSchemaDifferences(expected, actual);
  if (differences.length > 0) {
    const preview = differences.slice(0, 10).join(", ");
    const remaining =
      differences.length > 10 ? ` (and ${differences.length - 10} more)` : "";
    throw new Error(
      `Database test setup found an incomplete or incompatible schema: ${preview}${remaining}`,
    );
  }
  return expected;
}

async function recordSchemaReceipt(client, migration, expectedSchema) {
  const snapshot = serializeSchema(expectedSchema);
  await client.query(
    `
      UPDATE ${migrationTable}
      SET schema_snapshot = $1::jsonb
      WHERE tag = $2 AND hash = $3
    `,
    [JSON.stringify(snapshot), migration.tag, migration.hash],
  );
}

function deriveReviewedExpectedSchema(baseline, before, after) {
  const tables = new Set(
    [...after.tables].filter(
      (table) => baseline.tables.has(table) || !before.tables.has(table),
    ),
  );
  const deriveCollection = (collection) =>
    new Map(
      [...after[collection]].filter(
        ([key]) =>
          baseline[collection].has(key) || !before[collection].has(key),
      ),
    );
  return {
    tables,
    columns: deriveCollection("columns"),
    constraints: deriveCollection("constraints"),
    foreignKeys: deriveCollection("foreignKeys"),
    indexes: deriveCollection("indexes"),
  };
}

function splitSchemaKey(key) {
  const separator = key.indexOf(".");
  return [key.slice(0, separator), key.slice(separator + 1)];
}

async function buildExpectedSchemaFromReceipt(
  client,
  baseline,
  migrations,
  actualSchema,
) {
  const backendPid = await client.query("SELECT pg_backend_pid() AS pid");
  const expectedSchema = `__api_test_receipt_${backendPid.rows[0].pid}`;
  const quotedExpectedSchema = quoteIdentifier(expectedSchema);
  const originalSearchPath = await client.query(
    "SELECT current_setting('search_path') AS search_path",
  );

  await client.query("SAVEPOINT api_test_receipt_verification");
  try {
    await client.query(`CREATE SCHEMA ${quotedExpectedSchema}`);
    await client.query(
      "SELECT set_config('search_path', quote_ident($1) || ', ' || quote_ident($2), false)",
      [expectedSchema, actualSchema],
    );
    for (const table of [...baseline.tables].sort()) {
      await client.query(
        `CREATE TABLE ${quotedExpectedSchema}.${quoteIdentifier(table)} ` +
          `(LIKE ${quoteIdentifier(actualSchema)}.${quoteIdentifier(table)} ` +
          "INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY INCLUDING STORAGE)",
      );
    }

    const cloned = await describeSchema(client, expectedSchema, [
      expectedSchema,
      actualSchema,
    ]);
    for (const key of cloned.columns.keys()) {
      if (baseline.columns.has(key)) continue;
      const [table, column] = splitSchemaKey(key);
      await client.query(
        `ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)} CASCADE`,
      );
    }
    // Recreate primary/unique/check constraints before indexes and foreign
    // keys.  A current approval FK references (organization_id, id), which
    // is backed by a standalone unique index rather than a unique constraint.
    // PostgreSQL requires that index to exist before the FK is added.
    for (const constraintType of ["p", "u", "c", "x"]) {
      for (const [key, constraint] of baseline.constraints) {
        if (constraint.type !== constraintType) continue;
        const [table, constraintName] = splitSchemaKey(key);
        await client.query(
          `ALTER TABLE ${quoteIdentifier(table)} ` +
            `ADD CONSTRAINT ${quoteIdentifier(constraintName)} ${constraint.definition}`,
        );
      }
    }
    const constraintKeys = new Set(baseline.constraints.keys());
    for (const [key, index] of baseline.indexes) {
      if (index.primary || constraintKeys.has(key)) continue;
      await client.query(index.definition);
    }
    for (const [key, constraint] of baseline.constraints) {
      if (constraint.type !== "f") continue;
      const [table, constraintName] = splitSchemaKey(key);
      await client.query(
        `ALTER TABLE ${quoteIdentifier(table)} ` +
          `ADD CONSTRAINT ${quoteIdentifier(constraintName)} ${constraint.definition}`,
      );
    }
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        await client.query(rewritePublicSchema(statement, expectedSchema));
      }
    }
    return await describeSchema(client, expectedSchema, [
      expectedSchema,
      actualSchema,
    ]);
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT api_test_receipt_verification");
    throw error;
  } finally {
    await client.query("SELECT set_config('search_path', $1, false)", [
      originalSearchPath.rows[0].search_path,
    ]);
    await client.query(`DROP SCHEMA IF EXISTS ${quotedExpectedSchema} CASCADE`);
    await client.query("RELEASE SAVEPOINT api_test_receipt_verification");
  }
}

async function verifyCheckedInSchema(client, migrations, actualSchema) {
  const backendPid = await client.query("SELECT pg_backend_pid() AS pid");
  const expectedSchema = `__api_test_expected_${backendPid.rows[0].pid}`;
  const quotedExpectedSchema = quoteIdentifier(expectedSchema);
  const originalSearchPath = await client.query(
    "SELECT current_setting('search_path') AS search_path",
  );
  let verifiedExpected;
  const actualHasOrganizations = Boolean(
    (await client.query("SELECT to_regclass($1) AS relation", [
      `${actualSchema}.organizations`,
    ])).rows[0]?.relation,
  );
  const actualHasTenantCommunications = Boolean(
    (await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1
        AND table_name = 'onb_communications' AND column_name = 'organization_id'`,
      [actualSchema],
    )).rowCount,
  );
  if (actualHasOrganizations) {
    const checklistTable = await client.query("SELECT to_regclass($1) AS relation", [
      `${actualSchema}.onb_checklist_templates`,
    ]);
    const checklistFk = await client.query(
      `SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1
          AND t.relname = 'onb_checklist_templates'
          AND c.conname = 'onb_checklist_templates_organization_id_organizations_id_fk'`,
      [actualSchema],
    );
    if (checklistTable.rows[0]?.relation && checklistFk.rowCount === 0) {
      await client.query(
        `ALTER TABLE ${quoteIdentifier(actualSchema)}."onb_checklist_templates"
           ADD CONSTRAINT "onb_checklist_templates_organization_id_organizations_id_fk"
           FOREIGN KEY ("organization_id")
           REFERENCES ${quoteIdentifier(actualSchema)}."organizations"("id")`,
      );
    }
    const checklistProfilesTable = await client.query("SELECT to_regclass($1) AS relation", [
      `${actualSchema}.onb_checklist_profiles`,
    ]);
    const checklistProfilesFk = await client.query(
      `SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_class rt ON rt.oid = c.confrelid
        WHERE n.nspname = $1
          AND t.relname = 'onb_checklist_profiles'
          AND c.contype = 'f'
          AND rt.relname = 'organizations'
          AND (
            SELECT array_agg(a.attname ORDER BY key_position)
            FROM unnest(c.conkey) WITH ORDINALITY AS keys(attnum, key_position)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = keys.attnum
          ) = ARRAY['organization_id']::name[]`,
      [actualSchema],
    );
    if (checklistProfilesTable.rows[0]?.relation && checklistProfilesFk.rowCount === 0) {
      await client.query(
        `ALTER TABLE ${quoteIdentifier(actualSchema)}."onb_checklist_profiles"
           ADD CONSTRAINT "onb_checklist_profiles_organization_id_fkey"
           FOREIGN KEY ("organization_id")
           REFERENCES ${quoteIdentifier(actualSchema)}."organizations"("id")`,
      );
    }
  }
  if (actualHasTenantCommunications) {
    const index = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1
        AND indexname = 'onb_communications_organization_idempotency_key_idx'`,
      [actualSchema],
    );
    if (index.rowCount === 0) {
      await client.query(
        `CREATE UNIQUE INDEX "onb_communications_organization_idempotency_key_idx"
           ON ${quoteIdentifier(actualSchema)}."onb_communications"
             ("organization_id", "idempotency_key")`,
      );
    }
  }

  await client.query("SAVEPOINT api_test_schema_verification");
  try {
    await client.query(`CREATE SCHEMA ${quotedExpectedSchema}`);
    await client.query(
      "SELECT set_config('search_path', quote_ident($1), false)",
      [expectedSchema],
    );
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        let expectedStatement = rewritePublicSchema(statement, expectedSchema);
        if (
          !actualHasTenantCommunications &&
          migration.tag === "0031_onboarding_communication_idempotency" &&
          /CREATE\s+UNIQUE\s+INDEX/i.test(statement)
        ) {
          expectedStatement = "SELECT 1";
        }
        // A recovery workspace that predates organizations uses the same
        // compatibility form as executeForAdoption above.
        if (
          !actualHasOrganizations &&
          migration.tag === "0030_day1_checklist_gates" &&
          /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"onb_checklist_templates"/i.test(statement)
        ) {
          expectedStatement = expectedStatement.replace(
            /,\s*CONSTRAINT\s+"onb_checklist_templates_organization_id_organizations_id_fk"\s+FOREIGN KEY\s*\("organization_id"\)\s+REFERENCES\s+(?:"[^"]+"\.)?"organizations"\s*\("id"\)/i,
            "",
          );
        }
        if (
          !actualHasOrganizations &&
          migration.tag === "0033_targeted_checklist_profiles" &&
          /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"onb_checklist_profiles"/i.test(statement)
        ) {
          expectedStatement = expectedStatement.replace(
            /\s+REFERENCES\s+(?:"[^"]+"\.)?"organizations"\s*\("id"\)/i,
            "",
          );
        }
        await client.query(expectedStatement);
      }
    }

    const [expected, actual] = await Promise.all([
      describeSchema(client, expectedSchema),
      describeSchema(client, actualSchema),
    ]);
    verifiedExpected = expected;
    const differences = findSchemaDifferences(expected, actual);
    if (differences.length > 0) {
      const preview = differences.slice(0, 10).join(", ");
      const remaining =
        differences.length > 10
          ? ` (and ${differences.length - 10} more)`
          : "";
      throw new Error(
        `Database test setup found an incomplete or incompatible schema: ${preview}${remaining}`,
      );
    }
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT api_test_schema_verification");
    throw error;
  } finally {
    await client.query("SELECT set_config('search_path', $1, false)", [
      originalSearchPath.rows[0].search_path,
    ]);
    await client.query(`DROP SCHEMA IF EXISTS ${quotedExpectedSchema} CASCADE`);
    await client.query("RELEASE SAVEPOINT api_test_schema_verification");
  }
  return verifiedExpected;
}

export async function reconcileDevelopmentDatabase(options = {}) {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required to reconcile the development database",
    );
  }

  const migrations =
    options.migrations ??
    (await loadCheckedInMigrations({ allowReviewedDestructive: true }));
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("SET standard_conforming_strings = on");
    await client.query("SELECT pg_advisory_lock($1)", [advisoryLockKey]);
    const schemaResult = await client.query(
      "SELECT current_schema() AS schema_name",
    );
    const actualSchema = schemaResult.rows[0]?.schema_name;
    if (!actualSchema) {
      throw new Error(
        "Database test setup cannot determine the target database schema",
      );
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${migrationTable} (
        tag text PRIMARY KEY NOT NULL,
        hash text NOT NULL,
        created_at bigint NOT NULL,
        applied_at timestamp with time zone DEFAULT now() NOT NULL,
        schema_snapshot jsonb
      )
    `);
    await client.query(
      `ALTER TABLE ${migrationTable} ADD COLUMN IF NOT EXISTS schema_snapshot jsonb`,
    );
    await client.query("BEGIN");
    transactionOpen = true;

    const appliedResult = await client.query(
      `SELECT tag, hash, created_at, schema_snapshot FROM ${migrationTable}`,
    );
    const appliedRows = await adoptRenamedMigrationTags(
      client,
      migrations,
      appliedResult.rows,
    );
    const applied = new Map(appliedRows.map((row) => [row.tag, row]));
    assertNoUnknownAppliedMigrations(migrations, applied);
    for (const migration of migrations) {
      const existing = applied.get(migration.tag);
      if (
        existing &&
        (!migrationHashMatches(migration, existing.hash) ||
          Number(existing.created_at) !== migration.createdAt)
      ) {
        throw new Error(
          `Database test setup found a changed or partially recorded migration: ${migration.tag}`,
        );
      }
    }
    const pendingMigrations = migrations.filter(({ tag }) => !applied.has(tag));
    const hasReviewedHistory = migrations.some(
      (migration) =>
        applied.has(migration.tag) && !isAutomaticMigrationSafe(migration),
    );
    let expectedSchema;
    if (hasReviewedHistory) {
      const latestAppliedMigration = migrations.findLast(({ tag }) =>
        applied.has(tag),
      );
      expectedSchema = await assertSchemaMatchesReceipt(
        client,
        actualSchema,
        applied.get(latestAppliedMigration.tag),
      );
    }
    for (const migration of pendingMigrations) {
      assertAutomaticMigrationIsSafe(migration);
    }
    if (hasReviewedHistory && pendingMigrations.length > 0) {
      expectedSchema = await buildExpectedSchemaFromReceipt(
        client,
        expectedSchema,
        pendingMigrations,
        actualSchema,
      );
    }

    for (const migration of pendingMigrations) {
      const rewrittenMigration = {
        ...migration,
        statements: migration.statements.map((statement) =>
          rewritePublicSchema(statement, actualSchema),
        ),
      };
      if (hasReviewedHistory) {
        await applyReviewedMigrationStrictly(client, rewrittenMigration);
      } else {
        await applyMigration(client, rewrittenMigration);
      }
    }
    if (!hasReviewedHistory) {
      expectedSchema = await verifyCheckedInSchema(
        client,
        migrations,
        actualSchema,
      );
    } else if (pendingMigrations.length > 0) {
      const actual = await describeSchema(client, actualSchema);
      const differences = findSchemaDifferences(expectedSchema, actual);
      if (differences.length > 0) {
        const preview = differences.slice(0, 10).join(", ");
        const remaining =
          differences.length > 10
            ? ` (and ${differences.length - 10} more)`
            : "";
        throw new Error(
          `Database test setup found an incomplete or incompatible schema: ${preview}${remaining}`,
        );
      }
    }
    const latestMigration = migrations.at(-1);
    if (latestMigration) {
      await recordSchemaReceipt(client, latestMigration, expectedSchema);
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

export async function applyReviewedMigration(options = {}) {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to apply a reviewed migration");
  }

  const migrations =
    options.migrations ??
    (await loadCheckedInMigrations({
      allowReviewedDestructive: true,
    }));
  const migration = selectReviewedMigration(
    migrations,
    options.tag,
    options.approval,
  );
  assertReviewedMigrationKeepsTransactionControl(migration);
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("SET standard_conforming_strings = on");
    await client.query("SELECT pg_advisory_lock($1)", [advisoryLockKey]);
    const schemaResult = await client.query(
      "SELECT current_schema() AS schema_name",
    );
    const actualSchema = schemaResult.rows[0]?.schema_name;
    if (!actualSchema) {
      throw new Error(
        "Reviewed migration runner cannot determine the target database schema",
      );
    }
    await client.query("BEGIN");
    transactionOpen = true;
    const ledgerExists = await client.query(
      "SELECT to_regclass($1) AS ledger",
      [migrationTable],
    );
    if (!ledgerExists.rows[0]?.ledger) {
      throw new Error(
        "Reviewed migration runner requires automatic reconciliation to initialize the migration ledger first",
      );
    }
    await client.query(
      `ALTER TABLE ${migrationTable} ADD COLUMN IF NOT EXISTS schema_snapshot jsonb`,
    );
    const appliedResult = await client.query(
      `SELECT tag, hash, created_at, schema_snapshot FROM ${migrationTable}`,
    );
    const appliedRows = await adoptRenamedMigrationTags(
      client,
      migrations,
      appliedResult.rows,
    );
    const applied = new Map(appliedRows.map((row) => [row.tag, row]));
    assertNoUnknownAppliedMigrations(migrations, applied);
    const targetIndex = migrations.findIndex(
      (candidate) => candidate.tag === migration.tag,
    );
    const predecessors = migrations.slice(0, targetIndex);
    for (const predecessor of predecessors) {
      const existing = applied.get(predecessor.tag);
      if (
        !existing ||
        !migrationHashMatches(predecessor, existing.hash) ||
        Number(existing.created_at) !== predecessor.createdAt
      ) {
        throw new Error(
          `Reviewed migration ${migration.tag} cannot run before its predecessor ${predecessor.tag} is applied exactly`,
        );
      }
    }
    if (applied.has(migration.tag)) {
      throw new Error(`Reviewed migration ${migration.tag} is already applied`);
    }
    const laterApplied = migrations
      .slice(targetIndex + 1)
      .find((candidate) => applied.has(candidate.tag));
    if (laterApplied) {
      throw new Error(
        `Reviewed migration ${migration.tag} cannot run after later migration ${laterApplied.tag}`,
      );
    }

    const reviewedPredecessor = predecessors.findLast(
      (candidate) => !isAutomaticMigrationSafe(candidate),
    );
    const baselineExpected = reviewedPredecessor
      ? await assertSchemaMatchesReceipt(
          client,
          actualSchema,
          applied.get(predecessors.at(-1).tag),
        )
      : await verifyCheckedInSchema(client, predecessors, actualSchema);
    const before = await describeSchema(client, actualSchema);
    await applyReviewedMigrationStrictly(client, {
      ...migration,
      statements: migration.statements.map((statement) =>
        rewritePublicSchema(statement, actualSchema),
      ),
    });
    const after = await describeSchema(client, actualSchema);
    const reviewedExpected = deriveReviewedExpectedSchema(
      baselineExpected,
      before,
      after,
    );
    await recordSchemaReceipt(client, migration, reviewedExpected);
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

/**
 * Adds only the fixed identity used by authenticated development smoke tests.
 * The normal tenant middleware still has to resolve this persisted membership.
 */
export async function ensureDevelopmentSmokeMembership(options = {}) {
  if (process.env.NODE_ENV !== "development") {
    throw new Error(
      "Development smoke membership can only be created when NODE_ENV is exactly development",
    );
  }
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required to create the development smoke membership",
    );
  }

  const userId = "internal_intent_routing_smoke";
  const organizationId = "demo";
  const pool = new Pool({ connectionString });
  try {
    const organization = await pool.query(
      `SELECT 1 FROM organizations WHERE id = $1`,
      [organizationId],
    );
    if (organization.rowCount !== 1) {
      throw new Error(
        "The explicit demo organization is missing after database reconciliation",
      );
    }
    await pool.query(
      `
        INSERT INTO organization_memberships
          (organization_id, clerk_user_id, role)
        VALUES ($1, $2, 'member')
        ON CONFLICT (organization_id, clerk_user_id)
        DO UPDATE SET role = EXCLUDED.role
      `,
      [organizationId, userId],
    );
    return { userId, organizationId };
  } finally {
    await pool.end();
  }
}

export async function prepareDatabaseBackedTests(options = {}) {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) return;
  await reconcileDevelopmentDatabase({ ...options, connectionString });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await reconcileDevelopmentDatabase();
    console.log(
      "Development database reconciliation passed: checked-in migrations are applied and the live schema is compatible.",
    );
  } catch (error) {
    console.error(
      "DEVELOPMENT DATABASE RECONCILIATION FAILED. Workflows were not restarted because the live schema is stale or incompatible.",
    );
    throw error;
  }
}