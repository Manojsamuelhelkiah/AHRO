import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const readJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sources = readJson("research/sources.json");
const matrix = readJson("research/intent-agent-coverage.json");
const plan = readJson("research/onboarding-compound-action-plan.json");
const report = fs.readFileSync(
  path.join(root, "research/hro-intent-agent-architecture.md"),
  "utf8",
);
const csv = fs
  .readFileSync(path.join(root, "research/intent-agent-coverage.csv"), "utf8")
  .trimEnd()
  .split("\n");
const catalogSource = fs.readFileSync(
  path.join(root, "artifacts/api-server/src/data/intents.ts"),
  "utf8",
);

const parseCsvLine = (line) => {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value);
  return cells;
};

const validateSchemaValue = (schema, value, location) => {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const normalizedType =
    actualType === "number" && Number.isInteger(value) ? "integer" : actualType;
  assert(
    allowedTypes.includes(actualType) || allowedTypes.includes(normalizedType),
    `${location} expected ${allowedTypes.join("|")}, received ${actualType}`,
  );
  if (schema.enum) {
    assert(schema.enum.includes(value), `${location} is outside its enum`);
  }
  if (actualType === "array") {
    for (const [index, item] of value.entries()) {
      validateSchemaValue(schema.items, item, `${location}[${index}]`);
    }
  }
  if (actualType === "object") {
    for (const required of schema.required ?? []) {
      assert(
        Object.hasOwn(value, required),
        `${location} is missing required property ${required}`,
      );
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = schema.properties?.[key];
      const fallbackSchema =
        typeof schema.additionalProperties === "object"
          ? schema.additionalProperties
          : null;
      assert(
        propertySchema || fallbackSchema || schema.additionalProperties !== false,
        `${location}.${key} is not allowed`,
      );
      if (propertySchema || fallbackSchema) {
        validateSchemaValue(
          propertySchema ?? fallbackSchema,
          item,
          `${location}.${key}`,
        );
      }
    }
  }
};

const sourceKeys = new Set(sources.sources.map((source) => source.key));
assert(sourceKeys.size === sources.sources.length, "Source keys must be unique");
assert(sources.sources.length >= 15, "Standard-depth research needs 15+ sources");
for (const source of sources.sources) {
  const evidenceFile = source.evidencePath.split("#")[0];
  assert(
    fs.existsSync(path.join(root, evidenceFile)),
    `Missing saved evidence for ${source.key}: ${evidenceFile}`,
  );
}

assert(matrix.referenceIntents.length === 60, "Expected 60 reference intents");
assert(matrix.parentIntents.length === 38, "Expected 38 parent intents");
assert(matrix.candidateGaps.length === 6, "Expected six candidate gaps");
assert(
  matrix.observedDevelopmentCustomIntents.length === 2,
  "Expected two active development custom intents in the dated observation",
);
assert(
  new Set(matrix.referenceIntents.map((intent) => intent.key)).size === 60,
  "Reference intent keys must be unique",
);
const catalogPattern =
  /\{ key: "([^"]+)", name: "([^"]+)", domain: "([^"]+)", fc: "([^"]+)", desc: "([^"]+)", src: ([A-Za-z]+)\((?:"([^"]*)")?\), asIs: ([\d.]+), toBe: ([\d.]+), w: ([\d.]+), get: (\d+), put: (\d+), sys: (\d+), tags: \[([^\]]*)\] \}/g;
const catalogRows = [...catalogSource.matchAll(catalogPattern)].map(
  (match, index) => ({
    id: index + 1,
    key: match[1],
    name: match[2],
    domain: match[3],
    flowClass: match[4],
    description: match[5],
    asIsHandlingMin: Number(match[8]),
    toBeHumanMin: Number(match[9]),
    baseWeight: Number(match[10]),
    actGetActions: Number(match[11]),
    actPutActions: Number(match[12]),
    systemsTouchedBase: Number(match[13]),
    tags: [...match[14].matchAll(/"([^"]+)"/g)].map((tag) => tag[1]),
  }),
);
assert(catalogRows.length === 60, "Could not parse all 60 source catalog rows");
for (const catalog of catalogRows) {
  const delivered = matrix.referenceIntents.find(
    (intent) => intent.key === catalog.key,
  );
  assert(delivered, `Matrix is missing catalog row ${catalog.key}`);
  for (const field of [
    "id",
    "name",
    "domain",
    "flowClass",
    "description",
    "asIsHandlingMin",
    "toBeHumanMin",
    "baseWeight",
    "actGetActions",
    "actPutActions",
    "systemsTouchedBase",
  ]) {
    assert(
      delivered[field] === catalog[field],
      `${catalog.key} disagrees with source catalog field ${field}`,
    );
  }
  assert(
    JSON.stringify(delivered.tags) === JSON.stringify(catalog.tags),
    `${catalog.key} tags disagree with the source catalog`,
  );
}
assert(
  matrix.parentIntents.reduce(
    (total, parent) => total + parent.childKeys.length,
    0,
  ) === 60,
  "Every reference intent must appear under exactly one parent",
);

