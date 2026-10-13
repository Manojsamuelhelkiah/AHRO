import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbActionCenterActions,
  onbApprovalHistory,
  onbApprovals,
  onbCases,
  onbCandidateUploads,
  onbEffectJournal,
  onbCommunications,
  onbDocuments,
  onbEvents,
  onbSystemChecks,
} from "@workspace/db/schema";
import { documentNeedsCorrection, sendDocumentReminder, type DocumentReminderMode } from "./document-validation";
import { reminderEligible } from "./document-validation-policy";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import { isHistoricalTestRecord } from "./historical-test-record";
import { getUatCaseIsolation } from "./uat-isolation";
import { denyRetiredCaseCapability } from "../retired-case-capabilities";
import { externalProviderDispatchDenied } from "./provider-policy";
import { isChecklistAdministrator } from "./checklist";
import { sensitiveClassForDocument, withSensitiveAuthorityFence } from "./sensitive-access";
import { resolveClientActionRouting } from "./client-operations-settings";

export type ActionCenterScope = "active" | "completed" | "all";
export type ActionCenterAccess = "standard" | "synthetic-demo-simulation";
export type ActionCenterWorkforceFilter = "white-collar" | "blue-collar-frontline" | "mixed" | "needs-review" | "unclassified";
export type ActionCenterCallOutcome =
  | "reached"
  | "no-answer"
  | "left-voicemail"
  | "wrong-number"
  | "scheduled"
  | "declined"
  | "other";
export type ActionCenterWorkOwner =
  | "hr"
  | "recruiter"
  | "hiring-manager"
  | "bgv-team"
  | "documentation"
  | "operations"
  | "compliance";

export class ActionCenterNotFoundError extends Error {
  constructor(message = "Case or Action Center record not found.") {
    super(message);
    this.name = "ActionCenterNotFoundError";
  }
}
export class ActionCenterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionCenterConflictError";
  }
}
export class ActionCenterOfflineError extends Error {
  constructor() {
    super(
      "This synthetic sample is paused offline; Action Center mutations are read-only and no action was recorded.",
    );
    this.name = "ActionCenterOfflineError";
  }
}
export class ActionCenterPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionCenterPermissionError";
  }
}

/**
 * Action Center writes are deliberately narrower than tenant membership.
 * Demo members may operate the local simulation ledger, but a Demo request
 * can never turn this endpoint into a live volunteer/provider path. Live
 * No Demo run or retained consent can authorize new volunteer contact.
 */
export function assertActionCenterMutationAuthorized(
  organizationId: string,
  organizationRole: string | undefined,
  mode?: "live" | "simulation",
  access: ActionCenterAccess = "standard",
): void {
  if (access === "synthetic-demo-simulation") {
    if (organizationId !== DEMO_ORGANIZATION_ID) {
      throw new ActionCenterPermissionError(
        "Synthetic Action Center simulation is available only in Demo Organization.",
      );
    }
    if (mode === "live") {
      throw new ActionCenterPermissionError(
        "Demo Action Center access supports simulation only; live provider effects are blocked.",
      );
    }
    return;
  }
  if (organizationId === DEMO_ORGANIZATION_ID && mode === "live") {
    throw new ActionCenterPermissionError(
      "Demo Action Center cannot dispatch live contact.",
    );
  }
  if (organizationId !== DEMO_ORGANIZATION_ID && !isChecklistAdministrator(organizationRole)) {
    throw new ActionCenterPermissionError(
      "Organization owner or admin role required for Action Center mutations.",
    );
  }
}

type ActionRow = typeof onbActionCenterActions.$inferSelect;

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;
const caseHref = (caseId: number) => `/cases/${caseId}`;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function actionCompleted(status: string): boolean {
  return ["completed", "sent", "logged-only", "blocked", "failed"].includes(status);
}

function actionPublic(row: ActionRow, providerEffectId: string | null = null) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    caseId: row.caseId,
    actor: row.actorName,
    verified: row.verified,
    selfReported: row.selfReported,
    providerEffectId,
    createdAt: row.createdAt.toISOString(),
  };
}

type DocumentReminderActionResult = {
  action: ReturnType<typeof actionPublic>;
  idempotent: boolean;
  actionVersion: number;
};

function reminderEffectKey(providerIdempotencyKey: string): string {
  return `candidate-communication:${providerIdempotencyKey}`;
}

async function loadReminderEffect(
  organizationId: string,
  providerIdempotencyKey: string,
) {
  const [effect] = await db.select().from(onbEffectJournal).where(and(
    eq(onbEffectJournal.organizationId, organizationId),
    eq(onbEffectJournal.logicalOperationKey, reminderEffectKey(providerIdempotencyKey)),
  ));
  return effect ?? null;
}

function caseSummary(
  row: typeof onbCases.$inferSelect,
  access: ActionCenterAccess = "standard",
) {
  const pausedOffline = isSyntheticOfflineCase(row);
  const canAct = access === "synthetic-demo-simulation"
    ? pausedOffline
    : !pausedOffline;
  return {
    workerName: row.workerName,
    workerEmail: row.workerEmail,
    role: row.role,
    workforceClassification: row.workforceClassification,
    siteExposure: Boolean(row.workforceContext.siteExposure),
    safetyCritical: Boolean(row.workforceContext.safetyCritical),
    joiningDate: row.joiningDate,
    lifecycleStage: row.lifecycleStage,
    urgency: row.urgency,
    pausedOffline,
    canAct,
    aiCallHref: `${caseHref(row.id)}?tab=communications`,
  };
}

function priorityForCase(row: typeof onbCases.$inferSelect): "critical" | "high" | "medium" | "low" {
  const days = (new Date(row.joiningDate).getTime() - Date.now()) / 86_400_000;
  if (row.urgency === "critical" || days <= 2) return "critical";
  if (row.urgency === "urgent" || days <= 7) return "high";
  if (days <= 14) return "medium";
  return "low";
}

