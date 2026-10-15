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

- Real separation execution is **manual, source-attested evidence**.
  Existing connector adapters support onboarding operations, not separation
  revocation, asset return, statutory computation or client communications.
  No separation operation is advertised as automatically supported. If one is
  added later it must use approved operation policy and the durable effect
  journal, not invoke an onboarding adapter.
- Restricted plans remain restricted, require current HRBP/Ethics/Legal reviews
  and never acquire ordinary automation authority. Emergency Security work is
  independently scoped, manual and subsequently reviewed.
- Opaque narratives and history require all potentially relevant sensitive-field
  grants and explicit named-human reviews. Access does not establish professional qualifications. The fixed numeric settlement projection is
  separately Payroll-field/Finance-or-Payroll-authorized and omits references.
- Legacy offboarding labels remain review-only. There is no blanket migration,
  deletion or history replay.

## Case-bound access and equipment conversations

The additive resignation exchange journey admits only its exact newly created
records in the verified Demo organization. Display uses S followed immediately
by the numeric case ID; neither that label nor a persona is an authorization
signal. Provisioning, viewing, enrollment and estate configuration send nothing.
The three records start held and inherit the existing screening, classification,
approved-policy, permission, confidentiality and final-closure boundaries.

Only Gmail communication may be enabled, by a named accountable operator using
their authenticated account. Each task needs a unique current member whose
email is explicitly allowlisted and there is a separate enrolled escalation
member/address. Consent and email verification are client-declared Yes by default,
shown as two small case indicators. Unchecking either pauses outgoing email;
rechecking alone cannot bypass version-bound manual review. These declarations
are not independent transport proof or authority to confirm work. The registered agent needs
delegated private-case reading and conversation dispatch intersected with the
initiating operator's current permissions. No grants or identities are created
by enrollment. Shared Demo principals cannot enable communication.

Entra and ServiceNow expose bounded fictional operation/status contracts only.
Their correlated observations are stored separately from Gmail send acceptance,
signed inbound receipt, owner acknowledgment and authenticated source
attestation. Neither mock results nor real email establish real account
disablement, equipment movement, workforce outcomes or final exit closure.
Production separation task-evidence rejects these registered fictional records.

Email input is untrusted. Completion requires a full, aligned raw DKIM signature,
exact current task/enrollment/generation correlation, unique verified owner
binding, live scoped permissions, fresh policy/prerequisites and applicable date
gates. Generic acknowledgments, unsigned or forwarded statements, model output,
stale mail and display labels never authorize completion. An explicit reply can
confirm only checked portions; unresolved items remain pending or require
version-bound authenticated exception review. Authenticated source handoff is
also available for the enrolled task owner.

Outbound content and opaque references are persisted before journal claiming.
Non-idempotent ambiguous sends are never retried: exact signed Gmail sent-message
inspection can reconcile provider acceptance without implying delivery or read
acknowledgment. Provider message IDs suppress duplicates and self-send echoes;
offboarding references are reserved against onboarding/shared-mailbox intake.
Awaited heartbeat processing handles replies, follow-ups and escalation. The
persisted operational clock cannot advance real email reminder time.

### Verification and release prerequisites

- Contract tests cover all three adapter scenarios, date boundaries, exact
  portions, contradictory/quoted statements, bounded interpretation, injection,
  revision contracts and raw DKIM/encoded-body verification.
- Existing separation regressions cover the original lifecycle and closure
  denials; full workspace typechecking and ledger-led schema reconciliation
  remain required.
- An isolated, ledger-migrated Gmail-flow regression covers signed source
  replies, partial and exceptional completion, duplicated and forged messages,
  unbound responders, membership revocation, explicit clock reconciliation,
  stale enrollment drafts, quarantine and non-idempotent send recovery.
- The provider-denied authenticated browser regression exercises all three
  cases, persisted interface results, paused enrollment, scoped drafts and
  layouts at 390, 768 and 1280 pixels. This does not attest live channel health.
- The controlled live round-trip requires independently approved case enrollment
  by the actual named operator and explicit recipient bindings. Routine email
  consent/verification follows the client-declared default, not a per-case form.
  No channel approval has been
  inferred from the task description, fictional records or mailbox connection.
  Record only actual Gmail acceptance/receipt; never substitute fake provider
  receipts or claim live Entra/ServiceNow activity.

Shared-account confirmations require an explicit current named owner.
Temporary KT handling requires either an explicit statement that access is not
required, or a named owner, future expiry and reviewed authorization reference.
Missing or stale details produce a targeted clarification, not completion.
Labels and proposed ownership never enroll recipients or grant access.
