import { Router, type IRouter, type Request, type Response } from "express";
import {
  AttestOnboardingReadinessBody,
  RebaseOnboardingReadinessSlaBody,
  SetOnboardingPayrollCutoffBody,
  UpdateOnboardingReadinessSlaPolicyBody,
} from "@workspace/api-zod";
import { resolveReviewerName } from "../middlewares/require-auth";
import { getOrganizationId } from "../lib/organization-scope";
import {
  ensureReadinessSlaEnrollment,
  getEffectiveReadinessSlaPolicy,
  getReadinessSlaView,
  recordReadinessSlaAttestation,
  rebaseReadinessSlaCase,
  resolveReadinessSlaAction,
  saveReadinessSlaPolicy,
  setReadinessSlaPayrollCutoff,
} from "../lib/onboarding/readiness-sla-policy";
import { isChecklistAdministrator } from "../lib/onboarding/checklist";
import {
  governanceCaseImpact,
  rebaseGovernanceCase,
} from "../lib/onboarding/governance-runtime";

const router: IRouter = Router();

// The contextual-contact service resolves action ids through this tenant-bound
// adapter instead of trusting recipient or policy fields from a browser.
router.use((req, _res, next) => {
  if (!req.app.get("onboardingSlaActionResolver")) {
    req.app.set("onboardingSlaActionResolver", resolveReadinessSlaAction);
  }
  next();
});

function requireReadinessSlaAdmin(req: Request, res: Response): boolean {
  if (isChecklistAdministrator(req.organizationRole)) return true;
  res.status(403).json({ message: "Organization owner or admin role required for readiness SLA administration." });
  return false;
}

function caseId(req: Request): number | null {
  const parsed = Number(req.params.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isValidationError(error: unknown): error is Error {
  return error instanceof Error && error.name === "ZodError";
}

function conflictOrBadRequest(error: unknown, res: Response): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name.includes("Conflict") ||
    /concurrently|changed since|active orchestration claim|active provider dispatch|completed cases/i.test(error.message)) {
    res.status(409).json({ message: error.message });
    return true;
  }
  return false;
}

function governanceRebaseBody(value: unknown): {
  expectedSnapshotVersion: number;
  reason: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return typeof body.expectedSnapshotVersion === "number" &&
    Number.isInteger(body.expectedSnapshotVersion) &&
    body.expectedSnapshotVersion >= 0 &&
    typeof body.reason === "string" &&
    body.reason.trim().length > 0 &&
    body.reason.trim().length <= 4_000
    ? { expectedSnapshotVersion: body.expectedSnapshotVersion, reason: body.reason.trim() }
    : null;
}

function clientInputError(error: unknown, res: Response): boolean {
  if (error instanceof Error && /case not found/i.test(error.message)) {
    res.status(404).json({ message: error.message });
    return true;
  }
  if (isValidationError(error)) {
    res.status(400).json({ message: error.message });
    return true;
  }
  if (error instanceof Error &&
    /policy|reason|required|invalid|not enrolled|not applicable|cutoff|attestation/i.test(error.message)) {
    res.status(400).json({ message: error.message });
    return true;
  }
  return false;
}

router.get("/onboarding/readiness-sla/policy", async (req, res, next) => {
  try {
    const current = await getEffectiveReadinessSlaPolicy(getOrganizationId(req));
    res.json(current);
  } catch (error) {
    next(error);
  }
});

router.put("/onboarding/readiness-sla/policy", async (req, res, next) => {
  try {
    if (!requireReadinessSlaAdmin(req, res)) return;
    const body = UpdateOnboardingReadinessSlaPolicyBody.parse(req.body);
    const result = await saveReadinessSlaPolicy({
      organizationId: getOrganizationId(req),
      expectedVersion: body.expectedVersion,
      policy: body.policy,
      createdBy: await resolveReviewerName(req.authUserId!),
    });
    res.json(result);
  } catch (error) {
    if (conflictOrBadRequest(error, res)) return;
    if (clientInputError(error, res)) return;
    next(error);
  }
});

router.get("/onboarding/cases/:id/readiness-sla", async (req, res, next) => {
  try {
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const view = await getReadinessSlaView(getOrganizationId(req), id);
    if (!view) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    res.json(view);
  } catch (error) {
    next(error);
  }
});

