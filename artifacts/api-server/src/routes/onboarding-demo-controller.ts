import { Router, type IRouter } from "express";
import {
  ApplyOnboardingDemoRunActionBody,
  ApplyOnboardingDemoRunActionParams,
  ApplyOnboardingDemoRunActionResponse,
  CreateOnboardingDemoRunBody,
  CreateOnboardingDemoRunResponse,
  DownloadOnboardingDemoRunDocumentsParams,
  GetOnboardingDemoControllerResponse,
  GetOnboardingDemoRunParams,
  GetOnboardingDemoRunResponse,
} from "@workspace/api-zod";
import { DEMO_ORGANIZATION_ID } from "@workspace/db/schema";
import { getOrganizationId } from "../lib/organization-scope";
import {
  applyDemoAction,
  createDemoRun,
  demoDocuments,
  getDemoCapabilities,
  getDemoRun,
  isDemoControllerRole,
  publicRun,
} from "../lib/onboarding/demo-controller";

const router: IRouter = Router();

function rejectUnknown(body: unknown, allowed: readonly string[]): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Request body must be an object.";
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  return unknown.length > 0 ? `Unknown field(s): ${unknown.join(", ")}` : null;
}

function statusFor(error: unknown): number {
  const name = error instanceof Error ? error.name : "";
  if (name === "DemoRunNotFound" || name === "DemoScenarioNotFound") return 404;
  if (
    name === "DemoRunVersionConflict" ||
    name === "DemoRunConflict" ||
    name === "DemoVolunteerUnavailable"
  ) return 409;
  if (
    name === "DemoOrganizationOnly" ||
    name === "DemoLiveConfirmationRequired" ||
    name === "DemoLiveChannelDenied"
  ) return 403;
  if (name.startsWith("Demo")) return 400;
  return 500;
}

router.get("/onboarding/demo-controller", async (req, res, next) => {
  try {
    const response = await getDemoCapabilities(getOrganizationId(req), req.organizationRole);
    res.json(GetOnboardingDemoControllerResponse.parse(response));
  } catch (error) {
    next(error);
  }
});

router.post("/onboarding/demo-runs", async (req, res, next) => {
  try {
    if (!isDemoControllerRole(req.organizationRole)) {
      res.status(403).json({ error: "Sign in and join Demo Organization to create demo runs." });
      return;
    }
    const unknown = rejectUnknown(req.body, ["scenario", "volunteerId", "mode"]);
    if (unknown) {
      res.status(400).json({ error: unknown });
      return;
    }
    const parsed = CreateOnboardingDemoRunBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const run = await createDemoRun(getOrganizationId(req), req.authUserId!, parsed.data);
      res.status(201).json(CreateOnboardingDemoRunResponse.parse(publicRun(run)));
    } catch (error) {
      res.status(statusFor(error)).json({ error: error instanceof Error ? error.message : "Unable to create demo run." });
    }
  } catch (error) {
    next(error);
  }
});

router.get("/onboarding/demo-runs/:runId", async (req, res, next) => {
  try {
    if (getOrganizationId(req) !== DEMO_ORGANIZATION_ID || !isDemoControllerRole(req.organizationRole)) {
      res.status(403).json({ error: "Demo Controller details require membership in Demo Organization." });
      return;
    }
    const params = GetOnboardingDemoRunParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const run = await getDemoRun(getOrganizationId(req), params.data.runId);
    if (!run) {
      res.status(404).json({ error: "Demo run not found." });
      return;
    }
    res.json(GetOnboardingDemoRunResponse.parse(publicRun(run)));
  } catch (error) {
    next(error);
  }
});

router.post("/onboarding/demo-runs/:runId/actions", async (req, res, next) => {
  try {
    if (!isDemoControllerRole(req.organizationRole)) {
      res.status(403).json({ error: "Sign in and join Demo Organization to use demo controls." });
      return;
    }
    const params = ApplyOnboardingDemoRunActionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const unknown = rejectUnknown(req.body, [
      "expectedVersion", "requestId", "kind", "system", "outcome", "step",
      "reason", "hours", "channel", "mode", "liveConfirmation",
    ]);
    if (unknown) {
      res.status(400).json({ error: unknown });
      return;
    }
    const parsed = ApplyOnboardingDemoRunActionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const run = await applyDemoAction(
        getOrganizationId(req),
        req.authUserId!,
        params.data.runId,
        parsed.data,
      );
      res.json(ApplyOnboardingDemoRunActionResponse.parse(publicRun(run)));
    } catch (error) {
      res.status(statusFor(error)).json({ error: error instanceof Error ? error.message : "Unable to apply demo action." });
    }
  } catch (error) {
    next(error);
  }
});

router.get("/onboarding/demo-runs/:runId/documents", async (req, res, next) => {
  try {
    if (getOrganizationId(req) !== DEMO_ORGANIZATION_ID || !isDemoControllerRole(req.organizationRole)) {
      res.status(403).json({ error: "Demo Controller documents require membership in Demo Organization." });
      return;
    }
    const params = DownloadOnboardingDemoRunDocumentsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const run = await getDemoRun(getOrganizationId(req), params.data.runId);
    if (!run) {
      res.status(404).json({ error: "Demo run not found." });
      return;
    }
    res.type("text/plain").set("Content-Disposition", `attachment; filename="demo-${run.runId}-documents.txt"`).send(demoDocuments(run));
  } catch (error) {
    next(error);
  }
});

export default router;