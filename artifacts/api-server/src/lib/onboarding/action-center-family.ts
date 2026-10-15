import { HRO_BATCH_TEMPLATES, readHroBatchRequest } from "./hro-batch-templates";

export const actionCenterFamilies = [...new Set(HRO_BATCH_TEMPLATES.map(t => t.family))];
const legacyFamilies: Record<string, string> = {
  "standard-fte": "Onboarding", "internal-transfer": "Employee Changes",
  "payroll-bank-change": "Payroll", "benefits-life-event": "Benefits",
  "leave-parental": "Leave", "compliance-work-authorization": "Compliance",
  "offboarding-voluntary": "Offboarding", "helpdesk-employment-letter": "HR Helpdesk",
  "it-privileged-access": "IT Access", "learning-mandatory-certification": "Learning",
  "mobility-country-transfer": "Mobility", "documents-policy-acknowledgement": "Documents",
};
export function actionCenterFamily(row: { hireType: string; processPolicySnapshot: unknown; scenarioKey?: string | null }) {
  if (row.hireType === "separation") return "Offboarding";
  const family = readHroBatchRequest(row.processPolicySnapshot)?.family;
  if (family && actionCenterFamilies.includes(family)) return family;
  const key = row.scenarioKey?.replace(/^UAT-DEMO-COVERAGE:/, "");
  return (key && legacyFamilies[key]) ||
    (row.hireType === "offboarding" ? "Offboarding" :
      row.hireType === "internal-transfer" ? "Employee Changes" : "Onboarding");
}
export function matchesActionCenterContext(row: {
  workforceClassification?: { label: string } | null;
  workforceContext: { safetyCritical?: boolean; siteExposure?: boolean };
}, filters: { workforce?: string; safetyCritical?: boolean; siteExposure?: boolean }) {
  return (!filters.workforce || (row.workforceClassification?.label ?? "unclassified") === filters.workforce) &&
    (filters.safetyCritical === undefined || row.workforceContext.safetyCritical === filters.safetyCritical) &&
    (filters.siteExposure === undefined || row.workforceContext.siteExposure === filters.siteExposure);
}
