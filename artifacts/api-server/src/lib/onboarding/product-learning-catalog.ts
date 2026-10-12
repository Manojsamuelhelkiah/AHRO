import {
  PRODUCT_FEATURES as LEGACY_FEATURES, REQUIREMENTS as SOURCE_REQUIREMENTS,
  UAT_LEARNING_BASELINE as SOURCE_BASELINE,
  type ProductFeature, type GuideSection,
} from "./uat-learning-catalog";

export const UAT_LEARNING_CATALOG_VERSION = "2026.10.12";
export const UAT_LEARNING_BASELINE = SOURCE_BASELINE;

const RETIRED_FEATURE_IDS = new Set(["PFC-037", "PFC-040", "PFC-041", "PFC-042", "PFC-043"]);
const featureNotes: Record<string, string> = {
  "PFC-009": "Unavailable scanning and quarantine remain fail-closed. Only current independently verified scanner evidence can clear a gate.",
  "PFC-025": "Historical test records never enter live outcome metrics. Historical business outcomes require dated source evidence.",
  "PFC-044": "The guide describes current authorized operations and retained evidence; catalog coverage is not proof of execution.",
};
export const PRODUCT_FEATURES: ProductFeature[] = LEGACY_FEATURES
  .filter(item => !RETIRED_FEATURE_IDS.has(item.id))
  .map(item => ({
    ...item, scenarioIds: [], verification: "manual",
    availabilityNote: featureNotes[item.id] ?? item.availabilityNote,
  }));

export const REQUIREMENTS = SOURCE_REQUIREMENTS.map(item => ({
  ...item,
  scenarioIds: [], testMode: "manual-evidence" as const,
  latestResult: item.availability === "not-implemented" ? "blocked" as const : "manual" as const,
  gapReason: "Requires current independent, authorized observation. Static source mapping does not establish execution, provider certification, source authenticity or readiness.",
}));

function guide(id: string, title: string, entry: string, summary: string,
  instructions: string[], evidence: string[], exceptions: string[]): GuideSection {
  return {
    id, title, roles: ["authorized organization member", "current scoped reviewer"],
    entryPoints: [entry], summary, instructions, evidence, exceptions,
    featureIds: PRODUCT_FEATURES.filter(f => f.guideTopic === id).map(f => f.id),
    scenarioIds: [],
  };
}

