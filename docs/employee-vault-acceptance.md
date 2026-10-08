# Employee Vault: synthetic acceptance and production prerequisites

Processing approval is country-specific, not global. Each upload records the
explicit approved jurisdiction and policy revision; checks, scanner disclosure,
signed-result intake, owner downloads and employer reuse require that same live
approval. A source's supported countries do not expand privacy approval. Legacy
documents without a recorded jurisdiction remain unavailable, never backfilled
from today's policy. This release has one operator-approved processing country;
additional countries require separately reviewed configuration and new uploads.

Identity-only proof is never full BGV. This release matches typed check kinds,
jurisdiction and freshness against approved employer requirements; unsupported
additional coverage criteria fail closed rather than being ignored. Newer
authenticated adverse/inconclusive outcomes retire older clearances, and
delayed callbacks cannot restore them. Conflicting equal-date outcomes require
fresh evidence rather than selecting a clearance by arrival order.

The 30-file/100MB reservation quota includes replaced and deletion-pending files
until private cleanup confirms deletion. Invitations or declines without
consumption do not reopen HR approval; invalidating a live receipt does so once.

## Product boundary

Employee Vault is a separately registered web artifact at `/employee-vault/`.
Its public landing, `/sign-up`, and `/sign-in` routes do not require an employer
invitation. `/dashboard` and `/requests/:id` require a Clerk-authenticated
employee. Registering/signing in creates no HRO organization, membership,
employer administration privilege, or professional verifier authority.

The `EV-…` identifier is an opaque reference, **not a credential**. There is no
employee directory, email matching, public document route, or ID-to-profile
lookup. Requests have non-authorizing random links. The signed-in employee
asserts that the request concerns them; an authorized employer separately
confirms their identity against the case. An unrelated employee clicking a link
cannot become the candidate by knowing an ID or matching an email.

HRO owners can turn consumption on/off in Settings. The default is **off**.
Owners are not thereby authorized to read BGV/medical/identity/payroll records,
approve governance requirements, issue verification results, or dispatch
providers. Disabling consumption invalidates active reuse and closes old
requests; re-enabling does not revive old grants. Employee accounts remain.

## Truthful unavailable states

No commercial verifier was selected or enabled by this release. No production
privacy/processor/scanner/issuer approval is supplied by the migration.
The landing and account remain accessible, but unapproved private processing
blocks uploads. A configured storage processor can accept quarantined uploads
even when a scanner is unavailable; such files cannot be downloaded or reused.

Uploads, malware clearance, authenticated login, email verification, consent,
and an issuer's registration are **not BGV completion**. Only a current complete
set of authenticated source results, employee consent, employer case binding,
applicable approved requirements and a dated consumption receipt satisfies BGV.
Partial, adverse, inconclusive, expired, replaced or revoked evidence does not.
No automated adverse employment decision is made.

## Provisioning approved prerequisites

This is an operator-reviewed provisioning boundary, not a generic admin override.
Do not insert production approvals from the synthetic tests. A production launch
requires accountable privacy/security/legal approval with source references,
appropriate country/processor arrangements, private App Storage, a real approved
private malware scanner, and the project's protected-audit and production safety
checks. Independent employee audit/retention operating procedures must also be
approved; a local access log is not an independent external audit certification.

1. Review and provision the `independent-vault` processing policy through the
   operator's controlled database/configuration process: positive policy revision,
   actual employee-facing privacy notice, jurisdiction, expiry, storage and scanner
   approval, document retention days and maximum receipt retention days. Record
   the accountable approval reference. Employees acknowledge the exact notice
   revision when reserving an upload; changed revisions require renewed review.
   Inventory applicable document holds using `hold_until` before changing,
   replacing or deleting protected documents.
2. Configure the existing private scanner adapter (local ClamAV Unix socket or
   authenticated TLS endpoint). Never substitute a browser status, demo check,
   public URL, transport error or timeout for `clean`. Readiness without an actual
   working scanner is not sufficient. Run clean/EICAR/unavailable/timeout and
   byte-tampering drills using approved synthetic files before real collection.
