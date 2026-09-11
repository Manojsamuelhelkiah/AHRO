import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbCases,
  onbCommunications,
  onbSettings,
} from "@workspace/db/schema";
import { isNonEmployee } from "./external-systems";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import {
  listOnboardingAgents,
  resolveOnboardingAgent,
  type OperationalAgent,
} from "./operational-agents";

export const OPERATIONAL_REQUEST_SETTING_PREFIX = "operational_requests:";
export const SIMULATED_OPERATIONAL_LABEL = "[SIMULATED — NO EXTERNAL ACTION]";

export type OperationalRequestMethod = "email" | "agent";
export type OperationalRequestStatus =
  | "requested"
  | "in-progress"
  | "completed"
  | "blocked";
export type OperationalRequestAction =
  | "select-method"
  | "start"
  | "progress"
  | "complete"
  | "block"
  | "retry";
type OperationalRequestActionBody = {
  action: OperationalRequestAction;
  method?: OperationalRequestMethod;
  reason?: string;
  expectedVersion: number;
};

type OperationalRequestDefinition = {
  id: string;
  label: string;
  agent: string;
  teamRecipientLabel: string;
};

const OPERATIONAL_REQUEST_DEFINITIONS: readonly OperationalRequestDefinition[] = [
  {
    id: "documentation",
    label: "Documentation & compliance request",
    agent: "documentation",
    teamRecipientLabel: "Documentation / Compliance team",
  },
  {
    id: "access",
    label: "IT access and identity request",
    agent: "access",
    teamRecipientLabel: "IT / Security team",
  },
  {
    id: "assets",
    label: "Assets and workplace request",
    agent: "assets",
    teamRecipientLabel: "IT / Facilities team",
  },
  {
    id: "payroll",
    label: "Payroll setup request",
    agent: "payroll",
    teamRecipientLabel: "Payroll Operations team",
  },
  {
    id: "learning",
    label: "Learning and manager-connect request",
    agent: "learning",
    teamRecipientLabel: "L&D / Manager team",
  },
];

type StatusHistoryEntry = {
  status: OperationalRequestStatus;
  at: string;
  actor: string;
  reason: string | null;
  requestId: string | null;
  communicationId: number | null;
  /**
   * Optional for legacy history entries. A null value is explicit: this was
   * an email assignment or the historical identity is unavailable.
   */
  agentIdentity?: OperationalAgent | null;
};

type ProcessedRequest = {
  action: string;
  fingerprint: string;
};

type StoredOperationalRequest = {
  id: string;
  label: string;
  owner: string;
  agent: string;
  /**
   * Legacy state may not have this field. Public reads resolve it from the
   * stable agent id instead of trusting stale or fabricated metadata.
   */
  agentIdentity?: OperationalAgent | null;
  teamRecipientLabel: string;
  method: OperationalRequestMethod;
  status: OperationalRequestStatus;
  reference: string;
  simulated: true;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  blockedAt: string | null;
  lastRetryAt: string | null;
  updatedAt: string;
  failureReason: string | null;
  history: StatusHistoryEntry[];
  processedRequestIds: Record<string, ProcessedRequest>;
};

type StoredOperationalState = {
  version: number;
  requests: StoredOperationalRequest[];
  initializationRequestIds: Record<string, ProcessedRequest>;
};

export type OperationalRequest = Omit<
  StoredOperationalRequest,
  "processedRequestIds"
>;

export type OnboardingAgent = OperationalAgent;

export type OperationalRequestsEnvelope = {
  caseId: number;
  version: number;
  simulated: true;
  offlinePaused: boolean;
  requests: OperationalRequest[];
};

export type OperationalRequestMutationResult = OperationalRequestsEnvelope & {
  requestId: string | null;
  action: string | null;
  idempotent: boolean;
  initializedRequestIds: string[];
};

export class OperationalRequestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalRequestConflictError";
  }
}

export class OperationalRequestNotFoundError extends Error {
  constructor(message = "Case not found") {
    super(message);
    this.name = "OperationalRequestNotFoundError";
  }
}

export class OperationalRequestOfflineError extends Error {
  constructor() {
    super(
      "This synthetic sample is paused offline; operational requests are read-only and no simulated action was recorded.",
    );
    this.name = "OperationalRequestOfflineError";
  }
}

