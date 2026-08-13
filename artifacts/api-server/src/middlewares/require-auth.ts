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
