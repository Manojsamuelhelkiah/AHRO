import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbCases,
  onbCommunications,
  onbEvents,
  onbSettings,
  onbPolicyAuthorities,
  organizationMembershipsTable,
} from "@workspace/db/schema";
import { isNonEmployee } from "./external-systems";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import {
  listOnboardingAgents,
  resolveOnboardingAgent,
  type OperationalAgent,
} from "./operational-agents";
import { formatEmailIdentityLines } from "./email-identity";
import {
  compileWorkforceProcessSteps,
  workforceRuntimeEnabled,
  type WorkforceStepRuntimeIssue,
} from "./workforce-step-runtime";
import { workforceAuthorityScope } from "./workforce-policies";
import { evaluateStoredCaseGovernanceGate, type GovernanceWorkflow } from "./governance-runtime";
import { getStandardOperationsViewInTransaction } from "./standard-operations";
import {
  SensitiveLifecycleValidationError,
  withCaseDerivedLifecycleWrite,
} from "./sensitive-lifecycle";

export const OPERATIONAL_REQUEST_SETTING_PREFIX = "operational_requests:";
export const WORKFORCE_CONTINUATION_SETTING_PREFIX = "workforce_connector_continuation:";
export const SIMULATED_OPERATIONAL_LABEL = "[SIMULATED — NO EXTERNAL ACTION]";

export type OperationalRequestMethod = "email" | "agent" | "human-task";
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

function governanceWorkflowForOperationalRequest(request: StoredOperationalRequest): GovernanceWorkflow | null {
  if (request.runtimeWorkstream === "assets" || request.id === "assets") return "assets-workplace";
  if (request.runtimeWorkstream === "payroll" || request.id === "payroll") return "payroll-benefits";
  if (request.id === "documentation") return "worker-record-documents";
  if (request.id === "access") return "it-identity-access";
  if (request.runtimeWorkstream === "learning") return "frontline-deployment";
  return null;
}

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
  /** Human workforce tasks are accountable work, not a simulated integration. */
  simulated: boolean;
  runtimeSchemaVersion?: "workforce-step-runtime/v1";
  runtimeWorkstream?: "intake" | "payroll" | "assets" | "learning";
  responsibleRole?: string;
  assignedTo?: string | null;
  mandatory?: boolean;
  evidenceRequired?: boolean;
  nonblocking?: boolean;
  prerequisites?: string[];
  parallelGroup?: string | null;
  permittedChannels?: Array<"portal" | "manager-led">;
  notBeforeAt?: string | null;
  dueAt?: string | null;
  escalation?: {
    at: string;
    responsibleRole: string;
    assignedTo: string | null;
  } | null;
  workforceContextVersion?: number;
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
> & {
  /** Computed at read time; it does not pretend an escalation was sent. */
  overdue: boolean;
  /** A visible accountable escalation is required, not an automatic message. */
  escalationRequired: boolean;
};

export type OnboardingAgent = OperationalAgent;

export type OperationalRequestsEnvelope = {
  caseId: number;
  version: number;
  /** False when this case includes accountable human workforce tasks. */
  simulated: boolean;
  offlinePaused: boolean;
  requests: OperationalRequest[];
};

export type OperationalRequestMutationResult = OperationalRequestsEnvelope & {
  requestId: string | null;
  action: string | null;
  idempotent: boolean;
  initializedRequestIds: string[];
  /** The human task commit succeeded; guarded connector continuation will retry. */
  continuationPending?: boolean;
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
export class OperationalRequestAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalRequestAuthorizationError";
  }
}

const nowIso = () => new Date().toISOString();

function settingKey(caseId: number): string {
  return `${OPERATIONAL_REQUEST_SETTING_PREFIX}${caseId}`;
}

/**
 * Case-derived writes lock and evaluate lifecycle policy before the
 * operational state lock. Preserve this module's public not-found contract
 * when that authoritative case lookup finds no tenant-owned row.
 */
async function withOperationalRequestLifecycleWrite<T>(
  input: { organizationId: string; caseId: number },
  write: (tx: OperationalTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withCaseDerivedLifecycleWrite(input, write);
  } catch (error) {
    if (
      error instanceof SensitiveLifecycleValidationError &&
      error.message === "Case-derived sensitive write requires a current tenant case."
    ) {
      throw new OperationalRequestNotFoundError();
    }
    throw error;
  }
}

function continuationKey(caseId: number, requestId: string): string {
  return `${WORKFORCE_CONTINUATION_SETTING_PREFIX}${caseId}:${requestId}`;
}

