import coverage from "../../../../research/intent-agent-coverage.json";
import { intents } from "../data/intents";
import type { CustomIntentRow } from "@workspace/db";

export const INTENT_REGISTRY_VERSION = coverage.taxonomyVersion;

export type RiskClass = "low" | "medium" | "high" | "consequential";
export type RegistryMaturity =
  | "catalogued"
  | "simulated"
  | "integrated"
  | "verified"
  | "unsupported";
export type RegistrySource = "reference" | "custom";

export interface RegisteredAction {
  type: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executorKey: string | null;
}

export interface IntentRoute {
  registryVersion: string;
  key: string;
  canonicalOutcome: string;
  parentIntentKey: string | null;
  exactAliases: string[];
  accountableSpecialist: string;
  riskClass: RiskClass;
  actionSchema: { actions: RegisteredAction[] };
  evidenceContract: {
    completionEvidence: string;
    required: string[];
  };
  maturity: RegistryMaturity;
  source: RegistrySource;
  status: "active" | "retired";
  routable: boolean;
}

export interface ExecutorRegistration {
  key: string;
  kind: "workflow" | "typed-tool";
  owner: string;
  maximumMaturity: "simulated" | "integrated" | "verified";
}

const EXECUTORS: Readonly<Record<string, ExecutorRegistration>> = Object.freeze({
  "onboarding-case-workflow": {
    key: "onboarding-case-workflow",
    kind: "workflow",
    owner: "Onboarding Coordinator",
    maximumMaturity: "simulated",
  },
  "background-verification-workflow": {
    key: "background-verification-workflow",
    kind: "workflow",
    owner: "BGV Specialist",
    maximumMaturity: "simulated",
  },
});

export function getRegisteredExecutor(key: string): ExecutorRegistration | undefined {
  return EXECUTORS[key];
}

type CoverageIntent = (typeof coverage.referenceIntents)[number];

function inferRisk(row: CoverageIntent): RiskClass {
  if (row.flowClass === "fc4-frontier") return "consequential";
  if (row.flowClass === "fc3-multiagent" || row.tags.some((tag) => ["legal", "sensitive", "financial", "fraud-sensitive"].includes(tag))) {
    return "high";
  }
  return row.flowClass === "fc2-policy" ? "medium" : "low";
}

function executorFor(key: string): string | null {
  if (key === "new-hire-setup") return "onboarding-case-workflow";
  if (key === "background-check-chase") return "background-verification-workflow";
  return null;
}

function exactAliasesFor(key: string, row: CoverageIntent): string[] {
  const provenanceAliases = row.provenance.sourceEdges
    .filter((edge) => edge.relation === "exact-label" && edge.externalLabel)
    .map((edge) => edge.externalLabel as string);
  const approvedExamples = coverage.aliasExamples
    .filter((alias) => alias.relation === "exact-label" && alias.mapsTo.length === 1 && alias.mapsTo[0] === key)
    .map((alias) => alias.externalLabel);
  return [...new Set([...provenanceAliases, ...approvedExamples])].sort();
}

function referenceRoute(row: CoverageIntent): IntentRoute {
  const executorKey = executorFor(row.key);
  const maturity = row.coverage.referenceIntentExecution as RegistryMaturity;
  const actionExecutor = maturity === "simulated" ? executorKey : null;
  return {
    registryVersion: INTENT_REGISTRY_VERSION,
    key: row.key,
    canonicalOutcome: row.name,
    parentIntentKey: row.taxonomy.parentIntentKey,
    exactAliases: exactAliasesFor(row.key, row),
    accountableSpecialist: row.responsibility.accountableSpecialist,
    riskClass: inferRisk(row),
    actionSchema: {
      actions: row.actions.map((action) => ({
        ...action,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["requestId", "subjectId"],
          properties: {
            requestId: { type: "string", minLength: 1 },
            subjectId: { type: "string", minLength: 1 },
          },
        },
        executorKey: actionExecutor,
      })),
    },
    evidenceContract: {
      completionEvidence: row.completionEvidence,
      required: ["authoritativeSourceState", "policyVersion", "actor", "recordedAt"],
    },
    maturity,
    source: "reference",
    status: "active",
    routable: Boolean(actionExecutor),
  };
}

function safeJsonObject(value: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : fallback;
  } catch {
    return fallback;
  }
}