router.post("/onboarding/cases/:id/readiness-sla/enrollment", async (req, res, next) => {
  try {
    if (!requireReadinessSlaAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const enrollment = await ensureReadinessSlaEnrollment(
      organizationId,
      id,
      await resolveReviewerName(req.authUserId!),
      true,
    );
    if (!enrollment) {
      res.status(404).json({ message: "Case not found or historical completed case was not enrolled." });
      return;
    }
    const view = await getReadinessSlaView(organizationId, id);
    if (!view) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    res.json(view);
  } catch (error) {
    next(error);
  }
});

router.put("/onboarding/cases/:id/readiness-sla/payroll-cutoff", async (req, res, next) => {
  try {
    if (!requireReadinessSlaAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = SetOnboardingPayrollCutoffBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    const before = await getReadinessSlaView(organizationId, id);
    if (!before) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    if (before.enrolled && before.streams.find((stream) => stream.key === "payroll")?.status === "not-applicable") {
      res.status(409).json({ message: "Payroll cutoff is not applicable to this worker pathway." });
      return;
    }
    await setReadinessSlaPayrollCutoff({
      organizationId,
      caseId: id,
      expectedSnapshotVersion: body.expectedSnapshotVersion,
      payrollCutoff: new Date(body.payrollCutoff),
      reason: body.reason,
      setBy: await resolveReviewerName(req.authUserId!),
    });
    const view = await getReadinessSlaView(organizationId, id);
    if (!view) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    res.json(view);
  } catch (error) {
    if (conflictOrBadRequest(error, res)) return;
    if (clientInputError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/cases/:id/readiness-sla/attestations", async (req, res, next) => {
  try {
    if (!requireReadinessSlaAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = AttestOnboardingReadinessBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    await recordReadinessSlaAttestation({
      organizationId,
      caseId: id,
      streamKey: body.stream,
      complete: body.complete,
      expectedSnapshotVersion: body.expectedSnapshotVersion,
      reason: body.reason,
      attestedBy: await resolveReviewerName(req.authUserId!),
      attestedRole: req.organizationRole ?? "unknown",
    });
    const view = await getReadinessSlaView(organizationId, id);
    if (!view) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    res.json(view);
  } catch (error) {
    if (conflictOrBadRequest(error, res)) return;
    if (clientInputError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/cases/:id/readiness-sla/rebase", async (req, res, next) => {
  try {
    if (!requireReadinessSlaAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = RebaseOnboardingReadinessSlaBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    await rebaseReadinessSlaCase({
      organizationId,
      caseId: id,
      expectedSnapshotVersion: body.expectedSnapshotVersion,
      reason: body.reason,
      changedBy: await resolveReviewerName(req.authUserId!),
    });
    const view = await getReadinessSlaView(organizationId, id);
    if (!view) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    res.json(view);
  } catch (error) {
    if (conflictOrBadRequest(error, res)) return;
    if (clientInputError(error, res)) return;
    next(error);
  }
});

router.get("/onboarding/cases/:id/governance-impact", async (req, res, next) => {
  try {
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    res.json(await governanceCaseImpact({
      organizationId: getOrganizationId(req),
      caseId: id,
    }));
  } catch (error) {
    if (clientInputError(error, res)) return;
    next(error);
  }
});

router.post("/onboarding/cases/:id/governance-rebase", async (req, res, next) => {
  try {
    if (!requireReadinessSlaAdmin(req, res)) return;
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = governanceRebaseBody(req.body);
    if (!body) {
      res.status(400).json({
        message: "expectedSnapshotVersion must be a non-negative integer and reason is required.",
      });
      return;
    }
    const snapshot = await rebaseGovernanceCase({
      organizationId: getOrganizationId(req),
      caseId: id,
      expectedSnapshotVersion: body.expectedSnapshotVersion,
      reason: body.reason,
      changedBy: await resolveReviewerName(req.authUserId!),
    });
    res.json({
      snapshot,
      freshFinalApprovalRequired: true,
    });
  } catch (error) {
    if (conflictOrBadRequest(error, res)) return;
    if (clientInputError(error, res)) return;
    next(error);
  }
});

export default router;