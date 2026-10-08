import { db } from "@workspace/db";
import {
  onbApprovals,
  onbCases,
  onbStandardIntakeEvents,
  onbCommunications,
  onbEvents,
  onbFrontlineReleaseState,
  onbSystemChecks,
  type OnbReadinessItemRow,
  type OnbRecordsEvidenceItem,
  type OnbWorkstreamRow,
} from "@workspace/db/schema";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { withHroCaseContext, recordHroContextStep } from "../hro-context/manager";
import { currentHroContext } from "../hro-context/core";
import { sendOutbound } from "./channels";
import { recordGuardrailEvent } from "./guardrails";
import {
  normalizePreference,
  resolveReplyChannel,
  resolveWelcomeChannels,
} from "./channel-routing";
import { llmComplete } from "./llm";
import {
  bookSlot,
  bookedCall,
  formatSlotOffer,
  generateSlots,
  ianaZoneFor,
  matchSlotChoice,
  pendingProposal,
  proposeSlots,
  timezoneLabelFor,
  wantsCall,
} from "./scheduling";
import { dispatchWorkstreamConnectorMutations } from "./workstream-connectors";
import { applicableSystems, isNonEmployee } from "./external-systems";
import { hasTrustedBgvClearanceEvidence } from "./connector-evidence-provenance";
import { hasCurrentVaultBgvReceipt } from "../employee-vault/reuse";
import {
  EXECUTION_AUTHORIZATION_RULES,
  executionAuthorityScopes,
} from "./decision-authority";
import { evaluateFrontlineFloorReadinessInTransaction } from "./frontline-operations";
import { randomUUID } from "node:crypto";
import {
  LEGACY_CHECKLIST,
  mandatoryChecklistReady,
  checklistStageBlockers,
  readinessFromChecklist,
} from "./settings";
import { latestRequiredUploadMalwareBlockers } from "./document-readiness-guard";
import type {
  OnbAuthorityScope,
  OnbChecklistEnforcementStage,
  OnbChecklistTemplateItem,
} from "@workspace/db/schema";
import { approvalVersion, reopenApprovalInTransaction } from "./approval-version";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import {
  initializeOperationalRequests,
  initializeWorkforceStepTasks,
} from "./operational-requests";
import {
  authorityScopeForApproval,
  decisionAuthorityStillCurrent,
} from "./decision-authority";
import { evaluateStoredCaseGovernanceGate } from "./governance-runtime";
import { withCaseDerivedLifecycleWrite } from "./sensitive-lifecycle";
type CaseRow = typeof onbCases.$inferSelect;

export function checkpointSkipsPlanApproval(checkpoint: string | null | undefined): boolean {
  return checkpoint === "plan-approved";
}

export const OFFER_ACCEPTANCE_GATE_RULE = "Gate A — offer-acceptance package";
export const DAY1_READINESS_GATE_RULE = "Gate C — Day-1 readiness confirmation";

export const MIGRATION_REVIEW_HOLD_RULE = "Migration review — historical checklist classification";
/** Gate A applies to external employee, contractor, and rehire onboarding. */
export function offerAcceptanceRequired(c: Pick<CaseRow, "hireType">): boolean {
  return c.hireType === "external-fte" || c.hireType === "contractor" || c.hireType === "rehire";
}

/* ------------------------------------------------------------------ */
/* Audit helpers                                                       */
/* ------------------------------------------------------------------ */

export async function logEvent(
  caseId: number,
  agent: string,
  engine: "llm" | "rules" | "ldm" | "orchestrator" | "human" | "system",
  title: string,
  detail: string,
  opts?: { hitlPattern?: string; ruleRef?: string; idempotencyKey?: string },
) {
  // Events are always case-owned in the orchestration engine. Resolve the
  // tenant from that authoritative parent rather than relying on a DB default.
  const c = await getCase(caseId);
  await withCaseDerivedLifecycleWrite({ organizationId: c.organizationId, caseId }, (tx) => tx
    .insert(onbEvents)
    .values({
      organizationId: c.organizationId,
      caseId,
      agent,
      engine,
      hitlPattern: opts?.hitlPattern ?? null,
      ruleRef: opts?.ruleRef ?? null,
      title,
      detail,
      idempotencyKey: opts?.idempotencyKey ?? null,
    })
    // With an idempotency key, a crash-resumed writer re-inserting the
    // same event is a no-op at the DB boundary instead of a duplicate.
    .onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    }));
}

async function updateCase(caseId: number, patch: Partial<typeof onbCases.$inferInsert>) {
  const c = await getCase(caseId);
  await withCaseDerivedLifecycleWrite({ organizationId: c.organizationId, caseId }, (tx) => tx
    .update(onbCases)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, c.organizationId))));
}

/**
 * Gate A is before Intake: no plan, connector mutation, welcome message, or
 * portal provisioning may happen until a named HR reviewer confirms the
 * package. Ordinary cases receive an email even for a WhatsApp preference;
 * sendOutbound preserves the case-scoped email authorization boundary and
 * durably records a blocked/uncertain attempt rather than falling back.
 * Trusted standard-intake cases instead retain an HR-reviewable TA source
 * evidence reference, so a duplicate acceptance request is not sent.
 */
export async function enforceOfferAcceptanceGate(
  caseId: number,
  claim?: OrchestrationClaim,
): Promise<boolean> {
  const c = await getCase(caseId);
  if (!offerAcceptanceRequired(c) || c.offerAcceptanceComplete) return true;

  // A trusted source-event record is an acceptance-evidence *reference*, not
  // a completed Gate A. Keep the existing authority-bound human gate, while
  // avoiding a contradictory repeat "please accept" message to a worker whose
  // accepted-offer event is already under HR review.
  const [standardIntakeEvidence] = await db.select({
    sourceId: onbStandardIntakeEvents.sourceId,
  }).from(onbStandardIntakeEvents).where(and(
    eq(onbStandardIntakeEvents.organizationId, c.organizationId),
    eq(onbStandardIntakeEvents.caseId, caseId),
    eq(onbStandardIntakeEvents.state, "created"),
  )).limit(1);
  const delivery = standardIntakeEvidence ? null : await sendOutbound({
    caseId,
    channel: "email",
    toAddress: c.workerEmail,
    subject: "Action required: complete your offer-acceptance package",
    body: `Hello ${c.workerName.split(" ")[0]}, before onboarding can begin, please complete your offer-acceptance package by replying to this email or following the instructions provided by HR. A human HR reviewer will confirm completion before any onboarding activity starts.`,
    idempotencyKey: `gateway-a:${caseId}:offer-package:email`,
  });
  const blocked = delivery ? delivery.status !== "sent" : false;
  const deliveryFailureReason = delivery?.failureReason;
  const deliveryStatus = delivery?.status ?? "not-dispatched";
  await createApproval({
    caseId,
    authorityScope: "hr-compliance-approve",
    agent: "offer-acceptance-gate",
    ruleRef: OFFER_ACCEPTANCE_GATE_RULE,
    hitlPattern: "hard-block",
    recommendation: standardIntakeEvidence
      ? "Review the restricted TA source acceptance evidence reference and confirm package completion"
      : blocked
      ? "Resolve the blocked/uncertain offer-acceptance package email and confirm package completion"
      : "Confirm offer-acceptance package completion after HR evidence review",
    rationale: standardIntakeEvidence
      ? "A trusted TA source event supplied an acceptance evidence reference. An authorized HR reviewer must verify that restricted source reference and use the dedicated Gate A confirmation action; generic approvals cannot release this gate."
      : blocked
      ? `The mandatory email-only offer package request is ${deliveryStatus}${deliveryFailureReason ? `: ${deliveryFailureReason}` : ""}. No WhatsApp fallback is permitted; HR must resolve this before onboarding.`
      : "The offer-acceptance package request was durably dispatched. HR must review the returned evidence and use the dedicated Gate A confirmation action; generic approvals cannot release this gate.",
    // This gate has its own atomic confirmation route. A generic approval may
    // document review, but must never become an orchestration bypass.
    resumeAction: "none",
    idempotencyKey: `gateway-a:${caseId}:human-queue`,
  });
  const patch = {
    orchestrationStatus: "waiting-approval",
    orchestrationCheckpoint: "waiting:offer-acceptance",
    orchestrationClaimOwner: null,
    orchestrationClaimUntil: null,
  } as const;
  if (claim) await fencedCaseUpdate(caseId, claim, patch);
  else {
    // A detached create starter can race the dedicated confirmation route.
    // Never overwrite a confirmed release with the old waiting boundary.
    await db.update(onbCases).set({ ...patch, updatedAt: new Date() }).where(and(
      eq(onbCases.id, caseId),
      eq(onbCases.organizationId, c.organizationId),
      eq(onbCases.offerAcceptanceComplete, false),
    ));
  }
  await logEvent(
    caseId,
    "offer-acceptance-gate",
    "rules",
    "Gate A blocked onboarding pending offer acceptance",
    standardIntakeEvidence
      ? "A trusted TA source event is retained in the restricted intake register. HR must review its acceptance evidence reference and use the dedicated Gate A confirmation; no acceptance-request message was sent and no downstream onboarding action was started."
      : blocked
      ? "Offer-package email is blocked or has an uncertain outcome. A human queue item was created; no downstream onboarding action was started."
      : "Offer-package email was sent first. A human queue item was created; no downstream onboarding action was started.",
    {
      hitlPattern: "hard-block",
      ruleRef: OFFER_ACCEPTANCE_GATE_RULE,
      idempotencyKey: `gateway-a:${caseId}:blocked`,
    },
  );
  return false;
}

async function getCase(caseId: number): Promise<CaseRow> {
  const scope = currentHroContext();
  const [row] = await db.select().from(onbCases).where(and(
    eq(onbCases.id, caseId),
    scope ? eq(onbCases.organizationId, scope.organizationId) : undefined,
  ));
  if (!row) throw new Error(`case ${caseId} not found`);
  return row;
}

