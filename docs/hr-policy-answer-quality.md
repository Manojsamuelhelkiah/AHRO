# HR policy answer-quality evaluation

This is roadmap assurance work for the existing extract-selection assistant,
not a current accuracy guarantee, legal assurance, fairness certification or
permission to automate employment decisions. The business-user explainer in
`deliverables/Agentic_HRO_Business_User_Explainer.pdf` and its source
`docs/business-user-explainer/build_pdf.py` describe the larger roadmap; this
harness does not establish that the broader roadmap is complete.

## Business review

Open **UAT Test Center → Policy answer-quality benchmarks**. All benchmark
questions and sources are fixed fictional content. Review each question, the
full source, its version, dates, audience, requested applicability, expected
outcome, abstention requirement and rationale. The clock is frozen at
2026-10-08 so expiry tests remain repeatable.

The checked-in answer key is a **proposal**, not pre-approved business truth.
A currently verified `hr-compliance` governance assignee with current tenant
membership must explicitly approve or reject the complete content hash and
record a business review reference. An owner/admin role alone cannot approve.
No AI judge, confidence score or model-generated answer may substitute for
the business review.

Approval and rejection are tenant-scoped and retained with reviewer,
authority assignment, review identity, time and reference. Concurrent decisions
require the current review identity. Any change to questions, sources,
source revisions, dates, audiences, expected answers or rationale invalidates
the old approval. To correct a rejected case, update the synthetic pack in
`artifacts/api-server/src/lib/hr-policy-benchmark.ts`, then have the new exact
answer key reviewed. Do not add real employee text, tenant policy uploads or
employee records to this pack. Review references must not contain personal data.

## Two kinds of evidence

* **Provider-free contract replay:** no model, provider initialization,
  database setup or credentials. Scripted answer-key responses are replayed
  through the production JSON/quotation validator and date/audience/source
  gates. CI also tries fabricated quotes, source ids, wrong supported outcomes
  and malformed abstentions. A green replay is **not model accuracy**.
* **Real-model synthetic evaluation:** a distinct operation requiring
  business-approved ground truth, fresh verified HR compliance authority and
  explicit budget consent. The service uses the same production selector,
  model, prompt, full source context and exact-quote validation. Only the fixed
  synthetic questions and texts go to the provider. HTTP callers cannot
  supply custom questions, sources, model names or employee identifiers.

Use **Authorize and run real-model benchmark** only after approval. This can
consume provider budget. The current paired pack is bounded at 20 calls,
3,000 completion tokens per call / 60,000 completion tokens per run, 6,000 total
request-content characters per call, 180 seconds and three reserved live runs
per tenant per UTC day.
Requests are sequential with a 30-second per-call timeout, cancellation at the
run deadline and no provider retries. Input tokens also incur provider cost;
character limits bound input size, not a dollar-price guarantee.

The durable budget reservation precedes disclosure. Parallel live runs are
blocked, and an interrupted run consumes its reservation. Retrying the same
request identity never dispatches again. A crashed unfinished run is not
success and is not automatically resumed. Check recent evidence before
authorizing a new run. Authority and the exact business review are checked
before every provider call and again at completion.

## Scoring and provenance

The deterministic scorer compares **outcome, explicit abstention and exact
quotation/citation contract** against the reviewed key. Every expected
abstention must have no quote. Every supported answer must quote the exact
server-created candidate with its allowed id. Error, not-run, unavailable,
invalid citation, exhausted budget or revoked authority is never scored as a
correct semantic abstention. Any mismatch fails the run; there is no percentage
threshold that permits an unsafe supported answer.

Reports separate scripted replay from real-model evidence. Live reports show
outcome agreement, abstention agreement, unsafe-support counts and per-case
failures. Reports retain the reviewed synthetic snapshot, source versions and
hashes, prompt version, full request-configuration hash, selection-contract
hash, requested model, timestamps, call limits, review identity and provider
receipts (resolved model, response id, fingerprint if supplied and token usage).
No hidden reasoning or confidence judgement is stored.

An offline pass never establishes current live evidence. A historical live
pass with a different prompt/model/request, selection contract, benchmark or
review is marked older evidence and does not satisfy the current evidence
indicator. An alias can change at the provider without a local source change;
resolved-model receipts help investigation but are not a guarantee that a
provider's implementation stayed unchanged.

## Regression and release procedure

