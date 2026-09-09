## Canonical hierarchy

1. **Maintain worker and person master data**
   - Identity, legal name, date-of-birth, and government-ID correction completed
   - Preferred name, pronouns, and communication preference updated
   - Home address, personal contact, emergency contact, or dependent contact updated
   - Work contact, location, cost center, manager, or work schedule assignment corrected
   - Duplicate person records identified and merge decision completed
   - Worker record data-quality exception resolved with source and audit evidence

2. **Establish and govern organizations and positions**
   - Organization created, changed, inactivated, or hierarchy effective-dated
   - Organization manager or delegated approver assignment updated
   - Position created with job, grade, location, FTE, budget, and effective date
   - Position attributes/funding changed effective-dated
   - Position frozen, closed, reopened, or reclassified
   - Vacancy, headcount, manager-span, or hierarchy data-quality exception resolved

3. **Administer employment and contingent-worker relationships**
   - Employee employment record created and activated
   - Contingent worker engagement created with supplier, assignment, access/end-date controls
   - Employment/engagement extension completed
   - Worker type, legal employer, contract, or assignment conversion completed
   - Concurrent assignment added, changed, or ended
   - Contingent-worker engagement ended and downstream access/offboarding handoff issued

4. **Execute employment lifecycle changes**
   - Promotion, demotion, lateral move, or job change effective-dated
   - Manager, organization, location, cost center, or work-pattern transfer effective-dated
   - Leave/start-return employment-status change recorded and routed to dependent services
   - Pay-impacting employment change submitted to payroll with approval evidence
   - Termination, retirement, resignation, or end-of-contract recorded
   - Rehire eligibility/result and new employment relationship established

5. **Produce, execute, and retain HR documents and letters**
   - Requested standard employment letter generated and delivered
   - Contract, amendment, change confirmation, or termination letter generated from approved terms
   - Required document collected, classified, linked to the correct worker, and completeness verified
   - Document sent for e-signature and signature completion/reminder outcome recorded
   - Incorrect/outdated document superseded while preserving governed version history
   - Worker received a permitted copy of their employment document

6. **Resolve HR service, policy, and knowledge needs**
   - HR inquiry answered from approved current knowledge with source citation
   - Policy/procedure interpretation escalated and authoritative response delivered
   - HR case created, classified, routed, and assigned to the accountable queue
   - HR case transferred, escalated, suspended/resumed, or split into child tasks
   - HR case resolved, requester notified, and closure evidence recorded
   - Knowledge article created, reviewed, approved, published, revised, or retired

7. **Enable employee and manager self-service**
   - Employee self-service request authenticated, validated, and completed
   - Manager self-service transaction completed within delegated authority
   - Delegation created, changed, expired, or revoked with effective dates
   - Requester receives status, missing-information request, decision, or next-step notification
   - Self-service access/entitlement issue resolved or routed to IAM

8. **Govern records, privacy, data quality, and HR insight**
   - Personnel record retained, disposition-held, archived, or securely destroyed under schedule
   - Worker record access restricted or corrected after access-control review
   - Subject access request recognized, logged, identity-verified, and deadline set
   - Subject access request searches completed, third-party/legal review documented, and response delivered
   - Rectification request assessed and personal data corrected or refusal explained
   - Other privacy request (erasure, restriction, objection, portability where applicable) fulfilled or lawfully refused
   - HR metric/report generated from governed definitions and delivered to authorized audience
   - HR report access, scheduled delivery, or data extract entitlement provisioned/revoked
   - Reported data anomaly reconciled and metric restated/corrected where required

## Agent and execution mapping

