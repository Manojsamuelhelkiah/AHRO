/**
 * Credential/provider adapter for the isolated browser-regression process only.
 * Never imported by app.ts, production bundles or managed development servers.
 * The actual admission router, opaque DB store, membership checks and domain
 * routes run unchanged. Only Clerk network operations are replaced.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

export async function installUatBrowserAdapter(app, { dbPackage, sessions, userId }) {
  if (process.env.NODE_ENV !== "test" || process.env.ONBOARDING_E2E_TEST !== "true") {
    throw new Error("UAT browser adapter requires an isolated test process");
  }
  const admission = await import("./src/lib/uat-admission.ts");
  const { createUatAuthRouter } = await import("./src/routes/uat-auth.ts");
  const requireAuth = (req, res, next) => {
    const authenticatedUser = sessions.get(req.cookies?.browser_e2e_session);
    if (!authenticatedUser) { res.status(401).json({ message: "Signed out of the isolated browser session" }); return; }
    req.authUserId = authenticatedUser;
    next();
  };
  const { requireTenantContext } = await import("./src/middlewares/tenant-context.ts");
  const { createUatAdmissionGuard } = await import("./src/middlewares/uat-admission.ts");
  const { default: runs } = await import("./src/routes/onboarding-uat-test-center.ts");
  const { default: fairness } = await import("./src/routes/onboarding-fairness.ts");
  const { default: policies } = await import("./src/routes/hr-policies.ts");
  const { db, uatAdmissionsTable } = dbPackage;
  const identities = new Map();
  const identity = req => identities.get(req.cookies?.browser_e2e_session);
  const principal = admission.createActiveUatPrincipal(req => ({
    userId: req.authUserId ?? null, sessionId: identity(req)?.id ?? null,
  }), async id => {
    const value = [...identities.values()].find(s => s.id === id);
    if (!value) throw new Error("Unknown test identity");
    return value;
  });
  const live = admission.createLiveUatAdmissionVerifier(principal);
  app.get("/api/test/uat-identity", (req, res) => {
    const session = identity(req);
    const oldUser = sessions.get(req.cookies?.browser_e2e_session);
    res.json(session ? { userId: session.userId, sessionId: session.id }
      : oldUser ? { userId: oldUser, sessionId: req.cookies.browser_e2e_session } : {});
  });
  app.post("/api/test/uat-credential", (req, res) => {
    const id = randomUUID();
    const createdAt = Date.now();
    identities.set(id, { id, userId, clientId: id, status: "active", actor: null,
      createdAt, expireAt: createdAt + 3_600_000, abandonAt: createdAt + 3_600_000 });
    sessions.set(id, userId);
    res.cookie("browser_e2e_session", id, { httpOnly: true, sameSite: "lax", secure: false, path: "/" });
    res.json({ userId, sessionId: id });
  });
  app.post("/api/test/uat-expire", async (req, res) => {
    const token = admission.readUatCookie(req, admission.UAT_COOKIE);
    if (token) await db.update(uatAdmissionsTable).set({ expiresAt: new Date(0) })
      .where(eq(uatAdmissionsTable.tokenHash, admission.tokenHash(token)));
    res.status(204).end();
  });
  const factory = createUatAuthRouter({
    auth: requireAuth, tenant: requireTenantContext, principal, admission: live,
    revoke: admission.revokeUatCookie, findRecord: admission.findUatRecord,
    consume: admission.consumeUatChallenge,
    client: async id => ({ lastActiveSessionId: id, lastAuthenticationStrategy: "password" }),
    challenge: async (req, res) => {
      const token = admission.newUatToken();
      const expiresAt = new Date(Date.now() + admission.UAT_CHALLENGE_MS);
      await db.insert(uatAdmissionsTable).values({
        tokenHash: admission.tokenHash(token), kind: "challenge",
        sessionId: req.cookies?.browser_e2e_session ?? null, requestKey: "browser-isolated",
        createdAt: new Date(), expiresAt,
      });
      await admission.revokeUatCookie(req, res);
      res.cookie(admission.UAT_CHALLENGE_COOKIE, token, { ...admission.uatCookieOptions, maxAge: admission.UAT_CHALLENGE_MS });
      res.json({ expiresAt: expiresAt.toISOString() });
    },
  });
  app.use("/api", factory);
  const protectedRouter = express.Router();
  protectedRouter.use((req, _res, next) => admission.isUatProtectedPath(req.path) ? next() : next("router"));
  protectedRouter.use(requireAuth, requireTenantContext, createUatAdmissionGuard(live));
  protectedRouter.use(runs, fairness, policies);
  app.use("/api", protectedRouter);
}
