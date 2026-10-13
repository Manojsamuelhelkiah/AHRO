import { createHash } from "node:crypto";
import type { CustomIntentRow } from "@workspace/db";
import type { OperationalIntentCatalog, OperationalIntentDefinition, CatalogMapping, CatalogComposition } from "./intent-catalog-types";
import { GetIntentCatalogResponse } from "@workspace/api-zod";
import master from "../../../../research/hro-master-intent-taxonomy.json";
import legacy from "../../../../research/intent-agent-coverage.json";
import { intents } from "../data/intents";
import { HRO_BATCH_TEMPLATES } from "./onboarding/hro-batch-templates";
import { CURATED_OFFLINE_EXAMPLES } from "./onboarding/offline-example-extension";
import { SCENARIOS } from "./onboarding/scenarios";
import { FUTURE_INSTANCE_CONTRACT } from "./intent-instance-contract";

export const CATALOG_VERSION = "hro-operational-v1";
const RECONCILIATION_VERSION = "hro-reconciliation-v1";
const canonicalKey = (key: string) => key === "assign-mandatory-learning" ? "assign-learning" : key;
const initiation = {
  human: true, ai: true, standalone: true, composed: true, reviewStatus: "proposed" as const,
  note: "Proposed request modes only. No execution permission, executor assignment or professional decision authority is granted.",
};
const context = ["tenantId", "subjectReference", "requestReference", "country", "legalEntity", "effectiveDate", "policyVersion", "authorizedInitiator"];
const constraint = "Live scope authorization, independently approved policy and authoritative evidence must be checked by a future executor; taxonomy placement imposes no invocation restriction.";
const retainedScenarioVersion = `retained-scenarios:${createHash("sha256").update(JSON.stringify(SCENARIOS.map(row => [row.key, row.title, row.description, row.intake.hireType]))).digest("hex").slice(0, 16)}`;
const retainedScenarioFamilies: Record<string, string> = {
  "standard-fte": "Onboarding", "contractor-client": "Onboarding", rehire: "Onboarding", "internal-transfer": "Employee Changes",
  "bgv-exception": "Onboarding", "critical-skill": "Onboarding", "payroll-bank-change": "Payroll", "benefits-life-event": "Benefits",
  "leave-parental": "Leave", "compliance-work-authorization": "Compliance", "offboarding-voluntary": "Offboarding",
  "helpdesk-employment-letter": "HR Helpdesk", "it-privileged-access": "IT Access", "learning-mandatory-certification": "Learning",
  "mobility-country-transfer": "Mobility", "documents-policy-acknowledgement": "Documents",
};

