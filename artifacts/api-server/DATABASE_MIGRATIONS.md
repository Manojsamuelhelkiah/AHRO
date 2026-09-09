# Database migration commands

`pnpm --filter @workspace/api-server run db:reconcile` is the only migration
command used by `scripts/post-merge.sh`. It intentionally accepts additive
schema changes only and must never receive a destructive-policy bypass.

After every production publish, run the tenant safeguard verification in an
environment where `DATABASE_URL` is bound to that published database:

```sh
pnpm --filter @workspace/api-server run db:verify:tenant-safeguards
```

The command is read-only. It checks that every application tenant column has no
default, verifies direct organization and watch-email composite foreign keys by
their ordered column mappings (not their possibly PostgreSQL-shortened names),
requires the `demo` organization, and counts organization, watch-case, and
watch-check orphans. Any failed safeguard is named on stderr and makes the
command exit non-zero; do not trust the publish until every check passes.

For a deliberately reviewed destructive or otherwise unsupported migration:

1. Check in the SQL file and journal entry.
2. Run `pnpm --filter @workspace/api-server run db:migrate:reviewed -- --migration <tag>`.
   The command reports the exact migration tag, SHA-256 hash, and statement
   count, then refuses execution while showing the required approval value.
3. Review that exact file and target database. Rerun the command with
   `--approve 'APPLY:<tag>:<sha256>'`.

The approval is intentionally bound to the file hash, so editing the migration
invalidates an earlier review. The reviewed command applies only the named next
pending migration; it refuses missing, changed, out-of-order, or already-applied
migrations. Every statement runs strictly in one transaction: any statement
error rolls back both earlier statements and the migration receipt, and
migrations containing transaction-control or multiple-command statements are
refused. The runner reasserts its validated PostgreSQL string mode before every
statement. Automatic reconciliation continues to refuse a pending destructive
migration, but accepts an exact already-applied receipt. It verifies later drift
against a trusted schema snapshot stored with the receipt rather than replaying
reviewed SQL.
