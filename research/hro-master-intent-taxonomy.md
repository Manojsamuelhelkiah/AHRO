# Comprehensive HRO Intent and Agent Coverage

**Research date:** 9 September 2026  
**Depth:** Deep  
**Sources consulted:** 37 saved or registered sources  
**Taxonomy version:** hro-master-v1

## Executive summary

The recommended product corpus contains **17 HRO journeys, 88 service intents, 320 atomic sub-intents, 1 explicit composite route, and 41 accountable specialist capabilities**. It replaces the misleading idea that broad journeys such as onboarding are single intents. SAP's own onboarding scope is task-program based and spans responsible groups, equipment, buddies, notifications, and completion handling [[1]](https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/onboarding-tasks); employment eligibility and background screening also contain separately controlled document, consent, retention, dispute, and notice outcomes [[2]](https://www.uscis.gov/i-9-central/completing-form-i-9/retention-and-storage) [[3]](https://consumer.ftc.gov/articles/employer-background-checks-your-rights).

The hierarchy now includes **63 onboarding leaves across 13 services**. Examples include requesting BGV documents, recording screening consent, receiving the vendor result, handling a dispute, creating the worker record, collecting tax and bank information, setting pay/time profiles, enrolling benefits, provisioning identity/access, assigning equipment and facilities, issuing learning and policy tasks, coordinating the manager/buddy, checking day-one readiness, recording attendance/no-show, activating employment, managing probation, and cleaning up a cancelled hire.

This is a **target catalog**, not a claim of production automation. Today, one leaf (`background-check-chase`) and one composite route (`new-hire-setup`) are simulated; the other 319 leaves are unsupported by registered runtime executors. There are no integrated or production-verified specialist routes. The product must keep catalog coverage, agent mapping, and execution maturity separate.

“Comprehensive” means a canonical global HRO operating model, not every country rule duplicated as a new intent. Local law, collective agreements, plan rules, data retention, approvals, and entity policy belong in jurisdiction and policy overlays. This prevents corpus explosion while allowing the same canonical intent to behave correctly by worker, country, legal entity, contract, and effective date.

## Final coverage totals

| Journey | Service intents | Atomic sub-intents |
|---|---:|---:|
| Recruit and select | 6 | 9 |
| Onboard and activate workers | 13 | 63 |
| Maintain core HR records | 7 | 21 |
| Documents cases and knowledge | 5 | 17 |
| Govern privacy records and insight | 4 | 16 |
| Run payroll and statutory pay | 6 | 23 |
| Administer compensation and rewards | 4 | 12 |
| Administer benefits and expenses | 4 | 12 |
| Capture time and schedule work | 5 | 15 |
| Administer absence and leave | 4 | 14 |
| Manage performance | 4 | 12 |
| Learn and progress careers | 4 | 16 |
| Deploy and retain talent | 4 | 16 |
| Listen plan and change | 3 | 12 |
| Resolve employee relations | 4 | 18 |
| Protect people and assure compliance | 5 | 20 |
| Enable mobility and manage exit | 6 | 24 |
| **Total** | **88** | **320** |

## Current versus target product coverage

| Coverage layer | Count | Meaning |
|---|---:|---|
| Current reference concepts | 60 | Existing cost-model corpus retained and mapped: 59 atomic leaves plus 1 composite onboarding route. |
| Proposed canonical leaves | 320 | Full target list below; aliases are not counted as separate intents. |
| Custom intents | Environment-specific | Additive tenant outcomes using the same parent, owner, action, evidence, executor, risk, maturity, and version contract. |
| Simulated runtime leaves | 1 | `background-check-chase`. |
| Simulated composite routes | 1 | `new-hire-setup`. |
| Integrated routes | 0 | No live source-system connector execution is evidenced. |
| Production-verified routes | 0 | No end-to-end production executor is evidenced. |
| Unsupported target leaves | 319 | Catalogued/mapped but not executable until an approved executor and evidence contract are registered. |

## How the hierarchy works

- **Journey:** a lifecycle area, such as Onboard and activate workers.
- **Service intent:** a bounded process family, such as Background screening.
- **Atomic sub-intent:** one routable outcome with one accountable specialist and observable completion evidence.
- **Composite route:** an orchestration request that coordinates several atomic sub-intents without pretending to be one source-system write.
- **Alias:** alternative wording that resolves to a canonical node and is never counted as another intent.
- **Custom intent:** a tenant-defined canonical outcome, promoted only after ownership, evidence, actions, registered executors, risk, maturity, and version checks pass.

## Complete intent and sub-intent list

### Recruit and select (6 services, 9 sub-intents)

Create approved requisitions, progress candidates, and conclude offers.

#### Requisition management (1)

- **Create requisition** (`create-requisition`) — Talent Acquisition Operations Specialist. Create requisition is completed and recorded as one authoritative outcome. _medium; fc2-policy; unsupported._

#### Candidate management (1)

- **Create candidate profile** (`create-candidate-profile`) — Talent Acquisition Operations Specialist. Create candidate profile is completed and recorded as one authoritative outcome. _medium; fc2-policy; unsupported._

#### Candidate progression (1)

- **Progress candidate** (`progress-candidate`) — Talent Acquisition Operations Specialist. Progress candidate is completed and recorded as one authoritative outcome. _medium; fc2-policy; unsupported._

#### Offers and contracts (1)

- **Generate approved offer** (`generate-approved-offer`) — Talent Acquisition Operations Specialist. Generate approved offer is completed and recorded as one authoritative outcome. _medium; fc2-policy; unsupported._

#### Recruiting information (4)

- **Recruiting Process Question** (`recruiting-process-question`) — Talent Acquisition Operations Specialist. Recruiting Process Question is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Job Requirements Question** (`job-requirements-question`) — Talent Acquisition Operations Specialist. Job Requirements Question is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Job Recommendation Request** (`job-recommendation-request`) — Talent Acquisition Operations Specialist. Job Recommendation Request is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Referral Question** (`referral-question`) — Talent Acquisition Operations Specialist. Referral Question is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Employee referrals (1)

- **Resolve Referral Eligibility** (`resolve-referral-eligibility`) — Talent Acquisition Operations Specialist. Resolve Referral Eligibility is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Onboard and activate workers (13 services, 63 sub-intents)

Preboard, establish eligibility, enroll, orient, and confirm early-tenure readiness.

#### Onboarding case and readiness (4)

- **Open Onboarding Case** (`open-onboarding-case`) — Onboarding Operations Specialist. Open Onboarding Case is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Onboarding Status** (`onboarding-status`) — Onboarding Operations Specialist. Onboarding Status is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Check day-one readiness** (`check-day-one-readiness`) — Onboarding Operations Specialist. Confirm Readiness Gates is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Remediate Readiness Item** (`remediate-readiness-item`) — Onboarding Operations Specialist. Remediate Readiness Item is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Identity and right to work (4)

- **Request Identity Documents** (`request-identity-documents`) — Screening and Work Eligibility Specialist. Request Identity Documents is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Complete Work Eligibility Verification** (`complete-work-eligibility-verification`) — Screening and Work Eligibility Specialist. Complete Work Eligibility Verification is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Resolve Verification Discrepancy** (`resolve-verification-discrepancy`) — Screening and Work Eligibility Specialist. Resolve Verification Discrepancy is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Schedule Work Authorization Reverification** (`schedule-work-authorization-reverification`) — Screening and Work Eligibility Specialist. Schedule Work Authorization Reverification is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._

#### Background screening (11)

- **Obtain screening consent** (`obtain-screening-consent`) — Screening and Work Eligibility Specialist. Obtain Screening Consent is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Initiate Background Screening** (`initiate-background-screening`) — Screening and Work Eligibility Specialist. Initiate Background Screening is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Background Check Chase** (`background-check-chase`) — Screening and Work Eligibility Specialist. Background Check Chase is completed with a recorded, observable result. _low; fc1-deterministic; simulated._
- **Adjudicate Screening Exception** (`adjudicate-screening-exception`) — Screening and Work Eligibility Specialist. Adjudicate Screening Exception is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Request screening disclosure** (`request-bgv-disclosure-authorization`) — Screening and Work Eligibility Specialist. Screening disclosure is delivered for candidate review. _restricted; fc3-multiagent; unsupported._
- **Collect screening document** (`collect-bgv-document`) — Screening and Work Eligibility Specialist. One requested screening document is collected and linked to the screening case. _restricted; fc3-multiagent; unsupported._
- **Record screening vendor result** (`record-bgv-vendor-result`) — Screening and Work Eligibility Specialist. A vendor screening result is received and recorded without adjudicating it. _restricted; fc3-multiagent; unsupported._
- **Deliver screening report copy** (`deliver-bgv-report-copy`) — Screening and Work Eligibility Specialist. A required screening report copy is delivered to the candidate. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Issue screening pre-adverse notice** (`issue-bgv-pre-adverse-notice`) — Screening and Work Eligibility Specialist. A required pre-adverse notice is issued before an adverse decision. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Record screening dispute** (`record-bgv-dispute`) — Screening and Work Eligibility Specialist. A candidate dispute is received and recorded for adjudication. _restricted; fc3-multiagent; unsupported._
- **Issue screening adverse-action notice** (`issue-bgv-adverse-action-notice`) — Screening and Work Eligibility Specialist. A required adverse-action notice is issued after authorized decision. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._

