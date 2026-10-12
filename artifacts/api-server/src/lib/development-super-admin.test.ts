import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes } from "node:crypto";
import {
  passwordMatches, developmentSuperAdminEnabled, verifyDevelopmentAdminProof,
  allowDevelopmentAdminAttempt, isDevelopmentSuperAdmin,
  developmentAdminAttemptBlocked,
} from "./development-super-admin";

test("credentials are compared exactly without whitespace normalization", () => {
  const secret = randomBytes(24).toString("base64url");
  assert.equal(passwordMatches(secret, secret), true);
  assert.equal(passwordMatches(`${secret} `, secret), false);
  assert.equal(passwordMatches(undefined, secret), false);
  assert.equal(passwordMatches(secret, undefined), false);
});

test("proof rejects tampering, expiry, extended lifetime and secret rotation", () => {
  const secret = randomBytes(24).toString("base64url");
  const now = Date.now();
  const proof = { userId: "fictional-admin", issuedAt: now, expiresAt: now + 4 * 60 * 60 * 1000, sessionId: "fictional-session" };
  const encode = (value: unknown) => {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  };
  const signed = encode(proof);
  assert.deepEqual(verifyDevelopmentAdminProof(signed, secret, now), proof);
  assert.equal(verifyDevelopmentAdminProof(`${signed}x`, secret, now), null);
  assert.equal(verifyDevelopmentAdminProof(signed, `${secret}x`, now), null);
  assert.equal(verifyDevelopmentAdminProof(signed, secret, proof.expiresAt), null);
  assert.equal(verifyDevelopmentAdminProof(encode({ ...proof, expiresAt: proof.expiresAt + 1 }), secret, now), null);
  assert.equal(verifyDevelopmentAdminProof("malformed", secret, now), null);
});

test("five attempts are allowed per lockout window", () => {
  const key = randomBytes(24).toString("hex");
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(developmentAdminAttemptBlocked(key, 1000), false);
    assert.equal(allowDevelopmentAdminAttempt(key, 1000), true);
  }
  assert.equal(developmentAdminAttemptBlocked(key, 1000), true);
  assert.equal(allowDevelopmentAdminAttempt(key, 1000), false);
  assert.equal(allowDevelopmentAdminAttempt(key, 1000 + 15 * 60 * 1000), true);
});

test("development configuration never elevates identity alone and is disabled in production", () => {
  const previousMode = process.env.NODE_ENV;
  const previousSecret = process.env.DEV_SUPER_ADMIN_PASSWORD;
  try {
    process.env.DEV_SUPER_ADMIN_PASSWORD = randomBytes(24).toString("hex");
    process.env.NODE_ENV = "development";
    assert.equal(developmentSuperAdminEnabled(), true);
    assert.equal(isDevelopmentSuperAdmin("fictional-admin"), false);
    process.env.NODE_ENV = "production";
    assert.equal(developmentSuperAdminEnabled(), false);
    delete process.env.DEV_SUPER_ADMIN_PASSWORD;
    process.env.NODE_ENV = "development";
    assert.equal(developmentSuperAdminEnabled(), false);
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (previousSecret === undefined) delete process.env.DEV_SUPER_ADMIN_PASSWORD; else process.env.DEV_SUPER_ADMIN_PASSWORD = previousSecret;
  }
});
