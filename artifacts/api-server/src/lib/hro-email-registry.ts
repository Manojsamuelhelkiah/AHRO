import { HRO_BATCH_TEMPLATES, findHroTemplate, validateHroRows, type IntakeTemplate } from "./onboarding/hro-batch-templates";
import type { EmailStructure } from "./hro-email-structure";
export type ExtractionIssue = { field: string; kind: string; message: string };
const headerKey = (v: string) => v.trim().toLowerCase().replace(/[\s_-]+/g, "_");
const headers = new Map(HRO_BATCH_TEMPLATES.flatMap(t => t.columns.flatMap(c => [[headerKey(c.key), c.key], [headerKey(c.label), c.key]] as Array<[string, string]>)));
function canonicalValue(c: IntakeTemplate["columns"][number], raw: string): string {
  let value = raw.trim();
  if (c.kind === "choice") value = c.values?.find(v => v.toLowerCase() === value.toLowerCase()) ?? value;
  if (c.kind === "country") {
    const aliases: Record<string, string> = { usa: "US", "united states": "US", "united states of america": "US", uk: "GB", "united kingdom": "GB", india: "IN", canada: "CA", australia: "AU" };
    value = aliases[value.toLowerCase()] ?? (/^[a-z]{2}$/i.test(value) ? value.toUpperCase() : value);
  }
  if (c.kind === "email") {
    const wrapped = value.match(/^<?mailto:([^\s?<>]+)>?$/i) ?? value.match(/^\[([^\s<>]+@[^\s<>]+)\]\(mailto:\1\)$/i) ?? value.match(/^([^\s<>]+@[^\s<>]+)\s*<mailto:\1>$/i);
    if (wrapped) value = wrapped[1];
  }
  if (c.kind === "date") {
    const date = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    // DD-MM-YYYY only where the day exceeds 12, or day and month are identical.
    // Ambiguous numeric dates are deliberately not interpreted.
    if (date && (Number(date[1]) > 12 || date[1] === date[2])) value = `${date[3]}-${date[2]}-${date[1]}`;
  }
  return value;
}

