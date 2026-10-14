import { createHash, randomUUID } from "node:crypto";
import { denyRetiredCaseCapability } from "../retired-case-capabilities";
import { getProductLearningCatalog } from "./product-learning-catalog";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { onbCandidateLinks, onbCases, onbEvents, onbSettings, type OnbWorkforceContext } from "@workspace/db/schema";
import { DEMO_ORGANIZATION_ID } from "@workspace/db/schema";
import { defaultWorkstreams } from "./engine";
import { seedDocumentsForCase } from "./documents";
import { LEGACY_CHECKLIST, readinessFromChecklist } from "./settings";
import { issueCandidatePortalLink } from "./portal-link-issuance";
import { isUatRunIsolatedCase, UAT_RUN_ISOLATED_MARKER } from "./synthetic-offline";
import { UAT_RUN_SETTING_PREFIX } from "./uat-isolation";
import { evaluateUatWorkflow, type UatWorkflowEvaluation } from "./uat-workflow-evaluator";
import { collectUatEvaluationInput } from "./uat-workflow-fixtures";
import {
  FEATURE_COVERAGE, GUIDE_SECTIONS, PRODUCT_FEATURES, REQUIREMENTS, REQUIREMENT_COVERAGE,
  UAT_BASELINE_REVISION, UAT_CATALOG_VERSION, UAT_SCENARIOS,
  type UatScenario, type UatStep,
} from "./uat-learning-catalog";

const RUN_PREFIX = UAT_RUN_SETTING_PREFIX;

type Result = "passed" | "failed" | "blocked" | "not-run" | "not-applicable";
type Provenance = "simulated" | "manual-evidence" | "provider-sandbox" | "real-email";
type RunStatus = "active" | "paused" | "completed" | "blocked" | "cleaned";
type System = "hris" | "bgv" | "itsm" | "payroll" | "benefits" | "email";
type Operation = "request" | "status" | "poll" | "webhook" | "status-email";

type UatEvidence = { id: string; at: string; stepId: string | null; result: Result; provenance: Provenance; note: string };
type UatExchange = { id: string; system: System; operation: Operation; state: string; at: string; note: string };
type PendingEvent = {
  id: string; at: string; dueAt: string; kind: string;
  state: "pending" | "applied" | "ignored-duplicate" | "blocked"; description: string; note: string; eventKey: string;
  system: System; operation: Operation;
};
type CandidatePortal = { caseId: number; linkId: number; expiresAt: string; launchUrl: string };
type ExternalEffect = {
  kind: "issue-candidate-portal" | "dispatch-approved-demo-email";
  state: "prepared" | "dispatched" | "confirmed" | "uncertain" | "terminal-failure";
  intentHash: string; bodyHash: string; preparedAt: string; preparedBy: string;
  prevalidation: string; leaseExpiresAt: string; finalizedAt?: string; receiptHash?: string; failure?: string; correlationId?: string;
};
type SyntheticProfile = {
  workerName: string; workerEmail: string; family: string; variant: string; hireType: string; geography: string; joiningDate: string;
  fictional: true; statement: string;
};
type ScannerFact = { fixtureId: string; state: "clean" | "pending" | "failed" | "quarantined"; required: boolean };
export type UatRun = {
  runId: string; scenarioId: string; status: RunStatus; version: number; createdAt: string; updatedAt: string;
  fixtureVersion: string; fixtureSeed: string; baselineRevision: string; mode: "simulated" | "real-email";
  clock: { now: string; offsetHours: number }; linkedCaseIds: number[]; steps: UatStep[];
  evidence: UatEvidence[]; exchanges: UatExchange[]; pendingEvents: PendingEvent[]; cleanupNotice: string;
  syntheticProfile: SyntheticProfile;
  scannerFacts: ScannerFact[]; workflowEvaluation?: UatWorkflowEvaluation;
  initialization: "pending" | "ready" | "failed";
  actions: Record<string, string>; externalEffects: Record<string, ExternalEffect>; processedEventKeys: string[]; createdBy: string; createdByRole: string; createRequestId?: string | null;
};

