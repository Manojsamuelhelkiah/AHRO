/**
 * Policy and delivery boundary for contextual onboarding contact.
 *
 * This module deliberately sits in front of the existing channel and voice
 * implementations.  It chooses a recipient from the case/action policy (and
 * never from the request), checks the current case state, and then delegates
 * delivery to channels.ts or voice.ts.  Those modules remain the owners of
 * allowlists, provider safety, leases, and effect fencing.
 */
import { and, desc, eq, gte, like } from "drizzle-orm";
import { db } from "@workspace/db";
import { isRestrictedOfflineCase as isSyntheticOfflineCase } from "./operational-eligibility";
import {
  onbCases,
  onbCommunications,
  onbEffectJournal,
  onbEvents,
  onbReadinessSlaCaseState,
  onbReadinessSlaLedger,
  onbReadinessSlaSnapshots,
  onbSystemChecks,
  onbVoiceSessions,
  type OnbReadinessSlaActionPolicy,
} from "@workspace/db/schema";
import {
  addressAllowed,
  candidateEmailAuthorization,
  explicitlyAllowlistedCandidateAddress,
  sendAdministrativeEmail,
  sendOutbound,
} from "./channels";
import { candidateEmailMaySend, normalizePreference } from "./channel-routing";
import { refreshDemoAllowlist } from "./recipient-allowlist";
import { logEvent } from "./engine";
import { startVoiceCall, simulateVoiceCall } from "./voice";
import { getSetting, HR_APPROVER_EMAIL_KEY } from "./settings";
import { hrAlertAddress } from "./inbound-email";
import { isValidEmail } from "./settings";
import { calculateReadinessSlaActionTiming } from "./readiness-sla";
import {
  SYNTHETIC_OFFLINE_WARNING,
} from "./synthetic-offline";
import { withCaseDerivedLifecycleWrite } from "./sensitive-lifecycle";

export const CONTACT_ACTIONS = [
  "candidate-email",
  "owner-email",
  "backup-email",
  "candidate-call",
] as const;
export type ContactAction = (typeof CONTACT_ACTIONS)[number];
export type ContactScenario = "day-before" | "sla-escalation";

export const CONTEXTUAL_CONTACT_BODY_MIN = 1;
export const CONTEXTUAL_CONTACT_BODY_MAX = 5_000;
export const CONTEXTUAL_CONTACT_SUBJECT_MAX = 200;
export const CONTEXTUAL_CONTACT_GOAL_MAX = 500;
export const CONTEXTUAL_CONTACT_REVISION_MAX = 200;
export const RECENT_CONTACT_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type ContactSnapshot = string | number;

/**
 * The SLA agent may register its authoritative action lookup with the
 * Express app (or pass it to these functions).  Keeping the adapter small
 * lets this route land before the SLA action tables do, without trusting an
 * action id or recipient supplied by a caller.
 */
export type ContextualSlaAction = {
  id: string;
  organizationId: string;
  caseId: number;
  snapshotRevision?: ContactSnapshot | null;
  status: string;
  dueAt: Date | string | null;
  /** True only when the action is safe to expose to the candidate. */
  candidateRelevant: boolean;
  /** Documentation-only actions are the only automatic candidate-call goal. */
  actionKind?: string | null;
  goal?: string | null;
  ownerEmail?: string | null;
  backupEmail?: string | null;
  reason?: string | null;
};

export type ContextualSlaActionResolver = (input: {
  actionId: string;
  organizationId: string;
  caseId: number;
}) => Promise<ContextualSlaAction | null>;

type ContactCase = typeof onbCases.$inferSelect;

export type ContactRequestContext = {
  /**
   * Required for SLA escalation requests. `currentSnapshotRevision` remains
   * accepted as a wire-compatible alias for older clients, but both names
   * are normalized to the same expected immutable snapshot version.
   */
  expectedSnapshotRevision?: ContactSnapshot;
  currentSnapshotRevision?: ContactSnapshot;
  /** A policy-generated goal, not a recipient or delivery override. */
  goal?: string;
};

export type ContactRequest = {
  caseId: number;
  organizationId: string;
  action: ContactAction;
  scenario: ContactScenario;
  requestId: string;
  simulate?: boolean;
  subject?: string;
  body?: string;
  goal?: string;
  slaActionId?: string;
  context?: ContactRequestContext;
  /** Optional app-provided adapter for the connected readiness action store. */
  actionResolver?: ContextualSlaActionResolver;
  actorId?: string | null;
};

export type ContactOption = {
  action: ContactAction;
  audience: "candidate" | "owner" | "backup";
  channel: "email" | "voice";
  label: string;
  available: boolean;
  reasons: string[];
  recipient: string | null;
  gate: {
    gateARequired: boolean;
    gateAComplete: boolean;
    pendingDocsOfferPackageAllowed: boolean;
  };
  context: {
    scenario: ContactScenario;
    requiresSlaAction: boolean;
    slaActionId: string | null;
    snapshotRevision: ContactSnapshot | null;
    dueAt: string | null;
    status: string | null;
    candidateRelevant?: boolean;
  };
};

export type ContactOptionsResponse = {
  operationId: "getOnboardingContactOptions";
  caseId: number;
  audienceLabels: {
    candidate: string;
    owner: string;
    backup: string;
  };
  contacts: {
    candidateEmail: string | null;
    candidatePhone: string | null;
    ownerEmail: string | null;
    backupEmail: string | null;
  };
  gate: ContactOption["gate"];
  context: ContactOption["context"];
  activeCall: boolean;
  recentContact: {
    present: boolean;
    at: string | null;
    channel: string | null;
  };
  options: ContactOption[];
};

export type ContactDeliveryResult = {
  operationId: "sendOnboardingContextualContact";
  requestId: string;
  action: ContactAction;
  scenario: ContactScenario;
  status: string;
  delivery:
    | "sent"
    | "calling"
    | "simulated"
    | "logged-only"
    | "withheld"
    | "failed"
    | "sending"
    | "unknown"
    | "duplicate";
  communicationId?: number;
  voiceToken?: string;
  failureReason?: string | null;
  withheldReason?: string | null;
  audience: "candidate" | "owner" | "backup";
  recipient: string | null;
  slaActionId: string | null;
};

export class ContextualContactError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContextualContactError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type ContactDispatchState =
  "queued" | "sending" | "unknown" | "sent" | "failed" | "logged-only";

function classifyPersistedDispatchState(input: {
  claimState?: ContactDispatchState;
  communicationStatus?: string | null;
  journalStatus?: string | null;
  journalLeaseExpired?: boolean;
}): ContactDispatchState {
  if (
    input.journalStatus === "unknown_effect_manual_repair" ||
    (input.journalStatus === "dispatching" && input.journalLeaseExpired)
  ) {
    return "unknown";
  }
  if (input.journalStatus === "dispatching") return "sending";
  if (input.journalStatus === "confirmed") {
    if (input.communicationStatus === "failed") return "failed";
    if (input.communicationStatus === "logged-only") return "logged-only";
    return "sent";
  }
  const status = input.communicationStatus?.toLowerCase();
  if (status === "failed") return "failed";
  if (status === "logged-only") return "logged-only";
  if (status === "sent" || status === "calling" || status === "simulated") {
    return "sent";
  }
  if (input.communicationStatus) return "sending";
  return input.claimState ?? "queued";
}

type ContactClaimDetail = {
  claim?: boolean;
  organizationId?: string;
  caseId?: number;
  requestId?: string;
  action?: ContactAction;
  scenario?: ContactScenario;
  goal?: string;
  actorId?: string | null;
  slaActionId?: string | null;
  expectedSnapshotRevision?: ContactSnapshot | null;
  snapshotRevision?: ContactSnapshot | null;
  dueAt?: string | null;
  actionStatus?: string | null;
  candidateRelevant?: boolean;
  gateAComplete?: boolean;
  recipient?: string | null;
  deliveryKey?: string;
  dispatchState?: ContactDispatchState;
  failureReason?: string | null;
};

type ContactDbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.trim().split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const value = phone.trim();
  return value.length > 4 ? `${value.slice(0, 4)}•••${value.slice(-2)}` : "•••";
}

function normalizeRevision(
  value: ContactSnapshot | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function expectedSnapshotRevision(
  context: ContactRequestContext | undefined,
): ContactSnapshot | undefined {
  const expected = context?.expectedSnapshotRevision;
  const legacy = context?.currentSnapshotRevision;
  if (
    expected !== undefined &&
    legacy !== undefined &&
    String(expected) !== String(legacy)
  ) {
    throw new ContextualContactError(
      "snapshot_revision_conflict",
      "expectedSnapshotRevision and currentSnapshotRevision must match when both are provided.",
    );
  }
  return expected ?? legacy;
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeGoal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const goal = value.trim();
  if (!goal) return null;
  if (goal.length > CONTEXTUAL_CONTACT_GOAL_MAX) {
    throw new ContextualContactError(
      "invalid_goal",
      `Contextual action goal must be at most ${CONTEXTUAL_CONTACT_GOAL_MAX} characters`,
    );
  }
  return goal;
}

function candidateDocsGoal(goal: string | null | undefined): boolean {
  const normalized = (goal ?? "").toLowerCase();
  return (
    normalized.includes("pending-docs-offer-package") ||
    normalized.includes("pending documents offer package") ||
    normalized.includes("documentation reminder")
  );
}

function docsAction(action: ContextualSlaAction): boolean {
  const kind = (action.actionKind ?? "").toLowerCase();
  return (
    action.candidateRelevant &&
    (kind === "documentation" ||
      kind === "document" ||
      kind === "candidate-documentation" ||
      kind === "pending-docs" ||
      kind === "documents")
  );
}

function audienceFor(action: ContactAction): "candidate" | "owner" | "backup" {
  return action.startsWith("candidate-")
    ? "candidate"
    : action === "owner-email"
      ? "owner"
      : "backup";
}

function defaultGoal(
  action: ContactAction,
  scenario: ContactScenario,
  c: ContactCase,
): string {
  if (action === "candidate-call") {
    return scenario === "day-before"
      ? "Confirm the candidate is ready for joining day and identify any pending onboarding documentation."
      : "Ask the candidate about the candidate-relevant documentation item that is overdue and agree a next step.";
  }
  if (action === "candidate-email") {
    return scenario === "day-before"
      ? `Day-before onboarding check-in for ${c.workerName}.`
      : `Candidate documentation escalation for ${c.workerName}.`;
  }
  return scenario === "sla-escalation"
    ? `Review the overdue onboarding action for ${c.workerName}.`
    : `Review the onboarding contact state for ${c.workerName}.`;
}

function defaultCandidateSubject(scenario: ContactScenario): string {
  return scenario === "day-before"
    ? "A quick check-in before your first day"
    : "Action needed on your onboarding documentation";
}

function defaultCandidateBody(
  c: ContactCase,
  scenario: ContactScenario,
  goal: string,
): string {
  const firstName = c.workerName.split(/\s+/)[0] || "there";
  return scenario === "day-before"
    ? `Hi ${firstName},\n\nThis is a quick check-in ahead of your joining day. Please reply if anything is still needed from your side.\n\n${goal}\n\nBest,\nThe onboarding team`
    : `Hi ${firstName},\n\nWe are following up on a time-sensitive onboarding item. Please reply with an update or let us know if you need help.\n\n${goal}\n\nBest,\nThe onboarding team`;
}

function defaultAdministrativeSubject(
  action: ContactAction,
  scenario: ContactScenario,
): string {
  return action === "owner-email"
    ? `[Onboarding] ${scenario === "sla-escalation" ? "SLA escalation" : "Contact requested"}`
    : `[Onboarding] Backup ${scenario === "sla-escalation" ? "SLA escalation" : "contact"} notification`;
}

function defaultAdministrativeBody(
  c: ContactCase,
  scenario: ContactScenario,
  action: ContactAction,
  goal: string,
  sla: ContextualSlaAction | null,
): string {
  return [
    `A contextual ${scenario} contact was requested for ${c.workerName} (case ${c.id}).`,
    `Audience: ${audienceFor(action)}.`,
    sla?.reason ? `Action context: ${sla.reason}` : null,
    `Goal: ${goal}`,
    "No employment status or onboarding gate was changed by this notification.",
  ]
    .filter(Boolean)
    .join("\n");
}

function availableOption(
  action: ContactAction,
  c: ContactCase,
  gate: ContactOption["gate"],
  context: ContactOption["context"],
  state: {
    candidateEmail: {
      allowed: boolean;
      reasons: string[];
      recipient: string | null;
    };
    candidateCall: {
      allowed: boolean;
      reasons: string[];
      recipient: string | null;
    };
    owner: { allowed: boolean; reasons: string[]; recipient: string | null };
    backup: { allowed: boolean; reasons: string[]; recipient: string | null };
    activeCall: boolean;
    recentContact: {
      present: boolean;
      at: string | null;
      channel: string | null;
    };
  },
): ContactOption {
  const audience = audienceFor(action);
  const channel = action === "candidate-call" ? "voice" : "email";
  const base =
    action === "candidate-email"
      ? state.candidateEmail
      : action === "candidate-call"
        ? state.candidateCall
        : action === "owner-email"
          ? state.owner
          : state.backup;
  const reasons = [...base.reasons];
  if (state.recentContact.present && audience === "candidate") {
    reasons.push(
      "A candidate contact was sent recently; wait before sending another contextual contact.",
    );
  }
  if (state.activeCall && audience === "candidate") {
    reasons.push("A candidate voice call is already active for this case.");
  }
  if (
    !gate.gateAComplete &&
    gate.gateARequired &&
    audience === "candidate" &&
    !gate.pendingDocsOfferPackageAllowed
  ) {
    reasons.push(
      "Offer-Acceptance Package must be confirmed before candidate contact that advances preboarding.",
    );
  }
  if (context.requiresSlaAction && !context.slaActionId) {
    reasons.push("A current SLA action is required for this escalation.");
  }
  if (
    context.requiresSlaAction &&
    audience === "candidate" &&
    context.candidateRelevant !== true
  ) {
    reasons.push(
      "This SLA action is not candidate-relevant documentation; candidate contact is withheld.",
    );
  }
  return {
    action,
    audience,
    channel,
    label:
      action === "candidate-email"
        ? "Email candidate"
        : action === "candidate-call"
          ? "Call candidate"
          : action === "owner-email"
            ? "Email action owner"
            : "Email backup owner",
    available:
      base.allowed &&
      !(state.recentContact.present && audience === "candidate") &&
      !(state.activeCall && action === "candidate-call") &&
      (gate.gateAComplete ||
        audience !== "candidate" ||
        gate.pendingDocsOfferPackageAllowed) &&
      (!context.requiresSlaAction || Boolean(context.slaActionId)) &&
      // Candidate routes are additionally restricted to a documentation
      // action returned by the authoritative SLA snapshot.
      (!context.requiresSlaAction ||
        audience !== "candidate" ||
        context.candidateRelevant === true),
    reasons,
    recipient: base.recipient,
    gate,
    context,
  };
}

async function defaultSlaActionResolver(
  input: {
    actionId: string;
    organizationId: string;
    caseId: number;
  },
  executor: ContactDbTransaction | typeof db = db,
): Promise<ContextualSlaAction | null> {
  // Connected readiness actions are keyed by the immutable policy action key
  // and bound to the case's current snapshot.  Resolve this before the
  // legacy system-check adapter so a BGV/vendor breach can never be mistaken
  // for candidate documentation work.
  const [state] = await executor
    .select()
    .from(onbReadinessSlaCaseState)
    .where(
      and(
        eq(onbReadinessSlaCaseState.organizationId, input.organizationId),
        eq(onbReadinessSlaCaseState.caseId, input.caseId),
      ),
    );
  if (state) {
    const [snapshot] = await executor
      .select()
      .from(onbReadinessSlaSnapshots)
      .where(
        and(
          eq(onbReadinessSlaSnapshots.organizationId, input.organizationId),
          eq(onbReadinessSlaSnapshots.caseId, input.caseId),
          eq(onbReadinessSlaSnapshots.snapshotVersion, state.snapshotVersion),
        ),
      );
    const [c] = await executor
      .select()
      .from(onbCases)
      .where(
        and(
          eq(onbCases.organizationId, input.organizationId),
          eq(onbCases.id, input.caseId),
        ),
      );
    const policyAction = snapshot?.policy.actions.find(
      (action: OnbReadinessSlaActionPolicy) => action.key === input.actionId,
    );
    if (snapshot && c && policyAction) {
      const timing = calculateReadinessSlaActionTiming({
        action: policyAction,
        joiningDate: c.joiningDate,
        actionStartedAt: c.createdAt,
        payrollCutoff: state.payrollCutoff,
      });
      const [ledger] = await executor
        .select()
        .from(onbReadinessSlaLedger)
        .where(
          and(
            eq(onbReadinessSlaLedger.organizationId, input.organizationId),
            eq(onbReadinessSlaLedger.caseId, input.caseId),
            eq(onbReadinessSlaLedger.snapshotVersion, state.snapshotVersion),
            eq(onbReadinessSlaLedger.actionKey, input.actionId),
          ),
        )
        .orderBy(desc(onbReadinessSlaLedger.occurrence))
        .limit(1);
      return {
        id: policyAction.key,
        organizationId: input.organizationId,
        caseId: input.caseId,
        snapshotRevision: snapshot.snapshotVersion,
        status: ledger?.state ?? timing.status,
        dueAt: timing.dueAt,
        candidateRelevant: policyAction.streamKey === "documentation",
        actionKind: policyAction.streamKey,
        goal: policyAction.label,
        // There is no unsafe per-action owner override in the readiness
        // contract. The configured HR approver remains the owner recipient;
        // backupEmail is an action-policy address and is safe to use.
        ownerEmail: isValidEmail(policyAction.owner)
          ? policyAction.owner
          : null,
        backupEmail: policyAction.backupEmail,
        reason: policyAction.label,
      };
    }
  }
  // Compatibility adapter for the existing readiness checks.  BGV/ITSM/
  // payroll checks are intentionally not candidate-relevant; the connected
  // readiness action provider must explicitly mark documentation actions as
  // candidate-relevant before candidate contact can be sent.
  if (!/^\d+$/.test(input.actionId)) return null;
  const [row] = await executor
    .select()
    .from(onbSystemChecks)
    .where(
      and(
        eq(onbSystemChecks.id, Number(input.actionId)),
        eq(onbSystemChecks.organizationId, input.organizationId),
        eq(onbSystemChecks.caseId, input.caseId),
      ),
    );
  if (!row) return null;
  return {
    id: String(row.id),
    organizationId: row.organizationId,
    caseId: row.caseId,
    status: row.status,
    dueAt: row.dueAt,
    candidateRelevant: false,
    actionKind: row.system,
    reason: `${row.system} action ${row.externalRef}`,
  };
}

async function resolveAction(
  request: Pick<
    ContactRequest,
    | "action"
    | "scenario"
    | "slaActionId"
    | "context"
    | "caseId"
    | "organizationId"
  >,
  resolver?: ContextualSlaActionResolver,
  executor: ContactDbTransaction | typeof db = db,
): Promise<ContextualSlaAction | null> {
  if (request.scenario !== "sla-escalation") {
    if (request.slaActionId) {
      throw new ContextualContactError(
        "sla_action_not_allowed",
        "slaActionId is only valid for sla-escalation.",
        400,
      );
    }
    return null;
  }
  if (!request.slaActionId) {
    throw new ContextualContactError(
      "sla_action_required",
      "A current slaActionId is required for an SLA escalation contact.",
      409,
    );
  }
  const expectedRevision = expectedSnapshotRevision(request.context);
  if (expectedRevision === undefined) {
    throw new ContextualContactError(
      "snapshot_revision_required",
      "expectedSnapshotRevision is required for every SLA escalation contact.",
      409,
    );
  }
  const action = resolver
    ? await resolver({
        actionId: request.slaActionId,
        organizationId: request.organizationId,
        caseId: request.caseId,
      })
    : await defaultSlaActionResolver(
        {
          actionId: request.slaActionId,
          organizationId: request.organizationId,
          caseId: request.caseId,
        },
        executor,
      );
  if (
    !action ||
    action.id !== request.slaActionId ||
    action.organizationId !== request.organizationId ||
    action.caseId !== request.caseId
  ) {
    throw new ContextualContactError(
      "sla_action_not_found",
      "The SLA action is not current for this organization and case.",
      409,
    );
  }
  const requestedRevision = normalizeRevision(expectedRevision);
  const actionRevision = normalizeRevision(action.snapshotRevision);
  if (
    requestedRevision &&
    actionRevision &&
    requestedRevision !== actionRevision
  ) {
    throw new ContextualContactError(
      "stale_sla_action",
      "The readiness action changed; refresh the current action context before contacting anyone.",
      409,
      { currentSnapshotRevision: action.snapshotRevision },
    );
  }
  if (requestedRevision && !actionRevision) {
    throw new ContextualContactError(
      "snapshot_revision_unavailable",
      "The readiness action does not expose the requested snapshot revision.",
      409,
    );
  }
  const dueAt = parseDate(action.dueAt);
  const currentStatus = action.status.toLowerCase();
  if (
    !dueAt ||
    (currentStatus !== "overdue" && dueAt.getTime() >= Date.now()) ||
    [
      "done",
      "completed",
      "cancelled",
      "canceled",
      "closed",
      "resolved",
    ].includes(currentStatus)
  ) {
    throw new ContextualContactError(
      "sla_action_not_due",
      "The SLA action is no longer due or overdue; no escalation contact was sent.",
      409,
    );
  }
  if (
    request.action === "candidate-email" ||
    request.action === "candidate-call"
  ) {
    if (!docsAction(action)) {
      throw new ContextualContactError(
        "candidate_contact_not_allowed",
        "This SLA action is not a candidate-relevant documentation action; no candidate contact was sent.",
        409,
      );
    }
  }
  return action;
}

async function loadCase(
  caseId: number,
  organizationId: string,
  executor: ContactDbTransaction | typeof db = db,
  lock = false,
): Promise<ContactCase> {
  let query = executor
    .select()
    .from(onbCases)
    .where(
      and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId)),
    );
  if (lock) query = query.for("update") as typeof query;
  const [c] = await query;
  if (!c)
    throw new ContextualContactError("case_not_found", "Case not found.", 404);
  return c;
}

