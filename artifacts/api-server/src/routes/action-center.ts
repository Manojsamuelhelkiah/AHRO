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

const router: IRouter = Router();

async function actionCenterAccess(
  userId: string,
): Promise<ActionCenterAccess | "denied"> {
  const profile = await registeredDemoProfile(userId);
  if (profile === "administrator") return "synthetic-demo-simulation";
  if (profile === "reviewer") return "denied";
  return "standard";
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
  result: Awaited<ReturnType<typeof getActionCenter>>,
  access: ActionCenterAccess = "standard",
) {
  const accessByCase = new Map<number, SensitiveAccess>();
  const accessFor = async (caseId: number) => {
    const cached = accessByCase.get(caseId);
    if (cached) return cached;
    const access = await resolveSensitiveAccess({ organizationId, caseId, actorUserId });
    accessByCase.set(caseId, access);
    return access;
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
    const access = await accessFor(caseId);
    return access.identity
      ? { ...entry, workforceClassification: safeClassification(entry.workforceClassification, access) }
      : {
          ...entry,
          workerName: "Restricted candidate",
          workerEmail: "restricted",
          // Classification rationale is server-derived free text, not a
          // general Action Center entitlement.
          workforceClassification: null,
        };
  };
  const documentFollowups = await Promise.all(result.documentFollowups.map(async (item) => {
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
  const approvals = await Promise.all(result.approvals.map(async (item) => ({
    ...item,
    // Approval recommendation/rationale are opaque free text. Do not pass
    // them through a list/dashboard merely because their wording had no
    // classifier hit.
    ruleRef: "restricted-sensitive-approval",
    recommendation: "Restricted specialist approval pending or recorded.",
    rationale: "Details are restricted to the assigned specialist.",
    case: await safeCase(item.case, item.caseId),
  })));
  const notifications = result.notifications.map((item) => ({
    ...item,
    // BGV clearance state is operationally visible; raw event/message text,
    // provider recipient, and actor identity are not.
    title: item.kind === "bgv"
      ? "Background-verification clearance needs attention"
      : "Restricted onboarding notification",
    detail: item.kind === "bgv"
      ? `Background-verification clearance state: ${item.status}.`
      : "Operational state recorded; details are restricted.",
    recipient: "Restricted",
    initiator: "Restricted",
  }));
  const workItems = result.workItems.map((item) => ({
    ...item,
    owner: null,
    assignee: null,
    reason: null,
    actor: "Restricted",
  }));
  const completed = result.completed.map((item) => ({
    ...item,
    summary: "Restricted onboarding action recorded.",
    actor: "Restricted",
  }));
  const opportunities = result.opportunities.map((item) => ({
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
    approvals,
    notifications,
    documentFollowups,
    workItems,
    completed,
    opportunities,
  };
}

function clientError(error: unknown, res: Response): boolean {
  if (error instanceof SensitiveAuthorityRequiredError) {
    res.status(403).json({
      message: "A current case-scoped specialist authority assignment is required for this sensitive action.",
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
    const access = await actionCenterAccess(req.authUserId!);
    if (access === "denied") {
      res.status(403).json({
        message: "Action Center is unavailable to the read-only Demo Reviewer.",
        code: "DEMO_ACCOUNT_PRIVILEGE_CEILING",
      });
      return;
    }
    const parsed = GetOnboardingActionCenterQueryParams.safeParse(req.query);
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
        workforce: parsed.data.workforce,
        safetyCritical: parsed.data.safetyCritical,
        siteExposure: parsed.data.siteExposure,
      },
      access,
    );
    res.json(GetOnboardingActionCenterResponse.parse(
      await sensitiveActionCenterProjection(organizationId, req.authUserId, result, access),
    ));
  } catch (error) {
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
