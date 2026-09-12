# Protected onboarding audit guarantees

## What is protected

The service writes a tenant-local, SHA-256 chained sequence for protected
onboarding/control-tower requests. It writes an `attempted` entry *before* a
sensitive handler runs. A second, linked outcome entry records success, denial,
or failure when an HTTP response is observed. If a process dies before that
observation, tenant-scoped reconciliation writes a linked
`onboarding.audit-outcome.recovery-required` record. It truthfully records the
lost completion observation (rather than inventing a business outcome) and
makes the item reviewable instead of leaving it permanently unresolved.

The writer serializes each tenant with a transaction-scoped PostgreSQL advisory
lock. Entry and chain-head updates commit in one transaction. PostgreSQL
triggers reject application-path `UPDATE`, `DELETE`, and `TRUNCATE` operations
on audit entries. Corrections are new entries linked to the original; evidence
is never edited in place. Approval decisions also write their approval-history
snapshot and protected audit entry in the same transaction.

Protected entries do not foreign-key cases, approvals, users, or organizations.
Their pseudonymous object/case/correlation references survive deletion or
pseudonymisation of those business records. Approval-history cascade foreign
keys were removed and its own append-only triggers preserve prior decisions.
The synthetic-reset case-deletion boundary checks the tenant legal hold first.

## Capture and minimisation

The central middleware is installed after Clerk authentication and application
tenant membership resolution, covering tenant-scoped control-tower routers
including onboarding, action center, candidate administration, readiness SLA,
and other protected tenant mutations. It rechecks the persisted membership
when writing its actor-authority value. Owner/admin audit review also rechecks
the live membership, not merely request metadata.

Entries contain authenticated actor ID, verified tenant role when available,
timestamp, tenant, pseudonymous affected-object/case references, source,
hashed correlation reference, reviewed optimistic revision when supplied, and
allow-listed scalar metadata only. Request/response bodies are never captured.
The writer drops document/content, credentials, cookies, authorization,
medical, bank, email, phone, and similar metadata fields. Tenant-selection
denials are persisted under the explicit `platform-audit` scope without
retaining the requested tenant identifier.

Existing timeline events and approval snapshots are retained as **historical
coverage**. They are not retroactively represented as immutable chain entries,
and unavailable historic actor identity is not invented.

## Review and lifecycle

Only a current organization owner or admin can search, export, verify, or
manage audit lifecycle state. Search/export is tenant-scoped; export avoids
payload values and guards CSV formula injection. Integrity verification
recomputes the ordered sequence, predecessor hashes, content hashes, and head.

There is intentionally no audit purge job, retention deadline, or automatic
retention decision. An owner/admin records a reviewed retention statement.
Legal hold set/release is persisted and audited; the active hold blocks the
application's destructive synthetic case reset. Protected audit/approval
history cannot be cleaned up through normal application SQL regardless of
hold. Any future destructive lifecycle worker must reject active
`onb_audit_lifecycles.legal_hold_active` before touching case history,
documents, evidence, or protected audit records.

## Threat-model boundary and launch prerequisite

This is tamper-evident against ordinary application paths and detects changed,
reordered, or deleted entries relative to the stored tenant head. It is **not**
DBA-proof: a privileged database administrator can alter rows, heads,
functions, or triggers consistently. No provider is preselected during
organization signup. Independent externally operated anchoring/WORM storage is
therefore an explicit launch prerequisite; tenant settings may record the
approved provider metadata and secret-manager reference name, but never a
secret value. The integrity API never treats an environment flag as evidence.
An owner or administrator may replace or clear this tenant configuration after
signup; no adapter is selected when the setting is absent.
Credential references use only `env:UPPER_SNAKE_NAME` or `vault:path` syntax;
token-shaped values such as `sk-…` are rejected.

> Requirement: “Do not implement WORM: task explicitly out of scope DBA
> immutability with prerequisite disclosure.”

Accordingly, the integrity result explicitly reports
`regulatedProductionLaunchBlocked: true`. This blocks launch-readiness for
DBA-resistant regulated production until independently operated anchoring/WORM
exists; it does **not** block local development or the ordinary development API.

## External anchoring provider boundary

Each committed chain head also creates a tenant-scoped, durable checkpoint
outbox row. A shared heartbeat worker retries delivery with exponential
backoff, reclaims stale claims, and serializes claims per tenant across
application instances. It will not claim a later operation while any lower-id
checkpoint or legal-hold row is still undelivered. The tenant/idempotency key
lets a provider safely return the same receipt after an ambiguous timeout.
Legal-hold set/release operations use the same outbox and propagate only safe
lifecycle facts (including a fingerprint of the supplied reason); a client
provider is responsible for carrying those facts into its own
retention/legal-hold system.
If a client provider is installed after simulation delivery, the worker
requeues delivered operations that lack that provider's receipt. Receipt rows
are bound by an explicit tenant configuration generation, so replacing a
namespace or credential reference re-anchors even when the provider ID is
unchanged. Simulation receipts remain immutable evidence, while one immutable
receipt per provider and generation may be retained for the same operation.
Provider anchor, receipt-verification, and current-checkpoint reads have a
 bounded timeout. A timeout leaves the claim retryable; because the provider
 must honor the idempotency key, an ambiguous completed call is safe to retry.
Provider receipts must carry the current configuration generation and archive
namespace; both are matched exactly before verification is accepted. The
provider-visible idempotency key is deterministically derived from the original
outbox identity, generation, and a non-secret context fingerprint, so a
provider cannot replay a receipt cached under an earlier namespace.
 Provider anchors must also apply operations monotonically, or use a provider
 side compare-and-set. A timed-out request may finish after a retry or a
 higher operation, and must never move the provider's checkpoint or legal-hold
 state backwards.

The checked-in provider is deliberately a **simulation**. It returns a
deterministically verifiable receipt so retry, duplicate, restore comparison,
and outage behavior can be exercised, but it declares `independent: false`.
Consequently simulation can never make `externalAnchoring.configured` true or
unblock regulated production. Clients register an adapter implementing the
provider-neutral interface and its independent verification method; the tenant
resolver selects it by the persisted provider id. Configured status requires a
freshly verified receipt from that adapter, a local-head/external-checkpoint
match, and recorded passed restore and legal-hold drills against the same
provider. Verification fetches the provider's currently held checkpoint at
restore/review time; copied local receipt rows are not treated as the
provider's current truth. A restored database must run the integrity check and
treat missing, behind, ahead, or mismatched external checkpoints as blocked,
including a provider-ahead checkpoint after a local rollback.
If a tenant selects a provider ID that is not registered in the running
process, the adapter is unavailable rather than silently resolving to
simulation; its outbox remains retryable with an explicit missing-adapter
failure and launch remains blocked.
Every adapter operation receives a tenant context containing the selected
archive namespace and credential reference name; adapters resolve credentials
themselves and the service never reads those secret values.
Drill records retain the complete non-secret provider-signed receipt and are
strictly parsed and re-verified with the registered adapter on every status
read; changing or clearing tenant archive configuration atomically removes the
old drill evidence.

During an anchoring outage, continue local append-only capture, retain queued
delivery for retry, alert reviewers, and do not claim external protection or
regulated readiness. There is no automatic purge, statutory retention period,
or implied legal conclusion: the reviewed retention statement remains the
tenant's policy record, and active legal hold blocks destructive application
work as described above.