#### Worker master and employment record (4)

- **Collect Worker Profile** (`collect-worker-profile`) — Worker Data Operations Specialist. Collect Worker Profile is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Create Worker Record** (`create-worker-record`) — Worker Data Operations Specialist. Create Worker Record is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Resolve Duplicate Worker** (`resolve-duplicate-worker`) — Worker Data Operations Specialist. Resolve Duplicate Worker is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Amend Prestart Employment Details** (`amend-prestart-employment-details`) — Worker Data Operations Specialist. Amend Prestart Employment Details is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Payroll tax and time setup (4)

- **Collect tax form** (`collect-tax-form`) — Payroll Operations Specialist. Capture Tax Withholding is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Collect direct deposit** (`collect-direct-deposit`) — Payroll Operations Specialist. Capture Bank Details is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Set payroll group** (`set-payroll-group`) — Payroll Operations Specialist. Assign Pay Group is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Set time and leave profile** (`set-time-leave-profile`) — Payroll Operations Specialist. Assign Time And Leave Eligibility is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Benefits setup (4)

- **Determine New Hire Benefit Eligibility** (`determine-new-hire-benefit-eligibility`) — Benefits Operations Specialist. Determine New Hire Benefit Eligibility is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Enroll benefits** (`enroll-benefits`) — Benefits Operations Specialist. Benefits Enrollment is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Waive benefits** (`waive-benefits`) — Benefits Operations Specialist. Waive New Hire Coverage is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Resolve carrier enrollment error** (`resolve-carrier-enrollment-error`) — Benefits Operations Specialist. Resolve Onboarding Benefit Exception is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Identity and access setup (4)

- **Create Workforce Identity** (`create-workforce-identity`) — IT Identity and Access Specialist. Create Workforce Identity is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Provision Role Access** (`provision-role-access`) — IT Identity and Access Specialist. Provision Role Access is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Privileged Access Exception** (`approve-privileged-access-exception`) — IT Identity and Access Specialist. Approve Privileged Access Exception is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Reset Prehire Access** (`reset-prehire-access`) — IT Identity and Access Specialist. Reset Prehire Access is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Device and facilities setup (6)

- **Request Equipment** (`request-equipment`) — Workplace and Facilities Operations Specialist. Request Equipment is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Assign Equipment Custody** (`assign-equipment-custody`) — Workplace and Facilities Operations Specialist. Assign Equipment Custody is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Provision Site Badge** (`provision-site-badge`) — Workplace and Facilities Operations Specialist. Provision Site Badge is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Provision Workspace Access** (`provision-workspace-access`) — Workplace and Facilities Operations Specialist. Provision Workspace Access is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Ship prehire equipment** (`ship-prehire-equipment`) — Workplace and Facilities Operations Specialist. Ship prehire equipment is completed and recorded as one authoritative outcome. _medium; fc2-policy; unsupported._
- **Record prehire equipment receipt** (`record-prehire-equipment-receipt`) — Workplace and Facilities Operations Specialist. Record prehire equipment receipt is completed and recorded as one authoritative outcome. _medium; fc2-policy; unsupported._

#### Orientation and learning (4)

- **Assign Mandatory Learning** (`assign-mandatory-learning`) — Learning Operations Specialist. Assign Mandatory Learning is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Assign Policy Acknowledgement** (`assign-policy-acknowledgement`) — Learning Operations Specialist. Assign Policy Acknowledgement is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Record Policy Acknowledgement** (`record-policy-acknowledgement`) — Learning Operations Specialist. Record Policy Acknowledgement is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Learning Equivalency** (`approve-learning-equivalency`) — Learning Operations Specialist. Approve Learning Equivalency is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Manager buddy and communications (4)

- **Send Joining Instructions** (`send-joining-instructions`) — Onboarding Operations Specialist. Send Joining Instructions is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Assign Onboarding Buddy** (`assign-onboarding-buddy`) — Onboarding Operations Specialist. Assign Onboarding Buddy is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Schedule Required Introductions** (`schedule-required-introductions`) — Onboarding Operations Specialist. Schedule Required Introductions is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Publish Day One Agenda** (`publish-day-one-agenda`) — Onboarding Operations Specialist. Publish Day One Agenda is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### First-week activation (4)

- **Record First Day Attendance** (`record-first-day-attendance`) — Onboarding Operations Specialist. Record First Day Attendance is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Activate employment** (`activate-employment`) — Onboarding Operations Specialist. Activate Employment On Start Date is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Complete First Week Check In** (`complete-first-week-check-in`) — Onboarding Operations Specialist. Complete First Week Check In is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Record No Show** (`record-no-show`) — Onboarding Operations Specialist. Record No Show is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Probation and onboarding change (5)

- **Create Probation Plan** (`create-probation-plan`) — HR Business Partner / People Manager Operations. Create Probation Plan is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Record Probation Check In** (`record-probation-check-in`) — HR Business Partner / People Manager Operations. Record Probation Check In is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Confirm probation** (`confirm-probation`) — HR Business Partner / People Manager Operations. Probation Confirmation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Extend probation** (`extend-probation`) — HR Business Partner / People Manager Operations. Extend probation is completed and recorded as one authoritative outcome. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Fail probation** (`fail-probation`) — HR Business Partner / People Manager Operations. Fail probation is completed and recorded as one authoritative outcome. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._

#### Onboarding cancellation (5)

- **Cancel hire** (`cancel-hire`) — HR Business Partner / People Manager Operations. The pre-start hire is cancelled with an authorized effective date. _high; fc1-deterministic; unsupported._
- **Revoke prehire access** (`revoke-prehire-access`) — HR Business Partner / People Manager Operations. Prehire digital access is revoked. _high; fc2-policy; unsupported._
- **Recover prehire assets** (`recover-prehire-assets`) — HR Business Partner / People Manager Operations. One issued prehire asset is recovered or recovery exception is recorded. _high; fc2-policy; unsupported._
- **Notify cancelled-hire owners** (`notify-cancelled-hire-owners`) — HR Business Partner / People Manager Operations. Affected accountable owners receive the cancellation notification. _high; fc2-policy; unsupported._
- **Close cancelled-hire case** (`close-cancelled-hire-case`) — HR Business Partner / People Manager Operations. The cancellation case is closed after required downstream statuses are evidenced. _high; fc2-policy; unsupported._

### Maintain core HR records (7 services, 21 sub-intents)

Maintain person, worker, organization, position, and lifecycle records.

#### Person data (3)

- **Address Change** (`address-change`) — Worker Data Operations Specialist. Address Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Name Change** (`name-change`) — Worker Data Operations Specialist. Name Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Emergency Contact Update** (`emergency-contact-update`) — Worker Data Operations Specialist. Emergency Contact Update is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Worker data quality (3)

- **Resolve Worker Data Quality Exception** (`resolve-worker-data-quality-exception`) — HR Data Quality Specialist. Resolve Worker Data Quality Exception is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Restrict Worker Record Access** (`restrict-worker-record-access`) — HR Data Quality Specialist. Restrict Worker Record Access is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Link Person Records** (`link-person-records`) — HR Data Quality Specialist. Link Person Records is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Organization management (3)

- **Change Organization Hierarchy** (`change-organization-hierarchy`) — Organization and Position Management Specialist. Change Organization Hierarchy is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Org Data Correction** (`org-data-correction`) — Organization and Position Management Specialist. Org Data Correction is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Assign Organization Manager** (`assign-organization-manager`) — Organization and Position Management Specialist. Assign Organization Manager is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Position management (3)

- **Change Position Funding** (`change-position-funding`) — Organization and Position Management Specialist. Change Position Funding is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Freeze Position** (`freeze-position`) — Organization and Position Management Specialist. Freeze Position is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Resolve Position Data Exception** (`resolve-position-data-exception`) — Organization and Position Management Specialist. Resolve Position Data Exception is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Employment relationships (3)

