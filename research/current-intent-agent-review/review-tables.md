# Detailed review tables

Assessed 2026-10-16. Proposals only. Exact definition-level fields and affected-key arrays are in [intent-agent-matrix.json](intent-agent-matrix.json).

## Every service, including all 32 explicit association gaps

Atomic counts here are memberships, not additive unique outcomes. Composite propagation is excluded from explicit-role counts.

| Journey | Service | Atomic memberships | Explicit current roles | Proposed coordinator | Rationale |
|---|---|---:|---|---|---|
| recruiting | requisition-management | 1 | **None** | proposed:recruiting | Recruiting decisions and candidate records precede accepted-offer onboarding; helpdesk can answer FAQs but must not own hiring decisions. |
| recruiting | candidate-management | 1 | **None** | proposed:recruiting | Recruiting decisions and candidate records precede accepted-offer onboarding; helpdesk can answer FAQs but must not own hiring decisions. |
| recruiting | candidate-progression | 1 | **None** | proposed:recruiting | Recruiting decisions and candidate records precede accepted-offer onboarding; helpdesk can answer FAQs but must not own hiring decisions. |
| recruiting | offers-contracts | 1 | **None** | proposed:recruiting | Recruiting decisions and candidate records precede accepted-offer onboarding; helpdesk can answer FAQs but must not own hiring decisions. |
| recruiting | recruiting-self-service | 4 | hr-helpdesk | proposed:recruiting | Recruiting decisions and candidate records precede accepted-offer onboarding; helpdesk can answer FAQs but must not own hiring decisions. |
| recruiting | referrals | 1 | **None** | proposed:recruiting | Recruiting decisions and candidate records precede accepted-offer onboarding; helpdesk can answer FAQs but must not own hiring decisions. |
| onboarding | onboarding-case | 4 | onboarding | onboarding | Keep coordination with Onboarding, but readiness scoring, attendance, activation and professional decisions are separate records. |
| onboarding | identity-right-to-work | 4 | compliance, document-verification | compliance | Existing Compliance is broad: retain specialist handoffs and never interpret its mapping as legal, medical or screening authority. |
| onboarding | background-screening | 11 | compliance, document-verification | compliance | Existing Compliance is broad: retain specialist handoffs and never interpret its mapping as legal, medical or screening authority. |
| onboarding | worker-master-setup | 4 | **None** | employee-changes | Extend the existing core-HR coordinator to prestart worker creation; a composite onboarding mapping is not explicit worker-master accountability. |
| onboarding | payroll-tax-time-setup | 4 | payroll | payroll | Payroll coordinates approved pay execution; reward design and attendance adjudication require different accountabilities. |
| onboarding | benefits-setup | 4 | benefits | benefits | Extend Benefits to nonclinical wellbeing navigation; keep clinical/safety judgments outside the agent. |
| onboarding | identity-access-setup | 4 | it-access | it-access | Keep reusable standalone and composed access under one coordinator, not a second access-request agent. |
| onboarding | device-facilities-setup | 6 | assets-workplace | assets-workplace | Keep physical fulfillment separate from IAM and from a communication that merely asks for fulfillment. |
| onboarding | orientation-learning | 4 | learning | learning | Retain Learning but remove any implied ownership of performance ratings or succession selection. |
| onboarding | manager-buddy | 4 | onboarding | onboarding | Keep coordination with Onboarding, but readiness scoring, attendance, activation and professional decisions are separate records. |
| onboarding | first-week-activation | 4 | onboarding | onboarding | Keep coordination with Onboarding, but readiness scoring, attendance, activation and professional decisions are separate records. |
| onboarding | probation-onboarding-change | 5 | onboarding | onboarding | Keep coordination with Onboarding, but readiness scoring, attendance, activation and professional decisions are separate records. |
| core-hr | person-data | 3 | employee-changes | employee-changes | Extend the existing core-HR coordinator to prestart worker creation; a composite onboarding mapping is not explicit worker-master accountability. |
| core-hr | worker-data-quality | 3 | employee-changes | employee-changes | Extend the existing core-HR coordinator to prestart worker creation; a composite onboarding mapping is not explicit worker-master accountability. |
| core-hr | organization-management | 3 | employee-changes | employee-changes | Extend the existing core-HR coordinator to prestart worker creation; a composite onboarding mapping is not explicit worker-master accountability. |
| core-hr | position-management | 3 | employee-changes | employee-changes | Extend the existing core-HR coordinator to prestart worker creation; a composite onboarding mapping is not explicit worker-master accountability. |
| core-hr | employment-relationships | 3 | employee-changes | employee-changes | Extend the existing core-HR coordinator to prestart worker creation; a composite onboarding mapping is not explicit worker-master accountability. |
| core-hr | contingent-workforce | 3 | employee-changes | employee-changes | Extend the existing core-HR coordinator to prestart worker creation; a composite onboarding mapping is not explicit worker-master accountability. |
| core-hr | employee-changes | 3 | employee-changes | employee-changes | Extend the existing core-HR coordinator to prestart worker creation; a composite onboarding mapping is not explicit worker-master accountability. |
| documents-service | employment-documents | 4 | documents-records | documents-records | Document custody is distinct from verifying authenticity or making a legal determination. |
| documents-service | document-governance | 3 | documents-records | documents-records | Document custody is distinct from verifying authenticity or making a legal determination. |
| documents-service | hr-case-management | 3 | hr-helpdesk | hr-helpdesk | Retain front-door triage and knowledge; hand domain-specific outcomes to their proposed accountable coordinator. |
| documents-service | knowledge-policy | 4 | hr-helpdesk | hr-helpdesk | Retain front-door triage and knowledge; hand domain-specific outcomes to their proposed accountable coordinator. |
| documents-service | self-service-delegation | 3 | hr-helpdesk | hr-helpdesk | Retain front-door triage and knowledge; hand domain-specific outcomes to their proposed accountable coordinator. |
| privacy-insight | records-retention | 3 | documents-records | documents-records | Document custody is distinct from verifying authenticity or making a legal determination. |
| privacy-insight | privacy-rights | 7 | documents-records | documents-records | Document custody is distinct from verifying authenticity or making a legal determination. |
| privacy-insight | data-quality-controls | 3 | **None** | employee-changes | Reuse core-HR data stewardship and shared deterministic reporting rather than creating an analytics agent for every report. |
| privacy-insight | hr-reporting | 3 | **None** | employee-changes | Reuse core-HR data stewardship and shared deterministic reporting rather than creating an analytics agent for every report. |
| payroll | pay-access | 4 | payroll | payroll | Payroll coordinates approved pay execution; reward design and attendance adjudication require different accountabilities. |
| payroll | pay-run | 3 | payroll | payroll | Payroll coordinates approved pay execution; reward design and attendance adjudication require different accountabilities. |
| payroll | pay-release | 5 | payroll | payroll | Payroll coordinates approved pay execution; reward design and attendance adjudication require different accountabilities. |
| payroll | pay-corrections | 3 | payroll | payroll | Payroll coordinates approved pay execution; reward design and attendance adjudication require different accountabilities. |
| payroll | statutory-pay | 5 | payroll | payroll | Payroll coordinates approved pay execution; reward design and attendance adjudication require different accountabilities. |
| payroll | garnishments | 3 | payroll | payroll | Payroll coordinates approved pay execution; reward design and attendance adjudication require different accountabilities. |
| rewards | compensation | 3 | **None** | proposed:rewards | Distinct discretionary compensation and reward governance should not be hidden inside payroll calculation ownership. |
| rewards | variable-pay | 3 | **None** | proposed:rewards | Distinct discretionary compensation and reward governance should not be hidden inside payroll calculation ownership. |
| rewards | equity-recognition | 3 | **None** | proposed:rewards | Distinct discretionary compensation and reward governance should not be hidden inside payroll calculation ownership. |
| rewards | pension-wellbeing | 3 | benefits | benefits | Extend Benefits to nonclinical wellbeing navigation; keep clinical/safety judgments outside the agent. |
| benefits | benefits-enrollment | 3 | benefits | benefits | Extend Benefits to nonclinical wellbeing navigation; keep clinical/safety judgments outside the agent. |
| benefits | benefits-evidence | 3 | benefits, document-verification | benefits | Extend Benefits to nonclinical wellbeing navigation; keep clinical/safety judgments outside the agent. |
| benefits | carrier-claims | 3 | benefits | benefits | Extend Benefits to nonclinical wellbeing navigation; keep clinical/safety judgments outside the agent. |
| benefits | hr-expenses | 3 | benefits | benefits | Extend Benefits to nonclinical wellbeing navigation; keep clinical/safety judgments outside the agent. |
| time-scheduling | time-capture | 3 | **None** | proposed:time-attendance | Work-time cycles and payroll cutoffs differ from leave entitlement; separate coordination avoids treating an absence approval as approved worked hours. |
| time-scheduling | time-validation | 3 | **None** | proposed:time-attendance | Work-time cycles and payroll cutoffs differ from leave entitlement; separate coordination avoids treating an absence approval as approved worked hours. |
| time-scheduling | scheduling | 3 | **None** | proposed:time-attendance | Work-time cycles and payroll cutoffs differ from leave entitlement; separate coordination avoids treating an absence approval as approved worked hours. |
| time-scheduling | overtime-attendance | 3 | **None** | proposed:time-attendance | Work-time cycles and payroll cutoffs differ from leave entitlement; separate coordination avoids treating an absence approval as approved worked hours. |
| time-scheduling | time-information | 3 | **None** | proposed:time-attendance | Work-time cycles and payroll cutoffs differ from leave entitlement; separate coordination avoids treating an absence approval as approved worked hours. |
| absence | routine-absence | 3 | leave | leave | Keep leave accountability, but collaborate with time coordination for payable-time handoffs. |
| absence | absence-maintenance | 5 | leave | leave | Keep leave accountability, but collaborate with time coordination for payable-time handoffs. |
| absence | protected-leave | 3 | leave | leave | Keep leave accountability, but collaborate with time coordination for payable-time handoffs. |
| absence | extended-leave | 3 | leave | leave | Keep leave accountability, but collaborate with time coordination for payable-time handoffs. |
| performance | goals | 3 | **None** | proposed:performance-talent | A shared performance/talent coordinator joins evidence across reviews and succession without granting assessment or selection authority. |
| performance | checkins-feedback | 3 | **None** | proposed:performance-talent | A shared performance/talent coordinator joins evidence across reviews and succession without granting assessment or selection authority. |
| performance | reviews-calibration | 3 | **None** | proposed:performance-talent | A shared performance/talent coordinator joins evidence across reviews and succession without granting assessment or selection authority. |
| performance | improvement | 3 | **None** | proposed:performance-talent | A shared performance/talent coordinator joins evidence across reviews and succession without granting assessment or selection authority. |
| learning-career | skills | 4 | learning | learning | Retain Learning but remove any implied ownership of performance ratings or succession selection. |
| learning-career | learning | 4 | learning | learning | Retain Learning but remove any implied ownership of performance ratings or succession selection. |
| learning-career | certification-education | 4 | learning | learning | Retain Learning but remove any implied ownership of performance ratings or succession selection. |
| learning-career | career-mentoring | 4 | learning | learning | Retain Learning but remove any implied ownership of performance ratings or succession selection. |
| talent-mobility | internal-mobility | 4 | mobility | mobility | Keep Mobility as handoff coordinator; do not give it independent legal or tax decision authority. |
| talent-mobility | talent-review | 4 | **None** | proposed:performance-talent | A shared performance/talent coordinator joins evidence across reviews and succession without granting assessment or selection authority. |
| talent-mobility | succession | 4 | **None** | proposed:performance-talent | A shared performance/talent coordinator joins evidence across reviews and succession without granting assessment or selection authority. |
| talent-mobility | retention | 4 | **None** | proposed:performance-talent | A shared performance/talent coordinator joins evidence across reviews and succession without granting assessment or selection authority. |
| workforce-change | engagement | 4 | **None** | employee-changes | Extend existing organization-change coordination using deterministic scenario/report tools; no separate planning agent is justified before demand and controls are known. |
| workforce-change | workforce-planning | 4 | **None** | employee-changes | Extend existing organization-change coordination using deterministic scenario/report tools; no separate planning agent is justified before demand and controls are known. |
| workforce-change | change-support | 4 | **None** | employee-changes | Extend existing organization-change coordination using deterministic scenario/report tools; no separate planning agent is justified before demand and controls are known. |
| employee-relations | grievances | 6 | **None** | proposed:employee-relations | Contested cases and independent adjudication justify a distinct coordinator, not extending a generic compliance checklist. |
| employee-relations | investigations | 4 | **None** | proposed:employee-relations | Contested cases and independent adjudication justify a distinct coordinator, not extending a generic compliance checklist. |
| employee-relations | discipline | 4 | **None** | proposed:employee-relations | Contested cases and independent adjudication justify a distinct coordinator, not extending a generic compliance checklist. |
| employee-relations | ethics | 4 | **None** | proposed:employee-relations | Contested cases and independent adjudication justify a distinct coordinator, not extending a generic compliance checklist. |
| wellbeing-compliance | safety | 4 | compliance | compliance | Existing Compliance is broad: retain specialist handoffs and never interpret its mapping as legal, medical or screening authority. |
| wellbeing-compliance | accommodations | 4 | compliance | compliance | Existing Compliance is broad: retain specialist handoffs and never interpret its mapping as legal, medical or screening authority. |
| wellbeing-compliance | wellbeing | 4 | **None** | benefits | Extend Benefits to nonclinical wellbeing navigation; keep clinical/safety judgments outside the agent. |
| wellbeing-compliance | labor-relations | 4 | compliance | compliance | Existing Compliance is broad: retain specialist handoffs and never interpret its mapping as legal, medical or screening authority. |
| wellbeing-compliance | compliance-audit | 4 | compliance | compliance | Existing Compliance is broad: retain specialist handoffs and never interpret its mapping as legal, medical or screening authority. |
| mobility-exit | immigration | 4 | mobility | mobility | Keep Mobility as handoff coordinator; do not give it independent legal or tax decision authority. |
| mobility-exit | relocation | 4 | mobility | mobility | Keep Mobility as handoff coordinator; do not give it independent legal or tax decision authority. |
| mobility-exit | remote-work | 4 | mobility | mobility | Keep Mobility as handoff coordinator; do not give it independent legal or tax decision authority. |
| mobility-exit | restructuring | 4 | **None** | offboarding | Extend Offboarding to restructure coordination with independent Compliance/ER decisions, not a dedicated redundancy execution agent. |
| mobility-exit | termination-offboarding | 4 | offboarding | offboarding | Extend Offboarding to restructure coordination with independent Compliance/ER decisions, not a dedicated redundancy execution agent. |
| mobility-exit | retirement-alumni-rehire | 4 | offboarding | offboarding | Extend Offboarding to restructure coordination with independent Compliance/ER decisions, not a dedicated redundancy execution agent. |
| onboarding | onboarding-cancellation | 5 | onboarding | onboarding | Keep coordination with Onboarding, but readiness scoring, attendance, activation and professional decisions are separate records. |

