# Standard onboarding intake contract

The application does not implement or claim a native ATS connector. A Talent
Acquisition (TA) middleware can submit accepted-offer and scheduled-preboarding
events through the authenticated source contract below. The source system
remains the owner of the offer and acceptance artifact.

## TA middleware endpoint

`POST /api/onboarding/ta-intake/events`

Configure one tenant-pinned source per middleware identity in the deployment
secret `TA_INTAKE_SOURCES_JSON`; `sourceId` values must be globally unique:

```json
[
  {
    "organizationId": "tenant-id",
    "sourceId": "ta-production",
    "secret": "at-least-32-character-secret-kept-out-of-payloads",
    "label": "Approved TA middleware"
  }
]
```

The caller supplies these headers:

| Header | Meaning |
| --- | --- |
| `x-ta-intake-source` | Configured `sourceId` |
| `x-ta-intake-timestamp` | Unix epoch milliseconds, maximum five minutes old |
| `x-ta-intake-signature` | Lowercase SHA-256 HMAC described below |
| `x-organization-id` | Optional, and must equal the source's configured tenant |

Calculate the signature with the configured source secret over:

```text
ta-onboarding-intake:v1\n
POST\n
/api/onboarding/ta-intake/events\n
<sourceId>\n
<timestamp>\n
<canonical JSON request body>
```

Canonical JSON recursively sorts object keys, omits `undefined` values, and
retains array order. Requests with unknown sources, stale timestamps, tenant
mismatches, or invalid signatures are rejected. The configured source, not a
payload field, establishes source identity and tenant scope.

## Event body

```json
{
  "events": [
    {
      "sourceEventId": "immutable-source-event-id",
      "eventType": "accepted-offer",
      "acceptanceEvidenceReference": "source-system-reference-only",
      "occurredAt": "2030-01-01T10:00:00Z",
      "person": {
        "personKey": "stable-source-person-key",
        "workerName": "…",
        "workerEmail": "…",
        "hireType": "external-fte",
        "workerCategory": "employee",
        "role": "…",
        "department": "…",
        "geography": "…",
        "legalEntity": "…",
        "managerName": "…",
        "recruiterName": "…",
        "joiningDate": "2030-01-15",
        "workforceContext": { "workCountry": "…" }
      }
    }
  ]
}
```

`eventType` is either `accepted-offer` or `scheduled-preboarding`. An
`acceptanceEvidenceReference` is mandatory for both: it is a source-system
reference, not the artifact itself and not free-form offer content.

Each source event has a tenant/source/event-id unique record, its own
normalized intake snapshot, resolved workforce context, and resolved policy
snapshot. A valid event produces one held onboarding case and immutable
checklist snapshot. The route does **not** start orchestration, grant
authority, send candidate messages, or dispatch a provider.

### Intake-register data minimization

The linked onboarding case is the governed record for worker name, email,
phone, manager, recruiter, and other case facts. The source-event register
does **not** copy those facts: its intake snapshot holds only event metadata,
identity/evidence fingerprints, and a data-handling marker. Its policy copy
holds only profile/version/classification identity; the full approved policy
remains on the case. The workforce-context copy is a bounded operational
allowlist (job, location, employment, environment, hazards, licenses, and
batch fields); arbitrary JSON, `accessibilityNeeds`, and
`languagePreference` are rejected. Those special/sensitive details must use
their authorized workflows. The opaque evidence reference is separately
stored and requires the scoped HR authority described below.

If a linked case is deleted, the source-event row becomes a tombstone: the
case link is cleared, the evidence reference and all register snapshots are
minimized, and only tenant/source/event identity plus payload fingerprint
remain to fence a later replay. A tombstoned replay is blocked and never opens
a new case. The shared sensitive-lifecycle implementation also minimizes the
linked intake row during governed case minimisation; its provider lifecycle
owner maintains that paired behavior.

For `scheduled-preboarding`, `joiningDate` must be a valid date strictly in
the future. The service persists an HR-review due timestamp at midnight UTC on
the preceding calendar day. Its shared durable heartbeat creates a keyed
review queue at that due point and retries that handoff after a crash. A
scheduled case cannot be manually released early, and it cannot be started
late on or after its joining date.

## Staff preview and recovery

Authenticated tenant staff can use:

* `POST /api/onboarding/standard-intake/preview`
* `POST /api/onboarding/standard-intake/events`
* `POST /api/onboarding/standard-intake/replay`

with the same `{ "events": [...] }` body. The Control Tower's **Trusted
Intake** panel uses these endpoints and identifies the source as its
authenticated user; it is not a substitute for TA middleware credentials.

Preview validates each row, detects active-case duplicates, and resolves the
same per-person workforce policy used at commit. Commit is row-isolated:
successful rows remain durable when other rows are invalid or blocked and the
response is `207 Multi-Status` for mixed results. Replay the original event
IDs after correcting unresolved rows. Exact retries reconcile to the existing
case; reuse of an event ID with changed evidence or person facts is a conflict.
An active case for the same normalized email is recorded as
`duplicate-active`, never silently duplicated.

## Staff activation and Gate A

An owner/admin tenant role **and** a current, case-scoped
`hr-compliance-approve` authority are required to review the opaque source
evidence at:

`GET /api/onboarding/cases/{caseId}/standard-intake-evidence`

and explicitly activate a held case at:

`POST /api/onboarding/cases/{caseId}/standard-intake/release`

Activation is tenant-scoped, dispatch-locked, lifecycle-gated, and rejects a
pending policy rebase. Its persisted release marker is recovered by the shared
heartbeat if the detached orchestration starter dies. It changes only the held
case to the existing orchestration entry state. For pathways requiring Gateway
A, the normal engine then creates the existing authority-bound HR/compliance
approval; release does not complete or bypass that gate. The Gate A panel shows
the restricted TA acceptance-evidence reference and instructs the authorized
reviewer to verify it in the approved TA source before using the existing
dedicated confirmation. For this trusted-source path the engine does not send
a redundant "please accept" email; the source reference is still not itself an
authority grant or a completed Gate A.

Database migration `0065_standard_intake_scheduled_activation` adds durable
scheduling metadata to the already-applied tenant-scoped source-event register.
Apply it through the reviewed migration workflow before enabling any middleware
source configuration.