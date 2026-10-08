# Governed synthetic fairness evaluation

This is the first fairness roadmap increment described in
`deliverables/Agentic_HRO_Business_User_Explainer.pdf` (pages 3, 4 and 6).
It does **not** establish a formal fairness, employee-appeals, statistical
assessment or legal-certification programme.

## What is in scope

The executable recommendation is the **Policy Assistant's constrained extract
selection**: support an exact supplied extract, or withhold it because the
evidence is insufficient, conflicting or injected. This tests the production
selector, not employee eligibility or the final end-to-end policy retrieval.
The source policy is explicitly fictional, not a published employer policy.

Business reviewers choose from four fixed pairs. Each pair keeps employment
duration, worker type, question substance, candidate extract and full policy
context constant. Only a fictional display name or synthetic pronouns change.
Names are proxy cues, not labels for inferred ethnicity. Reviewers must
explicitly confirm that the selected variation is irrelevant to the particular
recommendation. No acceptance outcome is automatically populated.

Other decision types—including case explanations, readiness, document findings,
employment decisions and candidate selection—remain untested. The current
catalog does not cover every withholding outcome or protected/proxy cue.

## Review before criteria

Open **UAT Test Center → Synthetic fairness evaluation**.

1. An organization owner/admin defines the actual recommendation scope,
   selects pairs and records the legitimate-fact/variation rationale.
2. Three distinct authenticated reviewers approve the scope: a business
   owner/admin, a currently verified HR-compliance authority, and a currently
   verified legal authority. Governance nominations alone do not qualify.
3. Only after those reviews may the business owner enter the expected outcome
   for each pair and its job-relevant rationale.
4. The same three reviewer roles separately approve the criteria revision.
5. An owner/admin explicitly starts the paired observation run. Approvals are
   rechecked before each model request and before results are persisted.

Scope changes clear criteria and approvals. Criteria changes clear criteria
approvals. Revoked/expired authority, changed membership lifecycle, rejection
and version conflicts block progress. Original receipts and past run evidence
remain in history; no real tenant receives fabricated specialist approval.
Fixture/synthetic-policy catalog changes invalidate scope review; configured
model, prompt or output-contract changes invalidate criteria review. Receipts
record their stage, revision and the corresponding version-bound digest.

## Observations and investigation

Each pair invokes the actual production extract selector twice through the
existing HRO AI budget/context boundary. The runner exposes no case reads,
registered-agent tools, ranking, profiling or workflow effects. Agent invocation
permissions are not widened. Context history continues to hold metadata, not
prompts or answers.

- **Observed match:** both variants match the reviewed expectation in this
  observation only.
- **Investigate:** recommendations differ, or either deviates from expected
  behavior. Equal but incorrect answers are still discrepancies.
- **Blocked:** a model request failed, was invalid, lacked current approval,
  or was interrupted. Missing output is never counted as a pass.

An HR-compliance reviewer records an open, remediation-required or explained
disposition with a rationale. This does not rewrite the original model output
or convert a discrepancy into a passed test. Scope/criteria must be revised and
reviewed for changed expectations. A running attempt blocks simultaneous runs
and edits. An interrupted attempt may be explicitly closed after ten minutes;
late responses cannot finalize a closed attempt. Recovery never automatically
repeats a model call.

## Evidence

The downloadable JSON includes scope/criteria revisions, human review receipts,
manual-evidence versus synthetic-model-observation provenance, fixed fixture
snapshots, requested and returned model identities, provider response metadata,
prompt version/digest, output contract version, synthetic policy/catalog version
and digests, both outputs, expected behavior, discrepancies, investigation
history, coverage, blocked attempts and unresolved differences.

Programme writes are version-fenced, tenant-isolated, and fingerprinted into
the existing protected audit trail. The programme retains at most 100 run
attempts; reaching that limit blocks new runs instead of deleting evidence.
Historical exports retain the fixture snapshots used by those runs.

## Limits and future expansion

Four pairs and one observation per variant do not establish population-level
disparity rates, intersectional coverage, stochastic reliability, legal
compliance or bias-free decisions. Model aliases may change; returned model
identities are recorded when available. No real protected-characteristic data
or employee facts are accepted by the runner.

Real-data fairness analysis requires a separately approved lawful purpose,
access controls and retention controls. Broader decisions, independent appeals,
sampling and outcome analysis need their own reviewed scope and implementation;
none are implied by this increment.
