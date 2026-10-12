import { Router } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { requireAuth } from "../middlewares/require-auth";
import {
  ADMIN_COOKIE, ADMIN_LIFETIME_MS, adminCookieOptions, approvedPrivateIdentity,
  recentMfa, sameAdminOrigin, signAdminGrant,
} from "../lib/private-platform-admin";
import { rawRegisteredDemoProfile } from "../lib/demo-principal";
import { GetPrivateAdminEligibilityResponse, ActivatePrivateAdminSessionResponse, RevokePrivateAdminSessionResponse } from "@workspace/api-zod";
import { appendProtectedAudit } from "../lib/onboarding/protected-audit";

const router = Router();
// End-access and renewal must work even when the old grant is expired/revoked.
router.use("/platform-admin/session", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.header("sec-fetch-site") === "cross-site" ||
    (req.header("origin") && !sameAdminOrigin(req)) ||
    (req.method !== "GET" && !sameAdminOrigin(req))) {
    res.status(403).json({ message: "Same-site administrator request required." }); return;
  }
  const cookie = req.headers.cookie;
  req.headers.cookie = cookie?.split(";").filter(v => !v.trim().startsWith(`${ADMIN_COOKIE}=`)).join(";");
  requireAuth(req, res, () => { req.headers.cookie = cookie; next(); });
});
router.get("/platform-admin/session", async (req, res): Promise<void> => {
  const user = await clerkClient.users.getUser(req.authUserId!);
  const eligible = Boolean(approvedPrivateIdentity(user)) && !await rawRegisteredDemoProfile(user.id);
  res.json(GetPrivateAdminEligibilityResponse.parse({
    eligible, userId: user.id, primaryEmailId: user.primaryEmailAddressId,
    primaryEmailVerified: user.emailAddresses.some(email =>
      email.id === user.primaryEmailAddressId && email.verification?.status === "verified"),
    mfaEnrolled: user.twoFactorEnabled, mfaRequired: true, lifetimeMinutes: 15,
  }));
});
router.post("/platform-admin/session", async (req, res): Promise<void> => {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    res.status(503).json({ message: "Private administrator signing is not configured." }); return;
  }
  const auth = getAuth(req);
  const user = await clerkClient.users.getUser(req.authUserId!);
  const approval = approvedPrivateIdentity(user);
  if (!approval || await rawRegisteredDemoProfile(user.id) || !auth.sessionId) {
    res.status(403).json({ message: "An explicitly approved private, verified account is required." }); return;
  }
  if (!recentMfa(auth.sessionClaims?.fva)) {
    res.status(403).json({
      clerk_error: { type: "forbidden", reason: "reverification-error",
        metadata: { reverification: { level: "multi_factor", afterMinutes: 5 } } },
      message: "Verify both factors before activating administrator access.",
    }); return;
  }
  const session = await clerkClient.sessions.getSession(auth.sessionId);
  if (session.status !== "active" || session.userId !== user.id) {
    res.status(403).json({ message: "Active provider session required." }); return;
  }
  const issuedAt = Date.now();
  await appendProtectedAudit({
    organizationId: "platform-audit", actorId: user.id, actorKind: "authenticated",
    actorAuthority: "private-platform-admin:approved-mfa", action: "platform-admin.session-activated",
    outcome: "success", objectType: "platform-admin-session", source: "http",
    payload: { safeStatus: process.env.NODE_ENV, approvalVersion: approval.generation },
  });
  res.cookie(ADMIN_COOKIE, signAdminGrant({
    userId: user.id, sessionId: session.id, generation: approval.generation,
    environment: approval.environment, issuedAt, expiresAt: issuedAt + ADMIN_LIFETIME_MS,
  }, secret), { ...adminCookieOptions(), maxAge: ADMIN_LIFETIME_MS });
  res.json(ActivatePrivateAdminSessionResponse.parse({ active: true, expiresAt: new Date(issuedAt + ADMIN_LIFETIME_MS).toISOString() }));
});
router.delete("/platform-admin/session", async (req, res): Promise<void> => {
  const sessionId = getAuth(req).sessionId;
  // Revocation is durable at the provider, not just cookie removal.
  if (sessionId) await clerkClient.sessions.revokeSession(sessionId);
  res.clearCookie(ADMIN_COOKIE, adminCookieOptions());
  res.json(RevokePrivateAdminSessionResponse.parse({ active: false }));
});
export default router;