function key(runId: string) { return `${RUN_PREFIX}${runId}`; }
function err(name: string, message: string): Error { const error = new Error(message); error.name = name; return error; }
function future(from: string, hours: number) { return new Date(new Date(from).getTime() + hours * 3_600_000).toISOString(); }
function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/(?:token|secret|authorization|bearer|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, (opaque) =>
      // Durable server error/status enums are intentionally visible. Bearer
      // credentials are opaque/mixed-case; retain only ALL_CAPS machine codes.
      /^[A-Z][A-Z0-9_]{31,}$/.test(opaque) ? opaque : "[REDACTED_SECRET]");
}
function portalFailureMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "";
  if (caught instanceof Error && caught.name === "SensitiveAuthorityRequiredError") {
    return "SENSITIVE_RECORD_ACCESS_REQUIRED: Candidate portal was not issued. Source: sensitive-record authority fence. Remediation: a tenant administrator must grant the acting user current scoped authority for this case; UAT cannot bypass identity, medical, payroll, or background-check access controls.";
  }
  if (caught instanceof Error && caught.name === "SensitiveLifecycleConflictError") {
    return "SENSITIVE_LIFECYCLE_POLICY_REQUIRED: Candidate portal was not issued. Source: case-derived sensitive lifecycle policy gate. Remediation: an accountable policy owner must approve and configure the required collection policy; UAT does not override it.";
  }
  if (/offer acceptance/i.test(message)) {
    return "OFFER_ACCEPTANCE_REQUIRED: Candidate portal was not issued. Source: offer-acceptance gate. Remediation: record the synthetic offer-acceptance state through the approved UAT setup; do not bypass the gate.";
  }
  if (/governance|sensitive lifecycle|provider policy|authority/i.test(message)) {
    return "GOVERNANCE_REVIEW_REQUIRED: Candidate portal was not issued. Source: current candidate-portal governance/lifecycle gate. Remediation: the accountable policy owner must complete the indicated review or configuration; UAT does not override it.";
  }
  if (/intent was retired|cleaned|UAT portal intent/i.test(message)) {
    return "UAT_INTENT_RETIRED: Candidate portal was not issued because the run action was retired or cleaned before credential persistence. Submit a new explicit action only if the run remains active.";
  }
  return `PORTAL_ISSUANCE_FAILED_${caught instanceof Error ? caught.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_") : "UNKNOWN"}: Candidate portal was not issued. Source: internal candidate-portal issuance boundary. Review the server audit/status record; no credential was returned.`;
}
function parse(value: string): UatRun | null {
  try {
    const run = JSON.parse(value) as UatRun;
    return run && typeof run.runId === "string" && Array.isArray(run.evidence) && Array.isArray(run.exchanges)
      ? {
        ...run, pendingEvents: Array.isArray(run.pendingEvents)
          ? run.pendingEvents.map((event) => ({ ...event, system: event.system ?? "hris", operation: event.operation ?? "status" }))
          : [],
        processedEventKeys: Array.isArray(run.processedEventKeys) ? run.processedEventKeys : [],
        externalEffects: run.externalEffects && typeof run.externalEffects === "object" ? run.externalEffects : {},
        scannerFacts: Array.isArray(run.scannerFacts) ? run.scannerFacts : [],
        initialization: run.initialization === "ready" || run.initialization === "failed" ? run.initialization : "pending",
        syntheticProfile: run.syntheticProfile && typeof run.syntheticProfile === "object"
          ? run.syntheticProfile
          : profileForScenario(scenario(run.scenarioId) ?? {
            id: run.scenarioId, family: "legacy", title: "", description: "", roles: [], mode: "manual-evidence", status: "manual", blocker: null, steps: [],
          }, run.runId),
        createdBy: typeof run.createdBy === "string" ? run.createdBy : "legacy-unknown",
        createdByRole: typeof run.createdByRole === "string" ? run.createdByRole : "legacy-unknown",
      }
      : null;
  } catch { return null; }
}
function scenario(id: string) { return UAT_SCENARIOS.find((item) => item.id === id); }
function assertLifecycleAllows(run: UatRun, action: { kind: string }) {
  if (run.status === "cleaned") throw err("UatRunCleaned", "This UAT run was cleaned and cannot be resumed or changed.");
  if (action.kind === "cleanup") return;
  if (action.kind === "resume") {
    if (run.status === "blocked" || scenario(run.scenarioId)?.status === "blocked") {
      throw err("UatActionInvalid", "A blocked run or blocked catalog scenario cannot be activated.");
    }
    return;
  }
  if (run.status !== "active") {
    if (action.kind === "record-evidence") return;
    throw err("UatRunInactive", `Run is ${run.status}; only an explicit permitted lifecycle action or evidence note is allowed.`);
  }
}
function profileForScenario(selected: UatScenario, runId: string): SyntheticProfile {
  const variants: Record<string, { variant: string; hireType: string }> = {
    "UAT-STD-01": { variant: "standard/lateral", hireType: "external-fte" },
    "UAT-FLT-01": { variant: "frontline", hireType: "external-fte" },
    "UAT-XFR-01": { variant: "transfer", hireType: "internal-transfer" },
    "UAT-BATCH-02": { variant: "campus cohort", hireType: "external-fte" },
    "UAT-CASE-02": { variant: "rehire/conversion", hireType: "rehire" },
    "UAT-SETTINGS-01": { variant: "cross-border/relocation", hireType: "external-fte" },
    "UAT-AI-01": { variant: "executive/senior", hireType: "external-fte" },
    "UAT-OPS-01": { variant: "contractor", hireType: "contractor" },
  };
  const classification = variants[selected.id] ?? { variant: "standard", hireType: "external-fte" };
  return {
    workerName: "Avery Example",
    workerEmail: `uat-${runId.slice(0, 12)}@example.invalid`,
    family: selected.family,
    variant: classification.variant,
    hireType: classification.hireType,
    geography: "United States",
    joiningDate: "2030-01-15",
    fictional: true,
    statement: "Entirely fictional UAT profile. It is not an employee, identity, source, employment, or eligibility record.",
  };
}
function publicRun(run: UatRun) {
  const { actions: _actions, externalEffects: _effects, processedEventKeys: _processed, createdBy: _createdBy, createdByRole: _createdByRole, createRequestId: _requestId, ...safe } = run;
  const latestEffect = Object.values(run.externalEffects).sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))[0];
  return {
    ...safe,
    evidence: safe.evidence.map((item) => ({ ...item, note: redact(item.note) })),
    exchanges: safe.exchanges.map((item) => ({ ...item, state: redact(item.state), note: redact(item.note) })),
    pendingEvents: safe.pendingEvents.map(({ eventKey: _eventKey, system: _system, operation: _operation, ...item }) => ({ ...item, description: redact(item.description), note: redact(item.note) })),
    ...(latestEffect ? { externalActionStatus: { kind: latestEffect.kind, state: latestEffect.state, message: redact(latestEffect.failure ?? latestEffect.prevalidation) } } : {}),
  };
}
function portalIssuedBy(runId: string, requestId: string) { return `uat-portal:${runId}:${requestId}`; }
async function finishRecoveredExternal(
  organizationId: string, runId: string, requestId: string, hash: string,
  state: ExternalEffect["state"], receipt: string, failure?: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`onboarding-uat:${organizationId}:${runId}`}))`);
    const [row] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, key(runId)))).for("update");
    const run = row ? parse(row.value) : null;
    if (!run) throw err("UatRunNotFound", "UAT run not found in this organization.");
    const effect = run.externalEffects[requestId];
    if (!effect || effect.intentHash !== hash || run.actions[requestId] !== `pending:${hash}`) return publicRun(run);
    effect.state = state; effect.finalizedAt = run.clock.now;
    effect.receiptHash = createHash("sha256").update(receipt).digest("hex");
    if (failure) effect.failure = redact(failure);
    run.actions[requestId] = hash; run.version += 1; run.updatedAt = run.clock.now;
    await tx.insert(onbSettings).values({ organizationId, key: key(runId), value: JSON.stringify(run) })
      .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(run), updatedAt: sql`now()` } });
    return publicRun(run);
  });
}
async function reconcilePendingExternal(organizationId: string, runId: string, requestId: string, hash: string, run: UatRun) {
  const effect = run.externalEffects[requestId];
  if (!effect) return publicRun(run);
  if (effect.kind === "issue-candidate-portal") {
    const caseId = run.linkedCaseIds[0];
    const [link] = caseId ? await db.select({ id: onbCandidateLinks.id, expiresAt: onbCandidateLinks.expiresAt }).from(onbCandidateLinks).where(and(
      eq(onbCandidateLinks.organizationId, organizationId), eq(onbCandidateLinks.caseId, caseId), eq(onbCandidateLinks.issuedBy, portalIssuedBy(runId, requestId)),
    )).orderBy(desc(onbCandidateLinks.createdAt)).limit(1) : [];
    if (!link && Date.now() < new Date(effect.leaseExpiresAt).getTime()) {
      return { ...publicRun(run), candidatePortal: { canIssue: false, status: "prepared", reason: "Credential persistence is still within its real-time recovery lease; no duplicate credential will be issued." } };
    }
    const recovered = await finishRecoveredExternal(organizationId, runId, requestId, hash,
      link ? "confirmed" : "terminal-failure",
      link ? `portal:${caseId}:${link.id}:${link.expiresAt.toISOString()}` : "portal-receipt-not-found",
      link ? undefined : "Prepared portal action has no matching persisted credential. It was not automatically reissued; submit a new explicit action.",
    );
    return { ...recovered, candidatePortal: { canIssue: !link, status: link ? "recovered-no-url" : "not-issued", reason: link ? "Credential was recovered without returning a retained bearer URL." : "No credential receipt was found. Issue a new explicit link only after reviewing this terminal result." } };
  }
  // Retained non-portal effects are evidence only. Even a stale retry must
  // not update their receipt, resolve uncertainty, or invoke a controller.
  return publicRun(run);
}
const HARMLESS_FIXTURE_IDS = new Set([
  "valid", "missing-information", "expired", "inconsistent-name", "unsupported-format", "oversized", "corrupt", "changed-bytes",
]);
function evaluatorFamily(value: string): "standard" | "frontline" | "transfer" | "shared" {
  if (/frontline|campus|bulk/i.test(value)) return "frontline";
  if (/transfer|M&A|TUPE/i.test(value)) return "transfer";
  return "standard";
}
async function evaluateRunWorkflow(organizationId: string, run: UatRun): Promise<UatWorkflowEvaluation> {
  return db.transaction(async (tx) => {
    const caseId = run.linkedCaseIds[0];
    const [caseRow] = caseId ? await tx.select().from(onbCases).where(and(
      eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
    )).for("update") : [];
    if (!caseRow) throw err("UatRunNotFound", "The isolated linked case is unavailable for evaluation.");
    // One transaction-scoped collector binds real case/upload observations and
    // family fixtures. The controller only appends explicitly harmless,
    // run-owned scanner fixture facts; it never injects a live upload verdict.
    const input = await collectUatEvaluationInput(run, caseRow, tx);
    input.uploads.scannerResults = [...input.uploads.scannerResults, ...run.scannerFacts.map((item) => ({
      runId: run.runId, fixtureId: item.fixtureId, fixtureClass: "harmless-text" as const, state: item.state, required: item.required,
    }))];
    return evaluateUatWorkflow(input);
  });
}

function applyDueEvents(run: UatRun) {
  for (const event of run.pendingEvents.filter((item) => item.state === "pending" && item.dueAt <= run.clock.now).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id))) {
    if (run.processedEventKeys.includes(event.eventKey)) {
      event.state = "ignored-duplicate"; event.note = "Duplicate delayed response ignored by the run-scoped idempotency ledger.";
      continue;
    }
    run.processedEventKeys.push(event.eventKey); event.state = "applied";
    run.exchanges.push({ id: randomUUID(), at: event.dueAt, system: event.system, operation: "status", state: "simulated-response", note: `Run-scoped pending response applied: ${event.description}. No adapter or case readiness write occurred.` });
  }
}

async function write(organizationId: string, run: UatRun) {
  await db.insert(onbSettings).values({ organizationId, key: key(run.runId), value: JSON.stringify(run) })
    .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(run), updatedAt: sql`now()` } });
}
async function load(organizationId: string, runId: string): Promise<UatRun | null> {
  const [row] = await db.select({ value: onbSettings.value }).from(onbSettings)
    .where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, key(runId))));
  return row ? parse(row.value) : null;
}
async function markInitialization(organizationId: string, runId: string, state: UatRun["initialization"]) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`onboarding-uat:${organizationId}:${runId}`}))`);
    const [row] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, key(runId)))).for("update");
    const run = row ? parse(row.value) : null;
    if (!run || run.initialization === state) return;
    run.initialization = state; run.updatedAt = run.clock.now;
    await tx.insert(onbSettings).values({ organizationId, key: key(runId), value: JSON.stringify(run) })
      .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(run), updatedAt: sql`now()` } });
  });
}
async function seedRunLinkedCase(organizationId: string, run: UatRun) {
  const caseId = run.linkedCaseIds[0];
  const [caseRow] = caseId ? await db.select().from(onbCases).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId))) : [];
  if (!caseRow || !isUatRunIsolatedCase(caseRow)) {
    await markInitialization(organizationId, run.runId, "failed");
    throw err("UatRunInitializationFailed", "The run-linked isolated case is unavailable; no hidden initialization fallback was used.");
  }
  try {
    await seedDocumentsForCase({ id: caseRow.id, organizationId, workerCategory: caseRow.workerCategory, geography: caseRow.geography, hireType: caseRow.hireType, lifecycleStage: caseRow.lifecycleStage });
    await markInitialization(organizationId, run.runId, "ready");
  } catch (caught) {
    await markInitialization(organizationId, run.runId, "failed");
    throw caught;
  }
}

