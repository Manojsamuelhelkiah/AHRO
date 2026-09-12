import { Router, type IRouter, type Request, type Response } from "express";
import { getOrganizationId } from "../lib/organization-scope";
import { isChecklistAdministrator } from "../lib/onboarding/checklist";
import {
  changeStandardOperationsStartDate,
  getStandardOperationsView,
  reconcileStandardOperationsStartDateImpact,
  setStandardOperationsManualFulfillment,
  setStandardOperationsException,
  StandardOperationsConflictError,
  StandardOperationsNotFoundError,
} from "../lib/onboarding/standard-operations";
import {
  parseResolveStandardOperationExceptionBody,
  parseManualFulfillmentBody,
  parseStartDateImpactReconciliationBody,
  parseStartDateImpactStream,
  parseSetStandardOperationExceptionBody,
  parseStandardOperationsStartDateBody,
  parseStandardOperationExceptionType,
  StandardOperationsValidationError,
} from "../lib/onboarding/standard-operations-schema";

const router: IRouter = Router();

function caseId(req: Request): number | null {
  const parsed = Number(req.params.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requireOperationsAdmin(req: Request, res: Response): boolean {
  if (isChecklistAdministrator(req.organizationRole)) return true;
  res.status(403).json({ message: "Organization owner or admin role required to manage standard-operations holds." });
  return false;
}

function sendError(error: unknown, res: Response): boolean {
  if (error instanceof StandardOperationsNotFoundError) {
    res.status(404).json({ message: error.message });
    return true;
  }
  if (error instanceof StandardOperationsConflictError) {
    res.status(409).json({ message: error.message });
    return true;
  }
  if (error instanceof StandardOperationsValidationError) {
    res.status(400).json({ message: error.message });
    return true;
  }
  return false;
}

router.get("/onboarding/cases/:id/standard-operations", async (req, res, next) => {
  try {
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    res.json(await getStandardOperationsView(getOrganizationId(req), id));
  } catch (error) {
    if (sendError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/cases/:id/standard-operations/exceptions", async (req, res, next) => {
  try {
    if (!requireOperationsAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = parseSetStandardOperationExceptionBody(req.body);
    res.json(await setStandardOperationsException({
      organizationId: getOrganizationId(req),
      caseId: id,
      type: body.type,
      expectedVersion: body.expectedVersion,
      actorUserId: req.authUserId!,
    }));
  } catch (error) {
    if (sendError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/cases/:id/standard-operations/exceptions/:type/resolve", async (req, res, next) => {
  try {
    if (!requireOperationsAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const type = parseStandardOperationExceptionType(req.params.type);
    const body = parseResolveStandardOperationExceptionBody(req.body);
    res.json(await setStandardOperationsException({
      organizationId: getOrganizationId(req),
      caseId: id,
      type,
      expectedVersion: body.expectedVersion,
      actorUserId: req.authUserId!,
      resolve: true,
    }));
  } catch (error) {
    if (sendError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/cases/:id/standard-operations/manual-fulfillment", async (req, res, next) => {
  try {
    if (!requireOperationsAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = parseManualFulfillmentBody(req.body);
    res.json(await setStandardOperationsManualFulfillment({
      organizationId: getOrganizationId(req),
      caseId: id,
      area: body.area,
      expectedVersion: body.expectedVersion,
      actorUserId: req.authUserId!,
      status: body.status,
      evidenceStatus: body.evidenceStatus,
      consentStatus: body.consentStatus,
      cutoffStatus: body.cutoffStatus,
      reconciliationStatus: body.reconciliationStatus,
      failureStatus: body.failureStatus,
    }));
  } catch (error) {
    if (sendError(error, res)) return;
    next(error);
  }
});

router.put("/onboarding/cases/:id/standard-operations/start-date", async (req, res, next) => {
  try {
    if (!requireOperationsAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = parseStandardOperationsStartDateBody(req.body);
    res.json(await changeStandardOperationsStartDate({
      organizationId: getOrganizationId(req),
      caseId: id,
      startDate: body.startDate,
      expectedVersion: body.expectedVersion,
      actorUserId: req.authUserId!,
    }));
  } catch (error) {
    if (sendError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/cases/:id/standard-operations/start-date/impacts/:stream/reconcile", async (req, res, next) => {
  try {
    if (!requireOperationsAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const stream = parseStartDateImpactStream(req.params.stream);
    const body = parseStartDateImpactReconciliationBody(req.body);
    res.json(await reconcileStandardOperationsStartDateImpact({
      organizationId: getOrganizationId(req),
      caseId: id,
      stream,
      resolution: body.resolution,
      expectedVersion: body.expectedVersion,
      actorUserId: req.authUserId!,
    }));
  } catch (error) {
    if (sendError(error, res)) return;
    next(error);
  }
});

export default router;
