import type { SeparationFacts, SeparationState, SeparationPolicy, SeparationTask } from "@workspace/db";

export const CLOSURE_BLOCKED = "Final closure blocked: section 4.6 requirements pending";
export const SENSITIVE_TRIGGERS = ["posh", "whistleblower", "litigation-hold", "fraud-investigation", "abscondment", "death-in-service", "statutory-position", "unknown", "conflicting"] as const;
export const FACT_FIELDS = ["employeeId", "workerName", "exitType", "exitReason", "lastWorkingDay", "terminationDate", "timeZone", "role", "department", "country", "legalEntity", "workerCategory", "manager"] as const;
export class SeparationError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeparationError("An object is required.", 400);
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f]/.test(value)) throw new SeparationError(`${field} is required (at most ${max} plain-text characters).`, 400);
  return value.trim();
}
export function calendar(value: unknown, field: string): string {
  const v = text(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new SeparationError(`${field} must be a real YYYY-MM-DD date.`, 400);
  return v;
}
export function facts(value: unknown): SeparationFacts {
  const b = object(value);
  if (Object.keys(b).some(k => !FACT_FIELDS.includes(k as typeof FACT_FIELDS[number]))) throw new SeparationError("Unexpected separation field.", 400);
  const f = Object.fromEntries(FACT_FIELDS.map(k => [k, text(b[k], k, k === "exitReason" ? 2000 : 160)])) as SeparationFacts;
  f.employeeId = f.employeeId.normalize("NFKC").toUpperCase();
  f.lastWorkingDay = calendar(f.lastWorkingDay, "lastWorkingDay");
  f.terminationDate = calendar(f.terminationDate, "terminationDate");
  if (f.terminationDate < f.lastWorkingDay) throw new SeparationError("Termination date cannot precede LWD.", 400);
  if (!/^[A-Z]{2}$/.test(f.country)) throw new SeparationError("Country needs an uppercase two-letter code.", 400);
  try { new Intl.DateTimeFormat("en", { timeZone: f.timeZone }); } catch { throw new SeparationError("Use a valid IANA time zone.", 400); }
  return f;
}
export function initialState(): SeparationState {
  return { gatewayA: "pending", classification: null, urgency: null, flags: null, sensitiveTriggers: [], conflict: false, hrBpDisposition: null, screening: null, policyId: null, policyVersion: null, policyReceipt: null, tasks: [], decisions: [], holds: [], settlementVersions: [], pauseReason: null, closureBlocker: "section-4.6-pending" };
}
/** Convert the approved country's LWD wall clock, rejecting nonexistent/ambiguous times. */
export function endOfLwd(day: string, clock: string, timeZone: string): string {
  if (!/^\d{2}:\d{2}$/.test(clock) || Number(clock.slice(0, 2)) > 23 || Number(clock.slice(3)) > 59) throw new SeparationError("Approved endOfLwd must be HH:mm.", 400);
  const target = `${day} ${clock}`;
  const base = Date.parse(`${day}T${clock}:00Z`);
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const matches: number[] = [];
  // Time zones may have quarter-hour offsets; bounded search also detects DST folds.
  for (let m = -14 * 60; m <= 14 * 60; m++) {
    const at = base + m * 60000;
    if (formatter.format(at).replace(",", "") === target) matches.push(at);
  }
  if (matches.length !== 1) throw new SeparationError("The approved LWD time is ambiguous or nonexistent in this zone. HR must resolve the policy.");
  return new Date(matches[0]).toISOString();
}
const task = (id: string, activity: string, label: string, stream: string, scope: string, prerequisites: string[] = []): SeparationTask =>
  ({ id, activity, label, stream, scope, prerequisites, owner: null, dueAt: null, notBeforeAt: null, status: "pending", evidence: null, details: {} });
export function compilePlan(f: SeparationFacts, s: SeparationState, p: SeparationPolicy): SeparationTask[] {
  if (s.gatewayA !== "clear" || !s.flags || !s.urgency || !s.classification) throw new SeparationError("Separation Screening and confirmed classification are required.");
  if (p.country !== f.country || p.role !== f.role || p.workerCategory !== f.workerCategory || p.timeZone !== f.timeZone) throw new SeparationError("Approved country/role/category/time-zone policy does not match.");
  const immediate = s.flags.privileged || s.flags.highRisk || s.urgency === "High";
  const tasks = [
    task("access-inventory", "06", "Source-backed access inventory", "access", "it-security-approve"),
    task("shared-accounts", "06", "Shared/service-account reassignment", "access", "it-security-approve", ["access-inventory"]),
    task("kt-access-exception", "06", "Approve or rule out time-limited KT access", "access", "it-security-approve", ["access-inventory"]),
    task("access-closure", immediate ? "07" : "06", immediate ? "Immediate security closure with source evidence" : "Scheduled end-of-LWD access closure", "access", "it-security-approve", immediate ? ["access-inventory"] : ["shared-accounts", "kt-access-exception"]),
    ...(immediate ? [
      task("security-review", "07", "Post-execution review and unresolved dependency reconciliation", "access", "it-security-approve", ["access-closure", "shared-accounts", "kt-access-exception"]),
      task("break-glass", "07", "Document break-glass handling or evidenced non-applicability", "access", "it-security-approve"),
    ] : []),
    task("asset-inventory", "08", "Manager-confirmed asset expectations", "assets", "manager-approve"),
    task("asset-return", "08", "Physical/digital return, missing and damaged asset reconciliation", "assets", "site-fulfillment-approve", ["asset-inventory"]),
    task("licence-release", "08", "Source-backed licence release", "assets", "application-owner-approve"),
    task("asset-recovery", "08", "Finance-approved deductions / recovery / write-off disposition", "assets", "finance-approve", ["asset-return"]),
    task("knowledge-risk", "09", "Approve single-point-of-knowledge mitigation or attest no risk", "kt", "manager-approve"),
    task("kt-signoff", "09", "Receiving manager/successor KT sign-off", "kt", "manager-approve", ["knowledge-risk"]),
    task("settlement-calculation", "10", "Review versioned source-attested F&F calculation", "settlement", "finance-approve", ["asset-recovery"]),
    task("payroll-reconciliation", "10", "HRIS–Payroll data reconciliation", "settlement", "payroll-approve", ["settlement-calculation"]),
    task("payroll-ready", "10", "Payroll readiness", "settlement", "payroll-approve", ["payroll-reconciliation"]),
    task("statutory-items", "10", "Country-policy statutory settlement review", "settlement", "payroll-approve"),
    task("equity-review", "10", "Finance equity review and human-authored approved communication", "settlement", "finance-approve"),
    task("statutory-clearances", "11", "Compliance statutory clearances", "compliance", "hr-compliance-approve"),
    task("privacy-retention", "11", "Legal-approved privacy / retention actions; preserve holds", "compliance", "legal-approve"),
    task("legal-acknowledgements", "11", "NDA / IP / non-compete applicability and acknowledgements", "compliance", "legal-approve"),
    task("closure-preparation", "11", "Prepare evidence only — seven closure conditions not supplied", "compliance", "hr-compliance-approve", ["access-closure", "asset-recovery", "kt-signoff", "payroll-ready", "statutory-clearances", "privacy-retention", "legal-acknowledgements", "statutory-items", "equity-review", ...(immediate ? ["security-review", "break-glass"] : [])]),
  ];
  if (s.flags.peopleManager) tasks.push(task("manager-reassignment", "09", "People-manager reporting-line handover", "kt", "manager-approve"));
  if (s.flags.clientFacing) {
    tasks.push(
      task("client-replacement", "05", "Delivery Head replacement assignment", "client", "delivery-head-approve"),
      task("client-artefacts", "05", "Client artefact handover", "client", "delivery-head-approve", ["client-replacement"]),
      task("client-access", "05", "Client-system access review and source-backed closure", "client", "it-security-approve"),
      task("client-communication", "05", "Delivery Head approval of human-authored client communication", "client", "delivery-head-approve"),
      task("client-continuity", "05", "Delivery Head continuity sign-off", "client", "delivery-head-approve", ["client-artefacts", "client-access", "client-communication", "kt-signoff"]),
    );
  }
  for (const o of p.obligations) {
    if (tasks.some(t => t.id === o.id)) throw new SeparationError("Policy obligation collides with a baseline task.");
    const localDay = new Date(Date.parse(`${f.lastWorkingDay}T00:00:00Z`) + o.dueOffsetDays * 86400000).toISOString().slice(0, 10);
    tasks.push({ ...task(o.id, "04", o.label, o.stream, o.scope, o.prerequisites), dueAt: endOfLwd(localDay, p.endOfLwd, p.timeZone) });
  }
  const closure = tasks.find(t => t.id === "closure-preparation")!;
  closure.prerequisites = tasks.filter(t => t.id !== closure.id).map(t => t.id);
  const due = endOfLwd(f.lastWorkingDay, p.endOfLwd, p.timeZone);
  tasks.forEach(t => { t.dueAt ??= due; });
  if (!immediate) tasks.find(t => t.id === "access-closure")!.notBeforeAt = due;
  tasks.find(t => t.id === "asset-inventory")!.details = { expectation: p.defaultAssets.join(", "), confirmed: false };
  const ids = new Set(tasks.map(t => t.id));
  for (const t of tasks) if (t.prerequisites.some(id => !ids.has(id) || id === t.id)) throw new SeparationError("Policy has an unknown/self prerequisite.");
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) throw new SeparationError("Policy task prerequisites contain a cycle."); if (done.has(id)) return; visiting.add(id); tasks.find(t => t.id === id)!.prerequisites.forEach(visit); visiting.delete(id); done.add(id); };
  tasks.forEach(t => visit(t.id));
  return tasks;
}