/** Conservative source-level audit: exact identity does not imply semantic or execution approval. */
const familyMappings: Record<string, { keys: string[]; relation: CatalogMapping["relation"]; reason: string }> = {
  Onboarding: { keys: ["new-hire-setup"], relation: "broader", reason: "Onboarding includes acceptance, evidence and early tenure beyond the setup route." },
  "Employee Changes": { keys: ["effective-date-location-transfer", "effective-date-manager-change", "domestic-transfer"], relation: "ambiguous", reason: "Role, department, entity and manager changes have different completion records; the intake does not specify one outcome." },
  Payroll: { keys: ["bank-details-change"], relation: "related", reason: "Current templates concern bank changes, not every payroll service." },
  Benefits: { keys: ["life-event-change"], relation: "related", reason: "Life-event review may resolve eligibility without changing coverage." },
  Leave: { keys: ["leave-request", "leave-cancellation", "determine-leave-eligibility"], relation: "ambiguous", reason: "Submission, amendment and entitlement inquiry must not be conflated." },
  Compliance: { keys: ["schedule-work-authorization-reverification", "work-authorization", "escalate-authorization-expiry"], relation: "ambiguous", reason: "Renewal scheduling, authorization evidence and expiry escalation are distinct; intake is not permission to work." },
  Offboarding: { keys: ["offboarding-exit", "submit-resignation", "request-involuntary-termination-review"], relation: "broader", reason: "Preparation spans different separation types; final closure remains unavailable pending the closure specification." },
  "HR Helpdesk": { keys: ["reference-letter", "salary-certificate", "deliver-employment-document-copy"], relation: "ambiguous", reason: "Employment confirmation, experience letters and copies have different authoritative outcomes; unspecified letter types remain unresolved." },
  "IT Access": { keys: ["provision-role-access"], relation: "related", reason: "An application-access request proposes the grant outcome; owner review may instead reject or request clarification." },
  Learning: { keys: ["assign-learning", "training-enrollment", "approve-learning-equivalency"], relation: "ambiguous", reason: "Assignment, enrollment and equivalency are separate outcomes; sample variations do not establish which is required." },
  Mobility: { keys: ["cross-border-relocation", "domestic-transfer", "complete-relocation-transfer"], relation: "broader", reason: "Transfer planning spans multiple jurisdiction-specific outcomes and is not an executed cutover." },
  Documents: { keys: ["assign-policy-acknowledgement", "record-policy-acknowledgement"], relation: "ambiguous", reason: "Requesting an acknowledgement is not recording it; applicability questions may produce neither." },
};
const additionalFamilies = [
  { key: "background-verification", label: "Background verification", keys: ["initiate-background-screening", "record-bgv-vendor-result", "adjudicate-screening-exception"], reason: "Screening collection, provider result and human adjudication are separate; current provider outcomes need per-outcome audit." },
  { key: "early-tenure", label: "Early-tenure and probation", keys: ["complete-first-week-check-in", "create-probation-plan", "record-probation-check-in", "confirm-probation", "extend-probation", "fail-probation"], reason: "Historical authority and actual-start evidence remain mandatory; family mapping is broader than a single outcome." },
  { key: "frontline", label: "Frontline release", keys: ["assign-learning", "check-day-one-readiness", "activate-employment"], reason: "Site/safety release has additional professional evidence not fully captured by the master leaves." },
  { key: "workforce-transfer", label: "Controlled workforce transfer", keys: ["domestic-transfer", "cross-border-relocation", "complete-relocation-transfer"], reason: "Country approval and source-attested cutover differ from intake and planning." },
  { key: "separation", label: "Dedicated separation", keys: ["offboarding-exit", "complete-exit-controls"], reason: "Screening and controlled preparation exist; final closure is intentionally unavailable." },
];

function mapping(source: CatalogMapping["source"], sourceVersion: string, sourceKey: string, label: string, keys: string[], relation: CatalogMapping["relation"], rationale: string): CatalogMapping {
  return { source, sourceVersion, sourceKey, label, definitionKeys: [...new Set(keys.map(canonicalKey))], relation, reviewStatus: "proposed", rationale };
}