export async function createApproval(opts: {
  caseId: number;
  agent: string;
  ruleRef: string;
  hitlPattern: "approve-before-act" | "hard-block";
  recommendation: string;
  rationale: string;
  resumeAction: string;
  /** Structured archive Q&A evidence with per-answer stint scope (rehire escalations). */
  recordsEvidence?: OnbRecordsEvidenceItem[];
  /** Dedupe key: a crash-resumed caller re-creating the same approval is a no-op. */
  idempotencyKey?: string;
  /** Every newly-created decision must declare its designated authority. */
  authorityScope: OnbAuthorityScope;
  requestedByUserId?: string | null;
}) {
  const c = await getCase(opts.caseId);
  const inserted = await withCaseDerivedLifecycleWrite({ organizationId: c.organizationId, caseId: opts.caseId }, (tx) => tx
    .insert(onbApprovals)
    .values({
      organizationId: c.organizationId,
      caseId: opts.caseId,
      agent: opts.agent,
      ruleRef: opts.ruleRef,
      hitlPattern: opts.hitlPattern,
      recommendation: opts.recommendation,
      rationale: opts.rationale,
      recordsEvidence: opts.recordsEvidence ?? null,
      resumeAction: opts.resumeAction,
      idempotencyKey: opts.idempotencyKey ?? null,
      authorityScope: opts.authorityScope,
      // Producer identity is durable case-intake identity unless a later
      // signed-in analyst explicitly supplied their immutable principal ID.
      // Never manufacture a persona/contact string for SoD.
      requestedByUserId: opts.requestedByUserId ?? c.createdByUserId ?? null,
    })
    .onConflictDoNothing({
      target: [onbApprovals.organizationId, onbApprovals.idempotencyKey],
    })
    .returning()) as Array<typeof onbApprovals.$inferSelect>;
  // If the keyed approval already existed, its companion event (and the
  // approver notification) already happened too.
  const row = inserted[0] ?? (opts.idempotencyKey
    ? (await db.select().from(onbApprovals).where(and(
        eq(onbApprovals.organizationId, c.organizationId),
        eq(onbApprovals.idempotencyKey, opts.idempotencyKey),
      )))[0]
    : undefined);
  if (!row) throw new Error("Approval idempotency row disappeared");
  await logEvent(
    opts.caseId,
    opts.agent,
    "rules",
    opts.hitlPattern === "hard-block" ? "Hard-block raised" : "Approval requested",
    `${opts.recommendation} — ${opts.rationale}`,
    {
      hitlPattern: opts.hitlPattern,
      ruleRef: opts.ruleRef,
      idempotencyKey: opts.idempotencyKey ? `${opts.idempotencyKey}:event` : undefined,
    },
  );
  // Email the configured remote HR approver (if any) so they can decide by
  // replying approve/reject from their own inbox. Awaited: on autoscale the
  // process may freeze the moment the owning request completes, so a
  // detached send could be lost. notifyApproverOfApproval never throws, and
  // a delivery failure leaves the approval in the in-app queue as usual.
  // Dynamic import avoids a static engine <-> approver-email cycle.
  try {
    const m = await import("./approver-email");
    await m.notifyApproverOfApproval(row);
  } catch (err) {
    console.error(`[onboarding engine] approver notification failed:`, String(err));
  }
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export function defaultReadiness(): OnbReadinessItemRow[] {
  return readinessFromChecklist(LEGACY_CHECKLIST);
}

/** Null/empty snapshots are pre-migration cases and deliberately retain the legacy contract. */
export function checklistSnapshot(c: Pick<CaseRow, "checklistSnapshot">): OnbChecklistTemplateItem[] {
  return c.checklistSnapshot.length
    ? c.checklistSnapshot
    : LEGACY_CHECKLIST.map((item) => ({ ...item }));
}

export function checklistBlockers(
  c: Pick<CaseRow, "checklistSnapshot" | "readiness">,
  stage: OnbChecklistEnforcementStage,
): OnbChecklistTemplateItem[] {
  return checklistStageBlockers(c, stage);
}

export function documentationGateConfigured(
  c: Pick<CaseRow, "checklistSnapshot">,
  stage?: OnbChecklistEnforcementStage,
): boolean {
  const documentation = checklistSnapshot(c).find((item) => item.id === "documentation");
  return Boolean(
    documentation?.enabled &&
      documentation.mandatory &&
      (stage === undefined || documentation.enforcementStage === stage),
  );
}

function mandatoryMedicalSafetyGate(c: Pick<CaseRow, "checklistSnapshot">): boolean {
  return checklistSnapshot(c).some((item) =>
    item.enabled &&
    item.mandatory &&
    item.nonWaivableSafety === true,
  );
}
async function enforceChecklistGate(
  caseId: number,
  stage: OnbChecklistEnforcementStage,
  claim?: OrchestrationClaim,
): Promise<boolean> {
  const gate = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(onbCases).where(eq(onbCases.id, caseId)).for("update");
    if (!c) throw new Error(`case ${caseId} not found`);
    if (
      claim &&
      (c.orchestrationClaimOwner !== claim.owner ||
        c.orchestrationClaimToken !== claim.token)
    ) {
      throw new Error("Orchestration claim was fenced by a newer worker");
    }
    const blockers = checklistBlockers(c, stage);
    const migrationReviewHolds = checklistSnapshot(c).filter((item) =>
      item.enabled && item.migrationReviewHold === true,
    );
    const malwareBlockers = documentationGateConfigured(c, stage)
      ? await latestRequiredUploadMalwareBlockers(tx, c.organizationId, caseId)
      : [];
    if (blockers.length === 0 && malwareBlockers.length === 0 && migrationReviewHolds.length === 0) {
      return { blockers, malwareBlockers, migrationReviewHolds };
    }
    await tx.update(onbCases).set({
      orchestrationStatus: "checklist-blocked",
      orchestrationCheckpoint: `blocked:${stage}`,
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
      updatedAt: new Date(),
    }).where(eq(onbCases.id, caseId));
    return { blockers, malwareBlockers, migrationReviewHolds };
  });
  if (gate.blockers.length === 0 && gate.malwareBlockers.length === 0 && gate.migrationReviewHolds.length === 0) return true;
  if (gate.migrationReviewHolds.length > 0) {
    await createApproval({
      caseId,
      authorityScope: "hr-compliance-approve",
      agent: "authority-migration",
      ruleRef: MIGRATION_REVIEW_HOLD_RULE,
      hitlPattern: "approve-before-act",
      recommendation: "Review and classify historical mandatory checklist controls before continuation.",
      rationale: `Historical controls require governance review: ${gate.migrationReviewHolds.map((item) => item.label).join("; ")}.`,
      resumeAction: "none",
      idempotencyKey: `migration-review:${caseId}:checklist-classification`,
    });
  }
  const reasons = [
    ...gate.blockers.map((item) => item.label),
    ...gate.migrationReviewHolds.map((item) => `migration review: ${item.label}`),
    ...(gate.malwareBlockers.length > 0
      ? [`${gate.malwareBlockers.length} required candidate upload(s) are pending or failed the malware gate`]
      : []),
  ];
  await logEvent(
    caseId,
    "orchestrator",
    "rules",
    "Mandatory Day-1 checklist gate blocked",
    `${stage}: ${reasons.join("; ")}. No downstream activity was initiated.`,
    {
      ruleRef: "Day-1 checklist gate",
      idempotencyKey: `checklist-gate:${caseId}:${stage}`,
    },
  );
  return false;
}

type OrchestrationClaim = { owner: string; token: number };

async function fencedCaseUpdate(
  caseId: number,
  claim: OrchestrationClaim,
  patch: Partial<typeof onbCases.$inferInsert>,
): Promise<void> {
  const [updated] = await db.update(onbCases).set({ ...patch, updatedAt: new Date() }).where(and(
    eq(onbCases.id, caseId),
    eq(onbCases.orchestrationClaimOwner, claim.owner),
    eq(onbCases.orchestrationClaimToken, claim.token),
  )).returning({ id: onbCases.id });
  if (!updated) throw new Error("Orchestration claim was fenced by a newer worker");
  if (patch.orchestrationCheckpoint && currentHroContext()) {
    await recordHroContextStep("checkpoint-recorded", { reference: patch.orchestrationCheckpoint });
  }
}

async function renewOrchestrationClaim(caseId: number, claim: OrchestrationClaim): Promise<void> {
  const [renewed] = await db.update(onbCases).set({
    orchestrationClaimUntil: sql`now() + interval '15 minutes'`,
    updatedAt: new Date(),
  }).where(and(
    eq(onbCases.id, caseId),
    eq(onbCases.orchestrationClaimOwner, claim.owner),
    eq(onbCases.orchestrationClaimToken, claim.token),
    sql`${onbCases.orchestrationClaimUntil} > now()`,
  )).returning({ id: onbCases.id });
  if (!renewed) throw new Error("Orchestration lease expired or was fenced");
}

export function defaultWorkstreams(): OnbWorkstreamRow[] {
  return [
    { key: "documentation", label: "Documentation & Compliance", agent: "documentation", status: "pending", owner: "HR Ops", blockers: [] },
    { key: "access", label: "Access & System Readiness", agent: "access", status: "pending", owner: "IT / Security", blockers: [] },
    { key: "assets", label: "Asset & Workplace Readiness", agent: "assets", status: "pending", owner: "IT / Facilities", blockers: [] },
    { key: "learning", label: "Learning, Engagement & Readiness", agent: "learning", status: "pending", owner: "L&D / Manager", blockers: [] },
    { key: "analytics", label: "Data & Analytics", agent: "analytics", status: "pending", owner: "People Analytics", blockers: [] },
  ];
}

function setReadiness(items: OnbReadinessItemRow[], key: string, status: string, note?: string) {
  const item = items.find((i) => i.key === key);
  if (item) {
    item.status = status;
    if (note !== undefined) item.note = note;
  }
}

async function mergeManagedReadiness(
  caseId: number,
  desired: OnbReadinessItemRow[],
  managedKeys: readonly string[],
  patch: Partial<typeof onbCases.$inferInsert>,
  claim?: OrchestrationClaim,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(onbCases).where(eq(onbCases.id, caseId)).for("update");
    if (!current) throw new Error(`case ${caseId} not found`);
    if (
      claim &&
      (current.orchestrationClaimOwner !== claim.owner ||
        current.orchestrationClaimToken !== claim.token)
    ) {
      throw new Error("Orchestration claim was fenced by a newer worker");
    }
    const readiness = current.readiness.map((item) => ({ ...item }));
    for (const key of managedKeys) {
      const next = desired.find((item) => item.key === key);
      const existing = readiness.find((item) => item.key === key);
      if (!next || !existing) continue;
      // External/manual completion wins over a stale stage worker. A stage may
      // enrich a ready item but must never downgrade it to pending/in-progress.
      if (existing.status === "ready" && next.status !== "ready") continue;
      existing.status = next.status;
      if (next.note !== undefined) existing.note = next.note;
    }
    await tx.update(onbCases).set({
      ...patch,
      readiness,
      updatedAt: new Date(),
    }).where(and(
      eq(onbCases.id, caseId),
      ...(claim
        ? [
            eq(onbCases.orchestrationClaimOwner, claim.owner),
            eq(onbCases.orchestrationClaimToken, claim.token),
          ]
        : []),
    ));
  });
}

function setWorkstream(
  ws: OnbWorkstreamRow[],
  key: string,
  status: string,
  blockers?: string[],
) {
  const w = ws.find((i) => i.key === key);
  if (w) {
    w.status = status;
    if (blockers) w.blockers = blockers;
  }
}

/* ------------------------------------------------------------------ */
/* Stage 1 — Intake Agent (LDM rule table 4.1)                         */
/* ------------------------------------------------------------------ */