| Leaf/tight group | Accountable specialist; collaborators | Systems; read/write pattern | Approval/risk | Completion evidence |
|---|---|---|---|---|
| Person-data corrections, contacts, duplicate resolution | HR operations data steward; employee, manager, HRIS, payroll/IAM as affected | HRIS person/worker master reads; effective-dated HRIS writes; identity/document store reads; downstream event writes | Verify requester and source; restrict legal IDs, bank/tax data, sensitive fields; human review for merge or identity conflict | Before/after values, source proof, effective date, downstream-sync status, immutable audit event |
| Org/position lifecycle and data-quality exceptions | Org management/workforce-structure specialist; manager, finance/workforce planning, HRBP | Org/position master reads/writes; headcount/budget and hierarchy integrations read; publish hierarchy events | Budget owner/manager approval; effective-dating and segregation-of-duties checks; local legal entity controls | Approved transaction, resulting hierarchy/position version, budget/control validation, downstream publication receipt |
| Employee/contingent relationship creation, conversion, extension, end | HR operations specialist; recruiting, manager, procurement/vendor management, IT/IAM, payroll | HRIS employment/assignment writes; VMS/supplier record reads/writes; IAM provisioning/deprovisioning events | Validate worker classification, right-to-work/local compliance, supplier authorization, end-date/access controls; human approval for conversion/end exceptions | Active/ended assignment state, approved terms, required documents, provisioning/deprovisioning acknowledgements |
| Job/transfer/status/pay-impacting changes | HR operations specialist; manager, HRBP, compensation, payroll, benefits, IAM | HRIS effective-dated job/assignment writes; payroll/benefits/IAM interface writes; document generation | Manager and delegated approver; compensation/payroll approval for pay impact; prohibit retroactive changes without review | Approved workflow, future/retro change record, interface acknowledgements, issued change letter if required |
| Separation and rehire | HR operations specialist; manager, payroll, benefits, legal, security/IAM | HRIS termination/rehire writes; offboarding task/case system; IAM, payroll, benefits events | Separation reason and date controls; legal hold, local notice, final-pay, and rehire-eligibility review | Termination/rehire effective record, completed offboarding handoffs, notice/letter, final checklist and audit trail |
| Letters, documents, e-signature, document copies | HR document specialist; employee, manager, legal, HR operations | Template/policy repository reads; HRIS fields read; document repository and e-signature writes | Only approved jurisdiction/version templates; human review for nonstandard terms, legal notices, and signature authority | Immutable document version, merge-field validation, delivery/signature receipt, retention classification and link to worker |
| Policy answers and knowledge lifecycle | HR knowledge owner; policy owner, legal/compliance, HR COE | Approved knowledge base reads; proposed-article/version writes; case linkage writes | Agent may answer only from current, authorized content; route ambiguous/regulated interpretation; publication approval required | Cited source/version, answer delivery; for article: author/reviewer/approver, publish/expiry dates |
| Case intake, routing, work, closure | HR service-delivery/case specialist; relevant COE, manager, legal/ER, privacy | Case management read/write; knowledge and HRIS contextual reads; task/notification writes | Confidentiality segmentation; VIP/ER/legal/privacy routing; human decision for discretionary/employee-relations outcomes | Case ID, category/owner/SLA, chronology and attached evidence, requester notification, resolution/closure code |
| Employee/manager self-service and delegation | HR service delivery owner; requester, manager, IAM, HRIS admin | Portal/authentication reads; HRIS/case/workflow writes; IAM role/delegation writes | Strong authentication; delegated authority, scope, end date, and SoD validation; no autonomous approval of restricted transactions | Authenticated submission, validation result, delegation record, transaction/case status and notice |
| Retention, access control, privacy rights | Privacy/records officer; HR operations, legal, security, IT, records manager | Retention schedule and legal-hold reads; records archive/disposition writes; DSAR case, e-discovery/search, redaction package; access logs | Legal hold overrides disposal; least privilege; identity verification; legal/third-party/exemption review. SARs require documented decisions and timely response | Retention/disposition certificate or hold record; access review log; privacy request ID, scope/search log, redaction/exemption rationale, secure response proof |
| HR reporting, access, reconciliation | HR analytics/reporting owner; data steward, finance, HR leaders, privacy/security | Governed semantic layer/reporting reads; scheduled reports/access control writes; issue/correction log writes | Metric-definition approval; aggregate/suppress sensitive outputs; authorized audience; reconcile material restatements | Report version/as-of date, metric definition and lineage, recipient/access audit, reconciliation and correction notice |