- **Extend Employment** (`extend-employment`) — Worker Data Operations Specialist. Extend Employment is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Convert Worker Type** (`convert-worker-type`) — Worker Data Operations Specialist. Convert Worker Type is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Add Concurrent Assignment** (`add-concurrent-assignment`) — Worker Data Operations Specialist. Add Concurrent Assignment is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Contingent workforce (3)

- **Extend Contingent Engagement** (`extend-contingent-engagement`) — Contingent Workforce Operations Specialist. Extend Contingent Engagement is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **End Contingent Engagement** (`end-contingent-engagement`) — Contingent Workforce Operations Specialist. End Contingent Engagement is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Validate Supplier Authorization** (`validate-supplier-authorization`) — Contingent Workforce Operations Specialist. Validate Supplier Authorization is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Employee changes (3)

- **Effective Date Manager Change** (`effective-date-manager-change`) — Worker Data Operations Specialist. Effective Date Manager Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Effective Date Location Transfer** (`effective-date-location-transfer`) — Worker Data Operations Specialist. Effective Date Location Transfer is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Route Pay Impacting Change** (`route-pay-impacting-change`) — Worker Data Operations Specialist. Route Pay Impacting Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Documents cases and knowledge (5 services, 17 sub-intents)

Issue governed documents and resolve HR requests.

#### Employment documents (4)

- **Contract Generation** (`contract-generation`) — HR Document and Records Specialist. Contract Generation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Collect Required Document** (`collect-required-document`) — HR Document and Records Specialist. Collect Required Document is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Send Document For Signature** (`send-document-for-signature`) — HR Document and Records Specialist. Send Document For Signature is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Salary certificate** (`salary-certificate`) — HR Document and Records Specialist. A requested salary certificate is generated from authorized current pay data and delivered. _high; fc2-policy; unsupported._

#### Document governance (3)

- **Deliver Employment Document Copy** (`deliver-employment-document-copy`) — HR Document and Records Specialist. Deliver Employment Document Copy is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Classify Worker Document** (`classify-worker-document`) — HR Document and Records Specialist. Classify Worker Document is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Retain Signed Document** (`retain-signed-document`) — HR Document and Records Specialist. Retain Signed Document is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### HR case management (3)

- **Route Hr Case** (`route-hr-case`) — HR Service Delivery Specialist. Route Hr Case is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Escalate Hr Case** (`escalate-hr-case`) — HR Service Delivery Specialist. Escalate Hr Case is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Resolve Hr Case** (`resolve-hr-case`) — HR Service Delivery Specialist. Resolve Hr Case is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Knowledge and policy (4)

- **Policy Question** (`policy-question`) — HR Knowledge and Policy Specialist. Policy Question is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Escalate Policy Interpretation** (`escalate-policy-interpretation`) — HR Knowledge and Policy Specialist. Escalate Policy Interpretation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Publish Knowledge Article** (`publish-knowledge-article`) — HR Knowledge and Policy Specialist. Publish Knowledge Article is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Code of conduct answer** (`code-of-conduct-question`) — HR Knowledge and Policy Specialist. A code-of-conduct question is answered from an approved current policy source. _low; fc1-deterministic; unsupported._

#### Self-service and delegation (3)

- **Complete Manager Self Service** (`complete-manager-self-service`) — HR Service Delivery Specialist. Complete Manager Self Service is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Create Delegation** (`create-delegation`) — HR Service Delivery Specialist. Create Delegation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Resolve Self Service Access Issue** (`resolve-self-service-access-issue`) — HR Service Delivery Specialist. Resolve Self Service Access Issue is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Govern privacy records and insight (4 services, 16 sub-intents)

Protect records and provide governed HR reporting.

#### Records retention (3)

- **Place Record On Legal Hold** (`place-record-on-legal-hold`) — Privacy and Records Specialist. Place Record On Legal Hold is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Archive Personnel Record** (`archive-personnel-record`) — Privacy and Records Specialist. Archive Personnel Record is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Securely Dispose Record** (`securely-dispose-record`) — Privacy and Records Specialist. Securely Dispose Record is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Privacy rights (7)

- **Data Privacy Request** (`data-privacy-request`) — Privacy and Records Specialist. Data Privacy Request is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Complete Privacy Search And Review** (`complete-privacy-search-and-review`) — Privacy and Records Specialist. Complete Privacy Search And Review is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Deliver Privacy Response** (`deliver-privacy-response`) — Privacy and Records Specialist. Deliver Privacy Response is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Acknowledge privacy request** (`acknowledge-privacy-request`) — Privacy and Records Specialist. Acknowledge privacy request is completed and recorded as one authoritative outcome. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Set privacy request deadline** (`set-privacy-request-deadline`) — Privacy and Records Specialist. Set privacy request deadline is completed and recorded as one authoritative outcome. _restricted; fc2-policy; jurisdiction overlay; unsupported._
- **Request privacy clarification** (`request-privacy-clarification`) — Privacy and Records Specialist. Request privacy clarification is completed and recorded as one authoritative outcome. _restricted; fc2-policy; jurisdiction overlay; unsupported._
- **Redact privacy response** (`redact-privacy-response`) — Privacy and Records Specialist. Redact privacy response is completed and recorded as one authoritative outcome. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._

#### Data quality controls (3)

- **Review Record Access Control** (`review-record-access-control`) — HR Data Quality Specialist. Review Record Access Control is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Resolve Data Anomaly** (`resolve-data-anomaly`) — HR Data Quality Specialist. Resolve Data Anomaly is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Publish Data Quality Remediation** (`publish-data-quality-remediation`) — HR Data Quality Specialist. Publish Data Quality Remediation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### HR reporting (3)

- **Employee Data Report** (`employee-data-report`) — People Analytics and Reporting Specialist. Employee Data Report is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Schedule Governed Report** (`schedule-governed-report`) — People Analytics and Reporting Specialist. Schedule Governed Report is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Restate Hr Metric** (`restate-hr-metric`) — People Analytics and Reporting Specialist. Restate Hr Metric is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Run payroll and statutory pay (6 services, 23 sub-intents)

Operate pay inputs, calculations, payments, corrections, and filings.

#### Pay access and inputs (4)

- **Payslip Copy** (`payslip-copy`) — Payroll Operations Specialist. Payslip Copy is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Bank Details Change** (`bank-details-change`) — Payroll Operations Specialist. Bank Details Change is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Tax Form Copy** (`tax-form-copy`) — Payroll Operations Specialist. Tax Form Copy is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Pay frequency answer** (`pay-frequency-question`) — Payroll Operations Specialist. An authenticated requester receives the applicable pay frequency from the payroll calendar. _low; fc1-deterministic; unsupported._

#### Pay run and payment (3)

- **Off Cycle Payment** (`off-cycle-payment`) — Payroll Operations Specialist. Off Cycle Payment is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Validate Payroll Inputs** (`validate-payroll-inputs`) — Payroll Operations Specialist. Validate Payroll Inputs is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Approve Payroll Result** (`approve-payroll-result`) — Payroll Operations Specialist. Approve Payroll Result is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Pay release and exceptions (5)

- **Confirm Payment Received** (`confirm-payment-received`) — Payroll Operations Specialist. Confirm Payment Received is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Payroll Discrepancy** (`payroll-discrepancy`) — Payroll Operations Specialist. Payroll Discrepancy is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Resolve Payroll Calculation Exception** (`resolve-payroll-calculation-exception`) — Payroll Operations Specialist. Resolve Payroll Calculation Exception is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Final pay answer** (`final-pay-question`) — Payroll Operations Specialist. An authenticated requester receives a status answer for final-pay processing without changing payroll. _high; fc2-policy; unsupported._
- **Record returned payroll payment** (`record-returned-payroll-payment`) — Payroll Operations Specialist. Record returned payroll payment is completed and recorded as one authoritative outcome. _high; fc2-policy; unsupported._

#### Pay corrections and reconciliation (3)

- **Overpayment Recovery** (`overpayment-recovery`) — Payroll Operations Specialist. Overpayment Recovery is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Reconcile Payroll Register** (`reconcile-payroll-register`) — Payroll Operations Specialist. Reconcile Payroll Register is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Close Payroll Cycle** (`close-payroll-cycle`) — Payroll Operations Specialist. Close Payroll Cycle is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Statutory reporting (5)

