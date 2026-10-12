import { HRO_BATCH_TEMPLATES, hroRequestForRow } from "./hro-batch-templates";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";

/** New slots deliberately do not overlap any historical coverage identifiers. */
export const OFFLINE_EXAMPLE_PREFIX = "UAT-DEMO-EXAMPLES:additional-v1:";
const requests = [
  ["Onboarding", "onboarding-external-fte", [
    ["Remote analyst intake", "A remote analyst needs an equipment plan and an offer-package review."],
    ["Graduate engineer intake", "A graduate engineer needs induction planning and pending document review."],
    ["Regional sales hire", "A regional sales hire needs a proposed start-date and territory-access review."],
    ["Office operations hire", "An office operations hire needs workplace logistics and policy review."],
    ["Quality specialist hire", "A quality specialist needs a role-specific learning and documentation plan."],
  ]],
  ["Employee Changes", "employee-changes-role", [
    ["Team-lead promotion review", "Review a proposed promotion and the resulting manager responsibilities."],
    ["Department move review", "Review a move from customer support to service operations."],
    ["Role-title correction", "Review a requested correction to a worker's recorded role title."],
    ["Reporting-line change", "Review a proposed reporting-line change alongside the role record."],
    ["Part-time role transition", "Review a proposed role transition with a changed working arrangement."],
  ]],
  ["Payroll", "payroll-bank-change", [
    ["Bank change before cutoff", "Review a bank-change request received before the next payroll cutoff."],
    ["Bank change after cutoff", "Review whether a late bank-change request needs a later effective date."],
    ["Secure submission pending", "A bank-change request is awaiting a secure submission reference."],
    ["Effective-date clarification", "A bank-change request needs clarification of the proposed effective date."],
    ["Identity review pending", "A bank-change request is held pending independent identity review."],
  ]],
  ["Benefits", "benefits-life-event", [
    ["Marriage coverage review", "Review proposed coverage following a reported marriage; evidence is pending."],
    ["Birth coverage review", "Review a reported birth-related enrolment request without dependent details."],
    ["Adoption coverage review", "Review proposed adoption-related coverage and its effective-date rules."],
    ["Life-event window review", "Review a life-event request submitted near the enrolment deadline."],
    ["Plan eligibility question", "Review which plan applies to a reported life event; eligibility is unverified."],
  ]],
  ["Leave", "leave-request", [
    ["Annual leave request", "Review a proposed annual leave period and manager capacity planning."],
    ["Parental leave request", "Review parental leave dates and unresolved entitlement evidence."],
    ["Unpaid leave request", "Review a proposed unpaid leave period and payroll dependencies."],
    ["Leave date correction", "Review a requested correction to the dates on a leave proposal."],
    ["Return-date clarification", "Review a leave request with an unresolved planned return date."],
  ]],
  ["Compliance", "compliance-work-authorization", [
    ["Authorization renewal intake", "Review a renewal request before authorization expiry; source evidence is pending."],
    ["Expiry-date discrepancy", "Review inconsistent reported expiry dates without making an eligibility decision."],
    ["Renewal evidence missing", "A renewal request is blocked pending a verified evidence reference."],
    ["Country review pending", "Review the applicable country rules for a proposed authorization renewal."],
    ["Renewal deadline review", "Review a short renewal window; continued work is not authorized."],
  ]],
  ["Offboarding", "offboarding-separation", [
    ["Resignation preparation", "Prepare a proposed resignation checklist; exit authority and closure remain pending."],
    ["Retirement preparation", "Review proposed retirement dates and unresolved payroll dependencies."],
    ["Notice-date clarification", "Review conflicting proposed notice and last-working dates before any action."],
    ["Asset-return planning", "Prepare an asset-return plan for a proposed departure; nothing has been recovered."],
    ["Knowledge-handover planning", "Review proposed handover responsibilities; no access revocation or closure is recorded."],
  ]],
  ["HR Helpdesk", "hr-helpdesk-letter", [
    ["Bank letter inquiry", "Review an inquiry about an employment letter for a bank; no letter has been issued."],
    ["Housing letter inquiry", "Review a housing-related employment-letter request and required verification."],
    ["Employment dates question", "Clarify which employment dates a requested letter should cover."],
    ["Letter-language inquiry", "Review a request for an employment letter in another language."],
    ["Letter correction inquiry", "Review a proposed correction to a letter request; no signed document exists."],
  ]],
  ["IT Access", "it-access-request", [
    ["Read-only finance access", "Review proposed read-only finance application access; all approvals are pending."],
    ["Time-limited project access", "Review proposed project access with an expiry date; no entitlement is granted."],
    ["Privileged access review", "Review a proposed privileged role and unresolved segregation-of-duties checks."],
    ["Role-change access review", "Review access changes proposed after a team move; no system has been changed."],
    ["Application-owner clarification", "Identify the appropriate reviewer for an application access proposal."],
  ]],
  ["Learning", "learning-certification", [
    ["Security induction planning", "Review a proposed security induction assignment; no LMS enrolment exists."],
    ["Manager curriculum planning", "Review a proposed first-time manager curriculum and its applicable version."],
    ["Certification renewal planning", "Review a proposed certification renewal; completion evidence is absent."],
    ["Course accessibility inquiry", "Review delivery options for a proposed learning assignment."],
    ["Learning deadline clarification", "Review a proposed curriculum deadline and unresolved assignment scope."],
  ]],
  ["Mobility", "mobility-transfer", [
    ["Country transfer planning", "Review a proposed country transfer; immigration, tax and entity decisions are pending."],
    ["Relocation-date clarification", "Review conflicting proposed relocation and employment-effective dates."],
    ["Destination entity review", "Review the proposed destination entity without changing the worker record."],
    ["Temporary assignment planning", "Review a proposed temporary overseas assignment and return plan."],
    ["Transfer dependency review", "Review payroll and benefits dependencies for a proposed cross-border move."],
  ]],
  ["Documents", "documents-acknowledgement", [
    ["Security policy review", "Review a proposed information-security acknowledgement request; none is recorded."],
    ["Conduct policy review", "Review a proposed code-of-conduct acknowledgement and document version."],
    ["Remote-work policy review", "Review a proposed remote-work policy acknowledgement request."],
    ["Policy version clarification", "Clarify which policy revision a proposed acknowledgement should reference."],
    ["Acknowledgement deadline review", "Review a proposed acknowledgement deadline; no delivery or response is recorded."],
  ]],
] as const;

