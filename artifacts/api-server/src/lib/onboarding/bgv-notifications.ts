import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq, sql } from "drizzle-orm";
import { bgvNotificationLockPool, db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbCases,
  onbCommunications,
  onbSettings,
  onbSystemChecks,
} from "@workspace/db/schema";
import {
  candidateEmailAuthorization,
  sendEmail,
  explicitlyConfiguredAddressAllowed,
} from "./channels";
import { getSetting, HR_ALERT_EMAIL_KEY, HR_APPROVER_EMAIL_KEY, isValidEmail } from "./settings";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import { isRetiredControllerCase } from "./controller-retirement";
import {
  ACTION_IDENTITY_SETTING_KEY,
  identityForRole,
  parseActionIdentityConfig,
  type NamedStakeholders,
} from "./email-identity";
import {
  claimEffectDispatch,
  ensureEffectJournalEntry,
} from "./effect-journal";
import { onbEffectJournal } from "@workspace/db/schema";
import {
  dispatchWithProviderGovernance,
  PROVIDER_GOVERNANCE_WORKFLOW,
} from "./governance-provider-boundary";
import {
  evaluateSensitiveLifecycleGate,
  jurisdictionForWorkforceContext,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

type AdvisoryClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(error?: unknown): void;
};

export const BGV_NOTIFICATION_SETTING_PREFIX = "bgv_notifications:";

export type BgvNotificationRole =
  | "hr"
  | "bgvTeam"
  | "recruiter"
  | "hiringManager"
  | "compliance"
  | "candidate";
export type BgvNotificationSource =
  | "webhook"
  | "scheduled-poll"
  | "status-email"
  | "overdue"
  | "reopened"
  | "hr-reconcile"
  | "unknown";
export type BgvNotificationProvenance =
  | "trusted-provider"
  | "human-authorized"
  | "simulated"
  | "offline"
  | "unknown";
export type BgvNotificationClassification =
  | "delay"
  | "missing-info"
  | "discrepancy"
  | "review-required";
export type BgvNotificationDeliveryState =
  | "missing-recipient"
  | "queued"
  | "sent"
  | "failed"
  | "uncertain"
  | "simulated"
  | "skipped";

type CoordinationFlags = {
  candidateActionRequired?: boolean;
  providerActionRequired?: boolean;
  startDateAtRisk?: boolean;
  coordinationRequired?: boolean;
  dependentWorkOnHold?: boolean;
};
type RecipientConfig = {
  email: string | null;
  enabled: boolean;
  purposeAuthorized: boolean;
};
type CandidateConfig = {
  enabled: boolean;
  purposeAuthorized: boolean;
};
export type BgvNotificationConfig = {
  version: number;
  flags?: CoordinationFlags;
  hr?: RecipientConfig;
  bgvTeam?: RecipientConfig;
  recruiter?: RecipientConfig;
  hiringManager?: RecipientConfig;
  compliance?: RecipientConfig;
  candidate?: CandidateConfig;
};
type EffectiveFlags = {
  delay: boolean;
  missingInfo: boolean;
  discrepancy: boolean;
  reviewRequired: boolean;
  candidateActionRequired: boolean;
  providerActionRequired: boolean;
  startDateAtRisk: boolean;
  coordinationRequired: boolean;
  dependentWorkOnHold: boolean;
};
type StoredCycle = {
  cycleId: string;
  episode: "blocked" | "release";
  source: BgvNotificationSource;
  sourceProvenance: BgvNotificationProvenance;
  classifications: BgvNotificationClassification[];
  flags: EffectiveFlags;
  createdAt: string;
  sourceVersion?: string;
  suppressRoles?: BgvNotificationRole[];
};
type StoredState = {
  version: number;
  config: BgvNotificationConfig;
  cycles: StoredCycle[];
};
type CommunicationRow = Pick<
  typeof onbCommunications.$inferSelect,
  "id" | "status" | "failureReason" | "externalMessageId" | "idempotencyKey" | "toAddress"
>;

export class BgvNotificationNotFoundError extends Error {
  constructor(message = "Case not found") {
    super(message);
    this.name = "BgvNotificationNotFoundError";
  }
}
export class BgvNotificationConflictError extends Error {
  currentVersion?: number;
  constructor(message: string, currentVersion?: number) {
    super(message);
    this.name = "BgvNotificationConflictError";
    this.currentVersion = currentVersion;
  }
}
export class BgvNotificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BgvNotificationValidationError";
  }
}

export function parseBgvNotificationUpdateBody(raw: unknown): {
  version: number;
  config: BgvNotificationConfig;
} {
  if (!raw || typeof raw !== "object") {
    throw new BgvNotificationValidationError("A notification configuration body is required.");
  }
  const body = raw as Record<string, unknown>;
  const version = body.version;
  const rawConfig = body.config;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new BgvNotificationValidationError("version must be a positive integer.");
  }
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new BgvNotificationValidationError("config is required.");
  }
  const config = rawConfig as Record<string, unknown>;
  if (!Number.isSafeInteger(config.version) || (config.version as number) < 1) {
    throw new BgvNotificationValidationError("config.version must be a positive integer.");
  }
  const flags = config.flags;
  if (flags !== undefined) {
    if (!flags || typeof flags !== "object") {
      throw new BgvNotificationValidationError("config.flags must be an object.");
    }
    for (const key of [
      "candidateActionRequired",
      "providerActionRequired",
      "startDateAtRisk",
      "coordinationRequired",
      "dependentWorkOnHold",
    ]) {
      const value = (flags as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== "boolean") {
        throw new BgvNotificationValidationError(`config.flags.${key} must be boolean.`);
      }
    }
  }
  const recipientRoles = ["hr", "bgvTeam", "recruiter", "hiringManager", "compliance"] as const;
  for (const role of recipientRoles) {
    const value = config[role];
    if (value === undefined) continue;
    if (!value || typeof value !== "object") {
      throw new BgvNotificationValidationError(`config.${role} must be an object.`);
    }
    const candidate = value as Record<string, unknown>;
    if (
      candidate.email !== undefined &&
      candidate.email !== null &&
      typeof candidate.email !== "string"
    ) {
      throw new BgvNotificationValidationError(`config.${role}.email must be a string or null.`);
    }
    if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
      throw new BgvNotificationValidationError(`config.${role}.enabled must be boolean.`);
    }
    if (
      candidate.purposeAuthorized !== undefined &&
      typeof candidate.purposeAuthorized !== "boolean"
    ) {
      throw new BgvNotificationValidationError(
        `config.${role}.purposeAuthorized must be boolean.`,
      );
    }
  }
  const candidate = config.candidate;
  if (candidate !== undefined) {
    if (!candidate || typeof candidate !== "object") {
      throw new BgvNotificationValidationError("config.candidate must be an object.");
    }
    const value = candidate as Record<string, unknown>;
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      throw new BgvNotificationValidationError("config.candidate.enabled must be boolean.");
    }
    if (
      value.purposeAuthorized !== undefined &&
      typeof value.purposeAuthorized !== "boolean"
    ) {
      throw new BgvNotificationValidationError(
        "config.candidate.purposeAuthorized must be boolean.",
      );
    }
    if ("email" in value) {
      throw new BgvNotificationValidationError("Candidate email is case-derived and cannot be configured.");
    }
  }
  return {
    version: version as number,
    config: config as BgvNotificationConfig,
  };
}

const ROLES: readonly BgvNotificationRole[] = [
  "hr",
  "bgvTeam",
  "recruiter",
  "hiringManager",
  "compliance",
  "candidate",
];
const INTERNAL_HOLDS = ["it", "payroll", "facilities"] as const;
const EMPTY_FLAGS: EffectiveFlags = {
  delay: false,
  missingInfo: false,
  discrepancy: false,
  reviewRequired: false,
  candidateActionRequired: false,
  providerActionRequired: false,
  startDateAtRisk: false,
  coordinationRequired: false,
  dependentWorkOnHold: false,
};
const nowIso = () => new Date().toISOString();
const settingKey = (caseId: number) => `${BGV_NOTIFICATION_SETTING_PREFIX}${caseId}`;
const lockKey = (organizationId: string, caseId: number) =>
  `bgv-notifications:${organizationId}:${caseId}`;

