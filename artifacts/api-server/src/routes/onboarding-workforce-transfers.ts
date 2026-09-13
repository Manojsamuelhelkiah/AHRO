import { Router, type IRouter, type Request, type Response } from "express";
import { getOrganizationId } from "../lib/organization-scope";
import {
  TransferConflictError,
  TransferValidationError,
  commitTransferImport,
  createTransferCutoverPlan,
  createTransferImportPreview,
  createTransferIntegrationAction,
  createTransferPopulation,
  createTransferProgram,
  decideTransferGoNoGo,
  getTransferKpis,
  getTransferProgram,
  getTransferReconciliation,
  listTransferPrograms,
  recordConsultationMilestone,
  recordTransferCutoverSignoff,
  recordTransferDataGovernance,
  recordTransferKpiEvidence,
  recordTransferKpiDefinition,
  recordTransferObjection,
  recordTransferPathway,
  recordTransferReconciliation,
} from "../lib/onboarding/workforce-transfer";

const router: IRouter = Router();
const body = (req: Request): Record<string, unknown> => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new TransferValidationError("Request body must be an object.");
  return req.body as Record<string, unknown>;
};
const path = (req: Request, key: string) => {
  const raw = req.params[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new TransferValidationError(`${key} is required.`);
  return value;
};
function failure(error: unknown, res: Response) {
  if (error instanceof TransferConflictError) { res.status(409).json({ message: error.message }); return true; }
  if (error instanceof TransferValidationError) {
    res.status(/not found/i.test(error.message) ? 404 : /authority|membership/i.test(error.message) ? 403 : 400).json({ message: error.message });
    return true;
  }
  return false;
}
const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: (err?: unknown) => void) => {
  try { await fn(req, res); } catch (error) { if (!failure(error, res)) next(error); }
};

