import { Router, type IRouter, type Request, type Response } from "express";
import {
  ContextualContactError,
  contextualContactActionResolver,
  getOnboardingContactOptions,
  sendOnboardingContextualContact,
  type ContactAction,
  type ContactRequestContext,
  type ContactScenario,
} from "../lib/onboarding/contextual-contact";
import { getOrganizationId } from "../lib/organization-scope";

const router: IRouter = Router();

function invalid(res: Response, message: string): void {
  res.status(400).json({ message, code: "INVALID_REQUEST" });
}

function caseIdParam(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    invalid(res, "Case id must be a positive integer.");
    return null;
  }
  return id;
}

function handleError(
  err: unknown,
  res: Response,
  next: (error?: unknown) => void,
): void {
  if (err instanceof ContextualContactError) {
    res.status(err.status).json({
      message: err.message,
      code: err.code,
      ...(err.details ?? {}),
    });
    return;
  }
  next(err);
}

function resolverFor(req: Request) {
  return contextualContactActionResolver(req.app);
}

/**
 * operationId: getOnboardingContactOptions
 *
 * A tenant member may inspect this list.  Addresses are always masked and
 * audience labels are explicit so the UI cannot confuse a candidate route
 * with an owner/backup escalation route.
 */
router.get("/onboarding/cases/:id/contact-options", async (req, res, next) => {
  const caseId = caseIdParam(req, res);
  if (caseId === null) return;
  try {
    const scenario =
      req.query.scenario === undefined
        ? undefined
        : (req.query.scenario as ContactScenario);
    const goal =
      typeof req.query.goal === "string" ? req.query.goal : undefined;
    const slaActionId =
      typeof req.query.slaActionId === "string"
        ? req.query.slaActionId
        : undefined;
    const currentSnapshotRevision =
      typeof req.query.currentSnapshotRevision === "string"
        ? req.query.currentSnapshotRevision
        : undefined;
    const expectedSnapshotRevision =
      typeof req.query.expectedSnapshotRevision === "string"
        ? req.query.expectedSnapshotRevision
        : undefined;
    const options = await getOnboardingContactOptions({
      caseId,
      organizationId: getOrganizationId(req),
      scenario,
      goal,
      slaActionId,
      context:
        currentSnapshotRevision === undefined &&
        expectedSnapshotRevision === undefined
          ? undefined
          : { currentSnapshotRevision, expectedSnapshotRevision },
      actionResolver: resolverFor(req),
    });
    res.json(options);
  } catch (err) {
    handleError(err, res, next);
  }
});

function ownerOrAdmin(req: Request, res: Response): boolean {
  if (req.organizationRole === "owner" || req.organizationRole === "admin")
    return true;
  res.status(403).json({
    message:
      "Organization owner or admin role required to send contextual contact.",
    code: "ROLE_REQUIRED",
  });
  return false;
}

/**
 * operationId: sendOnboardingContextualContact
 *
 * Sending is intentionally narrower than inspection: only owners/admins may
 * dispatch, requestId is a required UUID, and recipient fields are rejected
 * rather than silently ignored.
 */
router.post("/onboarding/cases/:id/contact", async (req, res, next) => {
  const caseId = caseIdParam(req, res);
  if (caseId === null || !ownerOrAdmin(req, res)) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action as ContactAction;
    const scenario = body.scenario as ContactScenario;
    const requestId = body.requestId;
    if (typeof requestId !== "string") {
      invalid(res, "requestId is required and must be a UUID.");
      return;
    }
    if (
      body.context !== undefined &&
      (typeof body.context !== "object" ||
        body.context === null ||
        Array.isArray(body.context))
    ) {
      invalid(res, "context must be an object when provided.");
      return;
    }
    const rawContext = body.context as Record<string, unknown> | undefined;
    const topLevelExpectedSnapshotRevision =
      typeof body.expectedSnapshotRevision === "string" ||
      typeof body.expectedSnapshotRevision === "number"
        ? body.expectedSnapshotRevision
        : undefined;
    const context: ContactRequestContext | undefined = rawContext
      ? {
          currentSnapshotRevision:
            typeof rawContext.currentSnapshotRevision === "string" ||
            typeof rawContext.currentSnapshotRevision === "number"
              ? rawContext.currentSnapshotRevision
              : undefined,
          expectedSnapshotRevision:
            typeof rawContext.expectedSnapshotRevision === "string" ||
            typeof rawContext.expectedSnapshotRevision === "number"
              ? rawContext.expectedSnapshotRevision
              : topLevelExpectedSnapshotRevision,
          goal:
            typeof rawContext.goal === "string" ? rawContext.goal : undefined,
        }
      : topLevelExpectedSnapshotRevision === undefined
        ? undefined
        : { expectedSnapshotRevision: topLevelExpectedSnapshotRevision };
    const result = await sendOnboardingContextualContact({
      caseId,
      organizationId: getOrganizationId(req),
      action,
      scenario,
      requestId,
      simulate:
        body.simulate === undefined ? undefined : (body.simulate as boolean),
      subject: body.subject as string | undefined,
      body: body.body as string | undefined,
      goal: body.goal as string | undefined,
      slaActionId: body.slaActionId as string | undefined,
      context,
      actorId: req.authUserId ?? null,
      actionResolver: resolverFor(req),
    });
    res.status(result.delivery === "duplicate" ? 200 : 201).json(result);
  } catch (err) {
    handleError(err, res, next);
  }
});

export default router;