## Every existing agent

Exact current, proposed accountable, collaborator and affected keys are enumerated per role in JSON. No current mappings are edited.

| Role | Recommendation | Responsibility change | Missing capabilities |
|---|---|---|---|
| Onboarding Agent | update | Retain accepted-offer readiness; explicitly hand worker-master setup to Employee Changes and application/learning/asset outcomes to their coordinators. | Evidence-revision readiness bridge; Source-attested actual start; Human probation/readiness receipts |
| Offboarding Agent | update | Add restructure coordination, with Compliance/ER consultation and human decisions; preserve unavailable final closure. | Consultation ledger; Source-attested downstream receipts; Approved closure specification |
| Employee Changes Agent | update | Add explicit worker-master setup, data-quality/reporting and governed workforce-change coordination. | HRIS versioned read/write bridge; Deterministic report reconciliation; Approved workforce planning assumptions |
| Payroll Agent | update | Retain pay coordination; distinguish reward decisions, time approval, calculation, release and filing/remittance receipts. | Payroll calculation/result bridge; Bank/authority reconciliation; Segregated controller approvals |
| Benefits Agent | update | Add nonclinical wellbeing navigation; keep carrier decisions, pension advice and clinical/crisis judgments human/provider-owned. | Carrier/expense/pension receipts; Consent-bound EAP handoff; Urgent welfare escalation protocol |
| Leave Agent | update | Retain absence entitlement; explicitly collaborate with Time & Attendance and Payroll for payable-time handoffs. | Versioned entitlement API; Payable-time receipt reconciliation; Protected-leave human review |
| Compliance Agent | update | Retain coordination but replace implied general professional ownership with named screening/safety/legal/occupational-health handoffs; collaborate on ER and restructuring. | Source verification bridge; Named professional decision receipts; Restricted evidence projection |
| IT Access Agent | update | Retain reusable access coordinator; add explicit cancellation revocation collaboration and separate request communication from IAM completion. | Scoped IAM adapter; Owner approval bridge; Authoritative state readback |
| Learning Agent | update | Retain learning/credential/career coordination; distinguish policy acknowledgment from learning and succession/ratings from development. | LMS receipt bridge; Credential source validation; Equivalency/funding approvals |
| Mobility Agent | update | Retain transfers/immigration/remote-work coordination with explicit country approval and source cutover dependencies. | Country policy/approval bridge; Immigration authoritative status; Generation-fenced cutover receipts |
| Documents & Records Agent | update | Retain document/record coordination; collaborate on policy acknowledgments and governed report disclosures without activating deferred privacy workflows. | Repository/e-sign receipts; Hold-aware disclosure bridge; Source/version custody |
| HR Helpdesk Agent | update | Keep front-door triage and knowledge; hand recruiting outcomes to Recruiting while retaining published FAQs as collaborator. | Approved source grounding; Domain-specific disposition handoffs; Delivery evidence |
| Assets & Workplace Agent | update | Keep support role; explicitly collaborate on cancellation recovery and exit controls, distinguishing shipment, custody and facilities access. | Asset/facility source bridge; Shipping/custody receipt reconciliation |
| Document Verification Agent | update | Keep evidence support without accountable domain ownership; distinguish malware/local checks, source authentication and professional adjudication. | Authenticated source verification; Quarantine-aware evidence bridge; Human uncertainty/adverse review |
| Systems Watcher Agent | keep | Retain health observation support; do not add atomic domain ownership or treat connector watchers as this registered principal. | Explicit registered-principal watcher bridge; Independently verified health/escalation receipts |

