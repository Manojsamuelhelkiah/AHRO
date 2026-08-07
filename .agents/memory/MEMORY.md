# Memory Index

- [Cost-explorer model conventions](cost-model-conventions.md) — assumptions register is the single source of truth; every input must move the result; reconcile rows/buckets/totals in tests.
- [Scenario form/API mapping](scenario-form-mapping.md) — use the canonical mapper pair in `scenario-form.ts`; never spread raw API inputs into form state or stale overrides survive resets.
- [Orval codegen max-constraint TDZ](orval-codegen-max-tdz.md) — `maximum` on additionalProperties in the OpenAPI spec breaks the generated zod module at import; validate ranges app-side.
