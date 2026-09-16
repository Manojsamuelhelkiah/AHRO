import { Router, type IRouter } from "express";
import {
  GetOnboardingCaseSimulationParams,
  RestartOnboardingCaseSimulationBody,
  SimulateNextOnboardingCaseExchangeBody,
} from "@workspace/api-zod";
import {
  CaseSimulationConflictError,
  CaseSimulationDeniedError,
  CaseSimulationNotFoundError,
  getCaseSimulation,
  restartCaseSimulation,
  sendCurrentSimulationPrompt,
  simulateNextCaseExchange,
} from "../lib/onboarding/case-simulation";
import { getOrganizationId } from "../lib/organization-scope";

const router: IRouter = Router();

function statusFor(error: unknown): number {
  const name = error instanceof Error ? error.name : "";
  if (error instanceof CaseSimulationNotFoundError) return 404;
  if (error instanceof CaseSimulationDeniedError) return 403;
  if (error instanceof CaseSimulationConflictError) return 409;
  if (name === "DemoOrganizationOnly" || name === "DemoVolunteerUnavailable" || name === "DemoLiveChannelDenied") return 403;
  return 500;
}

function parseCaseId(value: unknown): number | null {
  const parsed = GetOnboardingCaseSimulationParams.safeParse({ caseId: value });
  return parsed.success && Number.isSafeInteger(parsed.data.caseId) && parsed.data.caseId > 0
    ? parsed.data.caseId
    : null;
}

router.get("/onboarding/cases/:caseId/simulation", async (req, res, next) => {
  const caseId = parseCaseId(req.params.caseId);
  if (caseId === null) {
    res.status(400).json({ error: "caseId must be a positive integer." });
    return;
  }
  try {
    const result = await getCaseSimulation({
      organizationId: getOrganizationId(req),
      actor: req.authUserId!,
      caseId,
    });
    res.json(result);
  } catch (error) {
    if (statusFor(error) === 500) {
      next(error);
      return;
    }
    res.status(statusFor(error)).json({ error: error instanceof Error ? error.message : "Unable to read simulation state." });
  }
});

router.post("/onboarding/cases/:caseId/simulation/simulate-next", async (req, res, next) => {
  const caseId = parseCaseId(req.params.caseId);
  if (caseId === null) {
    res.status(400).json({ error: "caseId must be a positive integer." });
    return;
  }
  const parsed = SimulateNextOnboardingCaseExchangeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!Number.isSafeInteger(parsed.data.expectedVersion) || parsed.data.expectedVersion < 0) {
    res.status(400).json({ error: "expectedVersion must be a non-negative safe integer." });
    return;
  }
  try {
    const result = await simulateNextCaseExchange({
      organizationId: getOrganizationId(req),
      actor: req.authUserId!,
      caseId,
      expectedVersion: parsed.data.expectedVersion,
      expectedGenerationId: parsed.data.expectedGenerationId,
      requestId: parsed.data.requestId,
    });
    res.json(result);
  } catch (error) {
    if (statusFor(error) === 500) {
      next(error);
      return;
    }
    res.status(statusFor(error)).json({ error: error instanceof Error ? error.message : "Unable to simulate next exchange." });
  }
});

router.post("/onboarding/cases/:caseId/simulation/restart", async (req, res, next) => {
  const caseId = parseCaseId(req.params.caseId);
  if (caseId === null) {
    res.status(400).json({ error: "caseId must be a positive integer." });
    return;
  }
  const parsed = RestartOnboardingCaseSimulationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!Number.isSafeInteger(parsed.data.expectedVersion) || parsed.data.expectedVersion < 0) {
    res.status(400).json({ error: "expectedVersion must be a non-negative safe integer." });
    return;
  }
  try {
    const result = await restartCaseSimulation({
      organizationId: getOrganizationId(req),
      actor: req.authUserId!,
      caseId,
      expectedVersion: parsed.data.expectedVersion,
      expectedGenerationId: parsed.data.expectedGenerationId,
      requestId: parsed.data.requestId,
    });
    res.json(result);
  } catch (error) {
    if (statusFor(error) === 500) {
      next(error);
      return;
    }
    res.status(statusFor(error)).json({ error: error instanceof Error ? error.message : "Unable to restart simulation." });
  }
});

router.post("/onboarding/cases/:caseId/simulation/send-email", async (req, res, next) => {
  const caseId = parseCaseId(req.params.caseId);
  if (caseId === null) {
    res.status(400).json({ error: "caseId must be a positive integer." });
    return;
  }
  const parsed = SimulateNextOnboardingCaseExchangeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await sendCurrentSimulationPrompt({
      organizationId: getOrganizationId(req),
      actor: req.authUserId!,
      caseId,
      expectedVersion: parsed.data.expectedVersion,
      expectedGenerationId: parsed.data.expectedGenerationId,
      requestId: parsed.data.requestId,
    });
    res.json(result);
  } catch (error) {
    if (statusFor(error) === 500) {
      next(error);
      return;
    }
    res.status(statusFor(error)).json({
      error: error instanceof Error ? error.message : "Unable to send the simulated prompt by email.",
    });
  }
});

export default router;