export const GUIDE_SECTIONS: GuideSection[] = [
  guide("navigation", "Navigation and operational queues", "/", "Use the Control Tower for authorized operational work. Historical test records are separate, read-only and non-operational.",
    ["Select your authorized workspace.", "Review current operational queues and ownership.", "Use Cases history for retained records, never as evidence of live work."],
    ["Current workspace and scoped access", "Dated operational events"], ["Shared demo identities cannot create cases or acquire real workflow authority."]),
  guide("lifecycle", "Intake and onboarding gates", "/cases", "Ordinary authenticated intake uses real case facts and explicit governance grants.",
    ["Create a case only with current case-flow and profile-edit access.", "Confirm offer acceptance through its dedicated evidence-backed gate.", "Resolve mandatory workstreams before requesting final human readiness review."],
    ["Approved policy snapshot", "Source evidence and approval version", "Current scoped human decision"],
    ["General intake does not collect free-form candidate notes or medical details.", "A score or status label never substitutes for authority or safety gates."]),
  guide("candidate", "Candidate documents and Employee Vault", "/cases", "Private uploads, scanning, authenticity checks and consent are distinct controls.",
    ["Issue candidate access only through authorized ordinary workflows.", "Keep quarantined or uncertain evidence blocked.", "Apply all-required evidence and fresh consent checks to Vault reuse."],
    ["Private file references", "Current scanner and source-verification receipts", "Consent and reuse scope"],
    ["Local file checks do not prove identity or source authenticity.", "Retained test portals cannot accept new uploads.", "Privacy withdrawal remains independent of new collection approval."]),
  guide("handoffs", "Human decisions and specialist handoffs", "/approvals", "Membership, assignment and mailbox personas are not professional authority.",
    ["Review the exact case and evidence revision.", "Check current specialist role, jurisdiction and scope.", "Record the accountable decision without inventing external completion."],
    ["Scoped authority", "Versioned approval", "Protected audit receipt"], ["Stale decisions and historical test records cannot authorize operations."]),
  guide("variants", "Workforce context, frontline release and early tenure", "/settings", "Approved country-specific policies govern context and safety requirements.",
    ["Confirm work country and approved policy revision.", "Keep medical, safety and BGV gates independent of weighted readiness.", "Record actual start and dated human follow-ups under current authority."],
    ["Policy adoption", "Independent release evidence", "Actual-start revision"], ["Unapproved starter policies are proposals, not runtime authority.", "Do not infer historical success from current checklists."]),
  guide("transfers", "Workforce transfers", "/workforce-transfers", "Transfers require country-specific approval, source-attested execution and evidence-fenced cutover.",
    ["Review population, legal basis and required objections.", "Reconcile source and target evidence.", "Obtain current independent cutover sign-offs."],
    ["Approved country policy", "Source-attested completion", "Generation-bound sign-off"], ["A Go label is not payroll or legal certification."]),
  guide("ai", "AI-supported work and guardrails", "/agents", "Generated plans are advisory; explanations describe recorded evidence rather than hidden reasoning.",
    ["Review drafts before adoption.", "Verify citations and limitations.", "Escalate uncertain or adverse evidence to accountable humans."],
    ["Approved source context", "Recorded limitations", "Reviewed action proposal"], ["AI output never grants authority or proves an external effect."]),
  guide("policy", "Policy library and grounded answers", "/hr-policy-library", "Source extracts, case evidence and policy decisions remain separate.",
    ["Maintain drafts under scoped access.", "Obtain required review before publication.", "Check audience, jurisdiction, dates and source context at disclosure."],
    ["Versioned source", "Approved extract", "Current publication review"], ["Retired evaluations cannot provide a current accuracy or fairness claim."]),
  guide("systems", "Provider systems and authorized channel checks", "/systems", "Separately authorized operational tests remain available; configuration alone does not prove provider execution.",
    ["Review connector mode and approved estate.", "Use explicit, authorized operational channel checks only.", "Reconcile uncertain effects without automatic non-idempotent redispatch."],
    ["Verified provider receipt", "Stable effect-journal payload", "Current recipient authorization"], ["Historical test records remain permanently denied dispatch.", "No simulated integration is represented as genuine external work."]),
  guide("communications", "Communications and monitored replies", "/systems", "Verified transport, tenant attribution, recipient authorization and responder authority are independent.",
    ["Check the exact case-bound reply reference.", "Quarantine ambiguous attribution.", "Review durable delivery status and unknown outcomes."],
    ["Provider message id", "Verified transport evidence", "Case-bound correlation"], ["A shared mailbox identity alone cannot authorize a state change."]),
  guide("analytics", "Operational outcomes and commercial assumptions", "/analytics", "Live metrics exclude historical test records. Commercial what-if estimates remain available with stated assumptions.",
    ["Check cohort, dates, source provenance and denominator.", "Distinguish observed outcomes from estimates.", "Do not treat aggregate what-if means as causal forecasts or case-level SLA rates."],
    ["Dated source evidence", "Eligible real cohort", "Explicit modeling assumptions"], ["Historical test activity is not business performance or readiness."]),
  guide("administration", "Governance, privacy, retention and audit", "/settings", "Sensitive access, legal holds, retention, independent audit readiness and release checks remain mandatory.",
    ["Use scoped access reports and current authority.", "Review approved lifecycle policies and legal holds.", "Verify independent audit receipts before regulated release."],
    ["Approved retention policy", "Legal hold", "Independent provider-verified audit receipt"],
    ["Tenant administration is not specialist authority.", "Restricted history and protected effect journals are retained; retirement does not purge records."]),
];

export const FEATURE_COVERAGE = {
  denominator: PRODUCT_FEATURES.length, referenceMapped: PRODUCT_FEATURES.length,
  withGuide: PRODUCT_FEATURES.filter(f => GUIDE_SECTIONS.some(g => g.id === f.guideTopic)).length,
  withScenario: 0, executedAssertions: 0, blocked: 0, manual: PRODUCT_FEATURES.length,
};
export const REQUIREMENT_COVERAGE = {
  denominator: REQUIREMENTS.length, referenceMapped: REQUIREMENTS.length,
  executedAssertions: 0, unavailableOrPolicyDependent: REQUIREMENTS.filter(r => ["not-implemented", "policy-dependent"].includes(r.availability)).length,
  providerSandboxBlocked: 0,
};
export function getProductLearningCatalog() {
  return {
    catalogVersion: UAT_LEARNING_CATALOG_VERSION, baselineRevision: UAT_LEARNING_BASELINE,
    scenarios: [], guideSections: GUIDE_SECTIONS, features: PRODUCT_FEATURES, requirements: REQUIREMENTS,
    denominators: { features: FEATURE_COVERAGE, requirements: REQUIREMENT_COVERAGE },
  };
}