3. Contract and approve the actual authoritative issuer(s) separately. Register
   their pinned **Ed25519 public keys**, verified issuer identity, approved kinds,
   jurisdictions, expiry and approval references through controlled provisioning.
   Protect and rotate issuer private keys outside this application. Tenant owners,
   employees and ordinary HR users have no issuer-configuration/status override.
4. Adopt the employer's **all-required-checks** policy in the existing Governance
   decision register, with the normal independently verified legal reviewer and
   source-backed review. For jurisdiction `IN`, the key is
   `employee-verification-requirements:IN`; its proposed value has the typed shape:

   ```json
   {
     "jurisdiction": "IN",
     "checks": ["identity", "criminal", "employment", "education"],
     "maxAgeDays": 90,
     "governanceRuntime": {
       "domain": "legal",
       "impactedWorkflows": ["background-verification", "it-identity-access"]
     }
   }
   ```

   This is an **illustrative shape**, not a default or legal recommendation.
   Use every employer-required supported check, applicable country/state, and
   actual approved freshness. Unsupported requirements mean Vault reuse is not
   suitable; retain the employer's normal checks. An identity-only set never
   satisfies a policy requiring additional checks. Cases must explicitly adopt
   the reviewed revision through the existing audited governance rebase.
5. Retain the existing acceptance, class-specific sensitive lifecycle policies,
   effective access permissions, specialist authority, protected audit and final
   HR approval prerequisites. Employer receipt retention is capped by both the
   independent approved maximum and the applicable approved employer BGV policy.
   Active employer BGV/case holds prevent receipt minimization.

Configuration approval is not evidence that a provider was called. There is no
unspecified automatic verification dispatch in this release. A future concrete
provider adapter must use the existing governance dispatch boundary and durable
effect journal, obtain an explicit authorized processing/disclosure scope and
never replay ambiguous non-idempotent effects.

## Provider-neutral authenticated result contract

The generated OpenAPI contract exposes `POST /api/vault/source-results`.
It authenticates the **source signature**, not a Clerk/admin role or a bearer
status label. A result contains submission ID, employee profile ID, issuer ID,
kind, jurisdiction, exact `{id, revision, sha256}` bindings, outcome
(`clear`, `adverse`, `inconclusive`), authoritative source reference, verification
and expiry timestamps. Timestamps are canonical UTC ISO-8601 strings.

Sign the UTF-8 JSON representation of this exact array:

```text
[
  "employee-vault-source:v1",
  submissionId, profileId, issuerId, kind, jurisdiction,
  bindingsSortedById.map(b => [b.id, b.revision, b.sha256]),
  outcome, sourceReference, verifiedAt, expiresAt
]
```

Send `{result, signature}` with the Ed25519 signature in standard base64.
The application verifies the pinned source, current issuer approval, dates,
employee/submission scope and exact clean document revisions before accepting.
Exact replay is idempotent; a conflicting/late result cannot revive a superseded
check. An employee or provider cannot set `clear` merely by submitting a label.
Registry revocation, expired approval and tampered signatures are checked again
at consumption/execution, not just at intake.

A real issuer must establish source authenticity and subject identity, including
the exact evidence revisions, in its approved verification process. A signature
from an unapproved source or a self-attested file is not authoritative evidence.
Do not infer identity from a login email or an employer's candidate email.

## Upload and recovery

Authenticated JSON reservation precedes bounded octet-stream bytes. Limits:
10 MiB/file, PDF/JPEG/PNG signatures, 30 current files and 100 MiB/current profile.
The bytes must match declared Content-Length, type and size. Upload reservations
have an expiry; duplicate/expired reservations cannot overwrite an existing file.
Private object names are constructed from opaque owned IDs, never user paths.

Storage inventory predates I/O. Interrupted reservations remain recoverable and
unreadable. Scanner claims and deadlines persist in the database; finalization
checks the exact claim and SHA-256. Timeout, indeterminate and unavailable states
stay quarantined, with bounded infrastructure retries. Replacement creates a new
revision and invalidates dependent checks and reuse instead of inheriting an old
verdict. Deletion first denies reads, then durable cleanup removes private bytes.
Tombstone inventory is retained for repeated cleanup of late interrupted writes.

