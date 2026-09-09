---
name: Indexes on optional recovery tables
description: Constraints on adding indexes when historical recovery schemas intentionally omit newer tables.
---

Do not add an automatic `CREATE INDEX` migration for a table that may be absent from a supported historical recovery schema. Do not wrap it in procedural SQL: automatic reconciliation intentionally rejects procedural statements.

**Why:** Recovery verification applies every later automatic migration even when an earlier feature migration was a safe no-op because its prerequisite tables did not exist. A plain index statement then fails on the missing relation, while a guarded `DO` block violates the additive-only migration policy.

**How to apply:** Before adding an index migration, confirm the indexed table exists in every recovery baseline that will receive it. If it does not, use a project-approved migration strategy that preserves recovery compatibility; do not weaken the migration classifier or bypass its ledger.