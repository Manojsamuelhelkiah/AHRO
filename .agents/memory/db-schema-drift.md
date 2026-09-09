---
name: DB schema reconciliation
description: Development schema changes need non-interactive migration application plus independent live-schema verification
---

Development schema changes must be represented by immutable, journaled SQL migrations. Post-merge setup must apply each statement non-interactively, record it durably, and verify the live schema against an expected schema rebuilt from the checked-in migration history. Automatic reconciliation is an allowlist for table definitions, indexes, and additive ALTER operations; any historical exception must be pinned to the exact reviewed migration hash rather than a mutable tag.

**Why:** schema-push tooling can require a TTY while automated merge setup has closed stdin. A partial additive migration once left required columns absent and broke every client estimate until manual repair. Application-only smoke checks may miss drift until a database-dependent route is exercised. A tag-only exception could let later edits silently inherit permission to run destructive SQL after a merge. SQL safety parsing must match the connection's string settings or quote/semicolon differences can hide a second destructive statement.

**How to apply:** add a forward SQL migration and matching journal entry for every schema change; use idempotent additive DDL where possible. Keep the reconciliation command in merge setup and run a database-backed smoke against the user-critical route. Treat missing tables, columns, constraints, indexes, changed migration hashes, unjournaled files, and statements outside the additive allowlist as hard failures. Route destructive, procedural, overwriting, and otherwise unsupported changes through a separate reviewed process. When splitting SQL locally, enforce the same PostgreSQL string-mode setting on the execution session.