## Candidate decisions

Targets show related/current definitions, not aliases or proposed execution bindings.

| Candidate | Classification | Confidence | Related canonical keys | Decision evidence/reason | Source locator |
|---|---|---|---|---|---|
| standalone-access-request | alias/context variant | high | provision-role-access | Same application-role grant and IAM completion record outside onboarding; not an execution alias and not a second definition. | research/intent-agent-coverage.json#candidateGaps/standalone-access-request; intent-catalog.ts standalone/composition contract |
| safety-incident-report | already covered | high | safety-incident-report | Historical candidate is now a source and canonical definition. Existing generic contract/capability gaps do not make it a missing definition. | research/intent-agent-coverage.json#candidateGaps/safety-incident-report; research/hro-master-intent-taxonomy.json#safety-incident-report |
| goal-setting | already covered | high | goal-setting | Historical candidate is now a source and canonical definition. Existing generic contract/capability gaps do not make it a missing definition. | research/intent-agent-coverage.json#candidateGaps/goal-setting; research/hro-master-intent-taxonomy.json#goal-setting |
| recruiting-process-question | already covered | high | recruiting-process-question | Historical candidate is now a source and canonical definition. Existing generic contract/capability gaps do not make it a missing definition. | research/intent-agent-coverage.json#candidateGaps/recruiting-process-question; research/hro-master-intent-taxonomy.json#recruiting-process-question |
| job-requirements-question | already covered | high | job-requirements-question | Historical candidate is now a source and canonical definition. Existing generic contract/capability gaps do not make it a missing definition. | research/intent-agent-coverage.json#candidateGaps/job-requirements-question; research/hro-master-intent-taxonomy.json#job-requirements-question |
| job-recommendation-request | already covered | high | job-recommendation-request | Historical candidate is now a source and canonical definition. Existing generic contract/capability gaps do not make it a missing definition. | research/intent-agent-coverage.json#candidateGaps/job-recommendation-request; research/hro-master-intent-taxonomy.json#job-recommendation-request |
| candidate-application-status | unresolved | medium | progress-candidate, recruiting-process-question | Personal application-stage response is distinct from changing stage, but the old draft does not establish an inspected exact source outcome/contract. Seek ATS scope and source evidence before proposing a leaf. | research/drafts/hro-master-gap-review.md recruiting candidates; master candidate-progression service |
| candidate-interview-preparation | unresolved | low | recruiting-process-question, job-requirements-question | May be grounded recruiting information rather than a separate completion record; no sufficiently specific inspected source supports a new definition. | research/drafts/hro-master-gap-review.md recruiting candidates |
| create-performance-improvement-plan | genuinely new outcome | medium | record-improvement-milestone, review-improvement-plan, close-improvement-plan | Recording milestones, reviewing and closing assume a plan already exists. Initial approved plan establishment has its own record and is absent; probation plan is a different lifecycle. | research/sources/master-talent-01.md formal processes paragraph: recording objectives, periodic performance reviews and improvement plans for underperformance; master improvement service |
| performance-rating-calibration | unresolved | medium | complete-performance-review | Service label mentions calibration but no leaf does. Need evidence that panel calibration is a separate authoritative record rather than an internal review step. | master reviews-calibration service label; research/sources/master-talent-01.md performance ratings/reviews discussion |
| bgv-notice-dispute-vendor-outcomes | already covered | high | request-bgv-disclosure-authorization, collect-bgv-document, record-bgv-vendor-result, deliver-bgv-report-copy, issue-bgv-pre-adverse-notice, record-bgv-dispute, issue-bgv-adverse-action-notice | All seven proposed source outcomes already exist; document types are context, not new intent keys. | research/drafts/hro-master-gap-review.md BGV list; research/sources/master-hire-03.md; master background-screening service |
| privacy-intake-deadline-redaction-response | already covered | high | acknowledge-privacy-request, set-privacy-request-deadline, request-privacy-clarification, complete-privacy-search-and-review, redact-privacy-response, deliver-privacy-response | Older missing-leaf advice is superseded; privacy operational activation stays deferred. | research/drafts/hro-master-gap-review.md privacy list; master privacy-rights service |
| payroll-remittance-return-reconciliation | already covered | high | submit-payroll-return, remit-payroll-liability, reconcile-payroll-liability, record-returned-payroll-payment | Separate authority receipts and bank-return outcomes are now present; tools remain unverified. | research/drafts/hro-master-gap-review.md payroll list; master statutory-pay/pay-release services |
| payable-time-interface | already covered | high | convert-absence-to-payable-time, send-payable-time-interface, resolve-payable-time-interface-exception | Conversion, target receipt and interface exception exist as distinct definitions. | research/sources/master-pay-02.md Oracle absence/time/payroll integration; master absence-maintenance service |
| grievance-meeting-appeal-evidence | already covered | high | schedule-grievance-meeting, process-grievance-appeal, collect-investigation-evidence, issue-investigation-finding | Old missing-outcome advice now points to existing keys; restricted execution remains separate. | research/drafts/hro-master-gap-review.md ER list; master grievances/investigations services |
| mandatory-learning-assignment | alias/context variant | high | assign-learning | Two source leaves share the same assignment record; mandatory status is context. This is the one current canonical consolidation. | intent-catalog.ts canonicalKey and learning contract; master assign-mandatory-learning and assign-learning |
| frontline-release | unresolved | medium | check-day-one-readiness, activate-employment, assign-learning | Explicit site/safety release evidence may need its own outcome; generic readiness is not professional release. Agree authoritative record and scope before adding a definition. | intent-catalog.ts additionalFamilies/frontline; artifacts/api-server/src/lib/onboarding/frontline-operations.ts |
| controlled-workforce-transfer | already covered | medium | domestic-transfer, cross-border-relocation, complete-relocation-transfer | Transfer planning and source-attested cutover fit existing keys; country-specific approval is policy context, not a duplicated country intent. | intent-catalog.ts additionalFamilies/workforce-transfer; artifacts/api-server/src/lib/onboarding/workforce-transfer.ts |
| early-tenure-probation | already covered | high | complete-first-week-check-in, create-probation-plan, record-probation-check-in, confirm-probation, extend-probation, fail-probation | Distinct probation outcomes already exist; historical authority receipts and actual-start fencing remain implementation prerequisites. | master probation-onboarding-change; artifacts/api-server/src/lib/onboarding/early-tenure.ts |
| talent-at-risk | already covered | medium | analyze-retention-signal, create-retention-action | Signal review and human follow-up are covered conceptually. Predictive model validation is a capability gap, not an intent addition; the active model implementation is not changed. | research/hro-master-intent-taxonomy.json#retention; separate Talent at Risk workstream not execution-verified in this assessment |
| candidate-resume-integrity-review | unresolved | medium | resolve-verification-discrepancy, adjudicate-screening-exception | Candidate resume verification may be distinct from work eligibility and screening. No inspected source-specific final record justifies conflating them or adding a definitive misconduct outcome. | master identity-right-to-work/background-screening boundaries; workforce early-warning product scope |
| offboarding-final-closure | unresolved | high | offboarding-exit, complete-exit-controls | Missing section 4.6 blocks closure requirements. Do not manufacture a closure outcome or revive retired execution. | intent-catalog.ts Offboarding family rationale; offboarding closure specification boundary |

