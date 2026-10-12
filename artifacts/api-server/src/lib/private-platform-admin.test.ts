import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import {
  ADMIN_APPROVAL_KEY, ADMIN_COOKIE, ADMIN_LIFETIME_MS, approvedPrivateIdentity,
  recentMfa, signAdminGrant, verifyAdminGrant, isPlatformSuperAdmin,
  bindPlatformSuperAdminTenant, createPlatformAdminContext, sameAdminOrigin,
  type PrivateIdentity,
} from "./private-platform-admin";

const secret = "fixture-secret-that-is-long-enough-for-tests";
const identity = (): PrivateIdentity => ({
  id: "user_private_fixture", primaryEmailAddressId: "idn_fixture", twoFactorEnabled: true,
  emailAddresses: [{ id: "idn_fixture", verification: { status: "verified" } }],
  privateMetadata: { [ADMIN_APPROVAL_KEY]: {
    userId: "user_private_fixture", primaryEmailId: "idn_fixture", environment: "production",
    generation: "fixture-generation", decisionRef: "fixture-private-decision",
  } },
});
const grant = () => ({
  userId: "user_private_fixture", sessionId: "sess_fixture", generation: "fixture-generation",
  environment: "production", issuedAt: Date.now(), expiresAt: Date.now() + ADMIN_LIFETIME_MS,
});

test("approval binds verified primary provider identity, MFA and explicit environment", () => {
  assert.ok(approvedPrivateIdentity(identity(), "production"));
  for (const mutate of [
    (user: PrivateIdentity) => { user.privateMetadata = { demoAdministrator: true, email: "fictional@example.com" }; },
    (user: PrivateIdentity) => { user.twoFactorEnabled = false; },
    (user: PrivateIdentity) => { user.emailAddresses[0].verification = { status: "unverified" }; },
    (user: PrivateIdentity) => { user.primaryEmailAddressId = "idn_changed"; },
    (user: PrivateIdentity) => { user.id = "user_other"; },
  ]) {
    const user = identity(); mutate(user);
    assert.equal(approvedPrivateIdentity(user, "production"), null);
  }
  assert.equal(approvedPrivateIdentity(identity(), "development"), null);
  assert.equal(approvedPrivateIdentity(identity(), "unknown"), null);
  assert.equal(isPlatformSuperAdmin("user_private_fixture"), false);
});

test("both factors must be recent; missing, negative, nonfinite and stale claims fail closed", () => {
  assert.equal(recentMfa([0, 5]), true);
  for (const ages of [null, undefined, [-1, 0], [0, -1], [6, 0], [0, 6], [NaN, 0], [0, Infinity], ["0", 0], [0]]) {
    assert.equal(recentMfa(ages), false);
  }
});

test("grant signature rejects tampering, expiry, key rotation and widened lifetime", () => {
  const proof = grant(); proof.expiresAt = proof.issuedAt + ADMIN_LIFETIME_MS;
  const value = signAdminGrant(proof, secret);
  assert.deepEqual(verifyAdminGrant(value, secret, proof.issuedAt), proof);
  assert.equal(verifyAdminGrant(`${value}x`, secret), null);
  assert.equal(verifyAdminGrant(value, `${secret}x`), null);
  assert.equal(verifyAdminGrant(value, "short"), null);
  assert.equal(verifyAdminGrant(value, secret, proof.expiresAt), null);
  assert.equal(verifyAdminGrant(signAdminGrant({ ...proof, expiresAt: proof.expiresAt + 1 }, secret), secret), null);
});

test("MFA/provider session gates, request lifetime and tenant binding preserve isolation", async () => {
  const oldEnv = process.env.NODE_ENV, oldSecret = process.env.SESSION_SECRET;
  process.env.NODE_ENV = "production"; process.env.SESSION_SECRET = secret;
  try {
    let user = identity(), status = "active", demo = false, unavailable = false;
    const middleware = createPlatformAdminContext({
      getUser: async () => { if (unavailable) throw new Error("fixture-unavailable"); return user; },
      getSession: async () => ({ userId: user.id, status }),
      isDemo: async () => demo,
    });
    async function run(overrides: { sessionId?: string; fva?: unknown; proof?: string; userId?: string; method?: string; origin?: string } = {}, next = () => {}) {
      const proof = grant(); proof.expiresAt = proof.issuedAt + ADMIN_LIFETIME_MS;
      const headers = { origin: overrides.origin ?? "https://fixture.test", host: "fixture.test" };
      const req = {
        authUserId: overrides.userId ?? proof.userId,
        auth: Object.assign(() => ({
          userId: proof.userId, sessionId: overrides.sessionId ?? proof.sessionId,
          sessionClaims: { fva: overrides.fva ?? [0, 0] }, tokenType: "session_token",
        }), { [Symbol.for("@clerk/express.auth")]: true }),
        method: overrides.method ?? "GET",
        headers: { cookie: `${ADMIN_COOKIE}=${overrides.proof ?? signAdminGrant(proof, secret)}` },
        header: (key: string) => headers[key as keyof typeof headers],
      } as unknown as Request;
      let code = 200, called = false;
      const res = Object.assign(new EventEmitter(), {
        setHeader() { return this; },
        status(value: number) { code = value; return this; }, json() { return this; },
      }) as unknown as Response;
      await middleware(req, res, () => {
        called = true;
        assert.equal(isPlatformSuperAdmin(proof.userId), true);
        assert.equal(isPlatformSuperAdmin("user_other"), false);
        assert.equal(isPlatformSuperAdmin(proof.userId, "org_a"), false);
        bindPlatformSuperAdminTenant("org_a");
        assert.equal(isPlatformSuperAdmin(proof.userId, "org_a"), true);
        assert.equal(isPlatformSuperAdmin(proof.userId, "org_b"), false);
        next();
        res.emit("finish");
        assert.equal(isPlatformSuperAdmin(proof.userId), false);
      });
      assert.equal(isPlatformSuperAdmin(proof.userId), false);
      return { code, called };
    }
    assert.deepEqual(await run(), { code: 200, called: true });
    for (const override of [
      { sessionId: "sess_other" }, { fva: [-1, 0] }, { fva: [0, 16] },
      { userId: "user_other" }, { proof: "tampered" },
      { method: "POST", origin: "https://attacker.test" },
    ]) assert.deepEqual(await run(override), { code: 403, called: false });
    status = "revoked";
    assert.deepEqual(await run(), { code: 403, called: false });
    status = "active"; demo = true;
    assert.deepEqual(await run(), { code: 403, called: false });
    demo = false; user.privateMetadata = {};
    assert.deepEqual(await run(), { code: 403, called: false });
    user = identity();
    (user.privateMetadata[ADMIN_APPROVAL_KEY] as { generation: string }).generation = "rotated";
    assert.deepEqual(await run(), { code: 403, called: false });
    unavailable = true;
    assert.deepEqual(await run(), { code: 503, called: false });
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
  }
});

test("administrator requests require explicit same origin", () => {
  const request = (origin?: string, site?: string) => ({
    header: (name: string) => ({ origin, host: "fixture.test", "sec-fetch-site": site }[name]),
  }) as unknown as Request;
  assert.equal(sameAdminOrigin(request()), false);
  assert.equal(sameAdminOrigin(request("https://other.test")), false);
  assert.equal(sameAdminOrigin(request("https://fixture.test", "cross-site")), false);
  assert.equal(sameAdminOrigin(request("https://fixture.test", "same-origin")), true);
});
