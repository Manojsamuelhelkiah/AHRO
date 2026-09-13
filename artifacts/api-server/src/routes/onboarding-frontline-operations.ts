import { Router, type IRouter, type Request, type Response } from "express";
import { getOrganizationId } from "../lib/organization-scope";
import {
  evaluateFrontlineFloorRelease,
  FrontlineConflictError,
  FrontlineValidationError,
  getFrontlineReadiness,
  getFrontlineKpiAggregate,
  getFrontlineEvidenceHistory,
  recordFrontlineEvidence,
  revokeFrontlineEvidence,
  recordFrontlineFulfillment,
  recordFrontlineKpiInput,
  recordFrontlinePolicyException,
  revokeFrontlinePolicyException,
} from "../lib/onboarding/frontline-operations";

const router: IRouter = Router();

function caseId(req: Request): number {
  const value = Number(req.params.id);
  if (!Number.isInteger(value) || value < 1) throw new FrontlineValidationError("Case id must be a positive integer.");
  return value;
}
function objectBody(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new FrontlineValidationError("Request body must be an object.");
  return req.body as Record<string, unknown>;
}
function number(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new FrontlineValidationError(`${field} must be an integer.`);
  return value as number;
}
function pathNumber(value: string | undefined, field: string): number {
  return number(Number(value), field);
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new FrontlineValidationError(`${field} must be a string.`);
  return value;
}
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return string(value, field);
}
function sendError(error: unknown, res: Response): boolean {
  if (error instanceof FrontlineConflictError) {
    res.status(409).json({ message: error.message });
    return true;
  }
  if (error instanceof FrontlineValidationError) {
    res.status(/not found/i.test(error.message) ? 404 : /authority/i.test(error.message) ? 403 : 400).json({ message: error.message });
    return true;
  }
  return false;
}

router.get("/onboarding/cases/:id/frontline/readiness", async (req, res, next) => {
  try { res.json(await getFrontlineReadiness(getOrganizationId(req), caseId(req))); }
  catch (error) { if (!sendError(error, res)) next(error); }
});

router.post("/onboarding/cases/:id/frontline/evidence", async (req, res, next) => {
  try {
    const body = objectBody(req);
    res.status(201).json(await recordFrontlineEvidence({
      organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId!,
      expectedVersion: number(body.expectedVersion, "expectedVersion"),
      kind: body.kind as never, evidenceReference: string(body.evidenceReference, "evidenceReference"),
      issuerTimestamp: string(body.issuerTimestamp, "issuerTimestamp"), effectiveAt: optionalString(body.effectiveAt, "effectiveAt"),
      expiresAt: optionalString(body.expiresAt, "expiresAt"), statutoryKey: optionalString(body.statutoryKey, "statutoryKey"),
      status: body.status as never, revocationReference: optionalString(body.revocationReference, "revocationReference"),
      skillRequirementKey: optionalString(body.skillRequirementKey, "skillRequirementKey"),
      subjectAgeYears: body.subjectAgeYears === undefined ? undefined : number(body.subjectAgeYears, "subjectAgeYears"),
    }));
  } catch (error) { if (!sendError(error, res)) next(error); }
});

router.post("/onboarding/cases/:id/frontline/evidence/:evidenceId/revoke", async (req, res, next) => {
  try {
    const body = objectBody(req);
    res.json(await revokeFrontlineEvidence({
      organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId!,
      expectedVersion: number(body.expectedVersion, "expectedVersion"), evidenceId: pathNumber(req.params.evidenceId, "evidenceId"),
      revocationReference: string(body.revocationReference, "revocationReference"),
    }));
  } catch (error) { if (!sendError(error, res)) next(error); }
});
router.get("/onboarding/cases/:id/frontline/evidence-history", async (req, res, next) => {
  try { res.json(await getFrontlineEvidenceHistory({ organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId! })); }
  catch (error) { if (!sendError(error, res)) next(error); }
});

router.post("/onboarding/cases/:id/frontline/fulfillments", async (req, res, next) => {
  try {
    const body = objectBody(req);
    res.status(201).json(await recordFrontlineFulfillment({
      organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId!,
      expectedVersion: number(body.expectedVersion, "expectedVersion"), item: body.item as never,
      // assetRef is retained as a narrow compatibility spelling; the server
      // still stores it as an opaque assetReference and never exposes it in
      // the broad readiness projection.
      assetReference: string(body.assetReference ?? body.assetRef, "assetReference"), size: optionalString(body.size, "size"),
      requestedQuantity: number(body.requestedQuantity, "requestedQuantity"), issuedQuantity: number(body.issuedQuantity, "issuedQuantity"),
      issuerTimestamp: string(body.issuerTimestamp, "issuerTimestamp"), acknowledgedAt: optionalString(body.acknowledgedAt, "acknowledgedAt"),
      status: body.status as never, exceptionId: body.exceptionId === undefined ? undefined : number(body.exceptionId, "exceptionId"),
      acknowledgementRecipientReference: optionalString(body.acknowledgementRecipientReference, "acknowledgementRecipientReference"),
      acknowledgementMethod: body.acknowledgementMethod as never,
    }));
  } catch (error) { if (!sendError(error, res)) next(error); }
});

router.post("/onboarding/cases/:id/frontline/policy-exceptions", async (req, res, next) => {
  try {
    const body = objectBody(req);
    res.status(201).json(await recordFrontlinePolicyException({
      organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId!,
      expectedVersion: number(body.expectedVersion, "expectedVersion"), item: body.item as never,
      type: body.type as never, reviewReference: string(body.reviewReference, "reviewReference"),
      effectiveAt: string(body.effectiveAt, "effectiveAt"), expiresAt: optionalString(body.expiresAt, "expiresAt"),
    }));
  } catch (error) { if (!sendError(error, res)) next(error); }
});

router.post("/onboarding/cases/:id/frontline/policy-exceptions/:exceptionId/revoke", async (req, res, next) => {
  try {
    const body = objectBody(req);
    res.json(await revokeFrontlinePolicyException({
      organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId!,
      expectedVersion: number(body.expectedVersion, "expectedVersion"), exceptionId: pathNumber(req.params.exceptionId, "exceptionId"),
      revocationReference: string(body.revocationReference, "revocationReference"),
    }));
  } catch (error) { if (!sendError(error, res)) next(error); }
});

router.post("/onboarding/cases/:id/frontline/kpi-inputs", async (req, res, next) => {
  try {
    const body = objectBody(req);
    res.status(201).json(await recordFrontlineKpiInput({
      organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId!,
      expectedVersion: number(body.expectedVersion, "expectedVersion"), kind: body.kind as never,
      occurredAt: string(body.occurredAt, "occurredAt"), actualExitAt: optionalString(body.actualExitAt, "actualExitAt"),
      evidenceReference: string(body.evidenceReference, "evidenceReference"),
    }));
  } catch (error) { if (!sendError(error, res)) next(error); }
});

router.get("/onboarding/cases/:id/frontline/kpis", async (req, res, next) => {
  try { res.json(await getFrontlineKpiAggregate({ organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId! })); }
  catch (error) { if (!sendError(error, res)) next(error); }
});

router.post("/onboarding/cases/:id/frontline/floor-release", async (req, res, next) => {
  try {
    const body = objectBody(req);
    res.json(await evaluateFrontlineFloorRelease({
      organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId!,
      expectedVersion: number(body.expectedVersion, "expectedVersion"),
    }));
  } catch (error) { if (!sendError(error, res)) next(error); }
});

export default router;