const CASE_LOCK_TIMEOUT_MS = 30_000;
const CASE_LOCK_POLL_MS = 50;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 30_000;
const caseFences = new Map<string, Promise<void>>();
const caseFenceContext = new AsyncLocalStorage<string>();

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function boundedProviderAttempt(
  sender: typeof sendEmail,
  recipient: string,
  subject: string,
  body: string,
): Promise<Awaited<ReturnType<typeof sendEmail>>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sender(recipient, subject, body),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(
          "Provider invocation exceeded the bounded 30 second window; delivery outcome is unknown.",
        )), PROVIDER_ATTEMPT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withCaseFence<T>(
  organizationId: string,
  caseId: number,
  work: () => Promise<T>,
): Promise<T> {
  const key = lockKey(organizationId, caseId);
  const previous = caseFences.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => turn);
  caseFences.set(key, queued);
  let client: AdvisoryClient | null = null;
  let acquired = false;
  try {
    await previous;
    const lockedClient = await bgvNotificationLockPool.connect();
    client = lockedClient;
    const deadline = Date.now() + CASE_LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await lockedClient.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)) as locked",
        [key],
      );
      if (result.rows[0]?.locked) {
        acquired = true;
        break;
      }
      await sleep(Math.min(CASE_LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    }
    if (!acquired) {
      throw new BgvNotificationConflictError(
        "Another BGV worker is still processing this case; retry after the bounded lock window.",
      );
    }
    return await caseFenceContext.run(key, work);
  } finally {
    let destroyClient = !acquired;
    try {
      if (acquired) {
        try {
          await client?.query("select pg_advisory_unlock(hashtext($1))", [key]);
        } catch (error) {
          // Never return a session to the pool if unlock failed: it may still
          // own the session-scoped lock.
          destroyClient = true;
          throw error;
        }
      }
    } finally {
      try {
        client?.release(destroyClient);
      } finally {
        release();
        if (caseFences.get(key) === queued) caseFences.delete(key);
      }
    }
  }
}

export function withBgvNotificationCaseFence<T>(
  organizationId: string,
  caseId: number,
  work: () => Promise<T>,
): Promise<T> {
  return withCaseFence(organizationId, caseId, work);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function stable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function validCaseId(caseId: number): void {
  if (!Number.isSafeInteger(caseId) || caseId < 1) {
    throw new BgvNotificationValidationError("Valid case id is required.");
  }
}

function defaultRecipient(
  role: Exclude<BgvNotificationRole, "candidate">,
  email: string | null,
): RecipientConfig {
  return {
    email,
    enabled: Boolean(email),
    // Existing HR alert/approver settings are an explicit purpose boundary.
    purposeAuthorized: role === "hr" && Boolean(email),
  };
}

async function defaultConfig(organizationId: string): Promise<BgvNotificationConfig> {
  const [hrAlert, hrApprover] = await Promise.all([
    getSetting(organizationId, HR_ALERT_EMAIL_KEY),
    getSetting(organizationId, HR_APPROVER_EMAIL_KEY),
  ]);
  const hr = (hrAlert ?? hrApprover ?? "").trim() || null;
  return {
    version: 1,
    flags: {},
    hr: defaultRecipient("hr", hr),
    bgvTeam: defaultRecipient("bgvTeam", null),
    recruiter: defaultRecipient("recruiter", null),
    hiringManager: defaultRecipient("hiringManager", null),
    compliance: defaultRecipient("compliance", null),
    candidate: { enabled: false, purposeAuthorized: false },
  };
}

function emptyState(config: BgvNotificationConfig): StoredState {
  return { version: 1, config: clone(config), cycles: [] };
}

function parseState(raw: string | null, config: BgvNotificationConfig): StoredState {
  if (!raw) return emptyState(config);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BgvNotificationConflictError(
      "BGV notification state is malformed; no mutation was applied.",
    );
  }
  if (!value || typeof value !== "object") {
    throw new BgvNotificationConflictError("BGV notification state is malformed; no mutation was applied.");
  }
  const candidate = value as Partial<StoredState>;
  if (
    !Number.isSafeInteger(candidate.version) ||
    (candidate.version as number) < 1 ||
    !Array.isArray(candidate.cycles)
  ) {
    throw new BgvNotificationConflictError("BGV notification state is malformed; no mutation was applied.");
  }
  const storedConfig = candidate.config && typeof candidate.config === "object"
    ? candidate.config as BgvNotificationConfig
    : config;
  const cycles = candidate.cycles as unknown[];
  const validSources = new Set<BgvNotificationSource>([
    "webhook",
    "scheduled-poll",
    "status-email",
    "overdue",
    "reopened",
    "hr-reconcile",
    "unknown",
  ]);
  const validProvenance = new Set<BgvNotificationProvenance>([
    "trusted-provider",
    "human-authorized",
    "simulated",
    "offline",
    "unknown",
  ]);
  const validClassifications = new Set<BgvNotificationClassification>([
    "delay",
    "missing-info",
    "discrepancy",
    "review-required",
  ]);
  if (cycles.some((item) => {
    if (!item || typeof item !== "object") return true;
    const cycle = item as Partial<StoredCycle>;
    return typeof cycle.cycleId !== "string" ||
      (cycle.episode !== "blocked" && cycle.episode !== "release") ||
      !validSources.has(cycle.source!) ||
      !validProvenance.has(cycle.sourceProvenance!) ||
      !Array.isArray(cycle.classifications) ||
      cycle.classifications.some((value) => !validClassifications.has(value)) ||
      !cycle.flags ||
      typeof cycle.flags !== "object" ||
      typeof cycle.createdAt !== "string" ||
      (cycle.suppressRoles !== undefined &&
        (!Array.isArray(cycle.suppressRoles) ||
          cycle.suppressRoles.some((role) => !ROLES.includes(role!))));
  })) {
    throw new BgvNotificationConflictError(
      "BGV notification state is malformed; no mutation was applied.",
    );
  }
  return {
    version: candidate.version as number,
    config: normalizeConfig(storedConfig, config, candidate.version as number),
    cycles: cycles as StoredCycle[],
  };
}

function normalizeRecipient(
  input: Partial<RecipientConfig> | undefined,
  fallback: RecipientConfig,
): RecipientConfig {
  return {
    email: input?.email === undefined ? fallback.email : input.email,
    enabled: input?.enabled === undefined ? fallback.enabled : Boolean(input.enabled),
    purposeAuthorized:
      input?.purposeAuthorized === undefined
        ? fallback.purposeAuthorized
        : Boolean(input.purposeAuthorized),
  };
}

function normalizeConfig(
  input: BgvNotificationConfig,
  fallback: BgvNotificationConfig,
  version: number,
): BgvNotificationConfig {
  const flags = { ...(fallback.flags ?? {}), ...(input.flags ?? {}) };
  return {
    version,
    flags,
    hr: normalizeRecipient(input.hr, fallback.hr!),
    bgvTeam: normalizeRecipient(input.bgvTeam, fallback.bgvTeam!),
    recruiter: normalizeRecipient(input.recruiter, fallback.recruiter!),
    hiringManager: normalizeRecipient(input.hiringManager, fallback.hiringManager!),
    compliance: normalizeRecipient(input.compliance, fallback.compliance!),
    candidate: {
      enabled: input.candidate?.enabled ?? fallback.candidate?.enabled ?? false,
      purposeAuthorized:
        input.candidate?.purposeAuthorized ??
        fallback.candidate?.purposeAuthorized ??
        false,
    },
  };
}

type NotificationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function loadLocked(
  tx: NotificationTransaction,
  organizationId: string,
  caseId: number,
): Promise<{ caseRow: typeof onbCases.$inferSelect; state: StoredState }> {
  const [caseRow] = await tx.select().from(onbCases).where(and(
    eq(onbCases.id, caseId),
    eq(onbCases.organizationId, organizationId),
  )).for("update");
  if (!caseRow) throw new BgvNotificationNotFoundError();
  const [stored] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId),
    eq(onbSettings.key, settingKey(caseId)),
  )).for("update");
  const config = await defaultConfig(organizationId);
  return { caseRow, state: parseState(stored?.value ?? null, config) };
}
async function saveState(
  tx: NotificationTransaction,
  organizationId: string,
  caseId: number,
  state: StoredState,
): Promise<void> {
  await tx.insert(onbSettings).values({
    organizationId,
    key: settingKey(caseId),
    value: JSON.stringify(state),
  }).onConflictDoUpdate({
    target: [onbSettings.organizationId, onbSettings.key],
    set: { value: JSON.stringify(state), updatedAt: sql`now()` },
  });
}

function classifyReason(reason: string): BgvNotificationClassification[] {
  const text = reason.toLowerCase();
  if (/\b(adverse|exception|discrep|unknown|review)\b/.test(text)) {
    return ["discrepancy", "review-required"];
  }
  if (/\b(missing|document|information|candidate)\b/.test(text)) return ["missing-info"];
  return ["delay"];
}