/** One schema registry for spreadsheet and mailbox request review. No execution authority. */
export const HRO_EMAIL_TEMPLATES = HRO_BATCH_TEMPLATES;
const restricted = /\b(?:iban|swift|bank\s*account|account\s*number|passport\s*(?:number|no)|national\s*id|social\s*security|diagnos(?:is|ed)|medical\s*(?:condition|finding)|routing\s*number)\b|\b\d{12,19}\b/i;
export function unsafeIntakeValue(value: string): boolean { return restricted.test(value); }
export function emailExample(t: IntakeTemplate): string {
  return t.columns.map(c => `${c.key}: ${c.key === "template_id" ? t.id : c.key === "template_version" ? t.version :
    c.key === "request_id" ? "your-source-reference" : c.key === "job_profile_id" ? "" : c.key === "time_zone" ? "America/New_York" :
    c.values ? c.values[0] : c.kind === "date" ? "2030-01-15" : c.kind === "country" ? "US" : c.kind === "email" ? "worker@example.invalid" :
    c.key.endsWith("_reference") ? "reviewed-source-reference" : `Example ${c.label}`}`).join("\n");
}
export function classifyEmail(subject: string, body: string, structure?: EmailStructure) {
  const input = `${subject}\n${body}`.slice(0, 32_768);
  const pairs: Record<string, string> = {};
  const suggestions = new Map<string, Array<{ value: string; source: string }>>();
  const issues: ExtractionIssue[] = (structure?.issues ?? []).map(message => ({ field: "table", kind: "malformed", message }));
  const add = (key: string, value: string, source: string) => {
    const found = suggestions.get(key) ?? [];
    found.push({ value: value.trim(), source }); suggestions.set(key, found);
  };
  const repeated = new Set<string>();
  for (const [source, content] of [["plain-text", body], ["html-text", structure?.htmlText ?? ""]]) for (const line of content.slice(0, 32_768).split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z_ ]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const key = headers.get(headerKey(match[1])) ?? headerKey(match[1]);
    add(key, match[2], source);
  }
  const employeeTables = (structure?.tables ?? []).filter(t => !t.invalid &&
    t.rows[0]?.some(v => ["worker_name", "worker_email"].includes(headers.get(headerKey(v)) ?? "")) &&
    (t.rows[0]?.filter(v => headers.has(headerKey(v))).length ?? 0) > 1);
  if (employeeTables.length > 1) issues.push({ field: "table", kind: "ambiguous", message: "Multiple employee tables require individual source correction; no employee records were merged." });
  for (const [index, table] of (structure?.tables ?? []).entries()) {
    if (employeeTables.length > 1) continue;
    if (table.invalid) continue;
    const rows = table.rows;
    const keys = rows[0]?.map(v => headers.get(headerKey(v)));
    const headerLayout = keys && keys.length >= 2 && keys.some(k => k !== undefined) && keys.filter(Boolean).length > keys.length / 2;
    if (headerLayout) {
      if (rows.length !== 2 || rows[1].length !== keys.length) {
        issues.push({ field: "table", kind: "ambiguous", message: "Expected exactly one employee value row with matching columns. Multiple employees are not imported." }); continue;
      }
      keys.forEach((key, i) => {
        if (key) add(key, rows[1][i], `html-table-${index + 1}`);
        else issues.push({ field: "table", kind: "unsupported", message: "Unrecognized table header. Use this template's column names." });
      });
    } else if (rows.length && rows.every(r => r.length === 2 && headers.has(headerKey(r[0])))) {
      rows.forEach(r => add(headers.get(headerKey(r[0]))!, r[1], `html-table-${index + 1}`));
    } else issues.push({ field: "table", kind: "ambiguous", message: "Unsupported table layout or unknown key. Use explicit template key/value rows or one header row and one employee row." });
  }
  for (const [key, values] of suggestions) {
    if (new Set(values.map(v => v.value)).size > 1) repeated.add(key);
    pairs[key] = values[0].value;
  }
  const explicit = !repeated.has("template_id") ? findHroTemplate(pairs.template_id) : undefined;
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
  const template = suggestions.has("template_id") ? explicit : candidates.length === 1 ? candidates[0] : undefined;
  const fields: Record<string, string> = {};
  const provenance: Record<string, string[]> = {};
  let sensitive = unsafeIntakeValue(input) || unsafeIntakeValue(structure?.htmlText ?? "");
  if (suggestions.has("template_id") && !explicit) issues.push({ field: "template_id", kind: repeated.has("template_id") ? "conflict" : "unsupported", message: "Explicit template identifiers conflict or are unsupported. Choose a current template." });
  if (template) {
    // Labelled facts participate in the same conflict checks as tables and
    // colon templates, rather than acting as a lower-priority fallback.
    const language: Record<string, RegExp> = {
      worker_name: /\b(?:worker|employee|new hire)\s+(?:name\s+)?(?:is|=)\s+([A-Za-z][A-Za-z .'-]{1,100})(?=[,;\n]|$)/ig,
      worker_email: /\b(?:worker|employee)\s+email\s+(?:is|=)\s+([^\s,;]+@[^\s,;]+)/ig,
      work_country: /\bwork country\s+(?:is|=)\s+([A-Z]{2})(?=[,;\s]|$)/ig,
      joining_date: /\b(?:joining date|starts on)\s*(?:is|=)?\s*(\d{4}-\d{2}-\d{2})\b/ig,
      effective_date: /\beffective date\s*(?:is|=)?\s*(\d{4}-\d{2}-\d{2})\b/ig,
      employee_id: /\bemployee id\s+(?:is|=)\s+([A-Za-z0-9_-]{1,80})\b/ig,
    };
    for (const [key, pattern] of Object.entries(language)) for (const content of [body, structure?.htmlText ?? ""])
      for (const match of content.matchAll(pattern)) add(key, match[1], "labelled-text");
    for (const column of template.columns) {
      const entries = suggestions.get(column.key) ?? [];
      const values = [...new Set(entries.map(e => canonicalValue(column, e.value)).filter(Boolean))];
      if (values.length > 1) {
        issues.push({ field: column.key, kind: "conflict", message: "Conflicting source values. Enter the correct reviewed value; no representation takes precedence." }); continue;
      }
      const value = values[0];
      if (entries.some(e => unsafeIntakeValue(e.value))) { sensitive = true; continue; }
      if (!value) continue;
      if (column.key === "template_version" && value !== String(template.version)) {
        issues.push({ field: column.key, kind: "unsupported", message: `Use supported template version ${template.version}; review the source before changing its version.` }); continue;
      }
      const validation = validateHroRows(template.id, template.version, [{ template_id: template.id, template_version: String(template.version), [column.key]: value }]);
      const problem = validation.issues.find(i => i.column === column.key && !i.message.endsWith("is required."));
      if (problem) issues.push({ field: column.key, kind: "unsupported", message: problem.message });
      else { fields[column.key] = value; provenance[column.key] = [...new Set(entries.map(e => e.source))]; }
    }
    for (const key of suggestions.keys()) if (!template.columns.some(c => c.key === key))
      issues.push({ field: "table", kind: "unsupported", message: "A source field is not allowed by the selected template and was not retained." });
    const validation = validateHroRows(template.id, template.version, [fields]);
    for (const problem of validation.issues.filter(i => !i.message.endsWith("is required."))) if (!issues.some(i => i.field === problem.column)) {
      issues.push({ field: problem.column, kind: "unsupported", message: problem.message });
      delete fields[problem.column]; delete provenance[problem.column];
    }
  }
  return {
    templateId: template?.id ?? null,
    family: template?.family ?? null,
    fields,
    issues,
    provenance,
    uncertainty: explicit ? "Explicit template still requires human review." : candidates.length === 1 ? "Keyword suggestion only; confirm classification." : "Classification is uncertain; choose a request template.",
    blockedReason: sensitive ? "Potential sensitive values detected. Supply secure collection references, not bank, medical or identity values." : issues.some(i => i.kind === "conflict") ? "Repeated fields require manual correction." : null,
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
