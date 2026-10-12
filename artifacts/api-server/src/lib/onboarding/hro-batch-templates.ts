import { createHash } from "node:crypto";

export type IntakeColumn = { key: string; label: string; required: boolean; description: string; kind: "text" | "date" | "email" | "country" | "choice"; values?: string[] };
export type IntakeTemplate = { id: string; version: number; family: string; name: string; description: string; columns: IntakeColumn[]; hireType?: string };
const column = (key: string, label: string, kind: IntakeColumn["kind"] = "text", required = true, description = "", values?: string[]): IntakeColumn => ({ key, label, kind, required, description, ...(values ? { values } : {}) });
const common = [
  column("template_id", "Template ID", "text", true, "Keep the downloaded template identifier unchanged."),
  column("template_version", "Template version", "text", true, "Keep the downloaded version unchanged."),
  column("request_id", "Request ID", "text", true, "Your unique source request reference. Reuse it only to retry the same request."),
  column("worker_name", "Worker name"),
  column("worker_email", "Worker email", "email"),
  column("work_country", "Work country", "country", true, "Two-letter country code; used for the approved collection policy."),
  column("legal_entity", "Legal entity"),
  column("department", "Department"),
];
const onboarding = [
  column("role", "Role"), column("manager_name", "Manager name"), column("recruiter_name", "Recruiter name"),
  column("joining_date", "Joining date", "date"),
  column("worker_category", "Worker category", "choice", true, "", ["employee", "contractor", "contingent"]),
  column("job_profile_id", "Job profile ID", "text", false, "Optional enabled tenant job-profile identifier."),
  column("work_environment", "Work environment", "choice", false, "", ["office", "remote", "site", "field", "mixed"]),
  column("site", "Site", "text", false),
  ...["site_exposure", "safety_critical", "assisted_intake"].map(key => column(key, key.replaceAll("_", " "), "choice", false, "Blank means unknown, not no.", ["yes", "no", "unknown"])),
];
const service = [column("employee_id", "Employee ID", "text", true, "A supplied employee reference; intake does not verify employment or identity."), column("effective_date", "Effective date", "date")];
const template = (id: string, family: string, name: string, columns: IntakeColumn[], hireType?: string): IntakeTemplate => ({
  id, version: 1, family, name,
  description: hireType ? "Creates held intake cases. Offer acceptance and existing review gates still apply." : "Creates held specialist-review requests only. No external changes, eligibility decisions or employee contact are authorized.",
  columns: [...common, ...columns], ...(hireType ? { hireType } : {}),
});