function sourceProvenance(
  requested: BgvNotificationProvenance,
  offline: boolean,
  simulation: boolean,
): BgvNotificationProvenance {
  if (offline) return "offline";
  if (simulation) return "simulated";
  return requested;
}

function makeFlags(
  classifications: BgvNotificationClassification[],
  config: BgvNotificationConfig,
  episode: "blocked" | "release",
): EffectiveFlags {
  const source: EffectiveFlags = {
    ...EMPTY_FLAGS,
    delay: episode === "blocked" && classifications.includes("delay"),
    missingInfo: episode === "blocked" && classifications.includes("missing-info"),
    discrepancy: episode === "blocked" && classifications.includes("discrepancy"),
    reviewRequired: episode === "blocked" && classifications.includes("review-required"),
  };
  const safe = config.flags ?? {};
  return {
    ...source,
    candidateActionRequired: Boolean(safe.candidateActionRequired),
    providerActionRequired:
      Boolean(safe.providerActionRequired) ||
      (episode === "blocked" && (source.delay || source.missingInfo)),
    startDateAtRisk: Boolean(safe.startDateAtRisk),
    coordinationRequired: Boolean(safe.coordinationRequired),
    dependentWorkOnHold:
      Boolean(safe.dependentWorkOnHold) || episode === "blocked",
  };
}

function createCycle(
  state: StoredState,
  episode: "blocked" | "release",
  source: BgvNotificationSource,
  provenance: BgvNotificationProvenance,
  classifications: BgvNotificationClassification[],
): StoredCycle {
  const sequence = state.cycles.length + 1;
  const cycle: StoredCycle = {
    cycleId: `bgv-cycle-${sequence}-${randomUUID().slice(0, 8)}`,
    episode,
    source,
    sourceProvenance: provenance,
    classifications,
    flags: makeFlags(classifications, state.config, episode),
    createdAt: nowIso(),
  };
  state.cycles.unshift(cycle);
  return cycle;
}

function currentCycle(state: StoredState): StoredCycle | null {
  return state.cycles[0] ?? null;
}

function sourceVersionOf(check: Pick<
  typeof onbSystemChecks.$inferSelect,
  "id" | "status" | "lastCheckedAt" | "note"
> | undefined): string | undefined {
  if (!check) return undefined;
  return `${check.id}:${check.status}:${check.lastCheckedAt?.toISOString() ?? ""}:${check.note ?? ""}`;
}

function isLiveSource(cycle: StoredCycle, role: BgvNotificationRole): boolean {
  if (cycle.sourceProvenance === "trusted-provider") return true;
  // An unknown legacy source can only be used for a narrowly scoped HR
  // coordination notice after HR explicitly records that purpose.
  return cycle.sourceProvenance === "human-authorized" && role === "hr";
}

function roleIncluded(
  role: BgvNotificationRole,
  cycle: StoredCycle,
): boolean {
  if (cycle.suppressRoles?.includes(role)) return false;
  if (role === "hr") return true;
  if (role === "bgvTeam") return cycle.flags.providerActionRequired;
  if (role === "candidate") return cycle.flags.candidateActionRequired;
  if (role === "compliance") return cycle.flags.discrepancy || cycle.flags.reviewRequired;
  if (role === "hiringManager") return cycle.flags.startDateAtRisk;
  return cycle.flags.startDateAtRisk || cycle.flags.coordinationRequired;
}

function roleConfig(
  role: BgvNotificationRole,
  config: BgvNotificationConfig,
  caseRow: typeof onbCases.$inferSelect,
): { email: string | null; enabled: boolean; purposeAuthorized: boolean } {
  if (role === "candidate") {
    return {
      email: caseRow.workerEmail,
      enabled: config.candidate?.enabled ?? false,
      purposeAuthorized: config.candidate?.purposeAuthorized ?? false,
    };
  }
  const value = config[role] as RecipientConfig | undefined;
  return {
    email: value?.email ?? null,
    enabled: value?.enabled ?? false,
    purposeAuthorized: value?.purposeAuthorized ?? false,
  };
}

async function namedStakeholdersForOrganization(
  organizationId: string,
): Promise<NamedStakeholders> {
  const [row] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId),
    eq(onbSettings.key, ACTION_IDENTITY_SETTING_KEY),
  ));
  return parseActionIdentityConfig(row?.value ?? null).stakeholders;
}

function roleLabel(role: BgvNotificationRole): string {
  return {
    hr: "HR / onboarding",
    bgvTeam: "BGV provider / verification team",
    recruiter: "Recruiter",
    hiringManager: "Hiring manager",
    compliance: "Compliance / restricted review",
    candidate: "Candidate / employee",
  }[role];
}

function stakeholderFor(
  role: BgvNotificationRole,
  c: typeof onbCases.$inferSelect,
  namedStakeholders: NamedStakeholders = {},
) {
  const existingName = role === "recruiter"
    ? c.recruiterName
    : role === "hiringManager"
      ? c.managerName
      : role === "candidate"
        ? c.workerName
        : null;
  const identity = identityForRole(role, namedStakeholders, existingName, roleLabel(role));
  return {
    ...identity,
    // Action Center identities use the role key as their storage shape. Use
    // the human-readable copy role unless a caller supplied a richer role.
    role: namedStakeholders[role]?.role &&
      namedStakeholders[role]?.role !== role
      ? namedStakeholders[role]!.role
      : roleLabel(role),
  };
}

function roleDisplayName(
  role: BgvNotificationRole,
  c: typeof onbCases.$inferSelect,
  namedStakeholders: NamedStakeholders = {},
): string {
  const stakeholder = stakeholderFor(role, c, namedStakeholders);
  return stakeholder.name || roleLabel(role);
}
function rolePurpose(role: BgvNotificationRole, cycle: StoredCycle): string {
  if (cycle.episode === "release") return "Generic onboarding hold release coordination";
  return {
    hr: "Human HR coordination for a BGV block",
    bgvTeam: "Simulated provider action request",
    recruiter: "Recruiter coordination and start-date risk",
    hiringManager: "Hiring-manager coordination and start-date risk",
    compliance: "Restricted discrepancy and human review coordination",
    candidate: "Candidate action or document request through the secure portal",
  }[role];
}

/**
 * BGV notices deliberately do not use the normal email identity footer: it
 * repeats display names and delivery addresses in the message body. The
 * recipient is authorized separately, but this BGV message may contain only
 * its generic case/reference and bounded action language.
 */
function boundedBgvNoticeLines(
  caseId: number,
  reference: string,
  actionRequired: string,
  simulated = false,
): string[] {
  return [
    simulated
      ? "SIMULATED ONLY — no external provider action was sent."
      : "This notice contains only a generic onboarding case reference.",
    `Action required: ${actionRequired}`,
    `Reference: ${reference}`,
    `Secure case reference: Case #${caseId}`,
  ];
}

function copyFor(
  role: BgvNotificationRole,
  cycle: StoredCycle,
  c: typeof onbCases.$inferSelect,
): { subject: string; body: string } {
  const caseReference = `Case #${c.id}`;
  const reference = `BGV-${c.id}-${cycle.cycleId}`;
  const release = cycle.episode === "release";
  const actionRequired = release
    ? role === "candidate"
      ? "Continue the onboarding checklist or contact HR for next steps."
      : "Review the existing case and coordinate with HR; no system release is implied."
    : role === "candidate"
      ? "Use the secure onboarding portal or contact HR to provide the requested information."
      : role === "bgvTeam"
        ? "Review the provider case through the authorized workflow and update its status (simulation only)."
        : "Review the existing case and coordinate with HR; no automated employment decision was made.";
  if (release) {
    const body =
      role === "candidate"
        ? `${caseReference}: A generic onboarding hold was released. Please continue using the secure onboarding portal or contact HR for next steps. This is not an employment clearance.`
        : `${caseReference}: A generic onboarding hold was released. Review the existing onboarding case or contact HR for next steps. This is not an employment clearance or an automated employment decision.`;
    return {
      subject: `Onboarding hold update — ${caseReference}`,
      body: [
        body,
        "",
        ...boundedBgvNoticeLines(c.id, reference, actionRequired),
      ].join("\n"),
    };
  }
  const body = {
    hr: `${caseReference}: This onboarding case requires human HR review. The case remains on a generic hold pending review. Review the existing case and coordinate the HR review. No finding details are included and no automated employment decision was made.`,
    bgvTeam: `${caseReference}: SIMULATED ONLY: please review the existing provider case through the authorized provider workflow and update the status. No provider action was sent.`,
    recruiter: `${caseReference}: Please coordinate with HR about a generic onboarding hold and any operational timing impact. Review the existing onboarding case with HR. No finding details are included in this notice.`,
    hiringManager: `${caseReference}: Please coordinate with HR about a generic onboarding hold and any operational timing impact. Review the existing onboarding case with HR. No finding details are included in this notice.`,
    compliance: `${caseReference}: A restricted case state requires human review. Review the existing case through the authorized restricted review process and coordinate with HR. This notice contains no raw finding and makes no automated employment decision.`,
    candidate: `${caseReference}: Please use the secure onboarding portal or contact HR to provide the requested information. This notice does not describe a discrepancy or adverse finding.`,
  }[role];
  return {
    subject: role === "compliance"
      ? `Onboarding case review required — ${caseReference}`
      : `Onboarding case update — ${caseReference}`,
    body: [
      body,
      "",
      ...boundedBgvNoticeLines(c.id, reference, actionRequired),
    ].join("\n"),
  };
}