router.get("/onboarding/workforce-transfers/programs", handle(async (req, res) => {
  res.json(await listTransferPrograms(getOrganizationId(req), req.authUserId!));
}));
router.post("/onboarding/workforce-transfers/programs", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await createTransferProgram({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, name: b.name, sourceLegalEntity: b.sourceLegalEntity, destinationLegalEntity: b.destinationLegalEntity, countries: b.countries, proposedBasis: b.proposedBasis, legalDay1: b.legalDay1, owners: b.owners }));
}));
router.get("/onboarding/workforce-transfers/programs/:programId", handle(async (req, res) => {
  res.json(await getTransferProgram(getOrganizationId(req), req.authUserId!, path(req, "programId")));
}));
router.post("/onboarding/workforce-transfers/programs/:programId/populations", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await createTransferPopulation({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, programId: path(req, "programId"), country: b.country, sourceLegalEntity: b.sourceLegalEntity, destinationLegalEntity: b.destinationLegalEntity, expectedHeadcount: b.expectedHeadcount }));
}));
router.post("/onboarding/workforce-transfers/programs/:programId/pathways", handle(async (req, res) => {
  const b = body(req);
  res.json(await recordTransferPathway({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, programId: path(req, "programId"), expectedVersion: b.expectedVersion, jurisdiction: b.jurisdiction, decision: b.decision, offerRequirement: b.offerRequirement, bgvApplicability: b.bgvApplicability, reviewReference: b.reviewReference }));
}));
router.post("/onboarding/workforce-transfers/programs/:programId/data-governance", handle(async (req, res) => {
  const b = body(req);
  res.json(await recordTransferDataGovernance({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, programId: path(req, "programId"), expectedVersion: b.expectedVersion, jurisdiction: b.jurisdiction, lawfulBasisReference: b.lawfulBasisReference, retentionReference: b.retentionReference, retentionUntil: b.retentionUntil }));
}));
router.post("/onboarding/workforce-transfers/populations/:populationId/imports/preview", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await createTransferImportPreview({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, populationId: path(req, "populationId"), mapping: b.mapping, rows: b.rows }));
}));
router.post("/onboarding/workforce-transfers/populations/:populationId/imports", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await commitTransferImport({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, populationId: path(req, "populationId"), previewId: typeof b.previewId === "string" ? b.previewId : "", idempotencyKey: b.idempotencyKey, expectedPopulationVersion: b.expectedPopulationVersion }));
}));
router.get("/onboarding/workforce-transfers/populations/:populationId/reconciliation", handle(async (req, res) => {
  res.json(await getTransferReconciliation(getOrganizationId(req), req.authUserId!, path(req, "populationId")));
}));
router.post("/onboarding/workforce-transfers/programs/:programId/consultation-milestones", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await recordConsultationMilestone({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, programId: path(req, "programId"), expectedVersion: b.expectedVersion, milestoneId: b.milestoneId, jurisdiction: b.jurisdiction, kind: b.kind, dueAt: b.dueAt, completedAt: b.completedAt, status: b.status, evidenceReference: b.evidenceReference }));
}));
router.post("/onboarding/workforce-transfers/workers/:workerId/objections", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await recordTransferObjection({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, workerId: path(req, "workerId"), expectedWorkerVersion: b.expectedWorkerVersion, outcome: b.outcome, receivedAt: b.receivedAt, evidenceReference: b.evidenceReference }));
}));
router.post("/onboarding/workforce-transfers/programs/:programId/integration-actions", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await createTransferIntegrationAction({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, programId: path(req, "programId"), expectedVersion: b.expectedVersion, actionId: b.actionId, kind: b.kind, ownerUserId: b.ownerUserId, dueAt: b.dueAt, completedAt: b.completedAt, status: b.status, evidenceReference: b.evidenceReference, legalApprovalReference: b.legalApprovalReference }));
}));
router.post("/onboarding/workforce-transfers/programs/:programId/cutover-plans", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await createTransferCutoverPlan({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, programId: path(req, "programId"), expectedVersion: b.expectedVersion, contingencyReference: b.contingencyReference }));
}));
router.post("/onboarding/workforce-transfers/cutover-plans/:planId/workers/:workerId/reconciliation", handle(async (req, res) => {
  const b = body(req);
  res.json(await recordTransferReconciliation({
    organizationId: getOrganizationId(req), actorUserId: req.authUserId!,
    planId: path(req, "planId"), workerId: path(req, "workerId"),
    expectedPlanVersion: b.expectedPlanVersion, stream: b.stream, status: b.status,
    evidenceReference: b.evidenceReference,
    sourceAttestationReference: b.sourceAttestationReference,
    destinationAttestationReference: b.destinationAttestationReference,
    destinationOriginalHireDate: b.destinationOriginalHireDate,
    destinationContinuousServiceDate: b.destinationContinuousServiceDate,
    destinationTermsReference: b.destinationTermsReference,
    destinationBenefitsReference: b.destinationBenefitsReference,
    repairReference: b.repairReference,
  }));
}));
router.post("/onboarding/workforce-transfers/cutover-plans/:planId/signoffs", handle(async (req, res) => {
  const b = body(req);
  res.json(await recordTransferCutoverSignoff({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, planId: path(req, "planId"), expectedPlanVersion: b.expectedPlanVersion, role: b.role, decision: b.decision, reasonReference: b.reasonReference }));
}));
router.post("/onboarding/workforce-transfers/cutover-plans/:planId/go-no-go", handle(async (req, res) => {
  const b = body(req);
  res.json(await decideTransferGoNoGo({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, planId: path(req, "planId"), expectedPlanVersion: b.expectedPlanVersion, decision: b.decision }));
}));
router.post("/onboarding/workforce-transfers/programs/:programId/kpi-evidence", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await recordTransferKpiEvidence({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, programId: path(req, "programId"), metric: b.metric, value: b.value, occurredAt: b.occurredAt, measurement: b.measurement, evidenceReference: b.evidenceReference, sourceAttestationReference: b.sourceAttestationReference, workerId: b.workerId, sourceRecordId: b.sourceRecordId }));
}));
router.post("/onboarding/workforce-transfers/programs/:programId/kpi-definitions", handle(async (req, res) => {
  const b = body(req);
  res.status(201).json(await recordTransferKpiDefinition({ organizationId: getOrganizationId(req), actorUserId: req.authUserId!, programId: path(req, "programId"), metric: b.metric, definitionReference: b.definitionReference, denominatorReference: b.denominatorReference }));
}));
router.get("/onboarding/workforce-transfers/programs/:programId/kpis", handle(async (req, res) => {
  res.json(await getTransferKpis(getOrganizationId(req), req.authUserId!, path(req, "programId")));
}));

export default router;