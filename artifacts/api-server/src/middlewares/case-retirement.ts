import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { db, onbCases } from "@workspace/db";
import { registeredDemoProfile } from "../lib/demo-principal";
import { isRestrictedHistoricalCase as isHistoricalTestRecord, operationalEligibilityInTransaction } from "../lib/onboarding/operational-eligibility";
import { getUatCaseIsolation } from "../lib/onboarding/uat-isolation";
import { isReadOnlyCaseExplanationRequest, isRetiredCaseCapabilityRequest, retiredCaseCapabilityResponse } from "../lib/retired-case-capabilities";

/** Runs after authentication, tenant verification and (for UAT) separate admission. */
export function createCaseRetirementFence(deps: {
  demoProfile?: typeof registeredDemoProfile;
  findCase?: (organizationId: string, id: number) => Promise<typeof onbCases.$inferSelect | undefined>;
  isolation?: typeof getUatCaseIsolation;
  operationalEligibility?: (row: typeof onbCases.$inferSelect) => Promise<{ allowed: boolean; reason: string | null }>;
} = {}): RequestHandler {
  return async (req, res, next) => {
  try {
    // These namespaces authenticate themselves or establish the session. They
    // are not case-test capabilities and must reach their existing handlers.
    if (req.path.startsWith("/onboarding/webhooks/") ||
        req.path.startsWith("/onboarding/ta-intake/") ||
        req.path === "/onboarding/demo-login" ||
        req.path === "/onboarding/demo-login/logout") {
      next();
      return;
    }
    if (!req.authUserId) {
      res.status(401).json({ message: "Authentication is required." });
      return;
    }
    if (isRetiredCaseCapabilityRequest(req.method, req.path)) {
      retiredCaseCapabilityResponse(req, res, next);
      return;
    }
    // Analysis still passes through audit, tenant/case access, retained-record
    // isolation and both final provider gates. It grants no operational power.
    if (isReadOnlyCaseExplanationRequest(req.method, req.path)) {
      next();
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (/^\/(?:onboarding\/(?:cases|standard-intake|batch-intake|batch-upload)|offboarding)(?:\/|$)/.test(req.path) &&
          await (deps.demoProfile ?? registeredDemoProfile)(req.authUserId)) {
        retiredCaseCapabilityResponse(req, res, next);
        return;
      }
      const match = /^\/(?:onboarding|offboarding)\/cases\/(\d+)(?:\/|$)/.exec(decodeURIComponent(req.path));
      if (match) {
        if (!req.organizationId) { res.status(403).json({ message: "A verified workspace is required." }); return; }
        const row = deps.findCase ? await deps.findCase(req.organizationId, Number(match[1])) :
          (await db.select().from(onbCases).where(and(
          eq(onbCases.organizationId, req.organizationId),
          eq(onbCases.id, Number(match[1])),
        )).limit(1))[0];
        if (row && (isHistoricalTestRecord(row) || (await (deps.isolation ?? getUatCaseIsolation)(row)).isolated)) {
          retiredCaseCapabilityResponse(req, res, next);
          return;
        }
        if (row) {
          const live = deps.operationalEligibility ? await deps.operationalEligibility(row) :
            await db.transaction(tx => operationalEligibilityInTransaction(tx, row));
          if (!live.allowed) { res.status(409).json({ message: live.reason }); return; }
        }
      }
    }
    next();
  } catch (error) { next(error); }
  };
}

export const caseRetirementFence = createCaseRetirementFence();