function customRoute(row: CustomIntentRow): IntentRoute {
  const rawActionSchema = safeJsonObject(row.actionSchema, { actions: [] });
  const actions = Array.isArray(rawActionSchema.actions)
    ? rawActionSchema.actions.filter((action): action is RegisteredAction =>
        typeof action === "object" && action !== null && typeof (action as { name?: unknown }).name === "string")
    : [];
  const evidence = safeJsonObject(row.evidenceContract, { required: [] });
  return {
    registryVersion: row.registryVersion,
    key: row.key,
    canonicalOutcome: row.name,
    parentIntentKey: row.parentIntentKey,
    exactAliases: JSON.parse(row.exactAliases) as string[],
    accountableSpecialist: row.accountableSpecialist,
    riskClass: row.riskClass as RiskClass,
    actionSchema: { actions },
    evidenceContract: {
      completionEvidence: typeof evidence.completionEvidence === "string" ? evidence.completionEvidence : row.description,
      required: Array.isArray(evidence.required) ? evidence.required.filter((item): item is string => typeof item === "string") : [],
    },
    maturity: row.maturity as RegistryMaturity,
    source: "custom",
    status: row.status as "active" | "retired",
    routable: row.status === "active"
      && ["simulated", "integrated", "verified"].includes(row.maturity)
      && actions.length > 0
      && actions.every((action) => Boolean(action.executorKey && EXECUTORS[action.executorKey])),
  };
}

export function validateCustomRoutingMetadata(input: {
  accountableSpecialist: string;
  riskClass: string;
  maturity: string;
  exactAliases: unknown;
  actionSchema: unknown;
  evidenceContract: unknown;
}): void {
  if (!input.accountableSpecialist.trim()) throw new Error("accountableSpecialist must be a non-empty string");
  if (!["low", "medium", "high", "consequential"].includes(input.riskClass)) {
    throw new Error("riskClass must be one of: low, medium, high, consequential");
  }
  if (!["catalogued", "simulated", "integrated", "verified", "unsupported"].includes(input.maturity)) {
    throw new Error("maturity must be one of: catalogued, simulated, integrated, verified, unsupported");
  }
  if (!Array.isArray(input.exactAliases) || input.exactAliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
    throw new Error("exactAliases must be an array of non-empty strings");
  }
  if (new Set(input.exactAliases).size !== input.exactAliases.length) {
    throw new Error("exactAliases must not contain duplicates");
  }
  if (typeof input.actionSchema !== "object" || input.actionSchema === null || Array.isArray(input.actionSchema)) {
    throw new Error("actionSchema must be an object");
  }
  const actions = (input.actionSchema as { actions?: unknown }).actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("actionSchema.actions must contain at least one typed action");
  }
  for (const action of actions) {
    if (typeof action !== "object" || action === null || Array.isArray(action)) {
      throw new Error("Every action must be an object");
    }
    const candidate = action as Partial<RegisteredAction>;
    if (!candidate.type?.trim() || !candidate.name?.trim() || !candidate.description?.trim()) {
      throw new Error("Every action requires type, name, and description");
    }
    if (typeof candidate.inputSchema !== "object" || candidate.inputSchema === null || Array.isArray(candidate.inputSchema)) {
      throw new Error(`Action ${candidate.name} requires an inputSchema object`);
    }
    if (candidate.executorKey !== null && typeof candidate.executorKey !== "string") {
      throw new Error(`Action ${candidate.name} executorKey must be a string or null`);
    }
    if (candidate.executorKey) {
      const executor = EXECUTORS[candidate.executorKey];
      if (!executor) throw new Error(`Action ${candidate.name} references an unregistered executor`);
      if (executor.owner !== input.accountableSpecialist) {
        throw new Error(`Action ${candidate.name} executor is owned by ${executor.owner}, not ${input.accountableSpecialist}`);
      }
      const maturityRank: Record<string, number> = {
        catalogued: 0,
        unsupported: 0,
        simulated: 1,
        integrated: 2,
        verified: 3,
      };
      if (maturityRank[input.maturity]! > maturityRank[executor.maximumMaturity]!) {
        throw new Error(`Action ${candidate.name} executor is only proven to ${executor.maximumMaturity} maturity`);
      }
    }
  }
  if (typeof input.evidenceContract !== "object" || input.evidenceContract === null || Array.isArray(input.evidenceContract)) {
    throw new Error("evidenceContract must be an object");
  }
  const required = (input.evidenceContract as { required?: unknown }).required;
  if (!Array.isArray(required) || required.length === 0 || required.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("evidenceContract.required must contain at least one evidence field");
  }
  const executable = actions.every((action) => Boolean((action as RegisteredAction).executorKey));
  if (["simulated", "integrated", "verified"].includes(input.maturity) && !executable) {
    throw new Error(`${input.maturity} outcomes require a registered executor for every action`);
  }
  if (input.maturity === "unsupported" && executable) {
    throw new Error("unsupported outcomes cannot declare executable actions");
  }
}

