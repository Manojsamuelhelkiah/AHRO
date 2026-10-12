import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { db, onbCases } from "@workspace/db";
import { registeredDemoProfile } from "../lib/demo-principal";
import { isHistoricalTestRecord } from "../lib/onboarding/historical-test-record";
import { getUatCaseIsolation } from "../lib/onboarding/uat-isolation";
import { isRetiredCaseCapabilityRequest, retiredCaseCapabilityResponse } from "../lib/retired-case-capabilities";

/** Runs after authentication, tenant verification and (for UAT) separate admission. */
export const caseRetirementFence: RequestHandler = async (req, res, next) => {
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
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (/^\/(?:onboarding\/(?:cases|standard-intake|batch-intake|batch-upload)|offboarding)(?:\/|$)/.test(req.path) &&
          await registeredDemoProfile(req.authUserId)) {
        retiredCaseCapabilityResponse(req, res, next);
        return;
      }
      const match = /^\/(?:onboarding|offboarding)\/cases\/(\d+)(?:\/|$)/.exec(decodeURIComponent(req.path));
      if (match) {
        if (!req.organizationId) { res.status(403).json({ message: "A verified workspace is required." }); return; }
        const [row] = await db.select().from(onbCases).where(and(
          eq(onbCases.organizationId, req.organizationId),
          eq(onbCases.id, Number(match[1])),
        )).limit(1);
        if (row && (isHistoricalTestRecord(row) || (await getUatCaseIsolation(row)).isolated)) {
          retiredCaseCapabilityResponse(req, res, next);
          return;
        }
      }
    }
    next();
  } catch (error) { next(error); }
};