const nowIso = () => new Date().toISOString();

function settingKey(caseId: number): string {
  return `${OPERATIONAL_REQUEST_SETTING_PREFIX}${caseId}`;
}

function advisoryLockKey(organizationId: string, caseId: number): string {
  return `operational-requests:${organizationId}:${caseId}`;
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicRequest(request: StoredOperationalRequest): OperationalRequest {
  const { processedRequestIds: _processedRequestIds, ...result } = request;
  return {
    ...result,
    // Keep the legacy agent id while deriving display metadata from the
    // canonical catalog. An email is a human/team communication, not an AI
    // agent attribution.
    agentIdentity:
      request.method === "agent" ? resolveOnboardingAgent(request.agent) : null,
    history: request.history.map((entry) => ({
      ...entry,
      // Older persisted history has no identity and must say unavailable,
      // rather than receiving a fabricated historical snapshot.
      agentIdentity: entry.agentIdentity ?? null,
    })),
  };
}

export function getOnboardingAgentCatalog(): OnboardingAgent[] {
  return listOnboardingAgents();
}

function publicEnvelope(
  caseId: number,
  state: StoredOperationalState,
  offlinePaused: boolean,
): OperationalRequestsEnvelope {
  return {
    caseId,
    version: state.version,
    simulated: true,
    offlinePaused,
    requests: state.requests.map(publicRequest),
  };
}

function emptyState(): StoredOperationalState {
  return {
    version: 0,
    requests: [],
    initializationRequestIds: {},
  };
}

function parseState(raw: string | null): StoredOperationalState {
  if (raw === null) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OperationalRequestConflictError(
      "Operational request state is malformed; no mutation was applied.",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Number.isInteger((parsed as { version?: unknown }).version) ||
    (parsed as { version: number }).version < 0 ||
    !Array.isArray((parsed as { requests?: unknown }).requests)
  ) {
    throw new OperationalRequestConflictError(
      "Operational request state is malformed; no mutation was applied.",
    );
  }
  const state = parsed as Partial<StoredOperationalState>;
  const requests = state.requests as unknown[];
  const statuses: OperationalRequestStatus[] = [
    "requested",
    "in-progress",
    "completed",
    "blocked",
  ];
  if (
    requests.some(
      (request) =>
        !request ||
        typeof request !== "object" ||
        typeof (request as { id?: unknown }).id !== "string" ||
        !statuses.includes((request as { status?: OperationalRequestStatus }).status!) ||
        !["email", "agent"].includes(
          (request as { method?: OperationalRequestMethod }).method!,
        ) ||
        !Array.isArray((request as { history?: unknown }).history) ||
        (request as { history: unknown[] }).history.some(
          (entry) =>
            !entry ||
            typeof entry !== "object" ||
            !statuses.includes(
              (entry as { status?: OperationalRequestStatus }).status!,
            ) ||
            typeof (entry as { at?: unknown }).at !== "string" ||
            typeof (entry as { actor?: unknown }).actor !== "string",
        ),
    )
  ) {
    throw new OperationalRequestConflictError(
      "Operational request state is malformed; no mutation was applied.",
    );
  }
  if (
    state.initializationRequestIds !== undefined &&
    (!state.initializationRequestIds ||
      typeof state.initializationRequestIds !== "object" ||
      Array.isArray(state.initializationRequestIds))
  ) {
    throw new OperationalRequestConflictError(
      "Operational request state is malformed; no mutation was applied.",
    );
  }
  return {
    version: state.version!,
    requests: requests.map((request) => ({
      ...(request as StoredOperationalRequest),
      processedRequestIds:
        (request as StoredOperationalRequest).processedRequestIds &&
        typeof (request as StoredOperationalRequest).processedRequestIds === "object"
          ? (request as StoredOperationalRequest).processedRequestIds
          : {},
    })),
    initializationRequestIds:
      state.initializationRequestIds && typeof state.initializationRequestIds === "object"
        ? state.initializationRequestIds
        : {},
  };
}

function defaultDefinitions(
  c: Pick<typeof onbCases.$inferSelect, "workerCategory">,
): readonly OperationalRequestDefinition[] {
  return OPERATIONAL_REQUEST_DEFINITIONS.filter(
    (definition) => definition.id !== "payroll" || !isNonEmployee(c.workerCategory),
  );
}

function resolvedIdentityForMethod(
  agentId: string,
  method: OperationalRequestMethod,
): OperationalAgent | null {
  if (method !== "agent") return null;
  return resolveOnboardingAgent(agentId);
}

function defaultRequest(
  definition: OperationalRequestDefinition,
  caseId: number,
  method: OperationalRequestMethod,
  timestamp: string,
): StoredOperationalRequest {
  const reference = `SIMULATED-OPS-${caseId}-${definition.id}-${randomUUID().slice(0, 8)}`;
  const registeredAgent = resolveOnboardingAgent(definition.agent);
  if (!registeredAgent) {
    throw new Error(
      `Operational request "${definition.id}" has no registered agent identity.`,
    );
  }
  return {
    id: definition.id,
    label: definition.label,
    owner: registeredAgent.owner,
    agent: definition.agent,
    agentIdentity: method === "agent" ? registeredAgent : null,
    teamRecipientLabel: definition.teamRecipientLabel,
    method,
    status: "requested",
    reference,
    simulated: true,
    requestedAt: timestamp,
    startedAt: null,
    completedAt: null,
    blockedAt: null,
    lastRetryAt: null,
    updatedAt: timestamp,
    failureReason: null,
    history: [
      {
        status: "requested",
        at: timestamp,
        actor: "system",
        reason:
          "Operational setup request initialized for simulation; no provider or external system was contacted.",
        requestId: null,
        communicationId: null,
        agentIdentity: method === "agent" ? registeredAgent : null,
      },
    ],
    processedRequestIds: {},
  };
}

type OperationalTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockAndLoad(
  tx: OperationalTransaction,
  organizationId: string,
  caseId: number,
): Promise<{
  caseRow: typeof onbCases.$inferSelect;
  state: StoredOperationalState;
}> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(organizationId, caseId)}))`,
  );
  const [caseRow] = await tx
    .select()
    .from(onbCases)
    .where(
      and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId)),
    )
    .for("update");
  if (!caseRow) throw new OperationalRequestNotFoundError();
  if (isSyntheticOfflineCase(caseRow)) {
    throw new OperationalRequestOfflineError();
  }
  const [stored] = await tx
    .select({ value: onbSettings.value })
    .from(onbSettings)
    .where(
      and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, settingKey(caseId)),
      ),
    )
    .for("update");
  return { caseRow, state: parseState(stored?.value ?? null) };
}

async function saveState(
  tx: OperationalTransaction,
  organizationId: string,
  caseId: number,
  state: StoredOperationalState,
): Promise<void> {
  await tx
    .insert(onbSettings)
    .values({
      organizationId,
      key: settingKey(caseId),
      value: JSON.stringify(state),
    })
    .onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify(state), updatedAt: sql`now()` },
    });
}

type CommunicationInput = {
  organizationId: string;
  caseId: number;
  request: StoredOperationalRequest;
  status: OperationalRequestStatus;
  actor: string;
  requestId: string | null;
  reason: string | null;
  idempotencyKey: string;
};

async function insertSimulationCommunication(
  tx: OperationalTransaction,
  input: CommunicationInput,
): Promise<number> {
  const isEmail = input.request.method === "email";
  const channel = isEmail ? "email" : "agent";
  const agentIdentity =
    input.request.method === "agent"
      ? resolveOnboardingAgent(input.request.agent)
      : null;
  const recipient = isEmail
    ? `${input.request.teamRecipientLabel} (simulated recipient label)`
    : agentIdentity
      ? `${agentIdentity.name} (id: ${agentIdentity.id}; origin: ${agentIdentity.origin}; simulated assignment)`
      : `Unresolved agent id "${input.request.agent}" (identity unavailable; simulated assignment)`;
  const subject = `${SIMULATED_OPERATIONAL_LABEL} ${input.request.label} — ${input.status}`;
  const reasonText = input.reason ? `\nReason: ${input.reason}` : "";
  const identityText = isEmail
    ? "AI agent identity: none — this is a simulated email/team assignment; the mail recipient label is not an AI agent."
    : agentIdentity
      ? `AI agent identity: ${agentIdentity.name} (id: ${agentIdentity.id}; origin: ${agentIdentity.origin}; simulated: true).`
      : `AI agent identity: unavailable for unregistered id "${input.request.agent}"; no AI agent invocation occurred.`;
  const body = [
    SIMULATED_OPERATIONAL_LABEL,
    "This is an internal simulation record only. No email was sent, no AI agent was invoked, and no provider or external system was called.",
    `Workstream owner: ${input.request.owner}`,
    `Method: ${input.request.method}`,
    `Recipient/assignment label: ${recipient}`,
    identityText,
    `Simulation reference: ${input.request.reference}`,
    `Recorded status: ${input.status}`,
    `Recorded by: ${input.actor}`,
    reasonText.trim(),
    input.status === "completed"
      ? "This records simulated completion only; it is not evidence of external completion."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  await tx
    .insert(onbCommunications)
    .values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      channel,
      direction: "outbound",
      audience: "admin",
      toAddress: recipient,
      subject,
      body,
      status: "logged-only",
      failureReason: input.status === "blocked" ? input.reason : null,
      sensitive: false,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [onbCommunications.organizationId, onbCommunications.idempotencyKey],
    });
  const [communication] = await tx
    .select({ id: onbCommunications.id })
    .from(onbCommunications)
    .where(
      and(
        eq(onbCommunications.organizationId, input.organizationId),
        eq(onbCommunications.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (!communication) {
    throw new Error("Simulated operational communication could not be recorded.");
  }
  return communication.id;
}

function assertExpectedVersion(
  state: StoredOperationalState,
  expectedVersion: number | undefined,
): void {
  if (expectedVersion === undefined) return;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new OperationalRequestConflictError(
      "expectedVersion must be a non-negative integer.",
    );
  }
  if (expectedVersion !== state.version) {
    throw new OperationalRequestConflictError(
      `Operational requests changed since they were loaded (current version ${state.version}).`,
    );
  }
}

function assertActionExpectedVersion(
  state: StoredOperationalState,
  expectedVersion: number | undefined,
): void {
  if (expectedVersion === undefined) {
    throw new OperationalRequestConflictError(
      "expectedVersion is required for operational request actions.",
    );
  }
  assertExpectedVersion(state, expectedVersion);
}

function assertRequestId(requestId: string): void {
  if (!requestId.trim() || requestId.length > 128) {
    throw new OperationalRequestConflictError(
      "requestId must contain 1–128 non-whitespace characters.",
    );
  }
}

function applyHistory(
  request: StoredOperationalRequest,
  status: OperationalRequestStatus,
  actor: string,
  reason: string | null,
  requestId: string | null,
  communicationId: number | null,
  timestamp: string,
  agentIdentity: OperationalAgent | null,
): void {
  request.status = status;
  request.updatedAt = timestamp;
  request.history.push({
    status,
    at: timestamp,
    actor,
    reason,
    requestId,
    communicationId,
    agentIdentity,
  });
  if (status === "in-progress" && !request.startedAt) request.startedAt = timestamp;
  if (status === "completed") request.completedAt = timestamp;
  if (status === "blocked") {
    request.blockedAt = timestamp;
    request.failureReason = reason;
  }
  if (status === "requested" && reason?.toLowerCase().includes("retry")) {
    request.lastRetryAt = timestamp;
    request.failureReason = null;
  }
}

function actionFingerprint(body: OperationalRequestActionBody): string {
  return stableFingerprint({
    action: body.action,
    method: body.method ?? null,
    reason: body.reason ?? null,
    expectedVersion: body.expectedVersion ?? null,
  });
}

function ensureActionAllowed(
  request: StoredOperationalRequest,
  action: OperationalRequestAction,
): void {
  const allowed: Record<
    OperationalRequestAction,
    OperationalRequestStatus[]
  > = {
    "select-method": ["requested"],
    start: ["requested"],
    progress: ["in-progress"],
    complete: ["in-progress"],
    block: ["requested", "in-progress"],
    retry: ["blocked"],
  };
  if (!allowed[action].includes(request.status)) {
    throw new OperationalRequestConflictError(
      `Action "${action}" is not valid while request "${request.id}" is ${request.status}.`,
    );
  }
}

function actionReason(
  action: OperationalRequestAction,
  reason: string | undefined,
): string | null {
  const trimmed = reason?.trim();
  if (action === "block" && (!trimmed || trimmed.length < 3)) {
    throw new OperationalRequestConflictError(
      "A block action requires a reason of at least 3 characters.",
    );
  }
  return trimmed || null;
}

function methodOrCurrent(
  request: StoredOperationalRequest,
  method: OperationalRequestMethod | undefined,
): OperationalRequestMethod {
  if (method !== undefined) {
    request.method = method;
    request.agentIdentity = resolvedIdentityForMethod(
      request.agent,
      method,
    );
  }
  if (request.method === "agent" && !request.agentIdentity) {
    request.agentIdentity = resolvedIdentityForMethod(
      request.agent,
      request.method,
    );
  }
  if (request.method === "email") request.agentIdentity = null;
  return request.method;
}

export function canMutateOperationalRequests(
  organizationId: string,
  role: string | undefined,
): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    (organizationId === DEMO_ORGANIZATION_ID && role === "member")
  );
}

export async function getOperationalRequests(
  organizationId: string,
  caseId: number,
): Promise<OperationalRequestsEnvelope> {
  const [caseRow] = await db
    .select({ id: onbCases.id, notes: onbCases.notes })
    .from(onbCases)
    .where(
      and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId)),
    );
  if (!caseRow) throw new OperationalRequestNotFoundError();
  const [stored] = await db
    .select({ value: onbSettings.value })
    .from(onbSettings)
    .where(
      and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, settingKey(caseId)),
      ),
    );
  return publicEnvelope(
    caseId,
    parseState(stored?.value ?? null),
    isSyntheticOfflineCase(caseRow),
  );
}

export async function initializeOperationalRequests(input: {
  organizationId: string;
  caseId: number;
  method?: OperationalRequestMethod;
  requestIds?: string[];
  requestId?: string;
  expectedVersion?: number;
  actor: string;
}): Promise<OperationalRequestMutationResult> {
  if (input.requestId !== undefined) assertRequestId(input.requestId);
  return db.transaction(async (tx) => {
    const { caseRow, state } = await lockAndLoad(
      tx,
      input.organizationId,
      input.caseId,
    );
    const method = input.method ?? "agent";
    const requestedIds = input.requestIds
      ? [...new Set(input.requestIds)]
      : defaultDefinitions(caseRow).map((definition) => definition.id);
    if (requestedIds.length === 0) {
      throw new OperationalRequestConflictError(
        "At least one operational request must be initialized.",
      );
    }
    const fingerprint = stableFingerprint({
      action: "initialize",
      method,
      requestIds: requestedIds,
    });
    if (input.requestId) {
      const seen = state.initializationRequestIds[input.requestId];
      if (seen) {
        if (seen.fingerprint !== fingerprint) {
          throw new OperationalRequestConflictError(
            `requestId "${input.requestId}" was already used for a different initialization.`,
          );
        }
        return {
          ...publicEnvelope(
            input.caseId,
            state,
            isSyntheticOfflineCase(caseRow),
          ),
          requestId: input.requestId,
          action: "initialize",
          idempotent: true,
          initializedRequestIds: [],
        };
      }
    }
    assertExpectedVersion(state, input.expectedVersion);
    const definitions = defaultDefinitions(caseRow).filter((definition) =>
      requestedIds.includes(definition.id),
    );
    if (requestedIds.some((id) => !definitions.some((definition) => definition.id === id))) {
      throw new OperationalRequestConflictError(
        "requestIds contains an unknown or inapplicable operational request.",
      );
    }
    const existing = new Set(state.requests.map((request) => request.id));
    const initializedRequestIds: string[] = [];
    for (const definition of definitions) {
      if (existing.has(definition.id)) continue;
      const request = defaultRequest(definition, input.caseId, method, nowIso());
      const communicationId = await insertSimulationCommunication(tx, {
        organizationId: input.organizationId,
        caseId: input.caseId,
        request,
        status: "requested",
        actor: input.actor,
        requestId: input.requestId ?? null,
        reason: null,
        idempotencyKey: `operational:${input.caseId}:${request.id}:initialize`,
      });
      request.history[0]!.communicationId = communicationId;
      state.requests.push(request);
      initializedRequestIds.push(request.id);
    }
    if (initializedRequestIds.length > 0) state.version += 1;
    if (input.requestId) {
      state.initializationRequestIds[input.requestId] = {
        action: "initialize",
        fingerprint,
      };
    }
    if (initializedRequestIds.length > 0 || input.requestId) {
      await saveState(tx, input.organizationId, input.caseId, state);
    }
    return {
      ...publicEnvelope(input.caseId, state, isSyntheticOfflineCase(caseRow)),
      requestId: input.requestId ?? null,
      action: "initialize",
      idempotent: false,
      initializedRequestIds,
    };
  });
}

export async function applyOperationalRequestAction(input: {
  organizationId: string;
  caseId: number;
  operationalRequestId: string;
  requestId: string;
  action: OperationalRequestAction;
  method?: OperationalRequestMethod;
  reason?: string;
  expectedVersion: number;
  actor: string;
}): Promise<OperationalRequestMutationResult> {
  assertRequestId(input.requestId);
  return db.transaction(async (tx) => {
    const { caseRow, state } = await lockAndLoad(
      tx,
      input.organizationId,
      input.caseId,
    );
    const request = state.requests.find(
      (candidate) => candidate.id === input.operationalRequestId,
    );
    if (!request) {
      throw new OperationalRequestNotFoundError(
        `Operational request "${input.operationalRequestId}" was not found for this case.`,
      );
    }
    const body = {
      action: input.action,
      method: input.method,
      reason: input.reason,
      expectedVersion: input.expectedVersion,
    } as OperationalRequestActionBody;
    const fingerprint = actionFingerprint(body);
    const seen = request.processedRequestIds[input.requestId];
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        throw new OperationalRequestConflictError(
          `requestId "${input.requestId}" was already used for a different action.`,
        );
      }
      return {
        ...publicEnvelope(
          input.caseId,
          state,
          isSyntheticOfflineCase(caseRow),
        ),
        requestId: input.operationalRequestId,
        action: input.action,
        idempotent: true,
        initializedRequestIds: [],
      };
    }
    assertActionExpectedVersion(state, input.expectedVersion);
    ensureActionAllowed(request, input.action);
    if (input.action === "select-method" && input.method === undefined) {
      throw new OperationalRequestConflictError(
        "select-method requires method=email or method=agent.",
      );
    }
    if (
      input.method !== undefined &&
      !["select-method", "start", "retry"].includes(input.action)
    ) {
      throw new OperationalRequestConflictError(
        `Method selection is not valid for action "${input.action}".`,
      );
    }
    const reason = actionReason(input.action, input.reason);
    const timestamp = nowIso();
    const method = methodOrCurrent(request, input.method);
    if (
      (input.action === "select-method" || input.action === "start" || input.action === "retry") &&
      !method
    ) {
      throw new OperationalRequestConflictError(
        "Select email or agent before starting an operational request.",
      );
    }

    let nextStatus: OperationalRequestStatus = request.status;
    if (input.action === "start" || input.action === "progress") {
      nextStatus = "in-progress";
    } else if (input.action === "complete") {
      nextStatus = "completed";
    } else if (input.action === "block") {
      nextStatus = "blocked";
    } else if (input.action === "retry") {
      nextStatus = "requested";
    }
    const communicationId = await insertSimulationCommunication(tx, {
      organizationId: input.organizationId,
      caseId: input.caseId,
      request,
      status: nextStatus,
      actor: input.actor,
      requestId: input.requestId,
      reason,
      idempotencyKey: `operational:${input.caseId}:${request.id}:action:${input.requestId}`,
    });
    applyHistory(
      request,
      nextStatus,
      input.actor,
      input.action === "retry"
        ? reason ?? "Retry requested; the simulated request returned to requested status."
        : reason,
      input.requestId,
      communicationId,
      timestamp,
      resolvedIdentityForMethod(request.agent, method),
    );
    request.processedRequestIds[input.requestId] = {
      action: input.action,
      fingerprint,
    };
    state.version += 1;
    await saveState(tx, input.organizationId, input.caseId, state);
    return {
      ...publicEnvelope(input.caseId, state, isSyntheticOfflineCase(caseRow)),
      requestId: input.operationalRequestId,
      action: input.action,
      idempotent: false,
      initializedRequestIds: [],
    };
  });
}
