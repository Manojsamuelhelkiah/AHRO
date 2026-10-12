import { createHash, randomInt, randomUUID } from "node:crypto";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbCases,
  onbCommunications,
  onbEvents,
  onbSettings,
  organizationMembershipsTable,
} from "@workspace/db/schema";
import { demoPrincipalSettingKey } from "../demo-principal";
import { isSyntheticOfflineCase, isUatRunIsolatedCase } from "./synthetic-offline";
import { UAT_RUN_SETTING_PREFIX } from "./uat-isolation";
import { isRetiredControllerCase } from "./controller-retirement";
import { evaluateSensitiveLifecycleGate, jurisdictionForWorkforceContext, withSensitiveLifecycleFence } from "./sensitive-lifecycle";

export const CASE_SIMULATION_SETTING_PREFIX = "onboarding:case-simulation:";
export const CASE_SIMULATION_MAX_EXCHANGES = 64;
const SIMULATION_EMAIL_RECIPIENT_LABEL = "pinned Demo volunteer";

export const SIMULATION_STAGES = [
  "offer",
  "documents",
  "bgv",
  "payroll",
  "access",
  "readiness",
  "final-review",
] as const;
export type SimulationStage = (typeof SIMULATION_STAGES)[number];
export type SimulationOutcome = "success" | "missing-info" | "pending" | "exception";
export type SimulationStatus = "ready" | "active" | "follow-up" | "pending" | "review" | "completed";

export type SimulationExchange = {
  sequence: number;
  /** Kept as a compact stage label for existing consumers. */
  stage: SimulationStage;
  stageBefore: SimulationStage;
  stageAfter: SimulationStage | "complete";
  outcome: SimulationOutcome;
  transition: "advanced" | "follow-up" | "pending" | "review" | "completed";
  followUp: boolean;
  reviewRequired: boolean;
  requestText: string;
  responderLabel: string;
  responseText: string;
  decisionExplanation: string;
  nextAction: "advance-stage" | "follow-up-missing-info" | "poll-status" | "simulated-human-review" | "complete";
  recordedAt: string;
  /** The transport may be real while the business result remains synthetic. */
  deliveryProvenance?: "simulated" | "real-email";
  businessOutcome?: "simulated";
};

export type SimulationEmailDelivery = {
  transport: "real-email";
  businessOutcome: "simulated-only";
  recipient: string;
  status: "prepared" | "sent" | "sending" | "failed" | "replied" | "stale";
  reason: string | null;
  freshness: "current-generation" | "retired-generation";
};

export type CaseSimulationState = {
  caseId: number;
  /**
   * Opaque identity of the current simulation run.  Versions are scoped to
   * this value and must never be compared across a restart.
   */
  generationId: string;
  version: number;
  stage: SimulationStage | "complete";
  status: SimulationStatus;
  exchanges: SimulationExchange[];
  lastOutcome: SimulationOutcome | null;
  operationExchange: SimulationExchange | null;
  replayed: boolean;
  simulated: true;
  authoritative: false;
  /** Current controlled-email status, with recipient secrets and correlation tokens removed. */
  emailDelivery: SimulationEmailDelivery | null;
};

type StoredSimulationState = CaseSimulationState & {
  requests: Record<string, StoredSimulationRequest>;
  emailDispatches: Record<string, SimulationEmailDispatch>;
};

export type SimulationEmailDispatch = {
  requestId: string;
  generationId: string;
  version: number;
  token: string;
  threadMarker: string;
  subject: string;
  body: string;
  recipient: string;
  status: "prepared" | "sent" | "sending" | "failed" | "replied" | "stale";
  providerMessageId: string | null;
  reason?: string | null;
};

type StoredSimulationRequest =
  | {
      fingerprint: string;
      kind: "advance";
      generationId: string;
      exchange: SimulationExchange;
    }
  | {
      fingerprint: string;
      kind: "restart";
      generationId: string;
      result: CaseSimulationState;
    }
  | {
      fingerprint: string;
      kind: "email";
      generationId: string;
      result: CaseSimulationState;
    };

type SimulationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SimulationOutcomeSelector = (input: {
  caseId: number;
  stage: SimulationStage;
  sequence: number;
  state: CaseSimulationState;
}) => SimulationOutcome;

let outcomeSelectorForTests: SimulationOutcomeSelector | undefined;

/**
 * Focused tests can choose every branch without making production randomness
 * part of the API contract. The selector is process-local and never persisted.
 */
export function setSimulationOutcomeSelectorForTests(
  selector: SimulationOutcomeSelector | undefined,
): void {
  outcomeSelectorForTests = selector;
}


export class CaseSimulationDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseSimulationDeniedError";
  }
}

