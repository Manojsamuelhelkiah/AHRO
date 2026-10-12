import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { clerkClient, getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { isDevelopmentSuperAdmin, bindDevelopmentSuperAdminTenant, enterDevelopmentAdminContext } from "./development-super-admin";
import { rawRegisteredDemoProfile } from "./demo-principal";

export const ADMIN_APPROVAL_KEY = "hroPrivatePlatformAdmin";
export const ADMIN_COOKIE = "hro_private_platform_admin";
export const ADMIN_LIFETIME_MS = 15 * 60_000;
type Approval = { userId: string; primaryEmailId: string; environment: string; generation: string; decisionRef: string };
type Grant = { userId: string; sessionId: string; generation: string; environment: string; issuedAt: number; expiresAt: number };
type Context = Grant & { organizationId?: string; active: boolean };
const context = new AsyncLocalStorage<Context>();

export type PrivateIdentity = {
  id: string; primaryEmailAddressId: string | null; twoFactorEnabled: boolean;
  emailAddresses: { id: string; verification: { status: string } | null }[];
  privateMetadata: Record<string, unknown>;
};
export function approvedPrivateIdentity(user: PrivateIdentity, environment = process.env.NODE_ENV): Approval | null {
  const approval = user.privateMetadata[ADMIN_APPROVAL_KEY] as Approval | undefined;
  if (!["development", "production"].includes(environment ?? "") || !approval ||
    approval.userId !== user.id || approval.environment !== environment ||
    typeof approval.generation !== "string" || !approval.generation ||
    typeof approval.decisionRef !== "string" || !approval.decisionRef || !user.twoFactorEnabled ||
    !user.primaryEmailAddressId || approval.primaryEmailId !== user.primaryEmailAddressId) return null;
  return user.emailAddresses.some(email => email.id === approval.primaryEmailId && email.verification?.status === "verified")
    ? approval : null;
}

export function recentMfa(ages: unknown, maxMinutes = 5): boolean {
  return Array.isArray(ages) && ages.length === 2 &&
    ages.every(age => typeof age === "number" && Number.isFinite(age) && age >= 0 && age <= maxMinutes);
}

export function signAdminGrant(grant: Grant, secret: string): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(`private-platform-admin:v1:${payload}`).digest("base64url")}`;
}

export function verifyAdminGrant(value: string, secret: string | undefined, now = Date.now()): Grant | null {
  if (!secret || secret.length < 32 || value.length > 4096) return null;
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", secret).update(`private-platform-admin:v1:${payload}`).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString()) as Grant;
    if (![grant.userId, grant.sessionId, grant.generation].every(v => typeof v === "string" && v.length > 0) ||
      !["development", "production"].includes(grant.environment) ||
      !Number.isFinite(grant.issuedAt) || !Number.isFinite(grant.expiresAt) ||
      grant.issuedAt > now || grant.expiresAt <= now || grant.expiresAt - grant.issuedAt !== ADMIN_LIFETIME_MS) return null;
    return grant;
  } catch { return null; }
}

export function sameAdminOrigin(req: Request): boolean {
  if (req.header("sec-fetch-site") === "cross-site") return false;
  try {
    const origin = new URL(req.header("origin") || "");
    const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
    return origin.host === host && (process.env.NODE_ENV !== "production" || origin.protocol === "https:");
  } catch { return false; }
}

export function adminCookieOptions() {
  // The preview is an HTTPS iframe. SameSite=None is necessary there; every
  // privileged API request is independently fenced against cross-site callers.
  return { httpOnly: true, secure: true, sameSite: "none" as const, path: "/" };
}

export function isPlatformSuperAdmin(userId: string, organizationId?: string) {
  const current = context.getStore();
  return isDevelopmentSuperAdmin(userId, organizationId) ||
    Boolean(current?.active && current.expiresAt > Date.now() && current.userId === userId &&
      (!organizationId || current.organizationId === organizationId));
}

export function bindPlatformSuperAdminTenant(organizationId: string) {
  bindDevelopmentSuperAdminTenant(organizationId);
  const current = context.getStore();
  if (current) current.organizationId = organizationId;
}

export function createPlatformAdminContext(services = {
  getUser: (id: string): Promise<PrivateIdentity> => clerkClient.users.getUser(id),
  getSession: (id: string): Promise<{ userId: string; status: string }> => clerkClient.sessions.getSession(id),
  isDemo: async (id: string) => Boolean(await rawRegisteredDemoProfile(id)),
}) {
return async function enterPlatformAdminContext(req: Request, res: Response, next: NextFunction) {
  if (res.writableEnded || res.destroyed) return;
  if (req.privatePlatformAdmin && req.authUserId && isPlatformSuperAdmin(req.authUserId)) { next(); return; }
  const cookie = req.headers?.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${ADMIN_COOKIE}=`));
  if (!cookie) { await enterDevelopmentAdminContext(req, res, next); return; }
  let grant: Grant | null = null;
  try { grant = verifyAdminGrant(decodeURIComponent(cookie.slice(ADMIN_COOKIE.length + 1)), process.env.SESSION_SECRET); } catch { /* reject */ }
  if (!grant || grant.userId !== req.authUserId || grant.environment !== process.env.NODE_ENV) {
    res.status(403).json({ message: "Private administrator access expired. End access or verify again.", code: "ADMIN_GRANT_INVALID" }); return;
  }
  if (req.header("sec-fetch-site") === "cross-site" ||
    (req.header("origin") && !sameAdminOrigin(req)) ||
    (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameAdminOrigin(req))) {
    res.status(403).json({ message: "Same-site administrator request required." }); return;
  }
  try {
    const auth = getAuth(req);
    if (auth.sessionId !== grant.sessionId || !recentMfa(auth.sessionClaims?.fva, 15)) {
      res.status(403).json({ message: "Recent MFA on the approved session is required.", code: "ADMIN_MFA_REQUIRED" }); return;
    }
    const [user, session] = await Promise.all([
      services.getUser(grant.userId), services.getSession(grant.sessionId),
    ]);
    const approval = approvedPrivateIdentity(user);
    if (!approval || approval.generation !== grant.generation || session.status !== "active" ||
      session.userId !== grant.userId || await services.isDemo(grant.userId)) {
      res.status(403).json({ message: "Private administrator eligibility or session was revoked.", code: "ADMIN_REVOKED" }); return;
    }
    const current: Context = { ...grant, active: true };
    req.privatePlatformAdmin = true;
    req.platformSuperAdmin = true;
    const end = () => { current.active = false; };
    res.once("finish", end); res.once("close", end);
    context.run(current, next);
  } catch {
    res.status(503).json({ message: "Administrator verification unavailable; access is blocked." });
  }
};
}
export const enterPlatformAdminContext = createPlatformAdminContext();

declare global {
  namespace Express {
    interface Request { privatePlatformAdmin?: boolean; platformSuperAdmin?: boolean }
  }
}
