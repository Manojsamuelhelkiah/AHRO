import test from "node:test";
import assert from "node:assert/strict";
import express, { type Request, type Response, type RequestHandler } from "express";
import cookieParser from "cookie-parser";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { db, uatAdmissionsTable } from "@workspace/db";
import { createUatAuthRouter } from "../routes/uat-auth";
import { createUatAdmissionGuard } from "../middlewares/uat-admission";
import { admissionMatches, consumeUatChallenge, createActiveUatPrincipal, createLiveUatAdmissionVerifier,
  freshUatSignIn, isUatProtectedPath, newUatToken, tokenHash, UAT_COOKIE, UAT_CHALLENGE_COOKIE,
  uatCookieOptions, type UatAdmissionRecord, type UatPrincipal } from "./uat-admission";

const now = Date.now();
const principal: UatPrincipal = { id: "session_fresh", userId: "user_member", clientId: "client_1",
  status: "active", createdAt: now - 100, expireAt: now + 60_000, abandonAt: now + 60_000, actor: null };
function record(overrides: Partial<UatAdmissionRecord> = {}): UatAdmissionRecord {
  return { tokenHash: "hash", kind: "admission", userId: principal.userId, sessionId: principal.id,
    organizationId: "org_a", requestKey: "test", createdAt: new Date(now - 1_000),
    expiresAt: new Date(now + 60_000), revokedAt: null, consumedAt: null, ...overrides };
}

test("opaque capabilities are strong, hashed, Secure HttpOnly and usable in the preview iframe", () => {
  const token = newUatToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(tokenHash(token), token);
  assert.deepEqual(uatCookieOptions, { httpOnly: true, secure: true, sameSite: "none", path: "/" });
});
test("admission binds user, session, organization, expiry and revocation", () => {
  assert.ok(admissionMatches(record(), principal.userId, principal.id, "org_a", now));
  for (const change of [
    { userId: "other" }, { sessionId: "other" }, { organizationId: "other" }, { kind: "challenge" },
    { expiresAt: new Date(now) }, { revokedAt: new Date(now) }, { createdAt: new Date(now + 1) },
  ]) assert.equal(admissionMatches(record(change), principal.userId, principal.id, "org_a", now), false);
});
test("fresh proof rejects active Control Tower sessions, consumed challenges and all ticket/identifier strategies", () => {
  const challenge = record({ kind: "challenge", sessionId: "session_control" });
  for (const strategy of ["password", "email_code", "email_link", "passkey", "oauth_google", "saml"]) {
    assert.ok(freshUatSignIn(challenge, principal, { lastActiveSessionId: principal.id, lastAuthenticationStrategy: strategy }, now));
  }
  for (const strategy of [null, "ticket", "email_address", "username", "unknown"]) {
    assert.equal(freshUatSignIn(challenge, principal, { lastActiveSessionId: principal.id, lastAuthenticationStrategy: strategy }, now), false);
  }
  const client = { lastActiveSessionId: principal.id, lastAuthenticationStrategy: "password" };
  for (const change of [{ sessionId: principal.id }, { consumedAt: new Date(now) }, { revokedAt: new Date(now) },
    { expiresAt: new Date(now) }, { createdAt: new Date(principal.createdAt) }]) {
    assert.equal(freshUatSignIn(record({ ...challenge, ...change }), principal, client, now), false);
  }
  assert.equal(freshUatSignIn(challenge, principal, { ...client, lastActiveSessionId: "session_other" }, now), false);
});

test("live principal rejects removed membership, revoked/expired/impersonated sessions and test/admin principals", async () => {
  const req = { authUserId: principal.userId, organizationId: "org_a", organizationRole: "owner" } as Request;
  let member: { role: "member" } | null = { role: "member" };
  let live = { ...principal };
  const check = createActiveUatPrincipal(() => ({ userId: principal.userId, sessionId: principal.id }),
    async () => live, async () => member);
  assert.ok(await check(req));
  assert.equal(req.organizationRole, "member", "admission does not invent elevated authority");
  member = null; assert.equal(await check(req), null); member = { role: "member" };
  for (const change of [{ status: "revoked" }, { status: "ended" }, { userId: "other" },
    { expireAt: now - 1 }, { abandonAt: now - 1 }, { actor: { sub: "admin" } }]) {
    live = { ...principal, ...change }; assert.equal(await check(req), null);
  }
  req.authUserId = "development-admin";
  assert.equal(await check(req), null);
  assert.equal(await createActiveUatPrincipal(() => ({ userId: null, sessionId: null }))(req), null);
});

