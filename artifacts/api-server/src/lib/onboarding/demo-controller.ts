import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbCases,
  onbDocuments,
  onbEvents,
  onbSettings,
} from "@workspace/db/schema";
import {
  LEGACY_CHECKLIST,
  readinessFromChecklist,
  type OnboardingDbTransaction,
} from "./settings";
import { defaultWorkstreams } from "./engine";
import {
  loadVolunteers,
  listPersonas,
  normalizeVolunteer,
  volunteerProblems,
  type DemoVolunteer,
} from "./demo-volunteers";
import { SCENARIOS, getScenario } from "./scenarios";
import { seedDocumentsForCase } from "./documents";
import { getDemoEmailReadiness, sendOutbound } from "./channels";
import { startVoiceCall, simulateVoiceCall } from "./voice";
import { runWithDemoControllerLive } from "./provider-policy";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";

export const DEMO_RUN_KEY_PREFIX = "demo-controller.run.v1:";
const ALLOWED_SYSTEMS = ["bgv", "hris", "access", "assets", "payroll", "learning"] as const;
const CHECKPOINTS = ["offer", "documents", "bgv", "systems", "hr-approval", "day1"] as const;
type DemoSystem = typeof ALLOWED_SYSTEMS[number];
type Checkpoint = typeof CHECKPOINTS[number];
type DemoMode = "hybrid";
type DemoStatus = "active" | "completed" | "blocked" | "restarted";
type Provenance = "simulated" | "live";

export type ControllerVolunteer = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  channelPreference: "email" | "whatsapp" | "both";
  approved: boolean;
  liveEmailAvailable: boolean;
  liveCallAvailable: boolean;
  capabilityReason: string | null;
};

type RunAction = {
  expectedVersion: number;
  requestId: string;
  kind: "load-documents" | "system-outcome" | "advance-time" | "advance" | "override-step" | "communication" | "restart";
  system?: DemoSystem | null;
  outcome?: "pending" | "complete" | "exception" | "overdue" | null;
  step?: Checkpoint | null;
  reason?: string | null;
  hours?: number | null;
  channel?: "email" | "call" | null;
  mode?: "live" | "simulated" | null;
  liveConfirmation?: "I_UNDERSTAND_LIVE_DEMO" | null;
};

type Activity = {
  id: string;
  at: string;
  actor: string;
  kind: string;
  requestId?: string;
  providerCallId?: string | null;
  providerOutcomeHash?: string | null;
  provenance: Provenance;
  message: string;
  transcript: string | null;
  providerStatus: string | null;
};

const DEMO_EMAIL_SUBJECT = "[DEMO] Onboarding simulation";

function demoEmailMessage(name: string | null): { subject: string; body: string } {
  return {
    subject: DEMO_EMAIL_SUBJECT,
    body: `[DEMO] Hello${name ? ` ${name}` : ""}, this is an explicitly requested onboarding demonstration.`,
  };
}

type DemoRun = {
  runId: string;
  caseId: number;
  caseName: string;
  scenario: string;
  mode: DemoMode;
  status: DemoStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  metadata: {
    caseId: number;
    name: string;
    email: string;
    phone: string | null;
    role: string;
    department: string;
    geography: string;
    joiningDate: string;
    offlineMarker: string;
  };
  checkpoints: Array<{ key: Checkpoint; status: "pending" | "completed" | "overridden" | "blocked"; reason: string | null }>;
  systems: Array<{
    system: DemoSystem;
    status: "pending" | "complete" | "exception" | "overdue";
    outcome: "pending" | "complete" | "exception" | "overdue" | null;
    simulated: boolean;
    updatedAt: string;
    note: string | null;
  }>;
  clock: { now: string; offsetHours: number };
  activity: Activity[];
  liveCapabilityReason: string | null;
  selectedVolunteerId: string | null;
  selectedVolunteer: ControllerVolunteer | null;
  renewedHRReviewRequired?: boolean;
  auditReason?: string | null;
  /** Durable idempotency ledger. Never exposed to the client. */
  actions: Record<string, { hash: string; responseRunId: string }>;
  parentRunId?: string | null;
};

function runKey(runId: string): string {
  return `${DEMO_RUN_KEY_PREFIX}${runId}`;
}

