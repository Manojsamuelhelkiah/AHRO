import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { getOrganizationId } from "../lib/organization-scope";
import { resolveReviewerName } from "../middlewares/require-auth";
import {
  completeEarlyTenureCheckin,
  assignEarlyTenureCheckinOwner,
  assignEarlyTenureAssignmentOwner,
  enrollEarlyTenureCase,
  getEarlyTenurePolicy,
  getEarlyTenureReminderInbox,
  getEarlyTenureView,
  listEarlyTenureOwnerOptions,
  recordEarlyTenureEvidence,
  recordMyEarlyTenureEvidence,
  recordProbationDecision,
  reviseEarlyTenureAssignment,
  runEarlyTenureReminderTick,
  saveEarlyTenurePolicy,
  setActualJoiningAnchor,
} from "../lib/onboarding/early-tenure";
import { hasCurrentAuthorityScope } from "../lib/onboarding/decision-authority";
import {
  recordEmploymentOutcomeEvidence,
  recordOutcomeSurveyEvidence,
} from "../lib/onboarding/outcome-reporting";

const router: IRouter = Router();

function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new Error("Request body must be an object.");
  }
  return req.body as Record<string, unknown>;
}
function integer(value: unknown, field: string, min = 1): number {
  if (!Number.isInteger(value) || (value as number) < min) throw new Error(`${field} must be an integer of at least ${min}.`);
  return value as number;
}
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}
function caseId(req: Request): number {
  return integer(Number(req.params.id), "Case id");
}
function id(req: Request, kind: string): number {
  return integer(Number(req.params.id), `${kind} id`);
}
function handle(error: unknown, res: Response): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "EarlyTenureConflict" || /changed since|only the current|not eligible/i.test(error.message)) {
    res.status(409).json({ message: error.message });
    return true;
  }
  if (/not found/i.test(error.message)) {
    res.status(404).json({ message: error.message });
    return true;
  }
  if (/authority|governance|separation|assigned tenant member|current tenant membership/i.test(error.message)) {
    res.status(403).json({ message: error.message });
    return true;
  }
  if (error.name === "EarlyTenureValidationError" || error.name === "OutcomeReportingValidationError" || /must be|required|invalid|not enrolled|not a trusted|cannot be|unsupported|policy/i.test(error.message)) {
    res.status(400).json({ message: error.message });
    return true;
  }
  return false;
}
async function requireGovernanceAdministrator(req: Request, res: Response): Promise<boolean> {
  const actorUserId = req.authUserId;
  if (!actorUserId) {
    res.status(401).json({ message: "Authentication required." });
    return false;
  }
  const allowed = await db.transaction((tx) => hasCurrentAuthorityScope(tx, {
    organizationId: getOrganizationId(req), actorUserId, scope: "authority-administration",
  }));
  if (!allowed) {
    res.status(403).json({ message: "Current governance-approved authority-administration assignment is required." });
    return false;
  }
  return true;
}

router.get("/onboarding/early-tenure/policy", async (req, res, next) => {
  try {
    res.json(await getEarlyTenurePolicy(getOrganizationId(req)));
  } catch (error) { next(error); }
});

