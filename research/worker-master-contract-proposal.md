# Worker-master completion contracts — approved definitions

Proposal version: `worker-master-evidence-proposal-v1`
Implemented contract version: `worker-master-evidence-v1`
Approval reference: `worker-master-definition-approval-2026-10-16`

Status: **Business definitions approved; read-only contract checks implemented.
No worker-master execution is enabled.**

## Approval record

On 16 October 2026, the user explicitly responded **“I approve as HR data owner”**
to the proposed four completion rules. This approves the business definitions
below. It is not independent verification of that person's professional identity,
a tenant-scoped runtime grant, approval of any individual worker transaction or
permission to connect a provider. No personal identifier is copied into this
record.

Baseline: `hro-master-v1` and `hro-operational-v1`, service
`worker-master-setup`. These four definitions now have operational revision `:2`
and source completion-contract revision `worker-master-evidence-v1`. Other
definitions retain their revisions. Taxonomy identities and counts, commercial
intents, coverage, executor registration and provider permissions are unchanged.

## Purpose

Replace generic completion descriptions with independently verifiable,
outcome-specific evidence. A local case status, agent statement,
model answer, dispatch acknowledgement or audit event alone cannot establish
completion in an external HR system.

The contract must be vendor-neutral. Each client's authoritative system,
connection, environment, object types, field mapping and applicable policy
revision must be identified separately before any future execution is enabled.
An unknown binding stays unresolved; it is not assumed to be a local case.

## Reviewed contract envelope

Typed inputs must identify the tenant, request, exact outcome key, contract
version, subject reference, authoritative-system binding, applicable policy
version and requested effective date when relevant. Updates additionally require
the exact target object ID and expected source version.

Completion evidence must bind to that same tenant, request, outcome, contract
version and source binding. It must identify the resulting source object and
version, observation time and durable source receipt reference. An independently
verified read-back or source attestation must establish the required postcondition.
An unverified caller-supplied receipt or `verified: true` field is insufficient.

Retained completion receipts must be immutable and link their verification result,
source evidence and any required version-bound human decision. Corrections append
new evidence rather than rewriting the original receipt. This document supplies
no receipt storage or provider-verification implementation.

## Reviewed outcome definitions

| Outcome | Typed inputs | Observable completion | Human decisions |
|---|---|---|---|
| `collect-worker-profile` | Subject and collection reference; approved required-field schema/version; submitted profile version | The approved collection system confirms that this profile version satisfies the required fields and validations. Retain the source profile ID/version and validated schema version. This is not proof that an employee master record exists or that identity documents are authentic. | HR data owner approves required fields and validation rules. Uncertain identity or disputed data remains for review. |
| `create-worker-record` | Reviewed profile ID/version; resolved person identity; approved employment inputs; intended source object type and effective date | The authoritative HR system confirms the intended worker/person/employment linkage and resulting object ID/version against the approved inputs. A submitted creation request or allocated local case ID is insufficient. | HR data owner approves identity/linkage and creation prerequisites. Unresolved duplicate or identity ambiguity prevents a completion claim. |
| `resolve-duplicate-worker` | Exact candidate object IDs/versions; compared identity evidence references; proposed disposition (`merge` or `keep-separate`) | Source read-back confirms the human-approved disposition. A merge identifies the surviving object and treatment of superseded objects; keeping records separate confirms both identities remain distinct. Detecting duplicates is not resolving them. | HR data steward explicitly approves disposition against the exact candidate versions. No automatic identity merge or inferred survivor. Changed candidates invalidate the decision. |
| `amend-prestart-employment-details` | Exact employment ID/expected version; typed allowed changes and approved values; requested effective date; authoritative pre-start state | Source read-back confirms the approved changed values, effective date, preserved person/employment linkage and new source version. A local profile edit does not prove the HR record changed. | Authorized HR decision covers the changes and effective date. Payroll-impacting changes require the applicable payroll decision. A worker already started or a concurrent source change requires review rather than silently applying pre-start semantics. |

## Automated acceptance checks

For each of the four outcomes, include a positive test with correctly bound,
independently verified source evidence satisfying its specific postcondition.
The positive test must not imply that a provider adapter exists.

Negative tests must establish that:

1. Local case completion, an audit-only record, an agent answer, a queued write,
   a failed write and an ambiguous write outcome cannot establish completion.
2. Missing or mismatched tenant, request, outcome, contract, source binding,
   environment, subject, object or source version is rejected.
3. Unverified, unavailable or stale source evidence remains pending review.
4. Profile completeness does not establish worker creation or document authenticity.
5. Worker creation with an ambiguous identity or unresolved duplicate stays pending.
6. Duplicate detection alone, an unapproved merge, a mismatched survivor or a
   decision on older candidate versions stays pending human review.
7. A keep-separate decision is not falsely tested as a successful merge.
8. An amendment with a mismatched effective date, wrong employment object,
   missing applicable decision, stale expected version or changed actual-start
   state stays pending review.
9. Replacing or superseding evidence cannot rewrite a retained completion receipt
   or silently reuse authority given for a different version.
10. Passing contract checks never promotes coverage, grants permissions, registers
    an executor or performs a provider write.

## Implementation and remaining operational boundary

The master JSON source and operational catalogue now expose the reviewed
outcome/evidence definitions and explicit source/decision requirements. Catalogue
initiation remains proposed and coverage remains catalogued. The typed request
and evidence schemas plus pure read-only assessor are implemented in
`artifacts/api-server/src/lib/worker-master-contracts.ts`; acceptance tests are in
`artifacts/api-server/src/lib/worker-master-contracts.test.ts`.

The assessor requires independently supplied server-owned read-only source and
human-decision verifiers; none is registered by this change. Missing, unavailable
or inconclusive verification returns `pending-human-review`. A positive result
is only `evidence-satisfies-contract`, always with `executionAvailable: false`.
No returned result marks a case complete.

Receipt candidates are content-addressed and frozen snapshots in memory. They
are not a durable immutable receipt store. New evidence produces a new digest;
old evidence does not validate a different input version. A future executor
must persist append-only verified receipts and recheck live permissions, policy
and source state within its existing execution fence before any business effect.

The Intent Catalog and its JSON export display the updated definitions through
the existing UI/API; no new API, case form or permission gate has been added.
Earlier static CSV/XLSX exports and the intent/agent assessment remain historical
baseline artifacts, not exports of this completion-contract revision.

Still required for operational adoption: tenant-specific source bindings,
approved field mappings, evidence freshness rules, identity-resolution criteria,
effective-date rules, authoritative verification and immutable receipt storage.
No provider connection, worker creation, merge, amendment or permission change
is included in this contract-definition change.
