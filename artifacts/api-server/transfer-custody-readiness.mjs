/*
 * Read-only catalog checks for migration 0084.
 *
 * This module intentionally contains no migration or repair SQL.  The
 * production verifier uses these queries inside its already-open
 * BEGIN TRANSACTION READ ONLY transaction and turns every catalog mismatch
 * into a failed startup safeguard.
 */

export const TRANSFER_CUSTODY_MIGRATION_TAG =
  "0084_workforce_transfer_lifecycle_custody";

export const TRANSFER_CUSTODY_FUNCTION_NAMES = Object.freeze([
  "onb_transfer_worker_source_custody",
  "onb_transfer_reconciliation_source_custody",
  "onb_transfer_data_governance_revision",
]);

export const TRANSFER_CUSTODY_TRIGGER_NAMES = Object.freeze([
  "onb_transfer_workers_source_custody",
  "onb_transfer_reconciliations_source_custody",
  "onb_transfer_data_governance_revision",
]);

// pg_trigger.tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8,
// UPDATE=16, TRUNCATE=32, INSTEAD=64.
export const TRANSFER_CUSTODY_TRIGGER_DEFINITIONS = Object.freeze([
  {
    name: "onb_transfer_workers_source_custody",
    relation: "onb_transfer_workers",
    functionName: "onb_transfer_worker_source_custody",
    type: 23, // BEFORE INSERT OR UPDATE FOR EACH ROW
  },
  {
    name: "onb_transfer_reconciliations_source_custody",
    relation: "onb_transfer_cutover_reconciliations",
    functionName: "onb_transfer_reconciliation_source_custody",
    type: 23, // BEFORE INSERT OR UPDATE FOR EACH ROW
  },
  {
    name: "onb_transfer_data_governance_revision",
    relation: "onb_transfer_data_governance",
    functionName: "onb_transfer_data_governance_revision",
    type: 19, // BEFORE UPDATE FOR EACH ROW
  },
]);

const FUNCTION_BODIES = Object.freeze({
  onb_transfer_worker_source_custody:
    "\n" +
    "BEGIN\n" +
    "  IF TG_OP = 'INSERT' THEN\n" +
    '    NEW."source_fingerprint" := encode(digest(NEW."source_payload"::text, \'sha256\'), \'hex\');\n' +
    "    RETURN NEW;\n" +
    "  END IF;\n" +
    "\n" +
    '  IF NEW."source_payload" IS DISTINCT FROM OLD."source_payload"\n' +
    '    OR NEW."original_hire_date" IS DISTINCT FROM OLD."original_hire_date"\n' +
    '    OR NEW."continuous_service_date" IS DISTINCT FROM OLD."continuous_service_date"\n' +
    '    OR NEW."source_fingerprint" IS DISTINCT FROM OLD."source_fingerprint" THEN\n' +
    "    RAISE EXCEPTION 'transfer worker source payload and preserved service dates are immutable custody evidence';\n" +
    "  END IF;\n" +
    "  RETURN NEW;\n" +
    "END;\n",
  onb_transfer_reconciliation_source_custody:
    "\n" +
    "DECLARE\n" +
    "  worker_fingerprint text;\n" +
    "BEGIN\n" +
    '  SELECT "source_fingerprint" INTO worker_fingerprint\n' +
    '  FROM "onb_transfer_workers"\n' +
    '  WHERE "organization_id" = NEW."organization_id"\n' +
    '    AND "id" = NEW."worker_id"\n' +
    "  FOR KEY SHARE;\n" +
    "\n" +
    "  IF worker_fingerprint IS NULL THEN\n" +
    "    RAISE EXCEPTION 'transfer reconciliation requires immutable source worker custody';\n" +
    "  END IF;\n" +
    '  NEW."source_fingerprint" := worker_fingerprint;\n' +
    "  RETURN NEW;\n" +
    "END;\n",
  onb_transfer_data_governance_revision:
    "\n" +
    "BEGIN\n" +
    '  IF NEW."lawful_basis_reference" IS DISTINCT FROM OLD."lawful_basis_reference"\n' +
    '    OR NEW."retention_reference" IS DISTINCT FROM OLD."retention_reference"\n' +
    '    OR NEW."retention_until" IS DISTINCT FROM OLD."retention_until"\n' +
    '    OR NEW."authority_assignment_id" IS DISTINCT FROM OLD."authority_assignment_id"\n' +
    '    OR NEW."authority_assignment_revision" IS DISTINCT FROM OLD."authority_assignment_revision" THEN\n' +
    "    NEW.\"revision\" := OLD.\"revision\" + 1;\n" +
    "  END IF;\n" +
    "  RETURN NEW;\n" +
    "END;\n",
});