function advisoryLockKey(organizationId: string, caseId: number): string {
  return `operational-requests:${organizationId}:${caseId}`;
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicRequest(request: StoredOperationalRequest): OperationalRequest {
  const { processedRequestIds: _processedRequestIds, ...result } = request;
  const now = Date.now();
  const overdue = Boolean(
    request.dueAt &&
    request.status !== "completed" &&
    new Date(request.dueAt).getTime() < now,
  );
  const escalationRequired = Boolean(
    request.escalation &&
    request.status !== "completed" &&
    new Date(request.escalation.at).getTime() <= now,
  );
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
    overdue,
    escalationRequired,
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
    simulated: state.requests.every((request) => request.simulated),
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
        !["email", "agent", "human-task"].includes(
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
  c: Pick<typeof onbCases.$inferSelect, "workerCategory" | "processPolicySnapshot">,
): readonly OperationalRequestDefinition[] {
  if (!workforceRuntimeEnabled(c.processPolicySnapshot)) {
    return OPERATIONAL_REQUEST_DEFINITIONS.filter(
      (definition) => definition.id !== "payroll" || !isNonEmployee(c.workerCategory),
    );
  }
  return OPERATIONAL_REQUEST_DEFINITIONS.filter(
    // Learning has no connected executor. It is compiled below as accountable
    // human work; it must never be initialized as an agent simulation.
    (definition) =>
      !["learning", "payroll", "assets"].includes(definition.id) &&
      (definition.id !== "payroll" || !isNonEmployee(c.workerCategory)),
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

function workforceTaskRequest(
  caseId: number,
  task: ReturnType<typeof compileWorkforceProcessSteps>["steps"][number],
  timestamp: string,
  workforceContextVersion: number,
): StoredOperationalRequest {
  const id = task.id;
  return {
    id,
    label: task.label,
    owner: task.assignedTo ?? task.responsibleRole,
    agent: "human-task",
    agentIdentity: null,
    teamRecipientLabel: task.assignedTo
      ? `${task.assignedTo} (${task.responsibleRole})`
      : task.responsibleRole,
    method: "human-task",
    status: "requested",
    reference: `HUMAN-TASK-${caseId}-${id}-${randomUUID().slice(0, 8)}`,
    simulated: false,
    runtimeSchemaVersion: "workforce-step-runtime/v1",
    runtimeWorkstream: task.workstream,
    responsibleRole: task.responsibleRole,
    assignedTo: task.assignedTo,
    mandatory: task.mandatory,
    evidenceRequired: task.evidenceRequired,
    nonblocking: task.nonblocking,
    prerequisites: task.prerequisites,
    parallelGroup: task.parallelGroup,
    permittedChannels: task.permittedChannels,
    notBeforeAt: task.notBeforeAt,
    dueAt: task.dueAt,
    escalation: task.escalation,
    workforceContextVersion,
    requestedAt: timestamp,
    startedAt: null,
    completedAt: null,
    blockedAt: null,
    lastRetryAt: null,
    updatedAt: timestamp,
    failureReason: null,
    history: [{
      status: "requested",
      at: timestamp,
      actor: "system",
      reason: "Accountable human workforce task created from the immutable learning policy snapshot. No AI agent, LMS, calendar, message, or external system was invoked.",
      requestId: null,
      communicationId: null,
      agentIdentity: null,
    }],
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
  const [caseRow] = await tx
    .select({ workerName: onbCases.workerName })
    .from(onbCases)
    .where(and(
      eq(onbCases.id, input.caseId),
      eq(onbCases.organizationId, input.organizationId),
    ));
  const reference = input.request.reference;
  const identityLines = formatEmailIdentityLines({
    stakeholder: {
      name: "",
      role: input.request.teamRecipientLabel,
    },
    deliveryAddress: null,
    requestedBy: input.actor,
    requestedByKind: "human",
    deliveryMode: "simulated",
    actionRequired: input.status === "completed"
      ? "Review the recorded simulated completion; no external completion is claimed."
      : `Review and update the simulated ${input.request.label} request (${input.status}).`,
    reference,
    appPath: `/approvals?tab=approvals&caseId=${encodeURIComponent(String(input.caseId))}&reference=${encodeURIComponent(reference)}`,
  });
  const body = [
    SIMULATED_OPERATIONAL_LABEL,
    "This is an internal simulation record only. No email was sent, no AI agent was invoked, and no provider or external system was called.",
    `Employee: ${caseRow?.workerName ?? "unknown (case record unavailable)"}`,
    `Case: #${input.caseId}`,
    `Workstream owner: ${input.request.owner}`,
    `Method: ${input.request.method}`,
    `Recipient/assignment label: ${recipient}`,
    identityText,
    `Simulation reference: ${input.request.reference}`,
    `Recorded status: ${input.status}`,
    `Recorded by: ${input.actor}`,
    ...identityLines,
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

function isWorkforceHumanTask(request: StoredOperationalRequest): boolean {
  return request.method === "human-task" &&
    request.runtimeSchemaVersion === "workforce-step-runtime/v1";
}

function assertWorkforceTaskCanStart(
  state: StoredOperationalState,
  request: StoredOperationalRequest,
  timestamp: string,
): void {
  if (!isWorkforceHumanTask(request)) return;
  if (request.notBeforeAt && new Date(request.notBeforeAt).getTime() > new Date(timestamp).getTime()) {
    throw new OperationalRequestConflictError(
      `Human task "${request.id}" is not available until ${request.notBeforeAt}.`,
    );
  }
  const incomplete = (request.prerequisites ?? []).filter((id) =>
    state.requests.find((candidate) => candidate.id === id)?.status !== "completed",
  );
  if (incomplete.length) {
    throw new OperationalRequestConflictError(
      `Human task "${request.id}" is waiting for prerequisite completion: ${incomplete.join(", ")}.`,
    );
  }
}

function assertWorkforceTaskAction(
  state: StoredOperationalState,
  request: StoredOperationalRequest,
  body: OperationalRequestActionBody,
  timestamp: string,
): void {
  if (!isWorkforceHumanTask(request)) return;
  if (body.method !== undefined) {
    throw new OperationalRequestConflictError(
      `Human task "${request.id}" has fixed permitted channels (${(request.permittedChannels ?? []).join(", ") || "none"}) and cannot select a simulated email or agent method.`,
    );
  }
  if (body.action === "select-method") {
    throw new OperationalRequestConflictError(
      `Human task "${request.id}" has a fixed human-task execution method.`,
    );
  }
  if (body.action === "start") assertWorkforceTaskCanStart(state, request, timestamp);
  if (body.action === "complete" && request.evidenceRequired !== false) {
    const evidence = body.reason?.trim();
    if (!evidence || evidence.length < 3) {
      throw new OperationalRequestConflictError(
        `Human task "${request.id}" requires an evidence reference or completion note of at least 3 characters before it can be completed.`,
      );
    }
  }
}

async function reconcileWorkforceStepReadiness(
  tx: OperationalTransaction,
  caseRow: typeof onbCases.$inferSelect,
  state: StoredOperationalState,
): Promise<boolean> {
  const blockingFor = (workstream: StoredOperationalRequest["runtimeWorkstream"]) =>
    state.requests.filter(
      (request) =>
        request.runtimeWorkstream === workstream &&
        request.mandatory !== false &&
        request.nonblocking !== true,
    );
  const completeFor = (workstream: StoredOperationalRequest["runtimeWorkstream"]) => {
    const tasks = blockingFor(workstream);
    return tasks.every((request) => request.status === "completed");
  };
  const incompleteLabels = (workstream: StoredOperationalRequest["runtimeWorkstream"]) =>
    blockingFor(workstream)
      .filter((request) => request.status !== "completed")
      .map((request) => request.label);
  const learningComplete = completeFor("learning");
  const payrollComplete = completeFor("payroll");
  const assetsComplete = completeFor("assets");
  const intakeComplete = completeFor("intake");
  const readiness = caseRow.readiness.map((item) => ({ ...item }));
  const learning = readiness.find((item) => item.key === "learning");
  const checkpoints = readiness.find((item) => item.key === "checkpoints");
  const payroll = readiness.find((item) => item.key === "payroll");
  const assets = readiness.find((item) => item.key === "assets");
  const profile = readiness.find((item) => item.key === "profile");
  const learningNote = learningComplete
    ? "All mandatory learning workforce tasks were completed by accountable humans with recorded completion evidence. No LMS, calendar, or messaging-provider completion is claimed."
    : `Awaiting accountable human completion of ${incompleteLabels("learning").length} mandatory learning task(s): ${incompleteLabels("learning").join(", ")}.`;
  if (learning) {
    learning.status = learningComplete ? "ready" : "in-progress";
    learning.note = learningNote;
  }
  if (checkpoints) {
    checkpoints.status = learningComplete ? "ready" : "in-progress";
    checkpoints.note = learningComplete
      ? "Learning and manager-connect workforce tasks are complete; checkpoint planning remains a human-owned record."
      : "Checkpoint readiness is held until mandatory learning workforce tasks are completed.";
  }
  if (payroll) {
    if (isNonEmployee(caseRow.workerCategory)) {
      payroll.status = "ready";
      payroll.note = "Not applicable — non-employee pathway.";
    } else {
      payroll.status = payrollComplete ? "ready" : "in-progress";
      payroll.note = payrollComplete
        ? "Payroll prerequisite and setup were completed by accountable humans with recorded evidence; no payroll provider enrollment is claimed."
        : `Payroll readiness is held for ${incompleteLabels("payroll").join(", ")}.`;
    }
  }
  if (assets) {
    assets.status = assetsComplete ? "ready" : "in-progress";
    assets.note = assetsComplete
      ? "Asset/workplace readiness was completed by accountable humans with recorded evidence; no fulfillment provider action is claimed."
      : `Asset readiness is held for ${incompleteLabels("assets").join(", ")}.`;
  }
  if (profile) {
    profile.status = intakeComplete ? "ready" : "in-progress";
    profile.note = intakeComplete
      ? "Configured intake mode and channel were confirmed by an accountable human with recorded evidence."
      : `Intake confirmation is held for ${incompleteLabels("intake").join(", ")}.`;
  }
  const workstreams = caseRow.workstreams.map((item) => ({
    ...item,
    blockers: [...item.blockers],
  }));
  const learningWorkstream = workstreams.find((item) => item.key === "learning");
  if (learningWorkstream) {
    learningWorkstream.status = learningComplete ? "ready" : "in-progress";
    learningWorkstream.blockers = learningComplete ? [] : incompleteLabels("learning");
  }
  const assetsWorkstream = workstreams.find((item) => item.key === "assets");
  if (assetsWorkstream) {
    assetsWorkstream.status = assetsComplete ? "ready" : "in-progress";
    assetsWorkstream.blockers = assetsComplete ? [] : incompleteLabels("assets");
  }
  await tx.update(onbCases).set({
    readiness,
    workstreams,
    updatedAt: new Date(),
  }).where(and(
    eq(onbCases.id, caseRow.id),
    eq(onbCases.organizationId, caseRow.organizationId),
  ));
  return [learningComplete, payrollComplete, assetsComplete, intakeComplete].every(Boolean);
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
  if (request.method !== "agent") request.agentIdentity = null;
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

export type WorkforceRuntimePrerequisiteEvaluation = {
  /** True only when this case currently has v2 human runtime tasks. */
  active: boolean;
  /** Every mandatory, blocking task in the requested workstream is complete. */
  allowed: boolean;
  incompleteTaskIds: string[];
  version: number;
};

/** Stable authority identifier; display labels are not authorization keys. */
export function workforceAuthorityRoleId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Invoke inside the policy-rebase transaction after locking this case's state. */
export function assertWorkforceRuntimeRebaseAllowed(serializedState: unknown): void {
  const state = parseState(typeof serializedState === "string" ? serializedState : null);
  if (state.requests.some((request) =>
    request.runtimeSchemaVersion === "workforce-step-runtime/v1" &&
    request.status !== "requested",
  )) {
    throw new OperationalRequestConflictError(
      "A workforce policy rebase cannot retire or rebuild tasks after a task has been claimed or acted on.",
    );
  }
}

/**
 * Read-only transactional gate for connector dispatch/recovery. Connector
 * owners call this immediately before a workstream mutation; it deliberately
 * writes no task state and never treats a missing runtime as a v2 blocker.
 */
export async function evaluateWorkforceRuntimePrerequisites(input: {
  organizationId: string;
  caseId: number;
  workstream: "intake" | "payroll" | "assets" | "learning";
}): Promise<WorkforceRuntimePrerequisiteEvaluation> {
  return db.transaction(async (tx) => {
    const [stored] = await tx.select({ value: onbSettings.value })
      .from(onbSettings)
      .where(and(
        eq(onbSettings.organizationId, input.organizationId),
        eq(onbSettings.key, settingKey(input.caseId)),
      )).limit(1);
    if (!stored) {
      return { active: false, allowed: true, incompleteTaskIds: [], version: 0 };
    }
    const state = parseState(stored.value);
    const tasks = state.requests.filter(
      (request) =>
        request.runtimeSchemaVersion === "workforce-step-runtime/v1" &&
        request.runtimeWorkstream === input.workstream &&
        request.mandatory !== false &&
        request.nonblocking !== true,
    );
    if (!tasks.length) {
      return { active: false, allowed: true, incompleteTaskIds: [], version: state.version };
    }
    const incompleteTaskIds = tasks
      .filter((request) => request.status !== "completed")
      .map((request) => request.id);
    return {
      active: true,
      allowed: incompleteTaskIds.length === 0,
      incompleteTaskIds,
      version: state.version,
    };
  });
}

type WorkforceContinuationDependencies = {
  dispatch?: (caseRow: typeof onbCases.$inferSelect) => Promise<
    void | { releaseHeld: boolean; heldConnectors: string[] }
  >;
  resume?: (caseId: number) => Promise<unknown>;
};

/**
 * Replays a committed human-task continuation. Both boundaries re-read and
 * enforce their own current gates, so this is safe for a later checklist
 * pause and cannot revive a stale pre-workstream authorization.
 */
export async function reconcileWorkforceConnectorContinuation(input: {
  organizationId: string;
  caseId: number;
  requestId: string;
  dependencies?: WorkforceContinuationDependencies;
}): Promise<void> {
  const key = continuationKey(input.caseId, input.requestId);
  try {
    const [caseRow] = await db.select().from(onbCases).where(and(
      eq(onbCases.id, input.caseId),
      eq(onbCases.organizationId, input.organizationId),
    ));
    if (!caseRow) {
      await db.delete(onbSettings).where(and(
        eq(onbSettings.organizationId, input.organizationId),
        eq(onbSettings.key, key),
      ));
      return;
    }
    const dispatchOutcome = input.dependencies?.dispatch
      ? await input.dependencies.dispatch(caseRow)
      : await (async () => {
        const { dispatchWorkstreamConnectorMutations } = await import("./workstream-connectors");
        return dispatchWorkstreamConnectorMutations(caseRow);
      })();
    if (dispatchOutcome?.releaseHeld) {
      // A workforce continuation can be the first path to create a BGV
      // tracker. Persist the same durable release boundary as the engine so
      // the now-tracked case is not excluded from untracked recovery before
      // trusted BGV/HRIS evidence arrives.
      await withCaseDerivedLifecycleWrite({
        organizationId: input.organizationId,
        caseId: input.caseId,
      }, (tx) => tx.update(onbCases).set({
        lifecycleStage: "preboarding",
        orchestrationStatus: "checklist-blocked",
        orchestrationCheckpoint: "waiting:standard-operations-release",
        orchestrationClaimOwner: null,
        orchestrationClaimUntil: null,
        updatedAt: new Date(),
      }).where(and(
        eq(onbCases.id, input.caseId),
        eq(onbCases.organizationId, input.organizationId),
      )));
      // Keep the committed task continuation durable. The heartbeat will
      // retry this exact, journal-fenced provider operation after the
      // outstanding Standard Operations evidence is reconciled; deleting it
      // here would make a manual payroll date-impact resolution inert until
      // some unrelated orchestration path happened to run.
      return;
    }
    if (input.dependencies?.resume) {
      await input.dependencies.resume(input.caseId);
    } else {
      const { resumeChecklistOrchestration } = await import("./engine");
      await resumeChecklistOrchestration(input.caseId);
    }
    await db.delete(onbSettings).where(and(
      eq(onbSettings.organizationId, input.organizationId),
      eq(onbSettings.key, key),
    ));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await withCaseDerivedLifecycleWrite({
      organizationId: input.organizationId,
      caseId: input.caseId,
    }, async (tx) => {
      await tx.insert(onbSettings).values({
        organizationId: input.organizationId,
        key,
        value: JSON.stringify({
          version: 1,
          caseId: input.caseId,
          requestId: input.requestId,
          status: "pending",
          lastError: detail.slice(0, 500),
          updatedAt: nowIso(),
        }),
      }).onConflictDoUpdate({
        target: [onbSettings.organizationId, onbSettings.key],
        set: {
          value: JSON.stringify({
            version: 1,
            caseId: input.caseId,
            requestId: input.requestId,
            status: "pending",
            lastError: detail.slice(0, 500),
            updatedAt: nowIso(),
          }),
          updatedAt: sql`now()`,
        },
      });
      await tx.insert(onbEvents).values({
        organizationId: input.organizationId,
        caseId: input.caseId,
        agent: "workforce-continuation",
        engine: "system",
        hitlPattern: "retry",
        ruleRef: "workforce-step-runtime/v1",
        title: "Committed workforce continuation pending retry",
        detail: `Human task completion is durable; guarded connector continuation remains pending: ${detail.slice(0, 300)}`,
        idempotencyKey: `workforce-continuation:${input.caseId}:${input.requestId}:pending`,
      }).onConflictDoNothing({
        target: [onbEvents.organizationId, onbEvents.idempotencyKey],
      });
    });
    throw error;
  }
}

/** Watcher recovery for continuations whose post-commit boundary failed. */
export async function recoverWorkforceConnectorContinuations(): Promise<void> {
  const rows = await db.select({
    organizationId: onbSettings.organizationId,
    key: onbSettings.key,
  }).from(onbSettings).where(
    sql`${onbSettings.key} like ${`${WORKFORCE_CONTINUATION_SETTING_PREFIX}%`}`,
  );
  for (const row of rows) {
    const suffix = row.key.slice(WORKFORCE_CONTINUATION_SETTING_PREFIX.length);
    const separator = suffix.indexOf(":");
    const caseId = Number(suffix.slice(0, separator));
    const requestId = suffix.slice(separator + 1);
    if (separator < 1 || !Number.isInteger(caseId) || caseId < 1 || !requestId) continue;
    try {
      await reconcileWorkforceConnectorContinuation({
        organizationId: row.organizationId,
        caseId,
        requestId,
      });
    } catch (error) {
      // The error was persisted on its continuation row; continue recovering
      // other tenants/cases rather than turning one refusal into a silent drop.
      console.error(`[workforce-continuation] recovery failed for ${row.key}:`, error);
    }
  }
}

export async function getOperationalRequests(
  organizationId: string,
  caseId: number,
): Promise<OperationalRequestsEnvelope> {
  const [caseRow] = await db
    .select({
      id: onbCases.id,
      notes: onbCases.notes,
      syntheticProvenance: onbCases.syntheticProvenance,
    })
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
  return withOperationalRequestLifecycleWrite({
    organizationId: input.organizationId,
    caseId: input.caseId,
  }, async (tx) => {
    const { caseRow, state } = await lockAndLoad(
      tx,
      input.organizationId,
      input.caseId,
    );
    const method = input.method ?? "agent";
    if (method === "human-task") {
      throw new OperationalRequestConflictError(
        "Human-task is reserved for workforce step policies and cannot initialize a simulated operational request.",
      );
    }
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

export type WorkforceStepInitializationResult = OperationalRequestsEnvelope & {
  active: boolean;
  initializedRequestIds: string[];
  issues: WorkforceStepRuntimeIssue[];
  blockingTasksComplete: boolean;
  workstreamBlockingComplete: Record<"intake" | "payroll" | "assets" | "learning", boolean>;
};

/**
 * Persist learning work as accountable human tasks. The source is only the
 * immutable processPolicySnapshot already attached to this case. A policy
 * never causes an AI/persona or external-system invocation here.
 */
export async function initializeWorkforceStepTasks(input: {
  organizationId: string;
  caseId: number;
  actor: string;
}): Promise<WorkforceStepInitializationResult> {
  return withOperationalRequestLifecycleWrite({
    organizationId: input.organizationId,
    caseId: input.caseId,
  }, async (tx) => {
    const { caseRow, state } = await lockAndLoad(
      tx,
      input.organizationId,
      input.caseId,
    );
    const compilation = compileWorkforceProcessSteps({
      processPolicySnapshot: caseRow.processPolicySnapshot,
      joiningDate: caseRow.joiningDate,
      workerCategory: caseRow.workerCategory,
    });
    const existingRuntimeTasks = () => state.requests.filter(
      (request) => request.runtimeSchemaVersion === "workforce-step-runtime/v1",
    );
    if (!compilation.active) {
      const prior = existingRuntimeTasks();
      if (prior.some((request) => request.status !== "requested")) {
        throw new OperationalRequestConflictError(
          "A workforce policy rebase cannot retire tasks after a task has been claimed or acted on.",
        );
      }
      if (prior.length) {
        state.requests = state.requests.filter(
          (request) => request.runtimeSchemaVersion !== "workforce-step-runtime/v1",
        );
        delete state.initializationRequestIds["learning-workforce-steps"];
        state.version += 1;
        await saveState(tx, input.organizationId, input.caseId, state);
      }
      return {
        ...publicEnvelope(input.caseId, state, isSyntheticOfflineCase(caseRow)),
        active: false,
        initializedRequestIds: [],
        issues: [],
        blockingTasksComplete: true,
        workstreamBlockingComplete: { intake: true, payroll: true, assets: true, learning: true },
      };
    }
    // Keep learning ids namespaced so legacy snapshots with terse sequence ids
    // cannot collide with payroll/assets task ids in the same case state.
    const runtimeTasks = compilation.steps.map((task) => task.workstream === "learning" && !task.id.startsWith("learning-")
      ? {
          ...task,
          id: `learning-${task.id}`,
          prerequisites: task.prerequisites.map((prerequisite) =>
            prerequisite.startsWith("learning-") ? prerequisite : `learning-${prerequisite}`),
        }
      : task);
    const runtimeIds = runtimeTasks.map((task) => task.id);
    if (new Set(runtimeIds).size !== runtimeIds.length) {
      throw new OperationalRequestConflictError(
        "Learning policy step ids collide after their required learning namespace is applied.",
      );
    }
    for (const task of runtimeTasks) {
      if (!task.assignedTo) continue;
      const [member] = await tx.select({ id: organizationMembershipsTable.id })
        .from(organizationMembershipsTable)
        .where(and(
          eq(organizationMembershipsTable.organizationId, input.organizationId),
          eq(organizationMembershipsTable.clerkUserId, task.assignedTo),
          isNull(organizationMembershipsTable.revokedAt),
        )).limit(1);
      if (!member) {
        throw new OperationalRequestConflictError(
          `Named assignee "${task.assignedTo}" is not an authenticated member of this organization.`,
        );
      }
    }
    const fingerprint = stableFingerprint({
      action: "initialize-learning-workforce-steps",
      schemaVersion: compilation.schemaVersion,
      steps: compilation.steps,
      issues: compilation.issues,
    });
    const initializationKey = "learning-workforce-steps";
    const seen = state.initializationRequestIds[initializationKey];
    if (seen && seen.fingerprint !== fingerprint) {
      const prior = existingRuntimeTasks();
      if (prior.some((request) => request.status !== "requested")) {
        throw new OperationalRequestConflictError(
          "A workforce policy rebase cannot replace tasks after a task has been claimed or acted on.",
        );
      }
      // A paused/rebased case has no claim or completion evidence yet. Retire
      // its requested-only tasks atomically, then construct the new immutable
      // snapshot below. References are never reused after an acted-on task.
      state.requests = state.requests.filter(
        (request) => request.runtimeSchemaVersion !== "workforce-step-runtime/v1",
      );
      delete state.initializationRequestIds[initializationKey];
    }
    const existing = new Set(state.requests.map((request) => request.id));
    const initializedRequestIds: string[] = [];
      for (const task of runtimeTasks) {
      const request = workforceTaskRequest(
        caseRow.id,
        task,
        nowIso(),
        caseRow.workforceContextVersion,
      );
      if (existing.has(request.id)) continue;
      if (request.prerequisites?.some((prerequisite) => !existing.has(prerequisite) &&
        !runtimeTasks.some((candidate) => candidate.id === prerequisite))) {
        throw new OperationalRequestConflictError(
          `Learning task "${request.id}" has a prerequisite outside its policy snapshot.`,
        );
      }
      state.requests.push(request);
      existing.add(request.id);
      initializedRequestIds.push(request.id);
    }
    if (initializedRequestIds.length > 0) state.version += 1;
    state.initializationRequestIds[initializationKey] = {
      action: "initialize-learning-workforce-steps",
      fingerprint,
    };
    if (initializedRequestIds.length > 0 || !seen) {
      await saveState(tx, input.organizationId, input.caseId, state);
    }
    const blockingTasks = state.requests.filter(
      (request) =>
        request.mandatory !== false &&
        request.nonblocking !== true,
    );
    const workstreamBlockingComplete = Object.fromEntries(
      (["intake", "payroll", "assets", "learning"] as const).map((workstream) => {
        const scoped = blockingTasks.filter((request) => request.runtimeWorkstream === workstream);
        return [workstream, scoped.every((request) => request.status === "completed")];
      }),
    ) as WorkforceStepInitializationResult["workstreamBlockingComplete"];
    return {
      ...publicEnvelope(input.caseId, state, isSyntheticOfflineCase(caseRow)),
      active: true,
      initializedRequestIds,
      issues: compilation.issues,
      blockingTasksComplete:
        blockingTasks.length > 0 &&
        blockingTasks.every((request) => request.status === "completed"),
      workstreamBlockingComplete,
    };
  });
}

/** @deprecated Kept for the initial learning-only caller during rollout. */
export const initializeLearningWorkforceStepTasks = initializeWorkforceStepTasks;

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
  actorUserId?: string;
  organizationRole?: string;
}): Promise<OperationalRequestMutationResult> {
  assertRequestId(input.requestId);
  let pendingContinuation: string | null = null;
  const result = await withOperationalRequestLifecycleWrite({
    organizationId: input.organizationId,
    caseId: input.caseId,
  }, async (tx) => {
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
    const governanceWorkflow = governanceWorkflowForOperationalRequest(request);
    // Completing an access/asset request is a release assertion, not merely a
    // progress update. Re-evaluate the case-owned standard-operations guard
    // under the same transaction that owns this request state so a manual hold
    // or unresolved start-date impact cannot race into a completed status.
    if (
      input.action === "complete" &&
      (request.id === "access" || request.id === "assets" || request.runtimeWorkstream === "assets")
    ) {
      const standardOperations = await getStandardOperationsViewInTransaction(
        tx,
        input.organizationId,
        input.caseId,
        caseRow,
      );
      const release = request.id === "access" ? standardOperations.release.access : standardOperations.release.assets;
      if (!release.eligible) {
        throw new OperationalRequestConflictError(
          `Access/asset completion is blocked: ${release.blockers.join(" ")}`,
        );
      }
    }
    // This is server-persisted classification, not a caller-supplied bypass.
    // Local simulation records never authorize provider I/O or real readiness.
    if (!request.simulated && governanceWorkflow && ["start", "progress", "complete"].includes(input.action)) {
      const governanceGate = await evaluateStoredCaseGovernanceGate({
        caseRow,
        workflow: governanceWorkflow,
      });
      if (!governanceGate.allowed) {
        throw new OperationalRequestConflictError(
          `Live workforce action is blocked by governance: ${governanceGate.blockers.map((blocker) => blocker.kind).join(",")}.`,
        );
      }
    }
    if (request.runtimeSchemaVersion === "workforce-step-runtime/v1") {
      if (!input.actorUserId) {
        throw new OperationalRequestAuthorizationError("A signed-in tenant user is required to act on an accountable workforce task.");
      }
      const [membership] = await tx.select({ id: organizationMembershipsTable.id })
        .from(organizationMembershipsTable)
        .where(and(
          eq(organizationMembershipsTable.organizationId, input.organizationId),
          eq(organizationMembershipsTable.clerkUserId, input.actorUserId),
          isNull(organizationMembershipsTable.revokedAt),
        )).limit(1);
      if (!membership) {
        throw new OperationalRequestAuthorizationError("The signed-in user is not a member of this organization.");
      }
      const authorityScope = workforceAuthorityScope(caseRow.workforceContext);
      if (!authorityScope || request.workforceContextVersion !== caseRow.workforceContextVersion) {
        throw new OperationalRequestAuthorizationError(
          "This workforce task cannot be acted on because its current site/context scope is unknown or has changed.",
        );
      }
      if (request.assignedTo) {
        if (request.assignedTo !== input.actorUserId) {
          throw new OperationalRequestAuthorizationError("This workforce task is assigned to a different authenticated tenant user.");
        }
      } else {
        const authorities = await tx.select({
          userId: onbPolicyAuthorities.userId,
          authorityRole: onbPolicyAuthorities.authorityRole,
          site: onbPolicyAuthorities.site,
        })
          .from(onbPolicyAuthorities)
          .where(and(
            eq(onbPolicyAuthorities.organizationId, input.organizationId),
            eq(onbPolicyAuthorities.userId, input.actorUserId),
            eq(onbPolicyAuthorities.caseId, input.caseId),
            eq(onbPolicyAuthorities.itemId, request.id),
            isNull(onbPolicyAuthorities.revokedAt),
          ));
        const authority = authorities.find((candidate: {
          userId: string;
          authorityRole: string;
          site: string;
        }) =>
          candidate.site === authorityScope &&
          workforceAuthorityRoleId(candidate.authorityRole) === workforceAuthorityRoleId(request.responsibleRole ?? ""),
        );
        if (!authority) {
          throw new OperationalRequestAuthorizationError(
            "This unassigned workforce task requires a server-side authority binding for its accountable role and case.",
          );
        }
      }
    } else if (!canMutateOperationalRequests(input.organizationId, input.organizationRole)) {
      throw new OperationalRequestAuthorizationError("Organization owner or admin role required for simulated operational request mutations.");
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
    const timestamp = nowIso();
    assertWorkforceTaskAction(state, request, {
      action: input.action,
      method: input.method,
      reason: input.reason,
      expectedVersion: input.expectedVersion,
    }, timestamp);
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
    const communicationId = request.simulated
      ? await insertSimulationCommunication(tx, {
          organizationId: input.organizationId,
          caseId: input.caseId,
          request,
          status: nextStatus,
          actor: input.actor,
          requestId: input.requestId,
          reason,
          idempotencyKey: `operational:${input.caseId}:${request.id}:action:${input.requestId}`,
        })
      : null;
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
    if (isWorkforceHumanTask(request)) {
      await reconcileWorkforceStepReadiness(tx, caseRow, state);
    }
    await saveState(tx, input.organizationId, input.caseId, state);
    if (
      input.action === "complete" &&
      isWorkforceHumanTask(request) &&
      request.status === "completed"
    ) {
      pendingContinuation = continuationKey(input.caseId, input.requestId);
      await tx.insert(onbSettings).values({
        organizationId: input.organizationId,
        key: pendingContinuation,
        value: JSON.stringify({
          version: 1,
          caseId: input.caseId,
          requestId: input.requestId,
          status: "pending",
          updatedAt: nowIso(),
        }),
      }).onConflictDoUpdate({
        target: [onbSettings.organizationId, onbSettings.key],
        set: { updatedAt: sql`now()` },
      });
    }
    return {
      ...publicEnvelope(input.caseId, state, isSyntheticOfflineCase(caseRow)),
      requestId: input.operationalRequestId,
      action: input.action,
      idempotent: false,
      initializedRequestIds: [],
    };
  });
  // Completion changes the same checklist state that gates the next review.
  // Resume only after the transaction commits; the engine will independently
  // re-check all mandatory evidence and never interprets this as an LMS effect.
  if (pendingContinuation) {
    try {
      await reconcileWorkforceConnectorContinuation({
        organizationId: input.organizationId,
        caseId: input.caseId,
        requestId: input.requestId,
      });
    } catch {
      // The task transaction already committed and the failure was persisted
      // as a continuation row/event. Return the completed task rather than
      // misreporting it as a 500 or rolling its evidence into ambiguity.
      return { ...result, continuationPending: true };
    }
  }
  return { ...result, continuationPending: false };
}