async function runIntake(caseId: number, claim?: OrchestrationClaim): Promise<"continue" | "paused"> {
  if (!(await enforceOfferAcceptanceGate(caseId, claim))) return "paused";
  const c = await getCase(caseId);
  const write = (patch: Partial<typeof onbCases.$inferInsert>) =>
    claim ? fencedCaseUpdate(caseId, claim, patch) : updateCase(caseId, patch);
  await write({ orchestrationStatus: "running", lifecycleStage: "trigger-received" });
  await logEvent(
    caseId,
    "orchestrator",
    "orchestrator",
    "Onboarding trigger received",
    `Case created for ${c.workerName} (${c.hireType}, ${c.geography}). Routing to Intake Agent.`,
    { idempotencyKey: `orchestration:${caseId}:intake:trigger` },
  );

  await logEvent(
    caseId,
    "intake",
    "rules",
    "Case created & hire type classified",
    `Classified as ${c.hireType} / ${c.workerCategory} via deterministic intake rules. Recruiter and manager notified.`,
    { hitlPattern: "notify-only", ruleRef: "4.1 Intake Rule 1", idempotencyKey: `orchestration:${caseId}:intake:classified` },
  );

  let paused = false;

  // Rule 10 — missing core data → hard-block
  if (!c.managerName || !c.role || !c.geography) {
    await createApproval({
      caseId,
      authorityScope: "hr-compliance-approve",
      agent: "intake",
      ruleRef: "4.1 Intake Rule 10",
      hitlPattern: "hard-block",
      recommendation: "Correct missing manager / role / location before onboarding proceeds",
      rationale: "Core onboarding data is missing or conflicting. The agent must not guess core data.",
      resumeAction: "continue-after-intake",
      idempotencyKey: `orchestration:${caseId}:approval:intake-rule-10`,
    });
    paused = true;
  }

  // Rule 8 — BGV pending/adverse → hard-block
  if ((c.notes ?? "").toLowerCase().includes("bgv")) {
    await createApproval({
      caseId,
      authorityScope: "hr-compliance-approve",
      agent: "documentation",
      ruleRef: "4.1 Intake Rule 8 / 4.3 Documentation Rules",
      hitlPattern: "hard-block",
      recommendation:
        "Do not mark onboarding ready. Route BGV exception to TA, Legal and Compliance for human decision.",
      rationale: `BGV status flagged: "${c.notes}". No automated adverse decision is permitted.`,
      resumeAction: "continue-after-intake",
      idempotencyKey: `orchestration:${caseId}:approval:intake-rule-8`,
    });
    await write({ lifecycleStage: "exception" });
    paused = true;
  }

  // Rule 2 — short lead time → elevated urgency (approve-before-act)
  const daysToJoin = Math.round(
    (new Date(c.joiningDate).getTime() - Date.now()) / 86400000,
  );
  if (daysToJoin <= 7 && !paused) {
    await write({ urgency: "elevated" });
    await createApproval({
      caseId,
      authorityScope: "hr-compliance-approve",
      agent: "intake",
      ruleRef: "4.1 Intake Rule 2",
      hitlPattern: "approve-before-act",
      recommendation: `Set urgency = ELEVATED (${daysToJoin} days to joining) and fast-track readiness checks`,
      rationale: "Joining date is within short lead time; expedited handling prevents Day-1 disruption.",
      resumeAction: "continue-after-intake",
      idempotencyKey: `orchestration:${caseId}:approval:intake-rule-2`,
    });
    paused = true;
  }

  // Rules 4/5 — internal transfer & rehire → approve-before-act
  if (c.hireType === "internal-transfer" && !paused) {
    await createApproval({
      caseId,
      authorityScope: "legal-approve",
      agent: "intake",
      ruleRef: "4.1 Intake Rule 4",
      hitlPattern: "approve-before-act",
      recommendation: "Use internal-movement pathway and preserve existing employee identity",
      rationale: "Internal transfer must re-scope access rather than duplicate identity.",
      resumeAction: "continue-after-intake",
      idempotencyKey: `orchestration:${caseId}:approval:intake-rule-4`,
    });
    paused = true;
  }
  if (c.hireType === "rehire" && !paused) {
    // Rule fires deterministically; the evidence-gathering below is an
    // LLM↔LDM exchange: the LLM agent formulates what it needs to know,
    // the LDM (large database model) agent interprets each question and
    // answers it from the archived employment records.
    const {
      ensureDemoRehireArchive,
      formulateRecordsQuestions,
      answerRecordsQuestions,
    } = await import("./records-agent");
    // Demo constructs (scenario/persona cases) get a synthetic archive so
    // the flow is demonstrable; manual rehires keep honest "no records".
    if (c.scenarioKey) {
      await ensureDemoRehireArchive(c.workerEmail, c.workerName, c.organizationId);
    }
    const { questions, viaLlm } = await formulateRecordsQuestions(
      `Rehire case: ${c.workerName}, ${c.role}, ${c.department}, joining ${c.joiningDate}. Notes: ${c.notes ?? "none"}.`,
    );
    await logEvent(caseId, "intake", "llm", "Rehire detected — querying records archive",
      `The reasoning agent asked the LDM records agent:\n${questions.map((q, i) => `${i + 1}. ${q.slice(0, 200)}`).join("\n")}${viaLlm ? "" : "\n(standard question set — AI question forming unavailable)"}`,
      { ruleRef: "4.1 Intake Rule 5", idempotencyKey: `rehire-records:${caseId}:ask` });
    const { stintCount, answers } = await answerRecordsQuestions(
      c.workerEmail,
      questions,
      c.organizationId,
    );
    await logEvent(caseId, "records", "ldm", stintCount > 0
      ? `Employment archive queried (${stintCount} past stints)`
      : "Employment archive queried — no records found",
      answers.map((a) => `Q: ${a.question.slice(0, 200)}\nA: ${a.answer}`).join("\n\n"),
      { ruleRef: "4.1 Intake Rule 5", idempotencyKey: `rehire-records:${caseId}:answer` });
    // Approver-facing evidence is ONLY the deterministic executor output —
    // never model-written prose (case notes are untrusted input).
    const evidence = stintCount > 0
      ? answers.filter((a) => a.interpreted).map((a) => a.answer).join(" ")
      : "No archived employment records were found for this worker; HR must validate the prior record manually.";
    await createApproval({
      caseId,
      authorityScope: "hr-compliance-approve",
      agent: "intake",
      ruleRef: "4.1 Intake Rule 5",
      hitlPattern: "approve-before-act",
      recommendation: "Flag prior employment record and reactivation considerations for HR review",
      rationale: `Rehire detected. ${c.notes ?? "Prior record must be validated before proceeding."} Records evidence: ${evidence || "(no interpretable answers)"}`,
      // Structured Q&A evidence (deterministic executor output only) so the
      // UI can show which stint(s) each answer was scoped to.
      recordsEvidence: stintCount > 0
        ? answers
            .filter((a) => a.interpreted)
            .map((a) => ({ question: a.question, answer: a.answer, scope: a.scope ?? { kind: "all" as const } }))
        : undefined,
      resumeAction: "continue-after-intake",
      idempotencyKey: `rehire-approval:${caseId}`,
    });
    paused = true;
  }

  // Rule 3 — contractor pathway (notify-only)
  if (c.workerCategory === "contractor" || c.workerCategory === "vendor") {
    await logEvent(
      caseId,
      "intake",
      "rules",
      "Routed to non-employee pathway",
      "Contractor/vendor checklist selected; employee-only benefits and payroll items excluded.",
      { hitlPattern: "notify-only", ruleRef: "4.1 Intake Rule 3", idempotencyKey: `orchestration:${caseId}:intake:non-employee` },
    );
  }

  // Rule 11 — client-facing (notify-only)
  if ((c.notes ?? "").toLowerCase().includes("client") || c.department.toLowerCase().includes("client")) {
    await logEvent(
      caseId,
      "intake",
      "rules",
      "Client-facing role flagged",
      "Project-readiness flagged; Delivery Head added to case watchers.",
      { hitlPattern: "notify-only", ruleRef: "4.1 Intake Rule 11", idempotencyKey: `orchestration:${caseId}:intake:client-facing` },
    );
  }

  // Preserve the immutable case snapshot and custom item statuses. Intake may
  // only update the connector-owned profile item.
  const readiness = (c.readiness.length ? c.readiness : defaultReadiness()) as OnbReadinessItemRow[];
  setReadiness(readiness, "profile", paused ? "in-progress" : "ready", paused ? "Awaiting human review" : "Confirmed by Intake Agent");
  await mergeManagedReadiness(
    caseId,
    readiness,
    ["profile"],
    { lifecycleStage: paused ? (await getCase(caseId)).lifecycleStage : "profile-validated" },
    claim,
  );

  if (paused) {
    await write({
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: "waiting:intake",
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
    });
    await reconcileDecidedApprovals(caseId);
    await logEvent(
      caseId,
      "orchestrator",
      "orchestrator",
      "Orchestration paused for human review",
      "One or more intake rules require human approval or hard-block resolution before the plan is generated.",
      { idempotencyKey: `orchestration:${caseId}:intake:paused` },
    );
    return "paused";
  }
  return "continue";
}

/* ------------------------------------------------------------------ */
/* Stage 2 — Plan Generation Agent (LLM + LDM rules 4.2)               */
/* ------------------------------------------------------------------ */

async function runPlanGeneration(
  caseId: number,
  resumingAfterPlanApproval = false,
  claim?: OrchestrationClaim,
): Promise<"continue" | "paused"> {
  const c = await getCase(caseId);
  const write = (patch: Partial<typeof onbCases.$inferInsert>) =>
    claim ? fencedCaseUpdate(caseId, claim, patch) : updateCase(caseId, patch);

  // LDM checklist adjustments per rule table 4.2
  const adjustments: Array<{ rule: string; text: string; hitl: string }> = [];
  const role = c.role.toLowerCase();
  if (role.includes("engineer") || role.includes("architect") || role.includes("developer")) {
    adjustments.push({ rule: "4.2 Plan Rule 1", text: "Development environment, project tools, code repository access and role-specific learning added.", hitl: "notify-only" });
  }
  if (c.department.toLowerCase().includes("finance") || role.includes("financial")) {
    adjustments.push({ rule: "4.2 Plan Rule 2", text: "ERP/finance system readiness and compliance-sensitive training added (governance-sensitive).", hitl: "approve-before-act" });
  }
  if (role.includes("manager")) {
    adjustments.push({ rule: "4.2 Plan Rule 3", text: "Manager induction, people-policy training and direct-report readiness activity added.", hitl: "notify-only" });
  }
  if (c.workerCategory === "contractor" || c.workerCategory === "vendor") {
    adjustments.push({ rule: "4.2 Plan Rule 4", text: "Non-employee checklist selected; employee-only benefits and payroll items excluded.", hitl: "notify-only" });
  }
  if ((c.notes ?? "").toLowerCase().includes("client")) {
    adjustments.push({ rule: "4.2 Plan Rule 5", text: "Client onboarding, project artefacts, delivery context and account-team connection added.", hitl: "approve-before-act" });
  }
  adjustments.push({ rule: "4.2 Plan Rule 7", text: `Statutory forms and local payroll requirements for ${c.geography} added.`, hitl: "notify-only" });
  if (c.hireType === "rehire") {
    adjustments.push({ rule: "4.2 Plan Rule 9", text: "Prior-record validation, reactivation checks and policy re-acknowledgement added.", hitl: "approve-before-act" });
  }
  if (c.hireType === "internal-transfer") {
    adjustments.push({ rule: "4.2 Plan Rule 10", text: "Role-transition plan, access re-scoping, manager change and learning plan added (not a full external onboarding).", hitl: "approve-before-act" });
  }
  if (c.skillCriticality === "scarce" || c.skillCriticality === "client-critical") {
    adjustments.push({ rule: "4.2 Plan Rule 12", text: "Workforce planning and role-readiness review added for skill-critical role.", hitl: "notify-only" });
  }

  const gated = adjustments.filter((a) => a.hitl === "approve-before-act");
  const automatic = adjustments.filter((a) => a.hitl !== "approve-before-act");

  for (const a of automatic) {
    await logEvent(caseId, "plan", "rules", "Checklist adjustment applied", a.text, {
      hitlPattern: a.hitl,
      ruleRef: a.rule,
      idempotencyKey: `orchestration:${caseId}:plan:auto:${a.rule}`,
    });
  }

  if (gated.length > 0 && !resumingAfterPlanApproval) {
    for (const a of gated) {
      await createApproval({
        caseId,
        authorityScope: "hr-compliance-approve",
        agent: "plan",
        ruleRef: a.rule,
        hitlPattern: "approve-before-act",
        recommendation: a.text,
        rationale: "This checklist adjustment is governance-sensitive and requires human approval before it is applied and onboarding proceeds.",
        resumeAction: "continue-after-plan",
        idempotencyKey: `orchestration:${caseId}:approval:plan:${a.rule}`,
      });
    }
    await write({
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: "waiting:plan",
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
    });
    await reconcileDecidedApprovals(caseId);
    await logEvent(caseId, "orchestrator", "orchestrator",
      "Orchestration paused for plan approval",
      "One or more plan adjustments are approve-before-act; workstreams and communications are held until a human approves.",
      { idempotencyKey: `orchestration:${caseId}:plan:paused` });
    return "paused";
  }

  for (const a of gated) {
    await logEvent(caseId, "plan", "rules", "Checklist adjustment applied (human-approved)", a.text, {
      hitlPattern: a.hitl,
      ruleRef: a.rule,
      idempotencyKey: `orchestration:${caseId}:plan:approved:${a.rule}`,
    });
  }

  // LLM plan narrative
  const plan = await llmComplete(
    c,
    "You are the Onboarding Plan Generation Agent in an HR outsourcing company's multi-agent onboarding system. Write a concise onboarding plan narrative (5-8 short bullet lines, plain text with '- ' bullets, no markdown headers) for the HR control tower. Be specific to the case. Do not invent personal data.",
    `Safe operational case context: role=${c.role}; department=${c.department}; geography=${c.geography}; hire type=${c.hireType}; worker category=${c.workerCategory}; joining date=${c.joiningDate}; urgency=${c.urgency}.${c.primarySkill ? ` Primary skill=${c.primarySkill}; criticality=${c.skillCriticality}.` : ""} Checklist adjustments already applied: ${adjustments.map((a) => a.text).join(" ")}`,
  );

  if (plan) {
    await write({ planSummary: plan });
    await logEvent(
      caseId,
      "plan",
      "llm",
      "Onboarding plan generated",
      "Personalised plan narrative drafted by the reasoning engine from the classified case profile and rule-based checklist adjustments.",
      { hitlPattern: "act-then-review", idempotencyKey: `orchestration:${caseId}:plan:narrative` },
    );
  } else {
    await logEvent(
      caseId,
      "plan",
      "system",
      "Plan narrative unavailable",
      "The reasoning engine call failed; rule-based checklist stands. Retry by re-running the scenario.",
      { idempotencyKey: `orchestration:${caseId}:plan:narrative-unavailable` },
    );
  }

  await write({ lifecycleStage: "plan-generated" });
  return "continue";
}

/* ------------------------------------------------------------------ */
/* Stage 3 — Parallel workstream agents (LDM)                          */
/* ------------------------------------------------------------------ */

/** Exported for persisted runtime integration coverage; production callers use orchestration claims. */
export async function runWorkstreams(
  caseId: number,
  claim?: OrchestrationClaim,
): Promise<"paused" | "complete"> {
  const record = await getCase(caseId);
  return withHroCaseContext(record, () => runWorkstreamsInContext(caseId, claim));
}