export const HRO_BATCH_TEMPLATES: IntakeTemplate[] = [
  template("onboarding-external-fte", "Onboarding", "External employee onboarding", onboarding, "external-fte"),
  template("onboarding-contractor", "Onboarding", "Contractor onboarding", [...onboarding, column("engagement_end_date", "Engagement end date", "date"), column("engagement_reference", "Engagement reference")], "contractor"),
  template("onboarding-rehire", "Onboarding", "Rehire onboarding", [...onboarding, column("previous_employee_id", "Previous employee ID"), column("previous_employment_reference", "Previous employment reference")], "rehire"),
  template("employee-changes-role", "Employee Changes", "Role / department change", [...service, column("new_role", "New role"), column("new_department", "New department"), column("change_reference", "Change request reference")]),
  template("payroll-bank-change", "Payroll", "Bank-detail change request", [...service, column("secure_submission_reference", "Secure bank-details submission reference", "text", true, "Reference only. Never put bank-account numbers into this workbook.")]),
  template("benefits-life-event", "Benefits", "Life-event enrolment request", [...service, column("event_type", "Event type", "choice", true, "", ["marriage", "birth", "adoption", "other"]), column("event_date", "Event date", "date"), column("benefit_plan_reference", "Benefit plan reference"), column("evidence_reference", "Evidence reference", "text", false, "Reference only; no dependent or medical details.")]),
  template("leave-request", "Leave", "Leave request", [...service, column("leave_type", "Leave type", "choice", true, "", ["annual", "parental", "unpaid", "other"]), column("start_date", "Start date", "date"), column("end_date", "End date", "date"), column("evidence_reference", "Evidence reference", "text", false, "Do not include diagnoses or health findings.")]),
  template("compliance-work-authorization", "Compliance", "Work-authorization renewal request", [...service, column("authorization_expiry_date", "Authorization expiry date", "date"), column("evidence_reference", "Evidence reference", "text", true, "Reference only; do not include passport or identity-document numbers.")]),
   { ...template("offboarding-separation", "Offboarding", "Controlled separation request", [
     ...service.map(c => c.key === "worker_email" ? { ...c, required: false, description: "Optional metadata only; separation intake does not authorize contact." } : c.key === "employee_id" ? { ...c, required: true } : c), column("separation_type", "Human-supplied exit type"), column("exit_reason", "Restricted exit reason"),
     column("last_working_date", "Last working day", "date"), column("termination_date", "Termination date", "date"),
     column("time_zone", "IANA time zone"), column("role", "Role"), column("worker_category", "Worker category"),
     column("manager_name", "Manager"), column("notice_reference", "Source provenance reference"),
   ]), version: 2, description: "Creates a held dedicated separation case. Gateway A and approved offboarding policy are required. Final closure is unavailable pending section 4.6." },
  template("hr-helpdesk-letter", "HR Helpdesk", "Employment-letter request", [...service, column("letter_type", "Letter type", "choice", true, "", ["employment-confirmation", "experience", "other"]), column("purpose_reference", "Purpose reference")]),
  template("it-access-request", "IT Access", "Application-access request", [...service, column("application_reference", "Application reference"), column("access_role", "Requested access role"), column("access_end_date", "Access end date", "date"), column("business_justification_reference", "Business justification reference")]),
  template("learning-certification", "Learning", "Certification / course assignment request", [...service, column("course_reference", "Course / certification reference"), column("due_date", "Due date", "date")]),
  template("mobility-transfer", "Mobility", "Cross-border transfer request", [...service, column("destination_country", "Destination country", "country"), column("destination_entity", "Destination legal entity"), column("destination_role", "Destination role"), column("transfer_reference", "Transfer approval reference")]),
  template("documents-acknowledgement", "Documents", "Policy acknowledgement request", [...service, column("document_reference", "Document reference"), column("document_version", "Document version"), column("due_date", "Due date", "date")]),
];