test("all testing reads, writes and downloads are gated; ordinary capabilities and Learning Guide remain independent", () => {
  const spec = readFileSync("../../lib/api-spec/openapi.yaml", "utf8");
  const paths = [...spec.matchAll(/^  (\/[^:]+):$/gm)].map(m => m[1]);
  const testing = paths.filter(p => p.startsWith("/onboarding/uat") || p.startsWith("/policies/evaluation"));
  assert.ok(testing.length >= 10);
  for (const path of testing) assert.ok(isUatProtectedPath(path), path);
  assert.ok(isUatProtectedPath("/POLICIES/EVALUATION/RUNS"));
  assert.ok(isUatProtectedPath("/ONBOARDING/UAT/FAIRNESS"));
  for (const path of ["/onboarding/learning-catalog", "/policies", "/policies/answer", "/policies/capabilities",
    "/onboarding/cases", "/onboarding/demo-controller", "/employee-vault"]) assert.equal(isUatProtectedPath(path), false);
  const routes = readFileSync("src/routes/index.ts", "utf8");
  assert.ok(routes.indexOf("router.use(requireUatAdmission)") < routes.indexOf("router.use(hrPolicyRouter)"));
  assert.ok(routes.indexOf("router.use(requireUatAdmission)") < routes.indexOf("router.use(onboardingUatTestCenterRouter)"));
});

