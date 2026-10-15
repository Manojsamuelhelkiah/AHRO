import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db, caseFlowBindings, caseFlowDefinitions, caseFlowTransitions,
  onbCases,
} from "@workspace/db";
import type { OnboardingDbTransaction } from "../onboarding/settings";
import { isHistoricalTestRecord } from "../onboarding/historical-test-record";
import { evaluateAction, type Definition, type FlowFamily } from "./contract";
import { DEFINITIONS, admissionDefinition, legacyBaselineDefinition, definitionDigest, registeredDefinition } from "./definitions";
import { loadDomainSnapshot, type DomainSnapshot, type FlowReadClient } from "./domain-snapshot";
import { currentHroContext } from "../hro-context/core";
import { FlowTransitionError } from "./errors";
export { FlowTransitionError } from "./errors";

type Tx = OnboardingDbTransaction;

/** Register only checked-in immutable definitions. Existing bytes must match. */
export async function registerDefinitionsInTransaction(tx: Tx): Promise<void> {
  for (const definition of DEFINITIONS) {
    const digest = definitionDigest(definition);
    await tx.insert(caseFlowDefinitions).values({
      id: definition.id, version: definition.version, family: definition.family, digest,
      definition: definition as unknown as Record<string, unknown>,
    }).onConflictDoNothing();
    const [stored] = await tx.select().from(caseFlowDefinitions).where(and(
      eq(caseFlowDefinitions.id, definition.id), eq(caseFlowDefinitions.version, definition.version),
    ));
    if (!stored || stored.digest !== digest ||
      definitionDigest(stored.definition as unknown as Definition) !== digest) {
      throw new FlowTransitionError("immutable_definition_mismatch");
    }
  }
}

/**
 * Admission only, after the domain parent/child rows exist, in their existing
 * transaction. Calling this never starts work, changes evidence or dispatches.
 */
export async function bindNewCaseInTransaction(tx: Tx, organizationId: string, caseId: number,
  family: FlowFamily): Promise<void> {
  const snapshot = await loadDomainSnapshot(tx, organizationId, caseId);
  if (snapshot?.family !== family) throw new FlowTransitionError("case_family_mismatch");
  await registerDefinitionsInTransaction(tx);
  const definition = admissionDefinition(family);
  await tx.insert(caseFlowBindings).values({
    organizationId, caseId, definitionId: definition.id, definitionVersion: definition.version,
    compatibility: "bound", reason: "Bound at domain admission; all domain gates remain required.",
  }).onConflictDoNothing();
  const [binding] = await tx.select().from(caseFlowBindings).where(and(
    eq(caseFlowBindings.organizationId, organizationId), eq(caseFlowBindings.caseId, caseId),
  ));
  if (!binding || binding.definitionId !== definition.id || binding.definitionVersion !== definition.version ||
    binding.compatibility !== "bound") throw new FlowTransitionError("existing_binding_cannot_be_replaced");
}

/**
 * Conservative legacy assessment. No stage completion is written. An unknown
 * checkpoint, retired fixture, partial separation envelope or unresolved
 * compatibility hold cannot gain authority from a read or provider callback.
 */
export function legacyCompatibility(c: typeof onbCases.$inferSelect, snapshot: DomainSnapshot): {
  compatible: boolean; reason: string;
} {
  if (snapshot.family === "review-only") return { compatible: false, reason: "Family is review-only; no executable runtime." };
  if (isHistoricalTestRecord(c)) return { compatible: false, reason: "Historical record retains its operational restrictions." };
  if (snapshot.family === "separation") {
    return { compatible: c.hireType === "separation",
      reason: "Dedicated separation records remain authoritative; final closure unavailable." };
  }
  const known = new Set([
    "initial", "plan", "intake-approved", "plan-approved", "waiting:intake", "waiting:plan",
    "waiting:offer-acceptance", "waiting:day1-readiness", "waiting:standard-operations-release",
    "blocked:before-workstreams", "blocked:before-employee-communications",
    "blocked:before-day1-review", "blocked:re-review", "workstreams-complete",
    "communications-complete", "review-complete",
  ]);
  const compatible = (c.orchestrationCheckpoint === null
    ? (c.orchestrationStatus === "idle" && c.lifecycleStage === "trigger-received") || snapshot.legacyContinuationSupported === true
    : known.has(c.orchestrationCheckpoint)) &&
    (!snapshot.facts["offer-required"] || snapshot.facts["offer-released"] ||
      ["initial", "waiting:offer-acceptance"].includes(c.orchestrationCheckpoint ?? "initial"));
  return { compatible, reason: compatible
    ? "Known domain recovery boundary; existing evidence and decisions were not reinterpreted."
    : "Unknown or inconsistent legacy recovery boundary requires review; no new work is authorized." };
}

