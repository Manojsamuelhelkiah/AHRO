# Workforce transfer custody and Publish

## Verification record (2026-09-13)

Read-only production catalog queries found **none** of these migration 0084
objects:

| Object | Development | Production |
| --- | --- | --- |
| `pgcrypto` extension and `digest(text,text)` / `digest(bytea,text)` | Present | Absent |
| `onb_transfer_worker_source_custody()` | Present | Absent |
| `onb_transfer_reconciliation_source_custody()` | Present | Absent |
| `onb_transfer_data_governance_revision()` | Present | Absent |
| `onb_transfer_workers_source_custody` trigger | Present | Absent |
| `onb_transfer_reconciliations_source_custody` trigger | Present | Absent |
| `onb_transfer_data_governance_revision` trigger | Present | Absent |

The earlier Publish comparison reported tables, columns, foreign keys and indexes
but no installation of these objects. A fresh comparison could not be obtained
in this task environment: the documented `explainSchemaDiff` callback was
unavailable. No Publish was initiated, so this is **not** evidence of a successful
post-Publish custody installation. Tables/columns appearing after Publish, or a
matching migration ledger, must not be interpreted as proof of these protections.
None of the required objects is currently verified as surviving into production.

## Read-only gate

`start-production.mjs` already verifies safeguards before importing the API or
starting workers/listeners. Transfers and retention are live runtime capabilities,
not an independently disabled module, so the custody check belongs in this same
mandatory startup gate, not just a transfer-page warning.

`verify-tenant-safeguards.mjs` performs the new checks after tenant schema
preflight, inside its existing bounded read-only transaction. Missing tables
fail first without querying dependent data. `transfer-custody-readiness.mjs`
checks the reviewed function bodies, signatures, security/configuration,
trigger relation/function/timing/events/column filters/conditions/enabled state,
pgcrypto membership and digest overload, actual unqualified name resolution,
session replication mode, and a known SHA-256 value. It performs no DDL or DML.
Failures prevent startup with `SAFEGUARD_MISMATCH`; timeouts retain their bounded
failure categories. This intentionally may block a new release until an operator
repairs production. Do not remove the gate to get a green deployment.

The worker trigger supplies immutable source fingerprints and rejects changes
to source payload and preserved service dates. The reconciliation trigger binds
receipts to the source worker. The governance trigger advances the policy revision
used by retention snapshots. Application checks alone do not replace them.

## Operator-controlled repair and release

1. Keep transfer use blocked. Review production backups/recovery and the Publish
   schema preview. Use normal Publish for structural schema changes; resolve
   rename warnings explicitly. Never use overwrite-with-development-data as a
   custody repair.
2. Inspect production catalogs using the SQL runner in **Database → production →
   My Data**. Compare the three function definitions and trigger definitions to
   `lib/db/drizzle/0084_workforce_transfer_lifecycle_custody.sql`, not just names.
3. If Publish omits the procedural objects, the authorized operator—not Agent,
   startup, or build—must arrange their installation through the platform's
   database administration surface. Replit documents a SQL runner and production
   Edit mode, but the documentation does not specifically guarantee extension or
   trigger DDL privileges. Confirm those permissions first. If unavailable,
   request Replit support-assisted installation; leave the release blocked.
   Do not obtain alternate production credentials or use application endpoints
   to bypass that restriction.
4. Have the operator/platform administrator review the existing migration as the
   repair specification. Do **not** blindly replay it: Publish may already have
   installed its columns; triggers may partially exist; it also contains legacy
   data backfills. Establish pgcrypto availability first, inspect existing worker
   fingerprints and reconciliation links, and approve any required backfill as a
   separate production data repair. Installing triggers alone does not prove the
   provenance of rows written while protections were absent. Quarantine/review
   such rows rather than declaring them verified retrospectively.
5. After the authorized repair, repeat read-only catalog inspection and Publish.
   Require the startup custody stages and the rest of tenant verification to pass
   before declaring the new instance ready. Recheck after later publishes too.
   This gate neither repairs the schema nor promises Publish will preserve it.

Official operator documentation:
https://docs.replit.com/features/data-and-storage/work-with-your-data
and https://docs.replit.com/features/data-and-storage/development-and-production.

## Regression checks

From `artifacts/api-server`:

```sh
node --test verify-tenant-safeguards.test.mjs start-production.test.mjs
NODE_ENV=development node --test transfer-custody-migration.test.mjs
```

The second command uses the existing development connection only. It creates
minimal tables in a unique schema, executes the checked-in migration, tests real
custody and governance behavior plus catalog rejection cases, then rolls the
entire transaction back. It never mutates shared application fixtures. The
readiness manifest is tested against the migration's exact function bodies.