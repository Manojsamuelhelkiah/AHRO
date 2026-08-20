import type { NextFunction, Request, Response } from "express";
import { clerkClient, getAuth } from "@clerk/express";

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
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }
  req.authUserId = userId;
  next();
}

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