router.put("/onboarding/early-tenure/policy", async (req, res, next) => {
  try {
    if (!(await requireGovernanceAdministrator(req, res))) return;
    const input = body(req);
    const result = await saveEarlyTenurePolicy({
      organizationId: getOrganizationId(req), expectedVersion: integer(input.expectedVersion, "expectedVersion", 0),
      policy: input.policy, actorUserId: req.authUserId!, createdBy: await resolveReviewerName(req.authUserId!),
    });
    res.json(result);
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.get("/onboarding/early-tenure/cases/:id", async (req, res, next) => {
  try {
    const view = await getEarlyTenureView(getOrganizationId(req), caseId(req), req.authUserId!);
    if (!view) { res.status(404).json({ message: "Case not found." }); return; }
    res.json(view);
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.get("/onboarding/early-tenure/cases/:id/owner-options", async (req, res, next) => {
  try {
    res.json(await listEarlyTenureOwnerOptions(getOrganizationId(req), caseId(req), req.authUserId!));
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.get("/onboarding/early-tenure/reminders/inbox", async (req, res, next) => {
  try {
    res.json(await getEarlyTenureReminderInbox(getOrganizationId(req), req.authUserId!));
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/cases/:id/enroll", async (req, res, next) => {
  try {
    const result = await enrollEarlyTenureCase({
      organizationId: getOrganizationId(req), caseId: caseId(req), actorUserId: req.authUserId!,
      enrolledBy: await resolveReviewerName(req.authUserId!),
    });
    if (!result.enrolled) { res.status(409).json(result); return; }
    res.status(201).json(await getEarlyTenureView(getOrganizationId(req), caseId(req), req.authUserId!));
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/cases/:id/joining-anchor", async (req, res, next) => {
  try {
    const input = body(req);
    await setActualJoiningAnchor({
      organizationId: getOrganizationId(req), caseId: caseId(req), actualJoinedAt: String(input.actualJoinedAt ?? ""),
      expectedAnchorRevision: integer(input.expectedAnchorRevision, "expectedAnchorRevision", 0),
      actorUserId: req.authUserId!, recordedBy: await resolveReviewerName(req.authUserId!),
    });
    res.json(await getEarlyTenureView(getOrganizationId(req), caseId(req), req.authUserId!));
  } catch (error) { if (!handle(error, res)) next(error); }
});

/**
 * Restricted human-entry boundary for voluntary 30-day onboarding surveys.
 * Trusted-provider survey adapters call the writer directly after their own
 * authenticated provider boundary; a browser route may not assert provider
 * provenance.
 */
router.post("/onboarding/analytics/outcome-evidence/surveys", async (req, res, next) => {
  try {
    const input = body(req);
    if (input.surveyKind !== "onboarding-30-day" || input.voluntary !== true) {
      throw new Error("Only voluntary onboarding-30-day survey evidence may be recorded.");
    }
    if (input.provenance !== undefined && input.provenance !== "human-authorized") {
      throw new Error("Browser survey evidence must be human-authorized; trusted-provider provenance is reserved for an authenticated connector adapter.");
    }
    await recordOutcomeSurveyEvidence({
      organizationId: getOrganizationId(req),
      caseId: integer(input.caseId, "caseId"),
      actorUserId: req.authUserId!,
      score: integer(input.score, "score", 0),
      submittedAt: String(input.submittedAt ?? ""),
      evidenceReference: String(input.evidenceReference ?? ""),
      provenance: "human-authorized",
    });
    res.status(204).end();
  } catch (error) { if (!handle(error, res)) next(error); }
});

/**
 * Restricted human-entry boundary for verified employment outcomes. It is
 * append-only so later HR corrections remain auditable; the KPI loader selects
 * the latest non-conflicting dated record.
 */
router.post("/onboarding/analytics/outcome-evidence/employment", async (req, res, next) => {
  try {
    const input = body(req);
    if (input.provenance !== undefined && input.provenance !== "human-authorized") {
      throw new Error("Browser employment evidence must be human-authorized; trusted HRIS provenance is reserved for an authenticated connector adapter.");
    }
    const employmentStatus = input.employmentStatus;
    if (employmentStatus !== "active" && employmentStatus !== "terminated" && employmentStatus !== "unknown") {
      throw new Error("employmentStatus must be active, terminated, or unknown.");
    }
    const evidenceId = await recordEmploymentOutcomeEvidence({
      organizationId: getOrganizationId(req),
      caseId: integer(input.caseId, "caseId"),
      actorUserId: req.authUserId!,
      actualJoinedAt: String(input.actualJoinedAt ?? ""),
      employmentStatus,
      effectiveAt: optionalString(input.effectiveAt, "effectiveAt"),
      correctsEvidenceId: input.correctsEvidenceId === undefined
        ? undefined
        : integer(input.correctsEvidenceId, "correctsEvidenceId"),
      observedAt: String(input.observedAt ?? ""),
      evidenceReference: String(input.evidenceReference ?? ""),
      provenance: "human-authorized",
    });
    res.status(201).json({ evidenceId });
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/assignments/:id/revise", async (req, res, next) => {
  try {
    const input = body(req);
    await reviseEarlyTenureAssignment({
      organizationId: getOrganizationId(req), assignmentId: id(req, "Assignment"),
      expectedRevision: integer(input.expectedRevision, "expectedRevision"),
      actorUserId: req.authUserId!, ownerName: String(input.ownerName ?? ""), ownerUserId: optionalString(input.ownerUserId, "ownerUserId") ?? null,
      dueAt: String(input.dueAt ?? ""), taskDetails: input.taskDetails,
      notificationRecipientEmail: optionalString(input.notificationRecipientEmail, "notificationRecipientEmail") ?? null,
    });
    res.status(204).end();
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/assignments/:id/evidence", async (req, res, next) => {
  try {
    const input = body(req);
    if (input.provenance !== undefined && input.provenance !== "human-authorized") {
      throw new Error("Browser early-tenure evidence must be human-authorized; trusted-provider provenance is reserved for an authenticated connector adapter.");
    }
    if (input.sourceConnectorKey !== undefined) {
      throw new Error("Browser early-tenure evidence cannot provide a connector source; trusted connector evidence is reserved for an authenticated adapter.");
    }
    await recordEarlyTenureEvidence({
      organizationId: getOrganizationId(req), assignmentId: id(req, "Assignment"), actorUserId: req.authUserId!,
      recordedBy: await resolveReviewerName(req.authUserId!), evidenceReference: String(input.evidenceReference ?? ""),
      provenance: "human-authorized",
      observedAt: String(input.observedAt ?? ""), note: optionalString(input.note, "note"),
    });
    res.status(204).end();
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/assignments/:id/owner", async (req, res, next) => {
  try {
    const input = body(req);
    await assignEarlyTenureAssignmentOwner({
      organizationId: getOrganizationId(req), assignmentId: id(req, "Assignment"),
      expectedRevision: integer(input.expectedRevision, "expectedRevision"),
      ownerUserId: String(input.ownerUserId ?? ""), buddyUserId: optionalString(input.buddyUserId, "buddyUserId"),
      actorUserId: req.authUserId!,
    });
    res.status(204).end();
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/assignments/:id/my-evidence", async (req, res, next) => {
  try {
    const input = body(req);
    if (input.provenance !== undefined && input.provenance !== "human-authorized") {
      throw new Error("Inbox evidence must be human-authorized.");
    }
    if (input.sourceConnectorKey !== undefined) throw new Error("Inbox evidence cannot provide a connector source.");
    await recordMyEarlyTenureEvidence({
      organizationId: getOrganizationId(req), assignmentId: id(req, "Assignment"), actorUserId: req.authUserId!,
      recordedBy: await resolveReviewerName(req.authUserId!), evidenceReference: String(input.evidenceReference ?? ""),
      observedAt: String(input.observedAt ?? ""), note: optionalString(input.note, "note"),
    });
    res.status(204).end();
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/checkins/:id/complete", async (req, res, next) => {
  try {
    const input = body(req);
    await completeEarlyTenureCheckin({
      organizationId: getOrganizationId(req), checkinId: id(req, "Check-in"), expectedRevision: integer(input.expectedRevision, "expectedRevision"),
      actorUserId: req.authUserId!, evidenceReference: String(input.evidenceReference ?? ""), completedAt: String(input.completedAt ?? ""),
    });
    res.status(204).end();
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/checkins/:id/owner", async (req, res, next) => {
  try {
    const input = body(req);
    await assignEarlyTenureCheckinOwner({
      organizationId: getOrganizationId(req), checkinId: id(req, "Check-in"),
      expectedRevision: integer(input.expectedRevision, "expectedRevision"),
      ownerUserId: String(input.ownerUserId ?? ""), actorUserId: req.authUserId!,
    });
    res.status(204).end();
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/probation-decisions", async (req, res, next) => {
  try {
    const input = body(req);
    const disposition = input.disposition;
    if (disposition !== "confirmed" && disposition !== "extended" && disposition !== "reviewed-other") {
      throw new Error("disposition must be confirmed, extended, or reviewed-other.");
    }
    await recordProbationDecision({
      organizationId: getOrganizationId(req), caseId: integer(input.caseId, "caseId"),
      expectedSnapshotVersion: integer(input.expectedSnapshotVersion, "expectedSnapshotVersion"),
      expectedAnchorRevision: integer(input.expectedAnchorRevision, "expectedAnchorRevision", 0),
      expectedDecisionVersion: integer(input.expectedDecisionVersion, "expectedDecisionVersion", 0),
      actorUserId: req.authUserId!, decidedBy: await resolveReviewerName(req.authUserId!), disposition,
      effectiveAt: String(input.effectiveAt ?? ""), extensionEndsAt: optionalString(input.extensionEndsAt, "extensionEndsAt"),
      rationale: String(input.rationale ?? ""), evidenceReference: String(input.evidenceReference ?? ""),
    });
    res.status(201).json(await getEarlyTenureView(getOrganizationId(req), integer(input.caseId, "caseId"), req.authUserId!));
  } catch (error) { if (!handle(error, res)) next(error); }
});

router.post("/onboarding/early-tenure/reminders/dispatch", async (req, res, next) => {
  try {
    if (!(await requireGovernanceAdministrator(req, res))) return;
    res.json(await runEarlyTenureReminderTick());
  } catch (error) { if (!handle(error, res)) next(error); }
});

export default router;