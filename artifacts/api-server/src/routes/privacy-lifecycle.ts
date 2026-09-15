import { Router, type IRouter, type Response } from "express";
import { getOrganizationId } from "../lib/organization-scope";
import {
  confirmRetentionShortening,
  listSensitiveLifecycleDeletionJobs,
  listSensitiveLifecycleHolds,
  listSensitiveLifecyclePolicies,
  previewRetentionShortening,
  releaseSensitiveLifecycleHold,
  retrySensitiveLifecycleDeletionJob,
  saveSensitiveLifecyclePolicy,
  SensitiveLifecycleConflictError,
  SensitiveLifecyclePermissionError,
  SensitiveLifecycleValidationError,
  setSensitiveLifecycleHold,
} from "../lib/onboarding/sensitive-lifecycle";
import {
  getStarterSensitiveLifecyclePolicy,
  saveStarterSensitiveLifecyclePolicy,
} from "../lib/onboarding/starter-lifecycle-policy";

const router: IRouter = Router();

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SensitiveLifecycleValidationError("A JSON object request body is required.");
  }
  return value as Record<string, unknown>;
}

function clientError(error: unknown, res: Response): boolean {
  if (error instanceof SensitiveLifecycleValidationError) {
    res.status(400).json({ message: error.message }); return true;
  }
  if (error instanceof SensitiveLifecyclePermissionError) {
    res.status(403).json({ message: error.message }); return true;
  }
  if (error instanceof SensitiveLifecycleConflictError) {
    res.status(409).json({ message: error.message }); return true;
  }
  return false;
}

router.get("/privacy/lifecycle/policies", async (req, res, next) => {
  try {
    res.json({ policies: await listSensitiveLifecyclePolicies({
      organizationId: getOrganizationId(req), actorUserId: req.authUserId!,
    }) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.get("/privacy/lifecycle/starter-policy", async (req, res, next) => {
  try {
    const queryCountry = Array.isArray(req.query.country) ? req.query.country[0] : req.query.country;
    res.json({
      starterPolicy: await getStarterSensitiveLifecyclePolicy({
        organizationId: getOrganizationId(req),
        actorUserId: req.authUserId!,
        country: queryCountry,
      }),
    });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.put("/privacy/lifecycle/starter-policy", async (req, res, next) => {
  try {
    res.json({
      starterPolicy: await saveStarterSensitiveLifecyclePolicy({
        organizationId: getOrganizationId(req),
        actorUserId: req.authUserId!,
        policy: body(req.body),
      }),
    });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.get("/privacy/lifecycle/holds", async (req, res, next) => {
  try {
    res.json({ holds: await listSensitiveLifecycleHolds({
      organizationId: getOrganizationId(req), actorUserId: req.authUserId!,
    }) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.get("/privacy/lifecycle/deletion-jobs", async (req, res, next) => {
  try {
    res.json({ jobs: await listSensitiveLifecycleDeletionJobs({
      organizationId: getOrganizationId(req), actorUserId: req.authUserId!,
    }) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/privacy/lifecycle/deletion-jobs/:id/retry", async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId) || jobId < 1) throw new SensitiveLifecycleValidationError("A positive job id is required.");
    res.json({ job: await retrySensitiveLifecycleDeletionJob({
      organizationId: getOrganizationId(req), actorUserId: req.authUserId!, jobId,
    }) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.put("/privacy/lifecycle/policies", async (req, res, next) => {
  try {
    res.json({ policy: await saveSensitiveLifecyclePolicy({
      organizationId: getOrganizationId(req), actorUserId: req.authUserId!, policy: body(req.body),
    }) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

/**
 * The preview is intentionally a separate, durable step.  It gives a
 * specialist the affected-object count without making an irreversible policy
 * change; confirmation must come from the same authenticated authority.
 */
router.post("/privacy/lifecycle/policies/shortening-preview", async (req, res, next) => {
  try {
    res.json(await previewRetentionShortening({
      organizationId: getOrganizationId(req), actorUserId: req.authUserId!, policy: body(req.body),
    }));
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/privacy/lifecycle/shortening-previews/:id/confirm", async (req, res, next) => {
  try {
    const confirmationId = Number(req.params.id);
    if (!Number.isInteger(confirmationId) || confirmationId < 1) {
      throw new SensitiveLifecycleValidationError("A positive preview id is required.");
    }
    const request = body(req.body);
    res.json({ policy: await confirmRetentionShortening({
      organizationId: getOrganizationId(req), actorUserId: req.authUserId!,
      confirmationId, confirmationPhrase: request.confirmationPhrase,
    }) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/privacy/lifecycle/holds", async (req, res, next) => {
  try {
    const request = body(req.body);
    const hold = await setSensitiveLifecycleHold({
      organizationId: getOrganizationId(req), actorUserId: req.authUserId!,
      dataClass: request.dataClass, caseId: request.caseId, objectPath: request.objectPath,
      reason: request.reason, reference: request.reference,
    });
    res.status(201).json({ hold });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

router.post("/privacy/lifecycle/holds/:id/release", async (req, res, next) => {
  try {
    const holdId = Number(req.params.id);
    if (!Number.isInteger(holdId) || holdId < 1) {
      throw new SensitiveLifecycleValidationError("A positive hold id is required.");
    }
    const request = body(req.body);
    res.json({ hold: await releaseSensitiveLifecycleHold({
      organizationId: getOrganizationId(req), actorUserId: req.authUserId!, holdId, reference: request.reference,
    }) });
  } catch (error) {
    if (clientError(error, res)) return;
    next(error);
  }
});

export default router;