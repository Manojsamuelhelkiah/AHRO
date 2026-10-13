# Workspace cleanup inventory — 2026-10-13

## Scope and outcome

Inspected the development application database `heliumdb`, schema `public`,
used by the unfiltered Super Admin organization listing. There were **41**
organization rows, not 45 as initially estimated in chat. Removed **8** verified
empty historical fixtures; **33** remain. No production database was changed.

No selector filter or administrator/member/demo authority rule was changed.
The extra retained rows remain visible to Super Admin, as required by the
existing cross-client access contract. Their presence does not grant ordinary
users memberships. No providers or remote storage were invoked by cleanup.

## Explicitly protected

| Workspace | Exact ID | Outcome |
|---|---|---|
| Demo Organization (the requested Demo Organisation) | `demo` | Retained unchanged |
| HCLTech | `org_654eb2bb-23cb-489a-9cc3-50faeddcfd3c` | Retained unchanged |

The transaction verified unique names/IDs, locked parents and dependent
relations, and checked hashes of all protected dependent rows before/after
deletion. Configuration, memberships, cases, documents, scenarios, audit rows,
and continuity records were unchanged. Only eight empty parent rows were
deleted; no child rows, Vault data, holds, or audit history were deleted.

## Removed — empty and independently attributable to fixtures

| Exact ID | Evidence |
|---|---|
| `candidate-security-b-30929-1788956777949-1295017a` | Candidate security suite's exact paired-ID, name, slug, and synthetic creator construction |
| `candidate-security-b-31145-1788956804554-e850958f` | Same construction, separate historical run |
| `uat-center-17834-1ca3f121-7948-4de2-bca7-e8182752b758-b` | Retired UAT suite's exact paired-ID, matching name/slug, and synthetic actor construction |
| `uat-center-17895-d7997dcb-a9be-452f-b4ac-d3f1bfc893c3-b` | Same construction, separate historical run |
| `uat-center-17947-fa054143-b925-40f8-b53b-6409459c9870-b` | Same construction, separate historical run |
| `uat-center-17991-9b68350d-7229-4f92-8135-b31ff12b0b09-b` | Same construction, separate historical run |
| `uat-center-18052-9dce03b2-6229-496f-8542-c5fbe6c4a4a5-b` | Same construction, separate historical run |
| `uat-center-18250-f545ce5c-e913-44ed-bb72-d5d24e5537a2-b` | Same construction, separate historical run |

Current source: `artifacts/api-server/src/routes/candidate-portal-security.test.ts`.
Historical source: the retired `src/lib/onboarding/uat-test-center.test.ts`,
recoverable through repository history using a search for `uat-center-`.
No retired UAT creation capability was restored. All eight rows had **zero**
dependent rows, including tenant columns without foreign keys and incoming
foreign keys from other schemas. Matching prefixes alone were not sufficient.

## Retained extras — substantive, protected, or uncertain

| Exact ID | Reason |
|---|---|
| `candidate-security-a-30929-1788956777949-1295017a` | Effect journal record retained |
| `candidate-security-a-31145-1788956804554-e850958f` | Effect journal record retained |
| `operational-a-5514-dd0608fe-8373-4e01-86fb-aae923e94c34` | Eight connectors and readiness policy retained |
| `operational-b-5514-dd0608fe-8373-4e01-86fb-aae923e94c34` | Eight connectors and readiness policy retained |
| `org_1d2cb115-44b7-4b76-95e4-f060204e15e9` | PolicySim workspace: audit entries/outbox/receipts/head and settings |
| `org_36bf0245-7361-4774-a08b-0433450334da` | PolicySim workspace: audit entries/outbox/receipts/head and settings |
| `org_82636055-ec54-49cc-ab61-efb3d77c4a46` | PolicySim workspace: empty but uncertain creator provenance; its name is not authorization to delete |
| `isolation-a-8377-1789400571617` | Three protected audit entries, receipts/outbox/head, and settings |
| `isolation-a-8493-1789400649947` | Three protected audit entries, receipts/outbox/head, and settings |
| `uat-center-17834-1ca3f121-7948-4de2-bca7-e8182752b758-a` | Membership, three authority assignments, governance and requirements |
| `uat-center-17895-d7997dcb-a9be-452f-b4ac-d3f1bfc893c3-a` | Membership, three authority assignments, governance and requirements |
| `uat-center-17947-fa054143-b925-40f8-b53b-6409459c9870-a` | Membership, three authority assignments, governance and requirements |
| `uat-center-17991-9b68350d-7229-4f92-8135-b31ff12b0b09-a` | Membership, three authority assignments, governance and requirements |
| `uat-center-18052-9dce03b2-6229-496f-8542-c5fbe6c4a4a5-a` | Membership, three authority assignments, governance and requirements |
| `uat-center-18250-f545ce5c-e913-44ed-bb72-d5d24e5537a2-a` | Membership, authority, requirements and retained dispatch marker |

