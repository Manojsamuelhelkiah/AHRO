# Early-tenure backend contract

Task 254 models Day 1 through probation as durable, tenant-scoped case work. It
does not treat a reminder, an agent statement, a calendar request, or a
checklist label as completion evidence.

## Ownership and scope

The early-tenure core owns:

- `onb_early_tenure_policy_versions`: immutable governed policy versions. A
  policy contains probation length, 30/60/90 check-in cadence, obligation
  applicability, connector requirements, and the authority scope permitted to
  record a probation disposition.
- `onb_early_tenure_case_snapshots`: one immutable resolved policy snapshot per
  enrolled case. The snapshot records the actual-join anchor and is never
  rewritten when a newer tenant policy is published.
- `onb_early_tenure_assignments`: versioned induction, compliance-training,
  buddy acknowledgement, manager-connect, learning and calendar obligations.
  Future assignments can be safely superseded; completed/cancelled rows remain
  historical evidence.
- `onb_early_tenure_evidence`: dated, human or trusted-source evidence for an
  assignment. It is append-only and tenant/case constrained.
- `onb_early_tenure_checkins`: 30/60/90 (or policy-defined) check-ins derived
  from the actual joining anchor. Their policy-configured reminder lead time,
  revisions, and reminder state are durable.
- `onb_early_tenure_reminders`: durable, idempotent notification outbox rows.
  Delivery delegates to the existing administrative communications safety
  boundary; identity and recipient authorization are rechecked on claim.
- `onb_probation_decisions`: human-only, authority-validated probation
  dispositions. Each record carries its expected policy snapshot and decision
  version so stale submissions are rejected.

The reporting module owns **separate** tables and routes:

- `onb_early_tenure_survey_responses` (restricted voluntary survey data,
  including 30-day eNPS); the core does not read raw responses.
- `onb_employment_outcome_evidence` (dated HRIS/authorized employment
  evidence); the core does not infer attrition.

Those tables must include `organization_id`, `case_id`, source/provenance,
observed/effective date, and tenant-and-case foreign keys. Reporting must
return `Not measured` for absent source evidence, exclude synthetic/demo data,
and enforce a configured minimum aggregation threshold before exposing eNPS.

## Route contract

All routes are under `/api/onboarding/early-tenure` and require an authenticated
organization context:

- `GET /cases/:caseId` returns the snapshot, current assignments/check-ins and
  their evidence/reminder projections only to a current case-scoped
  HR-compliance authority in the current tenant.
- `GET /cases/:caseId/owner-options` returns only active tenant-member IDs and
  roles to an authorized case reviewer. Assignment revisions must select one
  of these current members as `ownerUserId`.
- `GET /reminders/inbox` is the assigned member's minimal in-app inbox. It
  returns only reminder id/type/timing, an obligation label, and opaque task
  reference (no worker or case narrative). It marks a pending in-app reminder
  sent only as it becomes visible in that response, then keeps it visible
  until the current target is completed, cancelled, or superseded.
- `POST /assignments/:assignmentId/my-evidence` is the assigned active
  member's narrow inbox action. It accepts only human-authorized dated
  evidence for that member's current assignment; it grants no case-view or
  HR-review access.
- `POST /checkins/:checkinId/owner` assigns an active tenant member through a
  new check-in revision. Unassigned check-ins are not dispatched; the assigned
  member receives the same minimal inbox projection.
- `POST /assignments/:assignmentId/owner` is the corresponding owner-only,
  revision-fenced handoff for an active pending assignment. It is valid for
  Day-0 and overdue work and never changes the due date; once owned, an
  overdue assignment can enter the durable in-app reminder queue.
- `POST /cases/:caseId/enroll` creates a resolved snapshot and assignments only
  where the case is applicable. Existing enrollment is idempotent.
- `POST /cases/:caseId/joining-anchor` records an actual join date. It
  supersedes incomplete future work and any still-untouched planned-anchor
  task/check-in (including one now overdue); it never edits completed evidence
  or manually revised/historical work.
- `POST /assignments/:assignmentId/revise` safely supersedes a pending/future
  assignment and creates a new revision with an explicit human owner.
- `POST /assignments/:assignmentId/evidence` is human-only and may not assert
  connector provenance/source keys. Trusted configured-source evidence enters
  only through a server-owned authenticated connector adapter; neither path
  simulates LMS, Outlook, or Teams completion.
- `POST /probation-decisions` accepts confirmation, extension, or
  `reviewed-other` only. It requires snapshot, actual-anchor, and decision
  expected revisions plus a currently valid authorized human authority; it
  cannot make a dismissal or any automatic/adverse employment decision.
- `POST /reminders/dispatch` is an authorized worker/operator entry point. It
  claims durable rows then calls the existing administrative-email safety
  implementation. Unknown provider outcomes are terminal and require manual
  reconciliation.

`GET/POST /policy-versions` create/read policy versions. Publishing or changing
the active policy requires existing tenant governance and the policy authority
scope; case snapshots remain immutable.

## Safety invariants

1. Every query and mutation is scoped by `organization_id`; case-bearing rows
   use composite tenant/case foreign keys.
2. Enrollment applies only to non-synthetic, non-cancelled cases with a valid
   joining date and a policy whose applicability matches the case.
3. Scheduled dates use `actual_joined_at` when recorded, otherwise the planned
   joining date. Planned joining is never silently asserted to be actual
   employment.
4. The worker uses unique reminder keys plus a case lock and revision/version
   re-read before claiming delivery. A superseded assignment/check-in cannot
   send a stale reminder.
5. Learning/calendar connectors are requirements/statuses only until a
   trusted configured source confirms delivery/completion. Otherwise the
   assignment remains an explicit human task.
6. Probation is configured policy, not a hard-coded legal 90 days. A
   30/60/90 cadence is a check-in schedule only. A stale snapshot, anchor, or
   decision version, revoked authority, missing creator provenance, wrong
   tenant, or unsupported disposition is rejected.
7. Early-tenure evidence and its surrounding case-derived assignment,
   check-in, reminder, snapshot, and decision records enter the existing
   sensitive-lifecycle collection gate, retention watermark, and case
   minimization routine. Retention minimization redacts evidence references,
   identities, recipient data, anchors, agenda/task details, rationale, and
   probation authority identifiers while preserving only the durable structural
   revisions required by the tenant's approved lifecycle policy.
8. This service has no authoritative membership-email directory. External
   e-mail is therefore rejected rather than bound to an arbitrary address;
   assignment-owner in-app delivery is the durable supported channel.
9. Legacy nullable 0073 anchor fences are reconciled only where a current
   revision-2 target has a linked revision-1 predecessor whose planned due
   date proves the automatic transition. Other nullable legacy histories are
   intentionally left for a human revision.
10. `probation.maturityAt` and `probation.governedEndAt` in the case view are
    derived from the current actual anchor, immutable snapshot duration, and
    current-anchor extensions. Confirmation cannot be effective before that
    governed end; extensions may be reviewed after joining but must end after
    it. Decision effective dates cannot be future-dated.
11. New policies require separate required learning-enrollment and
    compliance-training completion obligations. Compliance evidence is blocked
    until the learning-enrollment assignment has dated completion evidence.
    Calendar delivery is also required and remains an explicit human-evidence
    fallback (it cannot be connector-required). Check-ins are a nonempty,
    distinct-offset configurable cadence; product defaults are 30/60/90 but a
    tenant policy may remove or replace those intervals.