- **Submit Payroll Return** (`submit-payroll-return`) — Payroll Operations Specialist. Submit Payroll Return is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Produce Year End Tax Document** (`produce-year-end-tax-document`) — Payroll Operations Specialist. Produce Year End Tax Document is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Amend Tax Document** (`amend-tax-document`) — Payroll Operations Specialist. Amend Tax Document is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Remit payroll liability** (`remit-payroll-liability`) — Payroll Operations Specialist. Remit payroll liability is completed and recorded as one authoritative outcome. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Reconcile payroll liability** (`reconcile-payroll-liability`) — Payroll Operations Specialist. Reconcile payroll liability is completed and recorded as one authoritative outcome. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Garnishments and levies (3)

- **Garnishment Query** (`garnishment-query`) — Payroll Operations Specialist. Garnishment Query is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Change Garnishment Withholding** (`change-garnishment-withholding`) — Payroll Operations Specialist. Change Garnishment Withholding is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Remit Garnishment** (`remit-garnishment`) — Payroll Operations Specialist. Remit Garnishment is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

### Administer compensation and rewards (4 services, 12 sub-intents)

Manage compensation, equity, recognition, pensions, and wellbeing benefits.

#### Compensation changes (3)

- **Validate Compensation Change** (`validate-compensation-change`) — Compensation and Rewards Specialist. Validate Compensation Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Compensation Change** (`approve-compensation-change`) — Compensation and Rewards Specialist. Approve Compensation Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Apply Compensation Change** (`apply-compensation-change`) — Compensation and Rewards Specialist. Apply Compensation Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Variable pay (3)

- **Correct Bonus Result** (`correct-bonus-result`) — Compensation and Rewards Specialist. Correct Bonus Result is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Submit Commission Input** (`submit-commission-input`) — Compensation and Rewards Specialist. Submit Commission Input is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Validate Incentive Eligibility** (`validate-incentive-eligibility`) — Compensation and Rewards Specialist. Validate Incentive Eligibility is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Equity and recognition (3)

- **Record Equity Tax Event** (`record-equity-tax-event`) — Equity and Recognition Operations Specialist. Record Equity Tax Event is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Nominate Recognition** (`nominate-recognition`) — Equity and Recognition Operations Specialist. Nominate Recognition is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Issue Recognition Award** (`issue-recognition-award`) — Equity and Recognition Operations Specialist. Issue Recognition Award is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Pension and financial wellbeing (3)

- **Pension Contribution Change** (`pension-contribution-change`) — Pension and Financial Wellbeing Specialist. Pension Contribution Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Reconcile Pension Contribution** (`reconcile-pension-contribution`) — Pension and Financial Wellbeing Specialist. Reconcile Pension Contribution is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Enroll Financial Wellbeing** (`enroll-financial-wellbeing`) — Pension and Financial Wellbeing Specialist. Enroll Financial Wellbeing is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Administer benefits and expenses (4 services, 12 sub-intents)

Determine benefit eligibility, elections, carrier outcomes, and HR reimbursements.

#### Benefits eligibility and enrollment (3)

- **Benefits Eligibility** (`benefits-eligibility`) — Benefits Operations Specialist. Benefits Eligibility is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Life Event Change** (`life-event-change`) — Benefits Operations Specialist. Life Event Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Dependent Add** (`dependent-add`) — Benefits Operations Specialist. Dependent Add is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Benefits evidence and exceptions (3)

- **Approve Benefit Exception** (`approve-benefit-exception`) — Benefits Operations Specialist. Approve Benefit Exception is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Reinstate Benefit Coverage** (`reinstate-benefit-coverage`) — Benefits Operations Specialist. Reinstate Benefit Coverage is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Calculate Benefit Deduction** (`calculate-benefit-deduction`) — Benefits Operations Specialist. Calculate Benefit Deduction is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Carrier and claims (3)

- **Reconcile Carrier Billing** (`reconcile-carrier-billing`) — Benefits Operations Specialist. Reconcile Carrier Billing is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Benefits Claim Issue** (`benefits-claim-issue`) — Benefits Operations Specialist. Benefits Claim Issue is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Resolve Coverage Exception** (`resolve-coverage-exception`) — Benefits Operations Specialist. Resolve Coverage Exception is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### HR reimbursements (3)

- **Validate Expense Claim** (`validate-expense-claim`) — Benefits Operations Specialist. Validate Expense Claim is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Expense Claim** (`approve-expense-claim`) — Benefits Operations Specialist. Approve Expense Claim is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Reimburse Expense Claim** (`reimburse-expense-claim`) — Benefits Operations Specialist. Reimburse Expense Claim is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Capture time and schedule work (5 services, 15 sub-intents)

Record work time, schedules, overtime, and attendance outcomes.

#### Time capture (3)

- **Clock In Out** (`clock-in-out`) — Time and Attendance Operations Specialist. Clock In Out is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Amend Time Entry** (`amend-time-entry`) — Time and Attendance Operations Specialist. Amend Time Entry is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Missing Clock Punch** (`missing-clock-punch`) — Time and Attendance Operations Specialist. Missing Clock Punch is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Time validation and approval (3)

- **Resolve Time Exception** (`resolve-time-exception`) — Time and Attendance Operations Specialist. Resolve Time Exception is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Time** (`approve-time`) — Time and Attendance Operations Specialist. Approve Time is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Lock Time For Payroll** (`lock-time-for-payroll`) — Time and Attendance Operations Specialist. Lock Time For Payroll is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Scheduling (3)

- **Publish Schedule** (`publish-schedule`) — Workforce Scheduling Specialist. Publish Schedule is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Schedule Change Request** (`schedule-change-request`) — Workforce Scheduling Specialist. Schedule Change Request is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Schedule Change** (`approve-schedule-change`) — Workforce Scheduling Specialist. Approve Schedule Change is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Overtime and attendance (3)

- **Overtime Inquiry** (`overtime-inquiry`) — Workforce Scheduling Specialist. Overtime Inquiry is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Overtime** (`approve-overtime`) — Workforce Scheduling Specialist. Approve Overtime is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Provide Attendance Report** (`provide-attendance-report`) — Workforce Scheduling Specialist. Provide Attendance Report is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Time information (3)

- **Time Quota Question** (`time-quota-question`) — Time and Attendance Operations Specialist. Time Quota Question is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Timesheet Reminder Dispute** (`timesheet-reminder-dispute`) — Time and Attendance Operations Specialist. Timesheet Reminder Dispute is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Public Holiday Question** (`public-holiday-question`) — Time and Attendance Operations Specialist. Public Holiday Question is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Administer absence and leave (4 services, 14 sub-intents)

Process routine absences and protected or extended leave cases.

#### Routine absence (3)

- **Leave Balance** (`leave-balance`) — Leave Operations Specialist. Leave Balance is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Leave Request** (`leave-request`) — Leave Operations Specialist. Leave Request is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Leave Cancellation** (`leave-cancellation`) — Leave Operations Specialist. Leave Cancellation is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Absence maintenance (5)

- **Convert Absence To Payable Time** (`convert-absence-to-payable-time`) — Leave Operations Specialist. Convert Absence To Payable Time is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Carryover Policy** (`carryover-policy`) — Leave Operations Specialist. Carryover Policy is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Absence Request** (`approve-absence-request`) — Leave Operations Specialist. Approve Absence Request is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Send payable time interface** (`send-payable-time-interface`) — Leave Operations Specialist. Send payable time interface is completed and recorded as one authoritative outcome. _high; fc2-policy; unsupported._
- **Resolve payable time interface exception** (`resolve-payable-time-interface-exception`) — Leave Operations Specialist. Resolve payable time interface exception is completed and recorded as one authoritative outcome. _high; fc2-policy; unsupported._

#### Protected leave (3)

- **Determine Leave Eligibility** (`determine-leave-eligibility`) — Leave Operations Specialist. Determine Leave Eligibility is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Parental Leave Guidance** (`parental-leave-guidance`) — Leave Operations Specialist. Parental Leave Guidance is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Sick Leave Certificate** (`sick-leave-certificate`) — Leave Operations Specialist. Sick Leave Certificate is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Extended leave (3)

- **Leave Of Absence Case** (`leave-of-absence-case`) — Leave Operations Specialist. Leave Of Absence Case is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Calculate Leave Pay Topup** (`calculate-leave-pay-topup`) — Leave Operations Specialist. Calculate Leave Pay Topup is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Close Leave Case** (`close-leave-case`) — Leave Operations Specialist. Close Leave Case is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

### Manage performance (4 services, 12 sub-intents)

Set expectations, capture feedback, and run fair reviews.

#### Goals and expectations (3)

- **Goal Setting** (`goal-setting`) — Performance Operations Specialist. Goal Setting is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Align Goal To Team** (`align-goal-to-team`) — Performance Operations Specialist. Align Goal To Team is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Goal** (`approve-goal`) — Performance Operations Specialist. Approve Goal is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Check-ins and feedback (3)

