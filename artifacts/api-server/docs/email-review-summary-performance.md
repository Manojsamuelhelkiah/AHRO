# Retained email review summary measurements

Measured in the development PostgreSQL workspace on 2026-10-13, using
transaction-rolled-back, disabled-ingress fixtures. No real messages or providers
were involved.

## Baseline

The original implementation read every tenant request ID into JavaScript, derived
every protected reference, and submitted both arrays in one aggregate query.

| Retained requests | Largest SQL parameter payload | Summary query elapsed |
| --- | ---: | ---: |
| 10,000 | 920,224 bytes | 91 ms |
| 100,000 | 9,200,224 bytes | 681 ms |

Those baseline cohorts contained waiting requests only. Payload size and application
memory grew with the full retained cohort, even though the returned summary was
under 400 bytes.

## Bounded correlation

A forward-only transaction cursor reads at most 1,000 identifiers at a time.
The existing protected-audit writer helper derives references in the application;
only identifier/reference pairs enter a transaction-local temporary table.
The aggregate joins that table and independently rechecks tenant, date and
synthetic-case fences. No pseudonymization key is passed to PostgreSQL.

| Retained requests | Largest SQL parameter payload | Largest returned correlation page | Elapsed |
| --- | ---: | ---: | ---: |
| 10,000 | 92,005 bytes | 1,000 rows | 309 ms |
| 100,000 | 92,005 bytes | 1,000 rows | 1,280 ms |

The latter cohorts mix waiting, converted, rejected, missing-evidence and reviewed
rows, with sparse protected audits and repeated reviews across page boundaries.
These timings are illustrative, not directly comparable latency benchmarks or
production guarantees. The important scaling invariant is bounded application
correlation memory and per-query payload; PostgreSQL still processes the full
eligible cohort. Total work and database temporary space remain proportional to
retained volume.

A final run using a fictional keyed pseudonymization secret, the synthetic-case
sentinel and interrupted-transaction cleanup checks measured 98 ms and 838 ms
respectively. The largest payload and page sizes remained unchanged.

An initial temporary-table implementation paged and updated an indexed mapping
in place; it took about 2,343 ms at 100,000 rows. The forward-only cursor and
append-only temporary mapping avoid those repeated updates and index maintenance.
There is intentionally no persistent crosswalk, new retention policy, SQL hash,
or claim that rotated historical keys can be recovered.

## Regression coverage

Run from `artifacts/api-server`:

```sh
TEST_FILE=src/lib/hro-email-turnaround-volume.test.ts node run-tests.mjs
TEST_FILE=src/lib/hro-email-turnaround.test.ts node run-tests.mjs
```

The volume test checks both cohort sizes, exact bands, first-event durations,
means/medians/p90, missing evidence, synthetic exclusions, bounded SQL parameters
and returned pages, small aggregate responses, and resource release on successful
reads and interrupted transaction rollback. The existing semantic test also
rejects other-tenant, pre-receipt, future, system and denied events and proves
mutable update timestamps do not affect measurements. Run these commands
sequentially: the test harness shares one build output directory.

Both tests can also be run with a process-local, fictional
`AUDIT_PSEUDONYMIZATION_KEY` to exercise keyed correlation. Never print or inspect
a real configured key. Do not enforce wall-clock timing as a flaky CI assertion.