function deliveryLabel(status: string, subject?: string | null): string {
  if (status === "simulated" || (status === "logged-only" && /^\[SIMULATED\]/i.test(subject ?? ""))) {
    return "Simulated";
  }
  if (status === "logged-only") return "Not sent";
  if (status === "sent" || status === "delivered" || status === "confirmed") return "Sent";
  if (status === "sending") return "Sending";
  if (status === "failed" || status === "blocked" || status === "unknown_effect_manual_repair") return "Failed";
  return "Recorded";
}

/** Display the snapshotted outbound identity, never use message text as authority. */
function outboundIdentityLine(
  communication: typeof onbCommunications.$inferSelect,
  label: string,
): string | null {
  if (communication.direction !== "outbound") return null;
  const line = communication.body.split(/\r?\n/).find(value => value.startsWith(`${label}: `));
  return line?.slice(label.length + 2).trim().slice(0, 300) || null;
}

function reminderActionStatus(status: string): ActionRow["status"] {
  return status === "sent" || status === "delivered"
    ? "sent"
    : status === "sending"
      ? "sending"
      : status === "logged-only"
        ? "logged-only"
        : status === "blocked"
          ? "blocked"
          : "failed";
}

async function reserveAction(input: {
  organizationId: string;
  caseId: number;
  kind: string;
  requestId: string;
  body: unknown;
  actorUserId: string;
  actorName: string;
  organizationRole?: string;
  status: ActionRow["status"];
  owner?: string | null;
  assignee?: string | null;
  outcome?: string | null;
  notes?: string | null;
  persona?: string | null;
  selfReported?: boolean;
  verified?: boolean;
  expectedVersion?: number;
  targetActionId?: number;
  access?: ActionCenterAccess;
}): Promise<{ row: ActionRow; idempotent: boolean; actionVersion: number }> {
  const requestFingerprint = fingerprint(input.body);
  return db.transaction(async (tx) => {
    const [ownedCase] = await tx
      .select()
      .from(onbCases)
      .where(and(eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId)))
      .for("update");
    if (!ownedCase) throw new ActionCenterNotFoundError("Case not found.");
    if (input.access === "synthetic-demo-simulation" || isHistoricalTestRecord(ownedCase) || (await getUatCaseIsolation(ownedCase)).isolated) {
      denyRetiredCaseCapability();
    }
    if (input.access === "synthetic-demo-simulation") {
      if (
        input.organizationId !== DEMO_ORGANIZATION_ID ||
        !isSyntheticOfflineCase(ownedCase)
      ) {
        throw new ActionCenterPermissionError(
          "Demo Action Center simulations are limited to current server-marked synthetic cases.",
        );
      }
    } else if (isSyntheticOfflineCase(ownedCase)) {
      throw new ActionCenterOfflineError();
    }

    const [existing] = await tx
      .select()
      .from(onbActionCenterActions)
      .where(and(
        eq(onbActionCenterActions.organizationId, input.organizationId),
        eq(onbActionCenterActions.requestId, input.requestId),
      ));
    const existingRows = await tx
      .select({ id: onbActionCenterActions.id })
      .from(onbActionCenterActions)
      .where(and(
        eq(onbActionCenterActions.organizationId, input.organizationId),
        eq(onbActionCenterActions.caseId, input.caseId),
      ));
    if (existing) {
      if (existing.payload.requestFingerprint !== requestFingerprint) {
        throw new ActionCenterConflictError(
          `requestId "${input.requestId}" was already used for a different action.`,
        );
      }
      return {
        row: existing,
        idempotent: true,
        actionVersion: existingRows.length,
      };
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== existingRows.length
    ) {
      throw new ActionCenterConflictError(
        `Action Center changed since version ${input.expectedVersion}; reload before retrying.`,
      );
    }
    if (input.targetActionId !== undefined) {
      const [target] = await tx.select().from(onbActionCenterActions).where(and(
        eq(onbActionCenterActions.organizationId, input.organizationId),
        eq(onbActionCenterActions.caseId, input.caseId),
        eq(onbActionCenterActions.id, input.targetActionId),
      ));
      if (!target || !["assign", "escalate"].includes(target.kind)) {
        throw new ActionCenterNotFoundError("Work item not found.");
      }
      if (target.status !== "open") {
        throw new ActionCenterConflictError("This work item is already resolved.");
      }
      const alreadyResolved = await tx.select().from(onbActionCenterActions).where(and(
        eq(onbActionCenterActions.organizationId, input.organizationId),
        eq(onbActionCenterActions.caseId, input.caseId),
        eq(onbActionCenterActions.kind, "resolve"),
      ));
      if (alreadyResolved.some((row) => row.payload.body &&
        typeof row.payload.body === "object" &&
        Number((row.payload.body as Record<string, unknown>).workItemId) === input.targetActionId)) {
        throw new ActionCenterConflictError("This work item is already resolved.");
      }
    }
    const routing = (input.kind === "assign" || input.kind === "escalate") && input.owner === undefined
      ? await resolveClientActionRouting(input.organizationId, ownedCase, tx) : null;
    const [row] = await tx
      .insert(onbActionCenterActions)
      .values({
        organizationId: input.organizationId,
        caseId: input.caseId,
        kind: input.kind,
        status: input.status,
        owner: input.owner ?? routing?.owner ?? null,
        assignee: input.assignee ?? routing?.assignee ?? null,
        outcome: input.outcome ?? null,
        notes: input.notes ?? routing?.reason ?? null,
        persona: input.persona ?? null,
        selfReported: input.selfReported ?? false,
        verified: input.verified ?? false,
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        requestId: input.requestId,
        payload: { requestFingerprint, body: input.body,
          ...(routing ? { clientRouting: {
            settingsVersion: routing.settingsVersion, groupId: input.assignee != null ? null : routing.groupId,
          } } : {}),
        },
      })
      .returning();
    if (!row) throw new Error("Action Center action was not persisted.");
    return { row, idempotent: false, actionVersion: existingRows.length + 1 };
  });
}

