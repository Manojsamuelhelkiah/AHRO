# Standard onboarding provider contracts

This package records the **contract and configuration boundary**, not a live
vendor integration. It contains no credentials and does not make HTTP calls.
Credentials, when a separately reviewed transport is introduced, remain in
server-side Replit Secrets.

## Oracle Fusion Cloud HCM

- **Source of truth:** worker identity and active work relationship.
- **Documented resource:** Oracle HCM REST Workers / Work Relationships:
  <https://docs.oracle.com/en/cloud/saas/human-resources/farws/api-workers-work-relationships.html>.
  The documented child resource is
  `GET /hcmRestApi/resources/{version}/workers/{workersUniqID}/child/workRelationships/{PeriodOfServiceId}`.
- **Configurable mappings:** `PersonId`, `PersonNumber`,
  `PeriodOfServiceId`, and the tenant's employment status value. Active status
  is never inferred from an arbitrary label; administrators configure the
  exact accepted values.
- **Fixture contract:** an `employee` or `work-relationship` observation has
  a stable source record ID, source-observed timestamp, evidence reference,
  and bounded non-sensitive field snapshot. `ORACLE_HCM_WORK_RELATIONSHIP_FIXTURE`
  is a shape-only isolated test fixture. Unknown states are rejected.

## ServiceNow

- **Source of truth:** ServiceNow service request/request-item state. This
  product does not replace ServiceNow as system of record.
- **Documented API family:** Service Catalog API:
  <https://www.servicenow.com/docs/r/api-reference/rest-apis/c_ServiceCatalogAPI.html>.
  The target is a configured catalog-item order path plus configured request
  state retrieval; table and state values vary by instance/release.
- **Configurable mappings:** request number, sys_id, requested-for, and
  submitted/in-progress/fulfilled/failed state sets. An unrecognised state
  cannot become fulfilled.
- **Fixture contract:** a `service-request` carries request identity,
  source-observed timestamp, evidence reference, and its normalized state.
  `SERVICENOW_SERVICE_REQUEST_FIXTURE` is shape-only test data, not a provider
  response or sandbox proof.

## Injectable transport and durable write boundary

`standard-provider-adapters.ts` implements no default network client. A
server-only caller must inject `ProviderHttpTransport`; this makes Oracle and
ServiceNow response contracts testable offline and prevents accidental
browser-side credential use.

- `readOracleHcmWorkRelationship` calls the documented Oracle work
  relationship resource and returns the normalized source ID/status only when
  all configured field mappings resolve.
- `readServiceNowRequest` calls the configured ServiceNow request table via
  its Table API and returns a normalized submitted/in-progress/fulfilled/failed
  state only when the instance mapping recognizes it.
- `submitServiceNowCatalogRequest` and `submitOracleHcmWorker` construct
  documented write requests, but the production execution boundary is
  hard-disabled. They cannot make a remote mutation while there is no
  non-injectable database-backed authority/lifecycle composition.

`executeJournaledRemoteWrite` fails before transport. The separately named
`executeJournaledRemoteWriteForTest` is fixture-only and accepts injected
journal/authority doubles to verify idempotency and ambiguity handling; it is
not a production composition. A future production writer must use the durable
effect journal and a non-injectable database authority/lifecycle boundary.
An attempted request is treated as potentially effective before awaiting
transport, so timeouts/offline failures become manual-repair outcomes unless a
provider-specific response proves no effect.

## Deliberately unselected providers

BGV/document follow-up, payroll, and benefits remain **Not configured**. The
status API exposes a different manual owner and independent normalized manual
work for status, evidence, consent, cutoff, reconciliation, and failure:

| Workstream | Accountable owner | Required decision before provider configuration |
| --- | --- | --- |
| BGV | HR compliance / BGV owner | vendor, jurisdiction/consent, clearance/adverse/no-response, retention and escalation |
| Payroll | Payroll owner | provider, eligibility, cutoff, reconciliation, recovery, authority and privacy |
| Benefits | Benefits owner | administrator, eligibility/consent, cutoff, carrier reconciliation and recovery |

No universal BGV/payroll/benefits endpoint is assumed and no enrollment or
clearance is claimed from a simulated value.

## Safety and truthfulness

`GET /onboarding/standard-providers/status` requires organization owner/admin
and reports configuration separately from source observations. A
`source-read-confirmed-not-live-evidence` state means the server read a
tenant-pinned provider record whose configured case-identity field exactly
matched the immutable case email. It is still not live readiness evidence and
cannot satisfy access, asset release, final approval, or historical KPI gates.
Legacy operator observations are labelled
`legacy-operator-observation-unverified`, never source-confirmed. Evidence
references, source IDs, state, and timestamp are additionally redacted unless
the viewer has current all-class sensitive authority for the linked case.

An active Oracle work relationship can additionally become a **trusted HRIS
attestation** only inside the same full authority/lifecycle/governance fence,
when the server classifier confirms the provider identity and provider
effective-start date against the currently locked case identity and joining
date. Configuration strings, sandbox receipts, and manual approval references
are never evidence of HRIS activation. This does not enable provider writes or
change the provider status endpoint's `liveReadinessEligible: false` contract.

The refresh route accepts only case-scoped provider source IDs; it does not
accept a raw state, narrative evidence reference, or arbitrary field snapshot.
It requires a case ID, lifecycle + governance provider boundary, and current
identity, medical, payroll, and BGV authority. Credentials, base URLs, and a
deployment `*_ORGANIZATION_ID` binding are server-side Replit Secrets. The
binding must exactly match the requested organization before any remote read;
the returned identity must also match the case before persistence.
The lifecycle inventory includes both provider source-record rows and
case-linked standard-intake event references. Retention minimization preserves
their row IDs, tenant/case linkage, and idempotency keys but replaces source
identities, evidence references, fingerprints, snapshots, and actor text.

All contracts report `remoteDispatchEnabled: false` and
`liveReadinessEligible: false`. Before any future dispatch can be added, it
must pass the durable effect journal with its unchanged idempotency key,
current authority/audit/privacy/governance gates, provider configuration,
authenticated sandbox evidence, explicit operator approval, and a separately
reviewed transport implementation. Ambiguous non-idempotent outcomes remain
manual-repair work rather than retry candidates.