const profiles = [
  ["Ari Linden", "Business Analyst", "Operations", "India", "IN", "Example India Ltd"],
  ["Mika Rowan", "Support Engineer", "Engineering", "UK", "GB", "Example UK Ltd"],
  ["Tala Brook", "Sales Coordinator", "Sales", "USA", "US", "Example Americas Inc"],
  ["Nico Vale", "Operations Associate", "Service Operations", "Germany", "DE", "Example Europe GmbH"],
  ["Rhea Finch", "Quality Specialist", "Quality", "Singapore", "SG", "Example APAC Pte Ltd"],
] as const;
const surnames = ["Linden", "Rowan", "Brook", "Vale", "Finch", "Reed", "Ash", "Glen", "Wren", "Elm", "Cedar", "Lake"] as const;

export const OFFLINE_CASE_EXAMPLES = requests.flatMap(([family, templateId, entries], familyIndex) =>
  entries.map(([title, summary], slot) => {
    const template = HRO_BATCH_TEMPLATES.find(item => item.id === templateId && item.family === family);
    if (!template) throw new Error(`Unknown offline example template: ${templateId}`);
    const [name, role, department, geography, country, legalEntity] = profiles[(slot + familyIndex) % profiles.length]!;
    const key = `${OFFLINE_EXAMPLE_PREFIX}${templateId}:${slot + 1}`;
    const request = hroRequestForRow(template, {
      request_id: key,
      request_summary: summary,
      worker_name: `Example — ${name.split(" ")[0]} ${surnames[familyIndex]}`,
      worker_email: `example-${familyIndex + 1}-${slot + 1}@hro.invalid`,
      work_country: country,
      legal_entity: legalEntity,
      department,
    });
    return {
      key, family, title, summary,
      values: {
        workerName: request.data.worker_name!,
        workerEmail: request.data.worker_email!,
        workerPhone: null,
        channelPreference: "email",
        hireType: family === "Onboarding" ? "external-fte" : family === "Employee Changes" || family === "Mobility" ? "internal-transfer" : family === "Offboarding" ? "offboarding" : "employee-service",
        workerCategory: "employee",
        role, department, geography, legalEntity,
        managerName: "Example manager",
        recruiterName: "Example service coordinator",
        joiningDate: `2030-11-${String(10 + slot).padStart(2, "0")}`,
        urgency: "standard",
        lifecycleStage: "service-intake",
        orchestrationStatus: "blocked",
        orchestrationCheckpoint: "synthetic-offline",
        orchestrationClaimOwner: null,
        orchestrationClaimUntil: null,
        controllerRetired: true,
        syntheticProvenance: "demo-full-coverage" as const,
        scenarioKey: key,
        planSummary: `${summary} Offline example only; all evidence and human decisions remain pending.`,
        notes: `${SYNTHETIC_OFFLINE_MARKER} Offline example. Read-only; no outreach, provider operation, approval authority or business outcome.`,
        readiness: [{ key: "example-review", label: "Evidence and human review pending", status: "pending", mandatory: true }],
        workstreams: [{ key: "example-review", label: `${family} request review`, agent: "none", status: "pending", owner: "Unassigned — offline example", blockers: ["Offline example; no execution permitted"] }],
        processPolicySnapshot: { batchIntake: { ...request, requestType: title } },
        checklistSnapshot: [],
        checklistProfileName: "Offline example — no execution policy",
        checklistMatchExplanation: "No operational policy or authority is adopted by an offline example.",
        offerAcceptanceComplete: false,
        candidateEmailAuthorizedAt: null,
        candidateEmailAuthorizedBy: null,
        createdByUserId: null,
      },
    };
  }),
);
