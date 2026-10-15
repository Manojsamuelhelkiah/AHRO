# Executable case flows

The Flow section in onboarding and controlled-separation details describes the
case's immutable executable **base flow**, not its Client Setup planning basis.
Policy, checklist and evidence revisions retain their own domain meanings.
They can reopen work without changing the bound base-flow version.

## Authority and ownership

- Domain case records, approvals, checklists, operational tasks and provider
  records remain authoritative. There is no additional workflow state machine
  or scheduler.
- The shared manager checks the pinned definition, registered action, stage
  dependencies and expected domain generation inside existing mutation fences.
  Existing domain services still check current permissions, human receipts,
  evidence, recipients, source attestations and effect eligibility.
- Definitions contain closed deterministic conditions and registered handlers.
  Plan/model output cannot supply executable code, choose a new handler,
  approve itself or rewrite the definition.
- The existing coordinator runs the definition's registered continuation
  sequences. Advancing a checkpoint does not complete its parallel tasks.
  Rework remains explicit and domain evidence can reopen an earlier boundary.
- Existing claims, immediate reconciliation and periodic recovery remain the
  only continuation mechanisms. The existing effect journal still owns stable
  operation identities and ambiguous outcomes; uncertain non-idempotent writes
  require reconciliation rather than automatic replay.

## Binding and release

New supported admissions bind inside their existing admission transaction.
Migration adds metadata only; startup reconciles compatible legacy identities
under existing tenant/case locking. It neither rewrites progress nor sends
messages. Unsupported families remain review-only. Uncertain historical state
remains compatibility-held and cannot obtain authority merely from a read.
Source/provider observations are still retainable while execution is held.

Checked-in definition bytes are canonicalized and compared with their stored
digest. Persisted definitions cannot be updated, deleted or truncated. Changing
the executable graph requires a new identity/version and an explicit admission
default; the captured legacy baseline is separate. Existing bindings cannot be
silently rebound. Human policy approval does not migrate a base-flow binding.

The separation definition covers screening, classification, approved-policy
planning, dependent tasks and governed exchanges. Restricted/manual branches
remain explicit. Final closure and closure-derived outcomes remain unavailable
pending the missing approved section 4.6.

## Read-only inspection

The case-scoped API uses the same structural evaluator as mutation guards.
Its possible-action explanations are informational, not permission guarantees
or execution controls: current domain checks run again at mutation/dispatch.
Private progress is conservatively redacted unless the viewer has the required
case and sensitive-record permissions. Reads do not bind a case, invoke a
model/provider, restart work or write a transition.

The Flow section provides textual stages, prerequisite dependencies,
responsible roles, actual parallel task status, expandable blockers and recent
recorded transition outcomes. Current required-upload safety holds are read
from live evidence, not merely cached readiness. History stores safe action,
version/generation, outcome and context references, not private evidence bodies.
It displays up to 100 recent transitions; older records remain retained.

## Verification and rollout

`pnpm run test:case-flows` selects the exact definition, manager, onboarding
gateway, live-document, approval, effect-journal, connector, operational-task,
separation, exchange and privacy suites. Each database suite owns a fully
migrated disposable schema, without a shared-schema search-path fallback, and
checks the original tenant inventory after disposal. The runner fails closed
if a selected suite loses its isolation registration.

The responsive Flow, separation-navigation and shared-family-filter browser
specs use the existing isolated browser harness. Its fixture admissions and
mocked read responses are test-only; they do not restore product simulation or
fictional-case creation. No test should run against real/demo records merely
because an in-process provider stub is installed.

Apply the ledger-backed schema reconciliation before restarting the API.
Activation requires complete handler adoption and passing lifecycle/recovery
checks. Do not waive a failing domain guard to accommodate an obsolete fixture,
replay unknown effects, or migrate cases to a newer definition as a rollout
shortcut.
