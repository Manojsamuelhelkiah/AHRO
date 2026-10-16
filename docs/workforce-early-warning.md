# Workforce early-warning foundation

## Talent at Risk examples

The approved Demo workspace contains three retention examples (high, moderate
and low risk) on exact existing Employee Changes source identities. Analytics
shows their 90-day values, dated context and supportive follow-ups. Persisted
review records appear in Analytics, Cases and the dashboard, and use the source
S-reference without additional sample labels. The high-risk review is critical.
The initial owner is the catalogue's HR team; a permitted administrator can take
ownership through the ordinary review editor.

These values live in a separate `riskExamples` response field and settings key,
never in real model assessments or model validation records. They confer no
permissions and trigger no outreach, workflow activation or employment effects.
Only exact authorized Demo sources qualify; identity/contact changes, changed
source revisions and expiry remove their indicators. Other subjects stay Not
assessed. Resume integrity is unchanged.

Population is an explicit development-only additive operation:

```
NODE_ENV=development SEED_SCRIPT=src/scripts/provision-workforce-risk-examples.ts pnpm --filter @workspace/api-server exec node run-seed.mjs
```

The development post-merge setup runs this idempotent command with
`WORKFORCE_EXAMPLES_IF_READY=true` so examples reach the main workspace when the
approved Demo source inventory exists. In this optional setup mode, missing Demo
or source inventory produces an explicit skipped status without blocking normal
reconciliation. The explicit command above still rejects missing sources.
Neither mode creates source cases, overwrites prior work or reopens resolved
reviews. It is not part of application startup or publishing.

Indicator expiry removes the coloured value, not the review or its history.
Review visibility continues to require current source permissions and the exact
eligible Demo identity, independently of the indicator's expiry or source revision.

## Available now

- **Analytics → Talent at Risk and Resume Integrity Review**: model connection
  status, accessible red/amber/green legend, and **Not assessed** indicators for
  subjects without a current result or an approved example.
- Source coverage is the current client's permitted existing HRO cases. It is not
  an employee master, a cross-client employee index or a longitudinal training set.
  Similar names or email addresses do not establish that two cases are one person.
- Current client administrators can create explicitly **human-originated** review
  cases, with a source case, reason, recommended follow-up, priority, human owner
  and due date. This does not set a prediction or an authenticity verdict.
- Open and in-progress reviews appear on Cases, the dashboard, and Action Center's
  Needs Attention view. Action Center counts each persisted review once, sorts
  critical human priorities first then due date, and links to Analytics and the source case.
  Its shared case-family and job-context filters use the source's recorded attributes;
  unknown safety/site context does not match an explicit filter.
  Review discovery loads independently of other Action Center sources, with retry
  and no cached disclosures after a failed or denied refresh. Caches are scoped to
  client, authenticated account and session; review writes invalidate all review views,
  and other sessions refresh every 30 seconds.
  Analytics holds the full list
  and review history, including resolved and dismissed cases.
- Reviews support open, in-progress, resolved and dismissed states. Closure needs
  a recorded outcome. No email, model call, employment decision or source workflow
  operation is triggered by creating or editing a review.
- Duplicate open work for the same source case and review kind is prevented.
  Concurrent writes use server-side revision preconditions and client-scoped
  transactions. Stale editors receive a conflict instead of overwriting changes.

## API and storage

The OpenAPI contract defines:

- `GET /api/workforce-insights` (optional `caseType`, `workforce`, `safetyCritical`,
  `siteExposure` discovery filters; filters do not change storage or lifecycle)
- `POST /api/workforce-insights/reviews`
- `PATCH /api/workforce-insights/reviews/{reviewId}`

Authentication and tenant admission precede these routes. Access requires live
client administrator rights and current source-case flow, profile and notes
permissions. Owners must be current administrators in the same client (or the
current verified platform administrator). Responses are not browser-cacheable.
There is no public model-result submission or browser-controlled model approval.

Reviews and future assessment structures use a versioned tenant settings aggregate.
They retain record-level history; no record deletion endpoint exists. Capacity
limits fail explicitly without pruning audit history. At high volume this storage
should move to indexed assessment/review tables with a deliberate migration.

## Future model integration contract

The server-side pure adapter in `src/lib/workforce-insights.ts` defines and tests:

- Separate, versioned model identities for attrition and resume integrity.
- Validation reference, defined prediction period, evidence revision, assessment
  timestamp, expiry, factors and recommended actions.
- Unknown status for a disconnected, unvalidated, mismatched or stale assessment.
- A current validated red result creating one critical human review, or linking
  the new assessment to the existing open review.
- Idempotent result replay and rejection of older results.

**This adapter is not connected to a model service or ingestion worker.**
The shipped GET response intentionally returns no active model assessments.
Connecting a model requires a trusted integration, a tenant-scoped persistence
boundary, live source authorization and a reviewed validation/deployment process.
The model's source revision must cover every feature dependency, including changes
in linked records; a case's update timestamp alone is not a feature-set fingerprint.
Passing a fixture test is not model validation or fairness certification.

## Before enabling predictions

### Talent at Risk

Establish a stable employee identity and lawful, purpose-appropriate source data,
dated longitudinal features and observed voluntary-departure outcomes. Choose a
prediction horizon and use temporal holdouts that prevent future-outcome leakage.
Evaluate precision, recall, precision-recall AUC, calibration, cohort performance
and operational alert volume. Monitor drift and stale evidence. Choose an ensemble
only if its measured performance justifies it; optional symbolic rules can govern
evidence eligibility and referral, not turn a weak model into a reliable one.

Recommendations should support the employee (for example, resolving a delayed
mobility request). A predicted likelihood does not establish intent to leave.

### Resume Integrity Review

Use independently verified discrepancy outcomes, not AI-writing style or language
proficiency as fabrication labels. A mismatch is a request for clarification and
source verification, not established fraud. Evaluate false accusations and missed
discrepancies, give candidates a correction path, and record the human resolution.

For both capabilities, separately review feature suitability, proxy risks, relevant
group performance, explanation fidelity and model limitations. Do not promise
“bias-free” decisions, and do not automate rejection, discipline or termination.