const allowedRelations = new Set([
  "exact-label",
  "family-scope",
  "curated-decomposition",
]);
const exactLabels = new Map();
for (const item of [
  ...matrix.referenceIntents,
  ...matrix.candidateGaps,
]) {
  const edges =
    item.provenance?.sourceEdges ?? item.sourceEdges ?? [];
  assert(edges.length > 0, `${item.key} must have at least one source edge`);
  for (const edge of edges) {
    assert(
      allowedRelations.has(edge.relation),
      `${item.key} has invalid source relation ${edge.relation}`,
    );
    assert(
      sourceKeys.has(edge.sourceKey),
      `${item.key} references unknown source ${edge.sourceKey}`,
    );
    if (edge.relation === "exact-label" && edge.externalLabel) {
      const prior = exactLabels.get(edge.externalLabel);
      assert(
        !prior,
        `Exact external label ${edge.externalLabel} is assigned to both ${prior} and ${item.key}`,
      );
      exactLabels.set(edge.externalLabel, item.key);
    }
  }
}

const maturityCounts = matrix.referenceIntents.reduce(
  (counts, intent) => {
    counts[intent.coverage.referenceIntentExecution] += 1;
    return counts;
  },
  { unsupported: 0, simulated: 0, integrated: 0 },
);
assert(maturityCounts.unsupported === 58, "Expected 58 unsupported outcomes");
assert(maturityCounts.simulated === 2, "Expected two simulated outcomes");
assert(maturityCounts.integrated === 0, "Expected no integrated intent route");
assert(
  matrix.referenceIntents.every(
    (intent) => intent.coverage.verifiedProductionE2E === false,
  ),
  "No reference intent may claim production E2E verification",
);