export class CaseSimulationNotFoundError extends Error {
  constructor() {
    super("Synthetic onboarding case was not found.");
    this.name = "CaseSimulationNotFoundError";
  }
}

export class CaseSimulationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseSimulationConflictError";
  }
}

function settingKey(caseId: number): string {
  return `${CASE_SIMULATION_SETTING_PREFIX}${caseId}`;
}

function advisoryLockKey(organizationId: string, caseId: number): string {
  return `onboarding-case-simulation:${organizationId}:${caseId}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function initialGenerationId(caseId: number): string {
  // A missing setting is a valid, not-yet-started simulation.  Deriving its
  // first identity makes GET followed by a mutation safe without turning a
  // read into a write.  Explicit restarts use random UUID identities.
  return `initial-${fingerprint({ caseId, kind: "case-simulation" }).slice(0, 32)}`;
}

function initialState(caseId: number): StoredSimulationState {
  return {
    caseId,
    generationId: initialGenerationId(caseId),
    version: 0,
    stage: "offer",
    status: "ready",
    exchanges: [],
    lastOutcome: null,
    operationExchange: null,
    replayed: false,
    simulated: true,
    authoritative: false,
    emailDelivery: null,
    requests: {},
    emailDispatches: {},
  };
}

function parseState(raw: string | null, caseId: number): StoredSimulationState {
  if (raw === null) return initialState(caseId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CaseSimulationConflictError("Simulation state is malformed; no mutation was applied.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { caseId?: unknown }).caseId !== caseId ||
    !Number.isInteger((parsed as { version?: unknown }).version) ||
    (parsed as { version: number }).version < 0 ||
    !Array.isArray((parsed as { exchanges?: unknown }).exchanges) ||
    typeof (parsed as { requests?: unknown }).requests !== "object" ||
    Array.isArray((parsed as { requests?: unknown }).requests)
  ) {
    throw new CaseSimulationConflictError("Simulation state is malformed; no mutation was applied.");
  }
  const state = parsed as Partial<StoredSimulationState>;
  if (state.exchanges!.length > CASE_SIMULATION_MAX_EXCHANGES) {
    throw new CaseSimulationConflictError("Simulation state exceeds its bounded exchange limit.");
  }
  return {
    caseId,
    generationId: typeof state.generationId === "string" && state.generationId.length > 0
      ? state.generationId
      : initialGenerationId(caseId),
    version: state.version!,
    stage: state.stage!,
    status: state.status!,
    exchanges: state.exchanges!,
    lastOutcome: state.lastOutcome ?? null,
    operationExchange: null,
    replayed: false,
    simulated: true,
    authoritative: false,
    emailDelivery: null,
    requests: normalizeRequests(state.requests, typeof state.generationId === "string" && state.generationId.length > 0
      ? state.generationId
      : initialGenerationId(caseId)),
    emailDispatches: normalizeEmailDispatches((state as { emailDispatches?: unknown }).emailDispatches),
  };
}

function normalizeEmailDispatches(value: unknown): Record<string, SimulationEmailDispatch> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, SimulationEmailDispatch> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Partial<SimulationEmailDispatch>;
    if (
      typeof candidate.requestId !== "string" ||
      typeof candidate.generationId !== "string" ||
      typeof candidate.token !== "string" ||
      typeof candidate.threadMarker !== "string" ||
      typeof candidate.subject !== "string" ||
      typeof candidate.body !== "string" ||
      typeof candidate.recipient !== "string" ||
      !["prepared", "sent", "sending", "failed", "replied", "stale"].includes(candidate.status ?? "") ||
      (candidate.providerMessageId !== null && typeof candidate.providerMessageId !== "string")
    ) continue;
    result[key] = candidate as SimulationEmailDispatch;
  }
  return result;
}

function normalizeRequests(
  requests: unknown,
  currentGenerationId: string,
): StoredSimulationState["requests"] {
  if (!requests || typeof requests !== "object" || Array.isArray(requests)) return {};
  const normalized: StoredSimulationState["requests"] = {};
  for (const [requestId, value] of Object.entries(requests)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Partial<StoredSimulationRequest> & {
      exchange?: SimulationExchange;
      result?: CaseSimulationState;
    };
    if (typeof record.fingerprint !== "string") {
      // Preserve no malformed request records.  The surrounding state remains
      // readable, while a reused malformed key cannot bypass a new CAS check.
      continue;
    }
    if (
      record.kind === "restart" &&
      typeof record.result === "object" &&
      record.result !== null &&
      typeof record.result.generationId === "string"
    ) {
      normalized[requestId] = {
        fingerprint: record.fingerprint,
        kind: "restart",
        generationId: record.result.generationId,
        result: record.result,
      };
      continue;
    }
    if (typeof record.exchange !== "object" || !record.exchange) continue;
    normalized[requestId] = {
      fingerprint: record.fingerprint,
      kind: "advance",
      generationId: typeof record.generationId === "string"
        ? record.generationId
        : currentGenerationId,
      exchange: record.exchange,
    };
  }
  return normalized;
}

function publicState(
  state: StoredSimulationState,
  operationExchange: SimulationExchange | null = null,
  replayed = false,
): CaseSimulationState {
  const { requests: _requests, emailDispatches, ...publicValue } = state;
  const currentDispatch = Object.values(emailDispatches)
    .sort((left, right) => {
      const leftIsCurrent = left.generationId === state.generationId ? 1 : 0;
      const rightIsCurrent = right.generationId === state.generationId ? 1 : 0;
      return rightIsCurrent - leftIsCurrent || right.version - left.version;
    })[0];
  const emailDelivery: SimulationEmailDelivery | null = currentDispatch
    ? {
      transport: "real-email",
      businessOutcome: "simulated-only",
      recipient: SIMULATION_EMAIL_RECIPIENT_LABEL,
      status: currentDispatch.status,
      reason: currentDispatch.reason ?? (
        currentDispatch.status === "sending"
          ? "Delivery outcome unknown; manual reconciliation is required. Automatic resend is disabled."
          : null
      ),
      freshness: currentDispatch.generationId === state.generationId
        ? "current-generation"
        : "retired-generation",
    }
    : null;
  return { ...publicValue, emailDelivery, operationExchange, replayed };
}

function randomOutcome(): SimulationOutcome {
  const roll = randomInt(100);
  if (roll < 60) return "success";
  if (roll < 80) return "missing-info";
  if (roll < 95) return "pending";
  return "exception";
}

function chooseOutcome(
  caseId: number,
  state: StoredSimulationState,
): SimulationOutcome {
  const stage = state.stage === "complete" ? "final-review" : state.stage;
  const selected = outcomeSelectorForTests?.({
    caseId,
    stage,
    sequence: state.exchanges.length + 1,
    state: publicState(state),
  }) ?? randomOutcome();
  if (!["success", "missing-info", "pending", "exception"].includes(selected)) {
    throw new CaseSimulationConflictError("Simulation outcome selector returned an invalid outcome.");
  }
  return selected;
}

async function authorizeCase(
  tx: SimulationTransaction,
  organizationId: string,
  actor: string,
  caseId: number,
): Promise<typeof onbCases.$inferSelect> {
  if (organizationId !== DEMO_ORGANIZATION_ID) {
    throw new CaseSimulationDeniedError("Case simulation is restricted to the Demo Organization.");
  }
  const [profile] = await tx.select({ value: onbSettings.value })
    .from(onbSettings)
    .where(and(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbSettings.key, demoPrincipalSettingKey(actor)),
    ))
    .limit(1);
  if (profile?.value !== "administrator") {
    throw new CaseSimulationDeniedError("A registered Demo Administrator profile is required.");
  }
  const [membership] = await tx.select({ id: organizationMembershipsTable.id })
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
      eq(organizationMembershipsTable.clerkUserId, actor),
      isNull(organizationMembershipsTable.revokedAt),
    ))
    .limit(1);
  if (!membership) {
    throw new CaseSimulationDeniedError("An active Demo Organization membership is required.");
  }
  const [caseRow] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbCases.id, caseId),
  )).limit(1);
  if (!caseRow) throw new CaseSimulationNotFoundError();
  if (!isSyntheticOfflineCase(caseRow) || isRetiredControllerCase(caseRow)) {
    throw new CaseSimulationDeniedError("Only active server-marked fictional offline cases may be simulated. Retained controller cases are historical only.");
  }
  const uatRunRows = await tx.select({ value: onbSettings.value })
    .from(onbSettings)
    .where(and(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
      like(onbSettings.key, `${UAT_RUN_SETTING_PREFIX}%`),
    ));
  const linkedToUatRun = uatRunRows.some((row) => {
    try {
      const value = JSON.parse(row.value) as {
        runId?: unknown;
        linkedCaseIds?: unknown;
      };
      return typeof value.runId === "string" &&
        Array.isArray(value.linkedCaseIds) &&
        value.linkedCaseIds.includes(caseId);
    } catch {
      return false;
    }
  });
  if (isUatRunIsolatedCase(caseRow) || linkedToUatRun) {
    throw new CaseSimulationConflictError(
      "UAT-isolated cases may not use the per-case response simulation.",
    );
  }
  return caseRow;
}

async function readStoredState(
  tx: SimulationTransaction,
  organizationId: string,
  caseId: number,
): Promise<StoredSimulationState> {
  const [stored] = await tx.select({ value: onbSettings.value })
    .from(onbSettings)
    .where(and(
      eq(onbSettings.organizationId, organizationId),
      eq(onbSettings.key, settingKey(caseId)),
    ))
    .limit(1);
  return parseState(stored?.value ?? null, caseId);
}

async function saveState(
  tx: SimulationTransaction,
  organizationId: string,
  state: StoredSimulationState,
): Promise<void> {
  await tx.insert(onbSettings).values({
    organizationId,
    key: settingKey(state.caseId),
    value: JSON.stringify(state),
  }).onConflictDoUpdate({
    target: [onbSettings.organizationId, onbSettings.key],
    set: { value: JSON.stringify(state), updatedAt: sql`now()` },
  });
}

function nextStage(stage: SimulationStage): SimulationStage | "complete" {
  const index = SIMULATION_STAGES.indexOf(stage);
  return index === SIMULATION_STAGES.length - 1 ? "complete" : SIMULATION_STAGES[index + 1]!;
}

function transitionFor(
  stage: SimulationStage,
  outcome: SimulationOutcome,
  status: SimulationStatus,
): Pick<SimulationExchange, "transition" | "followUp" | "reviewRequired"> & {
  stage: SimulationStage | "complete";
  status: SimulationStatus;
} {
  if (outcome === "success") {
    if (
      stage === "final-review" &&
      (status === "follow-up" || status === "pending")
    ) {
      return {
        stage,
        status: "active",
        transition: "review",
        followUp: false,
        reviewRequired: true,
      };
    }
    const stageAfterSuccess = nextStage(stage);
    return {
      stage: stageAfterSuccess,
      status: stageAfterSuccess === "complete" ? "completed" : "active",
      transition: stageAfterSuccess === "complete" ? "completed" : "advanced",
      followUp: false,
      reviewRequired: stageAfterSuccess === "complete",
    };
  }
  if (outcome === "missing-info") {
    return { stage, status: "follow-up", transition: "follow-up", followUp: true, reviewRequired: false };
  }
  if (outcome === "pending") {
    return { stage, status: "pending", transition: "pending", followUp: false, reviewRequired: false };
  }
  return { stage, status: "review", transition: "review", followUp: false, reviewRequired: true };
}

function stageLabel(stage: SimulationStage): string {
  const labels: Record<SimulationStage, string> = {
    offer: "offer package",
    documents: "document collection",
    bgv: "background verification",
    payroll: "payroll setup",
    access: "access provisioning",
    readiness: "day-one readiness",
    "final-review": "final simulated HR review",
  };
  return labels[stage];
}

type SimulationInteraction = {
  requestText: string;
  responderLabel: string;
};

function interactionFor(
  stage: SimulationStage,
  status: SimulationStatus,
): SimulationInteraction {
  const label = stageLabel(stage);
  if (status === "follow-up") {
    return {
      requestText: `[SIMULATED] Follow up for missing information needed to complete ${label}.`,
      responderLabel: `Simulated ${label} follow-up coordinator`,
    };
  }
  if (status === "pending") {
    return {
      requestText: `[SIMULATED] Poll the ${label} status and record the latest synthetic response.`,
      responderLabel: `Simulated ${label} status responder`,
    };
  }
  if (status === "review") {
    return {
      requestText: `[SIMULATED] Human-review exchange: ask HR to decide the synthetic ${label} exception.`,
      responderLabel: "Simulated HR reviewer",
    };
  }
  if (stage === "final-review") {
    return {
      requestText: "[SIMULATED] Human-review exchange: ask the simulated HR reviewer to decide final Day-one readiness.",
      responderLabel: "Simulated HR reviewer",
    };
  }
  return {
    requestText: `[SIMULATED] Request the next synthetic ${label} response.`,
    responderLabel: `Simulated ${label} responder`,
  };
}

function responseFor(
  stage: SimulationStage,
  status: SimulationStatus,
  outcome: SimulationOutcome,
): Pick<SimulationExchange, "responseText" | "decisionExplanation" | "nextAction"> {
  const label = stageLabel(stage);
  if (status === "review") {
    if (outcome === "success") {
      return {
        responseText: `[SIMULATED] Human-review decision: the simulated HR reviewer resolves the ${label} exception.`,
        decisionExplanation: `[SIMULATED] The explicit simulated HR decision approved resolution; only ${label} advances and no authoritative readiness changed.`,
        nextAction: "advance-stage",
      };
    }
    if (outcome === "missing-info") {
      return {
        responseText: `[SIMULATED] Human-review decision: the simulated HR reviewer requests more information for ${label}.`,
        decisionExplanation: `[SIMULATED] The explicit simulated HR decision created a missing-information follow-up; ${label} remains open.`,
        nextAction: "follow-up-missing-info",
      };
    }
    if (outcome === "pending") {
      return {
        responseText: `[SIMULATED] Human-review decision: the simulated HR reviewer defers the ${label} exception while its synthetic status is checked.`,
        decisionExplanation: `[SIMULATED] The explicit simulated HR decision deferred resolution; the next click polls ${label} and is not another human-review task.`,
        nextAction: "poll-status",
      };
    }
    return {
      responseText: `[SIMULATED] Human-review decision: the simulated HR reviewer keeps the ${label} exception open.`,
      decisionExplanation: `[SIMULATED] The explicit simulated HR decision did not resolve the exception; another simulated human-review exchange is required.`,
      nextAction: "simulated-human-review",
    };
  }
  if (
    stage === "final-review" &&
    (status === "follow-up" || status === "pending") &&
    outcome === "success"
  ) {
    return {
      responseText: `[SIMULATED] The ${status === "pending" ? "status check" : "follow-up"} resolved the final simulated HR review inputs.`,
      decisionExplanation: "[SIMULATED] Final-review inputs are resolved, but an explicit simulated HR reviewer decision is still required before completion.",
      nextAction: "simulated-human-review",
    };
  }
  if (
    stage === "final-review" &&
    (status === "ready" || status === "active") &&
    outcome === "success"
  ) {
    return {
      responseText: "[SIMULATED] Human-review decision: the simulated HR reviewer approves final Day-one readiness.",
      decisionExplanation: "[SIMULATED] The explicit simulated HR decision completed final review; the simulation may now complete and no authoritative readiness changed.",
      nextAction: "complete",
    };
  }
  if (outcome === "success") {
    const context = status === "follow-up"
      ? `The simulated ${label} follow-up supplied the missing information`
      : status === "pending"
        ? `The simulated ${label} status check returned a resolved result`
        : `The simulated ${label} response completed`;
    return {
      responseText: `[SIMULATED] ${context}.`,
      decisionExplanation: `[SIMULATED] Resolution was recorded for ${label}; only the simulation stage advances and no authoritative readiness changed.`,
      nextAction: "advance-stage",
    };
  }
  if (outcome === "missing-info") {
    return {
      responseText: `[SIMULATED] The ${label} response is missing required information; no completion is claimed.`,
      decisionExplanation: `[SIMULATED] ${label} remains open until the missing information is supplied in a follow-up exchange.`,
      nextAction: "follow-up-missing-info",
    };
  }
  if (outcome === "pending") {
    return {
      responseText: `[SIMULATED] The ${label} response is delayed and remains pending; this is not human review and does not require one.`,
      decisionExplanation: `[SIMULATED] The delay is a status-only result. The next click polls ${label} again rather than creating a human-review task.`,
      nextAction: "poll-status",
    };
  }
  return {
    responseText: `[SIMULATED] The ${label} response returned an exception; the synthetic case is held for simulated HR review.`,
    decisionExplanation: `[SIMULATED] This exception requires an explicit simulated human-review exchange before ${label} can resolve.`,
    nextAction: "simulated-human-review",
  };
}

/**
 * Reads only this simulation's durable setting. It intentionally does not
 * inspect readiness, documents, connectors, or any other authoritative state.
 */
export async function getCaseSimulation(input: {
  organizationId: string;
  actor: string;
  caseId: number;
}): Promise<CaseSimulationState> {
  return db.transaction(async (tx) => {
    await authorizeCase(tx, input.organizationId, input.actor, input.caseId);
    return publicState(await readStoredState(tx, input.organizationId, input.caseId));
  });
}

export async function simulateNextCaseExchange(input: {
  organizationId: string;
  actor: string;
  caseId: number;
  expectedVersion: number;
  expectedGenerationId: string;
  requestId: string;
}): Promise<CaseSimulationState> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new CaseSimulationConflictError("expectedVersion must be a non-negative integer.");
  }
  if (typeof input.expectedGenerationId !== "string" || input.expectedGenerationId.length < 1 || input.expectedGenerationId.length > 200) {
    throw new CaseSimulationConflictError("expectedGenerationId must contain 1-200 characters.");
  }
  if (typeof input.requestId !== "string" || input.requestId.length < 1 || input.requestId.length > 200) {
    throw new CaseSimulationConflictError("requestId must contain 1-200 characters.");
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(input.organizationId, input.caseId)}))`,
    );
    await authorizeCase(tx, input.organizationId, input.actor, input.caseId);
    const state = await readStoredState(tx, input.organizationId, input.caseId);
    const requestFingerprint = fingerprint({
      caseId: input.caseId,
      expectedVersion: input.expectedVersion,
      expectedGenerationId: input.expectedGenerationId,
      requestId: input.requestId,
    });
    const previous = state.requests[input.requestId];
    if (previous) {
      if (previous.fingerprint !== requestFingerprint) {
        throw new CaseSimulationConflictError(
          `requestId "${input.requestId}" was already used for a different simulation request.`,
        );
      }
      if (previous.kind !== "advance") {
        throw new CaseSimulationConflictError(
          `requestId "${input.requestId}" was already used for a restart request.`,
        );
      }
      if (state.generationId !== input.expectedGenerationId) {
        throw new CaseSimulationConflictError(
          "Simulation generation changed since this request was created; refresh before retrying.",
        );
      }
      return publicState(state, previous.exchange, true);
    }
    if (state.generationId !== input.expectedGenerationId) {
      throw new CaseSimulationConflictError(
        "Simulation generation changed since it was loaded; refresh before advancing.",
      );
    }
    if (state.version !== input.expectedVersion) {
      throw new CaseSimulationConflictError(
        `Simulation changed since it was loaded (current version ${state.version}).`,
      );
    }
    if (state.stage === "complete" || state.status === "completed") {
      throw new CaseSimulationConflictError("The simulation has already completed.");
    }
    if (Object.values(state.emailDispatches).some((entry) =>
      entry.generationId === state.generationId &&
      ["prepared", "sent", "sending"].includes(entry.status),
    )) {
      throw new CaseSimulationConflictError("A real-email simulation prompt is awaiting its monitored reply.");
    }
    if (state.exchanges.length >= CASE_SIMULATION_MAX_EXCHANGES) {
      throw new CaseSimulationConflictError("The simulation exchange limit has been reached.");
    }
    const stage = state.stage as SimulationStage;
    const outcome = chooseOutcome(input.caseId, state);
    const transition = transitionFor(stage, outcome, state.status);
    const interaction = interactionFor(stage, state.status);
    const response = responseFor(stage, state.status, outcome);
    const nextAction = transition.stage === "complete"
      ? "complete"
      : response.nextAction;
    const exchange: SimulationExchange = {
      sequence: state.exchanges.length + 1,
      stage,
      stageBefore: stage,
      stageAfter: transition.stage,
      outcome,
      transition: transition.transition,
      followUp: transition.followUp,
      reviewRequired: transition.reviewRequired,
      requestText: interaction.requestText,
      responderLabel: interaction.responderLabel,
      responseText: response.responseText,
      decisionExplanation: response.decisionExplanation,
      nextAction,
      recordedAt: new Date().toISOString(),
      deliveryProvenance: "simulated",
      businessOutcome: "simulated",
    };
    state.exchanges.push(exchange);
    state.version += 1;
    state.stage = transition.stage;
    state.status = transition.status;
    state.lastOutcome = outcome;
    state.operationExchange = exchange;
    state.replayed = false;
    state.requests[input.requestId] = {
      fingerprint: requestFingerprint,
      kind: "advance",
      generationId: state.generationId,
      exchange,
    };

    const eventKey = `case-simulation:${input.caseId}:${state.generationId}:${input.requestId}:event`;
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "response-driven-simulation",
      engine: "case-simulation",
      hitlPattern: transition.reviewRequired ? "review-before-authority" : null,
      ruleRef: "case-simulation:v1",
      title: `[SIMULATED] ${stageLabel(stage)} — ${outcome}`,
      detail: `${exchange.responseText} ${exchange.decisionExplanation}`,
      idempotencyKey: eventKey,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    await tx.insert(onbCommunications).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      channel: "simulation",
      direction: "outbound",
      audience: "admin",
      toAddress: "simulation-only",
      subject: `[SIMULATED] ${stageLabel(stage)} — ${outcome}`,
      body: [
        "This is an internal simulation record only.",
        "No email was sent, no real recipient was used, no provider was called, and no authoritative readiness was changed.",
        `Simulation stage: ${stageLabel(stage)}`,
        `Request: ${exchange.requestText}`,
        `Responder: ${exchange.responderLabel}`,
        `Outcome: ${outcome}`,
        `Response: ${exchange.responseText}`,
        `Decision: ${exchange.decisionExplanation}`,
        `Next action: ${exchange.nextAction}`,
        `Transition: ${transition.transition}`,
      ].join("\n"),
      status: "logged-only",
      sensitive: false,
      sensitiveDataClass: "unclassified-legacy",
       idempotencyKey: `case-simulation:${input.caseId}:${state.generationId}:${input.requestId}:communication`,
    }).onConflictDoNothing({
      target: [onbCommunications.organizationId, onbCommunications.idempotencyKey],
    });
    await saveState(tx, input.organizationId, state);
    return publicState(state, exchange, false);
  });
}

