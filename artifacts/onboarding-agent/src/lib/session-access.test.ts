import assert from "node:assert/strict";
import test from "node:test";
import { accessDenied, sessionAccessGuidance } from "./session-access";

test("access guidance uses explicit server reasons, never account labels", () => {
  assert.match(sessionAccessGuidance({ status: 403, data: { code: "EMAIL_INTAKE_DEMO_RESTRICTED" } }).message, /Public Demo.*Super Admin.*initials/);
  for (const code of ["ADMIN_GRANT_INVALID", "ADMIN_REVOKED", "ADMIN_MFA_REQUIRED"]) {
    assert.equal(sessionAccessGuidance({ status: 403, data: { code } }).renew, true);
  }
  assert.match(sessionAccessGuidance({ status: 403, data: { code: "ORGANIZATION_ACCESS_DENIED" } }).message, /selected client/);
  assert.match(sessionAccessGuidance({ status: 401 }).message, /Sign in again/);
  assert.match(sessionAccessGuidance({ status: 503 }).message, /temporarily unavailable/);
  assert.equal(sessionAccessGuidance({ status: 403, data: { code: "fictional", name: "Super Admin" } }).renew, false);
});

test("definitive denial suppresses retries without disabling transient-error recovery", () => {
  for (const status of [401, 403]) assert.equal(accessDenied({ status }), true);
  for (const status of [404, 409, 429, 503]) assert.equal(accessDenied({ status }), false);
  assert.equal(accessDenied(null), false);
});
