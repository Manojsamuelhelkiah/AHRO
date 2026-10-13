import { HRO_BATCH_TEMPLATES, findHroTemplate, validateHroRows, type IntakeTemplate } from "./onboarding/hro-batch-templates";

/** One schema registry for spreadsheet and mailbox request review. No execution authority. */
export const HRO_EMAIL_TEMPLATES = HRO_BATCH_TEMPLATES;
const restricted = /\b(?:iban|swift|bank\s*account|account\s*number|passport\s*(?:number|no)|national\s*id|social\s*security|diagnos(?:is|ed)|medical\s*(?:condition|finding)|routing\s*number)\b|\b\d{12,19}\b/i;
export function unsafeIntakeValue(value: string): boolean { return restricted.test(value); }
export function emailExample(t: IntakeTemplate): string {
  return t.columns.filter(c => c.required).map(c => `${c.key}: ${c.key === "template_id" ? t.id : c.key === "template_version" ? t.version :
    c.key === "request_id" ? "your-source-reference" : c.key === "time_zone" ? "America/New_York" :
    c.values ? c.values[0] : c.kind === "date" ? "2030-01-15" : c.kind === "country" ? "US" : c.kind === "email" ? "worker@example.invalid" :
    c.key.endsWith("_reference") ? "reviewed-source-reference" : `Example ${c.label}`}`).join("\n");
}
export function classifyEmail(subject: string, body: string) {
  const input = `${subject}\n${body}`.slice(0, 32_768);
  const pairs: Record<string, string> = {};
  const repeated = new Set<string>();
  for (const line of body.slice(0, 32_768).split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z_]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (Object.hasOwn(pairs, key)) repeated.add(key);
    else pairs[key] = match[2].trim();
  }
  const explicit = findHroTemplate(pairs.template_id);
  // Suggestions are never a case type until a reviewer chooses it.
  const keywords: Record<string, RegExp> = {
    "onboarding-external-fte": /\b(onboard|new hire|joining)\b/i,
    "onboarding-contractor": /\bcontractor\b/i,
    "onboarding-rehire": /\brehire\b/i,
    "onboarding-campus-cohort": /\bcampus\b/i,
    "onboarding-expedited": /\bexpedited\b/i,
    "employee-changes-internal-transfer": /\binternal transfer\b/i,
    "employee-changes-role": /\b(role change|department change|promotion)\b/i,
    "payroll-bank-change": /\b(bank|payroll)\b/i,
    "benefits-life-event": /\b(benefits|enrolment|life event)\b/i,
    "leave-request": /\b(leave|vacation)\b/i,
    "compliance-work-authorization": /\b(work authorization|work permit|visa renewal)\b/i,
    "offboarding-separation": /\b(offboard|separation|resignation|termination)\b/i,
    "hr-helpdesk-letter": /\b(employment letter|experience letter)\b/i,
    "it-access-request": /\b(application access|access request)\b/i,
    "learning-certification": /\b(certification|course assignment|training)\b/i,
    "mobility-transfer": /\b(cross.border|international transfer)\b/i,
    "documents-acknowledgement": /\b(policy acknowledgement|acknowledgment)\b/i,
  };
  const candidates = explicit ? [explicit] : HRO_EMAIL_TEMPLATES.filter(t => keywords[t.id]?.test(input));
  const template = candidates.length === 1 ? candidates[0] : undefined;
  const fields: Record<string, string> = {};
  let sensitive = unsafeIntakeValue(input);
  if (template) {
    for (const column of template.columns) {
      const value = pairs[column.key];
      if (value && value.length <= 240 && !repeated.has(column.key) && !unsafeIntakeValue(value)) fields[column.key] = value;
      else if (value && unsafeIntakeValue(value)) sensitive = true;
    }
    // Conservative natural-language extraction only for explicitly labelled
    // facts. Never infer a person, country, date or authority from sender identity.
    const language: Record<string, RegExp> = {
      worker_name: /\b(?:worker|employee|new hire)\s+(?:name\s+)?(?:is|=)\s+([A-Za-z][A-Za-z .'-]{1,100})(?=[,;\n]|$)/i,
      worker_email: /\b(?:worker|employee)\s+email\s+(?:is|=)\s+([^\s,;]+@[^\s,;]+)/i,
      work_country: /\bwork country\s+(?:is|=)\s+([A-Z]{2})(?=[,;\s]|$)/i,
      joining_date: /\b(?:joining date|starts on)\s*(?:is|=)?\s*(\d{4}-\d{2}-\d{2})\b/i,
      effective_date: /\beffective date\s*(?:is|=)?\s*(\d{4}-\d{2}-\d{2})\b/i,
      employee_id: /\bemployee id\s+(?:is|=)\s+([A-Za-z0-9_-]{1,80})\b/i,
    };
    for (const c of template.columns) if (!fields[c.key]) {
      const value = language[c.key]?.exec(input)?.[1];
      if (value && !unsafeIntakeValue(value)) fields[c.key] = value;
    }
  }
  return {
    templateId: template?.id ?? null,
    family: template?.family ?? null,
    fields,
    uncertainty: explicit ? "Explicit template still requires human review." : candidates.length === 1 ? "Keyword suggestion only; confirm classification." : "Classification is uncertain; choose a request template.",
    blockedReason: sensitive ? "Potential sensitive values detected. Supply secure collection references, not bank, medical or identity values." : repeated.size ? "Repeated fields require manual correction." : null,
    missingFields: template ? missingEmailFields(template.id, fields) : ["template_id"],
  };
}
export function missingEmailFields(templateId: string, fields: Record<string, string>): string[] {
  const t = findHroTemplate(templateId);
  return t ? t.columns.filter(c => c.required && !fields[c.key]?.trim()).map(c => c.key) : ["template_id"];
}
export function validateEmailReview(templateId: string, input: unknown) {
  const t = findHroTemplate(templateId);
  if (!t || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose a current supported request template.");
  const fields = input as Record<string, unknown>;
  const allowed = new Set(t.columns.map(c => c.key));
  if (Object.keys(fields).some(k => !allowed.has(k))) throw new Error("Only this template's allowed fields may be retained.");
  if (Object.values(fields).some(v => typeof v !== "string" || unsafeIntakeValue(v))) throw new Error("Only allowed text fields and secure collection references are accepted.");
  return validateHroRows(t.id, t.version, [fields]);
}