async function contactState(
  c: ContactCase,
  organizationId: string,
  policy?: ContextualSlaAction | null,
  executor: ContactDbTransaction | typeof db = db,
) {
  await refreshDemoAllowlist(organizationId);
  const auth = candidateEmailAuthorization(c);
  const explicitlyAllowlisted = explicitlyAllowlistedCandidateAddress(
    c.workerEmail,
    organizationId,
  );
  const candidateEmailAllowed = candidateEmailMaySend({
    channelPreference: c.channelPreference,
    caseAuthorized: auth.allowed,
    explicitlyAllowlisted,
    validEmail: isValidEmail(c.workerEmail),
  });
  const candidateEmailReasons: string[] = [];
  if (!isValidEmail(c.workerEmail))
    candidateEmailReasons.push("Candidate email on the case is invalid.");
  if (!["email", "both"].includes(normalizePreference(c.channelPreference))) {
    candidateEmailReasons.push(
      `The case contact preference is ${c.channelPreference}; candidate email is not enabled.`,
    );
  }
  if (!auth.allowed)
    candidateEmailReasons.push(
      auth.reason ?? "Candidate email is not authorized for live delivery.",
    );
  if (!explicitlyAllowlisted)
    candidateEmailReasons.push(
      "Candidate email is not on the configured demo allowlist.",
    );

  const candidateCallAllowed =
    Boolean(c.workerPhone) &&
    addressAllowed(c.workerPhone ?? "", organizationId);
  const candidateCallReasons: string[] = [];
  if (!c.workerPhone)
    candidateCallReasons.push("Candidate has no phone number on the case.");
  else if (!addressAllowed(c.workerPhone, organizationId))
    candidateCallReasons.push(
      "Candidate phone is not on the configured demo allowlist.",
    );

  const ownerEmail =
    policy?.ownerEmail?.trim() ||
    (await getSetting(organizationId, HR_APPROVER_EMAIL_KEY))?.trim() ||
    null;
  const backupEmail =
    policy?.backupEmail?.trim() || (await hrAlertAddress(organizationId));
  const ownerReasons: string[] = [];
  const backupReasons: string[] = [];
  if (!ownerEmail)
    ownerReasons.push(
      "No action-owner email is configured in the action policy.",
    );
  else if (!isValidEmail(ownerEmail))
    ownerReasons.push("Configured action-owner email is invalid.");
  else if (!addressAllowed(ownerEmail, organizationId))
    ownerReasons.push(
      "Action-owner email is not on the configured administrative allowlist.",
    );
  if (!backupEmail)
    backupReasons.push(
      "No backup owner email is configured in the action policy.",
    );
  else if (!isValidEmail(backupEmail))
    backupReasons.push("Configured backup owner email is invalid.");
  else if (!addressAllowed(backupEmail, organizationId))
    backupReasons.push(
      "Backup owner email is not on the configured administrative allowlist.",
    );

  const [active] = await executor
    .select({ startedAt: onbVoiceSessions.startedAt })
    .from(onbVoiceSessions)
    .where(
      and(
        eq(onbVoiceSessions.organizationId, organizationId),
        eq(onbVoiceSessions.caseId, c.id),
        eq(onbVoiceSessions.finalized, false),
      ),
    )
    .limit(1);
  const recentCutoff = new Date(Date.now() - RECENT_CONTACT_WINDOW_MS);
  const [recent] = await executor
    .select({
      createdAt: onbCommunications.createdAt,
      channel: onbCommunications.channel,
    })
    .from(onbCommunications)
    .where(
      and(
        eq(onbCommunications.organizationId, organizationId),
        eq(onbCommunications.caseId, c.id),
        eq(onbCommunications.direction, "outbound"),
        eq(onbCommunications.audience, "candidate"),
        gte(onbCommunications.createdAt, recentCutoff),
      ),
    )
    .orderBy(desc(onbCommunications.createdAt))
    .limit(1);
  const recentClaims = await executor
    .select({
      createdAt: onbEvents.createdAt,
      detail: onbEvents.detail,
    })
    .from(onbEvents)
    .where(
      and(
        eq(onbEvents.organizationId, organizationId),
        eq(onbEvents.caseId, c.id),
        gte(onbEvents.createdAt, recentCutoff),
        like(onbEvents.idempotencyKey, "contextual-contact:%"),
      ),
    );
  const candidateClaims = recentClaims
    .map((row) => {
      try {
        return { ...row, detail: JSON.parse(row.detail) as ContactClaimDetail };
      } catch {
        return null;
      }
    })
    .filter(
      (
        row,
      ): row is {
        createdAt: Date;
        detail: ContactClaimDetail;
      } =>
        Boolean(
          row?.detail.claim &&
          row.detail.action &&
          audienceFor(row.detail.action) === "candidate",
        ),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const recentCandidate =
    recent &&
    (!candidateClaims ||
      recent.createdAt.getTime() >= candidateClaims.createdAt.getTime())
      ? {
          present: true,
          at: recent.createdAt.toISOString(),
          channel: recent.channel,
        }
      : candidateClaims
        ? {
            present: true,
            at: candidateClaims.createdAt.toISOString(),
            channel:
              candidateClaims.detail.action === "candidate-call"
                ? "voice"
                : "email",
          }
        : null;
  return {
    candidateEmail: {
      allowed: candidateEmailAllowed,
      reasons: candidateEmailReasons,
      recipient: maskEmail(c.workerEmail),
    },
    candidateCall: {
      allowed: candidateCallAllowed,
      reasons: candidateCallReasons,
      recipient: maskPhone(c.workerPhone),
    },
    owner: {
      allowed: Boolean(
        ownerEmail &&
        isValidEmail(ownerEmail) &&
        addressAllowed(ownerEmail, organizationId),
      ),
      reasons: ownerReasons,
      recipient: maskEmail(ownerEmail),
    },
    backup: {
      allowed: Boolean(
        backupEmail &&
        isValidEmail(backupEmail) &&
        addressAllowed(backupEmail, organizationId),
      ),
      reasons: backupReasons,
      recipient: maskEmail(backupEmail),
    },
    activeCall: Boolean(active),
    recentContact: recentCandidate ?? {
      present: false,
      at: null,
      channel: null,
    },
  };
}

function gateFor(c: ContactCase, goal: string | null): ContactOption["gate"] {
  const gateARequired = ["external-fte", "contractor", "rehire"].includes(
    c.hireType,
  );
  return {
    gateARequired,
    gateAComplete: !gateARequired || c.offerAcceptanceComplete,
    pendingDocsOfferPackageAllowed: candidateDocsGoal(goal),
  };
}

export async function getOnboardingContactOptions(input: {
  caseId: number;
  organizationId: string;
  scenario?: ContactScenario;
  goal?: string;
  slaActionId?: string;
  context?: ContactRequestContext;
  actionResolver?: ContextualSlaActionResolver;
}): Promise<ContactOptionsResponse> {
  const scenario = input.scenario ?? "day-before";
  if (scenario !== "day-before" && scenario !== "sla-escalation") {
    throw new ContextualContactError(
      "invalid_scenario",
      "scenario must be day-before or sla-escalation.",
    );
  }
  const c = await loadCase(input.caseId, input.organizationId);
  const goal = normalizeGoal(input.goal ?? input.context?.goal);
  if (isSyntheticOfflineCase(c)) {
    const scenario = input.scenario ?? "day-before";
    const gate = gateFor(c, goal);
    const context: ContactOption["context"] = {
      scenario,
      requiresSlaAction: scenario === "sla-escalation",
      slaActionId: null,
      snapshotRevision: null,
      dueAt: null,
      status: null,
      candidateRelevant: scenario === "day-before",
    };
    const options = CONTACT_ACTIONS.map((action): ContactOption => ({
      action,
      audience: audienceFor(action),
      channel: action === "candidate-call" ? "voice" : "email",
      label: action,
      available: false,
      reasons: [SYNTHETIC_OFFLINE_WARNING],
      recipient: null,
      gate,
      context,
    }));
    return {
      operationId: "getOnboardingContactOptions",
      caseId: c.id,
      audienceLabels: {
        candidate: "Candidate",
        owner: "Action owner",
        backup: "Backup owner",
      },
      contacts: {
        candidateEmail: null,
        candidatePhone: null,
        ownerEmail: null,
        backupEmail: null,
      },
      gate,
      context,
      activeCall: false,
      recentContact: { present: false, at: null, channel: null },
      options,
    };
  }
  const sla = await resolveAction(
    {
      action: "owner-email",
      scenario,
      slaActionId: input.slaActionId,
      context: input.context,
      caseId: c.id,
      organizationId: c.organizationId,
    },
    input.actionResolver,
  );
  const state = await contactState(c, input.organizationId, sla);
  const gate = gateFor(c, goal);
  const context: ContactOption["context"] = {
    scenario,
    requiresSlaAction: scenario === "sla-escalation",
    slaActionId: sla?.id ?? null,
    snapshotRevision: sla?.snapshotRevision ?? null,
    dueAt: parseDate(sla?.dueAt)?.toISOString() ?? null,
    status: sla?.status ?? null,
    candidateRelevant:
      scenario === "day-before" ? true : sla?.candidateRelevant === true,
  };
  const options = CONTACT_ACTIONS.map((action) =>
    availableOption(action, c, gate, context, state),
  );
  return {
    operationId: "getOnboardingContactOptions",
    caseId: c.id,
    audienceLabels: {
      candidate: "Candidate",
      owner: "Action owner",
      backup: "Backup owner",
    },
    contacts: {
      candidateEmail: state.candidateEmail.recipient,
      candidatePhone: state.candidateCall.recipient,
      ownerEmail: state.owner.recipient,
      backupEmail: state.backup.recipient,
    },
    gate,
    context,
    activeCall: state.activeCall,
    recentContact: state.recentContact,
    options,
  };
}

async function claimRequest(
  executor: ContactDbTransaction,
  input: ContactRequest,
  goal: string,
  option: ContactOption,
  sla: ContextualSlaAction | null,
): Promise<"claimed" | "duplicate"> {
  const deliveryKey = `contextual-contact:${input.requestId}:delivery`;
  const detail = JSON.stringify({
    claim: true,
    organizationId: input.organizationId,
    caseId: input.caseId,
    requestId: input.requestId,
    action: input.action,
    scenario: input.scenario,
    goal,
    actorId: input.actorId ?? null,
    slaActionId: sla?.id ?? null,
    expectedSnapshotRevision: expectedSnapshotRevision(input.context) ?? null,
    snapshotRevision: sla?.snapshotRevision ?? null,
    dueAt: parseDate(sla?.dueAt)?.toISOString() ?? null,
    actionStatus: sla?.status ?? null,
    candidateRelevant: sla?.candidateRelevant ?? null,
    gateAComplete: option.gate.gateAComplete,
    recipient: option.recipient,
    deliveryKey,
    dispatchState: "queued",
  });
  const inserted = await executor
    .insert(onbEvents)
    .values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "channel",
      engine: "rules",
      hitlPattern: "act-then-review",
      ruleRef: "4.6 Communications Rules",
      title: "Contextual contact requested",
      detail,
      idempotencyKey: `contextual-contact:${input.requestId}`,
    })
    .onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    })
    .returning({ id: onbEvents.id });
  if (inserted.length) return "claimed";
  const [existing] = await executor
    .select({ caseId: onbEvents.caseId })
    .from(onbEvents)
    .where(
      and(
        eq(onbEvents.organizationId, input.organizationId),
        eq(onbEvents.idempotencyKey, `contextual-contact:${input.requestId}`),
      ),
    );
  if (existing?.caseId !== input.caseId) {
    throw new ContextualContactError(
      "request_id_conflict",
      "requestId is already bound to another case.",
      409,
    );
  }
  return "duplicate";
}

