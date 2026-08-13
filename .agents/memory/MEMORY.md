# Memory Index

- [Cost-explorer model conventions](cost-model-conventions.md) — assumptions register is the single source of truth; every input must move the result; reconcile rows/buckets/totals in tests.
- [Scenario form/API mapping](scenario-form-mapping.md) — use the canonical mapper pair in `scenario-form.ts`; never spread raw API inputs into form state or stale overrides survive resets.
- [Orval codegen max-constraint TDZ](orval-codegen-max-tdz.md) — `maximum` on additionalProperties in the OpenAPI spec breaks the generated zod module at import; validate ranges app-side.
- [Reasoning model token budget](reasoning-model-token-budget.md) — gpt-5 models return empty content when max_completion_tokens is too small; add ~+2500 buffer.
- [DB schema drift & drizzle push](db-schema-drift.md) — drizzle-kit push needs a TTY; missing columns silently break background pollers, apply DDL via SQL instead.
- [Monitor alert dedup must be durable](monitor-alert-dedup.md) — one-alert-per-outage state belongs in the DB, not process memory; failed sub-requests must fail the poll.
- [Stale composite declarations](stale-composite-decls.md) — `tsc --noEmit` reads workspace libs' built dist d.ts; use `tsc -b` or phantom type errors contradict the source.
- [Email as a status channel](email-status-channel.md) — inbound email must pass a sender allowlist before changing state; apply first then record the message id; guard on current status+mode.
- [Gmail self-send echo loop](gmail-self-send-echo.md) — store outbound provider message ids in the inbound dedup column or the poller replies to its own mail forever.
- [Task-merge file corruption](task-merge-corruption.md) — platform merges can scramble co-edited files; tsc after every merge, repair via git checkout of last good commit + re-apply merge intent.
- [Root tsc coverage gap](root-tsc-coverage.md) — root `tsc -b` skips artifact app sources; run the per-package typecheck for each touched artifact before declaring done.
- [Autoscale pauses in-process pollers](autoscale-background-pollers.md) — setInterval work stops without traffic; drive all pollers via the throttled heartbeat endpoint and wire new pollers into it.
- [TSX tests in node harness](tsx-tests-node-harness.md) — renderToStaticMarkup UI tests need jsx:automatic, bare builtin externals, and a createRequire banner in the esbuild bundle.