async function runWorkstreamsInContext(
  caseId: number, claim?: OrchestrationClaim,
): Promise<"paused" | "complete"> {
  const c = await getCase(caseId);
  // Ordinary provider effects each need their own reviewed specialist
  // decision. Gate A/plan approvals only control progression; they never
  // authorize payroll, IAM, BGV, or document effects by implication.
  const executionConnectors = [
    "documents",
    ...applicableSystems(c).map((system) =>
      system.key === "bgv" ? "background-verification"
        : system.key === "itsm" ? "iam" : "payroll",
    ),
  ] as Array<keyof typeof EXECUTION_AUTHORIZATION_RULES>;
  for (const connector of [...new Set(executionConnectors)]) {
    const scopes = executionAuthorityScopes(connector);
    await createApproval({
      caseId,
      authorityScope: scopes[0],
      agent: "workstreams",
      ruleRef: EXECUTION_AUTHORIZATION_RULES[connector],
      hitlPattern: "approve-before-act",
      recommendation: `Authorize the ${connector} provider operation for this case.`,
      rationale: `A current ${scopes.join(" or ")} specialist decision is required immediately before this provider effect.`,
      resumeAction: "continue-after-plan",
      idempotencyKey: `orchestration:${caseId}:approval:execution:${connector}`,
    });
  }
  const executionApprovals = await db.select({ status: onbApprovals.status }).from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, c.organizationId),
    eq(onbApprovals.caseId, caseId),
    sql`${onbApprovals.idempotencyKey} like ${`orchestration:${caseId}:approval:execution:%`}`,
  ));
  if (executionApprovals.some((approval) => approval.status === "pending")) {
    const paused = {
      orchestrationStatus: "waiting-approval" as const,
      orchestrationCheckpoint: "waiting:plan",
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
    };
    if (claim) await fencedCaseUpdate(caseId, claim, paused);
    else await db.update(onbCases).set(paused).where(eq(onbCases.id, caseId));
    return "paused";
  }
  const ws = (c.workstreams.length ? c.workstreams : defaultWorkstreams()) as OnbWorkstreamRow[];
  const readiness = c.readiness as OnbReadinessItemRow[];
  // Gate A is enforced by the caller before this stage. The non-learning
  // operational setup requests remain simulation records. Learning is
  // deliberately excluded: there is no connected LMS/calendar executor, so
  // the immutable policy snapshot is compiled into accountable human tasks.
  await initializeOperationalRequests({
    organizationId: c.organizationId,
    caseId,
    method: "agent",
    actor: "onboarding orchestrator (simulated)",
  });
  const workforceTasks = await initializeWorkforceStepTasks({
    organizationId: c.organizationId,
    caseId,
    actor: "onboarding orchestrator",
  });
  const workforceRuntimeActive = workforceTasks.active;

  // Documentation & Compliance — statutory pack is issued immediately, but
  // for external hires the item stays open until the BGV vendor's status
  // feed confirms clearance (tracked by the System Watcher).
  const bgvTracked = c.hireType !== "internal-transfer";
  setWorkstream(ws, "documentation", "ready");
  setReadiness(
    readiness,
    "documentation",
    bgvTracked ? "in-progress" : "ready",
    bgvTracked
      ? `Statutory pack for ${c.geography} issued — awaiting BGV clearance from the vendor feed`
      : `Statutory pack for ${c.geography} issued and tracked`,
  );
  // Payroll: non-employees (contractor/vendor) are outside payroll — must
  // match applicableSystems() so every in-progress item has a tracker.
  const nonEmployee = isNonEmployee(c.workerCategory);
  const payrollReady = workforceTasks.workstreamBlockingComplete.payroll;
  setReadiness(readiness, "payroll", nonEmployee || payrollReady ? "ready" : "in-progress",
    nonEmployee
      ? "Not applicable — non-employee pathway"
      : !workforceRuntimeActive
        ? "Awaiting bank & tax inputs from new hire; the operational setup request is simulated and no payroll enrollment was sent"
      : payrollReady
        ? "Payroll prerequisite and setup were completed by accountable humans with evidence; no payroll enrollment is claimed."
        : "Payroll readiness is held until the configured prerequisite and human setup confirmation are completed with evidence.");
  if (workforceRuntimeActive && !nonEmployee && !payrollReady) {
    await logEvent(caseId, "payroll", "human", "Payroll connector dispatch held",
      "Only the payroll connector mutation was held because the configured payroll prerequisite and human setup confirmation are incomplete; independent document, BGV, and IAM work remains dispatched through their own guarded operations.",
      { hitlPattern: "hard-block", ruleRef: "workforce-step-runtime/v1", idempotencyKey: `orchestration:${caseId}:workstreams:payroll-held` });
  }
  await logEvent(caseId, "documentation", "rules", "Documentation pack issued",
    `Mandatory identity/statutory documents for ${c.geography} requested; completion tracked with owner notification on gaps.`,
     { hitlPattern: "notify-only", ruleRef: "4.3 Documentation Rule 1", idempotencyKey: `orchestration:${caseId}:workstreams:documentation` });

  // Access & System Readiness
  const accessDetail =
    c.hireType === "internal-transfer"
      ? "Existing identity re-scope request prepared; duplicate identity creation was not performed."
      : c.hireType === "rehire"
        ? "Prior identity lookup noted; reactivation request was not sent to IT Security."
        : c.workerCategory === "contractor"
          ? "Limited-duration access request prepared with automatic expiry requirements noted; no access was provisioned."
          : "Corporate identity, email/collaboration and role-based application access request prepared; no access was provisioned.";
  setWorkstream(ws, "access", "ready");
  setReadiness(
    readiness,
    "access",
    "in-progress",
    `${accessDetail} Simulated ITSM request logged — no access was provisioned; awaiting a future real integration.`,
  );
  await logEvent(caseId, "access", "rules", "Access readiness request simulated", accessDetail, {
    hitlPattern: "act-then-review",
    ruleRef: "4.4 Access Rules",
    idempotencyKey: `orchestration:${caseId}:workstreams:access`,
  });

  // Asset & Workplace Readiness
  const assetsReady = workforceTasks.workstreamBlockingComplete.assets;
  setWorkstream(ws, "assets", assetsReady ? "ready" : "in-progress",
    assetsReady ? [] : ["Accountable human asset/workplace confirmation is required"]);
  setReadiness(readiness, "assets", assetsReady ? "ready" : "in-progress",
    !workforceRuntimeActive
      ? "Simulated asset request logged — no device, ID card or workspace booking occurred"
    : assetsReady
      ? "Asset/workplace readiness was completed by accountable humans with evidence; no device, ID card, or workspace booking is claimed."
      : "Asset/workplace readiness is held until the accountable human task is completed with evidence; no fulfillment request was sent.");
  await logEvent(caseId, "assets", workforceRuntimeActive ? "human" : "rules", !workforceRuntimeActive ? "Assets & workspace request simulated" : assetsReady ? "Assets workforce task already complete" : "Accountable assets workforce task created",
    !workforceRuntimeActive
      ? "Device, ID card and workspace (or remote kit) request was logged for simulation only; no booking or external fulfillment occurred."
    : assetsReady
      ? "Asset/workplace readiness has human-recorded evidence; no booking or external fulfillment is claimed."
      : "No device, ID card, workspace, badge, PPE, or tools request was sent. Action Center requires accountable human completion with evidence.",
     { hitlPattern: "notify-only", ruleRef: "4.5 Asset Rules", idempotencyKey: `orchestration:${caseId}:workstreams:assets` });

  // Learning / Engagement. Unlike the legacy simulation, readiness remains
  // held until these named/role-accountable human tasks are completed through
  // Action Center with required completion evidence.
  const learningTaskNames = workforceTasks.requests
    .filter((request) =>
      request.runtimeSchemaVersion === "workforce-step-runtime/v1" &&
      request.runtimeWorkstream === "learning" &&
      request.mandatory !== false &&
      request.nonblocking !== true &&
      request.status !== "completed",
    )
    .map((request) => request.label);
  const learningReady = workforceTasks.workstreamBlockingComplete.learning;
  const intakeReady = workforceTasks.workstreamBlockingComplete.intake;
  setWorkstream(ws, "learning", learningReady ? "ready" : "in-progress", learningReady ? [] : learningTaskNames);
  setReadiness(
    readiness,
    "learning",
    learningReady ? "ready" : "in-progress",
    !workforceRuntimeActive
      ? "Learning and manager-connect request was logged for simulation only; no learning enrollment or invitation was sent."
    : learningReady
      ? "Mandatory learning workforce tasks are complete with human-recorded evidence. No LMS or calendar completion is claimed."
      : `Awaiting accountable human completion of ${learningTaskNames.length} mandatory learning task(s): ${learningTaskNames.join(", ")}.`,
  );
  if (!intakeReady) {
    setReadiness(
      readiness,
      "profile",
      "in-progress",
      "Configured intake mode/channel is awaiting accountable human confirmation with evidence.",
    );
  }
  setReadiness(
    readiness,
    "checkpoints",
    learningReady ? "ready" : "in-progress",
    learningReady
      ? "Learning and manager-connect workforce tasks are complete; checkpoints remain a human-owned record."
      : "Checkpoint readiness is held until mandatory learning workforce tasks are completed.",
  );
  if (workforceTasks.issues.length) {
    await logEvent(caseId, "learning", "rules", "Learning policy selection is not executable",
      workforceTasks.issues.map((issue) => issue.message).join(" "),
      { hitlPattern: "hard-block", ruleRef: "workforce-step-runtime/v1", idempotencyKey: `orchestration:${caseId}:workstreams:learning:policy-issue` });
  }
  await logEvent(caseId, "learning", "human", learningReady
    ? "Learning workforce tasks already complete"
    : "Accountable learning workforce tasks created",
  learningReady
    ? "The immutable learning policy's mandatory tasks were already completed by accountable humans. No LMS, calendar, message, or simulated agent completion is claimed."
    : `Action Center holds learning readiness until ${learningTaskNames.length} mandatory human task(s) are completed with required evidence. No LMS, calendar, message, or simulated agent was invoked.`,
   { hitlPattern: "hard-block", ruleRef: "workforce-step-runtime/v1", idempotencyKey: `orchestration:${caseId}:workstreams:learning` });

  await mergeManagedReadiness(
    caseId,
    readiness,
    ["profile", "documentation", "payroll", "access", "assets", "learning", "checkpoints"],
    { workstreams: ws, lifecycleStage: "preboarding" },
    claim,
  );
  // A held IAM/payroll release is expected operational work rather than a
  // failed orchestration. Documents/BGV may already have been safely
  // journaled; retain that partial success and park at a durable retry
  // checkpoint without claiming either held release completed.
  const dispatchOutcome = await dispatchWorkstreamConnectorMutations(c);
  if (dispatchOutcome.releaseHeld) {
    await logEvent(
      caseId,
      "workstreams",
      "rules",
      "Release workstream waiting on Standard Operations",
      `${dispatchOutcome.heldConnectors.join(" and ")} release remains held by current Standard Operations evidence, approval, date-reconciliation, or HR Operations hold requirements. Independent workstream effects remain separately journaled and will not be duplicated on retry.`,
      {
        hitlPattern: "hard-block",
        ruleRef: "standard-operations/release-gate",
        idempotencyKey: `orchestration:${caseId}:workstreams:standard-operations-held`,
      },
    );
    const waiting = {
      lifecycleStage: "preboarding" as const,
      orchestrationStatus: "checklist-blocked" as const,
      orchestrationCheckpoint: "waiting:standard-operations-release",
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
    };
    if (claim) await fencedCaseUpdate(caseId, claim, waiting);
    else await db.update(onbCases).set(waiting).where(eq(onbCases.id, caseId));
    return "paused";
  }

  // The guarded connector dispatch above registered every applicable
  // externally-owned item with the System Watcher. The watcher closes each
  // readiness item only after its simulated source system confirms.
  return "complete";
}

/* ------------------------------------------------------------------ */
/* Stage 4 — Preboarding communications (LLM drafted, act-then-review) */
/* ------------------------------------------------------------------ */