export const TRANSFER_CUSTODY_FUNCTION_DEFINITIONS = Object.freeze([
  {
    name: "onb_transfer_worker_source_custody",
    body: FUNCTION_BODIES.onb_transfer_worker_source_custody,
  },
  {
    name: "onb_transfer_reconciliation_source_custody",
    body: FUNCTION_BODIES.onb_transfer_reconciliation_source_custody,
  },
  {
    name: "onb_transfer_data_governance_revision",
    body: FUNCTION_BODIES.onb_transfer_data_governance_revision,
  },
]);

export const TRANSFER_CUSTODY_PGCRYPTO_PROBE_INPUT =
  "transfer-custody-readiness";
export const TRANSFER_CUSTODY_PGCRYPTO_PROBE_SHA256 =
  "b088845e5fc5a34be17d69d084d2b98d0be12fdd99380b2a435d1c3da6bc4aa5";

/*
 * Keep the catalog queries explicit and boring.  In particular, do not use
 * pg_get_triggerdef(): its rendered SQL can change between PostgreSQL
 * versions and does not expose all of the safety-relevant catalog flags.
 */
export const transferCustodyFunctionsQuery = `
  SELECT
    namespace_record.nspname AS function_schema,
    procedure_record.proname AS function_name,
    procedure_record.pronargs AS argument_count,
    pg_get_function_identity_arguments(procedure_record.oid) AS identity_arguments,
    format_type(procedure_record.prorettype, NULL) AS return_type,
    language_record.lanname AS language_name,
    procedure_record.prosrc AS function_body,
    procedure_record.proconfig AS function_config,
    procedure_record.prosecdef AS prosecdef,
    procedure_record.prosecdef AS is_security_definer,
    procedure_record.provolatile AS volatility,
    procedure_record.proparallel AS parallel_safety
  FROM pg_proc procedure_record
  JOIN pg_namespace namespace_record
    ON namespace_record.oid = procedure_record.pronamespace
  JOIN pg_language language_record
    ON language_record.oid = procedure_record.prolang
  WHERE namespace_record.nspname = $1
    AND procedure_record.proname = ANY($2::text[])
  ORDER BY procedure_record.proname
`;

export const transferCustodyTriggersQuery = `
  SELECT
    trigger_record.tgname AS trigger_name,
    relation_record.relname AS relation_name,
    relation_namespace.nspname AS relation_schema,
    function_record.proname AS function_name,
    function_namespace.nspname AS function_schema,
    function_record.pronargs AS function_argument_count,
    pg_get_function_identity_arguments(function_record.oid) AS function_identity_arguments,
    trigger_record.tgtype::integer AS trigger_type,
    trigger_record.tgenabled AS enabled,
    trigger_record.tgqual IS NULL AS when_is_null,
    trigger_record.tgattr::smallint[] AS trigger_columns,
    trigger_record.tgisinternal AS is_internal
  FROM pg_trigger trigger_record
  JOIN pg_class relation_record
    ON relation_record.oid = trigger_record.tgrelid
  JOIN pg_namespace relation_namespace
    ON relation_namespace.oid = relation_record.relnamespace
  JOIN pg_proc function_record
    ON function_record.oid = trigger_record.tgfoid
  JOIN pg_namespace function_namespace
    ON function_namespace.oid = function_record.pronamespace
  WHERE relation_namespace.nspname = $1
    AND trigger_record.tgname = ANY($2::text[])
  ORDER BY trigger_record.tgname
`;

