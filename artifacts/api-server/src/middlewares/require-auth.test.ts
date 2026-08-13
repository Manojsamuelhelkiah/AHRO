import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { requireAuth, resolveReviewerName } from "./require-auth";

/**
 * Builds a fake request carrying the same `req.auth()` contract that
 * `clerkMiddleware` provides and `getAuth` consumes, plus a response
 * recorder, then runs `requireAuth` against them.
 */
function runRequireAuth(userId: string | null) {
  // `getAuth` only accepts an auth handler branded by clerkMiddleware; use
  // the same global-registry symbol to brand the stub.
  const authHandler = Object.assign(
    () => ({
      userId,
      sessionClaims: null,
      tokenType: "session_token",
    }),
    { [Symbol.for("@clerk/express.auth")]: true },
  );
  const req = { auth: authHandler } as unknown as Request;

  let statusCode: number | undefined;
  let jsonBody: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
      return this;
    },
  } as unknown as Response;

  let nextCalled = false;
  requireAuth(req, res, () => {
    nextCalled = true;
  });

  return { req, statusCode, jsonBody, nextCalled };
}

test("unauthenticated requests to guarded onboarding routes get 401", () => {
  const { statusCode, jsonBody, nextCalled } = runRequireAuth(null);
  assert.equal(statusCode, 401);
  assert.deepEqual(jsonBody, { message: "Authentication required" });
  assert.equal(nextCalled, false);
});

test("authenticated requests pass through with the signed-in user attached", () => {
  const { req, statusCode, nextCalled } = runRequireAuth("user_test_123");
  assert.equal(statusCode, undefined);
  assert.equal(nextCalled, true);
  assert.equal(req.authUserId, "user_test_123");
});

test("resolveReviewerName never returns a client-controlled value and falls back to the user id", async () => {
  // Unknown user id: Clerk lookup fails, so the raw id is recorded rather
  // than anything the client typed.
  const name = await resolveReviewerName("user_does_not_exist");
  assert.equal(name, "user_does_not_exist");
});
