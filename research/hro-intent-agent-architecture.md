# HRO Intent Coverage and Specialist-Agent Architecture

**Research date:** 2026-09-08  
**Decision status:** Architecture recommendation; no runtime agents or integrations were implemented  
**Companion data:** `intent-agent-coverage.json`, `intent-agent-coverage.csv`, `onboarding-compound-action-plan.json`, `sources.json`

## Executive summary

The project should **not** create one autonomous agent per intent. Keep one **Onboarding Coordinator / Case Lead** accountable for the lifecycle and route bounded work to a small set of specialists. Specialists may use AI for interpretation and planning, but source-system reads, validation, writes, status checks, and completion evidence should be typed tools and durable workflow steps.

The remembered **69-intent corpus cannot be reproduced honestly** from the surviving project. The fixed catalog contains **60 reference sub-intents**, organized in this report under **38 non-counting parent intents**. The development environment had **2 active custom intents** on 2026-09-08, producing the observed API total of 62. Six additional labels are directly supported by the screened public datasets, but they are listed as **candidate gaps**, not inserted merely to approach 69.

The source review also changes the provenance claim:

- SAP documentation substantiates product and service families such as employee data, pay statements, time and absence, benefits, onboarding tasks, HR case management, and data retention. It does not provide the project's exact 60-row list verbatim. [[1]](https://help.sap.com/docs/successfactors-employee-central/implementing-employee-central-core/employee-data-hr-information) [[2]](https://help.sap.com/docs/successfactors-employee-central-payroll/implementing-employee-central-payroll-based-on-sap-human-capital-management-for-sap-erp-hcm/pay-statement) [[3]](https://help.sap.com/docs/successfactors-employee-central/implementing-time-management-in-sap-successfactors/time-management-in-sap-successfactors) [[4]](https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/onboarding-tasks) [[5]](https://www.sap.com/products/hcm/enterprise-service-management.html)
- The captured SAP evidence also supports employee benefit claims/enrollment, performance and learning product scope, offboarding task administration, and configurable data retention. Some of those pages were available only as search-result evidence and are therefore marked lower-confidence in the registry. [[6]](https://help.sap.com/docs/successfactors-employee-central/implementing-global-benefits/79dac2f420c642b2871af2b8d6a6ff5c.html) [[7]](https://help.sap.com/docs/successfactors-employee-central/implementing-global-benefits/900861ba85f14f34b1a22fff1d9adcc9.html) [[8]](https://www.sap.com/products/hcm/performance-goals.html) [[9]](https://www.sap.com/docs/download/agreements/product-policy/css/service-specifications/feature-scope-description-for-sap-successfactors-learning-english-v5-2025.pdf) [[10]](https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/archive-onboarding-offboarding-tasks) [[11]](https://help.sap.com/docs/successfactors-platform/implementing-and-managing-data-protection-and-privacy/data-retention-time-management)
- HR-MultiWOZ is a useful MIT-licensed, synthetic task-oriented HR dialogue source with 550 conversations and ten service labels, including `time_off_report`, `benefits_enrollment`, `training_request`, `performance_review`, `access_request`, and `relocation_request`. Its card says it is not intended for training, so it should be treated as taxonomy/evaluation evidence pending a separate reuse review. [[12]](https://huggingface.co/datasets/xwjzds/hr_multiwoz_tod_sgd)
- Avature provides an Apache-2.0 HR intent-classification **test set** with 1,199 utterances and 34 expert-derived labels. It is especially useful for recruiting, policy, benefits, PTO, parental leave, career development, and escalation labels, but it does not establish a full employee-operations corpus. [[13]](https://github.com/Avature/intent-classification)
- Generic Kaggle chatbot intents and HR attrition tables are not valid evidence for employee-service intent labels. [[14]](https://www.kaggle.com/datasets/sahideseker/chatbot-intent-classification-dataset) [[15]](https://www.kaggle.com/datasets/pavansubhasht/ibm-hr-analytics-attrition-dataset)

## 1. Count reconciliation

### Canonical counting rules

| Class | Count | Included in the 60? | Rule |
|---|---:|---|---|
| Reference sub-intents | 60 | Yes | Fixed rows in `artifacts/api-server/src/data/intents.ts` |
| Parent intents | 38 | No | Grouping nodes; they do not add transaction volume |
| Active custom intents observed | 2 | No | Client/environment extensions, counted separately |
| Source-supported candidate gaps | 6 | No | Require product approval and cost modelling before addition |
| External aliases | variable | No | Mapped to an existing outcome and never double-counted |
| Retired custom intents | environment-specific | No | Retained for historical resolution, excluded from active rollups |

The 60 fixed rows reconcile as:

| Domain | Reference sub-intents | Proposed accountable specialist |
|---|---:|---|
| Pay | 9 | Payroll Operations |
| Leave | 8 | Leave and Absence |
| Time | 5 | Time and Attendance |
| Benefits | 6 | Benefits |
| Hire | 6 | Onboarding, Documents, BGV, and Talent Acquisition according to outcome |
| Develop | 5 | Learning and Development / Performance and Talent |
| Mobility | 5 | Global Mobility / Immigration |
| Retire | 5 | Retirement and Offboarding / Payroll / Documents |
| Data administration | 6 | HR Data and MDM / Privacy / People Analytics |
| Policy | 5 | HR Policy / Employee Relations |
| **Total** | **60** | |

The two active custom intents observed on 2026-09-08 were:

1. `configure-payroll-benefits-enrolment`
2. `check-induction-orientation-complete`

They must remain outside the fixed reference count. Adding them explains the development API total of **62**, but it says nothing about the missing historical 69-row snapshot.

### Why 69 is not a defensible target

1. The original row-level list and its source-to-row mapping are absent.
2. The surviving SAP/GitHub/Kaggle labels in code are broad source buckets, not stable URLs, dataset revisions, or exact external labels.
3. SAP feature documentation describes capabilities and fields, not one canonical conversational taxonomy. [[1]](https://help.sap.com/docs/successfactors-employee-central/implementing-employee-central-core/employee-data-hr-information) [[3]](https://help.sap.com/docs/successfactors-employee-central/implementing-time-management-in-sap-successfactors/time-management-in-sap-successfactors)
4. Open datasets count different things: HR-MultiWOZ uses task-oriented services, while Avature includes recruiting FAQs and conversational controls such as greeting, denial, and escalation. [[12]](https://huggingface.co/datasets/xwjzds/hr_multiwoz_tod_sgd) [[13]](https://github.com/Avature/intent-classification)
5. An HR analytics dataset can inform frequency assumptions, but it cannot prove an intent label or example utterance. [[15]](https://www.kaggle.com/datasets/pavansubhasht/ibm-hr-analytics-attrition-dataset)

**Decision:** retain the current **60** as the fixed baseline, make its hierarchy and provenance explicit, and review the six candidate gaps separately. Do not manufacture three additional rows.

## 2. Evidence-led taxonomy

The machine-readable matrix maps every reference row to:

- one parent intent;
- one accountable specialist capability;
- collaborators and shared capabilities;
- systems touched;
- typed read, validate, decide, write, verify, and audit actions;
- human-approval rules;
- completion evidence;
- exact captured source keys;
- current runtime maturity.

### Parent-intent model

The 38 parent intents are grouping nodes, not independently routed transactions:

| Domain | Parent intents |
|---|---|
| Pay | Pay Documents and Calendar; Payment Data Maintenance; Payroll Corrections and Exceptional Payments; Statutory and Court-Ordered Deductions |
| Leave | Leave Balances, Calendars and Policy; Leave Request Maintenance; Statutory and Medical Leave; Extended Leave Case |
| Time | Attendance Corrections; Schedules and Overtime; Time Records and Quotas |
| Benefits | Benefits Enrollment and Eligibility; Life Events and Dependents; Pension Contributions and Benefit Claims |
| Hire | Onboarding Case and Readiness; Employment Documents; Early-Tenure Confirmation; Employee Referrals; Background Verification |
| Develop | Learning Enrollment; Learning Compliance and Credentials; Education Support; Performance Management |
| Mobility | International Relocation; Work Authorization; Workforce Transfer; Cross-Border Remote Work |
| Retire | Retirement Planning and Initiation; Employee Offboarding; Final Settlement; Former-Worker Documents |
| Data administration | Personal Data Maintenance; Organization Data Corrections; Employee Privacy Rights; Workforce Reporting |
| Policy | Policy Knowledge; Employee Relations Intake; Policy Exceptions |

This hierarchy keeps employee outcomes stable while recording source relationships explicitly as:

- **exact-label** — close enough to map as an alias or subtype;
- **family-scope** — supports the surrounding service family but not this exact row;
- **curated-decomposition** — a product-designed outcome whose surviving broad source bucket has no row-level locator.

Only exact-label relationships become aliases. The accepted examples are:

- HR-MultiWOZ `time_off_report` maps to the existing leave-request outcome.
- HR-MultiWOZ `benefits_enrollment` maps to benefits enrollment.
- HR-MultiWOZ `training_request` maps to training enrollment.
- HR-MultiWOZ `harassment_report` is a sensitive subtype of grievance intake.
- Avature `faq_maternity_paternity_policy` maps to parental-leave guidance.

These are not extra intents because they express an existing outcome at a different granularity. [[12]](https://huggingface.co/datasets/xwjzds/hr_multiwoz_tod_sgd) [[13]](https://github.com/Avature/intent-classification)

Other nearby labels are deliberately **not** aliases: `relocation_request` does not prove cross-border tax/immigration scope; `performance_review` does not equal a process FAQ; `faq_company_benefits` does not prove contract/country eligibility logic; and `faq_remote_work_policy` does not prove a consequential work-from-abroad risk decision. They remain family-scope evidence in the matrix.

### Source-supported candidate gaps

Six exact external labels do not have a clean standalone row in the current catalog:

| Candidate | External evidence label | Proposed owner | Disposition |
|---|---|---|---|
| Standalone system access request | `access_request` | IT Identity and Access | Add only if HRO scope includes access outside onboarding |
| Workplace safety incident report | `safety_incident_report` | Workplace Safety / EHS | Strong candidate; mandatory human safety handling |
| Goal setting | `goal_setting` | Performance and Talent | Add if the product covers active performance transactions |
| Recruiting process question | `faq_recruiting_process` | Talent Acquisition | Add only if candidate support enters scope |
| Job requirements question | `faq_job_requirements` | Talent Acquisition | Same scope decision as recruiting |
| Job recommendation request | `user_wants_job_recommendations` | Talent Acquisition | Same scope decision; human screening remains separate |

The first three come from HR-MultiWOZ and the recruiting labels come from Avature. [[12]](https://huggingface.co/datasets/xwjzds/hr_multiwoz_tod_sgd) [[13]](https://github.com/Avature/intent-classification)

Conversational controls such as greet, goodbye, affirm, deny, and talk-to-human should be shared routing behavior, not business intents. Likewise, `harassment_report` maps into the existing human-led grievance path rather than creating a competing owner.

## 3. Specialist responsibility model

### Coordinator

The **Onboarding Coordinator / Case Lead** owns:

- case identity and lifecycle;
- action graph construction;
- dependencies and parallel branches;
- approvals and waivers;
- idempotency and duplicate suppression;
- retries, timeouts, escalation, and compensation;
- readiness aggregation;
- final handoff and closure.

This is a manager-owned pattern: specialists are bounded capabilities and the coordinator retains the final lifecycle response. OpenAI's orchestration guidance distinguishes this from a handoff, where the specialist takes over the conversation. [[16]](https://developers.openai.com/api/docs/guides/agents/orchestration)

### Initial onboarding specialists

| Specialist | Owns | Does not own |
|---|---|---|
| Worker Records and Documents | Identity/master-data completeness, document requirements, contract/document assembly, HRIS record evidence | Legal judgment without counsel; payroll calculation |
| BGV | Background-check initiation, vendor reconciliation, discrepancy escalation, evidence status | Final employment-risk decision without the named human authority |
| Payroll and Benefits Setup | Payroll profile, tax/bank prerequisites, benefit eligibility/enrollment, source confirmation | Bank-change fraud decision; broad HR policy |
| IT Identity and Access | Joiner identity, role/access requests, approvals, IAM/ITSM confirmation | Deciding a worker's business role |
| Assets and Workplace | Device, badge, facilities and workplace readiness | IAM authority or candidate communications policy |
| Learning and Induction | Mandatory learning, orientation, buddy and manager checkpoints | Performance or disciplinary decisions |

### Shared capabilities, not duplicated agents

- Communication and scheduling
- Policy and knowledge retrieval
- Human approval and evidence capture
- Audit/event recording
- Monitoring, SLA and recovery
- Typed integration execution
- Identity, authorization and privacy enforcement

SAP onboarding tasks support organization-specific task programs, responsible groups, buddy assignment, equipment tasks, completion automation, and notifications; that supports these responsibility boundaries but does not itself imply autonomous agents. [[4]](https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/onboarding-tasks)

### When to use an agent versus a tool

Use an AI specialist when the step requires contextual interpretation, ambiguous evidence synthesis, plan generation, or a bounded recommendation. Use deterministic code/tooling when the step is:

- authorization or entitlement checking;
- required-field and schema validation;
- exact calculation;
- API read/write;
- status retrieval;
- idempotency enforcement;
- retry scheduling;
- source-system confirmation;
- audit recording.

Microsoft's orchestration patterns support sequential and concurrent workflows with deterministically defined stages, while OpenAI describes manager-owned specialists as tools. [[17]](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) [[16]](https://developers.openai.com/api/docs/guides/agents/orchestration) Consequential function calls should expose their proposed name and arguments to an approval gate rather than letting the same model propose and approve the action. [[18]](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval)

## 4. Compound onboarding action graph

```text
Create/resume case
  idempotency: tenant + hiring-request-id
        |
Validate identity, employment profile, geography, role, dates
        |
Deterministic policy gates
  missing data / rehire / transfer / short lead time / special access
        |
Human approval or hard block where required
        |
Build versioned action graph
        |
        +--> Worker record and documents ----+
        |        HRIS employee ID            |
        +--> Background verification --------|
        |        vendor source status         |
        +--> Payroll and benefits ------------|----> Readiness join
        |        depends on HRIS + evidence   |       only source-confirmed
        +--> IT identity and access ----------|       prerequisites satisfy
        |        depends on role/manager      |
        +--> Assets and workplace ------------|
        |        depends on location/start    |
        +--> Learning and induction ----------+
                 depends on role/location
        |
Draft and send communications
  delivery is evidence of communication only, never task completion
        |
Watch source systems / consume callbacks
        |
Retry transient failures; escalate business failures
        |
Named human waiver for unresolved blockers, if policy allows
        |
Evaluate the deterministic required-branch set
  preserve confirmed / waived / not-applicable as distinct dispositions
        |
Day-1 handoff and auditable close
```

### Action state and evidence contract

The complete recommended machine contract is in `onboarding-compound-action-plan.json`. Each action should be persisted with:

- `pending`, `running`, `waiting_external`, `waiting_approval`, `confirmed`, `waived`, `not_applicable`, `unknown_external_effect`, `failed`, `compensating`, `cancelled`, or `manual_repair`;
- a logical external-operation key based on tenant, worker identity, action purpose, target system, and material-input hash; it must not include plan version or attempt number;
- a separate local execution-attempt key that includes the logical operation, plan version, and attempt ordinal;
- case and plan version;
- accountable capability, current lease owner, and monotonic fencing token;
- required input/evidence references;
- canonical tool name and arguments;
- approval proposal hash, authority role, decision, reason, expiry, and bound plan version;
- connector request/response locator;
- next retry and error classification;
- source-system confirmation time;
- compensating action, irreversible effects, and manual-repair owner.

An unrelated replan reuses an already confirmed external effect when the material-input hash is unchanged. Every provider retry uses the same logical key. After an ambiguous timeout, lease expiry, or worker disappearance once dispatch may have started, the coordinator must read/reconcile provider state before resending. A compare-and-set outbox claim plus the current fencing token prevents a stale holder from obtaining a new dispatch claim, but database fencing cannot cancel a remote request already in flight. Provider idempotency or provider-side fencing protects that remaining race. Without it, a negative lookup is insufficient: automatic redispatch is prohibited unless reconciliation positively finds the effect or definitively proves provider-side termination/nonexecution. Otherwise the action becomes `unknown_external_effect` and requires manual repair.

The default retry policy is six attempts with exponential backoff, full jitter, and a one-hour cap. Timeouts, rate limits, provider 5xx responses, and temporary network errors are retryable. Validation, authorization, policy denial, identity mismatch, and source conflict are not. Exhausted actions move to `manual_repair`; they never become complete.

Approvals bind the action ID, logical operation, plan version, tool name, canonical arguments, policy version, evidence references, and exact AND/OR authority requirements through a proposal hash. Execution must reject changed arguments, expired approval, changed plan version, a missing named authority, or a separation-of-duties conflict. For example, changed bank instructions require **both** named fraud-control and payroll approvers; privileged access requires named manager, application owner, and security approvers. A segregation-of-duties conflict is nonwaivable.

Waivers are tenant-, case-, action-, operation-, plan-, authority-, and blocker-specific, time-limited, and disabled by default. Eligibility comes from deterministic policy; role membership alone is insufficient without a named authority ID. Identity mismatch, missing legal consent, legal prohibition, segregation-of-duties conflict, an adverse BGV policy bar, and missing mandatory payroll identity are nonwaivable. A waiver cannot alter source-system state.

Retries should be durable and based on error class; business-rule failures are not transient failures. [[19]](https://docs.temporal.io/design-patterns/error-handling-patterns) Compensation is a forward business operation, not a database rollback, and may have domain-specific ordering. [[20]](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction) The recommended order is dependency-aware: communication correction, access revocation, reservation/order cancellation, enrollment/request cancellation, then document or worker-record correction. Signed agreements, completed checks, settled payroll, delivered messages, and retained audit/security evidence require controlled correction rather than deletion.

### Completion rule

An action disposition is `confirmed` only when its outcome-specific authoritative predicate is true for the current material operation. A policy-valid waiver produces `waived`, never `confirmed`; deterministic applicability evidence produces `not_applicable`. Examples of confirmation predicates include:

- HRIS worker ID exists and required document versions/signature states match;
- BGV provider status is `clear`, or a named adjudicator records an allowed decision;
- payroll worker/pay group, tax prerequisites, and required benefit enrollment are source-confirmed;
- IAM directory identity and approved role assignments exist, and ITSM fulfillment is confirmed;
- asset/workplace reservations have provider-confirmed readiness or delivery dates;
- LMS assignments and orientation records exist at the required curriculum/program version.

Generated text, an attempted API call, an email send, and a local “success” flag are insufficient. Message provider delivery proves communication only.

The required branch set must be derived deterministically from worker type, hire type, country, legal entity, role, location, start date, and policy version, and it must be dependency-closed. A contractor or internal-transfer case therefore does not fabricate payroll or fresh-BGV completion when those branches do not apply. When access or learning applies without an HRIS employment record, those branches bind to an authoritative nonemployee identity resolved from the contractor/vendor registry; otherwise plan construction fails. The readiness join consumes the derived set and preserves `confirmed`, `waived`, and `not_applicable` as evidence-backed, distinct dispositions; `failed` and `unknown_external_effect` always block closure.

## 5. Current implementation truth

The matrix uses the following maturity vocabulary:

| Status | Meaning |
|---|---|
| Catalogued | A reference/custom intent record exists |
| Cost-modelled | Effort, flow class, actions and system counts feed the business case |
| Simulated | An executable flow exists, but at least one authoritative integration is a simulator |
| Integrated | The flow reads/writes a real authoritative dependency for the stated scope |
| Verified | A test or operational check proves the claimed outcome and evidence contract |
| Unsupported | No runtime route or connector contract was found for this intent |

Current fixed-catalog result:

- **60 catalogued**
- **60 cost-modelled**
- **2 simulated**: new-hire setup and BGV follow-up
- **58 unsupported for reference-intent execution**, including onboarding-status
- **0 integrated reference-intent outcomes**
- **0 verified end-to-end against production external systems**

There is an implemented **internal case/task status capability**, but the `onboarding-status` reference intent does not route to it. The matrix records this separately as `internalCapabilityImplemented: true`; it does not count that capability as reference-intent integration. For the two simulated rows, `verificationScope` records simulator/workspace guardrail coverage while `verifiedProductionE2E` remains false.

Key code evidence:

- `artifacts/api-server/src/data/intents.ts` contains the flat 60-row reference catalog.
- `artifacts/api-server/src/data/flow-classes.ts` defines cost-model templates, not runtime execution.
- `artifacts/api-server/src/lib/onboarding/engine.ts` implements one fixed coordinator pipeline.
- `artifacts/api-server/src/lib/onboarding/external-systems.ts` explicitly simulates BGV, ITSM and payroll.
- `artifacts/api-server/src/lib/onboarding/system-watcher.ts` contains durable confirmation/watcher behavior for those simulated systems.
- `artifacts/onboarding-agent/src/pages/dashboard.tsx` includes agent-branded cards, but static presentation is not evidence of independently executable specialists.

## 6. Staged implementation sequence

### Stage 1 — Make the taxonomy executable as a contract

1. Add parent intent, canonical outcome, aliases, owner capability, risk class, action schema, evidence contract, and maturity fields to a versioned registry.
2. Preserve fixed reference intents separately from active/retired client custom intents.
3. Route only to registered actions; reject unknown or retired outcomes explicitly.
4. Add reconciliation tests: every active reference/custom intent has one owner, every action type has an executor, and every counted row has source evidence.

### Stage 2 — Production read and confirmation

1. Replace simulated BGV, ITSM/IAM and payroll status reads with production connectors.
2. Keep writes disabled initially.
3. Normalize source statuses and preserve raw provider evidence.
4. Make callbacks and pollers converge on one idempotent state-transition function.

### Stage 3 — Controlled low-risk writes

1. Enable deterministic writes such as task assignment, approved learning enrollment, or standard access requests.
2. Require source-system approval where configured.
3. Re-read the source after every write.
4. Add compensation and operator repair paths before broad rollout.

### Stage 4 — Bounded specialists

1. Introduce BGV, IT access, payroll/benefits, assets, documents, and induction specialists behind the coordinator.
2. Give each a narrow tool allowlist, evidence schema, SLA, and escalation policy.
3. Keep mobility, grievance, policy exceptions, DSAR, and consequential pay decisions assistive and human-led.
4. Use concurrency only for genuinely independent branches; dependencies remain deterministic. [[17]](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)

### Stage 5 — Corpus expansion

1. Decide whether recruiting, workplace safety, standalone access, and active goal-setting are in product scope.
2. Add approved candidates to the cost model with their own volume assumptions.
3. Pin dataset revisions and complete legal/privacy review before reusing utterances.
4. Do not change the baseline count merely to match the remembered number.

## 7. Limitations and risks

- No historical 69-row snapshot was found, so exact adds/removals cannot be reconstructed.
- SAP evidence is first-party product documentation. It is authoritative for documented product scope but not proof that this project is configured or integrated with those features.
- Several SAP pages were available only as captured search-result evidence; they are marked lower-confidence in `sources.json`.
- HR-MultiWOZ is synthetic and says it is not intended for training despite an MIT license label. Avature is a test set. Training-data reuse needs a separate legal, privacy, and quality review. [[12]](https://huggingface.co/datasets/xwjzds/hr_multiwoz_tod_sgd) [[13]](https://github.com/Avature/intent-classification)
- Other screened resources should not be promoted into row-level provenance: HR Practitioner Seed describes recruiting/policy generation tasks rather than employee-service intents, and Syncora is synthetic HR dialogue without an intent field. [[21]](https://huggingface.co/datasets/15juneee/hr-practitioner-seed-v1) [[22]](https://github.com/syncora-ai/hr-policies-qa-dataset)
- The current broad “GitHub corpus” and “Kaggle analytics” source names should not be presented as row-level provenance.
- Current runtime maturity is derived from code inspection, not production-system credentials or live customer validation.

## Conclusion

Adopt **one coordinator plus bounded specialists**, with deterministic tools and durable action-state management beneath them. Treat the current **60** as the reference baseline, the **2 active custom intents** as separate environment extensions, and the **6 source-supported gaps** as product decisions. This gives every existing outcome an accountable owner without confusing a cost model, a dataset label, a dashboard card, and a production agent.

## Sources

1. [Employee Data - HR Information](https://help.sap.com/docs/successfactors-employee-central/implementing-employee-central-core/employee-data-hr-information) — SAP Help Portal, publication date not stated; accessed 2026-09-08. First-party product documentation; authoritative for SAP field and permission scope, not independent validation. Saved evidence: `research/sources/sap-core-01-employee-data.md`.
2. [Pay Statement](https://help.sap.com/docs/successfactors-employee-central-payroll/implementing-employee-central-payroll-based-on-sap-human-capital-management-for-sap-erp-hcm/pay-statement) — SAP Help Portal, publication date not stated; accessed 2026-09-08. First-party product documentation for pay-statement access and history. Saved evidence: `research/sources/sap-core-02-pay-statement.md`.
3. [Time Management in SAP SuccessFactors](https://help.sap.com/docs/successfactors-employee-central/implementing-time-management-in-sap-successfactors/time-management-in-sap-successfactors) — SAP Help Portal, publication date not stated; accessed 2026-09-08. First-party product documentation for Time Off, Time Sheet, Time Tracking, approvals, payroll and reporting integrations. Saved evidence: `research/sources/sap-core-03-time-management.md`.
4. [Onboarding Tasks](https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/onboarding-tasks) — SAP Help Portal, publication date not stated; accessed 2026-09-08. First-party product documentation for task programs, responsible groups, equipment, buddy, and completion notifications. Saved evidence: `research/sources/sap-lifecycle-01-onboarding-tasks.md`.
5. [SAP SuccessFactors Enterprise Service Management | HR Service Delivery](https://www.sap.com/products/hcm/enterprise-service-management.html) — SAP, publication date not stated; accessed 2026-09-08. First-party product page for HR case handling, self-service, knowledge, and request automation. Saved evidence: `research/sources/sap-lifecycle-03-enterprise-service-management.md`.
6. [Claiming Benefits by Employee](https://help.sap.com/docs/successfactors-employee-central/implementing-global-benefits/79dac2f420c642b2871af2b8d6a6ff5c.html) — SAP Help Portal, publication date not stated; accessed 2026-09-08. First-party product documentation for reimbursement benefit claims. Saved evidence: `research/sources/sap-core-04-benefits-claims.md`.
7. [Latest Benefits Enrollment Experience](https://help.sap.com/docs/successfactors-employee-central/implementing-global-benefits/900861ba85f14f34b1a22fff1d9adcc9.html) — SAP Help Portal, publication date not stated; accessed 2026-09-08. First-party documentation captured as search-result evidence only. Saved evidence: `research/sources/sap-core-snippets.md#s3--latest-benefits-enrollment-experience`.
8. [SAP SuccessFactors Performance & Goals](https://www.sap.com/products/hcm/performance-goals.html) — SAP, publication date not stated; accessed 2026-09-08. First-party product page captured as search-result evidence; sufficient for family-level product scope only. Saved evidence: `research/sources/sap-lifecycle-snippets.md#performance-and-goals-product-capabilities`.
9. [Feature Scope Description for SAP SuccessFactors Learning](https://www.sap.com/docs/download/agreements/product-policy/css/service-specifications/feature-scope-description-for-sap-successfactors-learning-english-v5-2025.pdf) — SAP, 2025-01-01; accessed 2026-09-08. First-party feature-scope result captured as search evidence; PDF not fetched in this pass. Saved evidence: `research/sources/sap-lifecycle-snippets.md#learning-feature-scope`.
10. [Archive Onboarding/Offboarding Tasks](https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/archive-onboarding-offboarding-tasks) — SAP Help Portal, publication date not stated; accessed 2026-09-08. First-party documentation captured as search-result evidence only. Saved evidence: `research/sources/sap-lifecycle-snippets.md#offboarding-task-administration`.
11. [Data Retention Time Management](https://help.sap.com/docs/successfactors-platform/implementing-and-managing-data-protection-and-privacy/data-retention-time-management) — SAP Help Portal, publication date not stated; accessed 2026-09-08. First-party product documentation for retention and purge; not complete DSAR evidence. Saved evidence: `research/sources/sap-lifecycle-04-data-retention-privacy.md`.
12. [HR-MultiWOZ task-oriented dialogue dataset](https://huggingface.co/datasets/xwjzds/hr_multiwoz_tod_sgd) — xwjzds / Hugging Face, 2024-01-01; accessed 2026-09-08. Primary MIT-licensed synthetic HR task-oriented dialogue dataset card with 550 conversations and 10 service labels; card says not intended for training. Saved evidence: `research/sources/oss-datasets-01-hr-multiwoz.md`.
13. [Avature Intent Classification test set](https://github.com/Avature/intent-classification) — Avature, 2024-05-28; accessed 2026-09-08. Primary Apache-2.0 HR intent-classification test-set repository with 1,199 samples, 34 expert-derived labels, method and paper citation. Saved evidence: `research/sources/oss-github-01-avature-intent-classification.md`.
14. [Chatbot Intent Classification Dataset](https://www.kaggle.com/datasets/sahideseker/chatbot-intent-classification-dataset) — Kaggle / sahideseker, publication date not stated; accessed 2026-09-08. Primary CC BY-SA 4.0 synthetic intent dataset page, but retail/general support rather than HR. Saved evidence: `research/sources/oss-datasets-04-kaggle-chatbot-intents.md`.
15. [IBM HR Analytics Employee Attrition & Performance](https://www.kaggle.com/datasets/pavansubhasht/ibm-hr-analytics-attrition-dataset) — Kaggle, publication date not stated; accessed 2026-09-08. Search-only discovery evidence; HR analytics, not utterance/intent taxonomy evidence; license unverified here. Saved evidence: `research/sources/oss-datasets-snippets.md#ibm-hr-analytics-employee-attrition--performance`.
16. [Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration) — OpenAI, publication date not stated; accessed 2026-09-08. First-party technical documentation for manager-owned specialist tools versus handoffs. Saved evidence: `research/sources/agent-architecture-01-openai-orchestration.md`.
17. [AI Agent Orchestration Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) — Microsoft Azure Architecture Center, publication date not stated; accessed 2026-09-08. Established technical architecture guidance for sequential, concurrent, handoff and group-chat patterns. Saved evidence: `research/sources/agent-architecture-02-azure-agent-design-patterns.md`.
18. [Using function tools with human in the loop approvals](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval) — Microsoft Learn, publication date not stated; accessed 2026-09-08. First-party framework documentation for approval-required tool calls. Saved evidence: `research/sources/agent-architecture-04-microsoft-tool-approval.md`.
19. [Error Handling & Retry Patterns](https://docs.temporal.io/design-patterns/error-handling-patterns) — Temporal, publication date not stated; accessed 2026-09-08. First-party durable-workflow documentation for retry, failure classification and recovery patterns. Saved evidence: `research/sources/agent-architecture-03-temporal-error-handling.md`.
20. [Compensating Transaction Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction) — Microsoft Azure Architecture Center, publication date not stated; accessed 2026-09-08. Established technical architecture source captured as search-result evidence only. Saved evidence: `research/sources/agent-architecture-snippets.md#microsoft-azure-architecture-center--compensating-transaction-pattern`.
21. [HR practitioner seed v1](https://huggingface.co/datasets/15juneee/hr-practitioner-seed-v1) — 15juneee / Hugging Face, publication date not stated; accessed 2026-09-08. Primary Apache-2.0 dataset card with traceable upstream sources; recruiting/policy tasks, not employee-service intent labels. Saved evidence: `research/sources/oss-datasets-02-hr-practitioner.md`.
22. [HR Policies Q&A Dataset](https://github.com/syncora-ai/hr-policies-qa-dataset) — syncora-ai, 2025-09-04; accessed 2026-09-08. Primary synthetic HR dialogue repository; dialogue has no intent field and README usage wording creates license ambiguity. Saved evidence: `research/sources/oss-github-03-syncora-hr-policies-qa.md`.