export async function readBoundDefinition(tx: FlowReadClient, organizationId: string, caseId: number) {
  const [binding] = await tx.select().from(caseFlowBindings).where(and(
    eq(caseFlowBindings.organizationId, organizationId), eq(caseFlowBindings.caseId, caseId),
  ));
  if (!binding || binding.compatibility !== "bound" || !binding.definitionId || !binding.definitionVersion) {
    return { binding, definition: null };
  }
  const definition = registeredDefinition(binding.definitionId, binding.definitionVersion);
  const [stored] = await tx.select().from(caseFlowDefinitions).where(and(
    eq(caseFlowDefinitions.id, binding.definitionId), eq(caseFlowDefinitions.version, binding.definitionVersion),
  ));
  if (!definition || !stored || stored.digest !== definitionDigest(definition) ||
    definitionDigest(stored.definition as unknown as Definition) !== stored.digest) {
    return { binding, definition: null };
  }
  return { binding, definition };
}

/**
 * An explicit mutation-side compatibility assessment, never called by a read
 * projection or source observation. The caller owns the existing domain lock.
 * At most one NULL legacy identity is pinned; already-bound versions never move.
 */
export async function reconcileBindingInTransaction(tx: Tx, c: typeof onbCases.$inferSelect) {
  const snapshot = await loadDomainSnapshot(tx, c.organizationId, c.id);
  if (!snapshot) throw new FlowTransitionError("case_not_found");
  const [existing] = await tx.select().from(caseFlowBindings).where(and(
    eq(caseFlowBindings.organizationId, c.organizationId), eq(caseFlowBindings.caseId, c.id),
  ));
  if (existing?.definitionId || existing?.compatibility === "review-only") return;
  const assessment = legacyCompatibility(c, snapshot);
  if (!assessment.compatible || snapshot.family === "review-only") {
    if (!existing) await tx.insert(caseFlowBindings).values({
      organizationId: c.organizationId, caseId: c.id, compatibility: snapshot.family === "review-only" ? "review-only" : "review-required",
      reason: assessment.reason,
    }).onConflictDoNothing();
    return;
  }
  await registerDefinitionsInTransaction(tx);
  const definition = legacyBaselineDefinition(snapshot.family);
  if (existing) {
    await tx.update(caseFlowBindings).set({
      definitionId: definition.id, definitionVersion: definition.version,
      compatibility: "bound", reason: assessment.reason,
    }).where(and(eq(caseFlowBindings.organizationId, c.organizationId), eq(caseFlowBindings.caseId, c.id)));
  } else {
    await tx.insert(caseFlowBindings).values({
      organizationId: c.organizationId, caseId: c.id, definitionId: definition.id,
      definitionVersion: definition.version, compatibility: "bound", reason: assessment.reason,
    }).onConflictDoNothing();
  }
}

/** The domain mutation already holds its case/dispatch/authority fence. */
export async function guardDomainAction(tx: Tx, c: typeof onbCases.$inferSelect, actionId: string,
  operationKey: string, expected?: { version: number; generation: number }) {
  await reconcileBindingInTransaction(tx, c);
  const snapshot = await loadDomainSnapshot(tx, c.organizationId, c.id);
  if (!snapshot) throw new FlowTransitionError("case_not_found");
  const validated = await validateTransitionInTransaction(tx, {
    organizationId: c.organizationId, caseId: c.id, actionId,
    expectedVersion: expected?.version ?? (snapshot.family === "onboarding" ? c.orchestrationClaimToken : snapshot.version),
    expectedGeneration: expected?.generation ?? (snapshot.family === "onboarding" ? c.workforceContextVersion : snapshot.generation),
  });
  await recordTransitionInTransaction(tx, {
    organizationId: c.organizationId, caseId: c.id, operationKey, actionId,
    definition: validated.definition, version: snapshot.version, generation: snapshot.generation,
    outcome: "validated",
  });
  return validated;
}