export async function recordManualCallOutcome(input: {
  organizationId: string;
  actorUserId: string;
  actorName: string;
  organizationRole?: string;
  role?: string;
  requestId: string;
  caseId: number;
  outcome: ActionCenterCallOutcome;
  notes?: string | null;
  persona?: string | null;
  selfReported: true;
  access?: ActionCenterAccess;
}) {
  assertActionCenterMutationAuthorized(
    input.organizationId,
    input.organizationRole,
    undefined,
    input.access,
  );
  if (input.persona && input.organizationId !== DEMO_ORGANIZATION_ID) {
    throw new ActionCenterPermissionError(
      "Named call personas are available only in Demo Organization simulations.",
    );
  }
  const persist = async () => {
    const result = await reserveAction({
      ...input,
      kind: "manual-call-outcome",
      body: {
        requestId: input.requestId,
        caseId: input.caseId,
        outcome: input.outcome,
        notes: input.notes ?? null,
        persona: input.persona ?? null,
        selfReported: input.selfReported,
      },
      status: "completed",
      verified: false,
    });
    return {
      action: actionPublic(result.row),
      idempotent: result.idempotent,
      actionVersion: result.actionVersion,
    };
  };
  const [caseRow] = await db.select({
    notes: onbCases.notes,
    scenarioKey: onbCases.scenarioKey,
    syntheticProvenance: onbCases.syntheticProvenance,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId),
    eq(onbCases.id, input.caseId),
  )).limit(1);
  // Preserve not-found/offline error semantics and the Demo simulation path;
  // neither can persist an ordinary sensitive online case mutation.
  if (!caseRow || isHistoricalTestRecord(caseRow) || isSyntheticOfflineCase(caseRow) || input.access === "synthetic-demo-simulation") {
    return persist();
  }
  return withSensitiveAuthorityFence({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorUserId: input.actorUserId,
    classification: "identity",
    additionalClassifications: ["medical", "payroll", "bgv"],
    mutate: persist,
  });
}

export async function recordWorkItem(input: {
  organizationId: string;
  actorUserId: string;
  actorName: string;
  organizationRole?: string;
  requestId: string;
  caseId: number;
  kind: "assign" | "escalate" | "reassign" | "resolve";
  owner?: ActionCenterWorkOwner;
  assignee?: string | null;
  reason?: string | null;
  expectedVersion: number;
  targetActionId?: number;
  access?: ActionCenterAccess;
}) {
  assertActionCenterMutationAuthorized(
    input.organizationId,
    input.organizationRole,
    undefined,
    input.access,
  );
  const result = await reserveAction({
    ...input,
    body: {
      requestId: input.requestId,
      caseId: input.caseId,
      owner: input.owner ?? null,
      assignee: input.assignee ?? null,
      reason: input.reason ?? null,
      expectedVersion: input.expectedVersion,
      workItemId: input.targetActionId ?? null,
    },
    notes: input.reason ?? null,
    status: input.kind === "resolve" ? "completed" : "open",
    targetActionId: input.targetActionId,
  });
  return {
    action: actionPublic(result.row),
    idempotent: result.idempotent,
    actionVersion: result.actionVersion,
  };
}

type DocumentReminderInput = {
  organizationId: string;
  actorUserId: string;
  actorName: string;
  organizationRole?: string;
  requestId: string;
  caseId: number;
  documentId: number;
  mode: DocumentReminderMode;
};

const inFlightDocumentReminders = new Map<string, Promise<DocumentReminderActionResult>>();

/**
 * Coalesce genuinely overlapping attempts for one document before either
 * caller observes the post-send cooldown. This is not a cooldown bypass:
 * once the first promise settles, a later request takes the normal due-date
 * path and is rejected.
 */
export async function recordDocumentReminder(input: DocumentReminderInput): Promise<DocumentReminderActionResult> {
  const key = `${input.organizationId}:${input.caseId}:${input.documentId}:${input.mode}`;
  const existing = inFlightDocumentReminders.get(key);
  if (existing) return existing;
  const operation = recordDocumentReminderOnce(input);
  inFlightDocumentReminders.set(key, operation);
  try {
    return await operation;
  } finally {
    if (inFlightDocumentReminders.get(key) === operation) {
      inFlightDocumentReminders.delete(key);
    }
  }
}

async function recordDocumentReminderOnce(input: DocumentReminderInput): Promise<DocumentReminderActionResult> {
  const [document] = await db.select({
    key: onbDocuments.key,
    label: onbDocuments.label,
    category: onbDocuments.category,
  }).from(onbDocuments).where(and(
    eq(onbDocuments.id, input.documentId),
    eq(onbDocuments.organizationId, input.organizationId),
    eq(onbDocuments.caseId, input.caseId),
  ));
  if (!document) throw new ActionCenterNotFoundError("Case or document not found.");
  const classes = sensitiveClassForDocument(document);
  return withSensitiveAuthorityFence({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorUserId: input.actorUserId,
    classification: classes[0]!,
    additionalClassifications: classes.slice(1),
    additionalAccessKeys: [
      "tool.documents.edit",
      ...(input.mode === "live" ? ["tool.notification.send"] : []),
    ],
    // Keep the authority lock through replay recovery and provider dispatch,
    // not merely through its initial Action Center reservation.
    mutate: () => recordDocumentReminderUnsafe(input),
  });
}