async function requestAlreadyClaimed(
  input: ContactRequest,
  executor: ContactDbTransaction | typeof db = db,
): Promise<ContactClaimDetail | null> {
  const [existing] = await executor
    .select({
      caseId: onbEvents.caseId,
      detail: onbEvents.detail,
    })
    .from(onbEvents)
    .where(
      and(
        eq(onbEvents.organizationId, input.organizationId),
        eq(onbEvents.idempotencyKey, `contextual-contact:${input.requestId}`),
      ),
    );
  if (!existing) return null;
  if (existing.caseId !== input.caseId) {
    throw new ContextualContactError(
      "request_id_conflict",
      "requestId is already bound to another case.",
      409,
    );
  }
  let prior: ContactClaimDetail = {};
  try {
    prior = JSON.parse(existing.detail) as ContactClaimDetail;
    if (prior.action !== input.action || prior.scenario !== input.scenario) {
      throw new ContextualContactError(
        "request_id_conflict",
        "requestId is already bound to another contact action.",
        409,
      );
    }
  } catch (error) {
    if (error instanceof ContextualContactError) throw error;
    // An older event with this key is still a durable claim.  Do not risk
    // dispatching a second provider effect when its detail cannot be parsed.
  }
  return prior;
}

async function persistedDispatchState(
  input: ContactRequest,
  claim: ContactClaimDetail,
): Promise<{
  state: ContactDispatchState;
  failureReason: string | null;
  communicationId?: number;
}> {
  const deliveryKey =
    claim.deliveryKey ?? `contextual-contact:${input.requestId}:delivery`;
  const [communication] = await db
    .select()
    .from(onbCommunications)
    .where(
      and(
        eq(onbCommunications.organizationId, input.organizationId),
        eq(onbCommunications.idempotencyKey, deliveryKey),
      ),
    );
  const logicalOperationKey =
    input.action === "candidate-email" || input.action === "candidate-call"
      ? `candidate-communication:${deliveryKey}`
      : `administrative-communication:${deliveryKey}`;
  const [journal] = await db
    .select()
    .from(onbEffectJournal)
    .where(
      and(
        eq(onbEffectJournal.organizationId, input.organizationId),
        eq(onbEffectJournal.logicalOperationKey, logicalOperationKey),
      ),
    );
  if (communication && communication.caseId !== input.caseId) {
    throw new ContextualContactError(
      "request_id_conflict",
      "The durable delivery key is already bound to another case.",
      409,
    );
  }
  if (journal && journal.caseId !== input.caseId) {
    throw new ContextualContactError(
      "request_id_conflict",
      "The durable effect key is already bound to another case.",
      409,
    );
  }
  if (journal?.status === "unknown_effect_manual_repair") {
    return {
      state: "unknown",
      failureReason:
        journal.lastError ??
        "Delivery outcome unknown; manual reconciliation is required.",
      communicationId: communication?.id,
    };
  }
  if (journal?.status === "dispatching") {
    if (journal.claimUntil && journal.claimUntil.getTime() <= Date.now()) {
      return {
        state: "unknown",
        failureReason:
          "Dispatch lease expired before confirmation; manual reconciliation is required.",
        communicationId: communication?.id,
      };
    }
    return {
      state: "sending",
      failureReason: communication?.failureReason ?? null,
      communicationId: communication?.id,
    };
  }
  if (journal?.status === "confirmed") {
    return {
      state: classifyPersistedDispatchState({
        communicationStatus: communication?.status,
        journalStatus: journal.status,
      }),
      failureReason: communication?.failureReason ?? null,
      communicationId: communication?.id,
    };
  }
  if (input.action === "candidate-call") {
    const [activeVoice] = await db
      .select({ token: onbVoiceSessions.token })
      .from(onbVoiceSessions)
      .where(
        and(
          eq(onbVoiceSessions.organizationId, input.organizationId),
          eq(onbVoiceSessions.caseId, input.caseId),
          eq(onbVoiceSessions.finalized, false),
        ),
      )
      .limit(1);
    if (activeVoice) {
      return {
        state: "sent",
        failureReason: null,
      };
    }
  }
  if (communication) {
    return {
      state: classifyPersistedDispatchState({
        communicationStatus: communication.status,
        journalStatus: journal?.status,
      }),
      failureReason: communication.failureReason,
      communicationId: communication.id,
    };
  }
  return {
    state: claim.dispatchState ?? "queued",
    failureReason: claim.failureReason ?? null,
  };
}