async function runCommunications(caseId: number) {
  const c = await getCase(caseId);

  const draft = await llmComplete(
    c,
    "You are the onboarding communications assistant. Write a warm, professional pre-boarding welcome message to a new joiner. Under 120 words, plain text, no placeholders like [Name] — use the actual details given. Sign off as 'The Onboarding Team'.",
    `Safe operational context: the new joiner starts as ${c.role} in ${c.department} on ${c.joiningDate} in ${c.geography}. Mention that their onboarding checklist has been prepared and they can reply with any question. Do not include a name or manager identity.`,
    400,
  );
  const body =
    draft ??
    `Welcome aboard, ${c.workerName}! Your onboarding for the ${c.role} role starting ${c.joiningDate} is underway. Your checklist is prepared — reply to this message with any question.\n— The Onboarding Team`;

  const routing = resolveWelcomeChannels(c.channelPreference, c.workerPhone);
  await logEvent(caseId, "channel", "rules", "Channel preference applied",
    `HR channel preference for this case is "${normalizePreference(c.channelPreference)}". Welcome communications are routed accordingly.`,
    { hitlPattern: "notify-only", idempotencyKey: `orchestration:${caseId}:communications:channel` });

  if (routing.whatsappSkipped) {
    await logEvent(caseId, "channel", "system", "WhatsApp welcome skipped",
      routing.emailIsFallback
        ? "Channel preference is WhatsApp but the case has no phone number — welcome sent via email as fallback."
        : "Channel preference includes WhatsApp but the case has no phone number — email only.",
      { hitlPattern: "notify-only", idempotencyKey: `orchestration:${caseId}:communications:whatsapp-skipped` });
  }

  if (routing.channels.includes("email")) {
    const email = await sendOutbound({
      caseId,
      channel: "email",
      toAddress: c.workerEmail,
      subject: `Welcome, ${c.workerName.split(" ")[0]} — your onboarding has started`,
      body,
      idempotencyKey: `orchestration:${caseId}:welcome:email`,
    });
    if (email.status === "sending") {
      throw new Error(email.failureReason ?? "Email delivery outcome is unknown and requires manual reconciliation");
    }
    await logEvent(caseId, "channel", draft ? "llm" : "system",
      routing.emailIsFallback ? "Welcome email dispatched (fallback)" : "Welcome email dispatched",
      `Pre-boarding welcome drafted by the reasoning engine. Delivery status: ${email.status}${email.failureReason ? ` — ${email.failureReason}` : ""}.`,
      { hitlPattern: "act-then-review", idempotencyKey: `orchestration:${caseId}:welcome:email:event` });
  }

  if (routing.channels.includes("whatsapp") && c.workerPhone) {
    const wa = await sendOutbound({
      caseId,
      channel: "whatsapp",
      toAddress: c.workerPhone,
      body: `Hi ${c.workerName.split(" ")[0]}! This is your onboarding assistant. Your Day-1 checklist for ${c.joiningDate} is ready — reply here anytime with questions.`,
      idempotencyKey: `orchestration:${caseId}:welcome:whatsapp`,
    });
    if (wa.status === "sending") {
      throw new Error(wa.failureReason ?? "WhatsApp delivery outcome is unknown and requires manual reconciliation");
    }
    await logEvent(caseId, "channel", "system", "WhatsApp welcome dispatched",
      wa.status === "sent"
        ? "WhatsApp welcome delivered via Twilio."
        : wa.status === "logged-only"
          ? `WhatsApp welcome logged only${wa.failureReason ? ` — ${wa.failureReason}` : "."}`
          : `WhatsApp send failed: ${wa.failureReason}`,
      { hitlPattern: "act-then-review", idempotencyKey: `orchestration:${caseId}:welcome:whatsapp:event` });
  }
}

/* ------------------------------------------------------------------ */
/* Stage 5 — Data & Analytics Agent + readiness review                 */
/* ------------------------------------------------------------------ */

async function runAnalyticsAndReview(caseId: number, claim?: OrchestrationClaim) {
  if (!(await enforceOfferAcceptanceGate(caseId, claim))) return false;
  const c = await getCase(caseId);

  const review = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(onbCases).where(eq(onbCases.id, caseId)).for("update");
    if (!current) throw new Error(`case ${caseId} not found`);
    if (
      claim &&
      (current.orchestrationClaimOwner !== claim.owner ||
        current.orchestrationClaimToken !== claim.token)
    ) {
      throw new Error("Orchestration claim was fenced by a concurrent checklist transition");
    }
    const malwareBlockers = documentationGateConfigured(current)
      ? await latestRequiredUploadMalwareBlockers(tx, current.organizationId, caseId)
      : [];
    if (malwareBlockers.length > 0) {
      await tx.update(onbCases).set({
        orchestrationStatus: "checklist-blocked",
        orchestrationCheckpoint: "blocked:re-review",
        orchestrationClaimOwner: null,
        orchestrationClaimUntil: null,
        updatedAt: new Date(),
      }).where(eq(onbCases.id, caseId));
      return {
        allReady: false,
        promoted: false,
        malwareBlockers,
      };
    }
    const ws = current.workstreams.map((item) => ({ ...item })) as OnbWorkstreamRow[];
    setWorkstream(ws, "analytics", "ready");
    const blockers = ws.flatMap((w) => w.blockers);
    const allReady = mandatoryChecklistReady(current);
    const promoted = allReady && blockers.length === 0;
    const reviewPatch = promoted
      ? {
          workstreams: ws,
          lifecycleStage: "day1-review",
          orchestrationStatus: "waiting-approval",
          orchestrationCheckpoint: "waiting:day1-readiness",
          orchestrationClaimOwner: null,
          orchestrationClaimUntil: null,
          updatedAt: new Date(),
        }
      : {
          workstreams: ws,
          lifecycleStage: "preboarding",
          orchestrationStatus: "checklist-blocked",
          orchestrationCheckpoint: "blocked:re-review",
          orchestrationClaimOwner: null,
          orchestrationClaimUntil: null,
          updatedAt: new Date(),
        };
    const [updated] = await tx.update(onbCases).set(reviewPatch).where(and(
      eq(onbCases.id, caseId),
      ...(claim
        ? [
            eq(onbCases.orchestrationClaimOwner, claim.owner),
            eq(onbCases.orchestrationClaimToken, claim.token),
          ]
        : []),
    )).returning({ id: onbCases.id });
    if (!updated) throw new Error("Orchestration review commit was fenced");
    if (promoted) {
      await tx.insert(onbApprovals).values({
        organizationId: current.organizationId,
        caseId,
        agent: "day1-readiness-gate",
        ruleRef: DAY1_READINESS_GATE_RULE,
        hitlPattern: "approve-before-act",
        recommendation: "Review live Day-1 readiness and confirm onboarding completion",
        rationale: "All currently configured mandatory readiness items passed this review. HR confirmation is still required and will re-check live document-malware evidence before completion; no automated employment action is taken.",
        resumeAction: "none",
        authorityScope: "hr-compliance-approve",
        idempotencyKey: `gateway-c:${caseId}:human-queue`,
      }).onConflictDoNothing({
        target: [onbApprovals.organizationId, onbApprovals.idempotencyKey],
      });
      // A medical/safety checklist item is not waived by HR's final review.
      // It gets its own designated Occupational Health/EHS decision cycle.
      if (mandatoryMedicalSafetyGate(current)) {
        await tx.insert(onbApprovals).values({
          organizationId: current.organizationId,
          caseId,
          agent: "occupational-health-gate",
          ruleRef: "Medical/Safety — designated clearance",
          hitlPattern: "approve-before-act",
          recommendation: "Confirm mandatory medical/safety clearance",
          rationale: "This case has a mandatory medical, occupational-health, safety, or EHS checkpoint. HR final approval cannot waive this designated-authority gate.",
          resumeAction: "none",
          authorityScope: "occupational-health-approve",
          idempotencyKey: `gateway-medical-safety:${caseId}:human-queue`,
        }).onConflictDoNothing({
          target: [onbApprovals.organizationId, onbApprovals.idempotencyKey],
        });
      }
    }
    return { allReady, promoted, malwareBlockers: [] as number[] };
  });
  if (
    c.skillCriticality === "scarce" ||
    c.skillCriticality === "client-critical"
  ) {
    await logEvent(caseId, "analytics", "rules", "Critical skill inflow flagged",
      `Skill "${c.primarySkill}" (${c.skillCriticality}) entering the workforce. Aggregated insight routed to HR, Talent Planning and Delivery — individual-level judgement is never published.`,
      { hitlPattern: "notify-only", ruleRef: "14.2 Analytics Rules", idempotencyKey: `orchestration:${caseId}:analytics:critical-skill` });
  }
  await logEvent(caseId, "orchestrator", "orchestrator", "Readiness review complete",
    review.malwareBlockers.length > 0
      ? `${review.malwareBlockers.length} required candidate upload(s) are pending or failed the malware gate. Case remains blocked until the latest upload is cleared and documentation readiness is reconciled.`
      : review.promoted
      ? "All configured mandatory readiness items are complete. Case moves to Day-1 review; recommendation to complete will follow the joining date."
      : "Configured mandatory items remain incomplete and visible on the checklist; owners have been notified.",
    {
      hitlPattern: "notify-only",
      ruleRef: "4.7 Readiness Rule 10",
      idempotencyKey: `orchestration:${caseId}:review:${review.promoted ? "complete" : "blocked"}`,
    });
  if (review.promoted) {
    // Gate C queue creation and the waiting boundary committed atomically
    // above, so a crash cannot lose the final-review handoff.
    return false;
  }
  return review.promoted;
}

/**
 * Gate C's approval is intentionally narrower than generic approval handling.
 * Re-evaluate the live mandatory/malware boundary while holding the case lock
 * so an approval cannot race a document replacement or checklist reopen.
 */