export type HroIntakeRow = Record<string, string>;
export type HroIntakeIssue = { row: number; column: string; message: string };
export type HroBatchRequest = { templateId: string; templateVersion: number; family: string; requestType: string; requestId: string; data: HroIntakeRow; fingerprint: string; employeeReferenceStatus: "supplied-not-verified" | "not-applicable"; executionMode: "onboarding-review" | "specialist-review-only" };
export function findHroTemplate(id: unknown): IntakeTemplate | undefined { return HRO_BATCH_TEMPLATES.find(item => item.id === id); }
export function canonicalIntakeHash(value: unknown): string {
  const ordered = (input: unknown): unknown => Array.isArray(input) ? input.map(ordered) : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, ordered(val)])) : input;
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function validateHroRows(templateId: unknown, version: unknown, input: unknown) {
  const definition = findHroTemplate(templateId);
  const issues: HroIntakeIssue[] = [];
  const rows: HroIntakeRow[] = [];
  if (!definition || version !== definition.version) return { valid: false, rows, issues: [{ row: 0, column: "template", message: "Choose a supported template and its current version; download a fresh copy." }] };
  if (!Array.isArray(input) || input.length < 1 || input.length > 500) return { valid: false, rows, issues: [{ row: 0, column: "file", message: "Provide between 1 and 500 populated request rows." }] };
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    const rowNumber = index + 2;
    const row: HroIntakeRow = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push({ row: rowNumber, column: "row", message: "Each row must contain named text columns." }); continue;
    }
    const allowed = new Set(definition.columns.map(item => item.key));
    for (const key of Object.keys(raw)) if (!allowed.has(key)) issues.push({ row: rowNumber, column: key.slice(0, 80), message: "Unexpected column. Use this case type's downloaded template; extra data is not accepted." });
    for (const field of definition.columns) {
      const candidate = (raw as Record<string, unknown>)[field.key];
      if (candidate !== undefined && typeof candidate !== "string") {
        issues.push({ row: rowNumber, column: field.key, message: "Enter a plain text value, not a formula, object or number." }); continue;
      }
      const value = ((candidate ?? "") as string).trim();
      row[field.key] = value;
      if (!value && field.required) issues.push({ row: rowNumber, column: field.key, message: `${field.label} is required.` });
      if (value.length > 240 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || /^[=+@]/.test(value) || /^-\D/.test(value)) issues.push({ row: rowNumber, column: field.key, message: "Use at most 240 characters of plain text; formulas and control characters are not allowed." });
      if (!value) continue;
      if (field.kind === "date" && !validDate(value)) issues.push({ row: rowNumber, column: field.key, message: "Use a real calendar date in YYYY-MM-DD format." });
      if (field.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) issues.push({ row: rowNumber, column: field.key, message: "Enter a valid email address." });
      if (field.kind === "country" && !/^[A-Z]{2}$/.test(value)) issues.push({ row: rowNumber, column: field.key, message: "Use an uppercase two-letter country code, e.g. IN or US." });
      if (field.kind === "choice" && !field.values?.includes(value)) issues.push({ row: rowNumber, column: field.key, message: `Choose one of: ${field.values?.join(", ")}.` });
    }
    if (row.template_id !== definition.id || row.template_version !== String(definition.version)) issues.push({ row: rowNumber, column: "template_id", message: "This row belongs to a different template or version. Download the selected template." });
    if (row.request_id && seen.has(row.request_id)) issues.push({ row: rowNumber, column: "request_id", message: "Duplicate request ID in this file. Each request needs its own reference." });
    seen.add(row.request_id);
    for (const [start, end] of [["start_date", "end_date"], ["joining_date", "engagement_end_date"], ["effective_date", "access_end_date"]] as const) {
      if (row[start] && row[end] && validDate(row[start]) && validDate(row[end]) && row[end] < row[start]) issues.push({ row: rowNumber, column: end, message: `${end} cannot be before ${start}.` });
    }
    rows.push(row);
  }
  return { valid: issues.length === 0, rows, issues: issues.slice(0, 2500) };
}
export function hroRequestForRow(definition: IntakeTemplate, row: HroIntakeRow): HroBatchRequest {
  return { templateId: definition.id, templateVersion: definition.version, family: definition.family, requestType: definition.name, requestId: row.request_id, data: row, fingerprint: canonicalIntakeHash(row), employeeReferenceStatus: definition.hireType ? "not-applicable" : "supplied-not-verified", executionMode: definition.hireType ? "onboarding-review" : "specialist-review-only" };
}
export function readHroBatchRequest(snapshot: unknown): HroBatchRequest | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const request = (snapshot as { batchIntake?: HroBatchRequest }).batchIntake;
  const definition = findHroTemplate(request?.templateId);
  return definition && request && Number.isInteger(request.templateVersion) && request.templateVersion >= 1 && request.templateVersion <= definition.version &&
    request.family === definition.family && typeof request.requestId === "string" && typeof request.requestType === "string" &&
    request.data && typeof request.data === "object" && !Array.isArray(request.data) &&
    Object.values(request.data).every(value => typeof value === "string") && request.data.request_id === request.requestId &&
    request.fingerprint === canonicalIntakeHash(request.data) &&
    request.executionMode === (definition.hireType ? "onboarding-review" : "specialist-review-only") ? request : null;
}
/** Input narratives have their own notes/sensitive projection, not policy-read access. */
export function policyWithoutBatchIntake(snapshot: Record<string, unknown>): Record<string, unknown> {
  const { batchIntake: _privateIntake, ...policy } = snapshot;
  return policy;
}
