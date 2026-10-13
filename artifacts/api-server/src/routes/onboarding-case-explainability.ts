import { Router, type IRouter, type Request, type Response } from "express";
import { ExplainOnboardingCaseBody } from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import { resolveEffectiveAccess } from "../lib/access-governance";
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
import { caseAnalysisRestriction } from "../lib/onboarding/case-analysis-eligibility";
import { isReadOnlyCaseExplanationRequest } from "../lib/retired-case-capabilities";
import { defaultCompletion } from "../lib/onboarding/case-explainability";

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
type CaseAccessLookup = (
  organizationId: string,
  userId: string,
  caseId: number,
) => Promise<Pick<Awaited<ReturnType<typeof resolveEffectiveAccess>>, "allows">>;

export type CaseExplainabilityRouterDeps = {
  findCase?: CaseLookup;
  collectEvidence?: EvidenceCollector;
  resolveAccess?: CaseAccessLookup;
  complete?: ExplainabilityCompletion;
  analysisRestriction?: typeof caseAnalysisRestriction;
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
  const resolveAccess = deps.resolveAccess ?? (async (organizationId, userId, caseId) =>
    resolveEffectiveAccess({
      organizationId,
      principalType: "human",
      principalId: userId,
      caseId,
      purpose: "onboarding-case-explainability",
    }));

  const router: IRouter = Router();
  router.post("/onboarding/cases/:id/explain", async (req, res, next) => {
    const id = caseId(req);
    if (id === null || !isReadOnlyCaseExplanationRequest(req.method, req.path)) {
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
      const effectiveAccess = await resolveAccess(organizationId, userId, id);
      if (!effectiveAccess.allows.includes("flow.case.read")) {
        res.status(403).json({
          message: "Current case-read access is required for case explainability.",
          code: "CASE_ACCESS_REQUIRED",
        });
        return;
      }
      const restriction = await (deps.analysisRestriction ?? caseAnalysisRestriction)(ownedCase);
      if (restriction) {
        res.status(403).json({ code: "CASE_ANALYSIS_RESTRICTED", message: restriction, retryable: false });
        return;
      }
      const explainableCase = effectiveAccess.allows.includes("data.case.profile.read")
        ? ownedCase
        : { ...ownedCase, joiningDate: "Restricted" };

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
        // Recheck at each model stage and before returning private sources.
        // Revocation or a changed case projection discards this answer.
        const assertCurrentRead = async () => {
          const current = await lookup(organizationId, id);
          const access = await resolveAccess(organizationId, userId, id);
          if (!current || !access.allows.includes("flow.case.read") ||
            effectiveAccess.allows.includes("data.case.profile.read") !== access.allows.includes("data.case.profile.read") ||
            JSON.stringify(current) !== JSON.stringify(ownedCase) ||
            await (deps.analysisRestriction ?? caseAnalysisRestriction)(current)) {
            throw new ExplainabilityUnavailableError(undefined, { stage: "generation", code: "case_analysis_scope_changed" });
          }
        };
        const evidence = await collect(organizationId, id, explainableCase);
        if (!evidence) {
          res.status(404).json({ message: "Case not found" });
          return;
        }
        const answer = await explainCase(
          explainableCase,
          question,
          body.history,
          evidence,
          async (...args) => {
            await assertCurrentRead();
            return (deps.complete ?? defaultCompletion(explainableCase))(...args);
          },
        );
        await assertCurrentRead();
        res.json(answer);
      } catch (error) {
        if (error instanceof ExplainabilityUnavailableError) {
          const restrictions: Record<string, string> = {
            case_analysis_scope_changed: "Case access or evidence changed during analysis. Reopen the case with current access before asking again.",
            provider_dispatch_denied: "Ask AI is unavailable because external AI-provider use is disabled by the current safety policy.",
            provider_governance_or_lifecycle_denied: "Ask AI is unavailable because current provider approval, record isolation, or data-disclosure policy does not permit AI analysis. Review the permitted case records directly.",
            sensitive_external_disclosure_blocked: "This question or its evidence includes restricted content that cannot be sent to an AI provider. Ask about general case status without private details, or review permitted records directly.",
          };
          const message = restrictions[error.metadata?.code ?? ""];
          if (message) {
            res.status(403).json({ code: error.metadata?.code, message, retryable: false });
            return;
          }
          logger.error({
            err: error,
            explainability: error.metadata,
            organizationId,
            caseId: id,
            userId,
          }, "Case explanation model unavailable or malformed");
          res.status(503).json({ message: MODEL_ERRORS, retryable: true });
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