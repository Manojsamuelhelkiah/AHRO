import { HRO_BATCH_TEMPLATES, hroRequestForRow } from "./hro-batch-templates";
import { OFFLINE_CASE_EXAMPLES } from "./offline-example-inventory";

export const OFFLINE_EXTENSION_PREFIX = "UAT-DEMO-EXAMPLES:complementary-v1:";
type Scenario = [title: string, summary: string, data: Record<string, string>, templateId?: string];
/** Proposed discrepancies are intake questions, not verified findings or exceptions. */
const scenarios: Record<string, Scenario[]> = {
  Onboarding: [
    ["Fixed-term contractor intake", "Review the proposed engagement and end date; engagement authority and acceptance are pending.", { engagement_end_date: "2031-05-30", engagement_reference: "FICTIONAL-ENGAGEMENT-06", worker_category: "contractor" }, "onboarding-contractor"],
    ["Rehire employment-reference review", "Review the supplied prior employment reference; prior service and rehire eligibility are unverified.", { previous_employee_id: "FICTIONAL-PRIOR-07", previous_employment_reference: "FICTIONAL-SERVICE-07" }, "onboarding-rehire"],
    ["Campus cohort intake", "Review the proposed campus cohort start and shared induction; individual evidence and acceptance remain pending.", { joining_date: "2031-07-01", department: "Campus Engineering", assisted_intake: "yes" }, "onboarding-campus-cohort"],
    ["Expedited start review", "Review the short proposed start window; urgency does not waive evidence or human acceptance.", { joining_date: "2030-10-16", work_environment: "office" }, "onboarding-expedited"],
    ["Safety-critical site intake", "Review proposed site exposure and safety-critical duties; safety suitability, training and acceptance are unverified.", { work_environment: "site", site: "Fictional Site Cedar", site_exposure: "yes", safety_critical: "yes" }],
  ],
  "Employee Changes": [
    ["Same-country internal transfer", "Review the proposed same-country move and manager responsibility; no worker record has changed.", { new_role: "Service Planner", new_department: "Planning", change_reference: "FICTIONAL-SAME-COUNTRY-06" }, "employee-changes-internal-transfer"],
    ["Cross-entity role proposal", "Clarify whether the proposed change to Fictional Alternate Entity requires specialist review; no entity transfer is approved.", { new_role: "Entity Coordinator", new_department: "Entity Operations", change_reference: "FICTIONAL-CROSS-ENTITY-07" }],
    ["Acting-role end-date inquiry", "Clarify the proposed acting-role end date of 2031-02-28 and reversion requirements; temporary authority is not granted.", { new_role: "Acting Team Lead", new_department: "Service Operations", change_reference: "FICTIONAL-ACTING-08" }],
    ["Role change during proposed leave", "Review a role change proposed during reported leave from 2030-11-10 to 2030-11-20; neither proposal is approved.", { effective_date: "2030-11-15", new_role: "Coverage Coordinator", change_reference: "FICTIONAL-LEAVE-OVERLAP-09" }],
    ["Role change near payroll cutoff", "Clarify the proposed effective date against a reported 2030-11-25 cutoff; payroll acceptance is pending.", { effective_date: "2030-11-24", new_role: "Senior Associate", change_reference: "FICTIONAL-CUTOFF-10" }],
  ],
  Payroll: [
    ["Future-dated bank-change inquiry", "Review future-dated routing and identity evidence; no bank details are supplied or changed.", { effective_date: "2031-03-01", secure_submission_reference: "FICTIONAL-SECURE-FUTURE-06" }],
    ["Conflicting secure references", "Clarify why intake cites references A and B; neither reference proves secure submission or identity.", { secure_submission_reference: "FICTIONAL-REF-A / FICTIONAL-REF-B" }],
    ["Employee-reference clarification", "Obtain the missing employee reference before reviewing the proposal; identity is unknown.", { employee_id: "", secure_submission_reference: "FICTIONAL-SECURE-08" }],
    ["Repeated bank-change inquiry", "Review whether this repeats Fictional Request Prior-09; do not deduplicate or apply a change automatically.", { secure_submission_reference: "FICTIONAL-PRIOR-09" }],
    ["Payroll country/entity inquiry", "Clarify the reported work country and entity mismatch before any payroll review.", { work_country: "GB", legal_entity: "Example Americas Inc", secure_submission_reference: "FICTIONAL-MISMATCH-10" }],
  ],
  Benefits: [
    ["Other life-event eligibility inquiry", "Clarify the reported other life event and applicable eligibility; no dependent information or entitlement is recorded.", { event_type: "other", event_date: "2030-10-01", benefit_plan_reference: "FICTIONAL-PLAN-OTHER" }],
    ["Life-event effective-date mismatch", "Review a proposed effective date before the reported event; no backdating exception is accepted.", { event_type: "marriage", event_date: "2030-11-20", effective_date: "2030-11-01" }],
    ["Overlapping enrolment inquiries", "Review overlap with Fictional Enrolment Prior-08; coverage has not been granted.", { event_type: "other", evidence_reference: "FICTIONAL-ENROLMENT-PRIOR-08", benefit_plan_reference: "FICTIONAL-PLAN-OVERLAP" }],
    ["Benefit plan-reference clarification", "Obtain the missing plan reference before assessing eligibility; no plan is selected.", { event_type: "other", benefit_plan_reference: "", event_date: "2030-11-04" }],
    ["Benefits country/entity dependency", "Clarify country/entity eligibility and the applicable plan with a specialist; no eligibility finding exists.", { event_type: "other", work_country: "SG", legal_entity: "Example Europe GmbH", benefit_plan_reference: "FICTIONAL-PLAN-REGIONAL" }],
  ],
  Leave: [
    ["Overlapping leave-period inquiry", "Review overlap with a reported pending period 2030-12-10 to 2030-12-20; neither period is approved.", { leave_type: "annual", start_date: "2030-12-15", end_date: "2030-12-24", evidence_reference: "FICTIONAL-PENDING-PERIOD-06" }],
    ["Cross-year annual leave", "Review year-boundary allocation and balances; no entitlement or carry-over is confirmed.", { leave_type: "annual", start_date: "2030-12-28", end_date: "2031-01-06" }],
    ["Other leave entitlement inquiry", "Clarify the other leave category and policy entitlement without medical details.", { leave_type: "other", start_date: "2031-01-10", end_date: "2031-01-12" }],
    ["Unapproved leave amendment", "Review amended dates for Fictional Pending Request-09; the original request is reported unapproved.", { leave_type: "unpaid", start_date: "2030-11-22", end_date: "2030-11-25", evidence_reference: "FICTIONAL-PENDING-REQUEST-09" }],
    ["Short-notice coverage review", "Review the proposed short-notice period and staffing coverage; no leave or policy exception is granted.", { leave_type: "annual", start_date: "2030-10-16", end_date: "2030-10-17" }],
  ],
  Compliance: [
    ["Reported expired authorization", "A reported already-expired authorization requires urgent human review. This intake gives no permission to work and verifies no source.", { authorization_expiry_date: "2026-09-30", evidence_reference: "FICTIONAL-EXPIRED-06" }],
    ["Duplicate authorization references", "Review whether two submissions cite the same source; neither evidence nor renewal is verified.", { evidence_reference: "FICTIONAL-DUPLICATE-SOURCE-07", authorization_expiry_date: "2030-12-31" }],
    ["Authorization jurisdiction inquiry", "Clarify the country/entity mismatch with an authorized specialist; no work eligibility is determined.", { work_country: "DE", legal_entity: "Example UK Ltd", evidence_reference: "FICTIONAL-JURISDICTION-08" }],
    ["Renewal date after reported expiry", "Review the proposed effective date after reported expiry; no continuity or permission to work is assumed.", { authorization_expiry_date: "2030-10-31", effective_date: "2030-11-15", evidence_reference: "FICTIONAL-GAP-09" }],
    ["Untranslated authorization source", "Review translation and source authentication for the reported untranslated reference; no findings are established.", { evidence_reference: "FICTIONAL-UNTRANSLATED-10", authorization_expiry_date: "2031-02-01" }],
  ],
  Offboarding: [
    ["Fixed-term expiry preparation", "Review proposed fixed-term engagement expiry and source authority. Preparation only; final closure is unavailable.", { separation_type: "fixed-term-expiry", worker_category: "contractor", termination_date: "2031-05-30", notice_reference: "FICTIONAL-TERM-06" }],
    ["Proposed involuntary separation", "Authorized human and jurisdiction-specific review is required for the proposed separation. Preparation only; closure is unavailable.", { separation_type: "proposed-involuntary", notice_reference: "FICTIONAL-PROPOSAL-07" }],
    ["Departure during reported leave", "Review proposed departure during reported leave 2030-11-01 to 2030-11-30. No separation is authorized; closure is unavailable.", { separation_type: "proposed-resignation", last_working_date: "2030-11-15", notice_reference: "FICTIONAL-LEAVE-08" }],
    ["Working/termination date inquiry", "Clarify differing proposed last-working and termination dates with payroll. Preparation only; closure is unavailable.", { last_working_date: "2030-11-15", termination_date: "2030-11-30", notice_reference: "FICTIONAL-DATES-09" }],
    ["Cross-country separation review", "Review a reported prior UK assignment against the proposed German separation policy; no policy applicability is established. Closure is unavailable.", { work_country: "DE", legal_entity: "Example Europe GmbH", notice_reference: "FICTIONAL-CROSS-COUNTRY-10" }],
  ],
  "HR Helpdesk": [
    ["Experience-letter inquiry", "Review an experience-letter request and verified service dates; no letter is issued.", { letter_type: "experience", purpose_reference: "FICTIONAL-EXPERIENCE-06" }],
    ["Multiple employment-period inquiry", "Clarify reported service periods 2028-2029 and 2030 onward before preparing any letter.", { letter_type: "experience", purpose_reference: "FICTIONAL-MULTIPLE-PERIODS-07" }],
    ["Missing letter-purpose reference", "Obtain the missing purpose reference and review permitted disclosure; no document exists.", { letter_type: "employment-confirmation", purpose_reference: "" }],
    ["Requesting-entity clarification", "Clarify which entity should attest employment; the reported requesting entity is unverified.", { letter_type: "other", purpose_reference: "FICTIONAL-REQUESTING-ENTITY-09", legal_entity: "Fictional Requesting Entity" }],
    ["Letter date/role discrepancy", "Clarify whether a requested historical role for 2029 matches verified service records; no discrepancy is confirmed.", { letter_type: "experience", effective_date: "2029-06-01", purpose_reference: "FICTIONAL-HISTORICAL-ROLE-10" }],
  ],
  "IT Access": [
    ["Contractor access-expiry inquiry", "Review contractor engagement and proposed access expiry; no entitlement or employment status is verified.", { access_role: "contractor-read-only", access_end_date: "2031-05-30", business_justification_reference: "FICTIONAL-CONTRACTOR-06" }],
    ["Conflicting access-role inquiry", "Review potentially conflicting requester and approver roles; no segregation-of-duties finding or access grant exists.", { access_role: "requester / approver", business_justification_reference: "FICTIONAL-CONFLICT-07" }],
    ["Missing access justification", "Obtain a business justification before owner review; no access is granted.", { access_role: "project-reader", business_justification_reference: "" }],
    ["Access extension inquiry", "Review extending a reported prior request through the proposed date; prior access and extension authority are unverified.", { access_role: "project-reader", access_end_date: "2031-06-30", business_justification_reference: "FICTIONAL-EXTENSION-09" }],
    ["Application jurisdiction inquiry", "Clarify the application's country/entity scope with its owner before any entitlement decision.", { work_country: "IN", legal_entity: "Example UK Ltd", application_reference: "FICTIONAL-REGIONAL-APP-10" }],
  ],
  Learning: [
    ["Course prerequisite dependency", "Review whether Fictional Foundation-01 is a prerequisite; no completion or enrolment evidence exists.", { course_reference: "FICTIONAL-ADVANCED-REQUIRES-FOUNDATION-01", due_date: "2031-01-15" }],
    ["Duplicate course-assignment inquiry", "Review whether this repeats Fictional Assignment Prior-07; no LMS assignment is created.", { course_reference: "FICTIONAL-ASSIGNMENT-PRIOR-07", due_date: "2031-02-15" }],
    ["Certification equivalence inquiry", "Review whether a reported external certification is equivalent; no equivalence or completion is accepted.", { course_reference: "FICTIONAL-EQUIVALENCE-08", due_date: "2031-03-15" }],
    ["Course-version mismatch", "Clarify a proposed version 2 against the reported version 1 requirement; no applicable curriculum is approved.", { course_reference: "FICTIONAL-COURSE-V2-REQUIREMENT-V1", due_date: "2031-04-15" }],
    ["Country-specific curriculum inquiry", "Review the country-specific curriculum and jurisdiction applicability; no enrolment or completion exists.", { work_country: "DE", course_reference: "FICTIONAL-DE-CURRICULUM-10", due_date: "2031-05-15" }],
  ],
  Mobility: [
    ["Overseas assignment extension", "Review extending a reported temporary assignment; immigration, tax and payroll authority remain pending.", { destination_country: "SG", destination_entity: "Example APAC Pte Ltd", transfer_reference: "FICTIONAL-EXTENSION-06", effective_date: "2031-06-01" }],
    ["Return-to-home-country plan", "Review the proposed return to the reported home country; home status and entity readiness are unverified.", { destination_country: "IN", destination_entity: "Example India Ltd", transfer_reference: "FICTIONAL-RETURN-07" }],
    ["Move with authorization dependency", "Review the proposed move's work-authorization dependency; this intake grants no permission to work.", { destination_country: "GB", destination_entity: "Example UK Ltd", transfer_reference: "FICTIONAL-AUTH-PENDING-08" }],
    ["Destination country/entity inquiry", "Clarify the reported destination country/entity mismatch before specialist planning.", { destination_country: "DE", destination_entity: "Example Americas Inc", transfer_reference: "FICTIONAL-DESTINATION-09" }],
    ["Transfer near payroll cutoff", "Review the proposed effective date near a reported 2030-11-25 payroll cutoff; no cutover is authorized.", { effective_date: "2030-11-24", destination_country: "US", destination_entity: "Example Americas Inc", transfer_reference: "FICTIONAL-CUTOFF-10" }],
  ],
  Documents: [
    ["Superseded policy-revision inquiry", "Review whether the reported revision is superseded; no policy applicability or acknowledgement is recorded.", { document_reference: "FICTIONAL-POLICY-SUPERSEDED-06", document_version: "1" }],
    ["Policy language/accessibility inquiry", "Review the requested accessible language format and authoritative source; no delivery or acknowledgement exists.", { document_reference: "FICTIONAL-ACCESSIBLE-LANGUAGE-07", document_version: "2" }],
    ["Multiple policy-version inquiry", "Clarify whether revisions 2 and 3 apply to different periods; no applicable policy is selected.", { document_reference: "FICTIONAL-MULTIPLE-VERSIONS-08", document_version: "2 / 3" }],
    ["Duplicate acknowledgement inquiry", "Review whether this repeats Fictional Request Prior-09; no acknowledgement or duplicate finding is recorded.", { document_reference: "FICTIONAL-REQUEST-PRIOR-09", document_version: "3" }],
    ["Policy country/entity inquiry", "Clarify jurisdiction and entity applicability before requesting acknowledgement; no policy is adopted.", { work_country: "SG", legal_entity: "Example Europe GmbH", document_reference: "FICTIONAL-APPLICABILITY-10", document_version: "4" }],
  ],
};

