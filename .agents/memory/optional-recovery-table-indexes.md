---
name: Indexes on optional recovery tables
description: Constraints on adding indexes when historical recovery schemas intentionally omit newer tables.
---

Do not add an automatic `CREATE INDEX` migration for a table that may be absent from a supported historical recovery schema. Do not wrap it in procedural SQL: automatic reconciliation intentionally rejects procedural statements. A reviewed conditional forward migration is not sufficient by itself if it can be recorded as a no-op before a recovery later restores the table. In that case, the table's conditional birth migration must also define the index, the forward repair must cover databases that already applied the prior birth migration, and reconciliation may accept only that exact predecessor hash.

**Why:** Recovery verification applies every later automatic migration even when an earlier feature migration was a safe no-op because its prerequisite tables did not exist. A plain index statement then fails on the missing relation, while a guarded `DO` block violates the additive-only migration policy. A conditional repair can also be ledgered too early and never rerun, leaving indexes absent when the table appears later.

**How to apply:** Before adding an index migration, confirm the indexed table exists in every recovery baseline that will receive it. If it does not, use a hash-pinned reviewed conditional repair plus a self-sufficient table-creation path, and test recovery where the repair no-ops before the table is restored. Keep any predecessor-hash allowance scoped to one exact migration and hash; do not weaken the classifier or bypass the ledger.