function duplicateResult(
  input: ContactRequest,
  claim: ContactClaimDetail,
  persisted: Awaited<ReturnType<typeof persistedDispatchState>>,
): ContactDeliveryResult {
  return {
    operationId: "sendOnboardingContextualContact",
    requestId: input.requestId,
    action: input.action,
    scenario: input.scenario,
    // A duplicate is deliberately not reported as a successful send. The
    // status is the durable queued/sending/unknown/terminal disposition.
    status: persisted.state,
    delivery: "duplicate",
    failureReason: persisted.failureReason,
    audience: audienceFor(input.action),
    recipient: claim.recipient ?? null,
    slaActionId: claim.slaActionId ?? input.slaActionId ?? null,
    ...(persisted.communicationId
      ? { communicationId: persisted.communicationId }
      : {}),
  };
}

function actionContextMatches(
  expected: ContactClaimDetail,
  actual: ContextualSlaAction | null,
): boolean {
  if (!actual) return false;
  return (
    actual.id === expected.slaActionId &&
    actual.organizationId === expected.organizationId &&
    actual.caseId === expected.caseId &&
    normalizeRevision(actual.snapshotRevision) ===
      normalizeRevision(expected.snapshotRevision) &&
    parseDate(actual.dueAt)?.getTime() ===
      parseDate(expected.dueAt)?.getTime() &&
    actual.status.toLowerCase() ===
      (expected.actionStatus ?? "").toLowerCase() &&
    actual.candidateRelevant === expected.candidateRelevant
  );
}