Run `pnpm run test:policy-quality` on every change to selection prompts,
models, parsing, source extraction, date/audience gates or benchmark sources.
It is wired into the workspace build/release checks, the API test command and
the scoped GitHub workflow. The isolated bundler rejects provider/database
imports and launches tests with no inherited credentials.

Database-backed authorization and reservation tests:

```
TEST_FILE=src/lib/hr-policy-evaluation.test.ts pnpm --filter @workspace/api-server exec node run-tests.mjs
TEST_FILE=src/lib/hr-policy-library.test.ts pnpm --filter @workspace/api-server exec node run-tests.mjs
```

These tests use synthetic, separately scoped organizations and explicit
in-process fake selectors; they never count as real-model evidence. Production
HTTP routes do not expose a selector injection or provider stub.

Before releasing a model/prompt/selection change or a materially changed policy
source, review whether the fictional cases still represent the intended
policy qualifications. Update and business-review the synthetic answer key as
needed, run the provider-free suite, then authorize a new real-model run and
investigate every failed case. Repeat the live run manually when a provider
alias changes; builds and policy publication never silently spend provider
budget. The harness does not assess every published client policy automatically
and does not replace the assistant's live source authorization or post-model
reauthorization.

## Separately approved provider drift programme

In the same UAT panel, select a current completed **passing real-model** report,
inspect every actual outcome, quote, source and provider receipt, then attest
that you reviewed that baseline and separately authorize the displayed budget.
Answer-key approval or a one-off live run does **not** opt in to drift checking.
Only a freshly verified HR compliance reviewer can approve or stop a programme.
The exact authority assignment and answer-key review are bound to consent.
Offline, failed, incomplete, provider-isolated, superseded or receipt-less
reports cannot serve as production baselines. Baselines are never replaced
automatically after drift.

Consent permits at most **three checks in seven days**, starting no sooner
than 24 hours after approval and spaced at least 24 hours apart. The runtime
System Watcher / external heartbeat drives due checks; it processes at most
one programme per tick. This is not a promise of exact clock-time execution:
if the heartbeat is absent, no new evidence exists. Each check uses the same
current 20-call / 60,000 completion-token / 6,000-character-per-call / 180-second
limits as an explicit live run, and shares the durable tenant-wide allowance
of three live runs per UTC day. Consent creation, catalog reads, ordinary
builds, CI, policy review and publication never trigger provider spending.

Before reservation, every provider call and completion, the worker checks
current membership, the **same verified authority assignment**, unexpired and
unstopped programme consent, exact reviewed baseline and current answer-key,
request and selection-contract hashes. A changed local benchmark or prompt
requires a new reviewed live baseline, not an automatic migration of consent.
Only checked-in fictional sources and questions are dispatched; API requests
cannot provide model names, prompts, employee content, cadence or larger limits.

Comparison records requested model, baseline and fresh resolved-model /
fingerprint identity sets, changed case ids, and actual outcome, abstention
and exact-quotation differences. A resolved model or fingerprint change under
the unchanged requested name warns reviewers **even when all answers pass**.
Changed answers or ground-truth failures also warn reviewers. No AI judge is
used. Missing fingerprints are explicitly “unknown” and an unchanged receipt
is never proof that the provider implementation stayed fixed.

Provider errors, missing receipts, budget contention, revoked authority,
changed review or stopped consent pause the programme, with failed/incomplete
evidence distinct from “no observed drift.” Drift warnings suppress the
catalog’s current-live-evidence indicator pending a separately reviewed new
programme. Reservations are consumed before dispatch; concurrent workers
cannot double-spend, and an interrupted check is marked **unfinished** after
its deadline, never retried automatically. A reviewer may stop future calls;
already dispatched provider requests cannot be undone or refunded. After
investigation, stop/reapprove with current consent identity and a reviewed
baseline; renewed consent still cannot reset the shared daily tenant budget.
Programme approvals, stops and run evidence are tenant-scoped and durable.

Database-backed drift safety tests (fake selectors only):

```
TEST_FILE=src/lib/hr-policy-drift.test.ts pnpm --filter @workspace/api-server exec node run-tests.mjs
```

Their durable provider-isolated programmes are excluded by the production
worker. Isolated fixtures never become production live evidence, and HTTP
routes cannot enable the test lane.

The initial pack covers supported, missing, conflicting, injected,
misleading-citation, dated, audience, applicability and unpublished-revision
cases. More client-specific domains, fairness and multilingual coverage remain
separate review work. A passing fixed pack applies only to those tested cases.
