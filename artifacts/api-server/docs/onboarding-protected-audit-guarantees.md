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
functions, or triggers consistently. There is currently **no** independent
anchor or WORM implementation. Independent externally operated anchoring/WORM
storage is therefore an explicit unmet launch prerequisite; the integrity API
always reports it as not configured rather than treating an environment flag
as evidence.

> Requirement: “Do not implement WORM: task explicitly out of scope DBA
> immutability with prerequisite disclosure.”

Accordingly, the integrity result explicitly reports
`regulatedProductionLaunchBlocked: true`. This blocks launch-readiness for
DBA-resistant regulated production until independently operated anchoring/WORM
exists; it does **not** block local development or the ordinary development API.