async function recordDocumentReminderUnsafe(input: {
  organizationId: string;
  actorUserId: string;
  actorName: string;
  organizationRole?: string;
  requestId: string;
  caseId: number;
  documentId: number;
  mode: DocumentReminderMode;
}): Promise<DocumentReminderActionResult> {
  assertActionCenterMutationAuthorized(input.organizationId, input.organizationRole, input.mode);
  const [existingAction] = await db.select().from(onbActionCenterActions).where(and(
    eq(onbActionCenterActions.organizationId, input.organizationId),
    eq(onbActionCenterActions.caseId, input.caseId),
    eq(onbActionCenterActions.requestId, input.requestId),
  ));
  if (existingAction) {
    const existingBody = existingAction.payload.body;
    if (!existingBody || typeof existingBody !== "object" ||
      Number((existingBody as Record<string, unknown>).documentId) !== input.documentId ||
      String((existingBody as Record<string, unknown>).mode) !== input.mode) {
      throw new ActionCenterConflictError(
        `requestId "${input.requestId}" was already used for a different action.`,
      );
    }
    const body = existingBody as Record<string, unknown>;
    const providerIdempotencyKey = String(body.providerIdempotencyKey ?? "");
    let replayRow = existingAction;
    let effect = providerIdempotencyKey
      ? await loadReminderEffect(input.organizationId, providerIdempotencyKey)
      : null;
    const communicationId =
      typeof body.communicationId === "number" ? body.communicationId : null;
    let communication = communicationId
      ? (await db.select().from(onbCommunications).where(and(
        eq(onbCommunications.organizationId, input.organizationId),
        eq(onbCommunications.id, communicationId),
      )))[0] ?? null
      : null;
    if (!communication && providerIdempotencyKey) {
      communication = (await db.select().from(onbCommunications).where(and(
        eq(onbCommunications.organizationId, input.organizationId),
        eq(onbCommunications.idempotencyKey, providerIdempotencyKey),
      )))[0] ?? null;
    }

    // A request replay is also the recovery hook for a process crash. Resume
    // only before a provider claim exists; a dispatching/unknown journal entry
    // is intentionally never retried because its external outcome is
    // uncertain.
    if (existingAction.status === "sending" && (!effect || ["ready", "failed"].includes(effect.status))) {
      try {
        const delivery = await sendDocumentReminder({
          organizationId: input.organizationId,
          caseId: input.caseId,
          documentId: input.documentId,
          mode: input.mode,
          idempotencyKey: providerIdempotencyKey,
        });
        communication = (await db.select().from(onbCommunications).where(and(
          eq(onbCommunications.organizationId, input.organizationId),
          eq(onbCommunications.id, delivery.id),
        )))[0] ?? communication;
        effect = providerIdempotencyKey
          ? await loadReminderEffect(input.organizationId, providerIdempotencyKey)
          : null;
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : "Reminder recovery failed.";
        const [updated] = await db.update(onbActionCenterActions).set({
          status: "failed",
          payload: { ...existingAction.payload, failureReason },
          updatedAt: new Date(),
        }).where(and(
          eq(onbActionCenterActions.organizationId, input.organizationId),
          eq(onbActionCenterActions.id, existingAction.id),
        )).returning();
        replayRow = updated ?? existingAction;
      }
    }
    if (effect?.status === "confirmed" && communication?.status === "sending") {
      const [reconciled] = await db.update(onbCommunications).set({
        status: effect.externalEffectId ? "sent" : "logged-only",
        externalMessageId: effect.externalEffectId,
        failureReason: null,
      }).where(and(
        eq(onbCommunications.organizationId, input.organizationId),
        eq(onbCommunications.id, communication.id),
      )).returning();
      communication = reconciled ?? communication;
    } else if (effect?.status === "unknown_effect_manual_repair") {
      const failureReason = effect.lastError ?? "Delivery outcome unknown; manual reconciliation required.";
      if (communication) {
        const [reconciled] = await db.update(onbCommunications).set({
          status: "sending",
          failureReason,
        }).where(and(
          eq(onbCommunications.organizationId, input.organizationId),
          eq(onbCommunications.id, communication.id),
        )).returning();
        communication = reconciled ?? communication;
      }
      const [updated] = await db.update(onbActionCenterActions).set({
        status: "failed",
        payload: { ...existingAction.payload, failureReason },
        updatedAt: new Date(),
      }).where(and(
        eq(onbActionCenterActions.organizationId, input.organizationId),
        eq(onbActionCenterActions.id, existingAction.id),
      )).returning();
      replayRow = updated ?? replayRow;
    }
    if (communication && replayRow.status === "sending") {
      const [updated] = await db.update(onbActionCenterActions).set({
        status: reminderActionStatus(communication.status),
        payload: {
          ...replayRow.payload,
          communicationId: communication.id,
          deliveryStatus: communication.status,
          failureReason: communication.failureReason,
        },
        updatedAt: new Date(),
      }).where(and(
        eq(onbActionCenterActions.organizationId, input.organizationId),
        eq(onbActionCenterActions.id, replayRow.id),
      )).returning();
      replayRow = updated ?? replayRow;
    }
    const providerEffectId = effect?.externalEffectId ?? null;
    return {
      action: actionPublic(replayRow, providerEffectId),
      idempotent: true,
      actionVersion: (await db.select({ id: onbActionCenterActions.id })
        .from(onbActionCenterActions)
        .where(and(
          eq(onbActionCenterActions.organizationId, input.organizationId),
          eq(onbActionCenterActions.caseId, input.caseId),
        ))).length,
    };
  }
  const [candidate] = await db
    .select({ doc: onbDocuments, c: onbCases })
    .from(onbDocuments)
    .innerJoin(
      onbCases,
      and(eq(onbCases.id, onbDocuments.caseId), eq(onbCases.organizationId, onbDocuments.organizationId)),
    )
    .where(and(
      eq(onbDocuments.id, input.documentId),
      eq(onbDocuments.caseId, input.caseId),
      eq(onbDocuments.organizationId, input.organizationId),
    ));
  if (!candidate) throw new ActionCenterNotFoundError("Case or document not found.");
  if (isHistoricalTestRecord(candidate.c) || (await getUatCaseIsolation(candidate.c)).isolated) denyRetiredCaseCapability();
  if (isSyntheticOfflineCase(candidate.c)) throw new ActionCenterOfflineError();
  const [latestUpload] = await db.select({ validationState: onbCandidateUploads.validationState })
    .from(onbCandidateUploads)
    .where(and(
      eq(onbCandidateUploads.organizationId, input.organizationId),
      eq(onbCandidateUploads.caseId, input.caseId),
      eq(onbCandidateUploads.documentId, input.documentId),
    ))
    .orderBy(desc(onbCandidateUploads.id))
    .limit(1);
  if (!candidate.doc.required || !["pending", "received"].includes(candidate.doc.status) ||
    (candidate.doc.status === "received" && !documentNeedsCorrection({
      status: candidate.doc.status,
      validationState: latestUpload?.validationState,
    }))) {
    throw new ActionCenterConflictError("This document no longer needs a reminder.");
  }
  if (!reminderEligible({
    required: candidate.doc.required,
    status: candidate.doc.status,
    updatedAt: candidate.doc.updatedAt,
    reminderNextAt: candidate.doc.reminderNextAt,
  })) {
    throw new ActionCenterConflictError("This document is not due for a reminder yet.");
  }
  if (input.mode === "simulation" && input.organizationId !== DEMO_ORGANIZATION_ID) {
    throw new ActionCenterPermissionError(
      "Reminder simulation is only available in Demo Organization.",
    );
  }
  const providerIdempotencyKey = `document-reminder:${candidate.doc.id}:${candidate.doc.reminderCount + 1}`;
  const result = await reserveAction({
    ...input,
    kind: "remind-document",
    status: "sending",
    body: {
      requestId: input.requestId,
      caseId: input.caseId,
      documentId: input.documentId,
      mode: input.mode,
      providerIdempotencyKey,
    },
  });
  if (result.idempotent) {
    // Another request may have inserted the durable reservation between the
    // initial lookup and this transaction. Re-enter the replay/reconciliation
    // path rather than returning a stale `sending` row.
    return recordDocumentReminderUnsafe(input);
  }

  try {
    const delivery = await sendDocumentReminder({
      organizationId: input.organizationId,
      caseId: input.caseId,
      documentId: input.documentId,
      mode: input.mode,
      idempotencyKey: providerIdempotencyKey,
    });
    const nextStatus = reminderActionStatus(delivery.status);
    const effect = await loadReminderEffect(input.organizationId, providerIdempotencyKey);
    const [updated] = await db.update(onbActionCenterActions).set({
      status: nextStatus,
      payload: {
        requestFingerprint: result.row.payload.requestFingerprint,
        body: result.row.payload.body,
        communicationId: delivery.id,
        deliveryStatus: delivery.status,
        failureReason: delivery.failureReason,
      },
      updatedAt: new Date(),
    }).where(and(
      eq(onbActionCenterActions.organizationId, input.organizationId),
      eq(onbActionCenterActions.id, result.row.id),
    )).returning();
    const finalRow = updated ?? result.row;
    return {
      action: actionPublic(finalRow, effect?.externalEffectId ?? null),
      idempotent: false,
      actionVersion: result.actionVersion,
    };
  } catch (error) {
    await db.update(onbActionCenterActions).set({
      status: "failed",
      payload: {
        requestFingerprint: result.row.payload.requestFingerprint,
        body: result.row.payload.body,
        failureReason: error instanceof Error ? error.message : "Reminder failed.",
      },
      updatedAt: new Date(),
    }).where(and(
      eq(onbActionCenterActions.organizationId, input.organizationId),
      eq(onbActionCenterActions.id, result.row.id),
    ));
    throw error;
  }
}

