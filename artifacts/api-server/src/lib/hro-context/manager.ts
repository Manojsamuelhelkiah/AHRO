import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, hroContextAnchors, hroContextSteps, hroContextTransactions } from "@workspace/db";
import {
  currentHroContext, makeHroContextFrame, opaqueContextReference, runInHroContext,
  HRO_CONTEXT_STEP_CODES, type HroContextFrame, type HroContextSeed, type HroContextStepCode, type HroWorkflow,
} from "./core";
import { checkHroAiBudget } from "./ai-budget";

export async function openHroContext(seed: HroContextSeed): Promise<HroContextFrame> {
  // Validate parent boundaries before doing any persistence.
  const proposed = makeHroContextFrame(seed, randomUUID());
  return db.transaction(async (tx) => {
    await tx.insert(hroContextAnchors).values({
      id: proposed.anchorId, organizationId: proposed.organizationId,
      subjectType: proposed.subjectType, subjectHash: proposed.subjectHash,
    }).onConflictDoNothing();
    const [anchor] = await tx.select({ id: hroContextAnchors.id }).from(hroContextAnchors).where(and(
      eq(hroContextAnchors.organizationId, proposed.organizationId),
      eq(hroContextAnchors.subjectType, proposed.subjectType),
      eq(hroContextAnchors.subjectHash, proposed.subjectHash),
    ));
    if (!anchor) throw new Error("HRO_CONTEXT_ANCHOR_UNAVAILABLE");
    const frame = Object.freeze({ ...proposed, anchorId: anchor.id });
    const { subjectType: _type, subjectHash: _hash, ...record } = frame;
    await tx.insert(hroContextTransactions).values(record);
    await tx.insert(hroContextSteps).values({
      organizationId: frame.organizationId, transactionId: frame.id, code: "scope-bound", metrics: {},
    });
    return frame;
  });
}

export async function closeHroContext(frame: HroContextFrame, status: "completed" | "failed"): Promise<void> {
  await db.update(hroContextTransactions).set({
    status, finishedAt: new Date(), updatedAt: new Date(),
    version: sql`${hroContextTransactions.version} + 1`,
  }).where(and(
    eq(hroContextTransactions.organizationId, frame.organizationId),
    eq(hroContextTransactions.id, frame.id),
    eq(hroContextTransactions.status, "running"),
  ));
}

export async function withHroContext<T>(seed: HroContextSeed, action: () => Promise<T>): Promise<T> {
  const current = currentHroContext();
  const subjectHash = opaqueContextReference(seed.organizationId, seed.subjectType, seed.subjectId);
  if (current?.organizationId === seed.organizationId && current.subjectHash === subjectHash &&
      current.subjectType === seed.subjectType && current.workflow === seed.workflow &&
      !seed.executor && (!seed.initiatingUserId || seed.initiatingUserId === current.initiatingUserId)) {
    return action();
  }
  const frame = await openHroContext(seed);
  return runInHroContext(frame, async () => {
    try {
      const result = await action();
      await closeHroContext(frame, "completed");
      return result;
    } catch (error) {
      try { await closeHroContext(frame, "failed"); }
      catch (finalizationError) { throw new AggregateError([error, finalizationError], "HRO_CONTEXT_EXECUTION_AND_FINALIZATION_FAILED"); }
      throw error;
    }
  });
}

export function withHroOrganizationContext<T>(organizationId: string, action: () => Promise<T>) {
  const current = currentHroContext();
  if (current?.organizationId === organizationId) return action();
  return withHroContext({ organizationId, workflow: "privacy-lifecycle", subjectType: "tenant", subjectId: organizationId }, action);
}

/** The caller must have resolved the record through an existing authorized boundary. */
export function withHroCaseContext<T>(
  record: { id: number; organizationId: string }, action: () => Promise<T>, workflow?: HroWorkflow,
) {
  return withHroContext({
    organizationId: record.organizationId, subjectType: "case", subjectId: String(record.id),
    workflow: workflow ?? currentHroContext()?.workflow ?? "onboarding",
  }, action);
}

/** Validate the exact payload sent to the provider, never a separate approximate prompt. */
export async function dispatchHroAi<T, R extends {
  messages: readonly { content?: unknown }[]; max_completion_tokens?: number | null;
}>(request: R, dispatch: (request: R) => Promise<T>): Promise<T> {
  await approveHroAiContext(request.messages, request.max_completion_tokens ?? 0);
  return dispatch(request);
}

/** Only fixed codes, numeric budget metadata and hashed links can enter history. */
export async function recordHroContextStep(
  code: HroContextStepCode,
  options: { reference?: string; metrics?: { inputBytes?: number; outputTokens?: number } } = {},
): Promise<void> {
  const frame = currentHroContext();
  if (!frame) throw new Error("HRO_CONTEXT_REQUIRED");
  if (!HRO_CONTEXT_STEP_CODES.includes(code)) throw new Error("HRO_CONTEXT_INVALID_STEP");
  const metrics: { inputBytes?: number; outputTokens?: number } = {};
  for (const key of ["inputBytes", "outputTokens"] as const) {
    const value = options.metrics?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("HRO_CONTEXT_INVALID_METRIC");
      metrics[key] = value;
    }
  }
  await db.transaction(async (tx) => {
    const [running] = await tx.update(hroContextTransactions).set({
      updatedAt: new Date(), version: sql`${hroContextTransactions.version} + 1`,
    }).where(and(
      eq(hroContextTransactions.organizationId, frame.organizationId),
      eq(hroContextTransactions.id, frame.id),
      eq(hroContextTransactions.status, "running"),
    )).returning({ id: hroContextTransactions.id });
    if (!running) throw new Error("HRO_CONTEXT_ALREADY_CLOSED");
    await tx.insert(hroContextSteps).values({
      organizationId: frame.organizationId, transactionId: frame.id, code, metrics,
      referenceHash: options.reference === undefined ? null :
        opaqueContextReference(frame.organizationId, code, options.reference),
    });
  });
}

export async function approveHroAiContext(messages: readonly { content?: unknown }[], outputTokens: number) {
  if (!currentHroContext()) throw new Error("HRO_CONTEXT_REQUIRED");
  try {
    const metrics = checkHroAiBudget(messages, outputTokens);
    await recordHroContextStep("ai-budget-approved", { metrics });
    return metrics;
  } catch (error) {
    await recordHroContextStep("ai-budget-denied");
    throw error;
  }
}
