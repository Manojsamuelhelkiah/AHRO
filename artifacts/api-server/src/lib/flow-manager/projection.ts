import { and, desc, eq } from "drizzle-orm";
import { caseFlowTransitions } from "@workspace/db";
import { loadDomainSnapshot, type FlowReadClient } from "./domain-snapshot";
import { readBoundDefinition } from "./manager";
import { evaluateAction } from "./contract";

export const FLOW_NOTICE = "Possible actions describe structural prerequisites only. They do not grant authorization, approve evidence or guarantee dispatch. Domain permissions, current decisions, recipients and effect reconciliation are rechecked when an action is requested.";

/** Read-only: no registration, compatibility migration, continuation or provider work. */
export async function projectCaseFlow(tx: FlowReadClient, organizationId: string, caseId: number, privateProgress: boolean) {
  const snapshot = await loadDomainSnapshot(tx, organizationId, caseId);
  if (!snapshot) return null;
  const { binding, definition } = await readBoundDefinition(tx, organizationId, caseId);
  const mode = snapshot.family === "review-only" ? "review-only" : definition ? "executable" : "compatibility-review";
  const history = privateProgress ? await tx.select().from(caseFlowTransitions).where(and(
    eq(caseFlowTransitions.organizationId, organizationId), eq(caseFlowTransitions.caseId, caseId),
  )).orderBy(desc(caseFlowTransitions.createdAt), desc(caseFlowTransitions.operationKey)).limit(100) : [];
  return {
    caseId, family: snapshot.family, mode,
    compatibilityReason: definition ? "The immutable base-flow identity is pinned. Domain records remain authoritative."
      : snapshot.family === "review-only" ? "This family has no executable domain runtime. Review does not authorize execution."
        : "A compatible executable identity has not been established. Viewing this case does not bind, restart or replay it.",
    definitionId: binding?.definitionId ?? undefined,
    definitionVersion: binding?.definitionVersion ?? undefined,
    definition: definition ?? undefined,
    informationalNotice: FLOW_NOTICE, progressRedacted: !privateProgress,
    stages: definition?.stages.map(stage => {
      const applicable = snapshot.facts[stage.applies];
      const done = snapshot.facts[stage.completed];
      // Entering the parallel-workstream coordinator never completes the
      // underlying tasks. Its dependency milestone is initiation, not release.
      const parallelPending = stage.id === "workstreams" && snapshot.tasks.some(t => !["complete", "completed", "ready", "resolved", "verified"].includes(t.status));
      const blockers = !privateProgress ? ["Current case-field access is required to inspect progress."]
        : !applicable ? [] : stage.prerequisites.filter(id => {
          const prerequisite = definition.stages.find(s => s.id === id)!;
          return snapshot.facts[prerequisite.applies] && !snapshot.facts[prerequisite.completed];
        }).map(id => `Prerequisite stage: ${id}`);
      return { id: stage.id, label: stage.label, role: stage.role, prerequisites: [...stage.prerequisites],
        status: !privateProgress ? "restricted" : stage.id === "closure" ? "unavailable"
          : !applicable ? "not-applicable" : done && !parallelPending ? "complete"
            : parallelPending && done ? "active" : blockers.length ? "waiting" : "available",
        blockers: stage.id === "closure" && privateProgress ? ["Final separation closure is not supported."] : blockers };
    }) ?? [],
    actions: definition?.actions.map(action => {
      const evaluation = evaluateAction(definition, action.id, snapshot.facts);
      return { id: action.id, stage: action.stage, handler: action.handler,
        eligible: privateProgress && evaluation.eligible,
        blockers: privateProgress ? [...evaluation.blockers] : ["Current case-field access is required."],
        requiredAuthority: [...evaluation.authority], requiredEvidence: [...evaluation.evidence] };
    }) ?? [],
    tasks: privateProgress && definition ? snapshot.tasks.map(t => ({ ...t, prerequisites: [...t.prerequisites], blockers: [...t.blockers] })) : [],
    history: history.map(t => ({ actionId: t.actionId, outcome: t.outcome, reason: t.reason,
      definitionId: t.definitionId, definitionVersion: t.definitionVersion, occurredAt: t.createdAt.toISOString() })),
  };
}