async function markClaimState(
  input: ContactRequest,
  state: ContactDispatchState,
  failureReason?: string | null,
): Promise<void> {
  await withCaseDerivedLifecycleWrite({
    organizationId: input.organizationId,
    caseId: input.caseId,
  }, async (tx) => {
    const [row] = await tx
      .select({ detail: onbEvents.detail })
      .from(onbEvents)
      .where(
        and(
          eq(onbEvents.organizationId, input.organizationId),
          eq(onbEvents.caseId, input.caseId),
          eq(onbEvents.idempotencyKey, `contextual-contact:${input.requestId}`),
        ),
      );
    if (!row) return;
    let detail: ContactClaimDetail;
    try {
      detail = JSON.parse(row.detail) as ContactClaimDetail;
    } catch {
      detail = { claim: true };
    }
    detail.dispatchState = state;
    detail.failureReason = failureReason ?? null;
    await tx
      .update(onbEvents)
      .set({ detail: JSON.stringify(detail) })
      .where(
        and(
          eq(onbEvents.organizationId, input.organizationId),
          eq(onbEvents.caseId, input.caseId),
          eq(onbEvents.idempotencyKey, `contextual-contact:${input.requestId}`),
        ),
      );
  });
}

async function revalidateClaimBeforeDispatch(
  input: ContactRequest,
  expectedClaim: ContactClaimDetail,
): Promise<void> {
  const outcome = await withCaseDerivedLifecycleWrite({
    organizationId: input.organizationId,
    caseId: input.caseId,
  }, async (tx) => {
    const [caseRow] = await tx
      .select()
      .from(onbCases)
      .where(
        and(
          eq(onbCases.id, input.caseId),
          eq(onbCases.organizationId, input.organizationId),
        ),
      )
      .for("update");
    if (!caseRow) {
      return {
        error: new ContextualContactError(
          "case_not_found",
          "Case not found.",
          404,
        ),
      };
    }
    let action: ContextualSlaAction | null = null;
    let error: unknown = null;
    if (input.scenario === "sla-escalation") {
      try {
        action = await resolveAction(input, input.actionResolver, tx);
      } catch (err) {
        error = err;
      }
      if (!error && !actionContextMatches(expectedClaim, action)) {
        error = new ContextualContactError(
          "stale_sla_action",
          "The SLA action changed before the provider boundary; no contact was sent.",
          409,
          { manualRepairRequired: false },
        );
      }
    }
    if (
      !error &&
      audienceFor(input.action) === "candidate" &&
      ((input.action === "candidate-email" &&
        maskEmail(caseRow.workerEmail) !== expectedClaim.recipient) ||
        (input.action === "candidate-call" &&
          maskPhone(caseRow.workerPhone) !== expectedClaim.recipient))
    ) {
      error = new ContextualContactError(
        "case_contact_changed",
        "The case contact changed before the provider boundary; no contact was sent.",
        409,
      );
    }
    if (
      !error &&
      expectedClaim.gateAComplete === true &&
      !gateFor(caseRow, expectedClaim.goal ?? "").gateAComplete
    ) {
      error = new ContextualContactError(
        "gate_changed",
        "Offer-Acceptance Package changed before the provider boundary; no contact was sent.",
        409,
      );
    }
    if (!error && audienceFor(input.action) === "candidate") {
      const recentCutoff = new Date(Date.now() - RECENT_CONTACT_WINDOW_MS);
      const [recentCandidate] = await tx
        .select({ id: onbCommunications.id })
        .from(onbCommunications)
        .where(
          and(
            eq(onbCommunications.organizationId, input.organizationId),
            eq(onbCommunications.caseId, input.caseId),
            eq(onbCommunications.direction, "outbound"),
            eq(onbCommunications.audience, "candidate"),
            gte(onbCommunications.createdAt, recentCutoff),
          ),
        )
        .limit(1);
      if (recentCandidate) {
        error = new ContextualContactError(
          "recent_contact",
          "A candidate contact was recorded before the provider boundary; no second contact was sent.",
          409,
        );
      }
    }
    if (!error && input.action === "candidate-call") {
      const [activeCall] = await tx
        .select({ token: onbVoiceSessions.token })
        .from(onbVoiceSessions)
        .where(
          and(
            eq(onbVoiceSessions.organizationId, input.organizationId),
            eq(onbVoiceSessions.caseId, input.caseId),
            eq(onbVoiceSessions.finalized, false),
          ),
        )
        .limit(1);
      if (activeCall) {
        error = new ContextualContactError(
          "active_call",
          "A candidate voice call became active before the provider boundary; no second call was sent.",
          409,
        );
      }
    }
    const [event] = await tx
      .select({ detail: onbEvents.detail })
      .from(onbEvents)
      .where(
        and(
          eq(onbEvents.organizationId, input.organizationId),
          eq(onbEvents.caseId, input.caseId),
          eq(onbEvents.idempotencyKey, `contextual-contact:${input.requestId}`),
        ),
      )
      .for("update");
    if (!event) {
      return {
        error: new ContextualContactError(
          "claim_missing",
          "The contextual contact claim disappeared before dispatch.",
          409,
        ),
      };
    }
    let detail: ContactClaimDetail;
    try {
      detail = JSON.parse(event.detail) as ContactClaimDetail;
    } catch {
      detail = expectedClaim;
    }
    const policyRejected =
      error instanceof ContextualContactError &&
      [
        "stale_sla_action",
        "sla_action_not_found",
        "sla_action_not_due",
        "case_contact_changed",
        "gate_changed",
        "recent_contact",
        "active_call",
      ].includes(error.code);
    detail.dispatchState = error
      ? policyRejected
        ? "failed"
        : "unknown"
      : "sending";
    detail.failureReason = error instanceof Error ? error.message : null;
    await tx
      .update(onbEvents)
      .set({ detail: JSON.stringify(detail) })
      .where(
        and(
          eq(onbEvents.organizationId, input.organizationId),
          eq(onbEvents.caseId, input.caseId),
          eq(onbEvents.idempotencyKey, `contextual-contact:${input.requestId}`),
        ),
      );
    return { error };
  });
  if (outcome.error) throw outcome.error;
}

