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
- [Task-merge file corruption](task-merge-corruption.md) — platform merges can scramble co-edited files; typecheck after every merge, repair from last good commit + re-apply merge intent.
- [Autoscale pauses in-process pollers](autoscale-background-pollers.md) — setInterval work stops without traffic; drive all pollers via the throttled heartbeat endpoint and wire new pollers into it.
- [Webhook session durability](webhook-session-durability.md) — DB-backed call/webhook sessions need owner-fenced lease finalization, DB-boundary idempotency keys, and atomic start claims, or races/crashes duplicate or lose outcomes.
- [Clerk demo login via sign-in tickets](clerk-demo-login.md) — undeliverable demo emails can't pass device verification; mint backend sign-in tickets; signals-based useSignIn API quirks.
- [Restyle delegation drift](restyle-delegation-drift.md) — design subagents on restyle-only passes can silently change logic (auth predicates, dropped columns); always diff-review.
- [TSX tests in node harness](tsx-tests-node-harness.md) — renderToStaticMarkup UI tests need jsx:automatic, bare builtin externals, and a createRequire banner in the esbuild bundle.
- [Commercial pricing basis](commercial-pricing-basis.md) — quote full committed volume; exclude client labor from supplier COGS; overage recovers variable supplier cost only.
- [Customer-facing copy](customer-facing-copy.md) — product screens must stand alone; never refer users to decks, slides, or other internal documents.
- [OpenAPI integer persistence](openapi-integer-persistence.md) — generated Zod may accept fractional values for integer fields; enforce integrality before storing inputs used for derived snapshots.