export function buildIntentCatalog(customRows: CustomIntentRow[] = [], organizationId?: string): OperationalIntentCatalog {
  if (customRows.length && !organizationId) throw new Error("Custom catalog definitions require explicit tenant scope");
  const definitions: OperationalIntentDefinition[] = [];
  const mappings: CatalogMapping[] = [];
  for (const row of master.subIntents) {
    const key = canonicalKey(row.key);
    mappings.push(mapping("master", master.taxonomyVersion, row.key, row.name, [key], "exact",
      row.key === key ? "Preserved master outcome identity; completion and inputs still require review." : "Same learning-assignment completion record; mandatory status is input context, not a child-only outcome."));
    const existing = definitions.find(item => item.key === key);
    if (existing) {
      existing.journeyKeys = [...new Set([...existing.journeyKeys, row.journeyKey])];
      existing.serviceKeys = [...new Set([...existing.serviceKeys, row.serviceIntentKey])];
      existing.aliases = [...new Set([...existing.aliases, row.key, row.name, ...row.exactAliases])];
      existing.provenance.push(`${master.taxonomyVersion}:${row.key}`);
      continue;
    }
    definitions.push({
      key, version: `${CATALOG_VERSION}:1`, name: key === "provision-role-access" ? "Grant IT application access" : key === "assign-learning" ? "Assign learning" : row.name,
      definitionClass: "atomic", outcome: key === "provision-role-access"
        ? "Approved application role access is granted for the subject, with scope and expiry recorded by the authoritative identity system."
        : key === "assign-learning" ? "A learning requirement is assigned to the subject, with course version, due date and mandatory status recorded."
        : row.description,
      evidence: row.completionEvidence, journeyKeys: [row.journeyKey], serviceKeys: [row.serviceIntentKey],
      aliases: [...new Set([row.name, ...(key !== row.key ? [row.key] : []), ...row.exactAliases])], provenance: [`${master.taxonomyVersion}:${row.key}`, ...row.sourceFamilies],
      coverage: "catalogued", coverageEvidence: ["Source taxonomy only; no current outcome-specific integrated or verified execution receipt reviewed."],
      reviewStatus: "proposed", initiation: { ...initiation }, requiredContext: [...context],
      invocationConstraints: [constraint, ...(row.jurisdictionOverlay ? ["Jurisdiction-specific policy and authorized human review are required; research is not a legal determination."] : [])],
      status: "active",
    });
  }
  for (const row of master.compositeRoutes) {
    definitions.push({
      key: row.key, version: `${CATALOG_VERSION}:1`, name: "Onboard employee", definitionClass: "composite",
      outcome: row.description, evidence: ["Version-bound required applicable outcomes and final authorized readiness decision; not one source-system write."],
      journeyKeys: [row.journeyKey], serviceKeys: row.serviceIntentKeys, aliases: [row.name, "Onboard employee"],
      provenance: [`${master.taxonomyVersion}:${row.key}`, ...row.sourceFamilies], coverage: "catalogued",
      coverageEvidence: ["Legacy research/registry labels simulated setup; retired case launch/evaluation does not prove a currently supported composite intent."],
      reviewStatus: "proposed", initiation: { ...initiation }, requiredContext: [...context, "acceptedOfferReference", "roleRequirements"],
      invocationConstraints: [constraint, "Offer acceptance precedes onboarding effects; fresh HR readiness authority remains independent."], status: "active",
    });
    mappings.push(mapping("master", master.taxonomyVersion, row.key, row.name, [row.key], "exact", "Preserved composite identity, not an additional atomic outcome."));
  }
  for (const row of intents) {
    const target = master.subIntents.find(item => item.legacyReferenceKey === row.key)?.key
      ?? master.compositeRoutes.find(item => item.legacyReferenceKey === row.key)?.key;
    // Several commercial concepts intentionally cover more than one operational outcome.
    const broad = ["salary-certificate", "leave-cancellation", "dependent-add", "data-privacy-request", "offboarding-exit"].includes(row.key);
    mappings.push(mapping("registry", legacy.taxonomyVersion, row.key, row.name, target ? [target] : [],
      !target ? "unresolved" : broad ? "broader" : "exact",
      broad ? "Commercial wording combines variants or coordination; preserved source link is not an exact execution alias."
        : target ? "Explicit master legacy-reference link; cost and routing contracts remain unchanged." : "No explicit master reference link; requires review."));
  }
  for (const template of HRO_BATCH_TEMPLATES) {
    const match = familyMappings[template.family];
    mappings.push(mapping("case-family", `batch-template:${template.version}`, template.id, `${template.family} · ${template.name}`,
      match?.keys ?? [], match?.relation ?? "unresolved", match?.reason ?? "Unreviewed case family; no canonical outcome assumed."));
  }
  for (const family of additionalFamilies) {
    mappings.push(mapping("case-family", RECONCILIATION_VERSION, family.key, family.label, family.keys, "broader", family.reason));
  }
  for (const example of CURATED_OFFLINE_EXAMPLES) {
    const match = familyMappings[example.family];
    mappings.push(mapping("sample", example.key.includes("complementary-v1") ? "offline-complementary-v1" : "offline-additional-v1",
      example.key, `${example.family} · ${example.title}`, match?.keys ?? [], match ? "related" : "unresolved",
      `Fictional request variation, not completion evidence or a new definition. ${match?.reason ?? "Family outcome unresolved."}`));
  }
  for (const example of SCENARIOS) {
    const family = retainedScenarioFamilies[example.key];
    const match = family ? familyMappings[family] : undefined;
    mappings.push(mapping("sample", retainedScenarioVersion, `retained:${example.key}`, `Retained example · ${example.title}`,
      match?.keys ?? [], match ? "related" : "unresolved", "Retained fictional request definition only. Launch and evaluation remain retired; expected-behavior text is not evidence of a completed outcome."));
  }
  for (const candidate of legacy.candidateGaps) {
    const target = definitions.find(item => item.key === candidate.key || item.aliases.includes(candidate.key));
    mappings.push(mapping("candidate", legacy.taxonomyVersion, candidate.key, candidate.name, target ? [target.key] : [], target ? "related" : "unresolved",
      "Legacy proposed gap reconciled separately; membership neither approves a new commercial row nor proves execution."));
  }
  const sampleKeys = new Set(mappings.filter(item => item.source === "sample").flatMap(item => item.definitionKeys));
  for (const definition of definitions) {
    if (sampleKeys.has(definition.key)) {
      definition.coverage = "illustrative";
      definition.coverageEvidence.push("Curated offline request definitions illustrate intake only; no operational result or live provider support is implied.");
    }
    if (definition.key === "background-check-chase") {
      definition.coverageEvidence.push("Legacy simulated BGV route exists in the separate registry; current per-outcome support has not been verified.");
    }
    if (definition.key === "provision-role-access") definition.requiredContext.push("applicationReference", "requestedRole", "accessEndDate", "businessJustificationReference");
    if (definition.key === "assign-learning") definition.requiredContext.push("courseReference", "courseVersion", "dueDate", "mandatory");
  }
  for (const row of customRows.filter(item => item.organizationId === organizationId)) {
    const evidence = JSON.parse(row.evidenceContract) as { completionEvidence?: string; required?: string[] };
    const digest = createHash("sha256").update(JSON.stringify([row.key, row.name, row.description, row.exactAliases, row.evidenceContract, row.status, row.registryVersion, row.updatedAt])).digest("hex").slice(0, 16);
    definitions.push({
      key: `custom:${row.id}`, version: `${row.registryVersion}:${digest}`, name: row.name,
      definitionClass: "custom", outcome: row.description,
      evidence: [evidence.completionEvidence || "Completion outcome requires tenant review", ...(evidence.required ?? [])],
      journeyKeys: [], serviceKeys: [], aliases: [row.key, ...JSON.parse(row.exactAliases) as string[]],
      provenance: [`tenant-custom:${row.registryVersion}`, row.source],
      coverage: "catalogued", coverageEvidence: [`Declared legacy maturity ${row.maturity} is not current verified catalog evidence; no automatic promotion.`],
      reviewStatus: "proposed", initiation: { ...initiation }, requiredContext: [...context],
      invocationConstraints: [constraint, "Tenant definition is isolated; legacy grouping does not restrict invocation or grant authority."],
      status: row.status === "retired" ? "retired" : "active",
    });
  }
  const compositions: CatalogComposition[] = master.compositeRoutes.flatMap(row =>
    [...new Set([...row.subIntentKeys, "provision-role-access", "assign-learning"])].map(rawKey => ({
      key: `${row.key}:${canonicalKey(rawKey)}`, callerKey: row.key, calleeKey: canonicalKey(rawKey),
      condition: rawKey === "provision-role-access"
        ? "Only when the accepted role requires the application and its owner separately approves the scoped grant."
        : "Only when applicable approved tenant/jurisdiction/role policy requires this outcome; human review of the rule is pending.",
      inputMappings: ["caller.tenantId -> child.tenantId", "caller.subjectReference -> child.subjectReference", "caller.country -> child.country", "caller.legalEntity -> child.legalEntity", "caller.policyVersion -> child.policyVersion",
        ...(rawKey === "provision-role-access" ? ["caller.roleRequirements.application -> child.applicationReference", "caller.roleRequirements.accessRole -> child.requestedRole", "caller.roleRequirements.accessEndDate -> child.accessEndDate", "caller.roleRequirements.justification -> child.businessJustificationReference"] : ["caller.approvedRequirements -> child.outcomeSpecificInputs (review required)"])],
      completionDependency: "conditional" as const, reviewStatus: "proposed" as const,
    })));
  compositions.push({
    key: "domestic-transfer:provision-role-access", callerKey: "domestic-transfer", calleeKey: "provision-role-access",
    condition: "Only when the approved destination role needs different application access and its owner approves the scoped grant. Transfer completion dependency must be reviewed separately.",
    inputMappings: ["caller.tenantId -> child.tenantId", "caller.subjectReference -> child.subjectReference", "caller.country -> child.country", "caller.legalEntity -> child.legalEntity", "caller.policyVersion -> child.policyVersion",
      "caller.destinationRole.application -> child.applicationReference", "caller.destinationRole.accessRole -> child.requestedRole", "caller.destinationRole.accessEndDate -> child.accessEndDate", "caller.destinationRole.justification -> child.businessJustificationReference"],
    completionDependency: "independent", reviewStatus: "proposed",
  });
  const gaps: OperationalIntentCatalog["gaps"] = [
    { key: "scope-review", title: "Reviewed HRO scope is not exhaustive", description: "The master inventory is a research scope baseline, not every possible client request. Outcome-specific input/evidence schemas and initiation rules remain proposed for every definition.", definitionKeys: [], reviewStatus: "proposed" },
    { key: "current-evidence", title: "Current operational support audit pending", description: "Legacy registry simulation claims and local workflow/provider code do not prove live end-to-end outcome support. No integrated or verified catalog receipts are presently approved.", definitionKeys: [], reviewStatus: "proposed" },
    { key: "retained-distinctions", title: "Similar wording does not prove identical outcomes", description: "New-hire eligibility determination versus eligibility inquiry, learning assignment versus enrollment, and scheduling versus performing work-authorization verification retain separate definitions until outcome evidence justifies any merge.", definitionKeys: ["determine-new-hire-benefit-eligibility", "benefits-eligibility", "assign-learning", "training-enrollment", "schedule-work-authorization-reverification", "work-authorization"], reviewStatus: "proposed" },
    ...mappings.filter(item => ["broader", "ambiguous", "unresolved"].includes(item.relation)).map(item => ({
      key: `${item.source}:${item.sourceKey}`, title: item.label, description: item.rationale, definitionKeys: item.definitionKeys, reviewStatus: "proposed" as const,
    })),
    ...customRows.filter(row => row.organizationId === organizationId).map(row => ({
      key: `custom:${row.id}`, title: `Tenant outcome review: ${row.name}`, description: "Custom definition has no approved operational grouping or current execution-evidence mapping. Legacy declared maturity is not inherited.", definitionKeys: [`custom:${row.id}`], reviewStatus: "proposed" as const,
    })),
  ];
  const catalog: OperationalIntentCatalog = {
    version: CATALOG_VERSION, sourceVersions: [master.taxonomyVersion, legacy.taxonomyVersion, RECONCILIATION_VERSION, retainedScenarioVersion, "offline-additional-v1", "offline-complementary-v1", ...HRO_BATCH_TEMPLATES.map(row => `${row.id}:${row.version}`)],
    scope: master.scope,
    notices: ["Catalog membership and proposed human/AI initiation metadata never authorize execution.", "Journeys and services are browsing metadata, not owners or fixed parents. A sub-intent is an instance of the same reusable definition in a caller context.",
      "Sample variations do not inflate definition counts or establish support. Commercial costs, custom routing, approvals and providers are unchanged.",
      "Coverage: catalogued = definition only; illustrative = fictional intake examples; simulated = currently evidenced local execution; integrated = current remote completion evidence; verified = independently approved end-to-end outcome receipt. This first release has no approved simulated, integrated or verified catalog evidence."],
    counts: { journeys: master.journeys.length, services: master.serviceIntents.length, masterAtomicOutcomes: master.subIntents.length,
      canonicalAtomicDefinitions: definitions.filter(row => row.definitionClass === "atomic").length, compositeDefinitions: definitions.filter(row => row.definitionClass === "composite").length,
      customDefinitions: definitions.filter(row => row.definitionClass === "custom").length, proposedGaps: gaps.length,
      sampleVariations: CURATED_OFFLINE_EXAMPLES.length + SCENARIOS.length, registryEntries: intents.length },
    journeys: master.journeys.map(row => ({ key: row.key, name: row.name, description: row.description, journeyKey: null })),
    services: master.serviceIntents.map(row => ({ key: row.key, name: row.name, description: row.description, journeyKey: row.journeyKey })),
    definitions, mappings, compositions, gaps, instanceContract: FUTURE_INSTANCE_CONTRACT,
  };
  validateCatalogIntegrity(catalog);
  return GetIntentCatalogResponse.parse(catalog);
}