export async function getActionCenter(
  organizationId: string,
  scope: ActionCenterScope = "active",
  limit = 100,
  filters: { workforce?: ActionCenterWorkforceFilter; safetyCritical?: boolean; siteExposure?: boolean } = {},
  access: ActionCenterAccess = "standard",
) {
  const [cases, approvalRows, documents, systemChecks, events, communications, actionRows, approvalHistory, uploads] =
    await Promise.all([
      db.select().from(onbCases).where(eq(onbCases.organizationId, organizationId)),
      db.select({ approval: onbApprovals, c: onbCases })
        .from(onbApprovals)
        .innerJoin(onbCases, and(
          eq(onbCases.id, onbApprovals.caseId),
          eq(onbCases.organizationId, organizationId),
        ))
        .where(eq(onbApprovals.organizationId, organizationId))
        .orderBy(desc(onbApprovals.createdAt)),
      db.select({ doc: onbDocuments, c: onbCases })
        .from(onbDocuments)
        .innerJoin(onbCases, and(
          eq(onbCases.id, onbDocuments.caseId),
          eq(onbCases.organizationId, organizationId),
        ))
        .where(eq(onbDocuments.organizationId, organizationId))
        .orderBy(desc(onbDocuments.updatedAt)),
      db.select({ check: onbSystemChecks, c: onbCases })
        .from(onbSystemChecks)
        .innerJoin(onbCases, and(
          eq(onbCases.id, onbSystemChecks.caseId),
          eq(onbCases.organizationId, organizationId),
        ))
        .where(eq(onbSystemChecks.organizationId, organizationId))
        .orderBy(desc(onbSystemChecks.requestedAt)),
      db.select().from(onbEvents)
        .where(and(eq(onbEvents.organizationId, organizationId)))
        .orderBy(desc(onbEvents.createdAt), desc(onbEvents.id)),
      db.select({ communication: onbCommunications, c: onbCases })
        .from(onbCommunications)
        .innerJoin(onbCases, and(
          eq(onbCases.id, onbCommunications.caseId),
          eq(onbCases.organizationId, organizationId),
        ))
         .where(eq(onbCommunications.organizationId, organizationId))
        .orderBy(desc(onbCommunications.createdAt)),
      db.select().from(onbActionCenterActions)
        .where(eq(onbActionCenterActions.organizationId, organizationId))
        .orderBy(desc(onbActionCenterActions.createdAt), desc(onbActionCenterActions.id)),
      db.select().from(onbApprovalHistory)
        .where(eq(onbApprovalHistory.organizationId, organizationId))
        .orderBy(desc(onbApprovalHistory.createdAt), desc(onbApprovalHistory.id)),
      db.select({ upload: onbCandidateUploads })
        .from(onbCandidateUploads)
        .where(eq(onbCandidateUploads.organizationId, organizationId))
        .orderBy(desc(onbCandidateUploads.id)),
    ]);
  const isolation = await Promise.all(cases.map(async row => ({
    row, historical: isHistoricalTestRecord(row) || (await getUatCaseIsolation(row)).isolated,
  })));
  const visibleCases = access === "synthetic-demo-simulation"
    ? []
    : isolation.filter(item => !item.historical).map(item => item.row);
  const canActOnCase = (row: typeof onbCases.$inferSelect): boolean =>
    access === "synthetic-demo-simulation"
      ? isSyntheticOfflineCase(row)
      : !isHistoricalTestRecord(row) && !isSyntheticOfflineCase(row);
  const filteredCaseIds = new Set(visibleCases.filter((row) => {
    if (filters.workforce) {
      const label = row.workforceClassification?.label ?? "unclassified";
      if (label !== filters.workforce) return false;
    }
    // Unknown is not "no": filters are explicit applicability facts and must
    // not silently include cases whose safety/site context has not been set.
    if (filters.safetyCritical !== undefined && row.workforceContext.safetyCritical !== filters.safetyCritical) return false;
    if (filters.siteExposure !== undefined && row.workforceContext.siteExposure !== filters.siteExposure) return false;
    return true;
  }).map((row) => row.id));
  const caseById = new Map(visibleCases.map((row) => [row.id, row]));
  const latestSystemChecks = Array.from(new Map(
    systemChecks.map((row) => [`${row.c.id}:${row.check.system}`, row]),
  ).values());
  const latestUploadByDocument = new Map<number, typeof uploads[number]["upload"]>();
  for (const { upload } of uploads) {
    if (!latestUploadByDocument.has(upload.documentId)) {
      latestUploadByDocument.set(upload.documentId, upload);
    }
  }
  const activeApprovals = approvalRows.filter(({ approval }) => approval.status === "pending");
  const completedApprovals = approvalRows.filter(({ approval }) => approval.status !== "pending");
  const dueAt = Date.now();
  const followups = documents
    .filter(({ doc, c }) =>
      filteredCaseIds.has(c.id) &&
      doc.required &&
      ["pending", "received"].includes(doc.status),
    )
    .map(({ doc, c }) => ({
      validationState: latestUploadByDocument.get(doc.id)?.validationState ?? null,
      documentId: doc.id,
      caseId: c.id,
      key: doc.key,
      label: doc.label,
      category: doc.category,
      status: doc.status,
      required: doc.required,
      reminderCount: doc.reminderCount,
      lastReminderAt: iso(doc.lastReminderAt),
      nextReminderAt: iso(doc.reminderNextAt),
       action: doc.status === "received"
        ? (documentNeedsCorrection({
          status: doc.status,
          validationState: latestUploadByDocument.get(doc.id)?.validationState,
        }) ? "correction" : "review")
        : "remind",
       eligibleForReminder: access === "standard" && canActOnCase(c) && reminderEligible({
        required: doc.required,
        status: doc.status,
        updatedAt: doc.updatedAt,
        reminderNextAt: doc.reminderNextAt,
        now: dueAt,
      }) && (doc.status === "pending" || documentNeedsCorrection({
        status: doc.status,
        validationState: latestUploadByDocument.get(doc.id)?.validationState,
      })),
      case: caseSummary(c, access),
       caseHref: caseHref(c.id),
       capabilities: { canRemind: access === "standard" && canActOnCase(c) },
    }));
  const resolvedWorkItemIds = new Set(actionRows
    .filter((row) => row.kind === "resolve")
    .map((row) => Number((row.payload.body as Record<string, unknown> | undefined)?.workItemId))
    .filter((id) => Number.isInteger(id)));
  const latestReassignByTarget = new Map<number, ActionRow>();
  for (const row of actionRows) {
    if (row.kind !== "reassign") continue;
    const target = Number((row.payload.body as Record<string, unknown> | undefined)?.workItemId);
    if (Number.isInteger(target) && !latestReassignByTarget.has(target)) {
      latestReassignByTarget.set(target, row);
    }
  }
  const openActions = actionRows.filter((row) =>
    ["assign", "escalate"].includes(row.kind) &&
    row.status === "open" &&
    !resolvedWorkItemIds.has(row.id),
  );
  const completedActions = actionRows.filter((row) => actionCompleted(row.status));
  const actionVersionByCase = new Map<number, number>();
  for (const row of actionRows) {
    actionVersionByCase.set(row.caseId, (actionVersionByCase.get(row.caseId) ?? 0) + 1);
  }
  const notifications = [
    ...latestSystemChecks.filter(({ c }) => filteredCaseIds.has(c.id))
      .filter(({ check }) =>
        check.status === "overdue" ||
        (check.status === "pending" && check.dueAt.getTime() <= dueAt),
      )
       .map(({ check, c }) => ({
        id: `system-check:${check.id}`,
        caseId: check.caseId,
        kind: check.system === "bgv" ? "bgv" as const : "operational" as const,
        title: check.system === "bgv"
          ? "Background verification needs attention"
          : `${check.system.toUpperCase()} check needs attention`,
         detail: check.status === "overdue"
           ? `${check.system.toUpperCase()} check is overdue and requires review.`
           : `${check.system.toUpperCase()} check is due and requires review.`,
        status: check.status,
         source: "recorded-system-check",
         provenance: check.mode === "push"
           ? "provider-webhook"
           : check.mode === "poll"
             ? "provider-poll"
             : check.mode === "email"
               ? "provider-email"
               : "recorded-system-check",
         deliveryLabel: "Recorded",
         recipient: check.system,
         initiator: "system-watcher",
        createdAt: check.requestedAt.toISOString(),
        caseHref: caseHref(check.caseId),
         capabilities: { canAct: false },
      })),
    ...events
      .filter((event) => filteredCaseIds.has(event.caseId ?? -1) &&
        event.caseId !== null &&
        /overdue|exception|escalat|failed|attention|blocked|quarantin|review/i.test(
          `${event.title} ${event.detail}`,
        ),
      )
      .map((event) => ({
        id: `event:${event.id}`,
        caseId: event.caseId!,
        kind: /bgv|background/i.test(`${event.title} ${event.detail} ${event.ruleRef ?? ""}`)
          ? "bgv" as const
          : "operational" as const,
        title: event.title,
        detail: event.detail,
         status: "informational",
         source: "recorded-event",
         provenance: event.engine,
         deliveryLabel: "Recorded",
         recipient: event.agent,
         initiator: event.agent,
        createdAt: event.createdAt.toISOString(),
        caseHref: caseHref(event.caseId!),
         capabilities: {
           canAct: false,
         },
      })),
     ...communications.filter(({ c }) => filteredCaseIds.has(c.id)).map(({ communication, c }) => ({
       id: `communication:${communication.id}`,
      caseId: communication.caseId,
      kind: /bgv|background/i.test(`${communication.subject ?? ""} ${communication.body}`)
        ? "bgv" as const
        : "operational" as const,
       title: communication.subject ?? "Operational notification",
       detail: communication.failureReason ?? `${deliveryLabel(communication.status, communication.subject)} notification recorded.`,
      status: communication.status,
       source: "persisted-communication",
       provenance: communication.status === "simulated" || communication.status === "logged-only"
         ? "simulation-or-log-only" : "recorded-delivery-status",
       deliveryLabel: deliveryLabel(communication.status, communication.subject),
       recipient: `${outboundIdentityLine(communication, "Intended stakeholder") ??
         `${communication.audience === "candidate" ? c.workerName : communication.audience} — ${communication.audience}`} · ${communication.toAddress}`,
       initiator: outboundIdentityLine(communication, "Requested by") ?? communication.retriedBy ?? "system",
      createdAt: communication.createdAt.toISOString(),
      caseHref: caseHref(communication.caseId),
       capabilities: { canAct: canActOnCase(c) },
    })),
  ].slice(0, limit);

  const opportunities: Array<Record<string, unknown>> = [];
   for (const { doc, c } of documents) {
     if (!filteredCaseIds.has(c.id)) continue;
    if (!doc.required || !["pending", "received"].includes(doc.status)) continue;
    const received = doc.status === "received";
    const correctionRequired = documentNeedsCorrection({
      status: doc.status,
      validationState: latestUploadByDocument.get(doc.id)?.validationState,
    });
    if (received && !correctionRequired) {
      opportunities.push({
        id: `document-review:${c.id}:${doc.id}`,
        caseId: c.id,
        kind: "document-review",
        priority: priorityForCase(c),
        title: `Review received ${doc.label}`,
        description: "A document was received and is waiting for human review; receipt does not clear this checkpoint.",
        benefit: { type: "mandatory-checkpoint", checkpoint: "documentation-review", delta: null },
        evidence: { source: "onb_documents", documentId: doc.id, status: doc.status, reviewRequired: true },
        caseHref: caseHref(c.id),
         capabilities: { canAct: canActOnCase(c) },
      });
      continue;
    }
    opportunities.push({
      id: `document:${c.id}:${doc.id}`,
      caseId: c.id,
      kind: "missing-document",
      priority: priorityForCase(c),
       title: received ? `Correct ${doc.label}` : `Collect ${doc.label}`,
       description: received
         ? "A correction was requested; upload a replacement for human review."
         : "Submitting this required document moves the case toward the mandatory documentation checkpoint.",
      benefit: { type: "mandatory-checkpoint", checkpoint: "documentation", delta: null },
      evidence: { source: "onb_documents", documentId: doc.id, status: doc.status },
      caseHref: caseHref(c.id),
       capabilities: { canAct: canActOnCase(c) },
    });
  }
   for (const { check, c } of latestSystemChecks) {
     if (!filteredCaseIds.has(c.id)) continue;
    if (check.system !== "bgv" || check.status === "done") continue;
    opportunities.push({
      id: `bgv:${c.id}:${check.id}`,
      caseId: c.id,
      kind: "bgv-checkpoint",
      priority: priorityForCase(c),
      title: check.status === "overdue" ? "Resolve overdue background verification" : "Complete background verification",
       description: "A clear recorded BGV result is required for the mandatory background-verification checkpoint; provenance remains visible in the evidence.",
      benefit: { type: "mandatory-checkpoint", checkpoint: "background-verification", delta: null },
       evidence: {
         source: "recorded-system-check",
         provenance: check.mode === "push"
           ? "provider-webhook"
           : check.mode === "poll"
             ? "provider-poll"
             : check.mode === "email"
               ? "provider-email"
               : "recorded-system-check",
         system: check.system,
         checkId: check.id,
         status: check.status,
       },
      caseHref: caseHref(c.id),
       capabilities: { canAct: canActOnCase(c) },
    });
  }
   for (const { approval, c } of activeApprovals) {
     if (!filteredCaseIds.has(c.id)) continue;
    opportunities.push({
      id: `approval:${approval.id}:v${approval.version}`,
      caseId: c.id,
      kind: "approval-checkpoint",
      priority: approval.hitlPattern === "hard-block" ? "critical" : priorityForCase(c),
      title: "Review pending human approval",
       description: "Record the current decision for human review. A rejection or acknowledgement remains visible for follow-up and does not assert downstream release.",
      benefit: { type: "mandatory-checkpoint", checkpoint: "human-review", delta: null },
      evidence: { source: "onb_approvals", approvalId: approval.id, version: approval.version },
      caseHref: caseHref(c.id),
       capabilities: { canAct: canActOnCase(c) },
    });
  }
   for (const c of cases) {
     if (!filteredCaseIds.has(c.id)) continue;
    for (const item of c.checklistSnapshot) {
      if (!item.enabled || !item.mandatory) continue;
      const readiness = c.readiness.find((candidate) => candidate.key === item.id || candidate.key === item.label);
      if (readiness && readiness.status === "ready") continue;
      opportunities.push({
        id: `checklist:${c.id}:${item.id}`,
        caseId: c.id,
        kind: "mandatory-checklist",
        priority: priorityForCase(c),
        title: `Complete ${item.label}`,
        description: item.evidenceRequired
          ? `Independent evidence must be verified by the assigned ${item.responsibleRole ?? "designated human"} authority before this ${item.enforcementStage} gate can clear.`
          : `Completing this mandatory checklist item moves the case toward the ${item.enforcementStage} checkpoint.`,
        benefit: { type: "mandatory-checkpoint", checkpoint: item.enforcementStage, delta: null },
        evidence: { source: item.evidenceRequired ? "onb_policy_evidence" : "onb_cases.checklist_snapshot", itemId: item.id, status: readiness?.status ?? "not-started" },
        caseHref: caseHref(c.id),
          capabilities: { canAct: canActOnCase(c) },
      });
    }
  }
  for (const opportunity of opportunities) {
    opportunity.actionVersion = actionVersionByCase.get(Number(opportunity.caseId)) ?? 0;
  }
  opportunities.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return order[a.priority as keyof typeof order] - order[b.priority as keyof typeof order];
  });

  const showCompleted = scope === "completed" || scope === "all";
  const showActive = scope === "active" || scope === "all";
  const completed = showCompleted
     ? [
        ...completedActions.map((row) => {
          if (!filteredCaseIds.has(row.caseId)) return null;
          const c = caseById.get(row.caseId);
          return {
            id: `action-${row.id}`,
            kind: row.kind,
            caseId: row.caseId,
            status: row.status,
            summary: row.kind === "manual-call-outcome"
              ? `Manual call: ${row.outcome ?? "outcome recorded"}${row.verified ? "" : " (self-reported, not verified)"}`
              : row.kind === "remind-document"
                ? "Document reminder processed"
                : row.kind === "resolve"
                  ? "Resolved work item"
                  : `${row.kind === "escalate"
                    ? "Escalated"
                    : row.kind === "reassign"
                      ? "Reassigned"
                      : "Assigned"} to ${row.owner ?? "human queue"}`,
            actor: row.actorName,
            createdAt: row.createdAt.toISOString(),
            caseHref: caseHref(c?.id ?? row.caseId),
          };
        }).filter((row): row is NonNullable<typeof row> => row !== null),
        ...completedApprovals.filter(({ c }) => filteredCaseIds.has(c.id)).map(({ approval, c }) => ({
          id: `approval-${approval.id}-v${approval.version}`,
          kind: "approval",
          caseId: c.id,
          status: approval.status,
          summary: `${approval.status === "approved" ? "Approved" : "Rejected"}: ${approval.recommendation}`,
          actor: approval.decidedBy ?? "System",
          createdAt: (approval.decidedAt ?? approval.createdAt).toISOString(),
          caseHref: caseHref(c.id),
        })),
        ...approvalHistory.filter((history) => filteredCaseIds.has(history.caseId)).map((history) => {
          const c = caseById.get(history.caseId);
          return {
            id: `approval-history-${history.id}`,
            kind: "approval-history",
            caseId: history.caseId,
            status: history.status,
            summary: history.reason ?? `${history.eventType} approval cycle`,
            actor: history.decidedBy ?? "System",
            createdAt: history.createdAt.toISOString(),
            caseHref: caseHref(c?.id ?? history.caseId),
          };
        }),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
    : [];
  const active = showActive;
  const pausedOffline = access === "synthetic-demo-simulation"
    || (visibleCases.length === 0 && isolation.some(item => item.historical));
  // The envelope-level capability is fail-closed for mixed tenants. Each
  // case/item carries its own capability so a capable UI can still act on
  // online rows without ever treating an offline row as actionable.
  const simulationCanAct =
    access === "synthetic-demo-simulation" && visibleCases.length > 0;
  const allCasesOnline =
    visibleCases.length > 0 && visibleCases.every((row) => !isSyntheticOfflineCase(row));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    pausedOffline,
    capabilities: {
      canAct: allCasesOnline || simulationCanAct,
      canSendReminder: allCasesOnline,
      canRecordCallOutcome: allCasesOnline || simulationCanAct,
      canAssign: allCasesOnline || simulationCanAct,
      canEscalate: allCasesOnline || simulationCanAct,
      canReassign: allCasesOnline || simulationCanAct,
      canResolve: allCasesOnline || simulationCanAct,
      reminderMode: "existing-runner" as const,
      aiCall: {
        available: access === "standard" && !externalProviderDispatchDenied(),
        mode: "existing-control" as const,
        label: "Open guarded AI call controls",
        hrefTemplate: "/cases/{caseId}?tab=communications",
      },
    },
    counts: {
      pendingApprovals: active
        ? activeApprovals.filter(({ c }) => filteredCaseIds.has(c.id)).length
        : 0,
      notifications: active ? notifications.length : 0,
      missingDocuments: active ? followups.length : 0,
      openWorkItems: active
        ? openActions.filter((row) => filteredCaseIds.has(row.caseId)).length
        : 0,
      completed: completed.length,
      opportunities: active ? opportunities.length : 0,
    },
    approvals: showActive ? activeApprovals.filter(({ c }) => filteredCaseIds.has(c.id)).slice(0, limit).map(({ approval, c }) => ({
      id: approval.id,
      caseId: c.id,
      version: approval.version,
      status: approval.status,
      agent: approval.agent,
      hitlPattern: approval.hitlPattern,
      ruleRef: approval.ruleRef,
      recommendation: approval.recommendation,
      rationale: approval.rationale,
      createdAt: approval.createdAt.toISOString(),
       case: caseSummary(c, access),
       actions: {
         approveHref: "/approvals",
         caseHref: caseHref(c.id),
         canAct: canActOnCase(c),
       },
    })) : completedApprovals.filter(({ c }) => filteredCaseIds.has(c.id)).slice(0, limit).map(({ approval, c }) => ({
      id: approval.id,
      caseId: c.id,
      version: approval.version,
      status: approval.status,
      agent: approval.agent,
      hitlPattern: approval.hitlPattern,
      ruleRef: approval.ruleRef,
      recommendation: approval.recommendation,
      rationale: approval.rationale,
      createdAt: approval.createdAt.toISOString(),
       case: caseSummary(c, access),
       actions: {
         approveHref: "/approvals",
         caseHref: caseHref(c.id),
         canAct: canActOnCase(c),
       },
    })),
     notifications: active ? notifications.slice(0, limit) : [],
    documentFollowups: active ? followups.slice(0, limit) : [],
    workItems: active ? openActions.filter((row) => filteredCaseIds.has(row.caseId)).slice(0, limit).map((row) => {
      const current = latestReassignByTarget.get(row.id) ?? row;
      return {
      id: row.id,
      caseId: row.caseId,
      kind: row.kind as "assign" | "escalate",
      status: "open" as const,
      owner: current.owner,
      assignee: current.assignee,
      reason: current.notes,
      actor: current.actorName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: current.updatedAt.toISOString(),
      actionVersion: actionVersionByCase.get(row.caseId) ?? 0,
      capabilities: {
         canAct: canActOnCase(caseById.get(row.caseId)!),
         canReassign: canActOnCase(caseById.get(row.caseId)!),
         canResolve: canActOnCase(caseById.get(row.caseId)!),
      },
      caseHref: caseHref(row.caseId),
      };
    }) : [],
    completed,
     opportunities: active ? opportunities.slice(0, limit) : [],
  };
}