export async function completeDay1ReadinessGate(caseId: number): Promise<boolean> {
  // The tenant identity is immutable on a case. Read it before opening the
  // fenced transaction so the transaction itself can take the authority fence
  // before it obtains any case/approval row locks.
  const [tenant] = await db.select({ organizationId: onbCases.organizationId })
    .from(onbCases).where(eq(onbCases.id, caseId));
  if (!tenant) return false;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenant.organizationId}))`);
    const [c] = await tx.select().from(onbCases).where(eq(onbCases.id, caseId)).for("update");
    if (!c) return false;
    // Enrollment is additive: a legacy complete case must not be replayed by
    // the approval recovery worker merely because it has an old approved row.
    if (c.lifecycleStage === "complete") return false;
    const [approval] = await tx.select().from(onbApprovals).where(and(
      eq(onbApprovals.organizationId, c.organizationId),
      eq(onbApprovals.caseId, caseId),
      eq(onbApprovals.idempotencyKey, `gateway-c:${caseId}:human-queue`),
      eq(onbApprovals.status, "approved"),
    ));
    if (!approval || !(await decisionAuthorityStillCurrent(tx, approval))) return false;
    // Gate C is a live frontline release. Keep the verified compound
    // authority fence and independently fail closed on the adopted governance
    // snapshot before changing the case to complete.
    const governanceGate = await evaluateStoredCaseGovernanceGate({
      caseRow: c,
      workflow: "frontline-deployment",
    });
    if (!governanceGate.allowed) {
      await reopenApprovalInTransaction(tx, {
        organizationId: c.organizationId,
        caseId,
        idempotencyKey: `gateway-c:${caseId}:human-queue`,
        reason: `Automatically reopened because final live release is blocked by governance: ${governanceGate.blockers.map((blocker) => blocker.kind).join(",")}.`,
        actor: "day1-readiness-gate",
      });
      return false;
    }
    const requiresMedicalSafety = mandatoryMedicalSafetyGate(c);
    const [medicalSafetyApproval] = requiresMedicalSafety
      ? await tx.select().from(onbApprovals).where(and(
          eq(onbApprovals.organizationId, c.organizationId),
          eq(onbApprovals.caseId, caseId),
          eq(onbApprovals.idempotencyKey, `gateway-medical-safety:${caseId}:human-queue`),
          eq(onbApprovals.status, "approved"),
        ))
      : [undefined];
    if (requiresMedicalSafety && (
      !medicalSafetyApproval ||
      !(await decisionAuthorityStillCurrent(tx, medicalSafetyApproval))
    )) return false;
    const frontlineGate = await evaluateFrontlineFloorReadinessInTransaction(tx, c);
    const [frontlineReleaseState] = frontlineGate.applicable
      ? await tx.select().from(onbFrontlineReleaseState).where(and(
        eq(onbFrontlineReleaseState.organizationId, c.organizationId),
        eq(onbFrontlineReleaseState.caseId, caseId),
      )).for("update")
      : [undefined];
    if (frontlineGate.applicable && (
      frontlineReleaseState?.status !== "released" || frontlineGate.blockers.length > 0
    )) {
      await reopenApprovalInTransaction(tx, {
        organizationId: c.organizationId, caseId,
        idempotencyKey: `gateway-c:${caseId}:human-queue`,
        reason: "Automatically reopened because the dedicated frontline floor release state is absent/stale or live evidence is blocked: " +
          frontlineGate.blockers.join(" "),
        actor: "day1-readiness-gate",
      });
      return false;
    }
    const malwareBlockers = documentationGateConfigured(c)
      ? await latestRequiredUploadMalwareBlockers(tx, c.organizationId, caseId)
      : [];
    const bgvChecks = await tx.select().from(onbSystemChecks).where(and(
      eq(onbSystemChecks.organizationId, c.organizationId),
      eq(onbSystemChecks.caseId, caseId),
      eq(onbSystemChecks.system, "bgv"),
    ));
    const bgvClear = hasTrustedBgvClearanceEvidence(bgvChecks) || await hasCurrentVaultBgvReceipt(tx, c.organizationId, caseId);
    // The weighted readiness policy is optional during rollout. When the SLA
    // agent exports its hook, evaluate it inside this same final-review
    // transaction so the score and the approval cannot observe different
    // evidence. Historical complete cases intentionally bypass enrollment.
    let weightedReadinessPass = true;
    if (c.lifecycleStage !== "complete") {
      try {
        const slaModule = await import("./readiness-sla-policy");
        const gate = (slaModule as unknown as {
          readinessSlaGateForCase?: (tx: unknown, organizationId: string, caseId: number) => Promise<{ passes: boolean }>;
        }).readinessSlaGateForCase;
        if (gate) {
          const weighted = await gate(tx, c.organizationId, caseId);
          weightedReadinessPass = weighted.passes;
        }
      } catch (error) {
        // The policy worker is a separately enrolled rollout. Preserve the
        // existing Gate C authority until its module/schema is present, but do
        // not hide failures from an installed policy hook.
        const detail = String(error);
        if (!/does not provide an export|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(detail)) {
          throw error;
        }
      }
    }
    // BGV is required only where the configured documentation gate and case
    // pathway make it applicable. In that boundary, absence is not a green
    // result; a configured live check must exist and be done.
    const bgvRequired = documentationGateConfigured(c) && applicableSystems(c).some((system) => system.key === "bgv");
    if (!weightedReadinessPass || !mandatoryChecklistReady(c) || malwareBlockers.length > 0 || (bgvRequired && !bgvClear)) {
      // A previous Gate C approval authorizes only the readiness state that was
      // reviewed. Reopening evidence/checks revokes that authority; recovery
      // must never turn an old approval into a later automatic completion.
      await reopenApprovalInTransaction(tx, {
        organizationId: c.organizationId,
        caseId,
        idempotencyKey: `gateway-c:${caseId}:human-queue`,
        reason: "Automatically reopened because live readiness evidence changed; fresh HR confirmation is required.",
        actor: "day1-readiness-gate",
      });
      await tx.update(onbCases).set({
        lifecycleStage: "preboarding",
        orchestrationStatus: "checklist-blocked",
        orchestrationCheckpoint: "blocked:re-review",
        orchestrationClaimOwner: null,
        orchestrationClaimUntil: null,
        updatedAt: new Date(),
      }).where(eq(onbCases.id, caseId));
      return false;
    }
    await tx.update(onbCases).set({
      lifecycleStage: "complete",
      orchestrationStatus: "done",
      orchestrationCheckpoint: "review-complete",
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
      updatedAt: new Date(),
    }).where(eq(onbCases.id, caseId));
    await tx.insert(onbEvents).values({
      organizationId: c.organizationId,
      caseId,
      agent: "day1-readiness-gate",
      engine: "human",
      hitlPattern: "approve-before-act",
      ruleRef: DAY1_READINESS_GATE_RULE,
      title: "Gate C Day-1 readiness confirmed by HR",
      detail: "A human reviewer approved the final Day-1 readiness confirmation after current mandatory checklist and malware evidence were re-evaluated. No automated adverse employment action was taken.",
      // Completion belongs to the approval cycle, not merely the case. A
      // reopened Gate C must be able to record its later fresh confirmation.
      idempotencyKey: `gateway-c:${caseId}:complete:v${approvalVersion(approval.version)}`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    return true;
  });
}
/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

async function runFromPlan(
  caseId: number,
  resumingAfterPlanApproval = false,
  claim?: OrchestrationClaim,
) {
  if (!claim) throw new Error("A durable orchestration claim is required");
  if (!(await enforceOfferAcceptanceGate(caseId, claim))) return;
  await fencedCaseUpdate(caseId, claim, { orchestrationStatus: "running" });
  const plan = await runPlanGeneration(caseId, resumingAfterPlanApproval, claim);
  if (plan === "paused") return;
  await renewOrchestrationClaim(caseId, claim);
  if (!(await enforceChecklistGate(caseId, "before-workstreams", claim))) return;
  if ((await runWorkstreams(caseId, claim)) === "paused") return;
  await fencedCaseUpdate(caseId, claim, { orchestrationCheckpoint: "workstreams-complete" });
  if (!(await enforceChecklistGate(caseId, "before-employee-communications", claim))) return;
  await renewOrchestrationClaim(caseId, claim);
  await runCommunications(caseId);
  await fencedCaseUpdate(caseId, claim, { orchestrationCheckpoint: "communications-complete" });
  if (!(await enforceChecklistGate(caseId, "before-day1-review", claim))) return;
  await renewOrchestrationClaim(caseId, claim);
  if (!(await runAnalyticsAndReview(caseId, claim))) return;
  await fencedCaseUpdate(caseId, claim, {
    orchestrationCheckpoint: "review-complete",
    orchestrationClaimOwner: null,
    orchestrationClaimUntil: null,
  });
}

/** Fire-and-forget orchestration for a freshly created case. */
export function startOrchestration(caseId: number) {
  void runCaseContextAttempt(caseId, async () => {
    let claim: OrchestrationClaim | undefined;
    try {
      const [offlineCase] = await db
        .select()
        .from(onbCases)
        .where(eq(onbCases.id, caseId));
      if (offlineCase && isSyntheticOfflineCase(offlineCase)) return;
      const owner = randomUUID();
      const [claimed] = await db.update(onbCases)
        .set({
          orchestrationStatus: "running",
          orchestrationCheckpoint: "initial",
          orchestrationClaimOwner: owner,
          orchestrationClaimToken: sql`${onbCases.orchestrationClaimToken} + 1`,
          orchestrationClaimUntil: sql`now() + interval '15 minutes'`,
          updatedAt: new Date(),
        })
        .where(and(eq(onbCases.id, caseId), eq(onbCases.orchestrationStatus, "idle")))
        .returning({ token: onbCases.orchestrationClaimToken });
      if (!claimed) return;
      claim = { owner, token: claimed.token };
      if (!(await enforceOfferAcceptanceGate(caseId, claim))) return;
      const intake = await runIntake(caseId, claim);
      if (intake === "continue") {
        await fencedCaseUpdate(caseId, claim, { orchestrationCheckpoint: "plan" });
        await runFromPlan(caseId, false, claim);
      }
    } catch (err) {
      console.error(`[onboarding engine] case ${caseId} failed:`, err);
      if (claim) {
        await fencedCaseUpdate(caseId, claim, {
          orchestrationStatus: "blocked",
          orchestrationClaimOwner: null,
          orchestrationClaimUntil: null,
        }).catch(() => {});
      }
      await logEvent(caseId, "orchestrator", "system", "Orchestration error",
        `Unexpected failure: ${String(err).slice(0, 300)}`).catch(() => {});
      throw err;
    }
  });
}

/** Detached continuations reload the subject; a closed HTTP frame is never revived. */
async function runCaseContextAttempt(caseId: number, action: () => Promise<void>) {
  try {
    const record = await getCase(caseId);
    await withHroCaseContext(record, action);
  } catch {
    console.error("[onboarding context] case execution attempt failed");
  }
}

/**
 * Continue exactly after a checklist boundary. The conditional claim makes
 * simultaneous item completions and retries collapse to one orchestration run.
 */
export async function resumeChecklistOrchestration(caseId: number): Promise<boolean> {
  const record = await getCase(caseId);
  if (!record) return false;
  return withHroCaseContext(record, () => resumeChecklistOrchestrationInContext(caseId));
}

async function resumeChecklistOrchestrationInContext(caseId: number): Promise<boolean> {
  const [offlineCase] = await db
    .select()
    .from(onbCases)
    .where(eq(onbCases.id, caseId));
  if (offlineCase && isSyntheticOfflineCase(offlineCase)) return false;
  const owner = randomUUID();
  const [claimed] = await db.update(onbCases)
    .set({
      orchestrationStatus: "running",
      orchestrationClaimOwner: owner,
      orchestrationClaimToken: sql`${onbCases.orchestrationClaimToken} + 1`,
      orchestrationClaimUntil: sql`now() + interval '60 seconds'`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(onbCases.id, caseId),
      or(
        eq(onbCases.orchestrationStatus, "checklist-blocked"),
        and(
          eq(onbCases.orchestrationStatus, "running"),
          or(
            sql`${onbCases.orchestrationClaimUntil} is null`,
            sql`${onbCases.orchestrationClaimUntil} <= now()`,
          ),
        ),
      ),
      sql`${onbCases.orchestrationCheckpoint} in (
        'blocked:before-workstreams',
        'blocked:before-employee-communications',
        'blocked:before-day1-review',
        'blocked:re-review',
        'waiting:standard-operations-release',
        'initial',
        'plan',
        'intake-approved',
        'plan-approved',
        'workstreams-complete',
        'communications-complete'
      )`,
    ))
    .returning();
  if (!claimed) return false;
  const claim = { owner, token: claimed.orchestrationClaimToken };
  const checkpoint = claimed.orchestrationCheckpoint;
  try {
    await renewOrchestrationClaim(caseId, claim);
    if (!(await enforceOfferAcceptanceGate(caseId, claim))) return true;
    if (checkpoint === "initial") {
      const intake = await runIntake(caseId, claim);
      if (intake === "continue") {
        await fencedCaseUpdate(caseId, claim, { orchestrationCheckpoint: "plan" });
        await runFromPlan(caseId, false, claim);
      }
      return true;
    }
    if (
      checkpoint === "plan" ||
      checkpoint === "intake-approved" ||
      checkpoint === "plan-approved"
    ) {
      if (checkpoint === "intake-approved") {
        const current = await getCase(caseId);
        const readiness = current.readiness.map((item) => ({ ...item }));
        setReadiness(readiness, "profile", "ready", "Human review completed and approved");
        await mergeManagedReadiness(
          caseId,
          readiness,
          ["profile"],
          { lifecycleStage: "profile-validated" },
          claim,
        );
      }
      await runFromPlan(caseId, checkpointSkipsPlanApproval(checkpoint), claim);
      return true;
    }
    if (checkpoint === "blocked:re-review") {
      const ready = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(onbCases).where(eq(onbCases.id, caseId)).for("update");
        if (!current) throw new Error(`case ${caseId} not found`);
        if (
          current.orchestrationClaimOwner !== claim.owner ||
          current.orchestrationClaimToken !== claim.token
        ) {
          throw new Error("Orchestration claim was fenced by a newer worker");
        }
        const malwareBlockers = documentationGateConfigured(current)
          ? await latestRequiredUploadMalwareBlockers(tx, current.organizationId, caseId)
          : [];
        return malwareBlockers.length === 0 && mandatoryChecklistReady(current);
      });
      if (!ready) {
        await fencedCaseUpdate(caseId, claim, {
          orchestrationStatus: "checklist-blocked",
          orchestrationClaimOwner: null,
          orchestrationClaimUntil: null,
        });
        return false;
      }
      if (!(await runAnalyticsAndReview(caseId, claim))) return false;
      await fencedCaseUpdate(caseId, claim, {
        orchestrationCheckpoint: "review-complete",
        orchestrationClaimOwner: null,
        orchestrationClaimUntil: null,
      });
      return true;
    }
    if (checkpoint === "blocked:before-workstreams") {
      if (!(await enforceChecklistGate(caseId, "before-workstreams", claim))) return false;
      if ((await runWorkstreams(caseId, claim)) === "paused") return true;
      await fencedCaseUpdate(caseId, claim, { orchestrationCheckpoint: "workstreams-complete" });
      if (!(await enforceChecklistGate(caseId, "before-employee-communications", claim))) return true;
    }
    if (checkpoint === "waiting:standard-operations-release") {
      // This checkpoint is reached only after the pre-workstreams checklist
      // gate has passed and independent setup already ran. Re-running the
      // workstream preparation would also attempt to rebase already-claimed
      // human workforce tasks after a date correction. Retry only the
      // journal-fenced provider mutations; each repeats current authority and
      // Standard Operations checks immediately before its write.
      const outcome = await dispatchWorkstreamConnectorMutations(await getCase(caseId));
      if (outcome.releaseHeld) return true;
      await fencedCaseUpdate(caseId, claim, { orchestrationCheckpoint: "workstreams-complete" });
      if (!(await enforceChecklistGate(caseId, "before-employee-communications", claim))) return true;
    }
    if (
      checkpoint === "blocked:before-workstreams" ||
      checkpoint === "waiting:standard-operations-release" ||
      checkpoint === "blocked:before-employee-communications" ||
      checkpoint === "workstreams-complete"
    ) {
      if (checkpoint !== "blocked:before-workstreams" &&
          checkpoint !== "waiting:standard-operations-release" &&
          !(await enforceChecklistGate(caseId, "before-employee-communications", claim))) return false;
      await renewOrchestrationClaim(caseId, claim);
      await runCommunications(caseId);
      await fencedCaseUpdate(caseId, claim, { orchestrationCheckpoint: "communications-complete" });
      if (!(await enforceChecklistGate(caseId, "before-day1-review", claim))) return true;
    }
    if (
      checkpoint === "blocked:before-day1-review" ||
      checkpoint === "communications-complete"
    ) {
      if (!(await enforceChecklistGate(caseId, "before-day1-review", claim))) return false;
    }
    await renewOrchestrationClaim(caseId, claim);
    if (!(await runAnalyticsAndReview(caseId, claim))) return false;
    await fencedCaseUpdate(caseId, claim, {
      orchestrationCheckpoint: "review-complete",
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
    });
    return true;
  } catch (error) {
    await db.update(onbCases).set({
      orchestrationStatus: "checklist-blocked",
      orchestrationClaimOwner: null,
      orchestrationClaimUntil: null,
      updatedAt: new Date(),
    }).where(and(
      eq(onbCases.id, caseId),
      eq(onbCases.orchestrationClaimOwner, claim.owner),
      eq(onbCases.orchestrationClaimToken, claim.token),
    ));
    throw error;
  }
}

type ApprovalContinuation = (
  caseId: number,
  planApprovalAlreadyGranted: boolean,
  claim: OrchestrationClaim,
) => Promise<void>;

/**
 * Durable lost-wakeup reconciler. The case row is the serialization point:
 * exactly one caller can turn a fully-decided waiting approval set into a
 * continuation claim, whether the caller is the decision request, the engine
 * entering its wait state, or the watcher after a crash.
 */
export async function reconcileDecidedApprovals(
  caseId: number,
  continueRun: ApprovalContinuation = runFromPlan,
): Promise<boolean> {
  const owner = randomUUID();
  // See completeDay1ReadinessGate: fence authority changes before acquiring
  // the case serialization lock, matching approval decisions and revocations.
  const [tenant] = await db.select({ organizationId: onbCases.organizationId })
    .from(onbCases).where(eq(onbCases.id, caseId));
  if (!tenant) return false;
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenant.organizationId}))`);
    const [c] = await tx.select().from(onbCases).where(eq(onbCases.id, caseId)).for("update");
    if (!c || c.orchestrationStatus !== "waiting-approval") return null;
    const legacyNullCheckpoint = c.orchestrationCheckpoint === null;
    let resumeAction =
      c.orchestrationCheckpoint === "waiting:plan"
        ? "continue-after-plan"
        : c.orchestrationCheckpoint === "waiting:intake"
          ? "continue-after-intake"
          : null;
    let approvals: Array<typeof onbApprovals.$inferSelect>;
    if (resumeAction) {
      approvals = await tx.select().from(onbApprovals).where(and(
        eq(onbApprovals.caseId, caseId),
        eq(onbApprovals.organizationId, c.organizationId),
        eq(onbApprovals.resumeAction, resumeAction),
      ));
    } else if (c.orchestrationCheckpoint === null) {
      // Legacy waiting rows predate stage checkpoints. Require every persisted
      // pipeline approval to be decided (and none rejected), then infer the
      // furthest reached stage. A plan approval can only be created after the
      // intake set completed, so its presence distinguishes the plan wait.
      approvals = (await tx.select().from(onbApprovals).where(and(
        eq(onbApprovals.caseId, caseId),
        eq(onbApprovals.organizationId, c.organizationId),
      ))).filter((approval) => approval.resumeAction !== "none");
      resumeAction = approvals.some(
        (approval) => approval.resumeAction === "continue-after-plan",
      )
        ? "continue-after-plan"
        : approvals.some((approval) => approval.resumeAction === "continue-after-intake")
          ? "continue-after-intake"
          : null;
    } else {
      return null;
    }
    if (!resumeAction) return null;
    if (approvals.length === 0 || approvals.some((approval) => approval.status === "pending")) {
      return null;
    }
    if (approvals.some((approval) => approval.status === "rejected")) {
      await tx.update(onbCases).set({
        orchestrationStatus: "blocked",
        lifecycleStage: "exception",
        orchestrationClaimOwner: null,
        orchestrationClaimUntil: null,
        updatedAt: new Date(),
      }).where(eq(onbCases.id, caseId));
      return null;
    }
    // Final continuation boundary: an approval can be valid when recorded and
    // become invalid before the asynchronous continuation obtains the case
    // claim (revocation, expiry, governance withdrawal, scope/case change or
    // assignment revision). Do not continue on historical role evidence.
    for (const approval of approvals) {
      const lacksReviewedAuthorityEvidence =
        !approval.authorityScope ||
        !approval.decidedAuthorityId ||
        !Number.isSafeInteger(approval.decidedAuthorityRevision) ||
        !approval.decidedAuthorityRevision;
      // Historical approvals predate assignment/revision evidence. They must
      // never be treated as approved, but an active workflow needs a usable
      // reviewed renewal rather than a permanently stuck null-scope row.
      // Reopening preserves the immutable prior cycle in approval history and
      // retains its resume action; completed cases remain non-replayable.
      if (
        approval.status === "approved" &&
        lacksReviewedAuthorityEvidence &&
        c.lifecycleStage !== "complete"
      ) {
        await reopenApprovalInTransaction(tx, {
          organizationId: c.organizationId,
          caseId,
          approvalId: approval.id,
          authorityScope: authorityScopeForApproval(approval),
          reason: "Legacy approval lacks reviewed authority assignment and revision evidence; a fresh specialist decision is required.",
          actor: "authority-migration",
        });
        await tx.insert(onbEvents).values({
          organizationId: c.organizationId,
          caseId,
          agent: "authority-migration",
          engine: "rules",
          hitlPattern: "approve-before-act",
          ruleRef: approval.ruleRef,
          title: "Legacy approval renewed for reviewed decision",
          detail: "Historical approval evidence was archived and a new pending cycle was created with the original continuation semantics. No completed provider effect is replayed.",
          idempotencyKey: `decision-authority:${approval.id}:v${approval.version}:legacy-renewal`,
        }).onConflictDoNothing({
          target: [onbEvents.organizationId, onbEvents.idempotencyKey],
        });
        return null;
      }
      if (
        approval.status === "approved" &&
        !(await decisionAuthorityStillCurrent(tx, approval))
      ) {
        await tx.update(onbCases).set({
          orchestrationStatus: "blocked",
          lifecycleStage: "exception",
          orchestrationClaimOwner: null,
          orchestrationClaimUntil: null,
          updatedAt: new Date(),
        }).where(eq(onbCases.id, caseId));
        await tx.insert(onbEvents).values({
          organizationId: c.organizationId,
          caseId,
          agent: "decision-authority",
          engine: "rules",
          hitlPattern: "hard-block",
          ruleRef: approval.ruleRef,
          title: "Approved decision invalidated before continuation",
          detail: "The current verified authority, scope, revision, tenancy, or separation-of-duties evidence no longer permits continuation. No downstream action was dispatched.",
          idempotencyKey: `decision-authority:${approval.id}:v${approval.version}:continuation-blocked`,
        }).onConflictDoNothing({
          target: [onbEvents.organizationId, onbEvents.idempotencyKey],
        });
        return null;
      }
    }
    const checkpoint = resumeAction === "continue-after-plan" ? "plan-approved" : "intake-approved";
    const repairLegacyPlanProfile =
      legacyNullCheckpoint && resumeAction === "continue-after-plan";
    const readiness = repairLegacyPlanProfile
      ? (() => {
          const merged = (c.readiness.length ? c.readiness : defaultReadiness()).map(
            (item) => ({ ...item }),
          );
          let profile = merged.find((item) => item.key === "profile");
          if (!profile) {
            const legacyProfile = defaultReadiness().find((item) => item.key === "profile");
            if (legacyProfile) {
              profile = { ...legacyProfile };
              merged.push(profile);
            }
          }
          if (profile) {
            profile.status = "ready";
            profile.note = "Historical intake and plan approvals completed";
          }
          return merged;
        })()
      : undefined;
    const [row] = await tx.update(onbCases).set({
      orchestrationStatus: "running",
      orchestrationCheckpoint: checkpoint,
      orchestrationClaimOwner: owner,
      orchestrationClaimToken: sql`${onbCases.orchestrationClaimToken} + 1`,
      orchestrationClaimUntil: sql`now() + interval '15 minutes'`,
      ...(readiness ? { readiness } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(onbCases.id, caseId),
      eq(onbCases.orchestrationStatus, "waiting-approval"),
    )).returning({ token: onbCases.orchestrationClaimToken });
    return row ? { checkpoint, token: row.token } : null;
  });
  if (!claimed) return false;
  const claim = { owner, token: claimed.token };
  if (claimed.checkpoint === "intake-approved") {
    const current = await getCase(caseId);
    const readiness = current.readiness.map((item) => ({ ...item }));
    setReadiness(readiness, "profile", "ready", "Human review completed and approved");
    await mergeManagedReadiness(
      caseId,
      readiness,
      ["profile"],
      { lifecycleStage: "profile-validated" },
      claim,
    );
  }
  await continueRun(caseId, claimed.checkpoint === "plan-approved", claim);
  return true;
}