function internalCopy(
  internal: (typeof INTERNAL_HOLDS)[number],
  episode: "blocked" | "release",
  caseId: number,
): { subject: string; body: string } {
  const caseReference = `Case #${caseId}`;
  const reference = `BGV-${caseId}-${internal}`;
  if (episode === "release") {
    return {
      subject: `Simulated generic onboarding hold release — ${caseReference}`,
      body: [
        `${caseReference}: generic ${internal} onboarding hold/release coordination was recorded. No external ${internal} system was changed and this does not represent employment clearance.`,
        "",
        ...boundedBgvNoticeLines(
          caseId,
          reference,
          `Review the simulated ${internal} coordination only; no external system was changed.`,
          true,
        ),
      ].join("\n"),
    };
  }
  return {
    subject: `Simulated generic onboarding hold — ${caseReference}`,
    body: [
      `${caseReference}: generic ${internal} onboarding work is held while a BGV case receives human review. No finding details, employee decision, or external ${internal} action is included.`,
      "",
      ...boundedBgvNoticeLines(
        caseId,
        reference,
        `Record and review the simulated ${internal} hold only; no external system was changed.`,
        true,
      ),
    ].join("\n"),
  };
}

async function communicationsFor(
  organizationId: string,
  caseId: number,
  cycleId: string,
): Promise<CommunicationRow[]> {
  return db.select({
    id: onbCommunications.id,
    status: onbCommunications.status,
    failureReason: onbCommunications.failureReason,
    externalMessageId: onbCommunications.externalMessageId,
    idempotencyKey: onbCommunications.idempotencyKey,
    toAddress: onbCommunications.toAddress,
  }).from(onbCommunications).where(and(
    eq(onbCommunications.organizationId, organizationId),
    eq(onbCommunications.caseId, caseId),
    sql`${onbCommunications.idempotencyKey} like ${`bgv:${caseId}:${cycleId}:%`}`,
  ));
}

async function dispatchFenceValid(input: {
  organizationId: string;
  caseId: number;
  cycleId: string;
  episode: "blocked" | "release";
  configVersion: number;
  role: BgvNotificationRole;
  recipient: string;
}): Promise<boolean> {
  const [caseRow] = await db.select().from(onbCases).where(and(
    eq(onbCases.id, input.caseId),
    eq(onbCases.organizationId, input.organizationId),
  ));
  if (!caseRow) return false;
  const [check] = await db.select({
    id: onbSystemChecks.id,
    status: onbSystemChecks.status,
    lastCheckedAt: onbSystemChecks.lastCheckedAt,
    note: onbSystemChecks.note,
  }).from(onbSystemChecks).where(and(
    eq(onbSystemChecks.organizationId, input.organizationId),
    eq(onbSystemChecks.caseId, input.caseId),
    eq(onbSystemChecks.system, "bgv"),
  )).orderBy(desc(onbSystemChecks.id)).limit(1);
  // A blocked notice is only authoritative while BGV remains overdue, and a
  // release only after completion. This recheck fences a clear/release that
  // committed in another process before the external attempt began.
  if (check && (
    input.episode === "blocked"
      ? check.status !== "overdue"
      : check.status !== "done"
  )) return false;
  const [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, input.organizationId),
    eq(onbSettings.key, settingKey(input.caseId)),
  ));
  const state = parseState(stored?.value ?? null, await defaultConfig(input.organizationId));
  const cycle = currentCycle(state);
  if (!cycle || cycle.cycleId !== input.cycleId || state.version !== input.configVersion) return false;
  if (cycle.sourceVersion && cycle.sourceVersion !== sourceVersionOf(check)) return false;
  const candidateAuthorized = candidateEmailAuthorization(caseRow).allowed;
  if (!roleIncluded(input.role, cycle)) return false;
  const rc = roleConfig(input.role, state.config, caseRow);
  if (rc.email !== input.recipient) return false;
  return liveReason(cycle, input.role, rc, candidateAuthorized, state.config) === "authorized";
}

function deliveryState(row: CommunicationRow | undefined): BgvNotificationDeliveryState {
  if (!row) return "queued";
  if (row.status === "sent" || row.status === "delivered") return "sent";
  if (row.status === "simulated") return "simulated";
  if (row.status === "sending" || row.status === "uncertain") return "uncertain";
  if (row.status === "failed") return "failed";
  return "skipped";
}

function relatedCommunicationRows(
  rows: CommunicationRow[],
  key: string,
): CommunicationRow[] {
  return rows.filter((row) =>
    row.idempotencyKey === key ||
    row.idempotencyKey === `${key}:simulation` ||
    row.idempotencyKey === `${key}:live`);
}

function configEmailIsValid(value: string | null | undefined): boolean {
  return value === undefined || value === null || (isValidEmail(value) && value.length <= 320);
}

function liveReason(
  cycle: StoredCycle,
  role: BgvNotificationRole,
  rc: { email: string | null; enabled: boolean; purposeAuthorized: boolean },
  candidateAuthorized: boolean,
  config?: BgvNotificationConfig,
): string {
  if (!rc.email) return "missing-recipient";
  if (!rc.enabled || !rc.purposeAuthorized) return "live-authorization-required";
  if (role === "candidate" && !candidateAuthorized) return "candidate-email-authorization-required";
  if (
    cycle.sourceProvenance === "human-authorized" &&
    role === "hr" &&
    config?.flags?.coordinationRequired !== true
  ) {
    return "live-authorization-required";
  }
  const explicitHumanCoordination =
    cycle.sourceProvenance === "unknown" &&
    role === "hr" &&
    config?.flags?.coordinationRequired === true &&
    rc.purposeAuthorized;
  if (!isLiveSource(cycle, role) && !explicitHumanCoordination) {
    return "live-authorization-required";
  }
  if (!explicitlyConfiguredAddressAllowed(rc.email)) return "sender-allowlist-required";
  return "authorized";
}

function plannedRecipient(
  role: BgvNotificationRole,
  cycle: StoredCycle,
  c: typeof onbCases.$inferSelect,
  config: BgvNotificationConfig,
  candidateAuthorized: boolean,
  rows: CommunicationRow[],
  namedStakeholders: NamedStakeholders = {},
) {
  const rc = roleConfig(role, config, c);
  const stakeholder = stakeholderFor(role, c, namedStakeholders);
  const suppressed = cycle.suppressRoles?.includes(role) ?? false;
  const required = roleIncluded(role, cycle);
  const key = `bgv:${c.id}:${cycle.cycleId}:${role}:purpose`;
  const relatedRows = relatedCommunicationRows(rows, key);
  const row = relatedRows.find((candidate) => candidate.idempotencyKey === `${key}:live`) ??
    relatedRows.find((candidate) => candidate.idempotencyKey === key) ??
    relatedRows.find((candidate) => candidate.idempotencyKey === `${key}:simulation`);
  const reason = suppressed
    ? "already-notified"
    : !required
    ? "not-planned"
    : liveReason(cycle, role, rc, candidateAuthorized, config);
  let state = deliveryState(row);
  if (required && !row && reason === "missing-recipient") state = "missing-recipient";
  if (required && !row && reason !== "missing-recipient" && reason !== "authorized") state = "skipped";
  return {
    role,
    displayName: roleDisplayName(role, c, namedStakeholders),
    stakeholderName: stakeholder.name || null,
    stakeholderRole: stakeholder.role,
    email: row?.toAddress ?? rc.email,
    deliveryAddress: rc.email,
    configured: Boolean(rc.email),
    purpose: rolePurpose(role, cycle),
    actualDeliveryState: required ? state : "skipped" as const,
    communicationIds: relatedRows.map((candidate) => candidate.id),
    liveSendAuthorized: required && reason === "authorized" && role !== "bgvTeam",
    reason,
  };
}

