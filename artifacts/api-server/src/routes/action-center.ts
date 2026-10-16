import { Router, type IRouter, type Response } from "express";
import {
  AssignOnboardingActionCenterWorkBody,
  EscalateOnboardingActionCenterWorkBody,
  GetOnboardingActionCenterQueryParams,
  GetOnboardingActionCenterResponse,
  GetOnboardingActionCenterIdentitiesResponse,
  RecordOnboardingActionCenterCallOutcomeBody,
  RecordOnboardingActionCenterCallOutcomeResponse,
  RemindOnboardingActionCenterDocumentBody,
  RemindOnboardingActionCenterDocumentResponse,
  UpdateOnboardingActionCenterIdentitiesBody,
  UpdateOnboardingActionCenterIdentitiesResponse,
  ReassignOnboardingActionCenterWorkBody,
  ReassignOnboardingActionCenterWorkResponse,
  ResolveOnboardingActionCenterWorkBody,
  ResolveOnboardingActionCenterWorkResponse,
} from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import { resolveEffectiveAccess } from "../lib/access-governance";
import { resolveReviewerName } from "../middlewares/require-auth";
import {
  ActionCenterConflictError,
  ActionCenterNotFoundError,
  ActionCenterOfflineError,
  ActionCenterPermissionError,
  assertActionCenterMutationAuthorized,
  getActionCenter,
  recordDocumentReminder,
  recordManualCallOutcome,
  recordWorkItem,
  type ActionCenterAccess,
} from "../lib/onboarding/action-center";
import {
  canEditActionCenterIdentities,
  getActionCenterIdentities,
  ActionCenterIdentityConflictError,
  ActionCenterIdentityValidationError,
  updateActionCenterIdentities,
} from "../lib/onboarding/action-center-identities";
import {
  hasSensitiveAccess,
  hasOpaqueNarrativeAccess,
  resolveSensitiveAccess,
  SensitiveAuthorityRequiredError,
  sensitiveClassForDocument,
  type SensitiveAccess,
} from "../lib/onboarding/sensitive-access";
import { registeredDemoProfile } from "../lib/demo-principal";
import { separationActionCenter } from "../lib/offboarding/action-center";
import { SeparationError } from "../lib/offboarding/model";
import { parseActionCenterQuery } from "../lib/onboarding/action-center-query";

const router: IRouter = Router();

async function actionCenterAccess(
  userId: string,
): Promise<ActionCenterAccess | "denied"> {
  const profile = await registeredDemoProfile(userId);
  if (profile === "administrator") return "synthetic-demo-simulation";
  if (profile === "reviewer") return "denied";
  return "standard";
}

async function requireCaseEditAccess(
  organizationId: string,
  actorUserId: string,
  caseId: number,
  res: Response,
  requiresNotes: boolean,
): Promise<boolean> {
  const effective = await resolveEffectiveAccess({
    organizationId,
    principalType: "human",
    principalId: actorUserId,
    caseId,
    purpose: "onboarding-action-center-mutation",
  });
  if (
    !effective.allows.includes("flow.case.edit") ||
    (requiresNotes && !effective.allows.includes("data.case.notes.edit"))
  ) {
    res.status(403).json({
      message: requiresNotes
        ? "Explicit case-flow edit and case-notes edit grants are required for this action."
        : "Explicit case-flow edit access is required for this action.",
      code: "CASE_EDIT_ACCESS_REQUIRED",
    });
    return false;
  }
  return true;
}

