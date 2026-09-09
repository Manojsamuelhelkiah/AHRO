import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { clerkClient, getAuth } from "@clerk/express";

export const INTERNAL_SMOKE_USER_HEADER = "x-internal-smoke-user-id";
export const INTERNAL_SMOKE_TIMESTAMP_HEADER = "x-internal-smoke-timestamp";
export const INTERNAL_SMOKE_SIGNATURE_HEADER = "x-internal-smoke-signature";
export const INTERNAL_SMOKE_MAX_AGE_MS = 60_000;
export const INTERNAL_SMOKE_USER_ID = "internal_intent_routing_smoke";
const INTERNAL_SMOKE_MAX_FUTURE_SKEW_MS = 5_000;
const INTERNAL_SMOKE_KEY_CONTEXT = "api-internal-smoke-auth:v1";

type InternalSmokeSignatureInput = {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  userId: string;
};

export function createInternalSmokeSignature({
  secret,
  method,
  path,
  timestamp,
  userId,
}: InternalSmokeSignatureInput): string {
  const key = createHmac("sha256", secret)
    .update(INTERNAL_SMOKE_KEY_CONTEXT)
    .digest();
  return createHmac("sha256", key)
    .update(
      [
        method.toUpperCase(),
        path,
        timestamp,
        userId,
      ].join("\n"),
    )
    .digest("hex");
}

type InternalSmokeAuthOptions = {
  nodeEnv?: string;
  sessionSecret?: string;
  now?: () => number;
};

function getInternalSmokeUserId(
  req: Request,
  {
    nodeEnv = process.env.NODE_ENV,
    sessionSecret = process.env.SESSION_SECRET,
    now = Date.now,
  }: InternalSmokeAuthOptions,
): string | undefined {
  // This is deliberately an allow-list rather than a production deny-list:
  // unknown environments must never gain an alternate authentication path.
  if (nodeEnv !== "development" || !sessionSecret) return undefined;

  const userId = req.header(INTERNAL_SMOKE_USER_HEADER)?.trim();
  const timestamp = req.header(INTERNAL_SMOKE_TIMESTAMP_HEADER)?.trim();
  const signature = req.header(INTERNAL_SMOKE_SIGNATURE_HEADER)?.trim();
  if (
    userId !== INTERNAL_SMOKE_USER_ID ||
    !timestamp ||
    !signature ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) {
    return undefined;
  }

  const timestampMs = Number(timestamp);
  const ageMs = now() - timestampMs;
  if (
    !Number.isSafeInteger(timestampMs) ||
    ageMs < -INTERNAL_SMOKE_MAX_FUTURE_SKEW_MS ||
    ageMs > INTERNAL_SMOKE_MAX_AGE_MS
  ) {
    return undefined;
  }

  const path = new URL(req.originalUrl || req.url, "http://internal").pathname;
  const expected = createInternalSmokeSignature({
    secret: sessionSecret,
    method: req.method,
    path,
    timestamp,
    userId,
  });
  const actualBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return undefined;
  }
  return userId;
}

declare global {
  namespace Express {
    interface Request {
      authUserId?: string;
    }
  }
}

/**
 * Rejects unauthenticated requests with 401. Attaches the Clerk user id to
 * `req.authUserId` for downstream handlers.
 */
export function createRequireAuth(options: InternalSmokeAuthOptions = {}) {
  return function requireAuthenticatedRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const smokeUserId = getInternalSmokeUserId(req, options);
    if (smokeUserId) {
      req.authUserId = smokeUserId;
      next();
      return;
    }

    const auth = getAuth(req);
    const userId = auth?.userId;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    req.authUserId = userId;
    next();
  };
}

export const requireAuth = createRequireAuth();

/**
 * Resolves a human-readable display name for the signed-in reviewer.
 * Falls back to the primary email address, then the raw user id.
 */
export async function resolveReviewerName(userId: string): Promise<string> {
  try {
    const user = await clerkClient.users.getUser(userId);
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    if (fullName) return fullName;
    const email =
      user.primaryEmailAddress?.emailAddress ??
      user.emailAddresses[0]?.emailAddress;
    if (email) return email;
  } catch {
    // fall through to the raw id
  }
  return userId;
}

export function hasCommercialRateManagerPermission(
  privateMetadata: unknown,
): boolean {
  return (
    typeof privateMetadata === "object" &&
    privateMetadata !== null &&
    (privateMetadata as Record<string, unknown>).commercialRateManager === true
  );
}

export async function userCanManagePricingRates(userId: string): Promise<boolean> {
  try {
    const user = await clerkClient.users.getUser(userId);
    return hasCommercialRateManagerPermission(user.privateMetadata);
  } catch {
    return false;
  }
}

type RateManagerPermissionCheck = (userId: string) => Promise<boolean>;

export function createPricingRateManagerGuard(
  checkPermission: RateManagerPermissionCheck = userCanManagePricingRates,
) {
  return async function requirePricingRateManager(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    let allowed = false;
    try {
      allowed = await checkPermission(userId);
    } catch {
      // Authorization lookups fail closed: commercial master data must never
      // become writable merely because the identity provider is unavailable.
    }
    if (!allowed) {
      res.status(403).json({
        message: "Commercial rate manager permission required",
      });
      return;
    }
    next();
  };
}

export const requirePricingRateManager = createPricingRateManagerGuard();
