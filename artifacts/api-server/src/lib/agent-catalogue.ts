import { buildIntentCatalog } from "./intent-catalog";

export const AGENT_CATALOGUE_VERSION = "hro-agents-v1";
/** Reviewed coordination associations, not outcome support or routing authority. */
const roles = [
  ["onboarding", "Onboarding Agent", "Onboarding", "Coordinate accepted-offer onboarding and readiness handoffs.", ["onboarding-case", "manager-buddy", "first-week-activation", "probation-onboarding-change", "onboarding-cancellation"]],
  ["offboarding", "Offboarding Agent", "Offboarding", "Coordinate separation preparation and exit-control handoffs; final closure is unavailable.", ["termination-offboarding", "retirement-alumni-rehire"]],
  ["employee-changes", "Employee Changes Agent", "Employee Changes", "Coordinate employment, organization, position and employee record changes.", ["person-data", "worker-data-quality", "organization-management", "position-management", "employment-relationships", "contingent-workforce", "employee-changes"]],
  ["payroll", "Payroll Agent", "Payroll", "Coordinate pay inputs, corrections and statutory-pay requests; no payroll calculation executor.", ["payroll-tax-time-setup", "pay-access", "pay-run", "pay-release", "pay-corrections", "statutory-pay", "garnishments"]],
  ["benefits", "Benefits Agent", "Benefits", "Coordinate benefit eligibility, elections, claims and evidence handoffs.", ["benefits-setup", "benefits-enrollment", "benefits-evidence", "carrier-claims", "hr-expenses", "pension-wellbeing"]],
  ["leave", "Leave Agent", "Leave", "Coordinate absence, protected leave and return-to-work requests.", ["routine-absence", "absence-maintenance", "protected-leave", "extended-leave"]],
  ["compliance", "Compliance Agent", "Compliance", "Coordinate work eligibility, screening, safety and compliance review; never make professional determinations.", ["identity-right-to-work", "background-screening", "safety", "accommodations", "labor-relations", "compliance-audit"]],
  ["it-access", "IT Access Agent", "IT Access", "Coordinate identity and access requests with independent application-owner decisions.", ["identity-access-setup"]],
  ["learning", "Learning Agent", "Learning", "Coordinate learning, skills, credentials and career-development requests.", ["orientation-learning", "skills", "learning", "certification-education", "career-mentoring"]],
  ["mobility", "Mobility Agent", "Mobility", "Coordinate internal moves, immigration, relocation and remote-work handoffs.", ["internal-mobility", "immigration", "relocation", "remote-work"]],
  ["documents-records", "Documents & Records Agent", "Documents", "Coordinate governed documents, retention and privacy-rights requests.", ["employment-documents", "document-governance", "records-retention", "privacy-rights"]],
  ["hr-helpdesk", "HR Helpdesk Agent", "HR Helpdesk", "Coordinate HR enquiries, knowledge and case-management requests.", ["hr-case-management", "knowledge-policy", "self-service-delegation", "recruiting-self-service"]],
  ["assets-workplace", "Assets & Workplace Agent", "", "Support equipment custody, facilities and workplace handoffs.", ["device-facilities-setup"]],
  ["document-verification", "Document Verification Agent", "", "Support document evidence review; local checks are not source authentication.", ["identity-right-to-work", "background-screening", "benefits-evidence"]],
  ["systems-watcher", "Systems Watcher Agent", "", "Support system health observation and escalation. Existing connector watchers are not this registered principal.", []],
] as const;

/** Lightweight catalogue identity lookup for read projections. No principal,
 * permissions, invocation capability or taxonomy computation is created. */
export function agentCatalogueIdentity(key: string) {
  const role = roles.find(entry => entry[0] === key);
  if (!role) throw new Error(`Unknown catalogue agent: ${key}`);
  return { key: role[0], name: role[1], version: AGENT_CATALOGUE_VERSION };
}

export function agentCatalogue() {
  const taxonomy = buildIntentCatalog();
  return roles.map(([key, name, family, responsibility, services], index) => ({
    key, name, version: AGENT_CATALOGUE_VERSION, kind: index < 12 ? "domain" : "supporting",
    productFamilies: family ? [family] : key === "assets-workplace" ? ["Onboarding", "Offboarding", "Employee Changes"] : key === "document-verification" ? ["Onboarding", "Compliance", "Benefits", "Documents"] : roles.slice(0, 12).map(role => role[2]),
    responsibility,
    prerequisites: ["Active eligible accountable human member in this client", "Separately approved permissions and owner initiation for any future invocation", "Approved policy, evidence and capability-specific prerequisites before operational work"],
    mappings: taxonomy.definitions.filter(row => row.definitionClass !== "custom" && row.serviceKeys.some(service => (services as readonly string[]).includes(service))).map(row => ({
      intentKey: row.key, intentName: row.name, intentVersion: row.version,
      sourceVersion: taxonomy.version, provenance: row.provenance,
      reviewStatus: "reviewed", rationale: "Reviewed service-level coordination association only; does not approve outcome execution, coverage or professional authority.",
    })),
    operationalCapability: "unavailable",
  }));
}