/*
 * The LEFT JOIN preserves an extension row when the digest overload is
 * absent or is no longer a member of pgcrypto, allowing the verifier to
 * report a normal safeguard mismatch instead of treating a missing object as
 * a verifier/database error.
 */
export const transferCustodyPgcryptoQuery = `
  SELECT
    extension_record.extname,
    extension_namespace.nspname AS extension_schema,
    digest_record.oid IS NOT NULL AS digest_function_found,
    digest_record.oid AS digest_function_oid,
    digest_namespace.nspname AS digest_function_schema,
    digest_record.pronargs AS digest_argument_count,
    pg_get_function_identity_arguments(digest_record.oid) AS digest_identity_arguments,
    format_type(digest_record.prorettype, NULL) AS digest_return_type,
    digest_language.lanname AS digest_language,
    digest_dependency.deptype AS digest_dependency_type
  FROM pg_extension extension_record
  JOIN pg_namespace extension_namespace
    ON extension_namespace.oid = extension_record.extnamespace
  LEFT JOIN pg_proc digest_record
    ON digest_record.proname = 'digest'
   AND digest_record.pronamespace = extension_record.extnamespace
   AND digest_record.proargtypes =
       ARRAY['text'::regtype, 'text'::regtype]::oidvector
  LEFT JOIN pg_namespace digest_namespace
    ON digest_namespace.oid = digest_record.pronamespace
  LEFT JOIN pg_language digest_language
    ON digest_language.oid = digest_record.prolang
  LEFT JOIN pg_depend digest_dependency
    ON digest_dependency.classid = 'pg_proc'::regclass
   AND digest_dependency.objid = digest_record.oid
   AND digest_dependency.refclassid = 'pg_extension'::regclass
   AND digest_dependency.refobjid = extension_record.oid
   AND digest_dependency.deptype = 'e'
  WHERE extension_record.extname = 'pgcrypto'
`;

// Stable descriptive aliases for callers that refer to this catalog as a
// digest/extension check rather than a pgcrypto check.
export const transferCustodyDigestQuery = transferCustodyPgcryptoQuery;
export const expectedTransferCustodyFunctions =
  TRANSFER_CUSTODY_FUNCTION_DEFINITIONS;
export const expectedTransferCustodyTriggers =
  TRANSFER_CUSTODY_TRIGGER_DEFINITIONS;

/*
 * These references deliberately use the same unqualified names as migration
 * 0084.  A schema-qualified digest probe alone would pass even if the
 * function's runtime search_path resolved a shadowed or missing function.
 * `to_regprocedure` and `to_regclass` resolve in this transaction's actual
 * search_path, while the catalog joins below let the verifier compare the
 * resolved objects to the reviewed objects.
 */
export const transferCustodyResolutionQuery = `
  SELECT
    $1::text AS expected_schema,
    $2::oid AS expected_digest_oid,
    current_setting('search_path') AS search_path,
    current_setting('session_replication_role') AS session_replication_role,
    resolved_digest.oid AS resolved_digest_oid,
    resolved_digest_namespace.nspname AS resolved_digest_schema,
    resolved_digest.proname AS resolved_digest_name,
    pg_get_function_identity_arguments(resolved_digest.oid) AS resolved_digest_identity_arguments,
    resolved_worker.oid AS resolved_worker_oid,
    resolved_worker_namespace.nspname AS resolved_worker_schema,
    resolved_worker.relname AS resolved_worker_name,
    resolved_worker.relkind AS resolved_worker_kind
  FROM (VALUES (1)) AS anchor(dummy)
  LEFT JOIN pg_proc resolved_digest
    ON resolved_digest.oid = to_regprocedure('digest(text, text)')
  LEFT JOIN pg_namespace resolved_digest_namespace
    ON resolved_digest_namespace.oid = resolved_digest.pronamespace
  LEFT JOIN pg_class resolved_worker
    ON resolved_worker.oid = to_regclass('onb_transfer_workers')
  LEFT JOIN pg_namespace resolved_worker_namespace
    ON resolved_worker_namespace.oid = resolved_worker.relnamespace
`;