## Proposed additional roles: alternatives and gates

### Recruiting Coordination Agent

- Boundary: Candidate/requisition/offer coordination before accepted-offer handoff; no selection or eligibility decision.
- Extend existing role instead: Extending Onboarding conflates pre-offer selection with post-acceptance readiness; Helpdesk remains suitable for public process FAQs but not ATS progression.
- Deterministic alternative: Use deterministic ATS transitions/templates for simple approved moves; a coordinator is justified only for multi-party exceptions and handoffs.
- Justification: Distinct candidate lifecycle, ATS evidence and recruiter accountability; approve only if recruiting is in the product delivery scope.
- Affected canonical outcomes: recruiting-process-question, job-requirements-question, job-recommendation-request, referral-question, resolve-referral-eligibility, create-requisition, create-candidate-profile, progress-candidate, generate-approved-offer.
- Current support: not registered or implemented; proposal only.

### Compensation & Rewards Coordination Agent

- Boundary: Reward-plan and award coordination, excluding payroll calculation, pay decisions and investment/tax advice.
- Extend existing role instead: Payroll receives approved pay inputs; letting it own discretionary reward proposals and approval weakens segregation of duties.
- Deterministic alternative: Plan formulas, eligibility/budget checks and postings belong in deterministic tools; use a coordinator for approvals/exceptions, not calculations.
- Justification: Distinct plan versions, discretionary decisions and reward/equity ledgers; no separate equity or recognition agent needed.
- Affected canonical outcomes: validate-compensation-change, approve-compensation-change, apply-compensation-change, correct-bonus-result, submit-commission-input, validate-incentive-eligibility, record-equity-tax-event, nominate-recognition, issue-recognition-award.
- Current support: not registered or implemented; proposal only.

