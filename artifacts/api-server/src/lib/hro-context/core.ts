import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

export const HRO_WORKFLOWS = [
  "onboarding", "standard-intake", "documents", "communications", "readiness",
  "early-tenure", "frontline", "workforce-transfer", "governance", "hr-policy",
  "privacy-lifecycle", "demo", "uat", "agent", "organization",
] as const;
export type HroWorkflow = typeof HRO_WORKFLOWS[number];
export type HroSubjectType = "tenant" | "case" | "transfer-program";
export const HRO_CONTEXT_STEP_CODES = [
  "scope-bound", "checkpoint-recorded", "effect-bound", "provider-boundary",
  "ai-budget-approved", "ai-budget-denied", "agent-authorized", "approval-observed",
] as const;
export type HroContextStepCode = typeof HRO_CONTEXT_STEP_CODES[number];

export type HroContextSeed = {
  organizationId: string;
  workflow: HroWorkflow;
  subjectType: HroSubjectType;
  subjectId: string;
  /** Only authenticated, server-resolved identity. Never deserialize a seed from a request. */
  initiatingUserId?: string;
  executor?: { type: "agent"; id: string; version: number } | { type: "system" | "human" };
};
export type HroContextFrame = Readonly<{
  id: string; anchorId: string; organizationId: string; workflow: HroWorkflow;
  subjectType: HroSubjectType; subjectHash: string;
  parentTransactionId: string | null; correlationId: string;
  initiatorType: "human" | "system"; initiatingUserId: string | null;
  executorType: "human" | "system" | "agent"; agentId: string | null; agentVersion: number | null;
}>;
type Slot = { frame: HroContextFrame; active: boolean };
const storage = new AsyncLocalStorage<Slot | undefined>();

export function currentHroContext(): HroContextFrame | null {
  const slot = storage.getStore();
  return slot?.active ? slot.frame : null;
}

/** Tick callbacks must never borrow the heartbeat caller's client or human identity. */
export function withoutHroContext<T>(action: () => T): T {
  return storage.run(undefined, action);
}

export function opaqueContextReference(organizationId: string, kind: string, value: string): string {
  return createHash("sha256").update(JSON.stringify([organizationId, kind, value])).digest("hex");
}

export function makeHroContextFrame(seed: HroContextSeed, anchorId: string): HroContextFrame {
  if (!seed.organizationId || !seed.subjectId || !HRO_WORKFLOWS.includes(seed.workflow) ||
      !["tenant", "case", "transfer-program"].includes(seed.subjectType)) {
    throw new Error("HRO_CONTEXT_INVALID_SCOPE");
  }
  const parent = currentHroContext();
  if (parent && parent.organizationId !== seed.organizationId) {
    // Explicit detachment is required at a multi-tenant scan boundary.
    throw new Error("HRO_CONTEXT_TENANT_MISMATCH");
  }
  if (seed.initiatingUserId && parent?.initiatingUserId &&
      seed.initiatingUserId !== parent.initiatingUserId) {
    throw new Error("HRO_CONTEXT_ACTOR_MISMATCH");
  }
  const initiatingUserId = seed.initiatingUserId ?? parent?.initiatingUserId ?? null;
  const executor = seed.executor ?? (parent?.executorType === "agent"
    ? { type: "agent" as const, id: parent.agentId!, version: parent.agentVersion! }
    : { type: initiatingUserId ? "human" as const : "system" as const });
  if (!["human", "system", "agent"].includes(executor.type) ||
      (executor.type === "human" && !initiatingUserId)) throw new Error("HRO_CONTEXT_INVALID_EXECUTOR");
  if (executor.type === "agent" && (!executor.id || !Number.isSafeInteger(executor.version) || executor.version < 1)) {
    throw new Error("HRO_CONTEXT_INVALID_AGENT");
  }
  return Object.freeze({
    id: randomUUID(), anchorId, organizationId: seed.organizationId,
    workflow: seed.workflow, subjectType: seed.subjectType,
    subjectHash: opaqueContextReference(seed.organizationId, seed.subjectType, seed.subjectId),
    parentTransactionId: parent?.id ?? null,
    correlationId: parent?.correlationId ?? randomUUID(),
    initiatorType: initiatingUserId ? "human" : "system",
    initiatingUserId, executorType: executor.type,
    agentId: executor.type === "agent" ? executor.id : null,
    agentVersion: executor.type === "agent" ? executor.version : null,
  });
}

export async function runInHroContext<T>(frame: HroContextFrame, action: () => Promise<T>): Promise<T> {
  const slot: Slot = { frame, active: true };
  try {
    return await storage.run(slot, action);
  } finally {
    // A fire-and-forget callback can inherit ALS after the operation finishes.
    // It must open a fresh attempt, not mutate this closed attempt.
    slot.active = false;
  }
}

export function workflowForHroPath(path: string): HroWorkflow | null {
  if (path.startsWith("/agent-invocations")) return "agent";
  if (path.startsWith("/organizations")) return "organization";
  if (path.startsWith("/policies") || path.startsWith("/hr-policies") || path.startsWith("/policy-assistant")) return "hr-policy";
  if (path.startsWith("/governance") || path.startsWith("/action-center")) return "governance";
  if (path.startsWith("/privacy/")) return "privacy-lifecycle";
  if (!path.startsWith("/onboarding")) return null;
  if (path.includes("/governance") || path.includes("/action-center")) return "governance";
  if (path.includes("/workforce-transfers")) return "workforce-transfer";
  if (path.includes("/frontline")) return "frontline";
  if (path.includes("/early-tenure") || path.includes("/probation")) return "early-tenure";
  if (path.includes("/demo-") || path.includes("/demo-controller")) return "demo";
  if (path.includes("/uat")) return "uat";
  if (path.includes("/standard-intake") || path.includes("/intake-batches")) return "standard-intake";
  if (path.includes("/documents") || path.includes("/document-")) return "documents";
  if (path.includes("/readiness") || path.includes("/sla")) return "readiness";
  if (path.includes("/contact") || path.includes("/communications")) return "communications";
  return "onboarding";
}