/** Resume after a human decision on an approval. */
export function resumeAfterDecision(opts: {
  caseId: number;
  approved: boolean;
  decidedBy: string;
  comment: string | null;
  recommendation: string;
  ruleRef: string | null;
  hitlPattern: string;
  resumeAction: string;
  authorityScope?: OnbAuthorityScope | null;
}) {
  void runCaseContextAttempt(opts.caseId, async () => {
    try {
      const [offlineCase] = await db
        .select()
        .from(onbCases)
        .where(eq(onbCases.id, opts.caseId));
      if (offlineCase && isSyntheticOfflineCase(offlineCase)) return;
      if (opts.ruleRef === MIGRATION_REVIEW_HOLD_RULE) {
        if (!opts.approved) return;
        // This approval is an explicit governance classification of the
        // conservative migration hold, not a medical clearance. It removes
        // only the hold bit; genuinely designated safety controls retain
        // their independently configured nonWaivableSafety bit.
        await db.transaction(async (tx) => {
          if (!offlineCase) return;
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${offlineCase.organizationId}))`);
          const [current] = await tx.select().from(onbCases)
            .where(eq(onbCases.id, opts.caseId)).for("update");
          if (!current || current.lifecycleStage === "complete") return;
          await tx.update(onbCases).set({
            checklistSnapshot: checklistSnapshot(current).map((item) => ({
              ...item,
              ...(item.migrationReviewHold === true ? { migrationReviewHold: false } : {}),
            })),
            updatedAt: new Date(),
          }).where(eq(onbCases.id, opts.caseId));
        });
        await resumeChecklistOrchestration(opts.caseId);
        return;
      }
      const isHardBlock = opts.hitlPattern === "hard-block";
      const isDedicatedGatewayDecision = opts.ruleRef === OFFER_ACCEPTANCE_GATE_RULE ||
        opts.ruleRef === "Gate B — background verification" ||
        opts.ruleRef === DAY1_READINESS_GATE_RULE;
      const isStandaloneAcknowledgement = opts.resumeAction === "none" && !isDedicatedGatewayDecision;
      const decisionTitle = isStandaloneAcknowledgement
        ? "Review acknowledged — source completion/mandatory gates still required"
        : opts.ruleRef === OFFER_ACCEPTANCE_GATE_RULE
        ? "Gate A review decision recorded — dedicated confirmation still required"
        : isHardBlock
        ? opts.approved
          ? "Hard-block resolved by human owner"
          : "Hard-block upheld by human owner"
        : opts.approved
        ? "Approved by human reviewer"
        : "Rejected by human reviewer";
      const decisionDetail = isStandaloneAcknowledgement
        ? `${opts.decidedBy} acknowledged the ${opts.approved ? "approval" : "rejection"} review for ${opts.ruleRef ?? "the standalone escalation"}: "${opts.recommendation}"${opts.comment ? ` — ${opts.comment}` : ""}. Review acknowledged; source completion/mandatory gates still required. No lifecycle transition or downstream authorization occurred.`
        : opts.ruleRef === OFFER_ACCEPTANCE_GATE_RULE
        ? `${opts.decidedBy} recorded a Gate A review decision. The offer package remains blocked until the dedicated HR confirmation action records completion; no onboarding continuation occurred.`
        : `${opts.decidedBy} ${opts.approved ? (isHardBlock ? "resolved the hard-block and authorised onboarding to proceed" : "approved") : (isHardBlock ? "upheld the hard-block" : "rejected")}: "${opts.recommendation}"${opts.comment ? ` — ${opts.comment}` : ""}. ${isHardBlock ? "Decision made under human authority; no automated adverse action was taken." : ""}`;
      await logEvent(opts.caseId, "human", "human",
        decisionTitle,
        decisionDetail,
        { hitlPattern: opts.hitlPattern });
      // Gate A can only be released by its tenant-scoped, audited
      // /offer-acceptance confirmation route. An approval decision may record
      // HR's review of the blocked send, but cannot alter lifecycle state or
      // continue orchestration.
      if (
        opts.ruleRef === OFFER_ACCEPTANCE_GATE_RULE ||
        opts.ruleRef === "Gate B — background verification"
      ) return;
      // A designated medical/safety decision may be the second required Gate
      // C proof. Re-evaluate the final boundary after it commits rather than
      // allowing the generic standalone-acknowledgement path to swallow it.
      if (opts.authorityScope === "occupational-health-approve" && opts.approved) {
        await completeDay1ReadinessGate(opts.caseId);
        return;
      }
      // Pre-authority migration recovery is a deliberately narrow operation.
      // It has its own legal decision and never re-enters plan continuation,
      // which could otherwise dispatch unrelated BGV/IAM/payroll providers.
      if (opts.resumeAction === "recover-document-envelope") {
        if (!opts.approved) return;
        const [current] = await db.select().from(onbCases).where(eq(onbCases.id, opts.caseId));
        // Completed cases preserve their historical state; no recovery replay.
        if (!current || current.lifecycleStage === "complete") return;
        const { dispatchDocumentPackRecovery } = await import("./workstream-connectors");
        await dispatchDocumentPackRecovery(current);
        return;
      }
      // SLA/source-completion acknowledgements are records only. In
      // particular, a hard-block acknowledgement must not promote the case
      // before the source stream and mandatory gateway checks complete.
      if (isStandaloneAcknowledgement) return;

      // Only the dedicated Gate C decision can complete Day-1 review. Generic
      // approvals (including an approved BGV exception) are never a shortcut
      // around current mandatory checklist or malware gates.
      if (opts.ruleRef === DAY1_READINESS_GATE_RULE) {
        if (opts.approved) {
          const completed = await completeDay1ReadinessGate(opts.caseId);
          if (!completed) {
            await logEvent(
              opts.caseId,
              "day1-readiness-gate",
              "rules",
              "Gate C confirmation did not release onboarding",
              "The human decision was recorded, but current mandatory readiness or malware evidence no longer passed. The case remains blocked for human resolution.",
              { hitlPattern: "hard-block", ruleRef: DAY1_READINESS_GATE_RULE, idempotencyKey: `gateway-c:${opts.caseId}:approval-stale` },
            );
          }
        }
        return;
      }
      if (isHardBlock && opts.approved) {
        await updateCase(opts.caseId, { lifecycleStage: "profile-validated" });
      }

      // Standalone escalations (e.g. sensitive inbound message review) never
      // resume the pipeline — the decision itself is the action.
      if (opts.resumeAction === "none") return;

      await reconcileDecidedApprovals(opts.caseId);
    } catch (err) {
      console.error(`[onboarding engine] resume case ${opts.caseId} failed:`, err);
      throw err;
    }
  });
}

/** React to an inbound message from the new hire (LLM reply, act-then-review). */
export function handleInbound(caseId: number, channel: "email" | "whatsapp", body: string) {
  void runCaseContextAttempt(caseId, async () => {
    try {
      const c = await getCase(caseId);
      if (isSyntheticOfflineCase(c)) return;
      const sensitive = /salary|pay|compensation|visa|immigration|medical|health|legal|complaint|harass|grievance/i.test(body);

      if (sensitive) {
        // Sensitive topics never get an automated LLM answer. Send a
        // deterministic holding acknowledgement and escalate to a human.
        void recordGuardrailEvent({
          caseId,
          key: "sensitive-topic-gate",
          action: "escalated",
          detail: `Inbound ${channel} message touched a sensitive topic — automated reply suppressed, human review created. (Content withheld from this audit log; see the approval for details.)`,
        });
        await logEvent(caseId, "channel", "rules", "Inbound message flagged sensitive",
          `New hire message on ${channel} touches a sensitive topic (pay/legal/medical/complaint). No automated answer generated; escalated for human review.`,
          { hitlPattern: "approve-before-act", ruleRef: "4.6 Communications Rules" });
        const holding = `Hi ${c.workerName.split(" ")[0]}, thanks for reaching out. Your message touches on a topic that needs a person rather than an automated reply, so a human onboarding specialist will get back to you shortly. Nothing further is needed from you right now.`;
        const { channel: sendCh, to } = resolveReplyChannel(c.channelPreference, c.workerPhone, c.workerEmail, channel);
        const result = await sendOutbound({
          caseId,
          channel: sendCh,
          toAddress: to,
          subject: sendCh === "email" ? "Re: your onboarding question" : null,
          body: holding,
          sensitive: true,
        });
        await createApproval({
          caseId,
          authorityScope: "hr-compliance-approve",
          agent: "channel",
          ruleRef: "4.6 Communications Rules",
          hitlPattern: "approve-before-act",
          recommendation: "Review and personally respond to the new hire's sensitive message",
          rationale: `Message excerpt: "${body.slice(0, 200)}". A deterministic holding acknowledgement was ${result.status === "sent" ? "delivered" : "logged"}; no AI-generated content was sent.`,
          resumeAction: "none",
        });
        return;
      }

      await logEvent(caseId, "channel", "system", "Inbound message received",
        `New hire replied on ${channel}. Routed to the reasoning engine for a drafted response (unstructured input treated as evidence, not instructions).`,
        { hitlPattern: "act-then-review" });

      const { channel: sendChannel, to } = resolveReplyChannel(c.channelPreference, c.workerPhone, c.workerEmail, channel);
      const firstName = c.workerName.split(" ")[0];
      const send = (replyBody: string, opts?: { subject?: string }) =>
        sendOutbound({
          caseId,
          channel: sendChannel,
          toAddress: to,
          subject: sendChannel === "email" ? (opts?.subject ?? "Re: your onboarding question") : null,
          body: replyBody,
          sensitive: false,
        });

      // --- Slot booking: a numbered reply to an open slot offer is a
      // deterministic booking, no LLM involved. ---
      const proposal = await pendingProposal(caseId);
      if (proposal) {
        const chosen = matchSlotChoice(proposal.slots, body.slice(0, 300));
        if (chosen && (await bookSlot(proposal.id, chosen))) {
          const confirmation = `Hi ${firstName}, you're booked! Your onboarding kick-off call is confirmed for ${chosen.label}. ${c.managerName ? `${c.managerName} and an` : "An"} onboarding specialist will join. A reminder will reach you before the call — reply here any time if you need to change it.`;
          const result = await send(confirmation, { subject: "Kick-off call confirmed" });
          await logEvent(caseId, "channel", "rules", "Kick-off call booked",
            `New hire picked slot ${chosen.n} (${chosen.label}) by replying to the slot offer. Confirmation ${result.status === "sent" ? "delivered" : "logged"} on ${sendChannel}.`,
            { hitlPattern: "notify-only", ruleRef: "4.6 Communications Rules" });
          return;
        }
      }

      // Candidate messages and communication history are private records.
      // They are intentionally never assembled into an external LLM prompt;
      // a human receives these requests through the existing approval path.
      const booked = await bookedCall(caseId);
      const askingForCall = wantsCall(body);
      const tz = timezoneLabelFor(c.geography);
      const ai: { reply: string; needs_human: boolean; reason?: string } | null = null;
      const aiFailed = true;
      const needsHuman = true;

      if (needsHuman) {
        // The AI can't resolve this — alert + bring a human into the loop.
        const reason = "Private inbound content is not disclosed to an external language model";
        const holding = `Hi ${firstName}, thanks for your message — this one needs a person rather than an automated reply. A human onboarding specialist has been looped in and will get back to you shortly.`;
        const result = await send(holding);
        await createApproval({
          caseId,
          authorityScope: "hr-compliance-approve",
          agent: "channel",
          ruleRef: "4.6 Communications Rules",
          hitlPattern: "approve-before-act",
          recommendation: "AI could not resolve this new-hire message — respond personally",
          rationale: `${reason}. Message excerpt: "${body.slice(0, 200)}". A holding reply was ${result.status === "sent" ? "delivered" : "logged"}; no unverified AI answer was sent.`,
          resumeAction: "none",
        });
        void recordGuardrailEvent({
          caseId,
          key: "inbound-injection-fence",
          action: "escalated",
          detail: `Reasoning engine refused to auto-resolve an inbound ${channel} message (${reason}) — routed to human review. (Content withheld from this audit log; see the approval for details.)`,
        });
        await logEvent(caseId, "channel", "orchestrator", "AI escalated to human (HITL)",
          `The reasoning engine could not resolve the inbound message (${reason}). Alert raised and a pending human review created; the new hire received a holding acknowledgement on ${sendChannel}.`,
          { hitlPattern: "approve-before-act", ruleRef: "4.6 Communications Rules" });
        return;
      }

      // --- Compose the final reply; append real bookable slots if asked. ---
      let replyBody = ai!.reply;
      let subject: string | undefined;
      if (askingForCall && !booked) {
        const slots = generateSlots(new Date(), tz, ianaZoneFor(c.geography));
        await proposeSlots(caseId, slots);
        replyBody = `${replyBody}\n\n${formatSlotOffer(slots)}`;
        subject = "Your onboarding kick-off call — pick a slot";
        await logEvent(caseId, "channel", "rules", "Kick-off call slots offered",
          `Three bookable slots proposed (${slots.map((s) => s.label).join("; ")}). The hire books by replying with the slot number.`,
          { hitlPattern: "notify-only", ruleRef: "4.6 Communications Rules" });
      }

      const result = await send(replyBody, { subject });
      await logEvent(caseId, "channel", "llm", "Reply drafted & dispatched",
        `Contextual reply (grounded in checklist, document pack and conversation history) status on ${sendChannel}: ${result.status}${result.failureReason ? ` — ${result.failureReason}` : ""}.`,
        { hitlPattern: "act-then-review" });
    } catch (err) {
      console.error(`[onboarding engine] inbound case ${caseId} failed:`, err);
      // Operational failure must still reach a human: best-effort durable
      // alert (approval + event). If even this fails, the console error
      // above and the monitor telemetry remain the last line of defense.
      try {
        await createApproval({
          caseId,
          authorityScope: "hr-compliance-approve",
          agent: "channel",
          ruleRef: "4.6 Communications Rules",
          hitlPattern: "approve-before-act",
          recommendation: "Inbound message handling failed — review and respond personally",
          rationale: `Processing the new hire's ${channel} message crashed (${String(err).slice(0, 200)}). The hire may not have received any reply. Message excerpt: "${body.slice(0, 200)}".`,
          resumeAction: "none",
        });
        await logEvent(caseId, "channel", "orchestrator", "Inbound handling failed — human alerted",
          `Unhandled error while processing an inbound ${channel} message; a pending human review was created so the hire is not left without a response. Error: ${String(err).slice(0, 200)}`,
          { hitlPattern: "approve-before-act", ruleRef: "4.6 Communications Rules" });
      } catch (alertErr) {
        console.error(`[onboarding engine] failed to raise HITL alert for case ${caseId}:`, alertErr);
      }
      throw err;
    }
  });
}