type PreparedContact =
  | {
      kind: "duplicate";
      claim: ContactClaimDetail;
    }
  | {
      kind: "withheld";
      caseRow: ContactCase;
      option: ContactOption;
      reason: string;
      sla: ContextualSlaAction | null;
    }
  | {
      kind: "claimed";
      caseRow: ContactCase;
      goal: string;
      option: ContactOption;
      context: ContactOption["context"];
      sla: ContextualSlaAction | null;
      claim: ContactClaimDetail;
    };

async function prepareContactRequest(
  input: ContactRequest,
): Promise<PreparedContact> {
  return withCaseDerivedLifecycleWrite({
    organizationId: input.organizationId,
    caseId: input.caseId,
  }, async (tx): Promise<PreparedContact> => {
    const c = await loadCase(input.caseId, input.organizationId, tx, true);
    const existing = await requestAlreadyClaimed(input, tx);
    if (existing) return { kind: "duplicate", claim: existing };

    const goal =
      normalizeGoal(input.goal ?? input.context?.goal) ??
      defaultGoal(input.action, input.scenario, c);
    const sla = await resolveAction(input, input.actionResolver, tx);
    const state = await contactState(c, input.organizationId, sla, tx);
    const gate = gateFor(c, goal);
    const context: ContactOption["context"] = {
      scenario: input.scenario,
      requiresSlaAction: input.scenario === "sla-escalation",
      slaActionId: sla?.id ?? null,
      snapshotRevision: sla?.snapshotRevision ?? null,
      dueAt: parseDate(sla?.dueAt)?.toISOString() ?? null,
      status: sla?.status ?? null,
      candidateRelevant:
        input.scenario === "day-before"
          ? true
          : sla?.candidateRelevant === true,
    };
    const option = availableOption(input.action, c, gate, context, state);
    if (!option.available) {
      return {
        kind: "withheld",
        caseRow: c,
        option,
        reason:
          option.reasons.join(" ") ||
          "Contextual contact is not currently available.",
        sla,
      };
    }
    const claimState = {
      claim: true,
      organizationId: input.organizationId,
      caseId: input.caseId,
      requestId: input.requestId,
      action: input.action,
      scenario: input.scenario,
      goal,
      actorId: input.actorId ?? null,
      slaActionId: sla?.id ?? null,
      expectedSnapshotRevision: expectedSnapshotRevision(input.context) ?? null,
      snapshotRevision: sla?.snapshotRevision ?? null,
      dueAt: parseDate(sla?.dueAt)?.toISOString() ?? null,
      actionStatus: sla?.status ?? null,
      candidateRelevant: sla?.candidateRelevant,
      gateAComplete: option.gate.gateAComplete,
      recipient: option.recipient,
      deliveryKey: `contextual-contact:${input.requestId}:delivery`,
      dispatchState: "queued" as const,
    };
    const claimed = await claimRequest(tx, input, goal, option, sla);
    if (claimed === "duplicate") {
      const prior = await requestAlreadyClaimed(input, tx);
      if (!prior) {
        throw new ContextualContactError(
          "claim_disappeared",
          "The contextual contact claim could not be read after conflict.",
          409,
        );
      }
      return { kind: "duplicate", claim: prior };
    }
    // `claimRequest` serializes the durable detail.  Keep this local copy so
    // dispatch revalidation can use the exact context that won the claim.
    return {
      kind: "claimed",
      caseRow: c,
      goal,
      option,
      context,
      sla,
      claim: claimState,
    };
  });
}

export function validateContextualContactRequest(input: ContactRequest): void {
  if (!CONTACT_ACTIONS.includes(input.action)) {
    throw new ContextualContactError(
      "invalid_action",
      "action must be candidate-email, owner-email, backup-email, or candidate-call.",
    );
  }
  if (!["day-before", "sla-escalation"].includes(input.scenario)) {
    throw new ContextualContactError(
      "invalid_scenario",
      "scenario must be day-before or sla-escalation.",
    );
  }
  const expectedRevision = expectedSnapshotRevision(input.context);
  if (input.scenario === "sla-escalation" && expectedRevision === undefined) {
    throw new ContextualContactError(
      "snapshot_revision_required",
      "expectedSnapshotRevision is required for every SLA escalation contact.",
      409,
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.requestId,
    )
  ) {
    throw new ContextualContactError(
      "invalid_request_id",
      "requestId must be a UUID.",
    );
  }
  if (input.simulate !== undefined && typeof input.simulate !== "boolean") {
    throw new ContextualContactError(
      "invalid_simulate",
      "simulate must be a boolean when provided.",
    );
  }
  if (input.action === "candidate-email") {
    if (
      input.body !== undefined &&
      (typeof input.body !== "string" ||
        input.body.trim().length < CONTEXTUAL_CONTACT_BODY_MIN ||
        input.body.length > CONTEXTUAL_CONTACT_BODY_MAX)
    ) {
      throw new ContextualContactError(
        "invalid_body",
        `Candidate email body must be between ${CONTEXTUAL_CONTACT_BODY_MIN} and ${CONTEXTUAL_CONTACT_BODY_MAX} characters.`,
      );
    }
    if (
      input.subject !== undefined &&
      (typeof input.subject !== "string" ||
        input.subject.trim().length < 1 ||
        input.subject.length > CONTEXTUAL_CONTACT_SUBJECT_MAX)
    ) {
      throw new ContextualContactError(
        "invalid_subject",
        `Candidate email subject must be between 1 and ${CONTEXTUAL_CONTACT_SUBJECT_MAX} characters.`,
      );
    }
  } else if (input.body !== undefined || input.subject !== undefined) {
    throw new ContextualContactError(
      "recipient_or_content_override",
      "Only candidate-email may edit subject or body.",
    );
  }
  const forbidden = input as unknown as Record<string, unknown>;
  for (const key of [
    "to",
    "recipient",
    "ownerEmail",
    "backupEmail",
    "recipientEmail",
    "phone",
  ]) {
    if (forbidden[key] !== undefined) {
      throw new ContextualContactError(
        "recipient_override_forbidden",
        "Recipients are selected from the case and action policy.",
      );
    }
  }
  if (input.goal !== undefined && typeof input.goal !== "string") {
    throw new ContextualContactError(
      "invalid_goal",
      "goal must be a string when provided.",
    );
  }
  if (
    input.context?.goal !== undefined &&
    typeof input.context.goal !== "string"
  ) {
    throw new ContextualContactError(
      "invalid_goal",
      "context.goal must be a string when provided.",
    );
  }
  if (
    expectedRevision !== undefined &&
    typeof expectedRevision !== "string" &&
    typeof expectedRevision !== "number"
  ) {
    throw new ContextualContactError(
      "invalid_snapshot_revision",
      "context.expectedSnapshotRevision must be a string or number.",
    );
  }
  if (
    expectedRevision !== undefined &&
    String(expectedRevision).length > CONTEXTUAL_CONTACT_REVISION_MAX
  ) {
    throw new ContextualContactError(
      "invalid_snapshot_revision",
      `context.expectedSnapshotRevision must be at most ${CONTEXTUAL_CONTACT_REVISION_MAX} characters.`,
    );
  }
  normalizeGoal(input.goal ?? input.context?.goal);
}