function maskSimulationEmail(value: string): string {
  const [local, domain] = value.split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : "***";
}

/** Remove HTML/control markup before untrusted email text enters the timeline. */
export function sanitizeSimulationReply(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, (entity) => ({
      "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'",
    }[entity.toLowerCase()] ?? " "))
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

export type SimulationEmailRoute = SimulationEmailDispatch & {
  caseId: number;
  organizationId: string;
};

/** Poller-only view of server-owned simulation email correlation data. */
export async function listSimulationEmailRoutes(): Promise<SimulationEmailRoute[]> {
  const rows = await db.select({ organizationId: onbSettings.organizationId, value: onbSettings.value })
    .from(onbSettings)
    .where(like(onbSettings.key, `${CASE_SIMULATION_SETTING_PREFIX}%`));
  const routes: SimulationEmailRoute[] = [];
  const outboundRows = await db.select({
    externalMessageId: onbCommunications.externalMessageId,
    idempotencyKey: onbCommunications.idempotencyKey,
  }).from(onbCommunications).where(eq(onbCommunications.audience, "demo-volunteer"));
  const providerIds = new Map(
    outboundRows
      .filter((row) => row.externalMessageId && row.idempotencyKey)
      .map((row) => [row.idempotencyKey!, row.externalMessageId!] as const),
  );
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as Partial<StoredSimulationState>;
      if (!Number.isSafeInteger(parsed.caseId) || !parsed.emailDispatches) continue;
      for (const dispatch of Object.values(normalizeEmailDispatches(parsed.emailDispatches))) {
        if (["sent", "sending", "stale"].includes(dispatch.status)) {
          const key = `case-simulation-email:${parsed.caseId}:${dispatch.generationId}:${dispatch.requestId}`;
          routes.push({
            ...dispatch,
            providerMessageId: dispatch.providerMessageId ?? providerIds.get(key) ?? null,
            caseId: parsed.caseId as number,
            organizationId: row.organizationId,
          });
        }
      }
    } catch {
      // A malformed setting cannot authorize inbound mail.
    }
  }
  return routes;
}

