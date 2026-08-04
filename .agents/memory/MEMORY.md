# Memory Index

- [Cost-explorer model conventions](cost-model-conventions.md) — assumptions register is the single source of truth; every input must move the result; reconcile rows/buckets/totals in tests.
- [Task merges can revert uncommitted edits](task-merge-reverts.md) — after a background task merge, re-verify recent edits before building on them.
- [Scenario form/API mapping](scenario-form-mapping.md) — use the canonical mapper pair; never spread raw API inputs into form state or stale overrides survive resets.