function publicCycle(
  cycle: StoredCycle,
  c: typeof onbCases.$inferSelect,
  config: BgvNotificationConfig,
  rows: CommunicationRow[],
  namedStakeholders: NamedStakeholders = {},
) {
  const candidate = candidateEmailAuthorization(c).allowed;
  return {
    cycleId: cycle.cycleId,
    episode: cycle.episode,
    source: cycle.source,
    sourceProvenance: cycle.sourceProvenance,
    classifications: cycle.classifications,
    flags: cycle.flags,
    createdAt: cycle.createdAt,
    ...(cycle.sourceVersion ? { sourceVersion: cycle.sourceVersion } : {}),
    ...(cycle.suppressRoles ? { suppressRoles: cycle.suppressRoles } : {}),
    notifications: ROLES.map((role) =>
      plannedRecipient(role, cycle, c, config, candidate, rows, namedStakeholders),
    ).filter((row) => row.reason !== "not-planned"),
  };
}

function policy() {
  return {
    explanation:
      "BGV notices use allowlisted, purpose-authorized coordination copy only. Raw provider findings are never exposed, sensitive states require human review, and no notice changes BGV authority or makes an employment decision.",
    rawFindingsExposed: false as const,
    automaticEmploymentDecision: false as const,
    bGVClearAuthorityChanged: false as const,
  };
}

async function envelope(
  organizationId: string,
  caseId: number,
  role: string | undefined,
): Promise<PublicEnvelope> {
  validCaseId(caseId);
  const [caseRow] = await db.select().from(onbCases).where(and(
    eq(onbCases.id, caseId),
    eq(onbCases.organizationId, organizationId),
  ));
  if (!caseRow) throw new BgvNotificationNotFoundError();
  const stored = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId),
    eq(onbSettings.key, settingKey(caseId)),
  ));
  const state = parseState(stored[0]?.value ?? null, await defaultConfig(organizationId));
  const namedStakeholders = await namedStakeholdersForOrganization(organizationId);
  const cycles = await Promise.all(state.cycles.map(async (cycle) => ({
    ...publicCycle(
      cycle,
      caseRow,
      state.config,
      await communicationsFor(organizationId, caseId, cycle.cycleId),
      namedStakeholders,
    ),
  })));
  const authorityCanManage =
    role === "owner" ||
    role === "admin" ||
    (organizationId === DEMO_ORGANIZATION_ID && role === "member");
  const offline = isSyntheticOfflineCase(caseRow);
  const current = state.cycles[0] ? cycles[0] : null;
  return {
    caseId,
    version: state.version,
    config: state.config,
    authority: {
      canManage: authorityCanManage,
      offline,
      reason: authorityCanManage
        ? offline
          ? "Paused offline case is read-only."
          : organizationId === DEMO_ORGANIZATION_ID
            ? "Demo notifications are simulation-only."
          : null
        : "Owner or admin HR role required to manage real-tenant recipients.",
    },
    effectiveFlags: current?.flags ?? {
      ...EMPTY_FLAGS,
      ...Object.fromEntries(
        Object.entries(state.config.flags ?? {}).map(([key, value]) => [key, Boolean(value)]),
      ),
    },
    currentCycle: current,
    cycles,
    policy: policy(),
  };
}

type PublicEnvelope = {
  caseId: number;
  version: number;
  config: BgvNotificationConfig;
  authority: { canManage: boolean; offline: boolean; reason: string | null };
  effectiveFlags: EffectiveFlags;
  currentCycle: unknown;
  cycles: unknown[];
  policy: ReturnType<typeof policy>;
};

export function canManageBgvNotifications(
  organizationId: string,
  role: string | undefined,
): boolean {
  return role === "owner" || role === "admin" ||
    (organizationId === DEMO_ORGANIZATION_ID && role === "member");
}

export async function getBgvNotifications(input: {
  organizationId: string;
  caseId: number;
  role?: string;
}): Promise<PublicEnvelope> {
  return envelope(input.organizationId, input.caseId, input.role);
}

function validateConfig(config: BgvNotificationConfig): void {
  for (const role of ["hr", "bgvTeam", "recruiter", "hiringManager", "compliance"] as const) {
    const rc = config[role];
    if (!rc) continue;
    if (!configEmailIsValid(rc.email)) {
      throw new BgvNotificationValidationError(`A valid email is required for ${role}.`);
    }
  }
}

export async function updateBgvNotifications(input: {
  organizationId: string;
  caseId: number;
  role?: string;
  version: number;
  config: BgvNotificationConfig;
}): Promise<PublicEnvelope> {
  validCaseId(input.caseId);
  if (!canManageBgvNotifications(input.organizationId, input.role)) {
    throw new BgvNotificationConflictError(
      "Owner or admin HR role required for real-tenant BGV recipient configuration.",
    );
  }
  validateConfig(input.config);
  await withCaseFence(input.organizationId, input.caseId, async () => {
    await db.transaction(async (tx) => {
      const loaded = await loadLocked(tx, input.organizationId, input.caseId);
      if (isSyntheticOfflineCase(loaded.caseRow) || isRetiredControllerCase(loaded.caseRow)) {
        throw new BgvNotificationConflictError(
          "Paused offline cases are read-only; resume the case before changing BGV notifications.",
        );
      }
      if (!Number.isSafeInteger(input.version) || input.version !== loaded.state.version) {
        throw new BgvNotificationConflictError(
          `BGV notification configuration changed since it was loaded (current version ${loaded.state.version}).`,
          loaded.state.version,
        );
      }
      if (input.config.version !== input.version) {
        throw new BgvNotificationConflictError(
          `config.version must equal the current version ${loaded.state.version}.`,
          loaded.state.version,
        );
      }
      loaded.state.version += 1;
      loaded.state.config = normalizeConfig(input.config, loaded.state.config, loaded.state.version);
      // Source-derived discrepancy/review flags are reconstructed from each
      // cycle and can never be removed by coordination metadata.
      for (const cycle of loaded.state.cycles) {
        cycle.flags = makeFlags(cycle.classifications, loaded.state.config, cycle.episode);
        if (
          cycle.sourceProvenance === "unknown" &&
          loaded.state.config.flags?.coordinationRequired === true &&
          loaded.state.config.hr?.purposeAuthorized === true
        ) {
          cycle.sourceProvenance = "human-authorized";
        }
      }
      await saveState(tx, input.organizationId, input.caseId, loaded.state);
    });
  });
  return getBgvNotifications(input);
}

async function insertSimulated(
  organizationId: string,
  caseId: number,
  key: string,
  toAddress: string,
  subject: string,
  body: string,
): Promise<number | null> {
  return withBgvCollectionFence(organizationId, caseId, async () => {
  const [row] = await db.insert(onbCommunications).values({
    organizationId,
    caseId,
    channel: "email",
    direction: "outbound",
    audience: "admin",
    toAddress,
    subject,
    body,
    status: "simulated",
    failureReason: "Simulation only; no external message was sent.",
    sensitive: true,
    sensitiveDataClass: "bgv",
    idempotencyKey: key,
  }).onConflictDoNothing({
    target: [onbCommunications.organizationId, onbCommunications.idempotencyKey],
  }).returning({ id: onbCommunications.id });
  if (row) return row.id;
  const [existing] = await db.select({ id: onbCommunications.id }).from(onbCommunications).where(and(
    eq(onbCommunications.organizationId, organizationId),
    eq(onbCommunications.idempotencyKey, key),
  ));
  if (!existing) throw new Error("Simulated BGV communication claim disappeared.");
  return existing.id;
  });
}

