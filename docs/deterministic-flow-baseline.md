# Deterministic lifecycle baseline

## Authority and state ownership

The onboarding case, approvals and approval history, document/malware records,
source-system observations, workforce requests, readiness enrollment and
frontline release records own their respective facts. Orchestration checkpoints
are recovery cursors, not proof that all parallel tasks finished. Separation owns
its screening/classification receipts, approved policy snapshot, task dependency
graph, generations and exchange state in dedicated separation records.

The context manager correlates work; it never authorizes a transition. The
effect journal owns dispatch identity, claims and ambiguity. Neither Client
Setup's planning basis nor Cost Explorer flow classes are executable contracts.
Service-request families remain review-only. Legacy exit envelopes cannot enter
either runtime by acquiring an onboarding label.

## Onboarding entry points and recovery

| Boundary | Current entry points | Gates and continuation |
| --- | --- | --- |
| Admission | manual onboarding route, standard intake, batch intake | Existing intake provenance, tenant permissions, policy snapshots; admission itself must not release Gate A |
| Offer acceptance | `enforceOfferAcceptanceGate`, `requestOfferPackageEmail`, dedicated Gate A route | External FTE, contractor and rehire require explicit HR confirmation; trusted TA evidence suppresses duplicate requests, not confirmation |
| Intake / plan | `startOrchestration`, `runIntake`, `runPlanGeneration` | Rule-derived hard/approve-before-act gates; bounded AI narrative cannot release them |
| Pipeline continuation | `reconcileDecidedApprovals`, `resumeAfterDecision`, `resumeChecklistOrchestration` | Durable waiting checkpoint; current permission receipt, requester separation, owner/token lease and compare-and-set claim |
| Parallel work | `runWorkstreams`, connector/workforce request entry points | Before-workstreams checklist, current live decision and evidence, per-domain dependency checks; orchestration advancement is not task completion |
| Communications | `runCommunications`, channels and candidate-email retry | Acceptance, communication checklist, live recipient/governance/dispatch fences; confirmed effects are not resent |
| Source observations | watcher callbacks/polls/email, document and malware reconciliation | Observations remain retainable without authorizing execution; readiness can reopen and exact waiting boundaries can request reconciliation |
| Final readiness | `runAnalyticsAndReview`, `completeDay1ReadinessGate` | Live mandatory checklist, latest malware evidence, BGV, weighted readiness, distinct frontline release and current human Gate C decision |
| Periodic recovery | existing watcher, approval and workforce continuation workers | Same domain reconcilers; no additional scheduler |

## Separation entry points and recovery

| Boundary | Current entry points | Gates and continuation |
| --- | --- | --- |
| Admission | `createSeparationInTransaction`, manual/batch/mailbox callers | Tenant/employee source identity; dedicated held envelope, no employee contact |
| Human decisions | `actionSeparation` screening, HRBP reconciliation, classification | Case version/generation, dispatch mutation lock, current permission receipts, source-backed references |
| Plan | `actionSeparation` approved-policy plan compilation | Current screening/classification/country-role-category-zone policy; restricted branch requires explicit human-led reviews |
| Tasks | `actionSeparation`, `freshTask`, `planCurrent` | Actual task prerequisites and fresh generation-bound source evidence; stale or uncertain dependencies block |
| Exchanges | exchange service and runtime dispatch/reconciliation/reply handlers | Exact fictional pilot provenance, named recipients, channel permissions, source attestations, policy/dispatch fences and stable journal keys |
| Recovery | existing exchange worker and accepted-exchange reconciliation | Owner-fenced claims and durable source records; no second poller |
| Closure | all finalization/closure/archive/alumni/rehire/reporting actions | Unavailable pending approved section 4.6; evidence preparation is not closure |

## Characterization and isolation

Before adding runtime guards, run the exact selected suites through the owned
schema runner. In particular `gateway-guards.test.ts` and
`engine-document-gate.test.ts` must be explicitly selected for isolation; being
in a batch with another isolated suite is insufficient.

The disposable schema is migrated without a shared-schema search-path fallback.
Foreign keys must resolve inside it. Cleanup drops only the owned schema and
compares the original tenant inventory. Provider stubs alone do not isolate
fixtures from background workers.

Gateway fixtures must use current named-member permissions and human permission
receipts, not retired specialist assignments. Tests that revoke those old
assignments without exercising a live permission receipt can pass vacuously.
Both authorized-success and stale-authority denial are necessary.
