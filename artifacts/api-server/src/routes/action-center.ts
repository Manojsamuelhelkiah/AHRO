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
} from "../lib/onboarding/action-center";
import {
  canEditActionCenterIdentities,
  getActionCenterIdentities,
  ActionCenterIdentityConflictError,
  ActionCenterIdentityValidationError,
  updateActionCenterIdentities,
} from "../lib/onboarding/action-center-identities";

const router: IRouter = Router();

function clientError(error: unknown, res: Response): boolean {
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
    const parsed = GetOnboardingActionCenterQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.message });
      return;
    }
    const result = await getActionCenter(
      getOrganizationId(req),
      parsed.data.scope,
      parsed.data.limit,
    );
    res.json(GetOnboardingActionCenterResponse.parse(result));
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
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole);
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
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole, body.mode);
    const result = await recordDocumentReminder({
      organizationId: getOrganizationId(req),
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
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole);
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
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole);
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
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole);
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
    assertActionCenterMutationAuthorized(getOrganizationId(req), req.organizationRole);
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
    });
    res.json(ResolveOnboardingActionCenterWorkResponse.parse(result));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

export default router;