/**
 * Retain a correlated historical reply only when current collection policy
 * permits it. Never advance simulation or invoke the candidate response engine.
 */
export async function recordSimulationEmailReply(input: {
  caseId: number;
  organizationId: string;
  fromAddress: string;
  subject: string;
  body: string;
  externalMessageId: string;
  token: string;
  threadMarker: string;
}): Promise<"recorded" | "duplicate" | "stale" | "ignored"> {
  const sanitized = sanitizeSimulationReply(input.body);
  if (!sanitized) return "ignored";
  return withSensitiveLifecycleFence(input.organizationId, async () => {
    const [caseRow] = await db.select().from(onbCases).where(and(
      eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId),
    )).limit(1);
    if (!caseRow) return "ignored";
    if (!isSyntheticOfflineCase(caseRow)) {
      const gate = await evaluateSensitiveLifecycleGate({
        organizationId: input.organizationId,
        jurisdiction: jurisdictionForWorkforceContext(caseRow.workforceContext),
        dataClass: "candidate-contact", disclosure: false,
      });
      // Consume the historical route without collecting a forbidden body or
      // falling back to ordinary candidate orchestration.
      if (!gate.allowed) return "stale";
    }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(input.organizationId, input.caseId)}))`);
    const state = await readStoredState(tx, input.organizationId, input.caseId);
    const [existingCommunication] = await tx.select({ id: onbCommunications.id })
      .from(onbCommunications)
      .where(and(
        eq(onbCommunications.organizationId, input.organizationId),
        eq(onbCommunications.externalMessageId, input.externalMessageId),
      ))
      .limit(1);
    if (existingCommunication) return "duplicate";
    const route = Object.values(state.emailDispatches).find((candidate) =>
      candidate.token === input.token &&
      candidate.threadMarker === input.threadMarker &&
      ["sent", "sending", "stale"].includes(candidate.status),
    );
    if (!route || route.recipient.trim().toLowerCase() !== input.fromAddress.trim().toLowerCase()) return "ignored";
    const [communication] = await tx.insert(onbCommunications).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      channel: "email",
      direction: "inbound",
      audience: "demo-volunteer",
      toAddress: maskSimulationEmail(input.fromAddress),
      subject: input.subject,
      body: sanitized,
      status: "received",
      sensitive: true,
      sensitiveDataClass: "candidate-contact",
      externalMessageId: input.externalMessageId,
      idempotencyKey: `case-simulation-email-reply:${input.organizationId}:${input.externalMessageId}`,
    }).onConflictDoNothing({
      target: [onbCommunications.organizationId, onbCommunications.externalMessageId],
    }).returning({ id: onbCommunications.id });
    if (!communication) return "duplicate";
    // Historical correlation is retained to prevent fallback to the live
    // candidate engine. Preserve the original sent/unknown provider outcome
    // and record only this inbound receipt; progression is permanently inert.
    return "stale";
  });
  });
}

/**
 * Retires the current in-memory simulation progression and starts an
 * independent generation.  The case, provider state, UAT state, and
 * authoritative readiness are deliberately not read or written here.  The
 * append-only event and communication rows are the audit history for the
 * retired generation.
 */
export async function restartCaseSimulation(input: {
  organizationId: string;
  actor: string;
  caseId: number;
  expectedVersion: number;
  expectedGenerationId: string;
  requestId: string;
}): Promise<CaseSimulationState> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new CaseSimulationConflictError("expectedVersion must be a non-negative integer.");
  }
  if (typeof input.expectedGenerationId !== "string" || input.expectedGenerationId.length < 1 || input.expectedGenerationId.length > 200) {
    throw new CaseSimulationConflictError("expectedGenerationId must contain 1-200 characters.");
  }
  if (typeof input.requestId !== "string" || input.requestId.length < 1 || input.requestId.length > 200) {
    throw new CaseSimulationConflictError("requestId must contain 1-200 characters.");
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(input.organizationId, input.caseId)}))`,
    );
    await authorizeCase(tx, input.organizationId, input.actor, input.caseId);
    const state = await readStoredState(tx, input.organizationId, input.caseId);
    const requestFingerprint = fingerprint({
      caseId: input.caseId,
      expectedVersion: input.expectedVersion,
      expectedGenerationId: input.expectedGenerationId,
      requestId: input.requestId,
    });
    const previous = state.requests[input.requestId];
    if (previous) {
      if (previous.fingerprint !== requestFingerprint) {
        throw new CaseSimulationConflictError(
          `requestId "${input.requestId}" was already used for a different simulation request.`,
        );
      }
      if (previous.kind !== "restart") {
        throw new CaseSimulationConflictError(
          `requestId "${input.requestId}" was already used for an advance request.`,
        );
      }
      return { ...previous.result, replayed: true };
    }
    if (state.generationId !== input.expectedGenerationId) {
      throw new CaseSimulationConflictError(
        "Simulation generation changed since it was loaded; refresh before restarting.",
      );
    }
    if (state.version !== input.expectedVersion) {
      throw new CaseSimulationConflictError(
        `Simulation changed since it was loaded (current version ${state.version}).`,
      );
    }

    const retiredGenerationId = state.generationId;
    const retiredVersion = state.version;
    const retiredExchangeCount = state.exchanges.length;
    const nextGenerationId = randomUUID();
    state.generationId = nextGenerationId;
    state.version = 0;
    state.stage = "offer";
    state.status = "ready";
    state.exchanges = [];
    state.lastOutcome = null;
    state.operationExchange = null;
    state.replayed = false;

    const eventKey = `case-simulation:${input.caseId}:${retiredGenerationId}:${input.requestId}:restart:event`;
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "response-driven-simulation",
      engine: "case-simulation",
      hitlPattern: null,
      ruleRef: "case-simulation:restart:v1",
      title: "[SIMULATED] Response-driven case simulation restarted",
      detail: [
        "This restart retired only the prior synthetic simulation generation.",
        `Retired generation: ${retiredGenerationId}`,
        `Retired version: ${retiredVersion}`,
        `Retained simulated exchanges: ${retiredExchangeCount}`,
        `New generation: ${nextGenerationId}`,
        "No case, readiness, provider, recipient, or UAT state was changed.",
      ].join(" "),
      idempotencyKey: eventKey,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    await tx.insert(onbCommunications).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      channel: "simulation",
      direction: "outbound",
      audience: "admin",
      toAddress: "simulation-only",
      subject: "[SIMULATED] Response-driven case simulation restarted",
      body: [
        "This is an internal simulation record only.",
        "No email was sent, no real recipient was used, no provider was called, and no authoritative readiness was changed.",
        `Retired generation: ${retiredGenerationId}`,
        `Retired version: ${retiredVersion}`,
        `Retained simulated exchanges: ${retiredExchangeCount}`,
        `New generation: ${nextGenerationId}`,
      ].join("\n"),
      status: "logged-only",
      sensitive: false,
      sensitiveDataClass: "unclassified-legacy",
      idempotencyKey: `case-simulation:${input.caseId}:${retiredGenerationId}:${input.requestId}:restart:communication`,
    }).onConflictDoNothing({
      target: [onbCommunications.organizationId, onbCommunications.idempotencyKey],
    });

    const result = publicState(state);
    state.requests[input.requestId] = {
      fingerprint: requestFingerprint,
      kind: "restart",
      generationId: nextGenerationId,
      result,
    };
    await saveState(tx, input.organizationId, state);
    return result;
  });
}