/** Reserve credential/email actions before side effects so a concurrent click,
 * retry, or stale tab cannot mint another portal credential or send twice. */
async function reserveExternalAction(
  organizationId: string, runId: string, expectedVersion: number, requestId: string, hash: string, kind: "issue-candidate-portal" | "dispatch-approved-demo-email", actor: string, correlationId?: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`onboarding-uat:${organizationId}:${runId}`}))`);
    const [row] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, key(runId)),
    )).for("update");
    const run = row ? parse(row.value) : null;
    if (!run) throw err("UatRunNotFound", "UAT run not found in this organization.");
    const existing = run.actions[requestId];
    if (existing) {
      if (existing !== hash && existing !== `pending:${hash}`) throw err("UatRunConflict", "requestId was used for a different action.");
      return { run, reserved: false };
    }
    if (run.version !== expectedVersion) throw err("UatRunVersionConflict", `Run changed since version ${expectedVersion}; refresh before retrying.`);
    // External work is not prepared until the locked, current lifecycle state
    // has been checked. Cleanup/pause cannot race into portal/email dispatch.
    assertLifecycleAllows(run, { kind });
    run.actions[requestId] = `pending:${hash}`;
    run.externalEffects[requestId] = {
      kind, state: "prepared", intentHash: hash, bodyHash: hash, preparedAt: run.clock.now, preparedBy: actor,
      prevalidation: "Run ownership, tenant scope, current lifecycle, optimistic version, and action-specific server authorization were validated before effect preparation.",
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      correlationId,
    };
    run.version += 1; run.updatedAt = run.clock.now;
    await tx.insert(onbSettings).values({ organizationId, key: key(runId), value: JSON.stringify(run) })
      .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(run), updatedAt: sql`now()` } });
    return { run, reserved: true };
  });
}

export async function getUatCatalog(organizationId: string) {
  const rows = await db.select({ value: onbSettings.value }).from(onbSettings)
    .where(and(eq(onbSettings.organizationId, organizationId), like(onbSettings.key, `${RUN_PREFIX}%`)))
    .orderBy(desc(onbSettings.updatedAt));
  return {
    catalogVersion: UAT_CATALOG_VERSION, baselineRevision: UAT_BASELINE_REVISION, syntheticOnly: true,
    scenarios: [],
    runs: rows.map((row) => parse(row.value)).filter((run): run is UatRun => Boolean(run)).map((run) => ({
      runId: run.runId, scenarioId: run.scenarioId, status: run.status, version: run.version, createdAt: run.createdAt, updatedAt: run.updatedAt,
    })),
  };
}

/** Tenant-neutral canonical catalog; never mixes run evidence or bearer URLs. */
export function getLearningCatalog() {
  return getProductLearningCatalog();
}

export async function createUatRun(organizationId: string, actor: string, input: { scenarioId: string; mode?: "simulated"; requestId?: string | null }, actorRole = "tenant-member") {
  denyRetiredCaseCapability();
  const selected = scenario(input.scenarioId);
  if (!selected) throw err("UatScenarioNotFound", "Unknown UAT scenario.");
  if (input.mode !== undefined && input.mode !== "simulated") {
    throw err("UatRealEmailBlocked", "UAT runs do not send email. Only isolated test runs are supported.");
  }
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`onboarding-uat-create:${organizationId}:${input.requestId ?? randomUUID()}`}))`);
    if (input.requestId) {
      const rows = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
        eq(onbSettings.organizationId, organizationId), like(onbSettings.key, `${RUN_PREFIX}%`),
      ));
      const existing = rows.map((row) => parse(row.value)).find((run): run is UatRun =>
        Boolean(run && run.createRequestId === input.requestId && run.createdBy === actor),
      );
      if (existing) {
        if (existing.scenarioId !== input.scenarioId) throw err("UatRunConflict", "Create request ID was already used for a different scenario.");
        return { run: existing, caseRow: null };
      }
    }
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const profile = profileForScenario(selected, runId);
    const frontline = selected.id === "UAT-FLT-01";
    const workforceContext: OnbWorkforceContext = frontline
      ? { workCountry: "US", workerCategory: "employee", hiringMode: "batch", workEnvironment: "site", siteExposure: true, safetyCritical: true }
      : { workCountry: "US", workerCategory: "employee", hiringMode: "individual" };
    // The case is created inside the same tenant transaction as its durable
    // run pointer. A failed transaction cannot leave an eligible worker case.
    const [c] = await tx.insert(onbCases).values({
      organizationId, workerName: profile.workerName,
      workerEmail: profile.workerEmail, workerPhone: null, channelPreference: "email",
      hireType: profile.hireType, workerCategory: "employee", role: `Synthetic ${selected.family}`,
      department: "UAT (isolated)", geography: profile.geography, legalEntity: "Synthetic UAT entity",
      managerName: "UAT manager", recruiterName: "UAT coordinator", joiningDate: profile.joiningDate,
      lifecycleStage: "preboarding", orchestrationStatus: "uat-isolated", orchestrationCheckpoint: "uat-isolated",
      checklistTemplateVersion: 1, checklistSnapshot: [...LEGACY_CHECKLIST],
      checklistProfileId: frontline ? "uat-frontline-isolated" : "uat-isolated", checklistProfileName: frontline ? "UAT isolated frontline profile (unapproved fixture)" : "UAT isolated case",
      checklistProfileVersion: 1, checklistMatchedCriteria: {}, checklistMatchExplanation: "Server-created isolated UAT run case; this fixture is not a policy approval or specialist decision.",
      readiness: readinessFromChecklist(LEGACY_CHECKLIST), workstreams: defaultWorkstreams(), scenarioKey: selected.id,
      workforceContext,
      // Synthetic only: this exercises the existing Gate-A state without
      // asserting a real offer, employment relationship, or eligibility.
      offerAcceptanceComplete: profile.hireType !== "internal-transfer",
       notes: `${UAT_RUN_ISOLATED_MARKER}\n[uat-run:${runId}]\nSynthetic test case. Provider dispatch, ordinary orchestration, outreach and KPI/outcome inclusion are fenced. Candidate portal is explicit no-email only.`,
      createdByUserId: actor,
    }).returning();
    if (!c) throw err("UatRunCreateError", "Unable to create isolated UAT case.");
    await tx.insert(onbEvents).values({
      organizationId, caseId: c.id, agent: "uat-test-center", engine: "system",
      title: "Isolated UAT case created", detail: "Run-owned synthetic case. Ordinary dispatch and orchestration are fenced; no live readiness or KPI outcome is created.",
      idempotencyKey: `uat-run:${runId}:case-created`,
    }).onConflictDoNothing({ target: [onbEvents.organizationId, onbEvents.idempotencyKey] });
    const run: UatRun = {
      runId, scenarioId: selected.id, status: selected.status === "blocked" ? "blocked" : "active", version: 0, createdAt, updatedAt: createdAt,
      fixtureVersion: "synthetic-fixtures.v1", fixtureSeed: createHash("sha256").update(`synthetic-fixtures.v1:${selected.id}`).digest("hex").slice(0, 16),
      baselineRevision: UAT_BASELINE_REVISION, mode: "simulated", clock: { now: createdAt, offsetHours: 0 },
      linkedCaseIds: [c.id], steps: [...selected.steps], exchanges: [], pendingEvents: [], actions: {}, externalEffects: {}, processedEventKeys: [], scannerFacts: [], createdBy: actor, createdByRole: actorRole, createRequestId: input.requestId ?? null,
      syntheticProfile: profile,
      initialization: "pending",
      evidence: [{ id: randomUUID(), at: createdAt, stepId: null, result: selected.status === "blocked" ? "blocked" : "not-run", provenance: selected.mode, note: selected.blocker ?? "Run created with a run-owned isolated case. It cannot drive live readiness, providers, outreach, or KPIs." }],
      cleanupNotice: "Cleanup retires only this run's test records. The linked test case and quarantined uploads are preserved for audit; it never deletes operational cases, documents, audit history, holds, or production data.",
    };
    await tx.insert(onbSettings).values({ organizationId, key: key(runId), value: JSON.stringify(run) });
    return { run, caseRow: c };
  });
  // Always seed from the durable run pointer, including an idempotent retry
  // that finds a committed-but-uninitialized run after interruption.
  await seedRunLinkedCase(organizationId, created.run);
  const initialized = await load(organizationId, created.run.runId);
  if (!initialized) throw err("UatRunInitializationFailed", "Run disappeared during explicit linked-case initialization.");
  return publicRun(initialized);
}