export function validateCatalogIntegrity(catalog: OperationalIntentCatalog): void {
  const keys = new Set(catalog.definitions.map(row => row.key));
  if (keys.size !== catalog.definitions.length) throw new Error("Duplicate catalog identity");
  const journeyKeys = new Set(catalog.journeys.map(row => row.key));
  const serviceKeys = new Set(catalog.services.map(row => row.key));
  if (journeyKeys.size !== catalog.journeys.length || serviceKeys.size !== catalog.services.length) throw new Error("Duplicate grouping identity");
  for (const service of catalog.services) if (!service.journeyKey || !journeyKeys.has(service.journeyKey)) throw new Error("Orphan service");
  for (const row of catalog.definitions) {
    if (!row.outcome.trim() || !row.evidence.length || !row.version) throw new Error("Missing outcome contract");
    if (row.journeyKeys.some(key => !journeyKeys.has(key)) || row.serviceKeys.some(key => !serviceKeys.has(key))) throw new Error("Orphan definition grouping");
  }
  for (const row of [...catalog.mappings, ...catalog.gaps]) if (row.definitionKeys.some(key => !keys.has(key))) throw new Error("Unresolved mapping target");
  const edgeKeys = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of catalog.compositions) {
    if (!keys.has(edge.callerKey) || !keys.has(edge.calleeKey) || edgeKeys.has(edge.key)) throw new Error("Invalid composition");
    edgeKeys.add(edge.key);
    adjacency.set(edge.callerKey, [...(adjacency.get(edge.callerKey) ?? []), edge.calleeKey]);
  }
  const visited = new Set<string>(), active = new Set<string>();
  function visit(key: string) {
    if (active.has(key)) throw new Error("Composition cycle");
    if (visited.has(key)) return;
    active.add(key);
    for (const child of adjacency.get(key) ?? []) visit(child);
    active.delete(key); visited.add(key);
  }
  for (const key of keys) visit(key);
  const masterRows = catalog.mappings.filter(row => row.source === "master");
  if (new Set(masterRows.map(row => row.sourceKey)).size !== master.subIntents.length + master.compositeRoutes.length) throw new Error("Master mappings incomplete");
  for (const service of master.serviceIntents) {
    const children = master.subIntents.filter(row => row.serviceIntentKey === service.key);
    if (children.length !== service.subIntentKeys.length || service.subIntentKeys.some(key => !children.some(row => row.key === key && row.journeyKey === service.journeyKey))) throw new Error("Master hierarchy mismatch");
  }
  for (const journey of master.journeys) {
    const children = master.serviceIntents.filter(row => row.journeyKey === journey.key);
    if (children.length !== journey.serviceIntentKeys.length || journey.serviceIntentKeys.some(key => !children.some(row => row.key === key))) throw new Error("Master journey mismatch");
  }
  if (catalog.counts.journeys !== catalog.journeys.length || catalog.counts.services !== catalog.services.length ||
      catalog.counts.masterAtomicOutcomes !== master.subIntents.length ||
      catalog.counts.compositeDefinitions !== catalog.definitions.filter(row => row.definitionClass === "composite").length ||
      catalog.counts.registryEntries !== catalog.mappings.filter(row => row.source === "registry").length ||
      catalog.counts.proposedGaps !== catalog.gaps.length ||
      catalog.counts.canonicalAtomicDefinitions !== catalog.definitions.filter(row => row.definitionClass === "atomic").length ||
      catalog.counts.customDefinitions !== catalog.definitions.filter(row => row.definitionClass === "custom").length ||
      catalog.counts.sampleVariations !== catalog.mappings.filter(row => row.source === "sample").length) throw new Error("Catalog counts mismatch");
}

/** Exact identity only; never calls the legacy routing resolver or an executor. */
export function catalogDefinition(catalog: OperationalIntentCatalog, key: string) {
  return catalog.definitions.find(row => row.key === key);
}
