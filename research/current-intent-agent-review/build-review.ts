/**
 * Offline assessment assembly. No database, provider, model, environment-secret
 * or runtime write access. Run from the repository root with the workspace tsx.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildIntentCatalog, CATALOG_VERSION } from "../../artifacts/api-server/src/lib/intent-catalog";
import { agentCatalogue, AGENT_CATALOGUE_VERSION } from "../../artifacts/api-server/src/lib/agent-catalogue";
import { profiles, newRoles, roleChanges, candidates, REVIEW_DATE, REVIEW_VERSION } from "./review-decisions";

const directory = "research/current-intent-agent-review";
const read = (p: string) => fs.readFileSync(p, "utf8");
const json = (p: string) => JSON.parse(read(p));
const uniq = <T>(values: T[]) => [...new Set(values)];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const master = json("research/hro-master-intent-taxonomy.json");
const legacy = json("research/intent-agent-coverage.json");
const sources = json("research/hro-master-taxonomy-sources.json");
const catalog = buildIntentCatalog();
const agents = agentCatalogue();
const invocationSource = read("artifacts/api-server/src/lib/agent-invocation.ts");
const executableTools = JSON.parse(invocationSource.match(/EXECUTABLE_AGENT_TOOL_KEYS = (\[[^\n]+\]) as const/)?.[1] ?? "null");
assert.deepEqual(executableTools, ["tool.case.read", "tool.context.read"], "Registered tool evidence changed; reassess capabilities");
const byKey = new Map(catalog.definitions.map(d => [d.key, d]));
const canonicalKey = (key: string) => key === "assign-mandatory-learning" ? "assign-learning" : key;

// Read literal service associations, not inferred composite co-membership.
// Reject changes in catalogue shape rather than guessing at an unfamiliar form.
const roleRows = read("artifacts/api-server/src/lib/agent-catalogue.ts").split("\n")
  .filter(line => /^  \["/.test(line)).map(line => JSON.parse(line.trim().replace(/,$/, "")));
assert.equal(roleRows.length, agents.length, "Explicit service association extraction changed");
const explicitServices = new Map<string, string[]>(roleRows.map(row => [row[0], row[4]]));
for (const agent of agents) {
  const literal = roleRows.find(row => row[0] === agent.key);
  assert.equal(literal?.[1], agent.name);
  const expected = catalog.definitions.filter(d => d.serviceKeys.some(s => explicitServices.get(agent.key)!.includes(s))).map(d => d.key);
  assert.deepEqual(agent.mappings.map(m => m.intentKey), expected, "Catalogue mapping algorithm changed");
}
const roleKeys = new Set([...agents.map(a => a.key), ...newRoles.map(a => a.key)]);
const serviceKeys = new Set(catalog.services.map(s => s.key));
const assignedProfileServices = profiles.flatMap(p => p.services);
assert.equal(assignedProfileServices.length, new Set(assignedProfileServices).size, "Duplicate proposed service owner");
assert.deepEqual(new Set(assignedProfileServices), serviceKeys, "Every service needs an explicit reviewed proposal");
const profileFor = (key: string) => {
  const result = profiles.find(p => p.services.includes(key));
  assert.ok(result, `Missing proposal ${key}`); return result;
};
const associatedRoles = (service: string) => agents.filter(a => explicitServices.get(a.key)!.includes(service)).map(a => a.key);
const serviceReviews = catalog.services.map(service => {
  const p = profileFor(service.key);
  const sourceRows = master.subIntents.filter((r: any) => r.serviceIntentKey === service.key);
  return {
    ...service, explicitlyAssociatedRoles: associatedRoles(service.key),
    previouslyUnassociated: associatedRoles(service.key).length === 0,
    atomicIntentKeys: uniq(sourceRows.map((r: any) => canonicalKey(r.key))),
    compositeIntentKeys: catalog.definitions.filter(d => d.definitionClass === "composite" && d.serviceKeys.includes(service.key)).map(d => d.key),
    proposedAccountableRole: p.owner, collaborators: p.collaborators,
    recommendation: `${service.name}: ${associatedRoles(service.key).length ? "Review existing association" : "Add explicit association"} to ${p.owner}; apply only to this service's atomic outcomes. Composite coordination stays with onboarding.`,
    rationale: p.rationale, humanDecisionBoundary: p.boundary,
    requiredFutureSystems: p.systems, missingCapabilities: p.capabilities,
    proposedAcceptanceEvidence: p.acceptance,
    reviewDisposition: "assessment proposal; not an approved mapping or adapter",
  };
});

const matrix = catalog.definitions.map(d => {
  const rows = master.subIntents.filter((r: any) => canonicalKey(r.key) === d.key);
  const ps = uniq(d.serviceKeys.map(key => profileFor(key)));
  const composite = d.definitionClass === "composite";
  const currentRoles = agents.filter(a => a.mappings.some(m => m.intentKey === d.key)).map(a => a.key);
  const primary = composite ? "onboarding" : ps[0]!.owner;
  // Shared assignment has two browsing contexts but one Learning coordinator.
  if (!composite) assert.equal(new Set(ps.map(p => p.owner)).size, 1, `Conflicting accountability for ${d.key}`);
  const genericOutcome = /is completed (with a recorded, observable result|and recorded as one authoritative outcome)/i.test(d.outcome);
  const genericEvidence = d.evidence.some(e => /^dated (system|authoritative) record$|^immutable audit event$/.test(e));
  const genericSystems = rows.some((r: any) => r.systems.includes("system of record"));
  return {
    intentKey: d.key, name: d.name, definitionClass: d.definitionClass, definitionVersion: d.version,
    journeyKeys: d.journeyKeys, serviceKeys: d.serviceKeys,
    observableOutcomeAsCatalogued: d.outcome,
    outcomeContractStatus: genericOutcome ? "generic; observable state/record not specified" : "described; schema and authority review still required",
    completionEvidenceAsCatalogued: d.evidence,
    contractFlags: [
      ...(genericOutcome ? ["generic-outcome"] : []),
      ...(genericEvidence ? ["generic-completion-evidence"] : []),
      ...(genericSystems ? ["generic-system-contract"] : []),
      "no-approved-outcome-specific-input-evidence-schema",
      ...(composite ? ["composite-applicability-and-final-human-readiness-not-one-write"] : []),
    ],
    sourceVersion: master.taxonomyVersion, catalogueVersion: catalog.version,
    sourceOutcomeKeys: rows.length ? rows.map((r: any) => r.key) : [d.key],
    sourceProvenance: d.provenance,
    sourceEvidenceQuality: "Master family-scope provenance; not an inspected exact source-to-outcome quote or legal validation.",
    sourceContracts: rows.map((r: any) => ({
      sourceOutcomeKey: r.key, researchAccountableLabel: r.accountableAgent,
      collaborators: r.collaboratingAgents, systems: r.systems,
      readActions: r.readActions, writeActions: r.writeActions,
      humanApproval: r.humanApproval, completionEvidence: r.completionEvidence,
      jurisdictionOverlay: r.jurisdictionOverlay,
    })),
    aliases: d.aliases,
    currentCatalogueAssociations: currentRoles,
    currentExplicitServiceAssociations: d.serviceKeys.map(serviceKey => ({ serviceKey, roleKeys: associatedRoles(serviceKey) })),
    proposedAccountableCoordinatingRole: primary,
    proposedCollaborators: uniq([...ps.flatMap(p => p.collaborators), ...currentRoles.filter(r => r !== primary)])
      .filter(key => key !== primary),
    humanDecisionBoundary: composite
      ? "HR makes a fresh version-bound final readiness decision after applicable evidence; accepted offer precedes effects. Child professional approvals stay independent."
      : uniq(ps.map(p => p.boundary)).join(" "),
    requiredInputsAsCatalogued: d.requiredContext,
    inputContractStatus: "Generic required context only; validate outcome-specific fields, source identifiers, versions, lawful authority and applicability before implementation.",
    requiredFutureSystemsAndTools: uniq(ps.flatMap(p => p.systems)),
    proposedCapabilityImprovements: uniq(ps.flatMap(p => p.capabilities)),
    proposedEvidenceAcceptance: composite
      ? "Approved applicable outcome set, source-attested child receipts and current named HR readiness authority; no retired launch/evaluation result."
      : ps.map(p => p.acceptance).join(" "),
    proposalStatus: "Requirements to review; not an invented current contract or permission",
    currentCapability: {
      catalogueCoverage: d.coverage, catalogueEvidence: d.coverageEvidence,
      registeredAgentDomainExecution: "unavailable",
      registeredAgentTools: executableTools,
      toolLimitation: "Scoped case metadata/read-only working-context access after live owner/initiator authorization; neither completes this domain outcome.",
      integratedOutcomeReceiptReviewed: false, verifiedDomainExecution: "not established",
      workflowCapabilityEvidenceRefs: ["capability-ledger.md"],
    },
  };
});

const roles = agents.map(agent => {
  const change = roleChanges[agent.key]; assert.ok(change, `Role decision missing ${agent.key}`);
  const accountable = matrix.filter(r => r.proposedAccountableCoordinatingRole === agent.key).map(r => r.intentKey);
  const collaborating = matrix.filter(r => r.proposedCollaborators.includes(agent.key)).map(r => r.intentKey);
  const existing = agent.mappings.map(m => m.intentKey);
  return {
    key: agent.key, name: agent.name, kind: agent.kind, catalogueVersion: agent.version,
    currentResponsibility: agent.responsibility, explicitServiceKeys: explicitServices.get(agent.key),
    ...change, currentIntentKeys: existing, proposedAccountableIntentKeys: accountable,
    proposedCollaboratorIntentKeys: collaborating,
    exactAffectedIntentKeys: uniq([...existing, ...accountable, ...collaborating]),
    currentCapability: agent.operationalCapability,
    // Current associations are not removed by this assessment.
    currentAssociationsNeedingBoundaryReview: existing.filter(key => !accountable.includes(key)),
  };
});
const proposedRoles = newRoles.map(role => ({
  ...role, exactAffectedIntentKeys: matrix.filter(r => r.proposedAccountableCoordinatingRole === role.key).map(r => r.intentKey),
  humanDecisionBoundaries: uniq(matrix.filter(r => r.proposedAccountableCoordinatingRole === role.key).map(r => r.humanDecisionBoundary)),
  requiredFutureSystems: uniq(matrix.filter(r => r.proposedAccountableCoordinatingRole === role.key).flatMap(r => r.requiredFutureSystemsAndTools)),
  requiredInputs: "Current scoped subject/request, approved source object and policy versions, named human sponsor/decision, applicable evidence; outcome-specific schemas still need approval.",
  proposedCompletionEvidence: uniq(matrix.filter(r => r.proposedAccountableCoordinatingRole === role.key).map(r => r.proposedEvidenceAcceptance)),
  currentCapability: "not registered or implemented; proposal only",
}));

const allAtomic = matrix.filter(r => r.definitionClass === "atomic").map(r => r.intentKey);
const gaps = [
  ...serviceReviews.filter(s => s.previouslyUnassociated).map(s => ({
    key: `association:${s.key}`, category: "missing-agent-association", candidateClassification: "already covered",
    intentKeys: s.atomicIntentKeys, confidence: "high", evidence: "agent-catalogue.ts literal service arrays compared with master service keys",
    finding: s.recommendation, priority: "P0", resolution: "Review proposed owner and collaborator boundary; version catalogue and binding review only in a later approved change.",
  })),
  ...matrix.filter(r => r.contractFlags.some(f => f.startsWith("generic-"))).map(r => ({
    key: `contract:${r.intentKey}`, category: "inadequate-outcome-contract", candidateClassification: "already covered",
    intentKeys: [r.intentKey], confidence: "high", evidence: `intent-catalog:${r.intentKey}; master source contracts`,
    finding: r.contractFlags.filter(f => f.startsWith("generic-")).join(", "), priority: "P1",
    resolution: "Domain owner must name authoritative record, observable state, typed inputs/evidence and applicable human decision before any execution claim.",
  })),
  ...candidates.map(c => ({
    key: `candidate:${c.key}`, category: c.classification === "genuinely new outcome" ? "missing-intent-definition"
      : c.classification === "unresolved" ? "unresolved-intent-boundary" : "reconciled-historical-candidate",
    candidateClassification: c.classification, intentKeys: c.targets, confidence: c.confidence,
    evidence: c.evidence, finding: c.reason, proposal: c.proposal ?? null,
    priority: c.classification === "genuinely new outcome" ? "P1" : c.classification === "unresolved" ? "P2" : "closed-as-definition-gap",
    resolution: c.classification === "genuinely new outcome" ? "Approve outcome distinction and source contract before a separate catalogue proposal."
      : c.classification === "unresolved" ? "Resolve source evidence and authoritative completion boundary with product/domain owner."
      : "Do not add synonymous definitions or promote the label into a routing alias.",
  })),
  ...profiles.map((p, index) => ({
    key: `tools:${index + 1}`, category: "unavailable-or-unverified-tools-integrations", candidateClassification: "already covered",
    intentKeys: uniq(matrix.filter(r => r.serviceKeys.some(s => p.services.includes(s))).map(r => r.intentKey)),
    confidence: "high", evidence: "agent-catalogue.ts operationalCapability; agent-invocation.ts executable allowlist; capability-ledger.md",
    finding: `Required future systems: ${p.systems.join("; ")}. No registered role adapter or approved domain receipt is established.`,
    priority: "P2", resolution: "Select one approved source-system integration and validate independently; code/provider availability is not evidence of tenant configuration.",
  })),
  { key: "verification:all-outcomes", category: "unverified-execution", candidateClassification: "already covered",
    intentKeys: matrix.map(r => r.intentKey), confidence: "high", evidence: "intent-catalog.ts coverageEvidence; agent-catalogue.ts; capability-ledger.md",
    finding: "No canonical outcome has an approved current integrated/verified domain completion receipt in the inspected catalogue. This does not assert all legacy workflow capability is absent.",
    priority: "P2", resolution: "Obtain dated current source-attested result, applicable human decisions and independent outcome verification before changing support status." },
  { key: "scope:tenant-custom", category: "unavailable-tenant-inventory", candidateClassification: "unresolved",
    intentKeys: [], confidence: "high", evidence: "routes/intent-catalog.ts tenant-scoped loadRows; intent-catalog.ts customRows assembly",
    finding: "No authorized tenant snapshot was supplied or queried. Current active/retired custom counts, duplicates and associations are unknown, not zero.",
    priority: "P1", resolution: "Use an explicitly authorized tenant-scoped catalogue export, including revision and active/retired status; compare without cross-tenant disclosure." },
];

const aliasEdges = catalog.definitions.flatMap(d => d.aliases.map(alias => ({ alias, intentKey: d.key, basis: "current catalogue alias metadata; not a routing approval" })));
const aliasIndex = new Map<string, string[]>();
for (const edge of aliasEdges) aliasIndex.set(edge.alias.toLowerCase(), uniq([...(aliasIndex.get(edge.alias.toLowerCase()) ?? []), edge.intentKey]));
const ambiguousAliases = [...aliasIndex].filter(([, keys]) => keys.length > 1).map(([alias, intentKeys]) => ({ alias, intentKeys }));
const normalizedOutcomes = new Map<string, string[]>();
for (const row of master.subIntents) {
  const signature = row.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  normalizedOutcomes.set(signature, [...(normalizedOutcomes.get(signature) ?? []), row.key]);
}
const exactDuplicateSourceOutcomes = [...normalizedOutcomes].filter(([, keys]) => keys.length > 1).map(([outcome, sourceOutcomeKeys]) => ({ outcome, sourceOutcomeKeys }));
const sourceFiles = [
  "artifacts/api-server/src/lib/intent-catalog.ts", "artifacts/api-server/src/lib/intent-catalog-types.ts",
  "artifacts/api-server/src/lib/intent-catalog.test.ts", "artifacts/api-server/src/lib/agent-catalogue.ts",
  "artifacts/api-server/src/lib/agent-invocation.ts", "artifacts/api-server/src/lib/intent-registry.ts",
  "artifacts/api-server/src/lib/onboarding/operational-agents.ts", "artifacts/api-server/src/routes/intent-catalog.ts",
  "artifacts/onboarding-agent/src/pages/intent-catalog.tsx", "artifacts/onboarding-agent/src/pages/agents/index.tsx",
  "research/hro-master-intent-taxonomy.json", "research/hro-master-intent-taxonomy.csv",
  "research/hro-master-taxonomy-sources.json", "research/hro-master-taxonomy-notes.md",
  "research/hro-operational-catalog-contract.md", "research/agent-catalogue-registration-boundaries.md",
  "research/hro-intent-agent-architecture.md", "research/intent-agent-coverage.json",
  "research/drafts/hro-master-gap-review.md", "research/drafts/hro-master-source-review.md",
  "research/current-intent-agent-review/review-decisions.ts", "research/current-intent-agent-review/capability-ledger.md",
  "artifacts/api-server/src/lib/onboarding/action-conversation-contract.ts",
  "artifacts/api-server/src/lib/onboarding/action-conversation-agents.ts",
  "artifacts/api-server/src/lib/onboarding/connectors.ts",
  "artifacts/api-server/src/lib/onboarding/standard-provider-adapters.ts",
  "artifacts/api-server/src/lib/onboarding/standard-provider-source-read.ts",
  "artifacts/api-server/src/lib/onboarding/early-tenure.ts",
  "artifacts/api-server/src/lib/onboarding/frontline-operations.ts",
  "artifacts/api-server/src/lib/onboarding/workforce-transfer.ts",
  "artifacts/api-server/src/lib/offboarding/exchange-service.ts",
  ...sources.sources.map((s: any) => s.evidencePath?.split("#")[0]).filter(Boolean),
].filter((p, i, values) => values.indexOf(p) === i);
const fingerprints = sourceFiles.map(file => ({ file, sha256: hash(read(file)) }));
const explicitlyUnassociated = serviceReviews.filter(s => s.previouslyUnassociated);
const counts = {
  journeys: catalog.journeys.length, services: catalog.services.length,
  sourceAtomicOutcomes: master.subIntents.length, canonicalAtomicDefinitions: allAtomic.length,
  compositeDefinitions: matrix.filter(r => r.definitionClass === "composite").length,
  commercialConcepts: catalog.mappings.filter(m => m.source === "registry").length,
  catalogueAliasEdges: aliasEdges.length, distinctCatalogueAliasLabels: aliasIndex.size,
  ambiguousAliasLabels: ambiguousAliases.length,
  historicalAndFictionalExampleDefinitions: catalog.mappings.filter(m => m.source === "sample").length,
  retainedHistoricalScenarioDefinitions: catalog.mappings.filter(m => m.source === "sample" && m.sourceKey.startsWith("retained:")).length,
  curatedOfflineRequestDefinitions: catalog.mappings.filter(m => m.source === "sample" && !m.sourceKey.startsWith("retained:")).length,
  tenantCustomDefinitions: null,
  historicalObservedCustomRows: legacy.observedDevelopmentCustomIntents.length,
  legacyCandidateRows: legacy.candidateGaps.length, reviewedCandidates: candidates.length,
  proposedNewAtomicOutcomes: candidates.filter(c => c.classification === "genuinely new outcome").length,
  unresolvedCandidates: candidates.filter(c => c.classification === "unresolved").length,
  existingDomainRoles: agents.filter(a => a.kind === "domain").length,
  existingSupportingRoles: agents.filter(a => a.kind === "supporting").length,
  explicitlyAssociatedServices: serviceReviews.length - explicitlyUnassociated.length,
  explicitlyUnassociatedServices: explicitlyUnassociated.length,
  proposedAdditionalRoles: newRoles.length,
  genericOutcomeDefinitions: matrix.filter(r => r.contractFlags.includes("generic-outcome")).length,
  genericEvidenceDefinitions: matrix.filter(r => r.contractFlags.includes("generic-completion-evidence")).length,
  genericSystemsDefinitions: matrix.filter(r => r.contractFlags.includes("generic-system-contract")).length,
};
const packageData = {
  reviewVersion: REVIEW_VERSION, assessedOn: REVIEW_DATE,
  catalogueVersion: CATALOG_VERSION, agentCatalogueVersion: AGENT_CATALOGUE_VERSION,
  masterVersion: master.taxonomyVersion, legacyResearchVersion: legacy.taxonomyVersion,
  scope: "Offline read-only source/code review; canonical catalogue only. No tenant data, model calls, provider probes, runtime mutations or professional decisions.",
  tenantCustomInventory: { status: "not accessed", count: null, activeCount: null, retiredCount: null,
    historicalObservation: "Two development custom rows were observed in September research; not a current tenant inventory or canonical definitions.",
    contract: "Custom definitions require explicit organization scope, custom:id identity, content-derived revision, isolated aliases, status and separate outcome review; declared legacy maturity is not current support." },
  counts, sourceVersions: catalog.sourceVersions, sourceFingerprints: fingerprints,
  reconciliation: {
    sourceToCanonical: catalog.mappings.filter(m => m.source === "master"),
    commercialMappings: catalog.mappings.filter(m => m.source === "registry"),
    exampleMappings: catalog.mappings.filter(m => m.source === "sample"),
    caseFamilyMappings: catalog.mappings.filter(m => m.source === "case-family"),
    historicalCandidateMappings: catalog.mappings.filter(m => m.source === "candidate"),
    historicalObservedCustomRows: legacy.observedDevelopmentCustomIntents,
    compositions: catalog.compositions, aliasEdges, ambiguousAliases, exactDuplicateSourceOutcomes,
    canonicalConsolidation: { canonicalKey: "assign-learning", sourceKeys: ["assign-mandatory-learning", "assign-learning"],
      basis: "Same learning-assignment record; mandatory flag is context. No other semantic merge approved." },
  },
  journeys: catalog.journeys.map(j => ({ ...j, serviceKeys: serviceReviews.filter(s => s.journeyKey === j.key).map(s => s.key),
    canonicalIntentKeys: matrix.filter(r => r.journeyKeys.includes(j.key)).map(r => r.intentKey),
    assessment: "Every service reviewed below. Membership counts overlap for reused definitions and composite; do not sum journey memberships as unique definitions." })),
  serviceReviews, definitions: matrix, candidateGapReview: candidates, gapRegister: gaps,
  existingRoleRecommendations: roles, proposedRoleRecommendations: proposedRoles,
};

function validate(data: typeof packageData) {
  assert.deepEqual([data.counts.journeys, data.counts.services, data.counts.sourceAtomicOutcomes,
    data.counts.canonicalAtomicDefinitions, data.counts.compositeDefinitions,
    data.counts.commercialConcepts, data.counts.explicitlyAssociatedServices,
    data.counts.explicitlyUnassociatedServices, data.counts.existingDomainRoles, data.counts.existingSupportingRoles],
  [17, 88, 320, 319, 1, 60, 56, 32, 12, 3], "Verified baseline/revision drift; review, do not silently recalculate");
  assert.equal(data.catalogueVersion, "hro-operational-v1");
  assert.equal(data.agentCatalogueVersion, "hro-agents-v1");
  assert.equal(data.masterVersion, "hro-master-v1");
  assert.equal(data.definitions.length, new Set(data.definitions.map(r => r.intentKey)).size, "Duplicate definition");
  assert.deepEqual(new Set(data.definitions.map(r => r.intentKey)), new Set(byKey.keys()), "Incomplete canonical coverage");
  for (const row of data.definitions) {
    const current = byKey.get(row.intentKey)!;
    assert.equal(row.definitionVersion, current.version, "Mismatched definition revision");
    assert.equal(row.catalogueVersion, data.catalogueVersion, "Mismatched catalogue revision");
    assert.ok(roleKeys.has(row.proposedAccountableCoordinatingRole), "Dangling proposed owner");
    for (const key of [...row.currentCatalogueAssociations, ...row.proposedCollaborators]) assert.ok(roleKeys.has(key), "Dangling role");
    assert.deepEqual(row.aliases, current.aliases, "Unsupported aliases");
    for (const field of [row.observableOutcomeAsCatalogued, row.humanDecisionBoundary, row.proposedEvidenceAcceptance]) assert.ok(field.length);
    assert.ok(row.requiredFutureSystemsAndTools.length && row.sourceProvenance.length);
    assert.equal(row.currentCapability.verifiedDomainExecution, "not established");
  }
  for (const s of data.serviceReviews) {
    assert.ok(s.atomicIntentKeys.length && roleKeys.has(s.proposedAccountableRole));
    for (const key of [...s.atomicIntentKeys, ...s.compositeIntentKeys]) assert.ok(byKey.has(key), "Dangling service outcome");
  }
  for (const r of [...data.existingRoleRecommendations, ...data.proposedRoleRecommendations]) {
    for (const key of r.exactAffectedIntentKeys) assert.ok(byKey.has(key), "Dangling affected intent");
  }
  for (const c of data.candidateGapReview) for (const key of c.targets) assert.ok(byKey.has(key), "Dangling candidate target");
  for (const g of data.gapRegister) for (const key of g.intentKeys) assert.ok(byKey.has(key), "Dangling gap target");
  const edges = data.reconciliation.sourceToCanonical;
  assert.equal(edges.length, 321); assert.equal(new Set(edges.map(m => m.sourceKey)).size, 321);
  for (const row of [...master.subIntents, ...master.compositeRoutes]) {
    assert.equal(edges.filter(e => e.sourceKey === row.key).length, 1, "Source outcome missing/duplicated");
  }
  for (const edge of [...edges, ...data.reconciliation.commercialMappings]) {
    for (const key of edge.definitionKeys) assert.ok(byKey.has(key), "Dangling source/commercial mapping");
  }
  assert.equal(data.reconciliation.commercialMappings.length, 60);
  assert.equal(new Set(data.reconciliation.commercialMappings.map(r => r.sourceKey)).size, 60);
  assert.equal(data.reconciliation.ambiguousAliases.length, 0, "Unsupported ambiguous aliases require explicit review");
  assert.equal(data.counts.tenantCustomDefinitions, null, "Unknown custom count cannot become zero");
  // Semantic duplicate detection cannot be inferred from string equality alone.
  for (const d of data.reconciliation.exactDuplicateSourceOutcomes) {
    assert.equal(new Set(d.sourceOutcomeKeys.map(canonicalKey)).size, 1, "Unreviewed identical source outcome");
  }
  for (const c of legacy.candidateGaps) assert.ok(data.candidateGapReview.some(r => r.key === c.key), "Historical candidate unreviewed");
}
validate(packageData);

// The master CSV is a separate deliverable and must agree with the JSON.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ",") { row.push(cell); cell = ""; }
    else if (!quoted && ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  assert.equal(quoted, false, "Unclosed CSV field"); return rows;
}
const csvSource = parseCsv(read("research/hro-master-intent-taxonomy.csv"));
assert.equal(csvSource.length - 1, master.subIntents.length, "Source CSV count mismatch");
assert.deepEqual(new Set(csvSource.slice(1).map(r => r[0])), new Set(master.subIntents.map((r: any) => r.key)), "Source CSV keys mismatch");

const stringify = (data: unknown) => JSON.stringify(data, null, 2) + "\n";
const csvFields = ["intentKey", "name", "definitionClass", "definitionVersion", "journeyKeys", "serviceKeys",
  "observableOutcomeAsCatalogued", "sourceVersion", "sourceOutcomeKeys", "currentCatalogueAssociations",
  "proposedAccountableCoordinatingRole", "proposedCollaborators", "humanDecisionBoundary",
  "requiredInputsAsCatalogued", "requiredFutureSystemsAndTools", "completionEvidenceAsCatalogued",
  "proposedEvidenceAcceptance", "contractFlags", "currentCapability"];
const csvCell = (v: unknown) => `"${(typeof v === "string" ? v : JSON.stringify(v)).replaceAll('"', '""')}"`;
const csv = [csvFields, ...matrix.map(row => csvFields.map(field => row[field as keyof typeof row]))].map(row => row.map(csvCell).join(",")).join("\n") + "\n";
assert.equal(parseCsv(csv).length, 321);

const serviceTable = serviceReviews.map(s => `| ${s.journeyKey} | ${s.key} | ${s.atomicIntentKeys.length} | ${s.explicitlyAssociatedRoles.join(", ") || "**None**"} | ${s.proposedAccountableRole} | ${s.rationale} |`).join("\n");
const roleTable = roles.map(r => `| ${r.name} | ${r.recommendation} | ${r.change} | ${r.missing.join("; ")} |`).join("\n");
const candidateTable = candidates.map(c => `| ${c.key} | ${c.classification} | ${c.confidence} | ${c.targets.join(", ")} | ${c.reason} | ${c.evidence} |`).join("\n");
const generatedTables = `# Detailed review tables\n\nAssessed ${REVIEW_DATE}. Proposals only. Exact definition-level fields and affected-key arrays are in [intent-agent-matrix.json](intent-agent-matrix.json).\n\n## Every service, including all 32 explicit association gaps\n\nAtomic counts here are memberships, not additive unique outcomes. Composite propagation is excluded from explicit-role counts.\n\n| Journey | Service | Atomic memberships | Explicit current roles | Proposed coordinator | Rationale |\n|---|---|---:|---|---|---|\n${serviceTable}\n\n## Every existing agent\n\nExact current, proposed accountable, collaborator and affected keys are enumerated per role in JSON. No current mappings are edited.\n\n| Role | Recommendation | Responsibility change | Missing capabilities |\n|---|---|---|---|\n${roleTable}\n\n## Candidate decisions\n\nTargets show related/current definitions, not aliases or proposed execution bindings.\n\n| Candidate | Classification | Confidence | Related canonical keys | Decision evidence/reason | Source locator |\n|---|---|---|---|---|---|\n${candidateTable}\n\n## Proposed additional roles: alternatives and gates\n\n${proposedRoles.map(r => `### ${r.name}\n\n- Boundary: ${r.boundary}\n- Extend existing role instead: ${r.extendExisting}\n- Deterministic alternative: ${r.deterministicAlternative}\n- Justification: ${r.justification}\n- Affected canonical outcomes: ${r.exactAffectedIntentKeys.join(", ")}.\n- Current support: ${r.currentCapability}.\n`).join("\n")}`;
const outputs: Record<string, string> = {
  "intent-agent-matrix.json": stringify(packageData),
  "intent-agent-matrix.csv": csv,
  "gap-register.json": stringify({ reviewVersion: REVIEW_VERSION, assessedOn: REVIEW_DATE, gaps }),
  "review-tables.md": generatedTables,
  "reconciliation-results.json": stringify({
    reviewVersion: REVIEW_VERSION, assessedOn: REVIEW_DATE, counts,
    checks: ["canonical/source/composite full coverage", "explicit 56/32 service split", "all 15 role decisions",
      "source CSV/JSON identity", "catalogue/definition revisions", "source and commercial target integrity",
      "alias metadata provenance and ambiguity", "exact duplicate source outcome scan", "candidate and role target integrity",
      "unknown tenant inventory retained", "deterministic committed package comparison"],
    exactDuplicateSourceOutcomes, ambiguousAliases,
    semanticDuplicateReview: "Only assign-mandatory-learning/assign-learning merge is approved. New-hire benefit determination vs inquiry, learning assignment vs enrollment, scheduling vs work-authorization verification, and country policy context remain distinct. String scan cannot prove semantic uniqueness.",
    sourceFingerprints: fingerprints,
  }),
};
if (process.argv.includes("--write")) {
  for (const [name, content] of Object.entries(outputs)) fs.writeFileSync(path.join(directory, name), content);
  console.log("Wrote assessment datasets and tables:", counts);
} else {
  for (const [name, content] of Object.entries(outputs)) assert.equal(read(path.join(directory, name)), content, `Stale ${name}; inspect source/revision drift before an approved refresh`);
  // Negative checks prove failures are enforced, not just listed in a report.
  for (const [label, mutate] of [
    ["coverage", (d: typeof packageData) => d.definitions.pop()],
    ["duplicate", (d: typeof packageData) => d.definitions.push(d.definitions[0]!)],
    ["revision", (d: typeof packageData) => { d.definitions[0]!.definitionVersion = "stale"; }],
    ["alias", (d: typeof packageData) => { d.definitions[0]!.aliases.push("invented-alias"); }],
    ["role", (d: typeof packageData) => { d.definitions[0]!.proposedAccountableCoordinatingRole = "invented-role"; }],
    ["gap", (d: typeof packageData) => { d.gapRegister[0]!.intentKeys.push("invented-outcome"); }],
  ] as const) {
    const altered = structuredClone(packageData); mutate(altered);
    assert.throws(() => validate(altered), undefined, `Negative ${label} validation did not fail`);
  }
  console.log("PASS: deterministic assessment, full reconciliation and six negative validation probes", counts);
}