- **Complete Check In** (`complete-check-in`) — Performance Operations Specialist. Complete Check In is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Give Feedback** (`give-feedback`) — Performance Operations Specialist. Give Feedback is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Acknowledge Feedback** (`acknowledge-feedback`) — Performance Operations Specialist. Acknowledge Feedback is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Reviews and calibration (3)

- **Performance Cycle Question** (`performance-cycle-question`) — Performance Operations Specialist. Performance Cycle Question is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Complete Performance Review** (`complete-performance-review`) — Performance Operations Specialist. Complete Performance Review is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Communicate Review Outcome** (`communicate-review-outcome`) — Performance Operations Specialist. Communicate Review Outcome is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Performance improvement (3)

- **Record Improvement Milestone** (`record-improvement-milestone`) — Performance Operations Specialist. Record Improvement Milestone is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Review Improvement Plan** (`review-improvement-plan`) — Performance Operations Specialist. Review Improvement Plan is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Close Improvement Plan** (`close-improvement-plan`) — Performance Operations Specialist. Close Improvement Plan is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Learn and progress careers (4 services, 16 sub-intents)

Develop skills, learn, receive credentials, and plan careers.

#### Skills profile (4)

- **Add Skill** (`add-skill`) — Career and Skills Operations Specialist. Add Skill is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Validate Skill Proficiency** (`validate-skill-proficiency`) — Career and Skills Operations Specialist. Validate Skill Proficiency is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Request Skill Assessment** (`request-skill-assessment`) — Career and Skills Operations Specialist. Request Skill Assessment is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Identify Team Skill Gap** (`identify-team-skill-gap`) — Career and Skills Operations Specialist. Identify Team Skill Gap is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Learning enrollment (4)

- **Training Enrollment** (`training-enrollment`) — Learning Operations Specialist. Training Enrollment is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Withdraw Learning Enrollment** (`withdraw-learning-enrollment`) — Learning Operations Specialist. Withdraw Learning Enrollment is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Assign Learning** (`assign-learning`) — Learning Operations Specialist. Assign Learning is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Mandatory Training Chase** (`mandatory-training-chase`) — Learning Operations Specialist. Mandatory Training Chase is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Credentials and education (4)

- **Certification Tracking** (`certification-tracking`) — Learning Operations Specialist. Certification Tracking is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Verify Certification Evidence** (`verify-certification-evidence`) — Learning Operations Specialist. Verify Certification Evidence is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Tuition Reimbursement** (`tuition-reimbursement`) — Learning Operations Specialist. Tuition Reimbursement is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Learning Funding** (`approve-learning-funding`) — Learning Operations Specialist. Approve Learning Funding is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Career and mentoring (4)

- **Create Development Plan** (`create-development-plan`) — Career and Skills Operations Specialist. Create Development Plan is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Request Career Conversation** (`request-career-conversation`) — Career and Skills Operations Specialist. Request Career Conversation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Request Mentor** (`request-mentor`) — Career and Skills Operations Specialist. Request Mentor is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Record Mentoring Goal** (`record-mentoring-goal`) — Career and Skills Operations Specialist. Record Mentoring Goal is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Deploy and retain talent (4 services, 16 sub-intents)

Enable internal mobility, succession, and retention actions.

#### Internal mobility (4)

- **Apply Internal Opportunity** (`apply-internal-opportunity`) — Career and Skills Operations Specialist. Apply Internal Opportunity is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Update Mobility Preferences** (`update-mobility-preferences`) — Career and Skills Operations Specialist. Update Mobility Preferences is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Request Secondment** (`request-secondment`) — Career and Skills Operations Specialist. Request Secondment is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Withdraw Mobility Application** (`withdraw-mobility-application`) — Career and Skills Operations Specialist. Withdraw Mobility Application is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Talent review (4)

- **Nominate Talent** (`nominate-talent`) — Talent and Succession Management Specialist. Nominate Talent is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Record Readiness Evidence** (`record-readiness-evidence`) — Talent and Succession Management Specialist. Record Readiness Evidence is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Conduct Talent Review** (`conduct-talent-review`) — Talent and Succession Management Specialist. Conduct Talent Review is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Communicate Development Action** (`communicate-development-action`) — Talent and Succession Management Specialist. Communicate Development Action is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Succession planning (4)

- **Identify Critical Role** (`identify-critical-role`) — Talent and Succession Management Specialist. Identify Critical Role is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Propose Successor** (`propose-successor`) — Talent and Succession Management Specialist. Propose Successor is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Succession Plan** (`approve-succession-plan`) — Talent and Succession Management Specialist. Approve Succession Plan is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Monitor Successor Coverage** (`monitor-successor-coverage`) — Talent and Succession Management Specialist. Monitor Successor Coverage is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Retention and recognition (4)

- **Analyze Retention Signal** (`analyze-retention-signal`) — Talent and Succession Management Specialist. Analyze Retention Signal is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Create Retention Action** (`create-retention-action`) — Talent and Succession Management Specialist. Create Retention Action is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Audit Recognition Equity** (`audit-recognition-equity`) — Talent and Succession Management Specialist. Audit Recognition Equity is completed with a recorded, observable result. _high; fc2-policy; unsupported._
- **Redeem Recognition** (`redeem-recognition`) — Talent and Succession Management Specialist. Redeem Recognition is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Listen plan and change (3 services, 12 sub-intents)

Listen to employees, plan workforce needs, and support organizational change.

#### Engagement and surveys (4)

- **Respond To Survey** (`respond-to-survey`) — Employee Listening Specialist. Respond To Survey is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Launch Engagement Survey** (`launch-engagement-survey`) — Employee Listening Specialist. Launch Engagement Survey is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Release Safe Survey Results** (`release-safe-survey-results`) — Employee Listening Specialist. Release Safe Survey Results is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Create Survey Action Plan** (`create-survey-action-plan`) — Employee Listening Specialist. Create Survey Action Plan is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Workforce planning (4)

- **Submit Headcount Demand** (`submit-headcount-demand`) — Workforce Planning and Change Specialist. Submit Headcount Demand is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Model Workforce Supply Demand** (`model-workforce-supply-demand`) — Workforce Planning and Change Specialist. Model Workforce Supply Demand is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Produce Workforce Scenario** (`produce-workforce-scenario`) — Workforce Planning and Change Specialist. Produce Workforce Scenario is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Approve Workforce Action Plan** (`approve-workforce-action-plan`) — Workforce Planning and Change Specialist. Approve Workforce Action Plan is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Organizational change support (4)

- **Assess Change People Impact** (`assess-change-people-impact`) — Workforce Planning and Change Specialist. Assess Change People Impact is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Issue Change Communication** (`issue-change-communication`) — Workforce Planning and Change Specialist. Issue Change Communication is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Track Transition Action** (`track-transition-action`) — Workforce Planning and Change Specialist. Track Transition Action is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Measure Change Adoption** (`measure-change-adoption`) — Workforce Planning and Change Specialist. Measure Change Adoption is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Resolve employee relations (4 services, 18 sub-intents)

Resolve concerns, investigations, discipline, and ethics matters.

#### Grievances (6)

- **Grievance Intake** (`grievance-intake`) — Employee Relations Specialist. Grievance Intake is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Acknowledge Grievance** (`acknowledge-grievance`) — Employee Relations Specialist. Acknowledge Grievance is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Conduct Grievance Investigation** (`conduct-grievance-investigation`) — Employee Relations Specialist. Conduct Grievance Investigation is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Issue Grievance Outcome** (`issue-grievance-outcome`) — Employee Relations Specialist. Issue Grievance Outcome is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Schedule grievance meeting** (`schedule-grievance-meeting`) — Employee Relations Specialist. Schedule grievance meeting is completed and recorded as one authoritative outcome. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Process grievance appeal** (`process-grievance-appeal`) — Employee Relations Specialist. Process grievance appeal is completed and recorded as one authoritative outcome. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._

#### Workplace investigations (4)

- **Triage Allegation** (`triage-allegation`) — Workplace Investigations Specialist. Triage Allegation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Open Restricted Investigation** (`open-restricted-investigation`) — Workplace Investigations Specialist. Open Restricted Investigation is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Collect Investigation Evidence** (`collect-investigation-evidence`) — Workplace Investigations Specialist. Collect Investigation Evidence is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Issue Investigation Finding** (`issue-investigation-finding`) — Workplace Investigations Specialist. Issue Investigation Finding is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._

#### Disciplinary action (4)