export async function sendOnboardingContextualContact(
  input: ContactRequest,
): Promise<ContactDeliveryResult> {
  validateContextualContactRequest(input);
  const prepared = await prepareContactRequest(input);
  if (prepared.kind === "duplicate") {
    return duplicateResult(
      input,
      prepared.claim,
      await persistedDispatchState(input, prepared.claim),
    );
  }
  if (prepared.kind === "withheld") {
    const { caseRow: c, option, reason, sla } = prepared;
    await logEvent(
      c.id,
      "channel",
      "rules",
      "Contextual contact withheld",
      `${reason} Actor: ${input.actorId ?? "unknown"}.`,
      {
        hitlPattern: "approve-before-act",
        ruleRef: "4.6 Communications Rules",
        idempotencyKey: `contextual-contact:${input.requestId}:withheld`,
      },
    );
    return {
      operationId: "sendOnboardingContextualContact",
      requestId: input.requestId,
      action: input.action,
      scenario: input.scenario,
      status: "withheld",
      delivery: "withheld",
      withheldReason: reason,
      failureReason: reason,
      audience: option.audience,
      recipient: option.recipient,
      slaActionId: sla?.id ?? null,
    };
  }
  const { caseRow: c, goal, option, sla, claim } = prepared;
  if (isSyntheticOfflineCase(c)) {
    return {
      operationId: "sendOnboardingContextualContact",
      requestId: input.requestId,
      action: input.action,
      scenario: input.scenario,
      status: "withheld",
      delivery: "withheld",
      withheldReason: SYNTHETIC_OFFLINE_WARNING,
      failureReason: SYNTHETIC_OFFLINE_WARNING,
      audience: option.audience,
      recipient: null,
      slaActionId: sla?.id ?? null,
    };
  }
  await revalidateClaimBeforeDispatch(input, claim);

  let result: ContactDeliveryResult;
  if (input.action === "candidate-email") {
    const subject =
      input.subject?.trim() || defaultCandidateSubject(input.scenario);
    const body =
      input.body?.trim() || defaultCandidateBody(c, input.scenario, goal);
    const sent = await sendOutbound({
      caseId: c.id,
      channel: "email",
      toAddress: c.workerEmail,
      subject,
      body,
      idempotencyKey: `contextual-contact:${input.requestId}:delivery`,
    });
    result = {
      operationId: "sendOnboardingContextualContact",
      requestId: input.requestId,
      action: input.action,
      scenario: input.scenario,
      status: sent.status,
      delivery:
        sent.status === "sent"
          ? "sent"
          : sent.status === "logged-only"
            ? "logged-only"
            : sent.status === "sending"
              ? sent.failureReason?.toLowerCase().includes("unknown")
                ? "unknown"
                : "sending"
              : "failed",
      communicationId: sent.id,
      failureReason: sent.failureReason,
      audience: option.audience,
      recipient: option.recipient,
      slaActionId: sla?.id ?? null,
    };
  } else if (
    input.action === "owner-email" ||
    input.action === "backup-email"
  ) {
    const configuredRecipient =
      input.action === "owner-email"
        ? sla?.ownerEmail ||
          (
            await getSetting(input.organizationId, HR_APPROVER_EMAIL_KEY)
          )?.trim()
        : sla?.backupEmail || (await hrAlertAddress(input.organizationId));
    // A future action provider may supply policy recipients.  The setting
    // fallback is also policy-owned; neither path accepts caller addresses.
    if (!configuredRecipient || !isValidEmail(configuredRecipient)) {
      throw new ContextualContactError(
        "recipient_policy_missing",
        "The action policy has no valid administrative recipient.",
        409,
      );
    }
    const sent = await sendAdministrativeEmail({
      caseId: c.id,
      toAddress: configuredRecipient,
      subject: defaultAdministrativeSubject(input.action, input.scenario),
      body: defaultAdministrativeBody(
        c,
        input.scenario,
        input.action,
        goal,
        sla,
      ),
      idempotencyKey: `contextual-contact:${input.requestId}:delivery`,
    });
    result = {
      operationId: "sendOnboardingContextualContact",
      requestId: input.requestId,
      action: input.action,
      scenario: input.scenario,
      status: sent.status,
      delivery:
        sent.status === "sent"
          ? "sent"
          : sent.status === "logged-only"
            ? "logged-only"
            : sent.status === "sending"
              ? sent.failureReason?.toLowerCase().includes("unknown")
                ? "unknown"
                : "sending"
              : "failed",
      communicationId: sent.id,
      failureReason: sent.failureReason,
      audience: option.audience,
      recipient: option.recipient,
      slaActionId: sla?.id ?? null,
    };
  } else {
    const simulate = input.simulate !== false;
    const voice = simulate
      ? {
          status: "simulated" as const,
          note: `Simulated call completed for ${c.workerName}.`,
          token: undefined,
          result: await simulateVoiceCall(c.id, input.scenario, goal),
        }
      : await startVoiceCall({
          caseId: c.id,
          scenario: input.scenario,
          reason: goal,
          goal,
        });
    result = {
      operationId: "sendOnboardingContextualContact",
      requestId: input.requestId,
      action: input.action,
      scenario: input.scenario,
      status: voice.status,
      delivery: simulate
        ? "simulated"
        : voice.status === "calling"
          ? "calling"
          : voice.status === "logged-only"
            ? "logged-only"
            : "failed",
      voiceToken: "token" in voice ? voice.token : undefined,
      failureReason: !simulate && voice.status === "failed" ? voice.note : null,
      audience: option.audience,
      recipient: option.recipient,
      slaActionId: sla?.id ?? null,
    };
  }
  const claimState: ContactDispatchState =
    result.delivery === "unknown"
      ? "unknown"
      : result.delivery === "sending" || result.status === "sending"
        ? "sending"
        : result.delivery === "sent" ||
            result.delivery === "calling" ||
            result.delivery === "simulated"
          ? "sent"
          : result.delivery === "logged-only"
            ? "logged-only"
            : "failed";
  await markClaimState(input, claimState, result.failureReason);
  await logEvent(
    c.id,
    "channel",
    "rules",
    "Contextual contact delivery recorded",
    [
      `Action: ${input.action}.`,
      `Audience: ${result.audience}.`,
      `Actor: ${input.actorId ?? "unknown"}.`,
      `Delivery: ${result.delivery}.`,
      result.failureReason
        ? `Reason: ${result.failureReason}`
        : "No delivery error was reported.",
      "No employment status or onboarding gate was changed.",
    ].join(" "),
    {
      hitlPattern:
        result.delivery === "sent" ||
        result.delivery === "calling" ||
        result.delivery === "simulated"
          ? "act-then-review"
          : "approve-before-act",
      ruleRef: "4.6 Communications Rules",
      idempotencyKey: `contextual-contact:${input.requestId}:result`,
    },
  );
  return result;
}

/** Useful for route tests and the SLA route's app-level adapter wiring. */
export function contextualContactActionResolver(
  app: { get(name: string): unknown } | undefined,
): ContextualSlaActionResolver | undefined {
  const candidate = app?.get("onboardingSlaActionResolver");
  return typeof candidate === "function"
    ? (candidate as ContextualSlaActionResolver)
    : undefined;
}

/** Exported pure helpers for contract tests. */
export const contextualContactInternals = {
  actionContextMatches,
  candidateDocsGoal,
  classifyPersistedDispatchState,
  docsAction,
  maskEmail,
  maskPhone,
  normalizeRevision,
  defaultCandidateBody,
};