## Boundary and alias notes

- **Core HR vs payroll/benefits:** Core HR owns authoritative worker/assignment change and passes approved pay-impacting events downstream. Payroll owns calculation, tax, payment, and payslip correction; benefits owns enrollment/claims.
- **Core HR vs talent/recruiting:** Recruiting owns candidate and offer selection; Core HR owns creation/activation of the worker relationship after the approved handoff. Talent owns performance/learning/succession, except that their documents and status data may be read for records/privacy requests.
- **Core HR vs procurement/VMS:** HR owns worker/person and engagement policy; procurement/vendor management owns supplier commercial terms. “Contractor,” “contingent,” “non-employee,” and “external worker” are local aliases requiring a worker-type policy.
- **Organization vs position:** Organization is the accountable structural unit/hierarchy; position is an authorized seat. “Job,” “role,” and “position” must not be conflated: job is commonly the classification/catalog, role may be security or functional access, and position is a staffed/vacant instance.
- **Transfers and changes:** “Promotion,” “job change,” “transfer,” “manager change,” “cost-center change,” and “status change” should route to distinct leaves because required approvals/downstream effects differ; one business event may orchestrate several leaves.
- **Documents vs records:** Generate/deliver/sign is a document-service outcome; classify/retain/dispose is records management. A document request is not automatically a privacy access request.
- **Cases vs transactions:** A case tracks inquiry, exception, advice, or coordinated work; a transaction changes a system of record. Case closure does not prove a system change unless its transaction receipt is attached.
- **Knowledge vs policy authority:** Knowledge articles provide discoverability and operational guidance; policy owner/legal remains authoritative for policy interpretation and jurisdictional overlays. Do not let an agent synthesize binding advice from stale content.
- **Privacy:** SAR/access, rectification, erasure, restriction, objection, and portability are separate rights/workflows. Do not collapse them under “privacy request”; applicability, retention duties, exemptions, identity checks, and deadlines differ by law.
- **Local overlays:** Country, legal entity, collective agreement, government/federal-public-sector rules, language, retention schedule, signature authority, and data residency must be parameters/controls, not new global parent journeys.
- **Exclusions:** Benefits claims, payroll calculation/payment, recruiting selection, performance management, immigration legal advice, employee-relations investigation decisions, health/medical case decisions, and security account administration are collaborator-owned domains.

## Key facts

- The eCFR personnel-records subpart defines recordkeeping standards covering accuracy, relevancy, timeliness, and completeness; limits collection/use; and calls for administrative, technical, and physical safeguards. This supports distinct data-quality, access-control, and records-security leaves rather than a generic “employee file” intent. Source: https://www.ecfr.gov/current/title-5/chapter-I/subchapter-B/part-293/subpart-A
- The ICO states a worker SAR may be verbal or written and submitted to any part of the organization; an employer should designate a person/team/contact and train staff to recognize requests. Routing must therefore include “SAR recognized and logged,” not only an explicit “DSAR” form. Source: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/subject-access-request-q-and-as-for-employers
- ICO guidance says responses are due without delay and within one month, with a possible extension up to two months for complex/multiple requests; clarification may pause the time limit in limited circumstances. The privacy workflow needs deadline, clarification, and notification outcomes. Source: same URL.
- ICO requires case-by-case, documented justification for exemptions and requires consideration of other individuals’ information. This supports separate search, review/redaction, and response-delivery leaves with human legal/privacy approval. Source: same URL.
- ServiceNow’s official HR case-management documentation exposes employee case creation/view/edit, agent case creation by COE/service, assignment to agents/groups, and transfer/escalation/suspend/resume patterns. Those are routable operational outcomes, not merely “case management” as a module. Source: https://www.servicenow.com/docs/r/yokohama/employee-service-management/hr-service-delivery/c_HRCaseManagement.html
- The same official documentation enumerates case/knowledge management, HR dashboards and reports, personal data rights, employee journey management, document management, e-signature, delegation, and third-party integration in HR service delivery—supporting the connected but separately routed service intents above. Source: same URL.