The remaining **16** rows all have the exact base
`audit-it-7253-90ee1205-a3b3-49b7-a631-c4b9759d2bee-` plus one of the suffixes
below. This is a compact inventory notation, **not a deletion predicate**.
They trace to the protected audit integration suite and remain protected even
when synthetic.

| Suffix | Retention reason |
|---|---|
| `history-survives` | Approval history and sensitive lifecycle policies |
| `candidate-cleanup-hold` | Candidate case/access records, sensitive policies, governance and readiness evidence |
| `candidate-exchange` | Candidate case/access records, audit chain/receipts, policies and readiness evidence |
| `guardrail-throttle` | Twenty guardrail events, protected audit chain/receipts and settings |
| `anchor-outbox` | Protected audit chain/outbox/receipts and settings |
| `configured-client-adapter` | Two retained provider/configuration settings |
| `provider-generation-transition` | Protected audit chain/outbox/receipts and settings |
| `missing-provider-adapter` | Protected audit chain/outbox and settings |
| `anchor-timeout-fence` | Protected audit chain/outbox and settings |
| `anchor-fence` | Protected audit chain/outbox/receipt and settings |
| `anchor-unverifiable-drill` | Protected audit chain/outbox/receipt and settings |
| `archive-generation-race` | Two retained configuration settings |
| `stale-head-race` | Protected audit chain/outbox and settings |
| `provider-context-race` | Protected audit chain/outbox/receipt and settings |
| `anchor-ordered-checkpoints` | Protected audit chain/outbox/receipts and settings |
| `anchor-ordered-holds` | Retained audit outbox/receipts and settings |

No additional genuine clients or migration tenants were found in this
inventory. That observation does not authorize future removal of other rows.
There was no `platform-audit` organization row; case-less audit records and
any future platform-audit workspace are explicitly excluded from cleanup.

## Recovery and maintenance

`pnpm --filter @workspace/api-server workspaces:inventory` is read-only.
The local `clean-disposable-workspaces.mjs --apply <IDs...>` command accepts
only the reviewed manifest IDs, never patterns, arbitrary names, or all
workspaces. It rejects production process mode, protected IDs, changed
provenance, and any dependent row. Missing already-cleaned IDs are a no-op.

Private recovery material is in
`generated-artifacts/private-workspace-cleanup/recovery-approved-eight.json`
(directory mode 0700, file mode 0600, excluded from Git and deployments).
It contains only the eight deleted parent rows and preservation digests.
Do not expose or publish it: join-code hashes are private.
Recovery requires a trusted local database operator to parameterize an
`INSERT` of those exact parent fields inside a transaction, checking that the
IDs/slugs/hashes are still unclaimed first. Snapshot recovery and transaction
rollback are covered by the maintenance tests. The sanitized detailed
before/after counts are saved beside it; this document is the retained
non-sensitive outcome inventory.

## Recurrence safeguards

The browser harness already owned a disposable schema; none of the observed
everyday rows matched its navigation-fixture creators. It was not blamed for
these historical leftovers. Its historical migrations did contain literal
`"public"` foreign-key references, which bypassed the intended search path.
Test-only replay now rewrites those references into the owned schema and
rejects every outgoing cross-schema foreign key.

The proven candidate security, operational requests, and organization
isolation suites, plus workspace bootstrap/membership suites, now run in
owned disposable schemas. They reject direct shared-schema invocation.
Their parent runner drops the entire owned schema on success, assertions,
and ordinary termination; browser teardown likewise drops every owned
organization, including those created by the real workspace API. No public
deletion endpoint or weakened append-only protection was added.

The retired UAT fixture suite is no longer executable. Broad isolation of
other API suites and reclamation after an uncatchable kill remain outside
this maintenance scope.

## Verification results

- API typecheck passed.
- 51 affected API assertions passed across candidate security, operational
  requests, tenant isolation, workspace membership and Demo bootstrap.
- Three cleanup tests passed: protected/unverified/broad rejection,
  substantive/hold-dependent rejection, transaction rollback, private snapshot
  recovery, repeat cleanup, and disposal after a deliberate assertion failure.
- Both `client-workspace-navigation.spec.ts` journeys passed in the isolated
  harness, covering creation, joining, switching, keyboard navigation, public
  Demo rejection, ordinary membership isolation and Super Admin listing.
- The additional administrator expiry/renewal/downgrade journey passed.
  The additional `admin-case-read.spec.ts` “verified administrative reads”
  journey times out at `/api/test/admin-read/boundaries` with concurrent page
  activity. A direct authenticated request to that fixture probe returned
  correct scoped reads and `professional: false`, `mutated: false`, but the
  browser timeout remains unresolved and is not recorded as a pass.
- The everyday organization-ID list was checked again after successful and
  failed isolated runs: exactly the same 33 retained IDs. The two protected
  workspaces still exist under their original IDs and names.