- **Request Disciplinary Review** (`request-disciplinary-review`) — Employee Relations Specialist. Request Disciplinary Review is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Issue Disciplinary Allegation Notice** (`issue-disciplinary-allegation-notice`) — Employee Relations Specialist. Issue Disciplinary Allegation Notice is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Record Disciplinary Hearing** (`record-disciplinary-hearing`) — Employee Relations Specialist. Record Disciplinary Hearing is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Issue Disciplinary Outcome** (`issue-disciplinary-outcome`) — Employee Relations Specialist. Issue Disciplinary Outcome is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._

#### Ethics and speak-up (4)

- **Submit Ethics Disclosure** (`submit-ethics-disclosure`) — Ethics and Compliance Specialist. Submit Ethics Disclosure is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Assess Retaliation Risk** (`assess-retaliation-risk`) — Ethics and Compliance Specialist. Assess Retaliation Risk is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Resolve Conflict Of Interest** (`resolve-conflict-of-interest`) — Ethics and Compliance Specialist. Resolve Conflict Of Interest is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Close Ethics Case** (`close-ethics-case`) — Ethics and Compliance Specialist. Close Ethics Case is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._

### Protect people and assure compliance (5 services, 20 sub-intents)

Manage safety, accommodations, wellbeing, labor relations, and compliance.

#### Occupational safety (4)

- **Safety Incident Report** (`safety-incident-report`) — Occupational Safety Specialist. Safety Incident Report is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Escalate Serious Safety Event** (`escalate-serious-safety-event`) — Occupational Safety Specialist. Escalate Serious Safety Event is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Investigate Safety Incident** (`investigate-safety-incident`) — Occupational Safety Specialist. Investigate Safety Incident is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._
- **Verify Safety Corrective Action** (`verify-safety-corrective-action`) — Occupational Safety Specialist. Verify Safety Corrective Action is completed with a recorded, observable result. _high; fc2-policy; jurisdiction overlay; unsupported._

#### Accommodations (4)

- **Request Workplace Accommodation** (`request-workplace-accommodation`) — Workplace Accommodation Specialist. Request Workplace Accommodation is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Assess Accommodation Options** (`assess-accommodation-options`) — Workplace Accommodation Specialist. Assess Accommodation Options is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Decide Accommodation Request** (`decide-accommodation-request`) — Workplace Accommodation Specialist. Decide Accommodation Request is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Implement Accommodation Plan** (`implement-accommodation-plan`) — Workplace Accommodation Specialist. Implement Accommodation Plan is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._

#### Wellbeing and EAP (4)

- **Request Wellbeing Resource** (`request-wellbeing-resource`) — Wellbeing and EAP Specialist. Request Wellbeing Resource is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Make Consented Eap Referral** (`make-consented-eap-referral`) — Wellbeing and EAP Specialist. Make Consented Eap Referral is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Escalate Welfare Concern** (`escalate-welfare-concern`) — Wellbeing and EAP Specialist. Escalate Welfare Concern is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Record Nonclinical Workplace Support** (`record-nonclinical-workplace-support`) — Wellbeing and EAP Specialist. Record Nonclinical Workplace Support is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Labor relations (4)

- **Works Council Query** (`works-council-query`) — Labor Relations Specialist. Works Council Query is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Identify Collective Obligation** (`identify-collective-obligation`) — Labor Relations Specialist. Identify Collective Obligation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Conduct Representative Consultation** (`conduct-representative-consultation`) — Labor Relations Specialist. Conduct Representative Consultation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Retain Labor Consultation Record** (`retain-labor-consultation-record`) — Labor Relations Specialist. Retain Labor Consultation Record is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### HR compliance and audit (4)

- **Policy Exception Request** (`policy-exception-request`) — Ethics and Compliance Specialist. Policy Exception Request is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Identify Compliance Exception** (`identify-compliance-exception`) — Ethics and Compliance Specialist. Identify Compliance Exception is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Produce Audit Evidence Package** (`produce-audit-evidence-package`) — Ethics and Compliance Specialist. Produce Audit Evidence Package is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Report Record Tampering** (`report-record-tampering`) — Ethics and Compliance Specialist. Report Record Tampering is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

### Enable mobility and manage exit (6 services, 24 sub-intents)

Support compliant moves, restructures, exits, retirement, and rehire.

#### Immigration and authorization (4)

- **Work Authorization** (`work-authorization`) — Immigration and Mobility Specialist. Work Authorization is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Initiate Immigration Case** (`initiate-immigration-case`) — Immigration and Mobility Specialist. Initiate Immigration Case is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._
- **Visa Status Question** (`visa-status-question`) — Immigration and Mobility Specialist. Visa Status Question is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Escalate Authorization Expiry** (`escalate-authorization-expiry`) — Immigration and Mobility Specialist. Escalate Authorization Expiry is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Relocation and transfers (4)

- **Domestic Transfer** (`domestic-transfer`) — Immigration and Mobility Specialist. Domestic Transfer is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Cross Border Relocation** (`cross-border-relocation`) — Immigration and Mobility Specialist. Cross Border Relocation is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._
- **Relocation Allowance** (`relocation-allowance`) — Immigration and Mobility Specialist. Relocation Allowance is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._
- **Complete Relocation Transfer** (`complete-relocation-transfer`) — Immigration and Mobility Specialist. Complete Relocation Transfer is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._

#### Remote and cross-border work (4)

- **Remote Work Request** (`remote-work-request`) — Remote Work Compliance Specialist. Remote Work Request is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._
- **Assess Remote Work Risk** (`assess-remote-work-risk`) — Remote Work Compliance Specialist. Assess Remote Work Risk is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._
- **Approve Remote Work Arrangement** (`approve-remote-work-arrangement`) — Remote Work Compliance Specialist. Approve Remote Work Arrangement is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._
- **Revoke Remote Work Arrangement** (`revoke-remote-work-arrangement`) — Remote Work Compliance Specialist. Revoke Remote Work Arrangement is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._

#### Restructure and redundancy (4)

- **Assess Restructure Impact** (`assess-restructure-impact`) — Restructuring and Redundancy Specialist. Assess Restructure Impact is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Identify Redundancy Scope** (`identify-redundancy-scope`) — Restructuring and Redundancy Specialist. Identify Redundancy Scope is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Conduct Redundancy Consultation** (`conduct-redundancy-consultation`) — Restructuring and Redundancy Specialist. Conduct Redundancy Consultation is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._
- **Approve Redundancy Outcome** (`approve-redundancy-outcome`) — Restructuring and Redundancy Specialist. Approve Redundancy Outcome is completed with a recorded, observable result. _restricted; fc3-multiagent; jurisdiction overlay; unsupported._

#### Termination and offboarding (4)

- **Offboarding Exit** (`offboarding-exit`) — Offboarding and Termination Specialist. Offboarding Exit is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Submit Resignation** (`submit-resignation`) — Offboarding and Termination Specialist. Submit Resignation is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Request Involuntary Termination Review** (`request-involuntary-termination-review`) — Offboarding and Termination Specialist. Request Involuntary Termination Review is completed with a recorded, observable result. _restricted; fc3-multiagent; unsupported._
- **Complete Exit Controls** (`complete-exit-controls`) — Offboarding and Termination Specialist. Complete Exit Controls is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

#### Retirement alumni and rehire (4)

- **Retirement Estimate** (`retirement-estimate`) — Retirement and Alumni Operations Specialist. Retirement Estimate is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._
- **Retirement Initiation** (`retirement-initiation`) — Retirement and Alumni Operations Specialist. Retirement Initiation is completed with a recorded, observable result. _medium; fc1-deterministic; jurisdiction overlay; unsupported._
- **Reference Letter** (`reference-letter`) — Retirement and Alumni Operations Specialist. Reference Letter is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._
- **Assess Rehire Eligibility** (`assess-rehire-eligibility`) — Retirement and Alumni Operations Specialist. Assess Rehire Eligibility is completed with a recorded, observable result. _low; fc1-deterministic; unsupported._

## Composite routes

- **New hire setup** (`new-hire-setup`) — Orchestrates approved new-hire setup across worker record, enrollment, access, workplace, learning, readiness, and activation without claiming a single atomic write. It orchestrates 11 named atomic outcomes across 7 services. Current runtime: **simulated**.

## Agent capability map