async function insertSkipped(
  organizationId: string,
  caseId: number,
  key: string,
  toAddress: string,
  subject: string,
  body: string,
): Promise<number | null> {
  return withBgvCollectionFence(organizationId, caseId, async () => {
  const [row] = await db.insert(onbCommunications).values({
    organizationId,
    caseId,
    channel: "email",
    direction: "outbound",
    audience: "admin",
    toAddress,
    subject,
    body,
    status: "skipped",
    failureReason: body,
    sensitive: true,
    sensitiveDataClass: "bgv",
    idempotencyKey: key,
  }).onConflictDoNothing({
    target: [onbCommunications.organizationId, onbCommunications.idempotencyKey],
  }).returning({ id: onbCommunications.id });
  if (row) return row.id;
  const [existing] = await db.select({ id: onbCommunications.id }).from(onbCommunications).where(and(
    eq(onbCommunications.organizationId, organizationId),
    eq(onbCommunications.idempotencyKey, key),
  ));
  if (!existing) throw new Error("Skipped BGV communication claim disappeared.");
  return existing.id;
  });
}

/** Gate BGV collection itself, not just the later Gmail disclosure. */
async function withBgvCollectionFence<T>(
  organizationId: string,
  caseId: number,
  write: () => Promise<T>,
): Promise<T> {
  return withSensitiveLifecycleFence(organizationId, async () => {
    const [caseRow] = await db.select({
      workforceContext: onbCases.workforceContext,
    }).from(onbCases).where(and(
      eq(onbCases.organizationId, organizationId),
      eq(onbCases.id, caseId),
    ));
    if (!caseRow) return null as T;
    const lifecycle = await evaluateSensitiveLifecycleGate({
      organizationId,
      jurisdiction: jurisdictionForWorkforceContext(caseRow.workforceContext),
      dataClass: "bgv",
      disclosure: false,
    });
    if (!lifecycle.allowed) {
      return null as T;
    }
    return write();
  });
}

async function dispatchEmail(
  organizationId: string,
  caseId: number,
  key: string,
  recipient: string,
  subject: string,
  body: string,
  retryFailed: boolean,
  caseRow: typeof onbCases.$inferSelect,
  sender: typeof sendEmail = sendEmail,
  fence?: {
    cycleId: string;
    episode: "blocked" | "release";
    configVersion: number;
    role: BgvNotificationRole;
  },
): Promise<{ id: number; status: BgvNotificationDeliveryState; failureReason: string | null }> {
  // This row itself is sensitive BGV collection, independently of whether a
  // later Gmail dispatch is approved. Keep the class-specific lifecycle
  // decision and its first durable write under the same fence.
  let collectionDeniedReason: string | null = null;
  const inserted = await withSensitiveLifecycleFence(organizationId, async () => {
    const lifecycle = await evaluateSensitiveLifecycleGate({
      organizationId,
      jurisdiction: jurisdictionForWorkforceContext(caseRow.workforceContext),
      dataClass: "bgv",
      disclosure: false,
    });
    if (!lifecycle.allowed) {
      collectionDeniedReason = lifecycle.reason ?? "BGV communication collection is blocked by the sensitive lifecycle policy.";
      return undefined;
    }
    const [row] = await db.insert(onbCommunications).values({
      organizationId,
      caseId,
      channel: "email",
      direction: "outbound",
      audience: "admin",
      toAddress: recipient,
      subject,
      body,
      status: "queued",
      failureReason: null,
      sensitive: true,
      sensitiveDataClass: "bgv",
      idempotencyKey: key,
    }).onConflictDoNothing({
      target: [onbCommunications.organizationId, onbCommunications.idempotencyKey],
    }).returning({ id: onbCommunications.id });
    return row;
  });
  if (collectionDeniedReason) {
    return { id: 0, status: "skipped", failureReason: collectionDeniedReason };
  }
  let row = inserted;
  if (!row) {
    const [existing] = await db.select().from(onbCommunications).where(and(
      eq(onbCommunications.organizationId, organizationId),
      eq(onbCommunications.idempotencyKey, key),
    ));
    if (!existing) throw new Error("BGV communication claim disappeared.");
    if (existing.status === "sent") {
      return { id: existing.id, status: deliveryState(existing), failureReason: existing.failureReason };
    }
    if (existing.status === "uncertain" || existing.status === "sending") {
      return { id: existing.id, status: "uncertain", failureReason: existing.failureReason };
    }
    if (!["failed", "skipped", "logged-only", "simulated"].includes(existing.status) || !retryFailed) {
      return { id: existing.id, status: deliveryState(existing), failureReason: existing.failureReason };
    }
    const [claimed] = await db.update(onbCommunications).set({
      status: "sending",
      failureReason: "Retry claimed; awaiting Gmail result.",
      toAddress: recipient,
      subject,
      body,
    }).where(and(
      eq(onbCommunications.id, existing.id),
      sql`${onbCommunications.status} in ('failed', 'skipped', 'logged-only', 'simulated')`,
    )).returning({ id: onbCommunications.id });
    if (!claimed) return { id: existing.id, status: "uncertain", failureReason: "Another worker owns this delivery." };
    row = claimed;
  } else {
    const [claimed] = await db.update(onbCommunications).set({
      status: "sending",
      failureReason: null,
    }).where(and(
      eq(onbCommunications.id, row.id),
      eq(onbCommunications.status, "queued"),
    )).returning({ id: onbCommunications.id });
    if (!claimed) return { id: row.id, status: "uncertain", failureReason: "Another worker owns this delivery." };
    row = claimed;
  }
  const identity = {
    logicalOperationKey: `bgv-notification:${key}`,
    organizationId,
    tenantId: organizationId,
    caseId,
    toolName: "send-bgv-notification",
    argumentsHash: stable({ recipient, subject, body }),
    providerIdempotency: false,
  };
  const entry = await ensureEffectJournalEntry(identity);
  const owner = randomUUID();
  const claim = await claimEffectDispatch({
    ...identity,
    owner,
    expectedFencingToken: entry.fencingToken,
  });
  if (claim.kind !== "claimed") {
    const reason = claim.kind === "manual_repair_required"
      ? "Delivery outcome unknown; manual reconciliation required. Automatic resend is disabled."
      : "Delivery is currently owned by another worker.";
    await db.update(onbCommunications).set({
      status: "uncertain",
      failureReason: reason,
    }).where(eq(onbCommunications.id, row.id));
    return { id: row.id, status: "uncertain", failureReason: reason };
  }
  if (fence && !(await dispatchFenceValid({
    organizationId,
    caseId,
    cycleId: fence.cycleId,
    episode: fence.episode,
    configVersion: fence.configVersion,
    role: fence.role,
    recipient,
  }))) {
    const reason = "Current BGV cycle, check status, or recipient authorization changed before external dispatch.";
    await db.transaction(async (tx) => {
      await tx.update(onbEffectJournal).set({
        status: "failed",
        claimUntil: null,
        lastError: reason,
        updatedAt: sql`now()`,
      }).where(and(
        eq(onbEffectJournal.logicalOperationKey, identity.logicalOperationKey),
        eq(onbEffectJournal.organizationId, organizationId),
        eq(onbEffectJournal.status, "dispatching"),
        eq(onbEffectJournal.claimOwner, owner),
        eq(onbEffectJournal.fencingToken, claim.fencingToken),
      ));
      await tx.update(onbCommunications).set({
        status: "skipped",
        failureReason: reason,
      }).where(eq(onbCommunications.id, row.id));
    });
    return { id: row.id, status: "skipped", failureReason: reason };
  }
  let result: Awaited<ReturnType<typeof sendEmail>>;
  try {
    // The injected sender is still an external effect. It must not bypass the
    // final provider boundary used by the direct Gmail sender: current
    // governance and the BGV lifecycle policy must approve this exact Gmail
    // disclosure after the durable dispatch claim and immediately before I/O.
    // Re-read the case at the final boundary. Besides making a deleted or
    // re-scoped case fail closed, this supplies the current jurisdiction to
    // the exact provider-policy evaluation rather than relying on an earlier
    // reconciliation snapshot.
    const [currentCase] = await db.select().from(onbCases).where(and(
      eq(onbCases.id, caseId),
      eq(onbCases.organizationId, organizationId),
    ));
    if (!currentCase) {
      result = {
        status: "logged-only",
        failureReason: "Case is no longer available for external BGV notification dispatch.",
        externalMessageId: null,
      };
    } else {
      const finalDispatch = await dispatchWithProviderGovernance({
        caseRow: currentCase,
        workflow: PROVIDER_GOVERNANCE_WORKFLOW.communication,
        operation: `bgv-email:${caseId}:${key}`,
        providerId: "gmail",
        dataClass: "bgv",
        dispatch: () => boundedProviderAttempt(sender, recipient, subject, body),
        disposition: (value) => value.status === "sending"
          ? "unknown"
          : value.status === "sent" || value.status === "delivered"
            ? "sent"
            : "definitive-not-sent",
      });
      result = finalDispatch.dispatched
        ? finalDispatch.value
        : {
            status: "logged-only",
            failureReason: finalDispatch.reason,
            externalMessageId: null,
          };
    }
  } catch (error) {
    result = {
      status: "sending",
      failureReason: `Delivery outcome unknown: ${String(error).slice(0, 240)}. Do not retry automatically.`,
      externalMessageId: null,
    };
  }
  const uncertain = result.status === "sending";
  const status: BgvNotificationDeliveryState = uncertain
    ? "uncertain"
    : result.status === "sent"
      ? "sent"
      : result.status === "logged-only"
        ? "skipped"
        : "failed";
  const persistedStatus = result.status === "logged-only" ? "logged-only" : status;
  const committed = await db.transaction(async (tx) => {
    const [effect] = await tx.update(onbEffectJournal).set(uncertain
      ? {
          status: "unknown_effect_manual_repair",
          lastError: result.failureReason,
          claimUntil: null,
          updatedAt: sql`now()`,
        }
      : {
          status: result.status === "sent" ? "confirmed" : "failed",
          externalEffectId: result.externalMessageId,
          confirmedAt: result.status === "sent" ? sql`now()` : null,
          claimUntil: null,
          lastError: result.status === "sent" ? null : result.failureReason,
          updatedAt: sql`now()`,
        }).where(and(
      eq(onbEffectJournal.logicalOperationKey, identity.logicalOperationKey),
      eq(onbEffectJournal.organizationId, organizationId),
      eq(onbEffectJournal.status, "dispatching"),
      eq(onbEffectJournal.claimOwner, owner),
      eq(onbEffectJournal.fencingToken, claim.fencingToken),
    )).returning({ key: onbEffectJournal.logicalOperationKey });
    if (!effect) return false;
    await tx.update(onbCommunications).set({
      status: persistedStatus,
      failureReason: result.failureReason,
      externalMessageId: result.externalMessageId,
    }).where(eq(onbCommunications.id, row.id));
    return true;
  });
  return committed
    ? { id: row.id, status, failureReason: result.failureReason }
    : { id: row.id, status: "uncertain", failureReason: "Dispatch claim expired; manual reconciliation required." };
}

