# Controlled offboarding coverage

The twelve-activity source process intentionally omits section 4.6. This
implementation covers activities 01–11 and closure **preparation**, not a
seven-condition readiness certification. Gateway C and activity 12 have no
executable path. No administrators, workers, imports or callbacks can override
the blocker. Future analytics contracts are disabled and require approved
closure requirements, cohort suppression and privacy review.

## Requirement-to-test matrix

| Requirement | Automated evidence |
|---|---|
| 01 complete dates/time zones, attributable intake | Calendar validation; API aggregate test; browser manual form |
| 01 single active exit, source idempotency and conflict | Four concurrent retries; unique tenant/employee key; immutable alternate manager event; HRBP reconciliation |
| Mailbox alongside manual/batch | Shared consumer token/allowlist; provider-message dedup; reviewed conversion; quarantine acknowledgement; browser Intake page; missing/unapproved jurisdiction retains minimal correlation only, with no employee content until collection approval |
| Authenticated human source versus unsupported HRIS | Scoped manager/Security/Compliance admission; HRIS feed explicitly unsupported; mailbox never source-attested HRIS |
| Gateway A and 02 restricted handling | Sticky sensitive flags; HRBP; Ethics anti-retaliation/no-surprise; Legal human-led review; hidden narratives/history |
| 03 confirmed classification and urgency | Clear and restricted classification; unknown denied; explicit five flags; current recorded authority |
| 04 approved exact checklist version | Independent approval; version binding; withdrawn-policy denial; stale approval checks |
| 05 client-facing continuity | Compiled Delivery Head replacement, artifacts, client access/communication and continuity tasks; client plan reaches preparation |
| 06 standard access | Country wall-clock/DST validation; future end-LWD denial; shared-account and limited-KT prerequisites; source closure/dependency proof |
| Gateway B and 07 urgent closure | Privileged/high-risk/High plan branches; independent Security manual emergency closure and subsequent distinct Legal reviewer |
| 08 assets and Finance | Default inventory unconfirmed; asset/licence and Finance disposition tasks in authorized dependency walk |
| 09 KT | Manager/successor proof; risk mitigation predicate; client Delivery Head gate |
| 10 settlement and reconciliation | Versioned source calculations; fixed numeric Payroll projection; readiness/reconciliation prerequisites; upstream invalidation |
| 11 compliance and retention | Statutory/equity/privacy/legal task plan; holds prohibit deletion actions; preparation cannot become closure |
| Gateway C and 12 | Every close/archive/alumni/eligibility/insight action denied; database completion checks; generic onboarding write and dispatch denial |
| Rehire/retraction | Pause stops late evidence; HRBP resume/cancel/transfer-review; no access restoration or reversal |
| Death/abscondment/hold | Restricted reviewed pathway; death nominee-benefit review/no interview predicates; Legal abscondment notice/F&F references; retained case FK |
| Stale work and recovery | Optimistic edits race; revision/evidence generations; transitive prerequisite invalidation; immutable checkpoints; duplicate retry after operations |
| Tenant/restricted protection | Other tenant 404; viewer facts/sources/history/settlement redaction; live scoped authority/field checks |
| Onboarding/UAT survival | Existing browser regression suite and onboarding guards; separation never invokes provisioning/BGV/welcome/release |
| Responsive product surfaces | Browser flow checks list/detail/intake/policies at 390, 768 and 1280 pixels |

Primary tests: `artifacts/api-server/src/lib/offboarding/offboarding.test.ts`
and `browser-regression/offboarding.spec.ts`. Browser fixtures use a disposable
migrated schema, non-Demo test principals and the real API router behind the
existing unconditional provider-deny fence. They do not create real identities,
separation actions, messages, entitlements or operational authority.

## Runtime and policy boundaries

- All available separation execution is **manual, source-attested evidence**.
  Existing connector adapters support onboarding operations, not separation
  revocation, asset return, statutory computation or client communications.
  No separation operation is advertised as automatically supported. If one is
  added later it must use approved operation policy and the durable effect
  journal, not invoke an onboarding adapter.
- Restricted plans remain restricted, require current HRBP/Ethics/Legal reviews
  and never acquire ordinary automation authority. Emergency Security work is
  independently scoped, manual and subsequently reviewed.
- Opaque narratives and history require all potentially relevant sensitive-field
  grants and verified specialists. The fixed numeric settlement projection is
  separately Payroll-field/Finance-or-Payroll-authorized and omits references.
- Legacy offboarding labels remain review-only. There is no blanket migration,
  deletion or history replay.