| Accountable specialist capability | Owned leaves | Mission |
|---|---:|---|
| Talent Acquisition Operations Specialist | 9 | Own candidate, requisition, offer, and referral operations. |
| Onboarding Operations Specialist | 12 | Orchestrate onboarding communications, readiness, and case work. |
| Screening and Work Eligibility Specialist | 15 | Operate screening and work-eligibility controls. |
| Worker Data Operations Specialist | 13 | Maintain authoritative worker and employment data. |
| Organization and Position Management Specialist | 6 | Maintain organization and position structures. |
| Contingent Workforce Operations Specialist | 3 | Administer contingent worker engagements. |
| HR Service Delivery Specialist | 6 | Route and fulfill general HR service requests. |
| HR Document and Records Specialist | 7 | Produce governed HR documents and records. |
| HR Knowledge and Policy Specialist | 4 | Maintain and deliver approved HR knowledge. |
| Privacy and Records Specialist | 10 | Administer privacy rights and records controls. |
| HR Data Quality Specialist | 6 | Resolve HR data quality and access-control exceptions. |
| People Analytics and Reporting Specialist | 3 | Deliver governed people reporting. |
| Payroll Operations Specialist | 27 | Operate payroll inputs, calculation controls, payments, and filings. |
| Compensation and Rewards Specialist | 6 | Administer salary and incentive compensation. |
| Equity and Recognition Operations Specialist | 3 | Administer equity and recognition programs. |
| Benefits Operations Specialist | 16 | Administer benefit eligibility, enrollment, claims, and reimbursements. |
| Pension and Financial Wellbeing Specialist | 3 | Administer pension and financial wellbeing programs. |
| Time and Attendance Operations Specialist | 9 | Capture and validate time and attendance. |
| Workforce Scheduling Specialist | 6 | Operate schedules and overtime workflows. |
| Leave Operations Specialist | 14 | Administer absence and leave cases. |
| Performance Operations Specialist | 12 | Operate goals, feedback, reviews, and improvement cycles. |
| Learning Operations Specialist | 12 | Operate learning and credential workflows. |
| Career and Skills Operations Specialist | 12 | Administer skills, career, mentoring, and mobility. |
| Talent and Succession Management Specialist | 12 | Run talent review, succession, and retention programs. |
| Employee Listening Specialist | 4 | Operate engagement and survey programs. |
| Workforce Planning and Change Specialist | 8 | Run workforce planning and organizational change support. |
| Employee Relations Specialist | 10 | Resolve grievances and disciplinary cases. |
| Workplace Investigations Specialist | 4 | Conduct restricted workplace investigations. |
| Ethics and Compliance Specialist | 8 | Operate ethics and HR compliance controls. |
| Occupational Safety Specialist | 4 | Operate workplace safety cases and corrective actions. |
| Workplace Accommodation Specialist | 4 | Administer workplace accommodation cases. |
| Wellbeing and EAP Specialist | 4 | Coordinate non-clinical wellbeing and EAP support. |
| Labor Relations Specialist | 4 | Manage collective labor and representative consultation. |
| Immigration and Mobility Specialist | 8 | Administer immigration and relocation cases. |
| Remote Work Compliance Specialist | 4 | Assess and control remote-work arrangements. |
| Restructuring and Redundancy Specialist | 4 | Manage workforce restructuring and redundancy workflows. |
| Offboarding and Termination Specialist | 4 | Operate termination and offboarding controls. |
| Retirement and Alumni Operations Specialist | 4 | Administer retirement, alumni, and rehire processes. |
| IT Identity and Access Specialist | 4 | Provision and revoke workforce digital identity and access. |
| Workplace and Facilities Operations Specialist | 6 | Provide equipment, workplace, and facilities access. |
| HR Business Partner / People Manager Operations | 10 | Own manager-led probation and delegated people decisions. |

## Product implications

### 1. Import the hierarchy without distorting the cost model

The existing 60-row cost baseline should remain a versioned commercial model. The 320-leaf operational corpus is a different layer. Replacing the 60 cost rows with 320 rows would double-count composite work and invalidate current weights. Instead, map cost scenarios to service intents/composite routes while routing runtime requests to atomic leaves.

### 2. Make every leaf resolvable before making it executable