export function transferCustodyDigestProbeQuery() {
  return `
    SELECT encode(
      digest($1::text, 'sha256'::text),
      'hex'
    ) AS sha256_hex
  `;
}

function isEmptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function isNullOrEmptyConfig(value) {
  return value === null;
}

function functionFailure(definition, schema, reason) {
  return (
    `transfer custody function malformed: ${schema}.${definition.name}() ` +
    reason
  );
}

function triggerFailure(definition, schema, reason) {
  return (
    `transfer custody trigger malformed: ${schema}.${definition.relation} ` +
    `${definition.name} ` +
    reason
  );
}

function findNamedRow(rows, field, name) {
  return (Array.isArray(rows) ? rows : []).find((row) => row?.[field] === name);
}

function hasExactTriggerColumns(value) {
  // pg's int2vector cast is [] for a trigger applying to every column.
  return isEmptyArray(value);
}

function hasExpectedFunctionShape(row, definition, schema) {
  if (!row) {
    return `transfer custody function missing: ${schema}.${definition.name}()`;
  }
  if (row.function_schema !== schema) {
    return functionFailure(definition, schema, `has schema ${row.function_schema}`);
  }
  if (row.argument_count !== 0 || row.identity_arguments !== "") {
    return functionFailure(definition, schema, "has an unexpected signature");
  }
  if (row.return_type !== "trigger") {
    return functionFailure(definition, schema, `returns ${row.return_type}`);
  }
  if (row.language_name !== "plpgsql") {
    return functionFailure(definition, schema, `uses ${row.language_name}`);
  }
  const isSecurityDefiner =
    row.is_security_definer === undefined
      ? row.prosecdef
      : row.is_security_definer;
  if (isSecurityDefiner !== false) {
    return functionFailure(definition, schema, "is SECURITY DEFINER");
  }
  if (row.function_body !== definition.body) {
    return functionFailure(definition, schema, "body differs from migration 0084");
  }
  if (!isNullOrEmptyConfig(row.function_config)) {
    return functionFailure(
      definition,
      schema,
      "has unexpected function configuration",
    );
  }
  return null;
}

function hasExpectedTriggerShape(row, definition, schema) {
  if (!row) {
    return (
      `transfer custody trigger missing: ${schema}.${definition.relation} ` +
      `${definition.name}`
    );
  }
  if (row.relation_schema !== schema || row.relation_name !== definition.relation) {
    return triggerFailure(definition, schema, "targets an unexpected relation");
  }
  if (row.function_schema !== schema || row.function_name !== definition.functionName) {
    return triggerFailure(definition, schema, "executes an unexpected function");
  }
  if (
    row.function_argument_count !== 0 ||
    row.function_identity_arguments !== ""
  ) {
    return triggerFailure(definition, schema, "executes a function with arguments");
  }
  if (row.trigger_type !== definition.type) {
    return triggerFailure(definition, schema, "has unexpected timing or events");
  }
  if (row.enabled !== "O") {
    return triggerFailure(definition, schema, "is not enabled for origin sessions");
  }
  if (row.when_is_null !== true) {
    return triggerFailure(definition, schema, "has a WHEN predicate");
  }
  if (!hasExactTriggerColumns(row.trigger_columns)) {
    return triggerFailure(definition, schema, "has an UPDATE OF column list");
  }
  if (row.is_internal === true) {
    return triggerFailure(definition, schema, "is unexpectedly internal");
  }
  return null;
}

function findPgcryptoRow(rows) {
  return (Array.isArray(rows) ? rows : []).find(
    (row) => row?.extname === "pgcrypto",
  );
}

function pgcryptoFailures(pgcryptoRows) {
  const row = findPgcryptoRow(pgcryptoRows);
  if (!row) {
    return ["pgcrypto extension missing"];
  }
  if (row.digest_function_found !== true) {
    return [
      "pgcrypto digest(text, text) overload missing or not a catalog function",
    ];
  }
  if (row.digest_dependency_type !== "e") {
    return [
      "pgcrypto digest(text, text) overload is not a member of pgcrypto",
    ];
  }
  const failures = [];
  if (row.digest_argument_count !== 2 || row.digest_identity_arguments !== "text, text") {
    failures.push("pgcrypto digest(text, text) overload has an unexpected signature");
  }
  if (row.digest_return_type !== "bytea") {
    failures.push(`pgcrypto digest(text, text) overload returns ${row.digest_return_type}`);
  }
  if (row.digest_function_schema !== row.extension_schema) {
    failures.push("pgcrypto digest(text, text) overload is outside the extension schema");
  }
  return failures;
}