router.use("/onboarding/action-center/actions", async (req, res, next) => {
  try {
    if (await actionCenterAccess(req.authUserId!) === "denied") {
      res.status(403).json({
        message: "The Demo Reviewer cannot mutate Action Center records.",
        code: "DEMO_ACCOUNT_PRIVILEGE_CEILING",
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * Action Center is a derived surface, not an entitlement shortcut.  Its
 * source rows include free-form action/approval/communication text, so this
 * projection intentionally retains only typed operational state for callers
 * without a live specialist assignment.
 */
async function sensitiveActionCenterProjection(
  organizationId: string,
  actorUserId: string | undefined,
  result: Awaited<ReturnType<typeof getActionCenter>> & {
    domainRecords?: Awaited<ReturnType<typeof separationActionCenter>>["domainRecords"];
  },
  access: ActionCenterAccess = "standard",
) {
  const accessByCase = new Map<number, SensitiveAccess>();
  const caseAccessByCase = new Map<number, {
    flowRead: boolean;
    profileRead: boolean;
    notesRead: boolean;
  }>();
  const accessFor = async (caseId: number) => {
    const cached = accessByCase.get(caseId);
    if (cached) return cached;
    const access = await resolveSensitiveAccess({ organizationId, caseId, actorUserId });
    accessByCase.set(caseId, access);
    return access;
  };
  const caseAccessFor = async (caseId: number) => {
    const cached = caseAccessByCase.get(caseId);
    if (cached) return cached;
    const effective = await resolveEffectiveAccess({
      organizationId,
      principalType: "human",
      principalId: actorUserId ?? "",
      caseId,
      purpose: "onboarding-action-center",
    });
    const caseAccess = {
      flowRead: effective.allows.includes("flow.case.read"),
      profileRead: effective.allows.includes("data.case.profile.read"),
      notesRead: effective.allows.includes("data.case.notes.read"),
    };
    caseAccessByCase.set(caseId, caseAccess);
    return caseAccess;
  };
  const safeClassification = (classification: {
    label: string;
    source: string;
    confidence: string;
    rationale: string;
    correction?: { label: string };
  } | null, access: SensitiveAccess) => {
    if (!classification || hasOpaqueNarrativeAccess(access)) return classification;
    return {
      label: classification.label,
      source: classification.source,
      confidence: classification.confidence,
      rationale: "Restricted confidential workforce-classification rationale.",
      ...(classification.correction ? { correction: { label: classification.correction.label } } : {}),
    };
  };
  const safeCase = async <T extends {
    workerName: string;
    workerEmail: string;
    workforceClassification: {
      label: string;
      source: string;
      confidence: string;
      rationale: string;
      correction?: { label: string };
    } | null;
  }>(entry: T, caseId: number) => {
    const [access, caseAccess] = await Promise.all([accessFor(caseId), caseAccessFor(caseId)]);
    return access.identity && caseAccess.profileRead && caseAccess.flowRead
      ? { ...entry, workforceClassification: safeClassification(entry.workforceClassification, access) }
      : {
          ...entry,
          workerName: "Restricted candidate",
          workerEmail: "restricted",
          role: "Restricted case profile",
          joiningDate: "Restricted",
          siteExposure: false,
          safetyCritical: false,
          // Classification rationale is server-derived free text, not a
          // general Action Center entitlement.
          workforceClassification: null,
        };
  };
  const visibleCaseItems = async <T>(items: T[]): Promise<T[]> => {
    const visible: T[] = [];
    for (const item of items) {
      const caseId = (item as { caseId?: unknown }).caseId;
      if (typeof caseId === "number" && (await caseAccessFor(caseId)).flowRead) {
        visible.push(item);
      }
    }
    return visible;
  };
  const visibleDocuments = await visibleCaseItems(result.documentFollowups);
  const visibleApprovals = await visibleCaseItems(result.approvals);
  const visibleNotifications = await visibleCaseItems(result.notifications);
  const visibleWorkItems = await visibleCaseItems(result.workItems);
  const visibleCompleted = await visibleCaseItems(result.completed);
  const visibleOpportunities = await visibleCaseItems(result.opportunities);
  const caseSummaries = await visibleCaseItems(result.caseSummaries);
  const domainRecords = await visibleCaseItems(result.domainRecords ?? []);
  const documentFollowups = await Promise.all(visibleDocuments.map(async (item) => {
    const access = await accessFor(item.caseId);
    const { category, ...publicItem } = item;
    const classes = sensitiveClassForDocument({ key: item.key, label: item.label, category });
    if (hasSensitiveAccess(access, classes)) return { ...publicItem, case: await safeCase(item.case, item.caseId) };
    return {
      ...publicItem,
      key: "restricted",
      label: "Restricted document",
      validationState: "restricted",
      action: "remind" as const,
      eligibleForReminder: false,
      capabilities: { canRemind: false },
      case: await safeCase(item.case, item.caseId),
    };
  }));
  const approvals = await Promise.all(visibleApprovals.map(async (item) => {
    const [sensitive, fields] = await Promise.all([accessFor(item.caseId), caseAccessFor(item.caseId)]);
    const narrative = fields.notesRead && fields.profileRead && hasOpaqueNarrativeAccess(sensitive);
    return { ...item,
    // Approval recommendation/rationale are opaque free text. Do not pass
    // them through a list/dashboard merely because their wording had no
    // classifier hit.
    ruleRef: narrative ? item.ruleRef : "restricted-sensitive-approval",
    recommendation: narrative ? item.recommendation : "Restricted approval pending or recorded.",
    rationale: narrative ? item.rationale : "Approval details are restricted.",
    case: await safeCase(item.case, item.caseId),
  }; }));
  const notifications = await Promise.all(visibleNotifications.map(async item => {
    const [sensitive, fields] = await Promise.all([accessFor(item.caseId), caseAccessFor(item.caseId)]);
    const narrative = fields.notesRead && fields.profileRead && hasOpaqueNarrativeAccess(sensitive);
    const label = item.source === "persisted-communication" ? "Communication" :
      item.source === "recorded-system-check" ? "Operational check" : "Operational event";
    return { ...item,
      title: narrative ? item.title : `${label} recorded`,
      detail: narrative ? item.detail : `Recorded state: ${item.status}.`,
      recipient: narrative && sensitive.identity ? item.recipient : "Restricted",
      // A message's actor line is opaque text, independently requiring notes.
      initiator: narrative && fields.notesRead ? item.initiator : "Restricted",
    };
  }));
  const workItems = await Promise.all(visibleWorkItems.map(async item => {
    const [sensitive, fields] = await Promise.all([accessFor(item.caseId), caseAccessFor(item.caseId)]);
    const narrative = fields.notesRead && fields.profileRead && hasOpaqueNarrativeAccess(sensitive);
    return { ...item, owner: narrative ? item.owner : null, assignee: narrative ? item.assignee : null,
      reason: narrative ? item.reason : null, actor: narrative ? item.actor : "Restricted" };
  }));
  const completed = await Promise.all(visibleCompleted.map(async item => {
    const [sensitive, fields] = await Promise.all([accessFor(item.caseId), caseAccessFor(item.caseId)]);
    const narrative = fields.notesRead && fields.profileRead && hasOpaqueNarrativeAccess(sensitive);
    return { ...item, summary: narrative ? item.summary : "Restricted action recorded.",
      actor: narrative ? item.actor : "Restricted" };
  }));
  const opportunities = visibleOpportunities.map((item) => ({
    id: item.id,
    caseId: item.caseId,
    actionVersion: item.actionVersion,
    kind: item.kind,
    priority: item.priority,
    title: item.kind === "bgv-checkpoint"
      ? "Background-verification clearance checkpoint"
      : "Restricted onboarding checkpoint",
    description: item.kind === "bgv-checkpoint"
      ? "A recorded BGV clearance state requires attention."
      : "Operational checkpoint requires attention; details are restricted.",
    benefit: {
      type: "mandatory-checkpoint" as const,
      checkpoint: item.kind === "bgv-checkpoint" ? "background-verification" : "restricted",
      delta: null,
    },
    evidence: { source: "restricted-operational-state" },
    capabilities: {
      canAct: access === "synthetic-demo-simulation" &&
        (item.capabilities as { canAct?: unknown } | undefined)?.canAct === true,
    },
    caseHref: item.caseHref,
  }));
  return {
    ...result,
    counts: {
      pendingApprovals: approvals.filter((item) => item.status === "pending").length,
      notifications: notifications.length,
      missingDocuments: documentFollowups.length,
      openWorkItems: workItems.length,
      completed: completed.length,
      opportunities: opportunities.length,
    },
    approvals,
    notifications,
    documentFollowups,
    workItems,
    completed,
    opportunities,
    caseSummaries: caseSummaries.filter(s => s.caseType !== "Offboarding" || caseAccessByCase.get(s.caseId)?.profileRead),
    domainRecords: domainRecords.filter(s => caseAccessByCase.get(s.caseId)?.profileRead),
  };
}

function clientError(error: unknown, res: Response): boolean {
  if (error instanceof SensitiveAuthorityRequiredError) {
    res.status(403).json({
      message: "Current case-scoped decision, flow and sensitive-field permissions are required for this action.",
      code: "SENSITIVE_RECORD_ACCESS_REQUIRED",
    });
    return true;
  }
  if (error instanceof ActionCenterNotFoundError || /case or document not found|case not found/i.test(String((error as Error).message))) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Action Center record not found." });
    return true;
  }
  if (error instanceof ActionCenterPermissionError || /authorization|authorized|permission|simulation is only/i.test(String((error as Error).message))) {
    res.status(403).json({ message: error instanceof Error ? error.message : "Action Center permission denied." });
    return true;
  }
  if (error instanceof ActionCenterIdentityValidationError || (error instanceof Error && error.name === "ZodError")) {
    res.status(400).json({ message: error.message });
    return true;
  }
  if (error instanceof ActionCenterIdentityConflictError) {
    res.status(409).json({ message: error.message });
    return true;
  }
  if (
    error instanceof ActionCenterConflictError ||
    error instanceof ActionCenterOfflineError ||
    /not due|no longer needs|paused offline|changed since|already used/i.test(String((error as Error).message))
  ) {
    res.status(409).json({ message: error instanceof Error ? error.message : "Action Center action conflicts with current evidence." });
    return true;
  }
  return false;
}

router.get("/onboarding/action-center", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const access = await actionCenterAccess(req.authUserId!);
    if (access === "denied") {
      res.status(403).json({
        message: "Action Center is unavailable to the read-only Demo Reviewer.",
        code: "DEMO_ACCOUNT_PRIVILEGE_CEILING",
      });
      return;
    }
    const parsed = parseActionCenterQuery(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.message });
      return;
    }
    const organizationId = getOrganizationId(req);
    const result = await getActionCenter(
      organizationId,
      parsed.data.scope,
      parsed.data.limit,
      {
        caseType: parsed.data.caseType,
        workforce: parsed.data.workforce,
        safetyCritical: parsed.data.safetyCritical,
        siteExposure: parsed.data.siteExposure,
      },
      access,
      req.authUserId,
    );
    // A separate-store outage must not suppress authorized onboarding work.
    // Denied/restricted coverage is explicitly distinct from a zero queue.
    const domain = await separationActionCenter(organizationId, req.authUserId!, parsed.data).catch(error => {
      req.log?.warn({ source: "offboarding", denied: error instanceof SeparationError && error.status === 403 },
        "Action Center source unavailable");
      return { caseSummaries: [], domainRecords: [],
        offboardingSource: error instanceof SeparationError && error.status === 403
          ? "denied" as const : "unavailable" as const };
    });
    const unified = { ...result, domainRecords: domain.domainRecords,
      offboardingSource: domain.offboardingSource,
      caseSummaries: [...result.caseSummaries, ...domain.caseSummaries] };
    res.json(GetOnboardingActionCenterResponse.parse(
      await sensitiveActionCenterProjection(organizationId, req.authUserId, unified, access),
    ));
  } catch (error) {
    if (error instanceof SeparationError) {
      res.status(error.status).json({ message: error.status === 403
        ? "Offboarding source access was denied." : "Offboarding records could not be loaded." });
      return;
    }
    if (clientError(error, res)) return;
    next(error);
  }
});

router.get("/onboarding/action-center/identities", async (req, res, next) => {
  try {
    const result = await getActionCenterIdentities(getOrganizationId(req));
    res.json(GetOnboardingActionCenterIdentitiesResponse.parse(result));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.put("/onboarding/action-center/identities", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!canEditActionCenterIdentities(organizationId, req.organizationRole)) {
      res.status(403).json({
        message: "Organization owner or admin role required to edit named stakeholder identities.",
      });
      return;
    }
    const body = UpdateOnboardingActionCenterIdentitiesBody.parse(req.body);
    const result = await updateActionCenterIdentities({
      organizationId,
      expectedVersion: body.version,
      identities: body.identities,
    });
    res.json(UpdateOnboardingActionCenterIdentitiesResponse.parse(result));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/action-center/actions/manual-call-outcome", async (req, res, next) => {
  try {
    const body = RecordOnboardingActionCenterCallOutcomeBody.parse(req.body);
    const access = await actionCenterAccess(req.authUserId!);
    assertActionCenterMutationAuthorized(
      getOrganizationId(req),
      req.organizationRole,
      undefined,
      access === "denied" ? "standard" : access,
    );
    if (!await requireCaseEditAccess(
      getOrganizationId(req),
      req.authUserId!,
      body.caseId,
      res,
      Boolean(body.notes?.trim()),
    )) return;
    const result = await recordManualCallOutcome({
      organizationId: getOrganizationId(req),
      actorUserId: req.authUserId!,
      actorName: await resolveReviewerName(req.authUserId!),
      organizationRole: req.organizationRole,
      requestId: body.requestId,
      caseId: body.caseId,
      outcome: body.outcome,
      notes: body.notes ?? null,
      persona: body.persona ?? null,
      selfReported: true,
      access: access === "denied" ? "standard" : access,
    });
    res.json(RecordOnboardingActionCenterCallOutcomeResponse.parse(result));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/action-center/actions/remind-document", async (req, res, next) => {
  try {
    const body = RemindOnboardingActionCenterDocumentBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    const access = await actionCenterAccess(req.authUserId!);
    if (access === "synthetic-demo-simulation") {
      throw new ActionCenterPermissionError(
        "Document reminders are not a supported public Demo simulation action.",
      );
    }
    assertActionCenterMutationAuthorized(organizationId, req.organizationRole, body.mode);
    if (!await requireCaseEditAccess(organizationId, req.authUserId!, body.caseId, res, false)) return;
    const result = await recordDocumentReminder({
      organizationId,
      actorUserId: req.authUserId!,
      actorName: await resolveReviewerName(req.authUserId!),
      organizationRole: req.organizationRole,
      requestId: body.requestId,
      caseId: body.caseId,
      documentId: body.documentId,
      mode: body.mode,
    });
    res.json(RemindOnboardingActionCenterDocumentResponse.parse(result));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/action-center/actions/assign", async (req, res, next) => {
  try {
    const body = AssignOnboardingActionCenterWorkBody.parse(req.body);
    const access = await actionCenterAccess(req.authUserId!);
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole, undefined, access === "denied" ? "standard" : access);
    if (!await requireCaseEditAccess(getOrganizationId(req), req.authUserId!, body.caseId, res, true)) return;
    const result = await recordWorkItem({
      organizationId: getOrganizationId(req),
      actorUserId: req.authUserId!,
      actorName: await resolveReviewerName(req.authUserId!),
      organizationRole: req.organizationRole,
      requestId: body.requestId,
      caseId: body.caseId,
      kind: "assign",
      owner: body.owner,
      assignee: body.assignee ?? null,
      reason: body.reason ?? null,
      expectedVersion: body.expectedVersion,
      access: access === "denied" ? "standard" : access,
    });
    res.json(result);
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/action-center/actions/escalate", async (req, res, next) => {
  try {
    const body = EscalateOnboardingActionCenterWorkBody.parse(req.body);
    const access = await actionCenterAccess(req.authUserId!);
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole, undefined, access === "denied" ? "standard" : access);
    if (!await requireCaseEditAccess(getOrganizationId(req), req.authUserId!, body.caseId, res, true)) return;
    const result = await recordWorkItem({
      organizationId: getOrganizationId(req),
      actorUserId: req.authUserId!,
      actorName: await resolveReviewerName(req.authUserId!),
      organizationRole: req.organizationRole,
      requestId: body.requestId,
      caseId: body.caseId,
      kind: "escalate",
      owner: body.owner,
      assignee: body.assignee ?? null,
      reason: body.reason ?? null,
      expectedVersion: body.expectedVersion,
      access: access === "denied" ? "standard" : access,
    });
    res.json(result);
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/action-center/actions/reassign", async (req, res, next) => {
  try {
    const body = ReassignOnboardingActionCenterWorkBody.parse(req.body);
    const access = await actionCenterAccess(req.authUserId!);
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole, undefined, access === "denied" ? "standard" : access);
    if (!await requireCaseEditAccess(getOrganizationId(req), req.authUserId!, body.caseId, res, true)) return;
    const result = await recordWorkItem({
      organizationId: getOrganizationId(req),
      actorUserId: req.authUserId!,
      actorName: await resolveReviewerName(req.authUserId!),
      organizationRole: req.organizationRole,
      requestId: body.requestId,
      caseId: body.caseId,
      kind: "reassign",
      owner: body.owner,
      assignee: body.assignee ?? null,
      reason: body.reason ?? null,
      expectedVersion: body.expectedVersion,
      targetActionId: body.workItemId,
      access: access === "denied" ? "standard" : access,
    });
    res.json(ReassignOnboardingActionCenterWorkResponse.parse(result));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/action-center/actions/resolve", async (req, res, next) => {
  try {
    const body = ResolveOnboardingActionCenterWorkBody.parse(req.body);
    const access = await actionCenterAccess(req.authUserId!);
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole, undefined, access === "denied" ? "standard" : access);
    if (!await requireCaseEditAccess(getOrganizationId(req), req.authUserId!, body.caseId, res, false)) return;
    const result = await recordWorkItem({
      organizationId: getOrganizationId(req),
      actorUserId: req.authUserId!,
      actorName: await resolveReviewerName(req.authUserId!),
      organizationRole: req.organizationRole,
      requestId: body.requestId,
      caseId: body.caseId,
      kind: "resolve",
      reason: null,
      expectedVersion: body.expectedVersion,
      targetActionId: body.workItemId,
      access: access === "denied" ? "standard" : access,
    });
    res.json(ResolveOnboardingActionCenterWorkResponse.parse(result));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

export default router;