export class IntentResolutionError extends Error {
  constructor(
    public readonly code: "UNKNOWN_OUTCOME" | "RETIRED_OUTCOME" | "AMBIGUOUS_ALIAS" | "UNSUPPORTED_OUTCOME" | "REGISTRY_VERSION_MISMATCH",
    message: string,
    public readonly repair: { required: true; suppliedKey: string; registryVersion: string },
  ) {
    super(message);
    this.name = "IntentResolutionError";
  }
}

export function buildIntentRegistry(customRows: CustomIntentRow[] = []) {
  const reference = coverage.referenceIntents.map(referenceRoute);
  const custom = customRows
    .filter((row) => row.registryVersion === INTENT_REGISTRY_VERSION)
    .map(customRoute);
  const staleCustom = customRows
    .filter((row) => row.registryVersion !== INTENT_REGISTRY_VERSION)
    .map(customRoute);
  const routes = [...reference, ...custom];
  const aliases = new Map<string, IntentRoute[]>();
  for (const route of routes) {
    for (const label of [route.key, ...route.exactAliases]) {
      aliases.set(label, [...(aliases.get(label) ?? []), route]);
    }
  }

  return {
    version: INTENT_REGISTRY_VERSION,
    executors: Object.values(EXECUTORS),
    reference,
    custom,
    parents: coverage.parentIntents,
    candidates: coverage.candidateGaps,
    counts: {
      reference: reference.length,
      activeCustom: custom.filter((route) => route.status === "active").length,
      retiredCustom: custom.filter((route) => route.status === "retired").length,
      staleCustom: staleCustom.length,
      groupingParents: coverage.parentIntents.length,
      candidateGaps: coverage.candidateGaps.length,
      routable: routes.filter((route) => route.routable).length,
    },
    resolve(suppliedKey: string, requestedVersion = INTENT_REGISTRY_VERSION): IntentRoute {
      const repair = { required: true as const, suppliedKey, registryVersion: INTENT_REGISTRY_VERSION };
      if (requestedVersion !== INTENT_REGISTRY_VERSION) {
        throw new IntentResolutionError("REGISTRY_VERSION_MISMATCH", `Registry version ${requestedVersion} is not available`, repair);
      }
      const matches = aliases.get(suppliedKey) ?? [];
      const staleMatches = staleCustom.filter((route) => route.key === suppliedKey || route.exactAliases.includes(suppliedKey));
      if (matches.length === 0 && staleMatches.length > 0) {
        throw new IntentResolutionError("REGISTRY_VERSION_MISMATCH", `Outcome belongs to a retired registry version: ${suppliedKey}`, repair);
      }
      if (matches.length === 0) throw new IntentResolutionError("UNKNOWN_OUTCOME", `Unknown outcome: ${suppliedKey}`, repair);
      if (matches.length > 1) throw new IntentResolutionError("AMBIGUOUS_ALIAS", `Alias resolves to multiple outcomes: ${suppliedKey}`, repair);
      const route = matches[0]!;
      if (route.status === "retired") throw new IntentResolutionError("RETIRED_OUTCOME", `Outcome is retired: ${route.key}`, repair);
      if (!route.routable) throw new IntentResolutionError("UNSUPPORTED_OUTCOME", `Outcome has no registered executable route: ${route.key}`, repair);
      return route;
    },
  };
}

export function assertRegistryReconciled(): void {
  const registry = buildIntentRegistry();
  if (registry.reference.length !== intents.length || registry.reference.length !== coverage.counts.referenceSubIntents) {
    throw new Error("Reference registry and cost-model corpus counts do not reconcile");
  }
  const referenceKeys = new Set(intents.map((intent) => intent.key));
  for (const route of registry.reference) {
    if (!referenceKeys.has(route.key)) throw new Error(`Registry outcome is absent from cost model: ${route.key}`);
    if (!route.parentIntentKey || !route.accountableSpecialist) throw new Error(`Registry outcome lacks accountability: ${route.key}`);
    for (const action of route.actionSchema.actions) {
      if (route.routable && (!action.executorKey || !EXECUTORS[action.executorKey])) {
        throw new Error(`Routable action lacks a registered executor: ${route.key}/${action.name}`);
      }
    }
  }
}

assertRegistryReconciled();