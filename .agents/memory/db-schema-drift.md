---
name: DB schema reconciliation
description: Development schema changes need non-interactive migration application plus independent live-schema verification
---

Treat an automatic migration refusal as a safety finding to diagnose, not permission to switch immediately to privileged execution.

**Why:** Malformed migration packaging can resemble a reviewed-only operation. Bypassing the additive validator would conceal the underlying defect.

**How to apply:** Establish whether the intended operation truly requires reviewed authority before seeking approval; keep the validator intact and preserve recorded migration hashes.

Development schema changes must be represented by immutable, journaled SQL migrations. Post-merge setup must apply each statement non-interactively, record it durably, and verify the live schema against an expected schema rebuilt from the checked-in migration history. Automatic reconciliation is an allowlist for table definitions, indexes, and additive ALTER operations; any historical exception must be pinned to the exact reviewed migration hash rather than a mutable tag. Explicit destructive execution must bind approval to both tag and hash, reject transaction-control or multi-command statements, fail the whole transaction on any statement error, and record a trusted expected-schema receipt atomically. Automatic safety applies to pending work: an exact reviewed receipt permits later reconciliation, but reviewed SQL must not be replayed for schema verification because procedural or data statements can repeat side effects. If a later migration replaces a historical unique key, interrupted-ledger adoption may need an exact migration-and-statement compatibility rule for the old `ON CONFLICT` target; never broaden that exception to the PostgreSQL error code globally.

**Why:** schema-push tooling can require a TTY while automated merge setup has closed stdin. A partial additive migration once left required columns absent and broke every client estimate until manual repair. Application-only smoke checks may miss drift until a database-dependent route is exercised. A tag-only exception could let later edits silently inherit permission to run destructive SQL after a merge. SQL safety parsing must match the connection's string settings or quote/semicolon differences can hide a second destructive statement. Re-adopting an older migration after a tenant migration replaced a global primary key with a composite key caused PostgreSQL to reject the old conflict target even though the historical backfill was already represented.

**How to apply:** add a forward SQL migration and matching journal entry for every schema change; use idempotent additive DDL where possible. A migration is immutable as soon as any reconciliation run records its hash, even before the code is committed: restore those exact bytes and use a new forward correction if review later finds unsafe data behavior. If the interval between migrations could accumulate tenant records, preserve that intermediate state and test the staged upgrade, not only a fresh replay. Keep the reconciliation command in merge setup and run a database-backed smoke against the user-critical route. Treat missing tables, columns, constraints, indexes, changed migration hashes, unjournaled files, and pending statements outside the additive allowlist as hard failures. Compare foreign keys as a semantic multiset of local table/columns and referenced table/columns, not by constraint name: PostgreSQL truncates identifiers, and duplicate legacy relationships must still count as unexpected drift. Route destructive, procedural, overwriting, and otherwise unsupported changes through a separate reviewed process with strict transaction semantics. Reassert the validator's PostgreSQL string mode before every reviewed statement; a migration may change session parsing settings between statements. Exercise both fresh-schema and interrupted-ledger reconstruction after changing natural-key constraints, including fixtures that supply every newly required tenant column. Recovery tests run migrations in temporary schemas via `search_path`: existence checks must resolve against that active schema rather than hard-coding `public`, and migrations that depend on tenant tables must be excluded from any pre-tenant replay fixture so a recorded no-op cannot suppress their later application. Any compatibility exception must be pinned to the exact historical migration and SQL shape while the current expected schema is still verified independently. When Publish must add a required tenant key to populated production tables, use a temporary default to preserve rows, defer direct parent FKs until the parent seed exists, and remove both concessions in a verified follow-up publish.

Receipt reconstruction must create standalone unique indexes before foreign keys that reference those indexed columns.

Keep expected-schema replay isolated even when migrations call database-wide extension functions.

**Why:** An extension can already exist outside the disposable replay schema; `CREATE EXTENSION IF NOT EXISTS` then does not make its functions resolvable there. Adding the live schema to the replay search path could hide missing tables.

**How to apply:** Resolve the installed extension namespace and qualify only reviewed, exact-hash-bound extension calls during replay. Preserve original live migration bytes. Test with the extension already installed outside the scratch schema.

When parallel merges collide on a migration journal index, repair the index without casually changing the migration tag, timestamp, or SQL.

**Why:** Ledger identity includes the recorded timestamp and SQL hash; making timestamps look sequential can invalidate an already-applied migration even when its SQL is unchanged.

**How to apply:** Distinguish journal ordering metadata from ledger identity, preserve recorded migration identity, and confirm the repair through the normal post-merge reconciliation.

**Why:** PostgreSQL permits an FK to reference a standalone unique index, not only a named unique constraint. Rebuilding all FKs before indexes can reject a valid live schema.

**How to apply:** Preserve dependency order when reconstructing trusted schema receipts; do not omit the FK or weaken comparisons to work around missing parent uniqueness.
