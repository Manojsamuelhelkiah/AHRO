# Research Notes: HRO Intent Coverage and Agent Responsibilities

**Status:** complete; independent architecture review passed
**Depth:** Standard

## Plan

- **Question:** What evidence-led HRO intent/sub-intent taxonomy should replace the unrecoverable remembered 69-row baseline, and which specialist capability should own each outcome?
- **Scope:** Reconcile the current 60 reference intents and development custom-intent boundary; inspect SAP and identifiable open-source provenance; map modelled versus executable coverage; recommend specialist boundaries and one compound onboarding action graph. Do not implement agents or integrations.
- **Audience:** HRO product owners, enterprise architects, and implementation leads.
- **Deliverable:** Source-linked report, source registry, and machine-readable coverage matrix.

## Focus Areas

| # | Area | Status | Sources |
|---|---|---|---|
| 1 | SAP core HR, payroll, time, and benefits scope | complete | 7 captured SAP pages/results |
| 2 | SAP hire, learning, mobility, separation, policy, and privacy scope | complete | 6 captured SAP pages/results |
| 3 | Identifiable open-source HR intent datasets and licensing | complete | 6 screened datasets/repositories |
| 4 | Agent/tool boundaries, orchestration, HITL, and transaction safety | complete | 5 technical sources |
| 5 | Current 60-row catalog, custom-intent boundary, and runtime execution | complete | workspace audit |

## Coverage Checklist

- [x] Establish what “69 intents” can and cannot mean without the historical row-level snapshot.
- [x] Trace every canonical intent/sub-intent to a saved public source or clearly marked product-curated evidence.
- [x] Separate reference, custom, retired, alias, parent-intent, and sub-intent counts.
- [x] Assign one accountable specialist capability to every canonical outcome.
- [x] Distinguish catalogued, modelled, simulated, integrated, verified, and unsupported coverage.
- [x] Show a compound onboarding transaction with parallel work, dependencies, approval gates, idempotency, retries, and source-confirmed completion.
- [x] Identify the smallest safe implementation sequence and missing integrations.

## Findings Log

_[@key] markers reference sources in `research/sources.json`; they become numbered citations in the final report._

### SAP core HR, payroll, time, and benefits

- SAP Employee Central documents editable worker information including emergency contact, payment information, work-permit information, and global assignment details. [@sap-employee-data]
- SAP payroll documentation directly supports pay-statement access and payment history. [@sap-pay-statement]
- SAP Time Management separates absence handling (Time Off) from attendance handling (Time Sheet/Time Tracking) and documents workflow/payroll/reporting integration. [@sap-time-management]
- Benefits evidence directly supports reimbursement claims; enrollment evidence was captured at search-result level. [@sap-benefits-claims] [@sap-benefits-enrollment]

### SAP hire, learning, mobility, separation, policy, and privacy

- SAP onboarding programs are collections of tasks with responsible groups; examples include buddy assignment and equipment, with task auto-completion and notifications. [@sap-onboarding-tasks]
- Enterprise Service Management supports HR case handling, request automation, knowledge, and employee self-service, but does not establish this project's exact intent list. [@sap-esm]
- SAP data-retention documentation supports configurable retention and purge requests. It is adjacent to, but not complete evidence for, DSAR export orchestration. [@sap-data-retention]

### Open-source datasets

- HR-MultiWOZ is the strongest task-oriented HR service source found: 550 synthetic, fully labelled conversations across 10 service values with an MIT license label. Its card says it is not intended for training. [@hr-multiwoz]
- Avature is the strongest intent-classification source found: 1,199 English utterances, 34 expert-derived labels, Apache-2.0, and a published-paper reference. It is a test set and is recruiting/policy-heavy. [@avature-hr-intents]
- Generic Kaggle intent data are not HR; Kaggle attrition data are analytics, not intent labels. [@kaggle-generic-intents] [@kaggle-ibm-attrition]

### Agent architecture and transaction safety

- Keep the coordinator in control and call specialists as bounded capabilities; hand off only when the specialist should own the conversation branch. [@openai-orchestration]
- Use deterministic sequential/concurrent workflow structure for dependencies and independent branches; AI choice should not control hard prerequisites. [@azure-agent-patterns]
- Consequential tool calls need explicit approval, and retries/compensation need durable workflow state rather than model memory. [@microsoft-tool-approval] [@temporal-error-handling] [@azure-compensating-transaction]

### Current workspace

- Current fixed catalog has 60 flat rows across 10 domains; no parent/sub-intent fields.
- Development API observation on 2026-09-08: 60 reference + 2 active custom intents; environment totals are not a historical source baseline.
- Current onboarding engine coordinates a fixed pipeline. BGV, ITSM, and payroll are simulated status adapters; dashboard specialist cards are not proof of independent executable agents.
- Reconciliation result: 60 reference sub-intents grouped under 38 non-counting parent intents; six source-supported labels remain product-scope candidates.
- Provenance edges now distinguish exact external labels, family-scope evidence, and product-curated decompositions; only exact-label edges are aliases.
- Runtime maturity result: 58 unsupported reference outcomes, two simulated onboarding outcomes, and no integrated reference-intent route. Similar internal status capability is recorded separately; none are production-E2E verified.

## Conflicts & Open Questions

- The historical 69-row list was synthesized from SAP and open-source data, but no preserved row-level file or source-to-row mapping exists.
- “Intent” may mean employee outcome, transaction family, source training label, or implementation route; counts are incomparable until taxonomy rules are fixed.
- Public source availability and licenses may permit citation but not redistribution of training utterances.
- HR-MultiWOZ's MIT license label conflicts with its card's “not intended for training” statement; reuse needs separate review.

## Gaps

- Exact historical nine-row difference cannot be reconstructed without the original snapshot; the final report must reconcile evidence rather than pad to 69.
- Some SAP pages were captured only as search-result evidence and are marked lower-confidence in the source registry.
- No live employee-origin HR service-intent corpus with explicit licensing and verified non-synthetic provenance was found in this pass.

## Review and Validation

- `node research/validate-deliverables.mjs` passes catalog/CSV/JSON reconciliation, source-edge integrity, compound-plan graph and safety invariants, schema samples, and documented adversarial contract decisions.
- Independent architect review passed with no blockers. This is a research/design validation, not production-runtime verification.