### Time & Attendance Coordination Agent

- Boundary: Worked time, schedules, overtime and payroll cutoff handoffs; Leave retains entitlement decisions.
- Extend existing role instead: Leave could absorb low-volume time requests, but worked-time locking, scheduling and overtime have distinct evidence and operational cadence.
- Deterministic alternative: Clock validation and payable-time conversion stay deterministic; reassess need if the existing time platform handles all exception routing.
- Justification: Five explicitly unmapped service groups share one coherent time-to-pay boundary, rather than five agents.
- Affected canonical outcomes: clock-in-out, amend-time-entry, missing-clock-punch, resolve-time-exception, approve-time, lock-time-for-payroll, publish-schedule, schedule-change-request, approve-schedule-change, overtime-inquiry, approve-overtime, provide-attendance-report, time-quota-question, timesheet-reminder-dispute, public-holiday-question.
- Current support: not registered or implemented; proposal only.

### Performance & Talent Coordination Agent

- Boundary: Review/talent/succession/retention coordination; no ratings, selection, attrition conclusions or resume-integrity determinations.
- Extend existing role instead: Learning supports development but cannot own manager ratings or talent-panel choices; Employee Changes owns records, not evaluation.
- Deterministic alternative: Calendars and plan validation use deterministic tools; qualitative evidence handoff may justify coordination after criteria and human review are approved.
- Justification: Shared review evidence and human-panel boundary across seven services. Talent at Risk model implementation remains a separate workstream.
- Affected canonical outcomes: goal-setting, align-goal-to-team, approve-goal, complete-check-in, give-feedback, acknowledge-feedback, performance-cycle-question, complete-performance-review, communicate-review-outcome, record-improvement-milestone, review-improvement-plan, close-improvement-plan, nominate-talent, record-readiness-evidence, conduct-talent-review, communicate-development-action, identify-critical-role, propose-successor, approve-succession-plan, monitor-successor-coverage, analyze-retention-signal, create-retention-action, audit-recognition-equity, redeem-recognition.
- Current support: not registered or implemented; proposal only.

### Employee Relations Coordination Agent

- Boundary: Restricted concern, investigation, hearing and appeal coordination; humans own findings and sanctions.
- Extend existing role instead: Compliance remains a collaborator; its current broad mapping does not provide conflict-separated ER case stewardship.
- Deterministic alternative: Deadline calculation, chain-of-custody and access/hold checks must be deterministic; sensitive deliberation must not be delegated to an AI decision maker.
- Justification: Contested evidence, independent review and restricted case access are a distinct boundary; approve only with an ER sponsor and restricted-system plan.
- Affected canonical outcomes: grievance-intake, acknowledge-grievance, conduct-grievance-investigation, issue-grievance-outcome, triage-allegation, open-restricted-investigation, collect-investigation-evidence, issue-investigation-finding, request-disciplinary-review, issue-disciplinary-allegation-notice, record-disciplinary-hearing, issue-disciplinary-outcome, submit-ethics-disclosure, assess-retaliation-risk, resolve-conflict-of-interest, close-ethics-case, schedule-grievance-meeting, process-grievance-appeal.
- Current support: not registered or implemented; proposal only.
