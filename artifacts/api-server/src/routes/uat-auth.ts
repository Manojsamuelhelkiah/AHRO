import { Router, type RequestHandler } from "express";
import { clerkClient } from "@clerk/express";
import { requireAuth } from "../middlewares/require-auth";
import { requireTenantContext } from "../middlewares/tenant-context";
import { activeUatPrincipal, consumeUatChallenge, createUatChallenge, findUatRecord, freshUatSignIn, newUatToken, readUatCookie,
  requireLiveUatAdmission, revokeUatCookie, tokenHash, UAT_ADMISSION_MS, UAT_CHALLENGE_COOKIE, UAT_COOKIE,
  uatCookieOptions, uatSameOrigin } from "../lib/uat-admission";

const defaultDependencies = {
  auth: requireAuth as RequestHandler, tenant: requireTenantContext as RequestHandler, principal: activeUatPrincipal,
  challenge: createUatChallenge, findRecord: findUatRecord, consume: consumeUatChallenge,
  admission: requireLiveUatAdmission, revoke: revokeUatCookie,
  client: async (id: string) => {
    const client = await clerkClient.clients.getClient(id);
    return { lastActiveSessionId: client.lastActiveSessionId, lastAuthenticationStrategy: client.lastAuthenticationStrategy as string | null };
  },
};
export function createUatAuthRouter(deps = defaultDependencies) {
const router = Router();
router.use("/uat-auth", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (((req.method !== "GET" || req.header("origin")) && !uatSameOrigin(req)) ||
    ["cross-site", "same-site"].includes(req.header("sec-fetch-site") ?? "")) {
    res.status(403).json({ message: "Same-origin UAT request required" }); return;
  }
  next();
});
router.post("/uat-auth/challenge", async (req, res, next) => {
  try { await deps.challenge(req, res); } catch (error) { next(error); }
});
// Exit remains possible after membership removal or Clerk expiry.
router.delete("/uat-auth/admission", async (req, res, next) => {
  try { await deps.revoke(req, res); res.status(204).end(); } catch (error) { next(error); }
});
router.get("/uat-auth/admission", deps.auth, deps.tenant, async (req, res) => {
  try {
    const row = await deps.admission(req);
    if (!row) { res.status(401).json({ code: "UAT_SIGN_IN_REQUIRED", message: "Separate UAT sign-in required" }); return; }
    res.json({ organizationId: row.organizationId, userId: row.userId, sessionId: row.sessionId, expiresAt: row.expiresAt.toISOString() });
  } catch { res.status(503).json({ message: "UAT verification unavailable" }); }
});
router.post("/uat-auth/admission", deps.auth, deps.tenant, async (req, res) => {
  try {
    const token = readUatCookie(req, UAT_CHALLENGE_COOKIE);
    const session = await deps.principal(req);
    if (!token || !session) { res.status(401).json({ message: "Fresh UAT sign-in and active workspace membership required" }); return; }
    const challenge = await deps.findRecord(token);
    const client = await deps.client(session.clientId);
    if (!freshUatSignIn(challenge, session, client)) {
      res.status(401).json({ message: "Start UAT sign-in and authenticate again. Existing sessions and demo tickets cannot admit UAT." }); return;
    }
    const admissionToken = newUatToken();
    const now = new Date();
    const expiresAt = new Date(Math.min(now.getTime() + UAT_ADMISSION_MS, session.expireAt, session.abandonAt));
    const created = await deps.consume(token, admissionToken, session, req.organizationId!, tokenHash(req.ip ?? "unknown"), now, expiresAt);
    if (!created) { res.status(401).json({ message: "UAT sign-in challenge has already been used" }); return; }
    res.clearCookie(UAT_CHALLENGE_COOKIE, uatCookieOptions);
    res.cookie(UAT_COOKIE, admissionToken, { ...uatCookieOptions, maxAge: expiresAt.getTime() - now.getTime() });
    res.json({ organizationId: req.organizationId, userId: session.userId, sessionId: session.id, expiresAt: expiresAt.toISOString() });
  } catch { res.status(503).json({ message: "UAT sign-in verification unavailable" }); }
});
return router;
}
export default createUatAuthRouter();