async function reconcileCycle(
  organizationId: string,
  caseId: number,
  cycle: StoredCycle,
  state: StoredState,
  caseRow: typeof onbCases.$inferSelect,
  explicitSimulation: boolean,
  expectedConfigVersion: number,
  sender?: typeof sendEmail,
): Promise<{ created: number[]; retried: number[]; skipped: number[] }> {
  const created: number[] = [];
  const retried: number[] = [];
  const skipped: number[] = [];
  if (isRetiredControllerCase(caseRow)) return { created, retried, skipped };
  const candidateAuthorized = candidateEmailAuthorization(caseRow).allowed;
  const namedStakeholders = await namedStakeholdersForOrganization(organizationId);
  const simulatedBase = explicitSimulation ||
    cycle.sourceProvenance === "simulated" ||
    cycle.sourceProvenance === "offline" ||
    isSyntheticOfflineCase(caseRow) ||
    organizationId === DEMO_ORGANIZATION_ID;
  const rows = await communicationsFor(organizationId, caseId, cycle.cycleId);
  for (const role of ROLES) {
    if (!roleIncluded(role, cycle)) continue;
    const rc = roleConfig(role, state.config, caseRow);
    const key = `bgv:${caseId}:${cycle.cycleId}:${role}:purpose`;
    const simulatedDelivery = simulatedBase || role === "bgvTeam";
    let deliveryKey = simulatedDelivery ? `${key}:simulation` : key;
    let existing = rows.find((row) => row.idempotencyKey === deliveryKey);
    // Do not repurpose legacy simulated/logged-only rows that used the live
    // key before simulation delivery keys were separated.
    if (!simulatedDelivery &&
      existing &&
      (existing.status === "simulated" || existing.status === "logged-only")) {
      deliveryKey = `${key}:live`;
      existing = rows.find((row) => row.idempotencyKey === deliveryKey);
    }
    if (existing?.status === "uncertain" || existing?.status === "sending") {
      skipped.push(existing.id);
      continue;
    }
    if (!rc.email) {
      // Missing recipients stay visibly missing; no communication row is
      // fabricated merely to make configuration look delivered.
      continue;
    }
    if (!rc.enabled || !rc.purposeAuthorized ||
      (role === "candidate" && !candidateAuthorized)) {
      const id = await insertSkipped(
        organizationId,
        caseId,
        deliveryKey,
        rc.email,
        `BGV notification not sent — Case #${caseId}`,
        `Case #${caseId}: No BGV notification was sent to ${role}: live-authorization-required. The case remains in human review; no finding details are exposed.`,
      );
      if (id !== null) {
        if (!existing) created.push(id);
        else skipped.push(id);
      }
      continue;
    }
    if (simulatedBase || role === "bgvTeam") {
      const copy = copyFor(
        role,
        cycle,
        caseRow,
      );
      const id = await insertSimulated(
        organizationId,
        caseId,
        deliveryKey,
        rc.email,
        copy.subject,
        `SIMULATED ONLY — no email was sent.\n\n${copy.body}`,
      );
      if (id !== null) {
        if (!existing) created.push(id);
        else skipped.push(id);
      }
      continue;
    }
    const reason = liveReason(cycle, role, rc, candidateAuthorized, state.config);
    if (reason !== "authorized") {
      const id = await insertSkipped(
        organizationId,
        caseId,
        deliveryKey,
        rc.email,
        `BGV notification not sent — Case #${caseId}`,
        `Case #${caseId}: Notification skipped: ${reason}. No silent simulation fallback was used.`,
      );
      if (id !== null) {
        if (!existing) created.push(id);
        else skipped.push(id);
      }
      continue;
    }
    const copy = copyFor(
      role,
      cycle,
      caseRow,
    );
    if (!(await dispatchFenceValid({
      organizationId,
      caseId,
      cycleId: cycle.cycleId,
      episode: cycle.episode,
      configVersion: expectedConfigVersion,
      role,
      recipient: rc.email,
    }))) {
      if (existing) skipped.push(existing.id);
      continue;
    }
    const wasFailed = existing?.status === "failed" ||
      existing?.status === "skipped" ||
      existing?.status === "logged-only" ||
      existing?.status === "simulated";
    const outcome = await dispatchEmail(
      organizationId,
      caseId,
      deliveryKey,
      rc.email,
      copy.subject,
      copy.body,
      wasFailed,
      caseRow,
      sender,
      {
        cycleId: cycle.cycleId,
        episode: cycle.episode,
        configVersion: expectedConfigVersion,
        role,
      },
    );
    if (!existing) created.push(outcome.id);
    else if (wasFailed && outcome.status !== "uncertain") retried.push(outcome.id);
    if (outcome.status === "failed" || outcome.status === "skipped") skipped.push(outcome.id);
  }
  // Provider requests and downstream workstream holds are deliberately
  // simulated, including for real tenants. They can never mutate an external
  // IT/payroll/facilities system or imply an employment decision.
  for (const internal of INTERNAL_HOLDS) {
    const key = `bgv:${caseId}:${cycle.cycleId}:internal:${internal}`;
    const copy = internalCopy(internal, cycle.episode, caseId);
    const id = await insertSimulated(
      organizationId,
      caseId,
      key,
      `${internal} (simulated)`,
      copy.subject,
      copy.body,
    );
    if (id !== null && !rows.some((row) => row.idempotencyKey === key)) created.push(id);
  }
  return { created, retried, skipped };
}