test("actual HTTP routes require fresh proof, reject CSRF, protect downloads, enforce expiry/logout and pin both tabs", async () => {
  const rows = new Map<string, UatAdmissionRecord>();
  let current: UatPrincipal | null = { ...principal };
  let member = true;
  let strategy = "password";
  const checkPrincipal = createActiveUatPrincipal(req => ({
    userId: req.authUserId ?? null, sessionId: current?.id ?? null,
  }), async () => current!, async (_user, organization) => member && organization === "org_a" ? { role: "member" } : null);
  const live = createLiveUatAdmissionVerifier(checkPrincipal, async token => rows.get(tokenHash(token)));
  const auth: RequestHandler = (req, res, next) => {
    if (!current) { res.status(401).json({ message: "Signed out" }); return; }
    req.authUserId = current.userId; next();
  };
  const tenant: RequestHandler = (req, _res, next) => { req.organizationId = req.header("x-organization-id") || "org_a"; next(); };
  const authRouter = createUatAuthRouter({
    auth, tenant, principal: checkPrincipal, admission: live,
    client: async () => ({ lastActiveSessionId: current?.id ?? null, lastAuthenticationStrategy: strategy }),
    findRecord: async token => rows.get(tokenHash(token)),
    challenge: async (_req: Request, res: Response) => {
      const token = newUatToken();
      rows.set(tokenHash(token), record({ tokenHash: tokenHash(token), kind: "challenge", sessionId: "session_control" }));
      res.cookie(UAT_CHALLENGE_COOKIE, token, uatCookieOptions).json({ expiresAt: new Date(now + 60_000).toISOString() });
    },
    consume: async (token, admissionToken, session, organizationId, _key, at, expiresAt) => {
      const challenge = rows.get(tokenHash(token));
      if (!challenge || challenge.consumedAt) return false;
      challenge.consumedAt = at;
      rows.set(tokenHash(admissionToken), record({ tokenHash: tokenHash(admissionToken), sessionId: session.id, organizationId, expiresAt }));
      return true;
    },
    revoke: async (req, res) => {
      const row = rows.get(tokenHash(req.cookies?.[UAT_COOKIE] ?? ""));
      if (row) row.revokedAt = new Date();
      res.clearCookie(UAT_COOKIE, uatCookieOptions);
    },
  });
  const app = express(); app.use(cookieParser()); app.use(authRouter);
  app.use(auth, tenant, createUatAdmissionGuard(live));
  app.use((_req, res) => res.json({ permitted: true }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const request = (path: string, method = "GET", cookie = "", org = "org_a", requestOrigin = origin) =>
    fetch(`${origin}${path}`, { method, headers: { origin: requestOrigin, cookie, "x-organization-id": org, "sec-fetch-site": "same-origin" } });
  try {
    for (const path of ["/onboarding/uat", "/onboarding/uat/runs/run/evidence-report",
      "/onboarding/uat/runs/run/fixture", "/onboarding/uat/fairness/evidence-report", "/policies/evaluation/notifications"]) {
      assert.equal((await request(path)).status, 401, `Control Tower alone cannot read ${path}`);
    }
    assert.equal((await request("/policies/answer", "POST")).status, 200);
    assert.equal((await request("/onboarding/learning-catalog")).status, 200);
    assert.equal((await request("/uat-auth/challenge", "POST", "", "org_a", "https://attacker.invalid")).status, 403);
    const challengeResponse = await request("/uat-auth/challenge", "POST");
    const challengeCookie = challengeResponse.headers.get("set-cookie")!.split(";")[0];
    strategy = "ticket";
    assert.equal((await request("/uat-auth/admission", "POST", challengeCookie)).status, 401);
    strategy = "password";
    const admitted = await request("/uat-auth/admission", "POST", challengeCookie);
    assert.equal(admitted.status, 200);
    const admissionCookie = admitted.headers.get("set-cookie")!.match(/hro_uat_admission=[^;]+/)![0];
    assert.equal((await admitted.json() as { sessionId: string }).sessionId, principal.id);
    assert.equal((await request("/uat-auth/admission", "POST", challengeCookie)).status, 401, "single-use proof");
    assert.equal((await request("/onboarding/uat/fairness/evidence-report", "GET", admissionCookie)).status, 200);
    assert.equal((await request("/policies/evaluation/runs", "POST", admissionCookie, "org_a", "https://attacker.invalid")).status, 403);
    assert.equal((await request("/onboarding/uat", "GET", admissionCookie, "org_b")).status, 401, "other tab cannot retarget pinned scope");
    current = { ...principal, id: "session_replaced" };
    assert.equal((await request("/onboarding/uat", "GET", admissionCookie)).status, 401);
    current = { ...principal };
    member = false; assert.equal((await request("/policies/evaluation", "GET", admissionCookie)).status, 401); member = true;
    current.status = "revoked"; assert.equal((await request("/onboarding/uat", "GET", admissionCookie)).status, 401); current.status = "active";
    const row = [...rows.values()].find(r => r.kind === "admission")!;
    row.expiresAt = new Date(0); assert.equal((await request("/onboarding/uat", "GET", admissionCookie)).status, 401);
    row.expiresAt = new Date(Date.now() + 60_000);
    current = null;
    assert.equal((await request("/onboarding/uat", "GET", admissionCookie)).status, 401);
    assert.equal((await request("/uat-auth/admission", "DELETE", admissionCookie)).status, 204, "exit works after identity expiry");
    current = { ...principal };
    assert.equal((await request("/onboarding/uat", "GET", admissionCookie)).status, 401);
    assert.equal((await request("/policies/capabilities")).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("DB challenge claim is atomic across simultaneous admissions and refuses expired proofs", async () => {
  const token = newUatToken(), expiredToken = newUatToken();
  const admissionTokens = [newUatToken(), newUatToken()];
  const hashes = [token, expiredToken, ...admissionTokens].map(tokenHash);
  try {
    await db.insert(uatAdmissionsTable).values([
      record({ tokenHash: hashes[0], kind: "challenge", expiresAt: new Date(Date.now() + 60_000) }),
      record({ tokenHash: hashes[1], kind: "challenge", expiresAt: new Date(0) }),
    ]);
    const results = await Promise.all(admissionTokens.map(value => consumeUatChallenge(token, value, principal, "org_a", "test", new Date(), new Date(Date.now() + 60_000))));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await consumeUatChallenge(expiredToken, newUatToken(), principal, "org_a", "test", new Date(), new Date(now + 60_000)), false);
    const created = await db.select().from(uatAdmissionsTable).where(and(inArray(uatAdmissionsTable.tokenHash, hashes), eq(uatAdmissionsTable.kind, "admission")));
    assert.equal(created.length, 1);
  } finally { await db.delete(uatAdmissionsTable).where(inArray(uatAdmissionsTable.tokenHash, hashes)); }
});
