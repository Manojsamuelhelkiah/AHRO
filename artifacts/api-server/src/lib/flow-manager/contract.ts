/**
 * Executable base-flow vocabulary. Conditions and handlers are closed server
 * registries, not expressions, policy text, model output or uploaded code.
 * Domain services still own authorization, source evidence and dispatch.
 */
export const CONDITIONS = [
  "always", "admission-pending", "offer-required", "offer-released", "intake-released", "plan-released",
  "workstreams-entered", "communications-recorded", "readiness-review",
  "screened", "classified", "policy-planned", "restricted", "closure-unavailable",
] as const;
export type Condition = typeof CONDITIONS[number];
export const HANDLERS = [
  "onboarding.offer", "onboarding.intake", "onboarding.plan",
  "onboarding.workstreams", "onboarding.communications", "onboarding.review",
  "onboarding.readiness", "onboarding.reconcile", "onboarding.connector",
  "onboarding.workforce", "onboarding.notification",
  "separation.screen", "separation.classify", "separation.plan",
  "separation.task", "separation.exchange", "separation.reconcile",
] as const;
export type Handler = typeof HANDLERS[number];
export const CONTINUATION_HANDLERS = [
  "onboarding.plan", "onboarding.workstreams", "onboarding.connector",
  "onboarding.communications", "onboarding.review",
] as const satisfies readonly Handler[];
export type ContinuationHandler = typeof CONTINUATION_HANDLERS[number];
export type FlowFamily = "onboarding" | "separation";
export type Stage = {
  id: string;
  label: string;
  role: string;
  applies: Condition;
  prerequisites: readonly string[];
  /** A domain-owned fact, never a manager-maintained stage status. */
  completed: Condition;
};
export type Action = {
  id: string;
  stage: string;
  handler: Handler;
  requires: readonly Condition[];
  authority: readonly string[];
  evidence: readonly string[];
  /** Explicitly declared review/rework edges do not participate in the DAG. */
  reworkTo?: string;
};
export type Definition = {
  id: string;
  version: number;
  family: FlowFamily;
  stages: readonly Stage[];
  actions: readonly Action[];
  continuations?: Readonly<Record<string, readonly string[]>>;
};
export type Facts = Readonly<Record<Condition, boolean>>;
export type Evaluation = {
  actionId: string;
  handler: Handler;
  eligible: boolean;
  blockers: string[];
  authority: readonly string[];
  evidence: readonly string[];
};

const identifier = /^[a-z][a-z0-9.-]{0,95}$/;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Validate on registration, not when an operator first reaches a branch. */
export function defineFlow(input: Definition): Readonly<Definition> {
  const definition = structuredClone(input);
  if (!identifier.test(definition.id) ||
    !Number.isSafeInteger(definition.version) || definition.version < 1 ||
    !["onboarding", "separation"].includes(definition.family) ||
    !definition.stages.length || !definition.actions.length) {
    throw new Error("Invalid executable flow identity");
  }
  const stages = new Map(definition.stages.map(stage => [stage.id, stage]));
  const actions = new Set(definition.actions.map(action => action.id));
  if (stages.size !== definition.stages.length || actions.size !== definition.actions.length) {
    throw new Error("Duplicate executable flow identifier");
  }
  const condition = (id: Condition) => {
    if (!CONDITIONS.includes(id)) throw new Error(`Unsupported deterministic condition: ${id}`);
  };
  for (const stage of definition.stages) {
    if (!identifier.test(stage.id) || !stage.label.trim() || !stage.role.trim()) {
      throw new Error("Invalid executable stage");
    }
    condition(stage.applies);
    condition(stage.completed);
    if (new Set(stage.prerequisites).size !== stage.prerequisites.length ||
      stage.prerequisites.some(id => !stages.has(id) || id === stage.id)) {
      throw new Error("Dangling, self or duplicate stage prerequisite");
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("Executable prerequisites contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    stages.get(id)!.prerequisites.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  stages.forEach(stage => visit(stage.id));
  for (const action of definition.actions) {
    if (!identifier.test(action.id) || !stages.has(action.stage) ||
      !HANDLERS.includes(action.handler) || !action.handler.startsWith(`${definition.family}.`) ||
      (action.reworkTo !== undefined && !stages.has(action.reworkTo)) ||
      !action.authority.length || !action.evidence.length) {
      throw new Error("Invalid executable action or unregistered handler");
    }
    action.requires.forEach(condition);
  }
  for (const [checkpoint, sequence] of Object.entries(definition.continuations ?? {})) {
    if (!checkpoint || !sequence.length || new Set(sequence).size !== sequence.length ||
      sequence.some(id => !actions.has(id))) throw new Error("Invalid registered continuation");
    if (sequence.some(id => !CONTINUATION_HANDLERS.includes(
      definition.actions.find(action => action.id === id)!.handler as ContinuationHandler,
    ))) {
      throw new Error("Unsupported executable continuation handler");
    }
  }
  return deepFreeze(definition);
}

/**
 * Used by both mutation guards and read projections. Eligibility only explains
 * structural conditions. It cannot promise current permission, evidence or
 * recipient authorization, which each domain must recheck in its own fence.
 */
export function evaluateAction(definition: Definition, actionId: string, facts: Facts): Evaluation {
  const action = definition.actions.find(action => action.id === actionId);
  if (!action) throw new Error(`Action is not registered in the bound definition: ${actionId}`);
  const stage = definition.stages.find(stage => stage.id === action.stage)!;
  const blockers: string[] = [];
  if (!facts[stage.applies]) blockers.push(`Branch does not apply: ${stage.applies}`);
  for (const required of action.requires) {
    if (!facts[required]) {
      const explanations: Partial<Record<Condition, string>> = {
        "offer-released": "Offer acceptance has not been released",
        "intake-released": "The intake review is not released",
        "plan-released": "The onboarding plan is not released",
        "communications-recorded": "The communication stage has not reached its recorded checkpoint",
        screened: "Separation screening has not been confirmed",
        classified: "Separation classification has not been confirmed",
        "policy-planned": "Work is held, paused, cancelled, obsolete or missing its approved-policy plan",
      };
      blockers.push(`Required domain condition: ${required}. ${explanations[required] ?? "The registered prerequisite has not been met"}`);
    }
  }
  // Rework has its own explicit requirements. Do not demand completion of
  // downstream stages before allowing a review to invalidate/reopen them.
  if (!action.reworkTo) for (const id of stage.prerequisites) {
    const dependency = definition.stages.find(stage => stage.id === id)!;
    if (facts[dependency.applies] && !facts[dependency.completed]) {
      blockers.push(`Prerequisite: ${dependency.label}`);
    }
  }
  return {
    actionId, handler: action.handler, eligible: blockers.length === 0,
    blockers, authority: action.authority, evidence: action.evidence,
  };
}
