import type { Intent, SourceRef } from "./types";

// Curated corpus of HRO intents. Sources:
// - "SAP SuccessFactors service catalog (curated)" - intents distilled from the
//   SuccessFactors module scope (EC, ECP, Time, Benefits, Onboarding).
// - "GitHub HR chatbot intents corpora" - open-source HR intent datasets
//   (e.g. HR-chatbot intent collections) mapped to lifecycle domains.
// - "Kaggle HR analytics datasets" - ticket-category distributions used for
//   frequency weights.
// - "Curated (deck flows)" - intents named on the deck's flow slides.
const sapSrc = (note?: string): SourceRef => ({ name: "SAP SuccessFactors service catalog (curated)", confidence: "high", ...(note ? { note } : {}) });
const ghSrc = (note?: string): SourceRef => ({ name: "GitHub HR chatbot intents corpora", confidence: "medium", ...(note ? { note } : {}) });
const kgSrc = (note?: string): SourceRef => ({ name: "Kaggle HR analytics datasets", confidence: "medium", ...(note ? { note } : {}) });
const curatedFlowSrc = (note?: string): SourceRef => ({ name: "Curated product flow", confidence: "high", ...(note ? { note } : {}) });

interface Row {
  key: string;
  name: string;
  domain: string;
  fc: string;
  desc: string;
  src: SourceRef;
  asIs: number; // as-is human minutes
  toBe: number; // residual to-be human minutes
  w: number; // base weight
  get: number;
  put: number;
  sys: number;
  tags: string[];
}