## Source quality assessment

- **Tier 1 — government/regulator:** eCFR/O.P.M. personnel-record rules and ICO employer SAR guidance are authoritative regulatory sources. The eCFR itself labels its online presentation authoritative but unofficial; use the linked published CFR/GovInfo version for formal legal citation. ICO notes its cited guidance is under review due to the Data (Use and Access) Act, so local counsel should confirm current UK implementation.
- **Tier 1 — official product documentation:** ServiceNow documentation is authoritative evidence of product/service-delivery capabilities, but not a legal or universal-process standard.
- **Tier 2:** No standalone Tier 2 source was needed for the factual claims above; professional-body/analyst validation remains useful for benchmarking operating model and maturity.
- **Tier 3:** No promotional/listicle evidence used.

## Gaps and unanswered questions

- Authoritative jurisdiction-by-jurisdiction retention schedules, employment-change notice/letter rules, signature requirements, and worker-classification rules are still needed; the cited U.S. federal personnel-record rule is not a universal private-sector/global schedule.
- Define the product’s authoritative HRIS, VMS, document repository, IAM, payroll, analytics, and e-discovery integrations, including write permissions and reconciliation ownership.
- Establish enterprise-controlled vocabularies for worker types, job/position/role, employment statuses, separation reasons, organization types, sensitive attributes, and report metrics.
- Confirm which privacy regimes, data residency rules, legal-hold model, redaction standards, and identity-verification method apply; configure deadlines by jurisdiction.
- Set transaction-by-transaction approval matrix, delegation limits, retroactivity limits, escalation SLAs, data-quality thresholds, and evidence-retention requirements.
- Decide whether employee relations, occupational health, immigration, and legal casework use isolated case domains and what minimum metadata may be shared with core HR.

## Sources

1. **eCFR — “5 CFR Part 293 Subpart A: Basic Policies on Maintenance of Personnel Records.”** https://www.ecfr.gov/current/title-5/chapter-I/subchapter-B/part-293/subpart-A. Current eCFR page fetched 2026-09-08; underlying source 44 FR 65033 (Nov. 9, 1979), as displayed. **Tier 1.** Saved evidence: `research/sources/master-core-01.md`.
2. **Information Commissioner’s Office — “Subject access request Q and As for employers.”** https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/subject-access-request-q-and-as-for-employers. No publication date displayed; fetched 2026-09-08. **Tier 1.** Saved evidence: `research/sources/master-core-02.md`.
3. **ServiceNow — “HR Case Management,” Yokohama Employee Service Management documentation.** https://www.servicenow.com/docs/r/yokohama/employee-service-management/hr-service-delivery/c_HRCaseManagement.html. Release Yokohama; no publication date displayed; fetched 2026-09-08. **Tier 1 (official documentation).** Saved evidence: `research/sources/master-core-03.md`.
4. **Information Commissioner’s Office — “Right of access.”** https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/right-of-access/. Date not displayed. **Tier 1.** Saved linked-source evidence/context: `research/sources/master-core-02.md` (the employer SAR guidance links this as its detailed obligations source).
5. **ServiceNow — “Employee Service Management overview.”** https://www.servicenow.com/docs/r/yokohama/employee-service-management/employee-service-management-overview.html. Release Yokohama; date not displayed. **Tier 1 (official documentation).** Saved linked-source evidence/context: `research/sources/master-core-03.md` (product documentation breadcrumb/navigation).
