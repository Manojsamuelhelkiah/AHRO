import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  createInternalSmokeSignature,
  createPricingRateManagerGuard,
  createRequireAuth,
  hasCommercialRateManagerPermission,
  requireAuth,
  resolveReviewerName,
} from "./require-auth";

/**
 * Builds a fake request carrying the same `req.auth()` contract that
 * `clerkMiddleware` provides and `getAuth` consumes, plus a response
 * recorder, then runs `requireAuth` against them.
 */
function runRequireAuth(
  userId: string | null,
  requestOptions: {
    headers?: Record<string, string>;
    method?: string;
    originalUrl?: string;
    nodeEnv?: string;
    sessionSecret?: string;
    now?: () => number;
  } = {},
) {
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
  const headers = requestOptions.headers ?? {};
  const req = {
    auth: authHandler,
    method: requestOptions.method ?? "GET",
    originalUrl: requestOptions.originalUrl ?? "/api/intents",
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;

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
  const authMiddleware =
    requestOptions.nodeEnv === undefined &&
    requestOptions.sessionSecret === undefined &&
    requestOptions.now === undefined
      ? requireAuth
      : createRequireAuth({
          nodeEnv: requestOptions.nodeEnv,
          sessionSecret: requestOptions.sessionSecret,
          now: requestOptions.now,
        });
  authMiddleware(req, res, () => {
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

const smokeNow = 1_750_000_000_000;
const smokeSecret = "test-session-secret-with-sufficient-entropy";
const smokeUserId = "internal_intent_routing_smoke";

function smokeHeaders({
  timestamp = smokeNow.toString(),
  path = "/api/intents",
  method = "GET",
  userId = smokeUserId,
} = {}) {
  return {
    "x-internal-smoke-user-id": userId,
    "x-internal-smoke-timestamp": timestamp,
    "x-internal-smoke-signature": createInternalSmokeSignature({
      secret: smokeSecret,
      method,
      path,
      timestamp,
      userId,
    }),
  };
}

test("valid short-lived internal smoke signatures authenticate in development", () => {
  const result = runRequireAuth(null, {
    headers: smokeHeaders(),
    nodeEnv: "development",
    sessionSecret: smokeSecret,
    now: () => smokeNow,
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.authUserId, smokeUserId);
});

test("expired internal smoke signatures are rejected", () => {
  const timestamp = (smokeNow - 60_001).toString();
  const result = runRequireAuth(null, {
    headers: smokeHeaders({ timestamp }),
    nodeEnv: "development",
    sessionSecret: smokeSecret,
    now: () => smokeNow,
  });
  assert.equal(result.statusCode, 401);
  assert.equal(result.nextCalled, false);
});

test("tampered internal smoke signatures are rejected", () => {
  const headers = smokeHeaders();
  headers["x-internal-smoke-user-id"] = "caller_controlled_user";
  const result = runRequireAuth(null, {
    headers,
    nodeEnv: "development",
    sessionSecret: smokeSecret,
    now: () => smokeNow,
  });
  assert.equal(result.statusCode, 401);
  assert.equal(result.nextCalled, false);
});

test("internal smoke signatures are rejected outside development", () => {
  for (const nodeEnv of ["test", "staging", "developmnt", "production"]) {
    const result = runRequireAuth(null, {
      headers: smokeHeaders(),
      nodeEnv,
      sessionSecret: smokeSecret,
      now: () => smokeNow,
    });
    assert.equal(result.statusCode, 401, `NODE_ENV=${nodeEnv}`);
    assert.equal(result.nextCalled, false, `NODE_ENV=${nodeEnv}`);
  }
});

test("internal smoke signatures are rejected when NODE_ENV is unset", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const result = runRequireAuth(null, {
      headers: smokeHeaders(),
      sessionSecret: smokeSecret,
      now: () => smokeNow,
    });
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

test("resolveReviewerName never returns a client-controlled value and falls back to the user id", async () => {
  // Unknown user id: Clerk lookup fails, so the raw id is recorded rather
  // than anything the client typed.
  const name = await resolveReviewerName("user_does_not_exist");
  assert.equal(name, "user_does_not_exist");
});

test("commercial rate management requires an exact server-controlled private-metadata grant", () => {
  assert.equal(
    hasCommercialRateManagerPermission({ commercialRateManager: true }),
    true,
  );
  assert.equal(
    hasCommercialRateManagerPermission({ commercialRateManager: "true" }),
    false,
  );
  assert.equal(hasCommercialRateManagerPermission({ role: "admin" }), false);
  assert.equal(hasCommercialRateManagerPermission(null), false);
});

async function runPricingRateManagerRoute(
  userId: string | null,
  checkPermission: (userId: string) => Promise<boolean>,
) {
  const authResult = runRequireAuth(userId);
  if (!authResult.nextCalled) return authResult;

  let statusCode: number | undefined;
  let jsonBody: unknown;
  let nextCalled = false;
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
  await createPricingRateManagerGuard(checkPermission)(
    authResult.req,
    res,
    () => {
      nextCalled = true;
    },
  );
  return { statusCode, jsonBody, nextCalled };
}

test("pricing-rate-set mutation route rejects signed-in users without manager permission", async () => {
  const result = await runPricingRateManagerRoute(
    "user_untrusted",
    async () => false,
  );
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.jsonBody, {
    message: "Commercial rate manager permission required",
  });
  assert.equal(result.nextCalled, false);
});

test("pricing-rate-set mutation route admits designated commercial managers", async () => {
  const result = await runPricingRateManagerRoute(
    "user_rate_manager",
    async (userId) => userId === "user_rate_manager",
  );
  assert.equal(result.statusCode, undefined);
  assert.equal(result.nextCalled, true);
});

test("pricing-rate-set mutation route fails closed when permission lookup fails", async () => {
  const result = await runPricingRateManagerRoute(
    "user_rate_manager",
    async () => {
      throw new Error("identity provider unavailable");
    },
  );
  assert.equal(result.statusCode, 403);
  assert.equal(result.nextCalled, false);
});
