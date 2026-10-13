# Governance API contract (task 251)

The governance register is tenant-scoped and is served below `/api/governance`.
All endpoints require the existing authenticated tenant context. Responses never
claim that a provisional decision is legal, operational, or live approval.

## Catalog integration

The catalog module is imported by the API from `./governance-catalog` and must
export:

```ts
export interface GovernanceDecisionCatalogEntry {
  id: string;
  title: string;
  proposedValue: string;
  rationale: string;
  risks: readonly string[];
  accountableReviewRole: string;
  impactedWorkflows: readonly string[];
  reviewDueDate: string | null;
  sourceRefs: readonly string[];
}
export const GOVERNANCE_DECISIONS: readonly GovernanceDecisionCatalogEntry[];
```

Catalog entries are only seeded where a tenant has no record for that key.
They must use explicit provisional status/defaults and must not overwrite a
tenant's decisions or policies. Requirements Register rows are never seeded.

## Resource shapes

`Decision` has `key`, `title`, `revision`, `status` (`draft | provisional |
approved | rejected | superseded`), `proposedValue`, `rationale`, `risk`,
`accountableRole`, `reviewDueAt`, `impactedWorkflows`, `sourceReference`,
`approvedRevision` (the latest historically approved revision, retained even
when later superseded), `createdAt`, and `updatedAt`. A decision update creates a new immutable
revision; the former revision becomes `superseded`.

The Requirements Register is retired, not relocated. Existing coverage records,
source references and immutable audit events are historical-only. No manual
implementation, test, configuration or live-approval flag blocks or authorizes
future effects. Trusted provider configuration and applicable source evidence
are checked directly by workflow, independently of historical rows. Retirement
does not continue held cases, approve work, replay effects or send messages.

An owner/admin may nominate an assignment (`verificationStatus: "pending"`),
but it is not authority. Verified authority grants have
`verificationStatus: "verified"`, `role`, `assigneeUserId`,
`verifiedByUserId`, `verificationReference`, optional `expiresAt`, and
`revokedAt`. Admin role alone is never authority to create one.

## Endpoints

- `GET /governance/decisions` → `{ decisions: Decision[] }`; `POST
  /governance/decisions` → `{ decision: Decision }`
- `GET /governance/decisions/:key/history`
- `POST /governance/decisions/:key/revisions` (requires current revision)
- `POST /governance/decisions/:key/reviews` (requires verified active
  authority for the accountable role; stale revision returns 409)
- All methods below `/governance/requirements` return 410 without reading,
  seeding or changing retained data; listing/editing contracts are retired.
- `GET|POST /governance/assignments` → `{ assignments | assignment }`;
  `POST /governance/assignments/:id/verify` upgrades an owner nomination only
  when called by a server-verified operator;
  `POST /governance/assignments/:id/revoke` → `{ assignment }`
- `GET /governance/history` → `{ history: HistoryEvent[] }`
- `POST /governance/reminders/dispatch` (durable, idempotent reminder sweep)
- `POST /governance/dispatches/:dispatchId/reconcile` (server-verified
  operator only; requires an external-outcome reconciliation reference)

The existing externally driven onboarding watcher also calls
`runGovernanceReminderTick()`. It atomically transitions each due persisted
reminder once and writes a history event; it does not send a provider message.

Specialist assignment and operator-bootstrap administration are retired.
Their mutation URLs return 410 and cannot alter retained historical evidence.
Policy work requires a named active client member's live `tool.policy.manage`
permission and an explicit current-revision review. Membership, mailbox
personas and display-role labels are not permission grants or qualifications.

Mutation concurrency tokens are `expectedRevision` for decision revisions.
Reviews use `outcome: "approved"
| "rejected"` and require a non-empty `verificationReference`. The UI must not
substitute `approve/reject`, a browser-selected authority, or a local role for
these values.

Authorized policy managers can revise decision rationale/value and routing
labels or impacted workflows. Changes invalidate the prior review; routing
labels do not establish eligibility, permissions or professional qualifications.

Runtime gate consumers require a versioned permission-based human review and
revalidate the reviewer's live client-scoped permissions. Old specialist
receipts are history only and cannot authorize new effects. Explicit denies,
revocations, separation of duties, source evidence and case revisions remain.
Provider/runtime integrations must also follow
`docs/governance-dispatch-contract.md`; active or ambiguous durable dispatches
block governance mutation until verified reconciliation.

Consumers should display statuses and due dates as review work and show affected
workflows. Provider activation and source evidence remain independent of policy
approval; historical coverage flags establish none of these facts.

## Case adoption, impact, and rebase

New cases persist `governanceDecisionSnapshot` within their immutable
`processPolicySnapshot`. It contains the schema version, an adoption version,
timestamp, and every applicable sensitive decision's canonical `key`,
`revision`, `status`, `domain`, and canonical `impactedWorkflows`. Draft and
provisional decisions are deliberately included: an empty approved set is not
evidence that there is no governance impact.

- `GET /onboarding/cases/:id/governance-impact` returns `{ snapshot, impacts }`.
  Each impact has `key`, `adoptedRevision` (nullable for a newly introduced
  decision), `currentRevision`, `impactedWorkflows`, `reason`
  (`new-decision | revision-available | approval-revoked-or-missing`), and
  `blocksLiveActions`. New or later revisions are visible but never silently
  replace an active case snapshot.
- `POST /onboarding/cases/:id/governance-rebase` accepts
  `{ expectedSnapshotVersion, reason }` and returns
  `{ snapshot, freshFinalApprovalRequired: true }`. A normal rebase is
  version-checked and reopens Gate C. A historical case lacking a snapshot is
  fail-closed for sensitive future live actions; only an explicit audited
  request with `expectedSnapshotVersion: 0` may create its version-0 legacy
  adoption boundary. It also reopens Gate C and never replays provider effects.