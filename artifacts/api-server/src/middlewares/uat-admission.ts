import type { RequestHandler } from "express";
import { isUatProtectedPath, requireLiveUatAdmission, uatSameOrigin } from "../lib/uat-admission";

export function createUatAdmissionGuard(checkAdmission = requireLiveUatAdmission): RequestHandler {
 return async (req, res, next) => {
  if (!isUatProtectedPath(req.path)) { next(); return; }
  res.set("Cache-Control", "no-store");
  if ((!["GET", "HEAD"].includes(req.method) || req.header("origin")) && !uatSameOrigin(req) ||
    ["cross-site", "same-site"].includes(req.header("sec-fetch-site") ?? "")) {
    res.status(403).json({ code: "UAT_SAME_ORIGIN_REQUIRED", message: "Same-origin UAT request required" }); return;
  }
  try {
    if (!await checkAdmission(req)) {
      res.set("X-UAT-Admission", "required");
      res.status(401).json({ code: "UAT_SIGN_IN_REQUIRED", message: "Sign in separately to UAT for this workspace" }); return;
    }
    next();
  } catch {
    res.set("X-UAT-Admission", "unavailable");
    // Provider or membership lookup outages must never turn into admission.
    res.status(503).json({ code: "UAT_VERIFICATION_UNAVAILABLE", message: "UAT access could not be verified. Sign in again when verification is available." });
  }
 };
}
export const requireUatAdmission = createUatAdmissionGuard();