The corpus browser and resolver should understand all 320 canonical leaves plus tenant custom intents. Unsupported leaves should still be searchable, classifiable, explainable, and intake-capable, but must fail closed before a remote write. HR case management patterns support separate intake, assignment, confidential work, SLA, and closure states [[6]](https://www.servicenow.com/docs/r/yokohama/employee-service-management/hr-service-delivery/c_HRCaseManagement.html).

### 3. Register bounded executors by specialist capability

Each accountable capability needs an executor registry with approved read/write tools, ownership, risk ceiling, evidence schema, and supported maturity. Time, absence, and payroll are distinct but connected operational boundaries [[7]](https://www.gsa.gov/buy-through-us/shared-services/support-services-for-commissions-and-boards/hr-links-user-guides/time-and-leave) [[8]](https://docs.oracle.com/en/applications/peoplesoft/human-capital-management/9.2.055/peoplesoft-time-and-labor/integrating-absence-management-time-labor-payroll-north-america.html); one generic HR agent should not own all of them.

### 4. Keep evidence and human authority explicit

Restricted outcomes—screening, payroll release, privacy, employee relations, safety, accommodation, mobility, and termination—must retain source-confirmed evidence and human decision boundaries. Subject-access work alone requires bounded intake, search, review/redaction, and delivery activities [[5]](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/subject-access-request-q-and-as-for-employers); grievance and disciplinary journeys likewise require distinct meeting, decision, and appeal outcomes [[14]](https://www.acas.org.uk/grievance-procedure-step-by-step) [[13]](https://www.gov.uk/taking-disciplinary-action).

### 5. Apply policy overlays instead of multiplying canonical intents

The same canonical leave, payroll, screening, mobility, or separation intent can have different rules by jurisdiction, entity, worker type, union/CBA, plan, and effective date. The resolver should select the applicable policy version and record it with the case evidence. This is especially important because the research sources include U.S. and UK examples and must not be generalized into universal entitlements.

### 6. Roll out by value and risk

Start with high-volume deterministic reads and reversible writes, then policy-bound transactions, then multi-agent cases. Performance, talent, and workforce planning are broad professional disciplines rather than single chatbot labels [[10]](https://www.cipd.org/en/knowledge/factsheets/performance-factsheet) [[12]](https://www.cipd.org/en/knowledge/factsheets/talent-factsheet) [[11]](https://www.cipd.org/en/knowledge/factsheets/workforce-planning-factsheet). Employee-relations and safety routes should remain human-led with automation limited to intake, evidence handling, notifications, deadlines, and approved actions [[15]](https://www.osha.gov/laws-regs/oshact/section5-duties).

## Validation

The canonical JSON passed the following checks:

- Passed: validJson
- Passed: uniqueKeys
- Passed: uniqueServiceIntentKeys
- Passed: uniqueJourneyKeys
- Passed: referencesResolve
- Passed: everyServiceHasChildren
- Passed: everyJourneyHasServices
- Passed: legacyKeysAccountedForExactlyOnce
- Passed: legacyAtomicLeafMappings
- Passed: legacyCompositeRouteMappings
- Passed: noAliasEqualsCanonicalKey
- Passed: allowedEnumsOnly
- Passed: candidateGapsCovered
- Passed: compoundRouteSemantics
- Passed: accountableAgentResolution
- Passed: noCaseDuplicateAgentNames
- Passed: noSelfCollaboration
- Passed: everyAgentOwnsLeaf

Additional workbook-generation checks confirm unique canonical names, unique aliases, no canonical-key/alias collision, exact journey/service child membership, and one accountable registered capability per leaf.

## Limitations

No finite global taxonomy can enumerate every client-specific policy name, collective-agreement clause, country form, vendor exception, or future regulation. The corpus therefore models canonical outcomes and marks where a jurisdiction overlay is mandatory. Agent ownership is a target operating model and may be reassigned during client implementation. Current runtime maturity is based only on repository evidence; catalog mapping must not be marketed as integration. The corpus should be governed as a versioned product asset with change review, alias collision checks, deprecation handling, and usage-driven additions.

## Sources

1. [Onboarding Tasks](https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/onboarding-tasks) — SAP Help Portal; date not stated; Tier 2. Evidence: `research/sources/master-hire-01.md`.
2. [Form I-9 Retention and Storage](https://www.uscis.gov/i-9-central/completing-form-i-9/retention-and-storage) — U.S. Citizenship and Immigration Services; 2020-07-10; Tier 1. Evidence: `research/sources/master-hire-02.md`.
3. [Employer Background Checks and Your Rights](https://consumer.ftc.gov/articles/employer-background-checks-your-rights) — U.S. Federal Trade Commission; 2025-08-01; Tier 1. Evidence: `research/sources/master-hire-03.md`.
4. [5 CFR Part 293 Subpart A—Basic Policies on Maintenance of Personnel Records](https://www.ecfr.gov/current/title-5/chapter-I/subchapter-B/part-293/subpart-A) — Electronic Code of Federal Regulations; date not stated; Tier 1. Evidence: `research/sources/master-core-01.md`.
5. [Subject access request Q and As for employers](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/subject-access-request-q-and-as-for-employers) — UK Information Commissioner's Office; date not stated; Tier 1. Evidence: `research/sources/master-core-02.md`.
6. [HR Case Management](https://www.servicenow.com/docs/r/yokohama/employee-service-management/hr-service-delivery/c_HRCaseManagement.html) — ServiceNow; date not stated; Tier 2. Evidence: `research/sources/master-core-03.md`.
7. [Time and Leave](https://www.gsa.gov/buy-through-us/shared-services/support-services-for-commissions-and-boards/hr-links-user-guides/time-and-leave) — U.S. General Services Administration; 2026-07-21; Tier 1. Evidence: `research/sources/master-pay-01.md`.
8. [Integrating Absence Management, Time and Labor, and Payroll](https://docs.oracle.com/en/applications/peoplesoft/human-capital-management/9.2.055/peoplesoft-time-and-labor/integrating-absence-management-time-labor-payroll-north-america.html) — Oracle; date not stated; Tier 2. Evidence: `research/sources/master-pay-02.md`.
9. [Fix problems with running payroll](https://www.gov.uk/payroll-errors/correct-mistakes) — GOV.UK; date not stated; Tier 1. Evidence: `research/sources/master-pay-03.md`.
10. [Performance management: An introduction](https://www.cipd.org/en/knowledge/factsheets/performance-factsheet) — Chartered Institute of Personnel and Development; date not stated; Tier 1. Evidence: `research/sources/master-talent-01.md`.
11. [Workforce planning](https://www.cipd.org/en/knowledge/factsheets/workforce-planning-factsheet) — Chartered Institute of Personnel and Development; date not stated; Tier 1. Evidence: `research/sources/master-talent-02.md`.
12. [Talent management](https://www.cipd.org/en/knowledge/factsheets/talent-factsheet) — Chartered Institute of Personnel and Development; date not stated; Tier 1. Evidence: `research/sources/master-talent-03.md`.
13. [Taking disciplinary action against an employee](https://www.gov.uk/taking-disciplinary-action) — GOV.UK; date not stated; Tier 1. Evidence: `research/sources/master-risk-01.md`.
14. [Formal grievance procedure](https://www.acas.org.uk/grievance-procedure-step-by-step) — Acas; date not stated; Tier 1. Evidence: `research/sources/master-risk-02.md`.
15. [OSH Act of 1970, Section 5](https://www.osha.gov/laws-regs/oshact/section5-duties) — U.S. Occupational Safety and Health Administration; date not stated; Tier 1. Evidence: `research/sources/master-risk-03.md`.
16. [Employee Data - HR Information](https://help.sap.com/docs/successfactors-employee-central/implementing-employee-central-core/employee-data-hr-information) — SAP Help Portal; date not stated; Tier 3. Evidence: `research/sources/sap-core-01-employee-data.md`.
17. [Pay Statement](https://help.sap.com/docs/successfactors-employee-central-payroll/implementing-employee-central-payroll-based-on-sap-human-capital-management-for-sap-erp-hcm/pay-statement) — SAP Help Portal; date not stated; Tier 3. Evidence: `research/sources/sap-core-02-pay-statement.md`.
18. [Time Management in SAP SuccessFactors](https://help.sap.com/docs/successfactors-employee-central/implementing-time-management-in-sap-successfactors/time-management-in-sap-successfactors) — SAP Help Portal; date not stated; Tier 3. Evidence: `research/sources/sap-core-03-time-management.md`.
19. [Claiming Benefits by Employee](https://help.sap.com/docs/successfactors-employee-central/implementing-global-benefits/79dac2f420c642b2871af2b8d6a6ff5c.html) — SAP Help Portal; date not stated; Tier 3. Evidence: `research/sources/sap-core-04-benefits-claims.md`.
20. [Requesting Time Off](https://help.sap.com/docs/successfactors-employee-central/using-time-management-in-sap-successfactors/requesting-time-off) — SAP Help Portal; date not stated; Tier 3. Evidence: `research/sources/sap-core-snippets.md#s2--requesting-time-off`.
21. [Latest Benefits Enrollment Experience](https://help.sap.com/docs/successfactors-employee-central/implementing-global-benefits/900861ba85f14f34b1a22fff1d9adcc9.html) — SAP Help Portal; date not stated; Tier 3. Evidence: `research/sources/sap-core-snippets.md#s3--latest-benefits-enrollment-experience`.
22. [SAP SuccessFactors Performance & Goals](https://www.sap.com/products/hcm/performance-goals.html) — SAP; date not stated; Tier 3. Evidence: `research/sources/sap-lifecycle-snippets.md#performance-and-goals-product-capabilities`.
23. [Feature Scope Description for SAP SuccessFactors Learning](https://www.sap.com/docs/download/agreements/product-policy/css/service-specifications/feature-scope-description-for-sap-successfactors-learning-english-v5-2025.pdf) — SAP; 2025-01-01; Tier 3. Evidence: `research/sources/sap-lifecycle-snippets.md#learning-feature-scope`.
24. [SAP SuccessFactors Enterprise Service Management | HR Service Delivery](https://www.sap.com/products/hcm/enterprise-service-management.html) — SAP; date not stated; Tier 3. Evidence: `research/sources/sap-lifecycle-03-enterprise-service-management.md`.
25. [Data Retention Time Management](https://help.sap.com/docs/successfactors-platform/implementing-and-managing-data-protection-and-privacy/data-retention-time-management) — SAP Help Portal; date not stated; Tier 3. Evidence: `research/sources/sap-lifecycle-04-data-retention-privacy.md`.
26. [Archive Onboarding/Offboarding Tasks](https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/archive-onboarding-offboarding-tasks) — SAP Help Portal; date not stated; Tier 3. Evidence: `research/sources/sap-lifecycle-snippets.md#offboarding-task-administration`.
27. [Avature Intent Classification test set](https://github.com/Avature/intent-classification) — Avature; 2024-05-28; Tier 2. Evidence: `research/sources/oss-github-01-avature-intent-classification.md`.
28. [HR-MultiWOZ task-oriented dialogue dataset](https://huggingface.co/datasets/xwjzds/hr_multiwoz_tod_sgd) — xwjzds / Hugging Face; 2024-01-01; Tier 2. Evidence: `research/sources/oss-datasets-01-hr-multiwoz.md`.
29. [HR practitioner seed v1](https://huggingface.co/datasets/15juneee/hr-practitioner-seed-v1) — 15juneee / Hugging Face; date not stated; Tier 3. Evidence: `research/sources/oss-datasets-02-hr-practitioner.md`.
30. [HR Policies Q&A Dataset](https://github.com/syncora-ai/hr-policies-qa-dataset) — syncora-ai; 2025-09-04; Tier 3. Evidence: `research/sources/oss-github-03-syncora-hr-policies-qa.md`.
31. [Chatbot Intent Classification Dataset](https://www.kaggle.com/datasets/sahideseker/chatbot-intent-classification-dataset) — Kaggle / sahideseker; date not stated; Tier 3. Evidence: `research/sources/oss-datasets-04-kaggle-chatbot-intents.md`.
32. [IBM HR Analytics Employee Attrition & Performance](https://www.kaggle.com/datasets/pavansubhasht/ibm-hr-analytics-attrition-dataset) — Kaggle; date not stated; Tier 3. Evidence: `research/sources/oss-datasets-snippets.md#ibm-hr-analytics-employee-attrition--performance`.
33. [Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration) — OpenAI; date not stated; Tier 3. Evidence: `research/sources/agent-architecture-01-openai-orchestration.md`.
34. [AI Agent Orchestration Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) — Microsoft Azure Architecture Center; date not stated; Tier 2. Evidence: `research/sources/agent-architecture-02-azure-agent-design-patterns.md`.
35. [Error Handling & Retry Patterns](https://docs.temporal.io/design-patterns/error-handling-patterns) — Temporal; date not stated; Tier 3. Evidence: `research/sources/agent-architecture-03-temporal-error-handling.md`.
36. [Using function tools with human in the loop approvals](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval) — Microsoft Learn; date not stated; Tier 3. Evidence: `research/sources/agent-architecture-04-microsoft-tool-approval.md`.
37. [Compensating Transaction Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction) — Microsoft Azure Architecture Center; date not stated; Tier 3. Evidence: `research/sources/agent-architecture-snippets.md#microsoft-azure-architecture-center--compensating-transaction-pattern`.