assert(csv.length === 61, "CSV must contain one header plus 60 data rows");
assert(
  csv[0].includes("referenceIntentExecution") &&
    csv[0].includes("sourceEdges"),
  "CSV must expose maturity and source-edge fields",
);
const csvHeader = csv[0].split(",");
const csvRows = csv.slice(1).map((line) => {
  const values = parseCsvLine(line);
  assert(values.length === csvHeader.length, "CSV row has wrong column count");
  return Object.fromEntries(csvHeader.map((column, index) => [column, values[index]]));
});
for (const intent of matrix.referenceIntents) {
  const row = csvRows.find((candidate) => candidate.key === intent.key);
  assert(row, `CSV is missing ${intent.key}`);
  const expected = {
    id: String(intent.id),
    key: intent.key,
    name: intent.name,
    domain: intent.domain,
    parentIntentKey: intent.taxonomy.parentIntentKey,
    parentIntentName: intent.taxonomy.parentIntentName,
    flowClass: intent.flowClass,
    accountableSpecialist: intent.responsibility.accountableSpecialist,
    collaborators: intent.responsibility.collaborators.join(" | "),
    systems: intent.systems.join(" | "),
    humanApproval: intent.humanApproval,
    sourceEdges: intent.provenance.sourceEdges
      .map(
        (edge) =>
          `${edge.relation}:${edge.sourceKey}${
            edge.externalLabel ? `#${edge.externalLabel}` : ""
          }`,
      )
      .join(" | "),
    provenanceStrength: intent.provenance.strength,
    catalogued: String(intent.coverage.catalogued),
    costModelled: String(intent.coverage.costModelled),
    referenceIntentExecution: intent.coverage.referenceIntentExecution,
    internalCapabilityImplemented: String(
      intent.coverage.internalCapabilityImplemented,
    ),
    integrated: String(intent.coverage.integrated),
    verifiedProductionE2E: String(intent.coverage.verifiedProductionE2E),
    verificationScope: intent.coverage.verificationScope,
    runtimeScope: intent.coverage.scope,
    completionEvidence: intent.completionEvidence,
  };
  assert(
    Object.keys(expected).length === csvHeader.length,
    "Validator must compare every exported CSV column",
  );
  for (const [column, value] of Object.entries(expected)) {
    assert(
      row[column] === value,
      `CSV/JSON mismatch for ${intent.key}.${column}`,
    );
  }
}

assert(
  plan.caseContract.planVersion.includes("monotonic"),
  "Plan version must be monotonic",
);
assert(plan.retryPolicy.maxAttempts > 0, "Retry policy needs an attempt ceiling");
assert(
  plan.approvalContract.binding.includes("hash"),
  "Approval must bind canonical arguments and plan version",
);
assert(
  !plan.externalEffectContract.logicalOperationKey.includes("planVersion"),
  "Logical external operation identity must survive irrelevant replanning",
);
assert(
  plan.externalEffectContract.executionAttemptKey.includes("planVersion"),
  "Execution attempt identity must retain the local plan version",
);
assert(
  plan.externalEffectContract.ambiguousOutcome.includes(
    "unknown_external_effect",
  ),
  "Ambiguous writes must stop for reconciliation/manual repair",
);
assert(
  plan.caseContract.leaseAndFencing.dispatchRule.includes(
    "compare-and-set",
  ) &&
    plan.caseContract.leaseAndFencing.dispatchRule.includes("current token"),
  "Fencing must prevent stale workers from claiming provider dispatch",
);
assert(
  plan.waiverContract.fields.includes("tenantId") &&
    plan.waiverContract.fields.includes("caseId") &&
    plan.waiverContract.fields.includes("authorityId") &&
    plan.waiverContract.fields.includes("eligibilityRuleId"),
  "Waivers must bind tenant, case, named authority, and eligibility rule",
);
assert(plan.branches.length === 9, "Expected nine compound-plan actions");
const branchIds = new Set(plan.branches.map((branch) => branch.actionId));
assert(branchIds.size === plan.branches.length, "Branch IDs must be unique");
for (const branch of plan.branches) {
  assert(
    branch.logicalOperationKey &&
      !branch.logicalOperationKey.includes("planVersion"),
    `${branch.actionId} needs a plan-independent logical operation key`,
  );
  assert(
    branch.executionAttemptKey?.includes("planVersion"),
    `${branch.actionId} needs a plan-bound local execution attempt key`,
  );
  assert(
    branch.providerEffectSafety?.unknownOutcome.includes("manual_repair"),
    `${branch.actionId} needs safe ambiguous-write handling`,
  );
  assert(
    branch.approval?.proposalBindingRequired &&
      Array.isArray(branch.approval.rules),
    `${branch.actionId} needs explicit bound approval rules`,
  );
  assert(
    branch.inputSchema?.type === "object" &&
      branch.outputSchema?.type === "object" &&
      branch.inputSchema.required?.length > 0 &&
      branch.outputSchema.required?.length > 0,
    `${branch.actionId} needs typed input/output schemas`,
  );
  validateSchemaValue(
    branch.inputSchema,
    branch.sampleInput,
    `${branch.actionId}.sampleInput`,
  );
  validateSchemaValue(
    branch.outputSchema,
    branch.sampleOutput,
    `${branch.actionId}.sampleOutput`,
  );
  assert(
    branch.expectedAuthoritativeState?.system &&
      branch.expectedAuthoritativeState?.predicate,
    `${branch.actionId} needs an authoritative completion predicate`,
  );
  assert(
    branch.evidenceLocators?.length > 0,
    `${branch.actionId} needs evidence locators`,
  );
  assert(branch.compensation, `${branch.actionId} needs compensation policy`);
  for (const prerequisite of branch.prerequisites) {
    const dependency = prerequisite.split(":")[0];
    assert(
      branchIds.has(dependency),
      `${branch.actionId} has unknown prerequisite ${dependency}`,
    );
  }
}

const visitState = new Map();
const visit = (actionId) => {
  if (visitState.get(actionId) === "visiting") {
    throw new Error(`Compound plan contains a dependency cycle at ${actionId}`);
  }
  if (visitState.get(actionId) === "done") return;
  visitState.set(actionId, "visiting");
  const branch = plan.branches.find((candidate) => candidate.actionId === actionId);
  for (const prerequisite of branch.prerequisites) {
    visit(prerequisite.split(":")[0]);
  }
  visitState.set(actionId, "done");
};
for (const actionId of branchIds) visit(actionId);

for (const example of plan.applicabilityContract.examples) {
  const required = new Set(example.requiredBranchSet);
  for (const actionId of required) {
    const branch = plan.branches.find(
      (candidate) => candidate.actionId === actionId,
    );
    assert(branch, `${example.id} requires unknown branch ${actionId}`);
    for (const prerequisite of branch.prerequisites) {
      const dependency = prerequisite.split(":")[0];
      assert(
        dependency === "core-profile" || required.has(dependency),
        `${example.id} is not dependency-closed: ${actionId} needs ${dependency}`,
      );
    }
  }
}
const contractorExample = plan.applicabilityContract.examples.find(
  (example) => example.id === "contractor-access-learning-no-hris",
);
assert(
  contractorExample.requiredBranchSet.includes("it-identity-access") &&
    contractorExample.requiredBranchSet.includes("learning-induction") &&
    contractorExample.authoritativeBindings.subjectSource ===
      "authorized-contractor-registry",
  "Contractor access/learning must bind to an authoritative nonemployee identity",
);

const payrollRules = plan.branches.find(
  (branch) => branch.actionId === "payroll-benefits",
).approval.rules;
const bankRule = payrollRules.find(
  (rule) => rule.trigger === "new_or_changed_bank_instructions",
);
assert(
  bankRule.requiredApprovers.allOf.includes("named fraud-control approver") &&
    bankRule.requiredApprovers.allOf.includes("named payroll approver"),
  "Bank changes require both fraud-control and payroll authorities",
);
const accessRules = plan.branches.find(
  (branch) => branch.actionId === "it-identity-access",
).approval.rules;
const privilegedRule = accessRules.find(
  (rule) => rule.trigger === "privileged_access",
);
assert(
  privilegedRule.requiredApprovers.allOf.length === 3 &&
    privilegedRule.nonWaivableDenyOn.includes(
      "segregation_of_duties_conflict",
    ),
  "Privileged access needs manager, application owner, security, and nonwaivable SoD denial",
);

assert(
  plan.branches.find((branch) => branch.actionId === "readiness-join")
    ?.prerequisites.length === 1,
  "Readiness join must consume requiredBranchSet, not hard-code every branch",
);
assert(
  plan.applicabilityContract.derivation.includes("deterministic") &&
    plan.applicabilityContract.allowedDispositions.includes("not_applicable") &&
    plan.applicabilityContract.allowedDispositions.includes("waived"),
  "Applicability must derive a deterministic branch set with distinct dispositions",
);

const requiredExamples = new Set([
  "timeout-after-write",
  "timeout-after-write-no-provider-idempotency",
  "stale-dispatcher-race-no-provider-idempotency",
  "definitive-provider-nonexecution",
  "irrelevant-replan",
  "wrong-role-approval",
  "privileged-access-sod-conflict",
  "contractor-access-learning-no-hris",
  "changed-arguments-after-approval",
]);
const decideDispatchRecovery = ({
  providerIdempotency,
  dispatchMayHaveStarted,
  reconciliation,
}) => {
  if (!dispatchMayHaveStarted) return "redispatch_same_logical_key";
  if (providerIdempotency) return "retry_same_logical_key";
  if (reconciliation === "definitive_nonexecution") {
    return "redispatch_same_logical_key";
  }
  if (reconciliation === "found_effect") return "reuse_confirmed_effect";
  return "unknown_external_effect_manual_repair";
};
const decideScenario = (example) => {
  if (example.kind === "dispatch-recovery") {
    return decideDispatchRecovery(example.input);
  }
  if (example.kind === "replan") {
    return !example.input.materialInputChanged &&
      example.input.priorEffect === "confirmed"
      ? "reuse_confirmed_effect"
      : "new_logical_operation";
  }
  if (example.kind === "approval-binding") {
    return example.input.proposalHashMatches ? "execute" : "reject";
  }
  if (example.kind === "approval") {
    if (example.input.sodConflict) return "reject_nonwaivable";
    if (example.input.trigger === "new_or_changed_bank_instructions") {
      const authorities = new Set(example.input.namedAuthorities);
      return authorities.has("fraud-control approver") &&
        authorities.has("payroll approver")
        ? "approve"
        : "reject";
    }
  }
  if (example.kind === "applicability") {
    const required = new Set(example.requiredBranchSet);
    const closed = [...required].every((actionId) => {
      const branch = plan.branches.find(
        (candidate) => candidate.actionId === actionId,
      );
      return branch.prerequisites.every((prerequisite) => {
        const dependency = prerequisite.split(":")[0];
        return dependency === "core-profile" || required.has(dependency);
      });
    });
    return closed &&
      example.input.subjectSource === "authorized-contractor-registry"
      ? "dependency_closed"
      : "reject_plan";
  }
  throw new Error(`No decision function for scenario ${example.id}`);
};
for (const example of plan.adversarialExamples) {
  requiredExamples.delete(example.id);
  assert(
    decideScenario(example) === example.expectedDecision,
    `${example.id} contract decision did not match ${example.expectedDecision}`,
  );
}
assert(
  requiredExamples.size === 0,
  `Missing adversarial examples: ${[...requiredExamples].join(", ")}`,
);

assert(!report.includes("[@"), "Report contains unresolved citation markers");
assert(report.includes("**58 unsupported"), "Report maturity count is stale");
assert(
  report.includes("**0 integrated reference-intent outcomes**"),
  "Report must not overstate reference-intent integration",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      sources: sources.sources.length,
      referenceIntents: matrix.referenceIntents.length,
      parentIntents: matrix.parentIntents.length,
      candidateGaps: matrix.candidateGaps.length,
      exactSourceLabels: exactLabels.size,
      maturityCounts,
      compoundPlanActions: plan.branches.length,
    },
    null,
    2,
  ),
);