async function reconcileInternalUnlocked(input: {
  organizationId: string;
  caseId: number;
  role?: string;
  reason?: "manual" | "heartbeat" | "startup";
  simulation?: boolean;
  event?: {
    episode: "blocked" | "release";
    source: BgvNotificationSource;
    provenance: BgvNotificationProvenance;
    classifications: BgvNotificationClassification[];
  };
  sender?: typeof sendEmail;
}) {
  validCaseId(input.caseId);
  let cycle: StoredCycle | null = null;
  let state: StoredState;
  let caseRow: typeof onbCases.$inferSelect;
  let pausedOffline = false;
  await db.transaction(async (tx) => {
    const loaded = await loadLocked(tx, input.organizationId, input.caseId);
    caseRow = loaded.caseRow;
    state = loaded.state;
    if (isSyntheticOfflineCase(caseRow) || isRetiredControllerCase(caseRow)) {
      pausedOffline = true;
      return;
    }
    const check = await tx.select().from(onbSystemChecks).where(and(
      eq(onbSystemChecks.organizationId, input.organizationId),
      eq(onbSystemChecks.caseId, input.caseId),
      eq(onbSystemChecks.system, "bgv"),
    )).orderBy(desc(onbSystemChecks.id)).limit(1);
    if (input.event) {
      const latest = currentCycle(state);
      const eventProvenance = sourceProvenance(
        input.event.provenance,
        isSyntheticOfflineCase(caseRow),
        Boolean(input.simulation),
      );
      const trustedExceptionUpgrade =
        input.event.episode === "blocked" &&
        latest?.episode === "blocked" &&
        eventProvenance === "trusted-provider" &&
        latest.sourceProvenance !== "trusted-provider" &&
        input.event.classifications.some((classification) =>
          classification === "discrepancy" || classification === "review-required");
      if (input.event.episode === "blocked" && latest?.episode !== "blocked") {
        cycle = createCycle(
          state,
          "blocked",
          input.event.source,
          eventProvenance,
          input.event.classifications,
        );
      } else if (trustedExceptionUpgrade) {
        cycle = createCycle(
          state,
          "blocked",
          input.event.source,
          eventProvenance,
          [...new Set([...latest!.classifications, ...input.event.classifications])],
        );
        // A simulation is not evidence that HR was informed. Suppress only
        // an actual earlier send to the currently configured HR recipient.
        const previousNotices = await communicationsFor(
          input.organizationId, input.caseId, latest!.cycleId,
        );
        const hrRecipient = roleConfig("hr", state.config, caseRow).email;
        if (previousNotices.some((notice) =>
          notice.status === "sent" &&
          notice.toAddress === hrRecipient &&
          notice.idempotencyKey?.includes(`:${latest!.cycleId}:hr:purpose`)
        )) {
          cycle.suppressRoles = ["hr"];
        }
      } else if (input.event.episode === "blocked" && latest?.episode === "blocked") {
        // A later provider exception can add restricted review/compliance
        // classification to the same blocked episode without replaying HR.
        const merged = [...new Set([
          ...latest.classifications,
          ...input.event.classifications,
        ])];
        latest.classifications = merged;
        latest.flags = makeFlags(merged, state.config, latest.episode);
        if (eventProvenance === "trusted-provider") {
          latest.sourceProvenance = eventProvenance;
        }
        cycle = latest;
      } else if (input.event.episode === "release" && latest?.episode === "blocked") {
        cycle = createCycle(
          state,
          "release",
          input.event.source,
          eventProvenance,
          [],
        );
      } else {
        cycle = latest ?? null;
      }
      if (cycle) cycle.sourceVersion = sourceVersionOf(check[0]);
    } else {
      const latest = currentCycle(state);
      if (check[0]?.status === "overdue" && latest?.episode !== "blocked") {
        cycle = createCycle(
          state,
          "blocked",
          "overdue",
          sourceProvenance(
            "unknown",
            isSyntheticOfflineCase(caseRow),
            Boolean(input.simulation),
          ),
          classifyReason(check[0].note ?? ""),
        );
      } else if (latest?.episode === "blocked" && check[0]?.status === "done") {
        cycle = createCycle(
          state,
          "release",
          "hr-reconcile",
          sourceProvenance(
            "unknown",
            isSyntheticOfflineCase(caseRow),
            Boolean(input.simulation),
          ),
          [],
        );
      } else {
        cycle = latest ?? null;
      }
      if (cycle && cycle.sourceVersion === undefined) {
        cycle.sourceVersion = sourceVersionOf(check[0]);
      }
    }
    if (cycle && (!state.cycles.some((item) => item.cycleId === cycle!.cycleId) ||
      state.cycles[0]?.cycleId === cycle.cycleId)) {
      await saveState(tx, input.organizationId, input.caseId, state);
    }
  });
  // TS cannot infer assignment through the transaction callback.
  const loadedCase = caseRow!;
  const loadedState = state!;
  if (pausedOffline) {
    return {
      ...(await getBgvNotifications({
        organizationId: input.organizationId,
        caseId: input.caseId,
        role: input.role,
      })),
      createdCommunicationIds: [],
      retriedCommunicationIds: [],
      skippedCommunicationIds: [],
    };
  }
  const active = cycle ?? currentCycle(loadedState);
  if (!active) {
    return {
      ...(await getBgvNotifications({
        organizationId: input.organizationId,
        caseId: input.caseId,
        role: input.role,
      })),
      createdCommunicationIds: [],
      retriedCommunicationIds: [],
      skippedCommunicationIds: [],
    };
  }
  const result = await reconcileCycle(
    input.organizationId,
    input.caseId,
    active,
    loadedState,
    loadedCase,
    Boolean(input.simulation),
    loadedState.version,
    input.sender,
  );
  return {
    ...(await getBgvNotifications({
      organizationId: input.organizationId,
      caseId: input.caseId,
      role: input.role,
    })),
    createdCommunicationIds: result.created,
    retriedCommunicationIds: result.retried,
    skippedCommunicationIds: result.skipped,
  };
}

async function reconcileInternal(input: Parameters<typeof reconcileInternalUnlocked>[0]) {
  return withCaseFence(input.organizationId, input.caseId, () =>
    reconcileInternalUnlocked(input),
  );
}

export async function reconcileBgvNotifications(input: {
  organizationId: string;
  caseId: number;
  role?: string;
  reason?: "manual" | "heartbeat" | "startup";
  simulation?: boolean;
  sender?: typeof sendEmail;
}) {
  const reason = input.reason ?? "manual";
  if (!canManageBgvNotifications(input.organizationId, input.role) &&
    reason === "manual") {
    throw new BgvNotificationConflictError("Owner or admin HR role required to reconcile BGV notifications.");
  }
  if (reason === "manual") {
    const [caseRow] = await db.select({
      notes: onbCases.notes,
      syntheticProvenance: onbCases.syntheticProvenance,
    }).from(onbCases).where(and(
      eq(onbCases.id, input.caseId),
      eq(onbCases.organizationId, input.organizationId),
    ));
    if (!caseRow) throw new BgvNotificationNotFoundError();
    if (isSyntheticOfflineCase(caseRow) || isRetiredControllerCase(caseRow)) {
      throw new BgvNotificationConflictError(
        "Paused offline cases are read-only; resume the case before manual reconciliation.",
      );
    }
  }
  return reconcileInternal({ ...input, reason });
}

export async function recordBgvBlockedEpisode(input: {
  organizationId: string;
  caseId: number;
  source: BgvNotificationSource;
  provenance: BgvNotificationProvenance;
  reason: string;
  classifications?: BgvNotificationClassification[];
  sender?: typeof sendEmail;
  skipFence?: boolean;
}) {
  const work = () => reconcileInternalUnlocked({
    organizationId: input.organizationId,
    caseId: input.caseId,
    event: {
      episode: "blocked",
      source: input.source,
      provenance: input.provenance,
      classifications: input.classifications ?? classifyReason(input.reason),
    },
    sender: input.sender,
  });
  return input.skipFence && caseFenceContext.getStore() === lockKey(input.organizationId, input.caseId)
    ? work()
    : withCaseFence(input.organizationId, input.caseId, work);
}

export async function recordBgvReleaseEpisode(input: {
  organizationId: string;
  caseId: number;
  source: BgvNotificationSource;
  provenance: BgvNotificationProvenance;
  sender?: typeof sendEmail;
  skipFence?: boolean;
}) {
  const work = () => reconcileInternalUnlocked({
    organizationId: input.organizationId,
    caseId: input.caseId,
    event: {
      episode: "release",
      source: input.source,
      provenance: input.provenance,
      classifications: [],
    },
    sender: input.sender,
  });
  return input.skipFence && caseFenceContext.getStore() === lockKey(input.organizationId, input.caseId)
    ? work()
    : withCaseFence(input.organizationId, input.caseId, work);
}

export async function reconcileCurrentBgvNotifications(
  reason: "heartbeat" | "startup" = "heartbeat",
): Promise<void> {
  const cases = await db.select({
    id: onbCases.id,
    organizationId: onbCases.organizationId,
  }).from(onbCases).where(sql`${onbCases.lifecycleStage} <> 'complete'`);
  for (const row of cases) {
    try {
      await reconcileBgvNotifications({
        organizationId: row.organizationId,
        caseId: row.id,
        reason,
      });
    } catch {
      // A single malformed tenant setting or ambiguous dispatch must not stop
      // heartbeat recovery for other tenants.
    }
  }
}