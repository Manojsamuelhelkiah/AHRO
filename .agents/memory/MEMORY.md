# Memory Index

- [Cost-explorer model conventions](cost-model-conventions.md) — assumptions register is the single source of truth; every input must move the result; reconcile rows/buckets/totals in tests.
- [Scenario form/API mapping](scenario-form-mapping.md) — use the canonical mapper pair in `scenario-form.ts`; never spread raw API inputs into form state or stale overrides survive resets.
- [Orval codegen max-constraint TDZ](orval-codegen-max-tdz.md) — `maximum` on additionalProperties in the OpenAPI spec breaks the generated zod module at import; validate ranges app-side.
- [Reasoning model token budget](reasoning-model-token-budget.md) — gpt-5 models return empty content when max_completion_tokens is too small; add ~+2500 buffer.
- [DB schema drift & drizzle push](db-schema-drift.md) — drizzle-kit push needs a TTY; missing columns silently break background pollers, apply DDL via SQL instead.
- [Monitor alert dedup must be durable](monitor-alert-dedup.md) — one-alert-per-outage state belongs in the DB, not process memory; failed sub-requests must fail the poll.
- [Stale composite declarations](stale-composite-decls.md) — `tsc --noEmit` reads workspace libs' built dist d.ts; use `tsc -b` or phantom type errors contradict the source.
- [Gmail self-send echo loop](gmail-self-send-echo.md) — store outbound provider message ids in the inbound dedup column or the poller replies to its own mail forever.