/**
 * Source observations must be retained even for held historical cases. This
 * read-only predicate neither creates a binding nor throws a transition error.
 */
export async function observationMayRequestContinuation(tx: FlowReadClient, organizationId: string, caseId: number) {
  const { binding, definition } = await readBoundDefinition(tx, organizationId, caseId);
  return binding?.compatibility === "bound" && definition !== null;
}

export async function guardSeparationAction(tx: Tx, organizationId: string, caseId: number, actionId: string,
  operationKey: string, expected?: { version: number; generation: number }) {
  const [parent] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
  ));
  if (!parent) throw new FlowTransitionError("case_not_found");
  return guardDomainAction(tx, parent, actionId, operationKey, expected);
}

/**
 * One startup metadata reconciliation before the existing workers start.
 * Never dispatches, changes a domain record or schedules another poller.
 */
export async function initializeExecutableFlows(): Promise<void> {
  await db.transaction(registerDefinitionsInTransaction);
  const candidates = await db.select({ organizationId: onbCases.organizationId, caseId: onbCases.id })
    .from(onbCases).leftJoin(caseFlowBindings, and(
      eq(caseFlowBindings.organizationId, onbCases.organizationId), eq(caseFlowBindings.caseId, onbCases.id),
    )).where(isNull(caseFlowBindings.definitionId));
  for (const candidate of candidates) {
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${candidate.organizationId}))`);
      const [c] = await tx.select().from(onbCases).where(and(
        eq(onbCases.organizationId, candidate.organizationId), eq(onbCases.id, candidate.caseId),
      )).for("update");
      if (c) await reconcileBindingInTransaction(tx, c);
    });
  }
}

/**
 * Called INSIDE each existing mutation/claim fence after locking/reloading the
 * domain record. Never opens a transaction, takes an additional lock, invokes a
 * provider, or persists a binding. Domain checks must follow in the same fence.
 */
export async function validateTransitionInTransaction(tx: FlowReadClient, input: {
  organizationId: string; caseId: number; actionId: string;
  expectedVersion: number; expectedGeneration: number;
}) {
  const snapshot = await loadDomainSnapshot(tx, input.organizationId, input.caseId);
  if (!snapshot) throw new FlowTransitionError("case_not_found");
  const { binding, definition } = await readBoundDefinition(tx, input.organizationId, input.caseId);
  if (!definition || binding?.compatibility !== "bound") throw new FlowTransitionError("compatibility_review_required");
  if (definition.family !== snapshot.family) throw new FlowTransitionError("case_family_mismatch");
  if (snapshot.version !== input.expectedVersion || snapshot.generation !== input.expectedGeneration) {
    throw new FlowTransitionError("stale_domain_version_or_generation");
  }
  const evaluation = evaluateAction(definition, input.actionId, snapshot.facts);
  if (!evaluation.eligible) throw new FlowTransitionError(evaluation.blockers.join("; "));
  return { definition, snapshot, evaluation };
}

/** Metadata only, committed with the existing domain mutation. No private refs. */
export async function recordTransitionInTransaction(tx: Tx, input: {
  organizationId: string; caseId: number; operationKey: string;
  definition: Definition; actionId: string; version: number; generation: number;
  outcome: "validated" | "recorded" | "held";
}) {
  const context = currentHroContext();
  const correlation = context?.organizationId === input.organizationId ? ` Context transaction: ${context.id}.` : "";
  const action = input.definition.actions.find(action => action.id === input.actionId);
  const gateReferences = action ? ` Required gate references: ${action.evidence.join(", ")}.` : "";
  await tx.insert(caseFlowTransitions).values({
    organizationId: input.organizationId, caseId: input.caseId,
    operationKey: input.operationKey, definitionId: input.definition.id,
    definitionVersion: input.definition.version, actionId: input.actionId,
    domainVersion: input.version, generation: input.generation, outcome: input.outcome,
    reason: (input.outcome === "recorded" ? "Domain transition recorded under existing safeguards."
      : input.outcome === "held" ? "Domain transition held; review existing domain blockers."
      : "Structural prerequisites validated; live domain checks remain required.") + gateReferences + correlation,
  }).onConflictDoNothing();
}
