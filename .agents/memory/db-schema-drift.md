---
name: DB schema reconciliation
description: Development schema changes need non-interactive migration application plus independent live-schema verification
---

Development schema changes must be represented by immutable, journaled SQL migrations. Post-merge setup must apply each statement non-interactively, record it durably, and verify the live schema against an expected schema rebuilt from the checked-in migration history.

**Why:** schema-push tooling can require a TTY while automated merge setup has closed stdin. A partial additive migration once left required columns absent and broke every client estimate until manual repair. Application-only smoke checks may miss drift until a database-dependent route is exercised.

**How to apply:** add a forward SQL migration and matching journal entry for every schema change; use idempotent additive DDL where possible. Keep the reconciliation command in merge setup and run a database-backed smoke against the user-critical route. Treat missing tables, columns, constraints, indexes, changed migration hashes, and unjournaled files as hard failures.