export function findTransferCustodyReadinessFailures({
  schema,
  functions,
  triggers,
  pgcrypto,
  digestProbe,
  functionQueryFailed = false,
  triggerQueryFailed = false,
  pgcryptoQueryFailed = false,
  resolution,
  resolutionQueryFailed = false,
  digestProbeFailed = false,
} = {}) {
  const failures = [];
  if (functionQueryFailed) {
    failures.push(
      `transfer custody catalog query failed for functions in schema ${schema}`,
    );
  } else {
    for (const definition of TRANSFER_CUSTODY_FUNCTION_DEFINITIONS) {
      const failure = hasExpectedFunctionShape(
        findNamedRow(functions, "function_name", definition.name),
        definition,
        schema,
      );
      if (failure) failures.push(failure);
    }
  }

  if (triggerQueryFailed) {
    failures.push(
      `transfer custody catalog query failed for triggers in schema ${schema}`,
    );
  } else {
    for (const definition of TRANSFER_CUSTODY_TRIGGER_DEFINITIONS) {
      const failure = hasExpectedTriggerShape(
        findNamedRow(triggers, "trigger_name", definition.name),
        definition,
        schema,
      );
      if (failure) failures.push(failure);
    }
  }

  if (pgcryptoQueryFailed) {
    failures.push("pgcrypto catalog query failed");
  } else {
    failures.push(...pgcryptoFailures(pgcrypto));
  }

  const pgcryptoRow = findPgcryptoRow(pgcrypto);
  if (resolutionQueryFailed) {
    failures.push("transfer custody runtime resolution query failed");
  } else {
    if (
      resolution &&
      resolution.session_replication_role !== "origin" &&
      resolution.session_replication_role !== "local"
    ) {
      failures.push(
        "transfer custody verification requires session_replication_role origin or local",
      );
    }
  }
  if (!resolutionQueryFailed && pgcryptoRow?.digest_function_found) {
    const expectedDigestOid = pgcryptoRow.digest_function_oid;
    if (
      expectedDigestOid === undefined ||
      expectedDigestOid === null ||
      String(resolution?.resolved_digest_oid) !== String(expectedDigestOid) ||
      resolution?.resolved_digest_schema !== pgcryptoRow.digest_function_schema ||
      resolution?.resolved_digest_name !== "digest" ||
      resolution?.resolved_digest_identity_arguments !== "text, text"
    ) {
      failures.push(
        "unqualified digest(text, text) does not resolve to the pgcrypto overload",
      );
    }
    if (
      resolution?.resolved_worker_schema !== schema
    ) {
      failures.push(
        "unqualified onb_transfer_workers does not resolve to the target schema",
      );
    }
    if (
      resolution?.resolved_worker_name !== "onb_transfer_workers" ||
      resolution?.resolved_worker_kind !== "r"
    ) {
      failures.push(
        "unqualified onb_transfer_workers does not resolve to a base table",
      );
    }
  }
  if (digestProbeFailed || !pgcryptoRow?.digest_function_found) {
    if (digestProbeFailed) {
      failures.push("pgcrypto sha256 digest probe failed");
    }
  } else if (
    digestProbe?.sha256_hex !== TRANSFER_CUSTODY_PGCRYPTO_PROBE_SHA256
  ) {
    failures.push("pgcrypto sha256 digest(text, text) is not usable");
  }

  return failures;
}

// Explicit aliases make the pure catalog contract easy to consume from
// verifier tests without coupling callers to an implementation noun.
export const findTransferCustodyCatalogFailures =
  findTransferCustodyReadinessFailures;
export const findTransferCustodyFailures = findTransferCustodyReadinessFailures;