export async function getUatRun(organizationId: string, runId: string) {
  const run = await load(organizationId, runId);
  return run ? publicRun(run) : null;
}

export async function applyUatAction(organizationId: string, actor: string, runId: string, action: {
  expectedVersion: number; requestId: string; kind: "record-evidence" | "exchange" | "advance-clock" | "pause" | "resume" | "cleanup" | "issue-candidate-portal" | "inject-harmless-scanner-fact" | "evaluate-workflow";
  stepId?: string | null; result?: Result | null; note?: string | null; system?: System | null; operation?: Operation | null;
  state?: string | null; hours?: number | null; eventKey?: string | null; fixtureId?: string | null; scannerState?: "clean" | "pending" | "failed" | "quarantined" | null;
}, input?: { publicBase?: string; actorRole?: string }) {
  denyRetiredCaseCapability();
  if ((action as { kind: string }).kind === "dispatch-approved-demo-email") {
    throw err("UatActionInvalid", "This historical action is retired and cannot be replayed.");
  }
  let current = await load(organizationId, runId);
  if (!current) throw err("UatRunNotFound", "UAT run not found in this organization.");
  const hash = createHash("sha256").update(JSON.stringify({ ...action, publicBase: undefined })).digest("hex");
  // Ledger lookup precedes optimistic-version validation: a sequential retry
  // receives its already-recorded outcome rather than a false stale conflict.
  const prior = current.actions[action.requestId];
  if (prior) {
    if (prior !== hash && prior !== `pending:${hash}`) throw err("UatRunConflict", "requestId was used for a different action.");
    if (prior === `pending:${hash}`) return reconcilePendingExternal(organizationId, runId, action.requestId, hash, current);
    return publicRun(current);
  }
  if (current.version !== action.expectedVersion) throw err("UatRunVersionConflict", `Run changed since version ${action.expectedVersion}; refresh before retrying.`);
  assertLifecycleAllows(current, action);
  const externalAction = action.kind === "issue-candidate-portal";
  if (action.kind === "issue-candidate-portal" && (!current.linkedCaseIds[0] || !input?.publicBase)) {
    throw err("UatActionInvalid", "A linked UAT case and trusted request portal base are required.");
  }
  const evaluation = action.kind === "evaluate-workflow" ? await evaluateRunWorkflow(organizationId, current) : undefined;
  if (externalAction) {
    const reservation = await reserveExternalAction(organizationId, runId, action.expectedVersion, action.requestId, hash, "issue-candidate-portal", actor);
    if (!reservation.reserved) {
      if (reservation.run.actions[action.requestId] === `pending:${hash}`) {
        return reconcilePendingExternal(organizationId, runId, action.requestId, hash, reservation.run);
      }
      const prior = publicRun(reservation.run);
      if (action.kind === "issue-candidate-portal") {
        return {
          ...prior,
          candidatePortal: {
            canIssue: true,
            status: reservation.run.actions[action.requestId] === `pending:${hash}` ? "pending" : "not-reissued",
            reason: "The one-time portal credential is never retained. Wait for the in-flight action or issue a fresh explicit link with a new request ID.",
          },
        };
      }
      return prior;
    }
    current = reservation.run;
  }
  let candidatePortal: CandidatePortal | undefined;
  let externalFailure: string | undefined;
  if (action.kind === "issue-candidate-portal") {
    const caseId = current!.linkedCaseIds[0];
    const [caseRow] = await db.select().from(onbCases).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId)));
     if (!caseRow || !isUatRunIsolatedCase(caseRow)) {
      externalFailure = "Linked UAT case no longer exists or is not isolated.";
    } else try {
      const issued = await issueCandidatePortalLink({
        organizationId, caseId, issuedBy: portalIssuedBy(runId, action.requestId),
        // This deterministic server-owned identity permits a receipt-only
        // recovery after interruption; the actor remains in the UAT ledger.
        idempotencyKey: `uat-portal:${runId}:${action.requestId}`,
        uatIntent: { runId, requestId: action.requestId, hash, authorityActor: actor },
        publicBase: input!.publicBase!, sendEmail: false,
      });
      if (!issued?.portalUrl) throw err("UatPortalUnavailable", "Candidate portal could not be issued under the current governance boundary.");
      candidatePortal = { caseId, linkId: issued.id, expiresAt: issued.expiresAt.toISOString(), launchUrl: issued.portalUrl };
    } catch (caught) { externalFailure = portalFailureMessage(caught); }
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`onboarding-uat:${organizationId}:${runId}`}))`);
    const [row] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, key(runId)),
    )).for("update");
    const run = row ? parse(row.value) : null;
    if (!run) throw err("UatRunNotFound", "UAT run not found in this organization.");
    if (run.actions[action.requestId] && run.actions[action.requestId] !== `pending:${hash}`) {
      if (run.actions[action.requestId] !== hash) throw err("UatRunConflict", "requestId was used for a different action.");
      return publicRun(run);
    }
    if (run.actions[action.requestId] !== `pending:${hash}` && run.version !== action.expectedVersion) throw err("UatRunVersionConflict", `Run changed since version ${action.expectedVersion}; refresh before retrying.`);
    if (run.actions[action.requestId] !== `pending:${hash}`) assertLifecycleAllows(run, action);
    const at = run.clock.now;
    if (action.kind === "record-evidence") {
      if (!action.result) throw err("UatActionInvalid", "record-evidence requires a result.");
      if (action.stepId && !run.steps.some((step) => step.id === action.stepId)) throw err("UatActionInvalid", "Unknown step ID.");
      if (scenario(run.scenarioId)?.status !== "available" && action.result === "passed") {
        throw err("UatActionInvalid", "Blocked or manual scenarios retain their verification gap; a manually recorded pass cannot make the capability verified.");
      }
      if (action.result === "passed" && (!action.stepId || !action.note?.trim())) {
        throw err("UatActionInvalid", "A manual passed observation requires a specific step and a qualified evidence note; it is not automated sign-off.");
      }
      const qualifier = action.result === "passed"
        ? `Manual qualified observation by authenticated principal ${actor} (${input?.actorRole ?? "tenant-member"}); not automated sign-off or verified capability. `
        : `Manual observation by authenticated principal ${actor} (${input?.actorRole ?? "tenant-member"}). `;
      run.evidence.push({ id: randomUUID(), at, stepId: action.stepId ?? null, result: action.result, provenance: "manual-evidence", note: redact(`${qualifier}${action.note?.trim() || "No additional note supplied."}`) });
    } else if (action.kind === "exchange") {
      if (!action.system || !action.operation || !action.state?.trim()) throw err("UatActionInvalid", "exchange requires system, operation, and state.");
      const eventKey = action.eventKey?.trim() || createHash("sha256").update(`${run.runId}:${action.system}:${action.operation}:${action.state}`).digest("hex");
      if (run.processedEventKeys.includes(eventKey) || run.pendingEvents.some((event) => event.eventKey === eventKey)) {
        run.pendingEvents.push({ id: randomUUID(), at, dueAt: at, kind: "duplicate-event", state: "ignored-duplicate", description: "Duplicate/replayed normalized event", note: "The run-scoped event key was already recorded; no adapter or readiness action occurred.", eventKey, system: action.system, operation: action.operation });
      } else {
        run.exchanges.push({ id: randomUUID(), at, system: action.system, operation: action.operation, state: redact(action.state.trim()),
          note: redact(action.note?.trim() || "Simulated normalized exchange; no provider call and no readiness transition.") });
        if (action.operation === "request" || action.operation === "poll") {
          run.pendingEvents.push({ id: randomUUID(), at, dueAt: future(at, 1), kind: `${action.system}-response`, state: "pending", description: `${action.system} simulated response for ${action.operation}`, note: "Will apply only when this run clock reaches its due time.", eventKey, system: action.system, operation: action.operation });
        } else {
          run.processedEventKeys.push(eventKey);
        }
      }
      run.workflowEvaluation = await evaluateRunWorkflow(organizationId, run);
    } else if (action.kind === "advance-clock") {
      if (!action.hours || action.hours < 1) throw err("UatActionInvalid", "advance-clock requires a positive number of hours.");
      run.clock.offsetHours += action.hours; run.clock.now = future(run.clock.now, action.hours);
      applyDueEvents(run);
      run.evidence.push({ id: randomUUID(), at, stepId: null, result: "not-run", provenance: "simulated", note: `Run-scoped clock advanced ${action.hours} hour(s); production clock, workers, leases, deadlines and credentials are unchanged.` });
      run.workflowEvaluation = await evaluateRunWorkflow(organizationId, run);
    } else if (action.kind === "inject-harmless-scanner-fact") {
      if (!action.fixtureId || !HARMLESS_FIXTURE_IDS.has(action.fixtureId) || !action.scannerState) {
        throw err("UatActionInvalid", "A known harmless fixture ID and scanner state are required; live scanner outcomes cannot be injected.");
      }
      run.scannerFacts = [...run.scannerFacts.filter((fact) => fact.fixtureId !== action.fixtureId), { fixtureId: action.fixtureId, state: action.scannerState, required: true }];
      run.workflowEvaluation = await evaluateRunWorkflow(organizationId, run);
    } else if (action.kind === "evaluate-workflow") {
      run.workflowEvaluation = evaluation;
    } else if (action.kind === "pause") run.status = "paused";
    else if (action.kind === "resume") {
      if (scenario(run.scenarioId)?.status === "blocked") throw err("UatActionInvalid", "A provider-dependent or blocked scenario cannot be resumed into availability.");
      run.status = "active";
    } else if (action.kind === "issue-candidate-portal") {
      if (!candidatePortal) {
        run.evidence.push({ id: randomUUID(), at, stepId: null, result: "blocked", provenance: "manual-evidence", note: `Candidate portal issuance was blocked: ${redact(externalFailure ?? "no launch credential was created")}` });
      } else {
        run.evidence.push({ id: randomUUID(), at, stepId: null, result: "not-run", provenance: "manual-evidence", note: `Explicit no-email candidate portal link issued for linked UAT case ${candidatePortal.caseId}; bearer URL is returned once and never retained in run evidence.` });
      }
    }
    else if (action.kind === "cleanup") {
      // Credential/session retirement is scoped only to case IDs owned by the
      // run. Uploads, their quarantine state, audit history, and legal holds
      // are intentionally retained and are never deleted here.
      await tx.update(onbCandidateLinks).set({ revokedAt: new Date(at) }).where(and(
        eq(onbCandidateLinks.organizationId, organizationId),
        inArray(onbCandidateLinks.caseId, run.linkedCaseIds),
      ));
      // Sessions are retained for lifecycle/hold audit. Their parent links are
      // revoked above, which invalidates them without destructive deletion.
      for (const event of run.pendingEvents) if (event.state === "pending") {
        event.state = "blocked";
        event.note = "Cancelled by run cleanup before its run-clock due time.";
      }
      for (const [requestId, actionHash] of Object.entries(run.actions)) {
        if (!actionHash.startsWith("pending:")) continue;
        const effect = run.externalEffects[requestId];
        if (effect?.kind === "dispatch-approved-demo-email") continue;
        if (effect) {
          effect.state = "terminal-failure";
          effect.finalizedAt = at;
          effect.failure = "Cleanup retired the prepared portal action before a credential could remain active.";
          effect.receiptHash = createHash("sha256").update(`cleanup:${requestId}:${effect.state}`).digest("hex");
        }
        run.actions[requestId] = actionHash.slice("pending:".length);
      }
      run.status = "cleaned";
      run.evidence.push({ id: randomUUID(), at, stepId: null, result: "not-applicable", provenance: "manual-evidence", note: "Run-owned pending events retired and portal links revoked (sessions retained for audit). No case, document, upload, audit record, hold, or production fixture was deleted." });
    }
    if (run.status === "active" && run.evidence.some((item) => item.result === "failed")) run.status = "blocked";
    const prepared = run.externalEffects[action.requestId];
    if (prepared?.state === "prepared") {
      const outcome = candidatePortal ? "confirmed" : "terminal-failure";
      prepared.state = outcome;
      prepared.finalizedAt = at;
      const receipt = candidatePortal
        ? `portal:${candidatePortal.caseId}:${candidatePortal.linkId}:${candidatePortal.expiresAt}`
        : externalFailure ?? "no external receipt";
      prepared.receiptHash = createHash("sha256").update(receipt).digest("hex");
      if (outcome === "terminal-failure") prepared.failure = redact(externalFailure ?? "Provider outcome was not confirmed; no retry was performed.");
    }
    run.actions[action.requestId] = hash; run.version += 1; run.updatedAt = at;
    await tx.insert(onbSettings).values({ organizationId, key: key(runId), value: JSON.stringify(run) })
      .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(run), updatedAt: sql`now()` } });
    return { ...publicRun(run), ...(candidatePortal ? { candidatePortal } : {}) };
  });
}

export function fixturePack(run: Pick<UatRun, "runId" | "scenarioId" | "fixtureSeed">): string {
  denyRetiredCaseCapability();
  return [
    "ONBOARDING UAT TEST DOCUMENT PACK v1", "Test document — not valid for submission", "NOT A GENUINE HR, IDENTITY, BANK, TAX, OR EMPLOYMENT RECORD", "",
    `Run: ${run.runId}`, `Scenario: ${run.scenarioId}`, `Fixture seed: ${run.fixtureSeed}`, "",
    "Files are deliberately harmless text fixtures. Create them locally with the shown content before upload:",
    "01-valid-synthetic-id.txt — Test document — not valid for submission / Name: Avery Example",
    "02-missing-required-information.txt — Test document — not valid for submission / Missing required field",
    "03-expired-date.txt — Test document — not valid for submission / Expiry: 2000-01-01",
    "04-inconsistent-name.txt — Test document — not valid for submission / Name: Different Example Person",
    "05-unsupported-format.exe — do NOT create or upload executable content; verify UI type rejection with a harmless renamed text file only.",
    "06-size-mismatch.txt — use a harmless oversized generated text file only within environment limits.",
    "07-unreadable-or-corrupt.txt — Test document — not valid for submission / deliberately malformed fixture marker",
    "08-changed-bytes.txt — change one harmless byte after recording its checksum.",
    "", "Scanner/provider outcomes may be injected as test evidence. They are not malware scanning, source authenticity, identity verification, or operational-readiness proof.",
  ].join("\n");
}

export function evidenceReport(run: ReturnType<typeof publicRun>) {
  return {
    reportVersion: "onboarding-uat-evidence.v1",
    statement: "Restricted historical acceptance evidence. This report is read-only and non-operational. Stored observations do not certify vendors, authorize live cases, or establish genuine readiness. Blocked/manual/provider-dependent results remain gaps.",
    run,
  };
}