The existing shared heartbeat drives scanner work, expired reservations/claims,
expiry, live receipt reconciliation, retention and deletion. Autoscale operation
therefore needs the project's supported authenticated heartbeat schedule;
in-process timers alone are not a production recovery guarantee.

## Sharing and onboarding

Employee approval freezes the authorized checks and grants **summary only** by
default. Raw files require a separate explicit selection; each recipient read
also requires the current effective sensitive-record permission and specialist
authority. Opaque raw files conservatively require all sensitive classes.
Request IDs and Vault IDs do not authorize agent/tool/download/export access.
No raw document is copied into employer-owned candidate document evidence.

Authorized HR sees reused checks, outstanding checks, scope/expiry and truthful
full/partial BGV status in case detail. They enter the employee-confirmed Vault ID
and explicitly confirm independent identity-to-case binding before recording a
receipt. The shared evaluator never combines evidence from different employees
or grants into a complete set.

A current complete receipt suppresses duplicate BGV dispatch. A consumed partial
set keeps missing checks outstanding and passes only those missing check kinds
to the existing check-dispatch contract. No provider adapter is configured or
claimed here. Candidate-file verification, acceptance, governance, readiness,
access/payroll controls and final HR approval remain independent.

Revocation/disablement/replacement/expiry deny future reuse at live execution
boundaries. They invalidate receipts and reopen an active final approval cycle
without restoring deleted narratives or requiring new sensitive collection.
Already-disclosed information cannot be recalled; completed cases keep a minimal
dated historical receipt under approved retention/holds, not live permission.

## Automated synthetic acceptance

Run:

```sh
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/api-server run db:reconcile
pnpm --filter @workspace/api-server run db:verify:tenant-safeguards
pnpm -w run typecheck
TEST_FILE=src/lib/employee-vault/employee-vault.test.ts \
  pnpm --filter @workspace/api-server exec node run-tests.mjs
pnpm --filter @workspace/api-server run test:post-merge
```

The Vault suite uses two synthetic employees and employers, scoped cleanup,
ephemeral signing keys and explicitly synthetic approval references. It covers
absent memberships, tenant isolation, ID non-authorization, source forgery and
replay, concurrent consent, default summary/no raw-file grant, owner authority
denial, all-required versus partial sets, live receipt expiry/disablement,
revocation, evidence supersession, notice revisions, bounded file sizes,
interrupted reservations, scan claim recovery, infection and holds.

**These fixtures prove contracts and fail-closed behavior, not a live commercial
verification or production malware integration.** Do not copy their authority
rows, issuer keys, worker stubs or processing-policy approvals into production.

For browser acceptance use only synthetic people/documents at widths 390, 768
and 1440. Verify public entry and return-to-request authentication; a new account
without membership; independent dashboard; unavailable processing; bounded
upload/replacement/delete where approved synthetic processing exists; actual
employer/purpose/scope/expiry; summary-default consent; separate raw selection;
decline/revoke; tenant-owner opt-in/default-off and protected recipient errors.
With fully approved synthetic source/scanner/country fixtures, verify partial
and complete case reuse, then revoke/disable/expire/replace while the case is
active and verify final HR approval reopens. Test adverse and unavailable states
without changing actual employment outcomes or sending real messages.

## Internet publication checklist

Publish the registered artifact and shared API using the project's standard
deployment configuration. Keep `/employee-vault/` app routes and `/api/vault/`
employee APIs; do not add tenant middleware to employee endpoints or create
tenant-specific copies. Use the actual published URL returned by deployment,
not a constructed development-domain URL. Confirm Clerk domain/proxy settings,
HTTPS/private storage, production schema/ownership inventories, heartbeat,
source/scanner outages, restore/retention/holds and independent audit prerequisites.
Do not advertise production verification until the contracted source and all
relevant processors and drills are approved and actually working.