const rows: Row[] = [
  // ---------- pay ----------
  { key: "payslip-copy", name: "Payslip Copy Request", domain: "pay", fc: "fc1-deterministic", desc: "Employee requests a copy of a current or historical payslip.", src: curatedFlowSrc("Included standard flow"), asIs: 12, toBe: 0, w: 10, get: 2, put: 0, sys: 1, tags: ["self-service", "high-volume"] },
  { key: "salary-certificate", name: "Salary / Employment Certificate", domain: "pay", fc: "fc1-deterministic", desc: "Generate an employment or salary confirmation letter for banks or landlords.", src: sapSrc(), asIs: 25, toBe: 1, w: 6, get: 3, put: 1, sys: 2, tags: ["document", "high-volume"] },
  { key: "tax-form-copy", name: "Tax Form / Statement Copy", domain: "pay", fc: "fc1-deterministic", desc: "Retrieve annual tax statements (W-2, P60, Lohnsteuerbescheinigung).", src: ghSrc(), asIs: 15, toBe: 0, w: 5, get: 2, put: 0, sys: 1, tags: ["document", "seasonal"] },
  { key: "bank-details-change", name: "Bank Details Change", domain: "pay", fc: "fc2-policy", desc: "Update payment bank account with fraud-check verification.", src: sapSrc(), asIs: 18, toBe: 2, w: 5, get: 2, put: 1, sys: 2, tags: ["write", "fraud-sensitive"] },
  { key: "payroll-discrepancy", name: "Payroll Discrepancy Dispute", domain: "pay", fc: "fc3-multiagent", desc: "Employee disputes net pay; agents reconcile time, master data and payroll results.", src: curatedFlowSrc("Included standard flow"), asIs: 95, toBe: 12, w: 4, get: 6, put: 2, sys: 3, tags: ["dispute", "multi-system"] },
  { key: "overpayment-recovery", name: "Overpayment Recovery Setup", domain: "pay", fc: "fc3-multiagent", desc: "Detect and set up repayment plan for salary overpayments.", src: kgSrc(), asIs: 80, toBe: 15, w: 1.5, get: 5, put: 2, sys: 3, tags: ["dispute", "financial"] },
  { key: "off-cycle-payment", name: "Off-Cycle Payment Request", domain: "pay", fc: "fc3-multiagent", desc: "Process urgent off-cycle payment for missed wages or termination pay.", src: sapSrc(), asIs: 60, toBe: 10, w: 1.5, get: 4, put: 2, sys: 2, tags: ["write", "urgent"] },
  { key: "garnishment-query", name: "Garnishment / Wage Attachment Query", domain: "pay", fc: "fc2-policy", desc: "Explain a garnishment deduction and its legal basis.", src: kgSrc(), asIs: 35, toBe: 6, w: 1.2, get: 3, put: 0, sys: 2, tags: ["legal", "sensitive"] },
  { key: "pay-frequency-question", name: "Pay Schedule Question", domain: "pay", fc: "fc2-policy", desc: "When is payday, cutoffs and retro rules for my country/entity.", src: ghSrc(), asIs: 8, toBe: 0.5, w: 4, get: 1, put: 0, sys: 1, tags: ["faq"] },
  // ---------- leave ----------
  { key: "leave-balance", name: "Leave Balance Inquiry", domain: "leave", fc: "fc1-deterministic", desc: "Check remaining vacation, sick or PTO balances.", src: curatedFlowSrc("Included standard flow"), asIs: 8, toBe: 0, w: 10, get: 1, put: 0, sys: 1, tags: ["self-service", "high-volume"] },
  { key: "leave-request", name: "Leave Request Submission", domain: "leave", fc: "fc1-deterministic", desc: "Submit vacation or PTO request with policy validation and manager routing.", src: sapSrc(), asIs: 12, toBe: 0.5, w: 8, get: 2, put: 1, sys: 2, tags: ["write", "high-volume"] },
  { key: "leave-cancellation", name: "Leave Cancellation / Change", domain: "leave", fc: "fc1-deterministic", desc: "Cancel or modify an approved absence.", src: ghSrc(), asIs: 10, toBe: 0.5, w: 4, get: 2, put: 1, sys: 2, tags: ["write"] },
  { key: "parental-leave-guidance", name: "Parental Leave Guidance", domain: "leave", fc: "fc2-policy", desc: "Explain entitlement, pay and process for maternity/paternity leave by country.", src: ghSrc(), asIs: 45, toBe: 8, w: 2.5, get: 2, put: 0, sys: 2, tags: ["policy", "sensitive"] },
  { key: "sick-leave-certificate", name: "Sick Note Submission", domain: "leave", fc: "fc1-deterministic", desc: "Submit and register a medical certificate for sick leave.", src: sapSrc(), asIs: 15, toBe: 1, w: 5, get: 1, put: 1, sys: 2, tags: ["document", "write"] },
  { key: "leave-of-absence-case", name: "Extended Leave of Absence Case", domain: "leave", fc: "fc3-multiagent", desc: "Coordinate unpaid/extended leave: eligibility, benefits impact, payroll pause.", src: kgSrc(), asIs: 90, toBe: 18, w: 1, get: 5, put: 3, sys: 3, tags: ["multi-system", "case"] },
  { key: "public-holiday-question", name: "Holiday Calendar Question", domain: "leave", fc: "fc1-deterministic", desc: "Which public holidays apply to my location and schedule.", src: ghSrc(), asIs: 5, toBe: 0, w: 3, get: 1, put: 0, sys: 1, tags: ["faq"] },
  { key: "carryover-policy", name: "Leave Carryover Policy Question", domain: "leave", fc: "fc2-policy", desc: "Explain carryover limits, expiry dates and payout rules.", src: ghSrc(), asIs: 12, toBe: 1, w: 3, get: 1, put: 0, sys: 1, tags: ["policy", "seasonal"] },
  // ---------- time ----------
  { key: "missing-clock-punch", name: "Missing Clock Punch Correction", domain: "time", fc: "fc1-deterministic", desc: "Fix a missing or wrong clock-in/out entry with approval routing.", src: sapSrc(), asIs: 12, toBe: 0.5, w: 7, get: 2, put: 1, sys: 1, tags: ["write", "high-volume"] },
  { key: "overtime-inquiry", name: "Overtime Balance / Payment Inquiry", domain: "time", fc: "fc2-policy", desc: "Explain overtime valuation, balances and payout eligibility.", src: kgSrc(), asIs: 20, toBe: 3, w: 4, get: 2, put: 0, sys: 2, tags: ["policy"] },
  { key: "schedule-change-request", name: "Schedule / Shift Change Request", domain: "time", fc: "fc2-policy", desc: "Request shift swap or schedule change within labor rules.", src: kgSrc(), asIs: 18, toBe: 3, w: 4, get: 2, put: 1, sys: 2, tags: ["write"] },
  { key: "timesheet-reminder-dispute", name: "Timesheet Rejection Dispute", domain: "time", fc: "fc3-multiagent", desc: "Investigate rejected timesheets across project codes and approvals.", src: kgSrc(), asIs: 40, toBe: 8, w: 1.5, get: 4, put: 1, sys: 2, tags: ["dispute"] },
  { key: "time-quota-question", name: "Time Account Question", domain: "time", fc: "fc1-deterministic", desc: "Check flex-time, TOIL or time-account balances.", src: sapSrc(), asIs: 8, toBe: 0, w: 4, get: 1, put: 0, sys: 1, tags: ["self-service"] },
  // ---------- benefits ----------
  { key: "benefits-enrollment", name: "Benefits Enrollment", domain: "benefits", fc: "fc2-policy", desc: "Enroll in health/pension plans during open enrollment with eligibility checks.", src: sapSrc(), asIs: 35, toBe: 4, w: 4, get: 3, put: 2, sys: 2, tags: ["write", "seasonal"] },
  { key: "life-event-change", name: "Qualifying Life Event Change", domain: "benefits", fc: "fc3-multiagent", desc: "Process marriage/birth/divorce driven benefit changes across plans.", src: sapSrc(), asIs: 55, toBe: 8, w: 2, get: 5, put: 3, sys: 3, tags: ["multi-system", "write"] },
  { key: "benefits-eligibility", name: "Benefits Eligibility Question", domain: "benefits", fc: "fc2-policy", desc: "Am I eligible for plan X given my contract type and country.", src: ghSrc(), asIs: 18, toBe: 2, w: 4, get: 2, put: 0, sys: 2, tags: ["policy"] },
  { key: "pension-contribution-change", name: "Pension Contribution Change", domain: "benefits", fc: "fc2-policy", desc: "Change retirement plan contribution percentage.", src: ghSrc(), asIs: 15, toBe: 1.5, w: 2.5, get: 2, put: 1, sys: 2, tags: ["write"] },
  { key: "benefits-claim-issue", name: "Benefits Claim Escalation", domain: "benefits", fc: "fc3-multiagent", desc: "Investigate denied or stuck benefit claims with the carrier.", src: kgSrc(), asIs: 65, toBe: 12, w: 1.2, get: 4, put: 1, sys: 3, tags: ["dispute", "vendor"] },
  { key: "dependent-add", name: "Add / Remove Dependent", domain: "benefits", fc: "fc1-deterministic", desc: "Register a dependent with document verification.", src: sapSrc(), asIs: 20, toBe: 1.5, w: 3, get: 2, put: 1, sys: 2, tags: ["write", "document"] },
  // ---------- hire ----------
  { key: "onboarding-status", name: "Onboarding Status Inquiry", domain: "hire", fc: "fc1-deterministic", desc: "Check pre-boarding task status for a new hire.", src: sapSrc(), asIs: 10, toBe: 0.5, w: 4, get: 2, put: 0, sys: 2, tags: ["self-service"] },
  { key: "new-hire-setup", name: "New Hire Data Setup", domain: "hire", fc: "fc3-multiagent", desc: "Provision employee record, payroll, time profile, IT access from signed offer.", src: sapSrc(), asIs: 120, toBe: 15, w: 3, get: 5, put: 5, sys: 4, tags: ["multi-system", "write"] },
  { key: "contract-generation", name: "Employment Contract Generation", domain: "hire", fc: "fc2-policy", desc: "Generate a compliant contract from templates with clause selection.", src: sapSrc(), asIs: 55, toBe: 8, w: 2.5, get: 3, put: 1, sys: 2, tags: ["document", "legal"] },
  { key: "probation-confirmation", name: "Probation Period Confirmation", domain: "hire", fc: "fc1-deterministic", desc: "Track and confirm probation completion with manager sign-off.", src: kgSrc(), asIs: 20, toBe: 2, w: 2, get: 2, put: 1, sys: 2, tags: ["write"] },
  { key: "referral-question", name: "Referral Program Question", domain: "hire", fc: "fc2-policy", desc: "Explain referral bonus rules and payout timing.", src: ghSrc(), asIs: 10, toBe: 1, w: 2, get: 1, put: 0, sys: 1, tags: ["faq"] },
  { key: "background-check-chase", name: "Background Check Follow-Up", domain: "hire", fc: "fc3-multiagent", desc: "Chase and reconcile background-check status with vendor and start date.", src: kgSrc(), asIs: 45, toBe: 8, w: 1.2, get: 3, put: 1, sys: 3, tags: ["vendor"] },
  // ---------- develop ----------
  { key: "training-enrollment", name: "Training Course Enrollment", domain: "develop", fc: "fc1-deterministic", desc: "Enroll in catalog courses with approval and budget checks.", src: sapSrc(), asIs: 12, toBe: 0.5, w: 4, get: 2, put: 1, sys: 2, tags: ["write", "self-service"] },
  { key: "certification-tracking", name: "Certification Expiry Question", domain: "develop", fc: "fc1-deterministic", desc: "Check certification status and renewal deadlines.", src: kgSrc(), asIs: 10, toBe: 0.5, w: 2.5, get: 2, put: 0, sys: 2, tags: ["compliance"] },
  { key: "tuition-reimbursement", name: "Tuition Reimbursement Request", domain: "develop", fc: "fc2-policy", desc: "Check eligibility and submit education reimbursement claims.", src: ghSrc(), asIs: 30, toBe: 5, w: 1.5, get: 2, put: 1, sys: 2, tags: ["policy", "financial"] },
  { key: "performance-cycle-question", name: "Performance Review Process Question", domain: "develop", fc: "fc2-policy", desc: "Explain review timeline, forms and calibration process.", src: ghSrc(), asIs: 12, toBe: 1, w: 2.5, get: 1, put: 0, sys: 1, tags: ["faq", "seasonal"] },
  { key: "mandatory-training-chase", name: "Compliance Training Escalation", domain: "develop", fc: "fc1-deterministic", desc: "Notify and track overdue mandatory training completion.", src: kgSrc(), asIs: 8, toBe: 0.5, w: 2.5, get: 2, put: 1, sys: 2, tags: ["compliance", "outbound"] },
  // ---------- mobility ----------
  { key: "cross-border-relocation", name: "Cross-Border Relocation Case", domain: "mobility", fc: "fc4-frontier", desc: "End-to-end international relocation: tax, immigration, payroll split, benefits.", src: curatedFlowSrc("Included complex-case flow"), asIs: 480, toBe: 90, w: 0.4, get: 8, put: 6, sys: 5, tags: ["frontier", "case", "multi-country"] },
  { key: "visa-status-question", name: "Work Authorization Question", domain: "mobility", fc: "fc2-policy", desc: "Explain visa/work-permit status implications for employment.", src: ghSrc(), asIs: 30, toBe: 6, w: 1.2, get: 2, put: 0, sys: 2, tags: ["legal", "sensitive"] },
  { key: "domestic-transfer", name: "Domestic Transfer Processing", domain: "mobility", fc: "fc3-multiagent", desc: "Process location/entity transfer with comp, payroll and system updates.", src: sapSrc(), asIs: 75, toBe: 12, w: 1.2, get: 5, put: 4, sys: 3, tags: ["multi-system", "write"] },
  { key: "remote-work-request", name: "Work-From-Abroad Request", domain: "mobility", fc: "fc4-frontier", desc: "Assess tax/social-security/permanent-establishment risk of temporary work abroad.", src: kgSrc(), asIs: 120, toBe: 25, w: 0.8, get: 4, put: 1, sys: 3, tags: ["frontier", "risk"] },
  { key: "relocation-allowance", name: "Relocation Allowance Question", domain: "mobility", fc: "fc2-policy", desc: "Explain relocation package components and claim process.", src: ghSrc(), asIs: 20, toBe: 3, w: 1, get: 2, put: 0, sys: 1, tags: ["policy"] },
  // ---------- retire ----------
  { key: "retirement-estimate", name: "Retirement Date / Pension Estimate", domain: "retire", fc: "fc2-policy", desc: "Provide projected retirement dates and pension estimates.", src: sapSrc(), asIs: 40, toBe: 8, w: 1.5, get: 3, put: 0, sys: 2, tags: ["sensitive"] },
  { key: "retirement-initiation", name: "Retirement Process Initiation", domain: "retire", fc: "fc3-multiagent", desc: "Kick off retirement: notifications, benefits conversion, payroll finalization.", src: sapSrc(), asIs: 150, toBe: 30, w: 0.7, get: 5, put: 4, sys: 4, tags: ["case", "multi-system"] },
  { key: "offboarding-exit", name: "Voluntary Exit Offboarding", domain: "retire", fc: "fc3-multiagent", desc: "Process resignation: final pay, asset return, access revocation, references.", src: sapSrc(), asIs: 100, toBe: 15, w: 2, get: 5, put: 5, sys: 4, tags: ["multi-system", "write"] },
  { key: "final-pay-question", name: "Final Settlement Question", domain: "retire", fc: "fc2-policy", desc: "Explain final pay components, unused leave payout and timing.", src: ghSrc(), asIs: 20, toBe: 3, w: 1.5, get: 2, put: 0, sys: 2, tags: ["policy"] },
  { key: "reference-letter", name: "Employment Reference Letter", domain: "retire", fc: "fc1-deterministic", desc: "Generate a standard employment reference for a former employee.", src: ghSrc(), asIs: 25, toBe: 2, w: 1.5, get: 2, put: 1, sys: 2, tags: ["document"] },
  // ---------- data-admin ----------
  { key: "address-change", name: "Address Change", domain: "data-admin", fc: "fc1-deterministic", desc: "Update home address with downstream tax/benefits propagation.", src: sapSrc(), asIs: 10, toBe: 0.5, w: 6, get: 1, put: 2, sys: 2, tags: ["write", "high-volume"] },
  { key: "name-change", name: "Legal Name Change", domain: "data-admin", fc: "fc2-policy", desc: "Process legal name change with document verification across systems.", src: sapSrc(), asIs: 30, toBe: 4, w: 1.5, get: 2, put: 3, sys: 3, tags: ["write", "document"] },
  { key: "emergency-contact-update", name: "Emergency Contact Update", domain: "data-admin", fc: "fc1-deterministic", desc: "Add or update emergency contact details.", src: ghSrc(), asIs: 6, toBe: 0, w: 3.5, get: 1, put: 1, sys: 1, tags: ["write", "self-service"] },
  { key: "org-data-correction", name: "Org Assignment Correction", domain: "data-admin", fc: "fc3-multiagent", desc: "Fix wrong cost center / manager / org assignment with retro effects.", src: kgSrc(), asIs: 45, toBe: 8, w: 2, get: 4, put: 2, sys: 3, tags: ["multi-system", "retro"] },
  { key: "data-privacy-request", name: "Data Subject Access Request", domain: "data-admin", fc: "fc4-frontier", desc: "Compile GDPR/DSAR data export with legal review across all systems.", src: kgSrc(), asIs: 240, toBe: 45, w: 0.3, get: 8, put: 1, sys: 5, tags: ["frontier", "legal", "compliance"] },
  { key: "employee-data-report", name: "Manager Team Data Report", domain: "data-admin", fc: "fc1-deterministic", desc: "Generate team roster/headcount extract for a manager.", src: kgSrc(), asIs: 15, toBe: 1, w: 2.5, get: 3, put: 0, sys: 2, tags: ["report"] },
  // ---------- policy ----------
  { key: "policy-question", name: "General Policy Question", domain: "policy", fc: "fc2-policy", desc: "Answer questions on HR policies grounded in the client's policy corpus.", src: curatedFlowSrc("Included standard flow"), asIs: 15, toBe: 1.5, w: 8, get: 1, put: 0, sys: 1, tags: ["high-volume", "grounded"] },
  { key: "code-of-conduct-question", name: "Code of Conduct Clarification", domain: "policy", fc: "fc2-policy", desc: "Clarify conduct rules, gifts policy, conflicts of interest.", src: ghSrc(), asIs: 15, toBe: 2, w: 2, get: 1, put: 0, sys: 1, tags: ["grounded"] },
  { key: "grievance-intake", name: "Grievance / Complaint Intake", domain: "policy", fc: "fc4-frontier", desc: "Structured intake and triage of workplace grievances with mandatory human handling.", src: kgSrc(), asIs: 90, toBe: 45, w: 0.6, get: 2, put: 1, sys: 2, tags: ["sensitive", "human-led"] },
  { key: "works-council-query", name: "Works Council Agreement Query", domain: "policy", fc: "fc2-policy", desc: "Interpret collective/works-council agreement clauses by site.", src: kgSrc(), asIs: 35, toBe: 8, w: 1, get: 2, put: 0, sys: 1, tags: ["legal", "grounded"] },
  { key: "policy-exception-request", name: "Policy Exception Request", domain: "policy", fc: "fc4-frontier", desc: "Evaluate exception requests against precedent and escalate with recommendation.", src: kgSrc(), asIs: 60, toBe: 20, w: 0.6, get: 3, put: 1, sys: 2, tags: ["judgment", "case"] },
];

export const intents: Intent[] = rows.map((r, i) => ({
  id: i + 1,
  key: r.key,
  name: r.name,
  domain: r.domain,
  flowClass: r.fc,
  description: r.desc,
  source: r.src,
  asIsHandlingMin: r.asIs,
  toBeHumanMin: r.toBe,
  baseWeight: r.w,
  actGetActions: r.get,
  actPutActions: r.put,
  systemsTouchedBase: r.sys,
  tags: r.tags,
}));

export const intentMap: Record<string, Intent> = Object.fromEntries(
  intents.map((it) => [it.key, it]),
);
