import { Router, type IRouter, type Response } from "express";
import { getOrganizationId } from "../lib/organization-scope";
import {
  assignGovernanceAuthority,
  createGovernanceDecision,
  dispatchDueGovernanceReminders,
  getGovernanceDecisionHistory,
  GovernanceConflictError,
  GovernanceNotFoundError,
  GovernancePermissionError,
  GovernanceValidationError,
  isVerifiedGovernanceOperator,
  listGovernanceAssignments,
  listGovernanceDecisions,
  listGovernanceHistory,
  reviewGovernanceDecision,
  reconcileGovernanceDispatch,
  requestGovernanceAuthority,
  reviseGovernanceDecision,
  revokeGovernanceAuthority,
  verifyGovernanceAuthority,
} from "../lib/onboarding/governance";
import { GovernanceDispatchBlockedError } from "../lib/onboarding/governance-dispatch";

const router: IRouter = Router();
router.use((req, res, next) => {
  if (/^\/governance\/requirements(?:\/|$)/i.test(req.path)) {
    res.status(410).json({ code: "REQUIREMENTS_REGISTER_RETIRED", message: "The Requirements Register is retired. Historical records are retained and cannot be edited." });
    return;
  }
  if (/^\/governance\/(?:assignments|authority-bootstrap|authority-options)(?:\/|$)/i.test(req.path)) {
    res.status(410).json({ code: "SPECIALIST_AUTHORITY_RETIRED", message: "Specialist authority management is retired. Use ordinary access governance; historical records are retained." });
    return;
  }
  next();
});

function requestBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GovernanceValidationError("A JSON object request body is required.");
  }
  return value as Record<string, unknown>;
}

function actor(req: { authUserId?: string; organizationRole?: "owner" | "admin" | "member" }) {
  if (!req.authUserId) throw new GovernancePermissionError("Authentication required.");
  return { userId: req.authUserId, organizationRole: req.organizationRole };
}

function clientError(error: unknown, res: Response): boolean {
  if (error instanceof GovernanceValidationError) {
    res.status(400).json({ message: error.message });
    return true;
  }
  if (error instanceof GovernancePermissionError) {
    res.status(403).json({ message: error.message });
    return true;
  }
  if (error instanceof GovernanceNotFoundError) {
    res.status(404).json({ message: error.message });
    return true;
  }
  if (error instanceof GovernanceConflictError) {
    res.status(409).json({ message: error.message });
    return true;
  }
  if (error instanceof GovernanceDispatchBlockedError) {
    res.status(409).json({ message: error.message });
    return true;
  }
  return false;
}

function requireTenantEditor(role: string | undefined): void {
  if (role !== "owner" && role !== "admin") {
    throw new GovernancePermissionError("Organization owner or admin role required to dispatch tenant review reminders.");
  }
}

router.get("/governance/decisions", async (req, res, next) => {
  try {
    res.json({ decisions: await listGovernanceDecisions(getOrganizationId(req)) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/governance/decisions", async (req, res, next) => {
  try {
    const decision = await createGovernanceDecision(getOrganizationId(req), actor(req), requestBody(req.body));
    res.status(201).json({ decision });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.get("/governance/decisions/:key/history", async (req, res, next) => {
  try {
    res.json(await getGovernanceDecisionHistory(getOrganizationId(req), req.params.key));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/governance/decisions/:key/revisions", async (req, res, next) => {
  try {
    const decision = await reviseGovernanceDecision(
      getOrganizationId(req), actor(req), req.params.key, requestBody(req.body),
    );
    res.status(201).json({ decision });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/governance/decisions/:key/reviews", async (req, res, next) => {
  try {
    res.json(await reviewGovernanceDecision(
      getOrganizationId(req), actor(req), req.params.key, requestBody(req.body),
    ));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.get("/governance/assignments", async (req, res, next) => {
  try {
    res.json({ assignments: await listGovernanceAssignments(getOrganizationId(req)) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/governance/assignments", async (req, res, next) => {
  try {
    const body = requestBody(req.body);
    const currentActor = actor(req);
    const assignment = isVerifiedGovernanceOperator(currentActor.userId, getOrganizationId(req))
      ? await assignGovernanceAuthority(getOrganizationId(req), currentActor, body)
      : await requestGovernanceAuthority(getOrganizationId(req), currentActor, body);
    res.status(201).json({ assignment });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/governance/assignments/:id/verify", async (req, res, next) => {
  try {
    const body = requestBody(req.body);
    res.json({
      assignment: await verifyGovernanceAuthority(
        getOrganizationId(req), actor(req), req.params.id, body.verificationReference,
      ),
    });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

// An explicit name makes clear that this is a server-verified operator
// bootstrap, never a tenant-admin self-service specialist declaration.
router.post("/governance/authority-bootstrap", async (req, res, next) => {
  try {
    const assignment = await assignGovernanceAuthority(
      getOrganizationId(req), actor(req), requestBody(req.body),
    );
    res.status(201).json({ assignment });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/governance/assignments/:id/revoke", async (req, res, next) => {
  try {
    res.json({
      assignment: await revokeGovernanceAuthority(getOrganizationId(req), actor(req), req.params.id),
    });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/governance/dispatches/:dispatchId/reconcile", async (req, res, next) => {
  try {
    const body = requestBody(req.body);
    res.json({
      dispatch: await reconcileGovernanceDispatch(
        getOrganizationId(req), actor(req), req.params.dispatchId, body.reconciliationReference,
      ),
    });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.get("/governance/history", async (req, res, next) => {
  try {
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      throw new GovernanceValidationError("limit must be an integer from 1 to 250.");
    }
    res.json({ history: await listGovernanceHistory(getOrganizationId(req), limit) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/governance/reminders/dispatch", async (req, res, next) => {
  try {
    requireTenantEditor(req.organizationRole);
    res.json(await dispatchDueGovernanceReminders(getOrganizationId(req)));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

export default router;
