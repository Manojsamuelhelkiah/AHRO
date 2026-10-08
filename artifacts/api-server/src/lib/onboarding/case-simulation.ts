import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
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
import { getDemoEmailReadiness, sendOutbound } from "./channels";
import { isEligibleHybridDemoSimulation, withApprovedDemoVolunteerEmail } from "./demo-controller";

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
type SimulationEmailSenderForTests = (input: {
  caseId: number;
  recipient: string;
  dispatch: SimulationEmailDispatch;
}) => Promise<{ id: number; status: string; failureReason: string | null }>;
let emailSenderForTests: SimulationEmailSenderForTests | undefined;

/**
 * Focused tests can choose every branch without making production randomness
 * part of the API contract. The selector is process-local and never persisted.
 */
export function setSimulationOutcomeSelectorForTests(
  selector: SimulationOutcomeSelector | undefined,
): void {
  outcomeSelectorForTests = selector;
}

/** Test-only transport seam for proving provider completion races. */
export function setSimulationEmailSenderForTests(
  sender: SimulationEmailSenderForTests | undefined,
): void {
  emailSenderForTests = sender;
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
  if (!isSyntheticOfflineCase(caseRow) && !await isEligibleHybridDemoSimulation(tx, caseRow)) {
    throw new CaseSimulationDeniedError("Only server-marked fictional cases or currently authorized, pinned Demo Controller cases may be simulated.");
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

export type CaseSimulationEmailResult = CaseSimulationState & {
  emailDelivery: SimulationEmailDelivery;
};

function maskSimulationEmail(value: string): string {
  const [local, domain] = value.split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : "***";
}

function simulationEmailFingerprint(input: {
  caseId: number;
  expectedVersion: number;
  expectedGenerationId: string;
  requestId: string;
}): string {
  return fingerprint(input);
}

/**
 * The reply adapter is deliberately local and narrower than the general
 * response intelligence. Private email text must never be sent to an
 * external LLM. We accept only short, whole-message, low-risk semantic
 * variants; sensitive, adverse, conflicting, instruction-like, or ambiguous
 * content remains a simulated human-review exception.
 */
export function interpretSimulationEmailReply(text: string): SimulationOutcome {
  const normalized = text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\bi've\b/g, "i have")
    .replace(/\bi'm\b/g, "i am")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (
    normalized.length === 0 ||
    normalized.length > 240 ||
    /(?:ssn|social security|passport|bank|routing|salary|payroll account|password|medical|health|diagnos|disabil|tax id|tax number|date of birth|dob|home address|credit card|account number)/i.test(normalized) ||
    /(?:ignore (?:the )?(?:previous|above|prior)|system prompt|developer message|override|bypass|run (?:this|the)|execute|delete|transfer money|approve payment|change (?:the )?status|mark (?:this|it) complete|do not tell|keep this secret)/i.test(normalized)
  ) {
    return "exception";
  }

  // These are intentionally finite, whole-message patterns. Details,
  // competing requests, and free-form explanations do not advance a case.
  const success = /^(?:(?:yes|approved|approve|done|all set|looks good)|(?:(?:i\s+)?(?:have\s+)?(?:completed|submitted|confirmed|finished|provided|sent|uploaded|received)(?:\s+(?:it|this|that|the (?:form|document|documents|information|details|request)))?))(?:\s+and\s+(?:completed|submitted|confirmed|finished|sent|uploaded)\s+(?:it|this|that))?$/;
  const pending = /^(?:(?:pending|later|not yet|checking|in progress|working on it)|(?:i\s+am\s+)?(?:still\s+waiting|waiting)(?:\s+(?:for|on)\s+(?:this|that|it|the (?:form|document|documents|information|reply|response)))?|(?:i\s+)?will\s+(?:do|complete|submit)\s+(?:it|this|that)?\s*later|(?:i\s+)?need\s+more\s+time(?:\s+to\s+(?:complete|submit|provide)\s+(?:it|this|that))?)$/;
  const missing = /^(?:(?:missing|more info(?:rmation)?|(?:i\s+)?need more info(?:rmation)?|need clarification|clarification needed)|(?:i\s+)?need\s+(?:the\s+)?(?:form|document|documents|information|details|clarification)|(?:please\s+)?(?:re)?send\s+(?:the\s+)?(?:form|document|documents|information|details)|could\s+you\s+(?:please\s+)?(?:clarify|resend)\s+(?:the\s+)?(?:form|document|documents|information|details|what\s+is\s+needed))$/;
  const matches = [success, pending, missing].filter((pattern) => pattern.test(normalized)).length;
  if (matches !== 1) return "exception";
  if (success.test(normalized)) return "success";
  if (pending.test(normalized)) return "pending";
  return "missing-info";
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

function simulationEmailBody(
  caseId: number,
  generationId: string,
  prompt: string,
  token: string,
  threadMarker: string,
): string {
  return [
    "[REAL EMAIL — CONTROLLED DEMO]",
    "This is a real delivery of a synthetic employee prompt. It is not a candidate request and cannot change readiness, authority, provider evidence, or KPI history.",
    "",
    `[SIMULATED EMPLOYEE PROMPT] ${prompt}`,
    "",
    "Reply with exactly one of: yes, pending, missing, or another short response for simulated human review.",
    "",
    `[SIMULATION CASE:${caseId}] [SIMULATION GENERATION:${generationId}]`,
    `[SIM-THREAD:${threadMarker}] [SIM-REPLY-TOKEN:${token}]`,
  ].join("\n");
}

/**
 * Prepare and explicitly dispatch the current simulation prompt. The durable
 * state and exact outbound payload are written before entering the provider
 * context. An ambiguous provider result remains `sending` and is never
 * automatically retried.
 */
export async function sendCurrentSimulationPrompt(input: {
  organizationId: string;
  actor: string;
  caseId: number;
  expectedVersion: number;
  expectedGenerationId: string;
  requestId: string;
}): Promise<CaseSimulationEmailResult> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new CaseSimulationConflictError("expectedVersion must be a non-negative integer.");
  }
  if (!input.requestId.trim()) throw new CaseSimulationConflictError("requestId is required.");
  // Establish the same Demo Administrator, membership, synthetic-case, and
  // UAT boundary before any volunteer/provider readiness lookup.
  await getCaseSimulation({
    organizationId: input.organizationId,
    actor: input.actor,
    caseId: input.caseId,
  });
  // Idempotent retries must return their prior result without revalidating a
  // volunteer that may have been edited after the original dispatch.
  const [priorSetting] = await db.select({ value: onbSettings.value })
    .from(onbSettings)
    .where(and(
      eq(onbSettings.organizationId, input.organizationId),
      eq(onbSettings.key, settingKey(input.caseId)),
    ))
    .limit(1);
  if (priorSetting) {
    const priorState = parseState(priorSetting.value, input.caseId);
    const priorDispatch = priorState.emailDispatches[input.requestId];
    if (priorDispatch) {
      if (priorDispatch.generationId !== input.expectedGenerationId || priorDispatch.version !== input.expectedVersion) {
        throw new CaseSimulationConflictError("This email request is bound to a different simulation version.");
      }
      return {
        ...publicState(priorState),
        emailDelivery: {
          transport: "real-email",
          businessOutcome: "simulated-only",
          recipient: SIMULATION_EMAIL_RECIPIENT_LABEL,
          status: priorDispatch.status,
          reason: priorDispatch.status === "sending"
            ? "Delivery outcome unknown; manual reconciliation is required. Automatic resend is disabled."
            : null,
          freshness: priorDispatch.generationId === priorState.generationId ? "current-generation" : "retired-generation",
        },
      };
    }
  }
  // Fail closed before writing a pending dispatch when setup is not ready.
  // The second identical lookup below is intentional: it is the immediate
  // provider-boundary revalidation required by the Demo Controller path.
  if (!emailSenderForTests) {
    await withApprovedDemoVolunteerEmail(
      input.organizationId,
      input.caseId,
      input.requestId,
      async () => undefined,
    );
  }
  const readiness = await getDemoEmailReadiness();
  if (!readiness.configured) {
    const denied = new Error(`Controlled Demo email is unavailable: ${readiness.reason}`);
    denied.name = "DemoLiveChannelDenied";
    throw denied;
  }
  const prepared = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(input.organizationId, input.caseId)}))`);
    await authorizeCase(tx, input.organizationId, input.actor, input.caseId);
    const state = await readStoredState(tx, input.organizationId, input.caseId);
    const existing = state.emailDispatches[input.requestId];
    if (existing) {
      if (existing.generationId !== input.expectedGenerationId || existing.version !== input.expectedVersion) {
        throw new CaseSimulationConflictError("This email request is bound to a different simulation version.");
      }
      return { state, dispatch: existing, replayed: true };
    }
    if (state.generationId !== input.expectedGenerationId || state.version !== input.expectedVersion) {
      throw new CaseSimulationConflictError("Simulation changed since it was loaded; refresh before sending the prompt.");
    }
    if (state.stage === "complete" || state.status === "completed") {
      throw new CaseSimulationConflictError("The completed simulation has no current employee prompt to email.");
    }
    const inFlight = Object.values(state.emailDispatches).find((entry) =>
      entry.generationId === state.generationId &&
      ["prepared", "sent", "sending"].includes(entry.status),
    );
    if (inFlight) {
      throw new CaseSimulationConflictError("A simulation email is already awaiting a reply; no second email was sent.");
    }
    const stage = state.stage;
    const interaction = interactionFor(stage, state.status);
    const token = randomBytes(24).toString("hex");
    const threadMarker = randomBytes(18).toString("hex");
    const subject = `[DEMO SIMULATION][SIM-THREAD:${threadMarker}] ${stageLabel(stage)}`;
    const body = simulationEmailBody(input.caseId, state.generationId, interaction.requestText, token, threadMarker);
    const dispatch: SimulationEmailDispatch = {
      requestId: input.requestId,
      generationId: state.generationId,
      version: state.version,
      token,
      threadMarker,
      subject,
      body,
      recipient: "",
      status: "prepared",
      providerMessageId: null,
      reason: null,
    };
    state.emailDispatches[input.requestId] = dispatch;
    state.version += 1;
    state.replayed = false;
    await saveState(tx, input.organizationId, state);
    return { state, dispatch, replayed: false };
  });

  if (prepared.replayed) {
    return {
      ...publicState(prepared.state),
      emailDelivery: {
        transport: "real-email",
        businessOutcome: "simulated-only",
        recipient: SIMULATION_EMAIL_RECIPIENT_LABEL,
        status: prepared.dispatch.status,
        reason: prepared.dispatch.status === "sending"
          ? "Delivery outcome unknown; manual reconciliation is required. Automatic resend is disabled."
          : null,
        freshness: prepared.dispatch.generationId === prepared.state.generationId ? "current-generation" : "retired-generation",
      },
    };
  }

  let delivery: { status: string; failureReason: string | null; id?: number } = {
    status: "sending",
    failureReason: "Delivery outcome unknown; manual reconciliation is required. Automatic resend is disabled.",
  };
  let recipient = "";
  let providerAttempted = false;
  try {
    if (emailSenderForTests) {
      recipient = "volunteer@example.com";
      providerAttempted = true;
      delivery = await emailSenderForTests({
        caseId: input.caseId,
        recipient,
        dispatch: prepared.dispatch,
      });
    } else {
      delivery = await withApprovedDemoVolunteerEmail(
        input.organizationId,
        input.caseId,
        input.requestId,
        async (selected) => {
          recipient = selected.email;
          providerAttempted = true;
          return sendOutbound({
            caseId: input.caseId,
            channel: "email",
            toAddress: selected.email,
            subject: prepared.dispatch.subject,
            body: prepared.dispatch.body,
            persistedBody: prepared.dispatch.body,
            sensitive: true,
            stableBody: true,
            skipCandidateReplyReference: true,
            audience: "demo-volunteer",
            idempotencyKey: `case-simulation-email:${input.caseId}:${prepared.dispatch.generationId}:${input.requestId}`,
          });
        },
      );
    }
  } catch (caught) {
    delivery = {
      status: providerAttempted ? "sending" : "failed",
      failureReason: providerAttempted
        ? "Delivery outcome unknown; manual reconciliation is required. Automatic resend is disabled."
        : caught instanceof Error ? caught.message : "Live Demo Controller email was blocked.",
    };
  }

  const final = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(input.organizationId, input.caseId)}))`);
    const state = await readStoredState(tx, input.organizationId, input.caseId);
    const dispatch = state.emailDispatches[input.requestId] ?? prepared.dispatch;
    if (dispatch.generationId !== state.generationId) {
      dispatch.status = delivery.status === "sent" || delivery.status === "delivered" || delivery.status === "sending"
        ? "stale"
        : "failed";
      dispatch.recipient = recipient || dispatch.recipient;
      dispatch.reason = delivery.failureReason;
      state.emailDispatches[input.requestId] = dispatch;
      await saveState(tx, input.organizationId, state);
      return { state, dispatch };
    }
    dispatch.recipient = recipient || dispatch.recipient;
    dispatch.providerMessageId = null;
    dispatch.status = delivery.status === "sent" || delivery.status === "delivered"
      ? "sent"
      : delivery.status === "sending"
        ? "sending"
        : "failed";
    dispatch.reason = delivery.failureReason;
    // The provider message id is persisted by sendOutbound on the durable
    // communication row. Keep only the dispatch state here so tokens remain
    // server-owned and never become a client-visible secret.
    await saveState(tx, input.organizationId, state);
    return { state, dispatch };
  });
  return {
    ...publicState(final.state),
    emailDelivery: {
      transport: "real-email",
      businessOutcome: "simulated-only",
      recipient: SIMULATION_EMAIL_RECIPIENT_LABEL,
      status: final.dispatch.status,
      reason: delivery.failureReason,
      freshness: final.dispatch.generationId === final.state.generationId ? "current-generation" : "retired-generation",
    },
  };
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
 * Persist a real inbound reply and map it only to the synthetic simulation
 * state machine. This function deliberately never invokes the ordinary
 * candidate response engine.
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
    // The send preparation increments the simulation version exactly once.
    // Any later simulation action makes this reply stale even if its token is
    // valid, preventing a delayed email from mutating a newer prompt.
    if (route.generationId !== state.generationId || state.version !== route.version + 1) {
      route.status = "stale";
      await tx.insert(onbEvents).values({
        organizationId: input.organizationId,
        caseId: input.caseId,
        agent: "response-driven-simulation",
        engine: "case-simulation",
        title: "[SIMULATED] Delayed real-email reply ignored",
        detail: `A delayed reply for simulation generation ${route.generationId} / request ${route.requestId} was recorded and ignored; current simulation state was not changed.`,
        idempotencyKey: `case-simulation-email-reply:${input.caseId}:${input.externalMessageId}:stale`,
      }).onConflictDoNothing({
        target: [onbEvents.organizationId, onbEvents.idempotencyKey],
      });
      await saveState(tx, input.organizationId, state);
      return "stale";
    }
    const stage = state.stage === "complete" ? "final-review" : state.stage;
    const outcome = interpretSimulationEmailReply(sanitized);
    const transition = transitionFor(stage, outcome, state.status);
    const response = responseFor(stage, state.status, outcome);
    const exchange: SimulationExchange = {
      sequence: state.exchanges.length + 1,
      stage,
      stageBefore: stage,
      stageAfter: transition.stage,
      outcome,
      transition: transition.transition,
      followUp: transition.followUp,
      reviewRequired: transition.reviewRequired,
      requestText: `[REAL EMAIL SENT — SIMULATED PROMPT] ${route.body.split("\n").find((line) => line.includes("[SIMULATED EMPLOYEE PROMPT]")) ?? "Current simulated employee prompt"}`,
      responderLabel: "Approved Demo volunteer (real email transport)",
      responseText: `[REAL EMAIL RECEIVED — SIMULATED OUTCOME] ${sanitized.slice(0, 1000)}`,
      decisionExplanation: `[SIMULATED ONLY] ${response.decisionExplanation} Real delivery/reply evidence does not change authoritative readiness or KPI history.`,
      nextAction: response.nextAction,
      recordedAt: new Date().toISOString(),
      deliveryProvenance: "real-email",
      businessOutcome: "simulated",
    };
    state.exchanges.push(exchange);
    state.version += 1;
    state.stage = transition.stage;
    state.status = transition.status;
    state.lastOutcome = outcome;
    state.operationExchange = exchange;
    route.status = "replied";
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "response-driven-simulation",
      engine: "case-simulation",
      hitlPattern: transition.reviewRequired ? "review-before-authority" : null,
      ruleRef: "case-simulation:real-email:v1",
      title: `[SIMULATED] Real email reply — ${outcome}`,
      detail: exchange.decisionExplanation,
      idempotencyKey: `case-simulation-email-reply:${input.caseId}:${input.externalMessageId}:event`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    await saveState(tx, input.organizationId, state);
    return "recorded";
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