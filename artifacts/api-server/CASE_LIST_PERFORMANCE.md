# Case-list batching

## Measurement

The regression fixture uses 120 copies of existing retained fictional example
definitions in a private PostgreSQL schema. It does not provision records in
the application’s Demo or client tenants. Background workers cannot see the
fixtures, and teardown drops the private schema.

Measured on 2026-10-13:

| Read path | Database calls | Elapsed time |
| --- | ---: | ---: |
| Ordinary per-case projection, 120 rows | 2,640 | 683 ms |
| Batched list endpoint, identical output | 19 | 60 ms |

A second run during server builds measured 1,141 ms and 69 ms respectively,
with the same query counts. Timings are observations, not production latency
guarantees; the automated regression asserts output equivalence and bounded
query counts rather than a timing threshold.

Counts include transaction begin/commit calls. The baseline invokes the
ordinary detail serializer concurrently for the same rows. The batched
measurement includes the HTTP list endpoint, tenant selection and Demo filter.
Authorization database-call count is also checked for equality at 10 and 120
rows.

## Safety and limitations

- Access inputs are read once per request in a tenant-scoped, read-only,
  repeatable-read transaction. The existing permission evaluator still decides
  each case; no permission cache persists across requests.
- Sensitive fields still require independent current professional authority.
  Bulk and detail projections are compared for full and partial specialist
  access as well as users without specialist authority.
- Shared presentation reads retain the existing trusted-BGV, malware and UAT
  predicates. Lists do not approve cases or authorize execution.
- Cases with Vault receipts still perform the existing live consent, policy and
  check verification. That conditional work is not bounded independently of
  the number of receipt-bearing cases; absent receipts are checked in bulk.
- Lists remain unpaginated. This change reduces repeated database work, not
  response size or the number of rows rendered in the browser.
- Offline-only lists refresh permissions every 30 seconds and stop displaying
  cached case metadata on a failed refresh.

## Reproduce

```sh
TEST_FILE=src/routes/onboarding-case-list-batch.test.ts \
  pnpm --filter @workspace/api-server exec node run-tests.mjs
TEST_FILE=src/routes/onboarding-evidence.test.ts \
  pnpm --filter @workspace/api-server exec node run-tests.mjs
TEST_FILE=src/pages/cases/index.test.tsx \
  pnpm --filter @workspace/onboarding-agent test
```