function fingerprintVolunteer(v: DemoVolunteer): string {
  const canonical = [
    v.name, v.email.toLowerCase(), v.phone, v.channelPreference, v.persona,
    v.role, v.department, v.geography, v.hireType, v.workerCategory,
    v.managerName, v.recruiterName, v.joiningDate, v.notes,
  ].join("\u001f");
  return `vol_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

type ProviderReadiness = { email: boolean; call: boolean; emailReason?: string };

function providerReadiness(): ProviderReadiness {
  // Voice performs a live Twilio number-capability lookup immediately before
  // dialing. Keep the capability conservative here: a phone number alone is
  // never evidence that Twilio voice is ready.
  const call = Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() || process.env.REPLIT_DEV_DOMAIN?.trim()),
  );
  // Synchronous callers validate Gmail readiness immediately before dispatch.
  // Capability generation supplies the actual async probe result below.
  return { email: true, call };
}

async function actualProviderReadiness(): Promise<ProviderReadiness> {
  const email = await getDemoEmailReadiness();
  return { ...providerReadiness(), email: email.configured, emailReason: email.reason };
}

function volunteerView(v: DemoVolunteer, readiness = providerReadiness()): ControllerVolunteer {
  const problem = volunteerProblems(v);
  const id = fingerprintVolunteer(v);
  const emailAvailable = !problem && readiness.email && v.channelPreference !== "whatsapp";
  const callAvailable = !problem && readiness.call && Boolean(v.phone);
  const capabilityReason = problem
    ?? (!readiness.email && !readiness.call
      ? readiness.emailReason ?? "No live email or Twilio voice provider is currently ready."
      : !readiness.email && v.channelPreference !== "whatsapp"
        ? readiness.emailReason ?? "The connected email provider is not currently ready."
        : !readiness.call && Boolean(v.phone)
          ? "Twilio voice is not currently ready; simulated calls remain available."
          : null);
  return {
    id,
    name: v.name,
    email: v.email,
    phone: v.phone || null,
    channelPreference: v.channelPreference as ControllerVolunteer["channelPreference"],
    approved: !problem,
    liveEmailAvailable: emailAvailable,
    liveCallAvailable: callAvailable,
    capabilityReason,
  };
}

async function controllerVolunteers(
  organizationId: string,
  readiness = providerReadiness(),
): Promise<ControllerVolunteer[]> {
  return (await loadVolunteers(organizationId)).map((volunteer) => volunteerView(volunteer, readiness));
}

function error(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function nowIso(): string {
  return new Date().toISOString();
}

function initialCheckpoints() {
  return CHECKPOINTS.map((key) => ({
    key,
    status: "pending" as const,
    reason: null,
  }));
}

function initialSystems() {
  return ALLOWED_SYSTEMS.map((system) => ({
    system,
    status: "pending" as const,
    outcome: "pending" as const,
    simulated: true,
    updatedAt: nowIso(),
    note: "External system is simulated for this demo run; no connector write is permitted.",
  }));
}

function publicRun(run: DemoRun) {
  const { actions: _actions, ...safe } = run;
  return safe;
}

function parseRun(value: string): DemoRun | null {
  try {
    const run = JSON.parse(value) as DemoRun;
    if (
      !run || typeof run.runId !== "string" || typeof run.caseId !== "number" ||
      typeof run.version !== "number" || !Array.isArray(run.activity)
    ) return null;
    return run;
  } catch {
    return null;
  }
}

async function writeRun(tx: Pick<OnboardingDbTransaction, "insert" | "update">, organizationId: string, run: DemoRun) {
  await tx.insert(onbSettings).values({
    organizationId,
    key: runKey(run.runId),
    value: JSON.stringify(run),
  }).onConflictDoUpdate({
    target: [onbSettings.organizationId, onbSettings.key],
    set: { value: JSON.stringify(run), updatedAt: sql`now()` },
  });
}

async function addCaseEvent(
  tx: Pick<OnboardingDbTransaction, "insert">,
  organizationId: string,
  caseId: number,
  activity: Activity,
  idempotencyKey: string,
) {
  await tx.insert(onbEvents).values({
    organizationId,
    caseId,
    agent: "demo-controller",
    engine: "human",
    hitlPattern: "demo-explicit-action",
    ruleRef: "demo-controller-v1",
    title: activity.kind,
    detail: activity.message,
    idempotencyKey,
  }).onConflictDoNothing({
    target: [onbEvents.organizationId, onbEvents.idempotencyKey],
  });
}

async function createCase(
  tx: OnboardingDbTransaction,
  organizationId: string,
  scenarioKey: string,
  volunteer: DemoVolunteer | null,
  runId: string,
) {
  const scenario = getScenario(scenarioKey) ?? SCENARIOS[0]!;
  const intake = volunteer
    ? {
        ...scenario.intake,
        workerName: volunteer.name,
        workerEmail: volunteer.email,
        workerPhone: volunteer.phone || null,
        channelPreference: volunteer.channelPreference,
        hireType: volunteer.hireType,
        workerCategory: volunteer.workerCategory,
        role: volunteer.role,
        department: volunteer.department,
        geography: volunteer.geography,
        managerName: volunteer.managerName,
        recruiterName: volunteer.recruiterName,
        joiningDateOffsetDays: 7,
        notes: volunteer.notes,
      }
    : scenario.intake;
  const joiningDate = new Date(Date.now() + intake.joiningDateOffsetDays * 86400_000)
    .toISOString().slice(0, 10);
  const [row] = await tx.insert(onbCases).values({
    organizationId,
    workerName: intake.workerName,
    workerEmail: intake.workerEmail,
    workerPhone: intake.workerPhone,
    channelPreference: volunteer?.channelPreference ?? "email",
    hireType: intake.hireType,
    workerCategory: intake.workerCategory,
    role: intake.role,
    department: intake.department,
    geography: intake.geography,
    legalEntity: intake.legalEntity,
    managerName: intake.managerName,
    recruiterName: intake.recruiterName,
    joiningDate,
    lifecycleStage: "intake",
    orchestrationStatus: "demo-blocked",
    checklistTemplateVersion: 1,
    checklistSnapshot: [...LEGACY_CHECKLIST],
    checklistProfileId: "demo-controller",
    checklistProfileName: "Demo Controller (isolated)",
    checklistProfileVersion: 1,
    checklistMatchedCriteria: {},
    checklistMatchExplanation: "Fresh synthetic case owned by the demo controller.",
    orchestrationCheckpoint: "demo-controller-blocked",
    readiness: readinessFromChecklist(LEGACY_CHECKLIST),
    workstreams: defaultWorkstreams(),
    scenarioKey,
    primarySkill: intake.primarySkill,
    skillCriticality: intake.skillCriticality,
    notes: `${SYNTHETIC_OFFLINE_MARKER}\n[demo-controller-run:${runId}]\n${intake.notes ?? "Synthetic case; no ordinary engine authority."}`,
    candidateEmailAuthorizedAt: volunteer ? new Date() : null,
    candidateEmailAuthorizedBy: volunteer ? "demo-controller" : null,
  }).returning();
  if (!row) throw error("DemoRunCreateError", "Unable to create synthetic demo case.");
  return row;
}

export async function getDemoCapabilities(organizationId: string, role?: string) {
  const inDemo = organizationId === DEMO_ORGANIZATION_ID;
  const canManage = inDemo && isDemoControllerRole(role);
  const reason = !inDemo
    ? "Demo Controller is available only in Demo Organization."
    : !canManage
      ? "Sign in and join Demo Organization to use Demo Controller."
      : null;
  // All authenticated Demo Organization members can present demos. Missing
  // membership and other tenants still receive no private controller data.
  const readiness = canManage ? await actualProviderReadiness() : null;
  const volunteers = canManage
    ? await controllerVolunteers(organizationId, readiness ?? undefined)
    : [];
  const sessions = canManage ? await listDemoRuns(organizationId) : [];
  return {
    available: canManage,
    reason,
    organizationId,
    canCreateRuns: canManage,
    canDispatchLive: canManage && volunteers.some((v) => v.liveEmailAvailable || v.liveCallAvailable),
    defaultMode: "hybrid" as const,
    allowedSystems: canManage ? [...ALLOWED_SYSTEMS] : [],
    scenarios: canManage ? listPersonas().map(({ key, title, description, expectedBehaviour }) => ({
      key, title, description, expectedBehaviour,
    })) : [],
    approvedVolunteers: volunteers,
    existingSessions: sessions.map((run) => publicRun(run)),
  };
}

export async function listDemoRuns(organizationId: string): Promise<DemoRun[]> {
  const rows = await db.select({ value: onbSettings.value })
    .from(onbSettings)
    .where(and(
      eq(onbSettings.organizationId, organizationId),
      like(onbSettings.key, `${DEMO_RUN_KEY_PREFIX}%`),
    ))
    .orderBy(desc(onbSettings.updatedAt));
  return rows.map((row) => parseRun(row.value)).filter((run): run is DemoRun => !!run);
}

async function loadRun(organizationId: string, runId: string): Promise<DemoRun | null> {
  const [row] = await db.select({ value: onbSettings.value })
    .from(onbSettings)
    .where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, runKey(runId))));
  return row ? parseRun(row.value) : null;
}

export async function createDemoRun(
  organizationId: string,
  actor: string,
  input: { scenario: string; volunteerId?: string | null; mode?: DemoMode },
): Promise<DemoRun> {
  if (organizationId !== DEMO_ORGANIZATION_ID) throw error("DemoOrganizationOnly", "Demo Controller is limited to Demo Organization.");
  const scenario = getScenario(input.scenario) ?? (input.scenario === "custom" ? SCENARIOS[0] : undefined);
  if (!scenario) throw error("DemoScenarioNotFound", "Unknown demo scenario.");
  const volunteers = await loadVolunteers(organizationId);
  const volunteer = input.volunteerId
    ? volunteers.find((candidate) => fingerprintVolunteer(candidate) === input.volunteerId) ?? null
    : null;
  if (input.volunteerId && !volunteer) throw error("DemoVolunteerUnavailable", "Selected volunteer is no longer approved or has changed.");
  if (volunteer && volunteerProblems(volunteer)) throw error("DemoVolunteerUnavailable", volunteerProblems(volunteer)!);
  const readiness = await actualProviderReadiness();
  const runId = randomUUID();
  const createdAt = nowIso();
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-controller:${organizationId}`}))`);
    const c = await createCase(tx, organizationId, input.scenario, volunteer, runId);
    const selected = volunteer ? volunteerView(volunteer, readiness) : null;
    const run: DemoRun = {
      runId,
      caseId: c.id,
      caseName: c.workerName,
      scenario: input.scenario,
      mode: "hybrid",
      status: "active",
      version: 0,
      createdAt,
      updatedAt: createdAt,
      metadata: {
        caseId: c.id,
        name: c.workerName,
        email: c.workerEmail,
        phone: c.workerPhone,
        role: c.role,
        department: c.department,
        geography: c.geography,
        joiningDate: c.joiningDate,
        offlineMarker: SYNTHETIC_OFFLINE_MARKER,
      },
      checkpoints: initialCheckpoints(),
      systems: initialSystems(),
      clock: { now: createdAt, offsetHours: 0 },
      activity: [{
        id: randomUUID(),
        at: createdAt,
        actor,
        kind: "run-created",
        provenance: "simulated",
        message: "Fresh synthetic case created. Ordinary orchestration and automatic outreach are blocked.",
        transcript: null,
        providerStatus: null,
      }],
      liveCapabilityReason: selected?.approved
        ? "Live contact is available only through an explicit, recipient-pinned controller action."
        : "Select an approved volunteer to enable explicit live email or call actions.",
      selectedVolunteerId: selected?.id ?? null,
      selectedVolunteer: selected,
      renewedHRReviewRequired: false,
      auditReason: null,
      actions: {},
      parentRunId: null,
    };
    await writeRun(tx, organizationId, run);
    await addCaseEvent(tx, organizationId, c.id, run.activity[0]!, `demo-run:${runId}:created`);
    return run;
  });
  await seedDocumentsForCase({
    id: row.caseId,
    organizationId,
    workerCategory: volunteer?.workerCategory ?? scenario.intake.workerCategory,
    geography: row.metadata.geography,
    hireType: scenario.intake.hireType,
    lifecycleStage: "intake",
  });
  return row;
}

function canonicalPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalPayload(child)]),
    );
  }
  return value;
}

function actionHash(action: RunAction): string {
  return createHash("sha256").update(JSON.stringify(canonicalPayload(action))).digest("hex");
}

function refreshStatus(run: DemoRun): DemoStatus {
  if (run.status === "restarted") return run.status;
  return run.checkpoints.every((step) => step.status === "completed" || step.status === "overridden")
    ? "completed"
    : run.checkpoints.some((step) => step.status === "blocked")
      ? "blocked"
      : "active";
}

async function updateCaseForRun(
  tx: OnboardingDbTransaction,
  run: DemoRun,
  action: RunAction,
  actor: string,
) {
  const [caseRow] = await tx.select().from(onbCases).where(and(
    eq(onbCases.id, run.caseId),
    eq(onbCases.organizationId, DEMO_ORGANIZATION_ID),
  )).for("update");
  if (!caseRow) throw error("DemoRunNotFound", "Run-owned synthetic case not found.");
  const readiness = [...caseRow.readiness];
  const workstreams = caseRow.workstreams.map((stream) => ({ ...stream, blockers: [...stream.blockers] }));
  if (action.kind === "load-documents") {
    const item = readiness.find((row) => row.key === "documentation");
    if (item) item.status = "ready";
    const stream = workstreams.find((candidate) => candidate.key === "documentation");
    if (stream) stream.status = "complete";
    await tx.update(onbDocuments).set({
      status: "verified",
      note: "Synthetic demo evidence only — not source-authenticated and not a real uploaded file.",
      updatedAt: new Date(),
    }).where(and(
      eq(onbDocuments.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbDocuments.caseId, run.caseId),
    ));
  }
  if (action.kind === "system-outcome" && action.outcome === "complete") {
    const item = readiness.find((row) => row.key === action.system);
    if (item) item.status = "ready";
    const streamKey = action.system === "assets" || action.system === "access" || action.system === "learning"
      ? action.system
      : null;
    const stream = streamKey ? workstreams.find((candidate) => candidate.key === streamKey) : null;
    if (stream) {
      stream.status = "complete";
      stream.blockers = [];
    }
  } else if (action.kind === "system-outcome" && action.system) {
    const streamKey = action.system === "assets" || action.system === "access" || action.system === "learning"
      ? action.system
      : null;
    const stream = streamKey ? workstreams.find((candidate) => candidate.key === streamKey) : null;
    if (stream) {
      stream.status = action.outcome === "pending" ? "pending" : "blocked";
      stream.blockers = [action.reason ?? `Simulated ${action.outcome ?? "pending"} outcome.`];
    }
  }
  await tx.update(onbCases).set({
    readiness,
    workstreams,
    lifecycleStage: run.status === "completed" ? "complete" : "preboarding",
    orchestrationStatus: "demo-controlled",
    orchestrationCheckpoint: `demo-controller:${action.kind}`,
    updatedAt: new Date(),
  }).where(and(eq(onbCases.id, run.caseId), eq(onbCases.organizationId, DEMO_ORGANIZATION_ID)));
  void actor;
}

function checkpoint(run: DemoRun, key: Checkpoint, status: "completed" | "overridden" | "blocked", reason: string | null) {
  const item = run.checkpoints.find((candidate) => candidate.key === key);
  if (item) {
    item.status = status;
    item.reason = reason;
  }
}

function finalReviewApproved(run: DemoRun): boolean {
  const hr = run.checkpoints.find((step) => step.key === "hr-approval");
  const day1 = run.checkpoints.find((step) => step.key === "day1");
  const approved = (status: DemoRun["checkpoints"][number]["status"]) =>
    status === "completed" || status === "overridden";
  return !!hr && !!day1 && approved(hr.status) && approved(day1.status);
}

function reopenFinalReview(run: DemoRun, reason: string): void {
  const hr = run.checkpoints.find((step) => step.key === "hr-approval");
  const day1 = run.checkpoints.find((step) => step.key === "day1");
  if (hr) hr.status = "pending";
  if (day1) day1.status = "pending";
  run.renewedHRReviewRequired = true;
  run.auditReason = reason;
}

async function performMutation(
  organizationId: string,
  actor: string,
  runId: string,
  action: RunAction,
): Promise<{ run: DemoRun; duplicate: boolean }> {
  const hash = actionHash(action);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-controller:${organizationId}`}))`);
    const [stored] = await tx.select({ value: onbSettings.value })
      .from(onbSettings)
      .where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, runKey(runId))))
      .for("update");
    const run = stored ? parseRun(stored.value) : null;
    if (!run) throw error("DemoRunNotFound", "Demo run not found.");
    const previous = run.actions[action.requestId];
    if (previous) {
      if (previous.hash !== hash) throw error("DemoRunConflict", "requestId was already used for a different action.");
      const duplicateRun = previous.responseRunId === run.runId
        ? run
        : (await tx.select({ value: onbSettings.value }).from(onbSettings)
          .where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, runKey(previous.responseRunId)))))[0];
      const parsedDuplicate = duplicateRun && "value" in duplicateRun ? parseRun(duplicateRun.value) : run;
      return { run: parsedDuplicate ?? run, duplicate: true };
    }
    if (run.version !== action.expectedVersion) {
      throw error("DemoRunVersionConflict", `Run changed since version ${action.expectedVersion}; current version is ${run.version}.`);
    }
    if (run.status === "restarted") throw error("DemoRunConflict", "A restarted run cannot receive more actions.");
    if (action.kind === "communication" && (!action.mode || !action.channel)) {
      throw error("DemoActionInvalid", "communication requires channel and mode.");
    }
    if (action.kind === "communication" && action.mode === "live") {
      if (action.liveConfirmation !== "I_UNDERSTAND_LIVE_DEMO") {
        throw error("DemoLiveConfirmationRequired", "Explicit live confirmation is required.");
      }
      if (!run.selectedVolunteerId) throw error("DemoVolunteerUnavailable", "Live communication requires a selected approved volunteer.");
      if (action.channel !== "email" && action.channel !== "call") throw error("DemoLiveChannelDenied", "Only email and call are eligible for live demo contact.");
    }
    const at = new Date(Date.now() + run.clock.offsetHours * 3600000).toISOString();
    const activity: Activity = {
      id: randomUUID(),
      at,
      actor,
      kind: action.kind,
      requestId: action.requestId,
      provenance: action.mode === "live" ? "live" : "simulated",
      message: action.reason?.trim() || `Demo action ${action.kind} applied.`,
      transcript: null,
      providerStatus: action.mode === "live" ? "dispatching" : "simulated",
    };
    const reviewWasApproved = finalReviewApproved(run);
    let materialEvidenceReason: string | null = null;
    if (action.kind === "load-documents") {
      checkpoint(run, "documents", "completed", "Synthetic documentation pack loaded; no uploaded bytes or source-authenticated evidence were used.");
      materialEvidenceReason = "Synthetic document evidence was loaded after the prior HR/Day-1 review; a fresh review is required.";
    } else if (action.kind === "system-outcome") {
      if (!action.system || !action.outcome) throw error("DemoActionInvalid", "system-outcome requires system and outcome.");
      const state = run.systems.find((candidate) => candidate.system === action.system);
      if (!state) throw error("DemoActionInvalid", "Unknown demo system.");
      const previousOutcome = state.outcome;
      const previousStatus = state.status;
      state.status = action.outcome === "pending" ? "pending" : action.outcome;
      state.outcome = action.outcome;
      state.updatedAt = at;
      state.note = "Simulated provider outcome; no HRIS, access, assets, payroll, or learning connector was changed.";
      checkpoint(run, action.system === "bgv" ? "bgv" : "systems", action.outcome === "complete" ? "completed" : "blocked", action.reason ?? state.note);
      if (previousOutcome !== action.outcome || previousStatus !== state.status) {
        materialEvidenceReason = `Simulated ${action.system} evidence changed from ${previousOutcome ?? "unknown"} to ${action.outcome}; a fresh HR/Day-1 review is required.`;
      }
    } else if (action.kind === "advance-time") {
      const hours = action.hours ?? 0;
      if (hours <= 0) throw error("DemoActionInvalid", "advance-time requires positive hours.");
      run.clock.offsetHours += hours;
      activity.message = `Demo clock advanced ${hours} hour(s); wall clock and global timers were not changed.`;
    } else if (action.kind === "advance") {
      const next = run.checkpoints.find((candidate) => candidate.status === "pending");
      if (!next) throw error("DemoActionInvalid", "No pending checkpoint remains.");
      next.status = "completed";
      next.reason = "Completed by explicit simulated demo action.";
    } else if (action.kind === "override-step") {
      if (!action.step || !action.reason?.trim()) throw error("DemoActionInvalid", "override-step requires step and reason.");
      checkpoint(run, action.step, "overridden", action.reason.trim());
      activity.message = `Checkpoint ${action.step} overridden for simulation: ${action.reason.trim()}`;
      if (action.step === "documents" || action.step === "bgv" || action.step === "systems") {
        materialEvidenceReason = `Synthetic ${action.step} evidence was overridden after the prior HR/Day-1 review; a fresh review is required.`;
      } else if (action.step === "hr-approval" && run.renewedHRReviewRequired) {
        // This explicit fresh HR decision clears the renewal requirement.
        // Day 1 remains pending until separately reviewed.
        run.renewedHRReviewRequired = false;
        activity.message = `Fresh HR approval recorded: ${action.reason.trim()}`;
      }
    } else if (action.kind === "restart") {
      run.status = "restarted";
      run.actions[action.requestId] = { hash, responseRunId: runId };
      run.version += 1;
      run.updatedAt = at;
      run.activity.push({
        ...activity,
        message: "Run retired and preserved. Restart creates a new synthetic case and run; this run cannot dispatch again.",
      });
      await writeRun(tx, organizationId, run);
      await updateCaseForRun(tx, run, action, actor);
      return { run, duplicate: false };
    }
    if (reviewWasApproved && materialEvidenceReason) {
      reopenFinalReview(run, materialEvidenceReason);
      activity.message = materialEvidenceReason;
    }
    run.clock.now = new Date(Date.now() + run.clock.offsetHours * 3600000).toISOString();
    run.activity.push(activity);
    run.actions[action.requestId] = { hash, responseRunId: runId };
    run.version += 1;
    run.updatedAt = at;
    run.status = refreshStatus(run);
    await writeRun(tx, organizationId, run);
    await updateCaseForRun(tx, run, action, actor);
    await addCaseEvent(tx, organizationId, run.caseId, activity, `demo-run:${runId}:action:${action.requestId}`);
    return { run, duplicate: false };
  });
}

async function revalidateSelectedVolunteer(organizationId: string, run: DemoRun): Promise<ControllerVolunteer> {
  if (!run.selectedVolunteerId) throw error("DemoVolunteerUnavailable", "No approved volunteer is pinned to this run.");
  const current = (await loadVolunteers(organizationId))
    .find((candidate) => fingerprintVolunteer(candidate) === run.selectedVolunteerId);
  if (!current || volunteerProblems(current)) {
    throw error("DemoVolunteerUnavailable", "The selected volunteer was removed, edited, or is no longer approved.");
  }
  const selected = volunteerView(current);
  if (selected.email !== run.metadata.email || (selected.phone ?? null) !== run.metadata.phone) {
    throw error("DemoVolunteerUnavailable", "The pinned volunteer identity changed; live contact is blocked.");
  }
  return selected;
}

async function liveClaimStillValid(
  organizationId: string,
  runId: string,
  requestId: string,
  caseId: number,
  channel: "email" | "call",
  recipient: string,
): Promise<boolean> {
  const latest = await loadRun(organizationId, runId);
  if (!latest || latest.caseId !== caseId) return false;
  const activity = latest.activity.find((entry) => entry.requestId === requestId);
  if (!activity || activity.providerStatus !== "dispatching" && activity.providerStatus !== "calling") return false;
  try {
    const selected = await revalidateSelectedVolunteer(organizationId, latest);
    return channel === "email"
      ? selected.email.trim().toLowerCase() === recipient.trim().toLowerCase()
      : selected.phone === recipient;
  } catch {
    return false;
  }
}

async function terminalizeLiveClaim(
  organizationId: string,
  runId: string,
  requestId: string,
  providerStatus: "blocked" | "failed" | "unknown",
  message: string,
): Promise<DemoRun> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-controller:${organizationId}`}))`);
    const [stored] = await tx.select({ value: onbSettings.value })
      .from(onbSettings)
      .where(and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, runKey(runId)),
      ))
      .for("update");
    const latest = stored ? parseRun(stored.value) : null;
    if (!latest) throw error("DemoRunNotFound", "Demo run not found while terminalizing live action.");
    const activity = latest.activity.find((entry) => entry.requestId === requestId);
    if (!activity) throw error("DemoRunConflict", "Live communication claim is no longer present.");
    if (activity.providerStatus === "dispatching" || activity.providerStatus === "calling") {
      activity.providerStatus = providerStatus;
      activity.message = message;
      latest.version += 1;
      latest.updatedAt = nowIso();
      await writeRun(tx, organizationId, latest);
    }
    return latest;
  });
}

async function finishLiveCommunication(
  organizationId: string,
  actor: string,
  run: DemoRun,
  action: RunAction,
): Promise<DemoRun> {
  const channel = action.channel!;
  let selected: ControllerVolunteer | null = null;
  let status = "failed";
  let message = "";
  let transcript: string | null = null;
  let providerAttempted = false;
  try {
    selected = await revalidateSelectedVolunteer(organizationId, run);
    if (channel === "email") {
      const emailReadiness = await getDemoEmailReadiness();
      if (!emailReadiness.configured) throw error("DemoLiveChannelDenied", emailReadiness.reason);
      if (!selected.liveEmailAvailable) throw error("DemoLiveChannelDenied", "Live email is unavailable for this volunteer.");
    }
    if (channel === "call" && !selected.liveCallAvailable) throw error("DemoLiveChannelDenied", "Live call is unavailable for this volunteer.");
    const localCallId = channel === "call" ? randomUUID() : null;
    if (localCallId) {
      // Bind the controller's local identity before the provider creates a
      // session or performs any Twilio I/O. The provider receives this same ID.
      await bindDemoVoiceCall({
        caseId: run.caseId,
        runId: run.runId,
        requestId: action.requestId,
        callId: localCallId,
      });
    }
    await runWithDemoControllerLive({
      organizationId,
      caseId: run.caseId,
      channel,
      recipient: channel === "email" ? selected.email : selected.phone!,
      runId: run.runId,
      requestId: action.requestId,
      revalidate: () => liveClaimStillValid(
        organizationId,
        run.runId,
        action.requestId,
        run.caseId,
        channel,
        channel === "email" ? selected!.email : selected!.phone!,
      ),
    }, async () => {
      if (channel === "email") {
        providerAttempted = true;
        const email = demoEmailMessage(selected!.name);
        const sent = await sendOutbound({
          caseId: run.caseId,
          channel: "email",
          toAddress: selected!.email,
          subject: email.subject,
          body: email.body,
          idempotencyKey: `demo-run:${run.runId}:communication:${action.requestId}`,
        });
        status = sent.status;
        message = sent.failureReason ?? `Email provider result: ${sent.status}.`;
      } else {
        providerAttempted = true;
        const called = await startVoiceCall({
          caseId: run.caseId,
          scenario: "day-before",
          reason: "[DEMO] Explicitly requested onboarding demonstration call.",
          runId: run.runId,
          requestId: action.requestId,
          localCallId: localCallId ?? undefined,
        });
        status = called.status;
        message = called.note;
        if (called.status === "calling") {
          message = "Demo call started; inbound transcript remains isolated to this run-owned case.";
        }
      }
    });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "Live provider preflight failed.";
    return terminalizeLiveClaim(
      organizationId,
      run.runId,
      action.requestId,
      providerAttempted ? "unknown" : "blocked",
      providerAttempted
        ? `Live provider outcome is unknown; no retry was attempted: ${detail}`
        : `Live communication blocked before provider dispatch: ${detail}`,
    );
  }
  // Reload and merge only after acquiring the same durable controller lock
  // used by action mutations. Provider webhooks may have recorded a real call
  // outcome while the dispatch request was in flight; never overwrite that
  // newer state with the pre-I/O snapshot.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-controller:${organizationId}`}))`);
    const [stored] = await tx.select({ value: onbSettings.value })
      .from(onbSettings)
      .where(and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, runKey(run.runId)),
      ))
      .for("update");
    const latest = stored ? parseRun(stored.value) : null;
    if (!latest) return run;
    const activity = latest.activity.find((entry) => entry.requestId === action.requestId);
    if (!activity) throw error("DemoRunConflict", "Live communication claim is no longer present.");
    if (activity.providerStatus === "dispatching") {
      const persistedStatus = status === "sending"
        ? "unknown"
        : status === "logged-only"
          ? "blocked"
          : status;
      activity.message = status === "sending"
        ? "Provider outcome is ambiguous; no simulated fallback or automatic retry was performed."
        : message;
      activity.transcript = transcript;
      activity.providerStatus = persistedStatus;
      latest.version += 1;
      latest.updatedAt = nowIso();
      await writeRun(tx, organizationId, latest);
    }
    return latest;
  });
}

/**
 * Fence a provider call to the exact live action before Twilio I/O starts.
 * The voice provider owns call initiation and supplies its local CallSid (or
 * equivalent) through this narrow interface.
 */
export async function bindDemoVoiceCall(input: {
  caseId: number;
  runId: string;
  requestId: string;
  callId: string;
}): Promise<void> {
  if (!input.callId.trim()) throw error("DemoVoiceCallInvalid", "A provider call ID is required.");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-controller:${DEMO_ORGANIZATION_ID}`}))`);
    const [stored] = await tx.select({ value: onbSettings.value })
      .from(onbSettings)
      .where(and(
        eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbSettings.key, runKey(input.runId)),
      ))
      .for("update");
    const run = stored ? parseRun(stored.value) : null;
    if (!run || run.caseId !== input.caseId) throw error("DemoVoiceCallNotFound", "No matching Demo Controller call claim exists.");
    const activity = run.activity.find((entry) => entry.requestId === input.requestId);
    if (!activity || activity.provenance !== "live" || activity.kind !== "communication") {
      throw error("DemoVoiceCallNotFound", "No matching live Demo Controller call claim exists.");
    }
    if (activity.providerCallId && activity.providerCallId !== input.callId) {
      throw error("DemoVoiceCallConflict", "The live call claim is already bound to another provider call.");
    }
    if (activity.providerCallId === input.callId) return;
    if (activity.providerStatus !== "dispatching" && activity.providerStatus !== "calling") {
      throw error("DemoVoiceCallConflict", "The live call claim is no longer dispatchable.");
    }
    activity.providerCallId = input.callId;
    run.version += 1;
    run.updatedAt = nowIso();
    await writeRun(tx, DEMO_ORGANIZATION_ID, run);
  });
}

/**
 * Record a real provider outcome against the previously fenced Demo call.
 * This is deliberately case/call-ID based and never runs ordinary engine
 * finalization for the synthetic offline case.
 */
export async function recordDemoVoiceOutcome(input: {
  caseId: number;
  callId: string;
  transcript: string;
  status: string;
}): Promise<void> {
  const callId = input.callId.trim();
  if (!callId) throw error("DemoVoiceCallInvalid", "A provider call ID is required.");
  const payloadHash = createHash("sha256").update(JSON.stringify({
    caseId: input.caseId,
    callId,
    transcript: input.transcript,
    status: input.status,
  })).digest("hex");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-controller:${DEMO_ORGANIZATION_ID}`}))`);
    const rows = await tx.select({ key: onbSettings.key, value: onbSettings.value })
      .from(onbSettings)
      .where(and(
        eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
        like(onbSettings.key, `${DEMO_RUN_KEY_PREFIX}%`),
      ))
      .for("update");
    let matched: { run: DemoRun; activity: Activity } | null = null;
    for (const row of rows) {
      const run = parseRun(row.value);
      if (!run || run.caseId !== input.caseId) continue;
      const activity = run.activity.find((entry) => entry.providerCallId === callId);
      if (activity) {
        matched = { run, activity };
        break;
      }
    }
    if (!matched) throw error("DemoVoiceCallNotFound", "No bound Demo Controller call matches this provider outcome.");
    const { run, activity } = matched;
    if (activity.providerOutcomeHash) {
      if (activity.providerOutcomeHash !== payloadHash) {
        throw error("DemoVoiceOutcomeConflict", "This provider call already has a different outcome payload.");
      }
      return;
    }
    activity.providerOutcomeHash = payloadHash;
    activity.providerStatus = input.status;
    activity.transcript = input.transcript;
    activity.message = `Live provider outcome recorded (${input.status}); transcript retained for this synthetic run only.`;
    run.version += 1;
    run.updatedAt = nowIso();
    await writeRun(tx, DEMO_ORGANIZATION_ID, run);
    await addCaseEvent(
      tx,
      DEMO_ORGANIZATION_ID,
      run.caseId,
      {
        ...activity,
        actor: "demo-provider",
        kind: "voice-outcome",
        message: activity.message,
      },
      `demo-run:${run.runId}:voice-outcome:${payloadHash}`,
    );
  });
}

export async function applyDemoAction(
  organizationId: string,
  actor: string,
  runId: string,
  action: RunAction,
): Promise<DemoRun> {
  if (organizationId !== DEMO_ORGANIZATION_ID) throw error("DemoOrganizationOnly", "Demo Controller is limited to Demo Organization.");
  const result = await performMutation(organizationId, actor, runId, action);
  if (result.duplicate) return result.run;
  if (action.kind === "restart") {
    // The retired run remains durable history, while the response points at
    // a genuinely new run/case. The old action ledger is then repaired to
    // point at that immutable successor so retries cannot create a second
    // restart.
    const fresh = await createDemoRun(organizationId, actor, {
      scenario: result.run.scenario,
      volunteerId: result.run.selectedVolunteerId,
      mode: "hybrid",
    });
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-controller:${organizationId}`}))`);
      const [stored] = await tx.select({ value: onbSettings.value })
        .from(onbSettings)
        .where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, runKey(runId))))
        .for("update");
      const retired = stored ? parseRun(stored.value) : null;
      if (!retired) return;
      retired.actions[action.requestId] = {
        hash: actionHash(action),
        responseRunId: fresh.runId,
      };
      retired.updatedAt = nowIso();
      await writeRun(tx, organizationId, retired);
    });
    return fresh;
  }
  if (action.kind === "communication" && action.mode === "live") {
    return finishLiveCommunication(organizationId, actor, result.run, action);
  }
  if (action.kind === "communication" && action.mode === "simulated") {
    const latest = await loadRun(organizationId, runId);
    if (!latest) return result.run;
    if (action.channel === "email") {
      const email = demoEmailMessage(latest.selectedVolunteer?.name ?? null);
      latest.activity[latest.activity.length - 1]!.message = [
        "Simulated email (not sent; no provider dispatch).",
        `Subject: ${email.subject}`,
        `Body: ${email.body}`,
      ].join("\n");
      latest.activity[latest.activity.length - 1]!.providerStatus = "simulated";
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-controller:${organizationId}`}))`);
        await writeRun(tx, organizationId, latest);
      });
      return latest;
    }
    if (action.channel === "call") {
      const simulation = await simulateVoiceCall(latest.caseId, "day-before", "[DEMO] Explicit simulated call");
      const transcript = simulation.transcript.length > 0
        ? simulation.transcript.map((turn) => `${turn.role}: ${turn.text}`).join("\n")
        : "SIMULATED TRANSCRIPT\nagent: [DEMO] Hello — this is a synthetic onboarding call.\nhire: [DEMO] Thanks, I understand this is a demonstration.";
      latest.activity[latest.activity.length - 1]!.transcript = transcript;
      latest.activity[latest.activity.length - 1]!.message = "Simulated call completed; transcript is synthetic and excluded from genuine KPIs.";
      latest.activity[latest.activity.length - 1]!.providerStatus = "simulated";
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-controller:${organizationId}`}))`);
        await writeRun(tx, organizationId, latest);
      });
      return latest;
    }
  }
  return result.run;
}

export async function getDemoRun(organizationId: string, runId: string): Promise<DemoRun | null> {
  const run = await loadRun(organizationId, runId);
  if (!run || !run.selectedVolunteerId || !run.selectedVolunteer) return run;
  const readiness = await actualProviderReadiness();
  const current = (await loadVolunteers(organizationId))
    .find((candidate) => fingerprintVolunteer(candidate) === run.selectedVolunteerId);
  if (!current || volunteerProblems(current)) {
    run.selectedVolunteer = {
      ...run.selectedVolunteer,
      approved: false,
      liveEmailAvailable: false,
      liveCallAvailable: false,
      capabilityReason: "The pinned volunteer was removed, edited, or is no longer approved; live contact is blocked.",
    };
    run.liveCapabilityReason = run.selectedVolunteer.capabilityReason;
  } else {
    run.selectedVolunteer = volunteerView(current, readiness);
    run.liveCapabilityReason = run.selectedVolunteer.approved
      ? "Live contact is available only through an explicit, recipient-pinned controller action."
      : run.selectedVolunteer.capabilityReason;
  }
  return run;
}

export function demoDocuments(run: DemoRun): string {
  return [
    "DEMO / SYNTHETIC DOCUMENTATION PACK",
    "WATERMARK: NOT A GENUINE HR RECORD — GENERATED FOR DEMONSTRATION ONLY",
    "",
    `Run: ${run.runId}`,
    `Case: ${run.caseId} — ${run.caseName}`,
    `Scenario: ${run.scenario}`,
    `Generated: ${run.createdAt}`,
    "",
    ...run.checkpoints.map((step) => `${step.key}: ${step.status}${step.reason ? ` — ${step.reason}` : ""}`),
    "",
    "No uploaded file bytes, malware scan result, source-authenticated evidence, or external HR system record is represented by this pack.",
  ].join("\n");
}

export function isDemoControllerRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

export { publicRun };