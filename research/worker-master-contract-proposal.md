# Worker-master completion contracts — draft for approval

Proposal version: `worker-master-evidence-proposal-v1`

Status: **Draft — HR data-owner approval pending. Not a runtime contract.**

Baseline: `hro-master-v1` and `hro-operational-v1`, service
`worker-master-setup`. This proposal does not replace either baseline, change
coverage, register an executor, or authorize a provider write.

## Purpose

Replace generic completion descriptions with independently verifiable,
outcome-specific evidence after approval. A local case status, agent statement,
model answer, dispatch acknowledgement or audit event alone cannot establish
completion in an external HR system.

The contract must be vendor-neutral. Each client's authoritative system,
connection, environment, object types, field mapping and applicable policy
revision must be identified separately before any future execution is enabled.
An unknown binding stays unresolved; it is not assumed to be a local case.

## Common proposed contract envelope

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

## Outcome-specific proposals

| Outcome | Typed inputs to define | Observable completion | Human decisions |
|---|---|---|---|
| `collect-worker-profile` | Subject and collection reference; approved required-field schema/version; submitted profile version | The approved collection system confirms that this profile version satisfies the required fields and validations. Retain the source profile ID/version and validated schema version. This is not proof that an employee master record exists or that identity documents are authentic. | HR data owner approves required fields and validation rules. Uncertain identity or disputed data remains for review. |
| `create-worker-record` | Reviewed profile ID/version; resolved person identity; approved employment inputs; intended source object type and effective date | The authoritative HR system confirms the intended worker/person/employment linkage and resulting object ID/version against the approved inputs. A submitted creation request or allocated local case ID is insufficient. | HR data owner approves identity/linkage and creation prerequisites. Unresolved duplicate or identity ambiguity prevents a completion claim. |
| `resolve-duplicate-worker` | Exact candidate object IDs/versions; compared identity evidence references; proposed disposition (`merge` or `keep-separate`) | Source read-back confirms the human-approved disposition. A merge identifies the surviving object and treatment of superseded objects; keeping records separate confirms both identities remain distinct. Detecting duplicates is not resolving them. | HR data steward explicitly approves disposition against the exact candidate versions. No automatic identity merge or inferred survivor. Changed candidates invalidate the decision. |
| `amend-prestart-employment-details` | Exact employment ID/expected version; typed allowed changes and approved values; requested effective date; authoritative pre-start state | Source read-back confirms the approved changed values, effective date, preserved person/employment linkage and new source version. A local profile edit does not prove the HR record changed. | Authorized HR decision covers the changes and effective date. Payroll-impacting changes require the applicable payroll decision. A worker already started or a concurrent source change requires review rather than silently applying pre-start semantics. |

## Required automated acceptance checks after approval

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

## Approval and implementation boundary

Approval to start this work is not approval of these business definitions.
Record explicit HR data-owner acceptance or requested revisions before changing
the master source contract or operational catalogue. A conversational approval
of this proposal is not a live case decision or execution authority.

Once the business definitions are accepted, publish a separately versioned
contract change with the approval reference, typed schemas, outcome-specific
tests, reconciled source/catalogue references and explicit coverage limitations.
The current draft leaves the runtime and source catalogue unchanged.

Still required for operational adoption: tenant-specific source bindings,
approved field mappings, evidence freshness rules, identity-resolution criteria,
effective-date rules, authoritative verification and immutable receipt storage.
No provider connection, worker creation, merge, amendment or permission change
is included in this proposal.
