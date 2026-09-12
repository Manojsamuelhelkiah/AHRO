# Early-tenure outcome reporting contract

Task 254 reporting is intentionally separate from early-tenure workflow
completion. A reminder, task assignment, calendar invitation, policy check-in,
or agent-generated statement is **not** outcome evidence.

## Evidence records required from the tenure backend

Reporting owns two append-only, tenant-scoped evidence relations and their
authorized writers. KPI/reporting code only reads the safe projection below.

### `onb_early_tenure_survey_responses`

Required columns: `id`, `organization_id`, `case_id`, `survey_kind`,
`voluntary`, `score`, `submitted_at`, `provenance`, `source_connector_key`,
`authority_assignment_id`, `authority_assignment_revision`,
`evidence_reference`, `recorded_by_user_id`, and `created_at`;
`(organization_id, case_id)` references `onb_cases`.

- `survey_kind` is `onboarding-30-day`.
- `score` is an integer from 0 through 10.
- Only `voluntary = true` responses are usable.
- `provenance` is `trusted-provider` or `human-authorized`; simulated, demo,
  offline, unknown, or absent provenance is unusable.
- A trusted-provider response must identify the approved survey source. A
  human-authorized response must retain the verified authority reference in
  the source writer, rather than relying on a request role.
- A case contributes at most one response: the most recently submitted valid
  response as of the report timestamp.
- A response is usable only where the same case has one trustworthy actual
  employment-start record and `submitted_at` is at least 30 days after it.
  Pre-join/Day-1 records cannot be relabelled as a 30-day result.

Raw response text, respondent identity, survey token, free-form comments, and
individual scores are never returned by analytics or export routes.

### `onb_employment_outcome_evidence`

Required columns: `id`, `organization_id`, `case_id`, `actual_joined_at`,
`employment_status`, `effective_at`, `observed_at`, `provenance`,
`source_connector_key`, `authority_assignment_id`,
`authority_assignment_revision`, `evidence_reference`,
`recorded_by_user_id`, and `created_at`; the same tenant-and-case foreign key
is required.

- The authoritative source is either a trusted `hris` connector or an
  explicitly authorized human source with a current authority assignment
  recorded by the writer.
- `actual_joined_at` is a date/timestamp of actual employment start, never the
  planned `onb_cases.joining_date`.
- Usable statuses are `active`, `terminated`, or `unknown`. A termination
  needs its dated `effective_at`.
- Simulated/demo/unknown/offline evidence and invalid or future dates are not
  evidence. Conflicting or incomplete evidence remains unknown.

For 0–90-day attrition, an early dated termination counts as attrition. A
non-attrition observation is usable only when it proves employment through
the 90-day anniversary (or a termination is dated after that anniversary).
An active status observed earlier is unknown, not retention.

## Authorized evidence write endpoints

The frontend may use only the human-authorized routes below. Both require the
normal authenticated tenant context plus a current, server-verified
`hr-compliance-approve` authority scoped to the case. The authority assignment
ID and revision are resolved by the server and cannot be supplied by the
caller. Both routes are append-only. The survey route returns `204 No Content`;
employment returns `201 {"evidenceId": number}` only, so a later correction can
refer to a prior termination without exposing evidence detail. There is no
individual-evidence read endpoint.

For a human write, the server first verifies current authority and then writes
an immutable, server-authored authority receipt containing the exact grant ID,
revision, validity window, scope, role, and case/site/jurisdiction context.
KPI loading validates that receipt rather than a mutable current grant, so a
subsequent authority revocation cannot silently rewrite a previously valid
historical outcome.

`POST /api/onboarding/analytics/outcome-evidence/surveys`

```json
{
  "caseId": 42,
  "surveyKind": "onboarding-30-day",
  "voluntary": true,
  "score": 0,
  "submittedAt": "2026-08-01T10:00:00.000Z",
  "evidenceReference": "restricted-survey-record-reference"
}
```

`score` is an integer 0–10 and `submittedAt` cannot be future-dated. The API
also requires a single trustworthy actual joining record already recorded for
the case and a submission at least 30 days later. It rejects any
non-voluntary survey, other survey kind, or caller-supplied trusted-provider
provenance.

`POST /api/onboarding/analytics/outcome-evidence/employment`

```json
{
  "caseId": 42,
  "actualJoinedAt": "2026-05-01T09:00:00.000Z",
  "employmentStatus": "terminated",
  "effectiveAt": "2026-06-15T09:00:00.000Z",
  "observedAt": "2026-06-16T09:00:00.000Z",
  "evidenceReference": "restricted-hr-record-reference"
}
```

`employmentStatus` is `active`, `terminated`, or `unknown`. `terminated`
requires `effectiveAt`; other statuses reject it. The actual join must be no
later than the observation, and a termination effective time must be between
those timestamps. The frontend must not use planned joining dates.

If a later `active` HR correction reverses a previously recorded termination,
send `correctsEvidenceId` as that prior termination's evidence ID. Without
this explicit link, a termination followed by active status remains unknown
rather than being reported as retained. A correction must be observed after
the referenced termination; every outstanding termination needs its own later
explicit correction before retention can be calculated.

Trusted-provider rows are not accepted from a browser. A future authenticated
provider adapter calls the exported reporting writer only after it has verified
an active, trusted registry connector. Employment specifically requires `hris`;
survey evidence additionally requires a connector explicitly authorized for
the `voluntary onboarding survey/eNPS` capability. No such survey adapter is
currently registered, so trusted-provider survey writes fail closed. This
prevents an HTTP caller or an unrelated HRIS/LMS connector from presenting
claimed provider data as survey evidence.

## KPI response contract

`GET /api/onboarding/analytics/outcome-kpis` remains a tenant-scoped aggregate
endpoint. The selected period filters case creation for continuity with the
existing dashboard; it is not an employment-start cohort. Non-sensitive
metrics return `eligibleCount`, `sampleSize`, and `unknownCount`; `value: null`
must be rendered as unavailable, never zero. For eNPS and attrition, the
ordinary endpoint also suppresses value, status, and all count fields below
the five-observation privacy floor.

The eNPS metric uses the standard calculation:

`100 * (promoters (9–10) - detractors (0–6)) / usable voluntary responses`.

It is only published when at least **5 distinct responses** meet the contract.
Below that threshold, the result is `insufficient-data` with a null value.
The threshold is a privacy floor and is independent of the general dashboard
small-cohort suppression rule.

## Privacy-scoped analytics export

`GET /api/onboarding/analytics/outcome-kpis/export?format=json|csv` is
restricted to a current tenant owner/admin **and** a server-verified
privacy/legal governance assignment. It returns aggregate KPI rows only:

- no worker, case, event, source-record, survey, authority, join-date, or
  employment-status identifier;
- values and counts for any metric below the export cohort floor of 5 are
  suppressed;
- all rows contain the report timestamp, metric definition, a
  non-inferential `insufficient-data` status when suppressed, and an explicit
  suppression reason where relevant;
- `integrationState` is `pending-powerbi`; this is an export contract, not a
  claim that a Power BI connector has been activated.

The frontend should use the response's `suppressed` and
`publicationStatus` fields, not attempt to derive a result from counts.

## LMS and calendar activation requirements

The existing connector registry contains `lms` and `calendar` requirement
entries. They are activation-pending registry records, not integrations:
neither entry has a provider adapter, credential, polling loop, webhook, or
simulated completion. Before activation, an accountable owner must record
approved vendor, purpose/field mapping, least-privilege scope, privacy and
retention review, and authenticated sandbox/source confirmation. Until then,
learning and calendar workflow work remains human-owned and any outcome
without qualifying evidence remains unknown.