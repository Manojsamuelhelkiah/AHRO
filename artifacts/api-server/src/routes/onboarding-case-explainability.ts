import { Router, type IRouter, type Request, type Response } from "express";
import { ExplainOnboardingCaseBody } from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import {
  collectCaseExplainabilityEvidence,
  findExplainableCase,
  type CaseExplainabilityEvidence,
} from "../lib/onboarding/case-explainability-evidence";
import {
  explainCase,
  ExplainabilityUnavailableError,
  type ExplainabilityCompletion,
} from "../lib/onboarding/case-explainability";
import { logger } from "../lib/logger";

const MAX_IN_FLIGHT_PER_USER = 2;
const MAX_REQUESTS_PER_MINUTE = 20;
const RATE_WINDOW_MS = 60_000;
const MODEL_ERRORS = "Case explanation is temporarily unavailable. Please retry.";

type ExplainableCase = NonNullable<Awaited<ReturnType<typeof findExplainableCase>>>;
type EvidenceCollector = (
  organizationId: string,
  caseId: number,
  knownCase?: ExplainableCase,
) => Promise<CaseExplainabilityEvidence | null>;
type CaseLookup = (
  organizationId: string,
  caseId: number,
) => Promise<ExplainableCase | null>;

export type CaseExplainabilityRouterDeps = {
  findCase?: CaseLookup;
  collectEvidence?: EvidenceCollector;
  complete?: ExplainabilityCompletion;
};

type RateState = {
  windowStartedAt: number;
  requests: number;
  inFlight: number;
};

const rateStates = new Map<string, RateState>();

function takeRequestSlot(key: string): boolean {
  const now = Date.now();
  const prior = rateStates.get(key);
  const state = !prior || now - prior.windowStartedAt >= RATE_WINDOW_MS
    ? { windowStartedAt: now, requests: 0, inFlight: 0 }
    : prior;
  if (state.requests >= MAX_REQUESTS_PER_MINUTE || state.inFlight >= MAX_IN_FLIGHT_PER_USER) {
    rateStates.set(key, state);
    return false;
  }
  state.requests += 1;
  state.inFlight += 1;
  rateStates.set(key, state);
  return true;
}

function releaseRequestSlot(key: string): void {
  const state = rateStates.get(key);
  if (!state) return;
  state.inFlight = Math.max(0, state.inFlight - 1);
  if (state.inFlight === 0 && Date.now() - state.windowStartedAt >= RATE_WINDOW_MS) {
    rateStates.delete(key);
  }
}

function caseId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}

export function createOnboardingCaseExplainabilityRouter(
  deps: CaseExplainabilityRouterDeps = {},
): IRouter {
  const lookup = deps.findCase ?? findExplainableCase;
  const collect = deps.collectEvidence ?? collectCaseExplainabilityEvidence;

  const router: IRouter = Router();
  router.post("/onboarding/cases/:id/explain", async (req, res, next) => {
    const id = caseId(req);
    if (id === null) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    try {
      const organizationId = getOrganizationId(req);
      // This is deliberately the first case-scoped operation. In particular,
      // do not collect readiness, communications, or model context before it.
      const ownedCase = await lookup(organizationId, id);
      if (!ownedCase) {
        res.status(404).json({ message: "Case not found" });
        return;
      }

      const body = ExplainOnboardingCaseBody.parse(req.body);
      const question = body.question.trim();
      if (!question) {
        res.status(400).json({ message: "Question must not be blank." });
        return;
      }

      const slotKey = `${userId}:${organizationId}`;
      if (!takeRequestSlot(slotKey)) {
        res.status(429).json({ message: "Too many case explanation requests. Please retry shortly." });
        return;
      }
      try {
        const evidence = await collect(organizationId, id, ownedCase);
        if (!evidence) {
          res.status(404).json({ message: "Case not found" });
          return;
        }
        const answer = await explainCase(
          ownedCase,
          question,
          body.history,
          evidence,
          deps.complete,
        );
        res.json(answer);
      } catch (error) {
        if (error instanceof ExplainabilityUnavailableError) {
          logger.error({
            err: error,
            explainability: error.metadata,
            organizationId,
            caseId: id,
            userId,
          }, "Case explanation model unavailable or malformed");
          res.status(503).json({ message: MODEL_ERRORS });
          return;
        }
        next(error);
      } finally {
        releaseRequestSlot(slotKey);
      }
    } catch (error) {
      if (isValidationError(error)) {
        res.status(400).json({ message: "Invalid case explanation request." });
        return;
      }
      next(error);
    }
  });
  return router;
}

export default createOnboardingCaseExplainabilityRouter();