export const OFFLINE_EXTENSION_EXAMPLES = Object.entries(scenarios).flatMap(([family, entries], familyIndex) =>
  entries.map(([title, summary, details, templateId], index) => {
    const base = OFFLINE_CASE_EXAMPLES.find(item => item.family === family)!;
    const template = HRO_BATCH_TEMPLATES.find(item => item.id === (templateId ?? base.values.processPolicySnapshot.batchIntake.templateId))!;
    const slot = index + 6;
    const key = `${OFFLINE_EXTENSION_PREFIX}${familyIndex + 1}:${slot}`;
    const workerName = `Example — ${["Sage", "Remy", "Ellis", "Jules", "Kiran"][index]} ${["Fern", "Pine", "Birch", "Stone", "Willow", "Aspen", "Maple", "Hazel", "Oak", "Iris", "Juniper", "Alder"][familyIndex]}`;
    const workerEmail = `example-complementary-${familyIndex + 1}-${slot}@hro.invalid`;
    const defaults: Record<string, string> = {
      template_id: template.id, template_version: String(template.version),
      request_id: key, worker_name: workerName, worker_email: workerEmail,
      work_country: ["IN", "GB", "US", "DE", "SG"][index]!,
      legal_entity: ["Example India Ltd", "Example UK Ltd", "Example Americas Inc", "Example Europe GmbH", "Example APAC Pte Ltd"][index]!,
      department: ["Planning", "Engineering", "Sales", "Operations", "Quality"][index]!,
      employee_id: `FICTIONAL-EMPLOYEE-${familyIndex + 1}-${slot}`,
      effective_date: `2030-11-${10 + index}`, role: base.values.role,
      manager_name: "Example manager", recruiter_name: "Example coordinator",
      joining_date: `2030-11-${10 + index}`, worker_category: "employee",
      work_environment: "office", site_exposure: "unknown", safety_critical: "unknown",
      new_role: "Proposed Specialist", new_department: "Planning", change_reference: `FICTIONAL-CHANGE-${slot}`,
      secure_submission_reference: `FICTIONAL-SECURE-${slot}`,
      event_type: "other", event_date: "2030-11-01", benefit_plan_reference: `FICTIONAL-PLAN-${slot}`,
      leave_type: "annual", start_date: "2030-11-10", end_date: "2030-11-12",
      authorization_expiry_date: "2031-01-31", evidence_reference: `FICTIONAL-SOURCE-${slot}`,
      separation_type: "proposed-separation", last_working_date: "2030-11-30", termination_date: "2030-11-30",
      time_zone: "Etc/UTC", notice_reference: `FICTIONAL-NOTICE-${slot}`,
      letter_type: "employment-confirmation", purpose_reference: `FICTIONAL-PURPOSE-${slot}`,
      application_reference: `FICTIONAL-APPLICATION-${slot}`, access_role: "read-only",
      access_end_date: "2031-02-28", business_justification_reference: `FICTIONAL-JUSTIFICATION-${slot}`,
      course_reference: `FICTIONAL-COURSE-${slot}`, due_date: "2031-01-31",
      destination_country: "GB", destination_entity: "Example UK Ltd", destination_role: "Proposed Specialist",
      transfer_reference: `FICTIONAL-TRANSFER-${slot}`, document_reference: `FICTIONAL-DOCUMENT-${slot}`, document_version: "1",
    };
    const data = Object.fromEntries(template.columns.map(column => [column.key, details[column.key] ?? defaults[column.key] ?? ""]));
    const request = hroRequestForRow(template, data);
    return { key, family, title, summary, values: {
      ...base.values, workerName, workerEmail, scenarioKey: key,
      hireType: template.hireType ?? base.values.hireType,
      workerCategory: data.worker_category || "employee",
      geography: ({ IN: "India", GB: "UK", US: "USA", DE: "Germany", SG: "Singapore" } as Record<string, string>)[data.work_country]!,
      legalEntity: data.legal_entity!, department: data.department!,
      joiningDate: data.joining_date || data.effective_date!,
      urgency: template.id === "onboarding-expedited" || title === "Reported expired authorization" ? "urgent" : "standard",
      planSummary: `${summary} Offline example only; all evidence and human decisions remain pending.`,
      readiness: [{ key: "example-review", label: summary, status: "pending", mandatory: true }],
      processPolicySnapshot: { batchIntake: { ...request, requestType: title } },
    } };
  }));

export const CURATED_OFFLINE_EXAMPLES = [...OFFLINE_CASE_EXAMPLES, ...OFFLINE_EXTENSION_EXAMPLES];
