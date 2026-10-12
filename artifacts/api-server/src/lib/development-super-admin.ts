import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { clerkClient, getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

const COOKIE = "hro_dev_super_admin";
const MAX_AGE = 4 * 60 * 60 * 1000;
type Proof = { userId: string; issuedAt: number; expiresAt: number; sessionId?: string };
type Scope = { userId: string; sessionId: string; organizationId?: string; active: boolean; expiresAt: number };
const scope = new AsyncLocalStorage<Scope>();
const attempts = new Map<string, { count: number; until: number }>();
const transitions = new Map<string, Promise<void>>();

export function developmentSuperAdminEnabled() {
  return process.env.NODE_ENV === "development" && Boolean(process.env.DEV_SUPER_ADMIN_PASSWORD);
}

export function isDevelopmentSuperAdmin(userId: string, organizationId?: string) {
  const current = scope.getStore();
  return developmentSuperAdminEnabled() && current?.active === true && current.expiresAt > Date.now() && current.userId === userId &&
    (!organizationId || current.organizationId === organizationId);
}

export function bindDevelopmentSuperAdminTenant(organizationId: string) {
  const current = scope.getStore();
  if (current) current.organizationId = organizationId;
}

export function passwordMatches(candidate: unknown, expected: string | undefined) {
  if (typeof candidate !== "string" || !expected || candidate.length > 512) return false;
  const digest = (value: string) => createHmac("sha256", expected).update(value).digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function allowDevelopmentAdminAttempt(key: string, now = Date.now()) {
  for (const [id, entry] of attempts) if (entry.until <= now) attempts.delete(id);
  const entry = attempts.get(key) ?? { count: 0, until: now + 15 * 60 * 1000 };
  if (entry.count >= 5) return false;
  entry.count++;
  attempts.set(key, entry);
  return true;
}

export function developmentAdminAttemptBlocked(key: string, now = Date.now()) {
  const entry = attempts.get(key);
  return Boolean(entry && entry.until > now && entry.count >= 5);
}

function sameOrigin(req: Request) {
  if (req.header("sec-fetch-site") === "cross-site") return false;
  const origin = req.header("origin");
  if (!origin) return false;
  try {
    const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
    const originHost = new URL(origin).host;
    return originHost === host || originHost === process.env.REPLIT_DEV_DOMAIN;
  } catch { return false; }
}

function cookieOptions(req: Request) {
  const secure = req.secure || req.header("x-forwarded-proto")?.split(",")[0] === "https";
  return { httpOnly: true, secure, sameSite: secure ? "none" as const : "lax" as const, path: "/", maxAge: MAX_AGE };
}

function writeProof(req: Request, res: Response, proof: Proof) {
  const payload = Buffer.from(JSON.stringify(proof)).toString("base64url");
  const signature = createHmac("sha256", process.env.DEV_SUPER_ADMIN_PASSWORD!).update(payload).digest("base64url");
  res.cookie(COOKIE, `${payload}.${signature}`, cookieOptions(req));
}

export function verifyDevelopmentAdminProof(encoded: string, secret: string | undefined, now = Date.now()): Proof | null {
  if (!secret) return null;
  try {
    if (encoded.length > 2048) return null;
    const [payload, signature, extra] = encoded.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", secret).update(payload).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    const proof = JSON.parse(Buffer.from(payload, "base64url").toString()) as Proof;
    if (typeof proof.userId !== "string" || !Number.isFinite(proof.issuedAt) ||
      !Number.isFinite(proof.expiresAt) || proof.issuedAt > now + 1000 ||
      proof.expiresAt <= now || proof.expiresAt - proof.issuedAt !== MAX_AGE ||
      (proof.sessionId !== undefined && typeof proof.sessionId !== "string")) return null;
    return proof;
  } catch { return null; }
}

function readProof(req: Request): Proof | null {
  if (!developmentSuperAdminEnabled()) return null;
  try {
    const entry = req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
    return entry ? verifyDevelopmentAdminProof(decodeURIComponent(entry.slice(COOKIE.length + 1)), process.env.DEV_SUPER_ADMIN_PASSWORD) : null;
  } catch { return null; }
}

// Provider metadata is private, preserved by the demo-account marker, and
// survives API restarts. Only the first protected transition revokes sessions,
// allowing both development testers to sign in concurrently afterwards.
export async function prepareDevelopmentAdminLogin(req: Request, res: Response, userId: string) {
  if (!sameOrigin(req)) { res.status(403).json({ message: "Use the same-site Super Admin sign-in form." }); return false; }
  if (!developmentSuperAdminEnabled()) {
    res.status(403).json({ message: "Temporary Super Admin access is available only in development with its password configured." });
    return false;
  }
  if (developmentAdminAttemptBlocked("super-admin")) {
    res.status(429).json({ message: "Too many Super Admin sign-in attempts. Try again in 15 minutes." });
    return false;
  }
  if (!passwordMatches(req.body?.password, process.env.DEV_SUPER_ADMIN_PASSWORD)) {
    res.status(401).json({ message: "Super Admin sign-in failed. Check the password." });
    return false;
  }
  const epoch = createHmac("sha256", process.env.DEV_SUPER_ADMIN_PASSWORD!).update("development-admin-session-fence").digest("hex");
  const transitionKey = `${userId}:${epoch}`;
  if (!transitions.has(transitionKey)) {
    const transition = (async () => {
      const user = await clerkClient.users.getUser(userId);
      if (user.privateMetadata.developmentAdminCredentialEpoch === epoch) return;
      // Page until no active legacy session remains; do not silently ignore
      // a failed revocation and proceed to issue a privileged ticket.
      for (;;) {
        const sessions = await clerkClient.sessions.getSessionList({ userId, status: "active", limit: 100 });
        if (!sessions.data.length) break;
        await Promise.all(sessions.data.map(session => clerkClient.sessions.revokeSession(session.id)));
      }
      await clerkClient.users.updateUserMetadata(userId, { privateMetadata: { developmentAdminCredentialEpoch: epoch } });
    })();
    transitions.set(transitionKey, transition);
    transition.catch(() => { transitions.delete(transitionKey); });
  }
  await transitions.get(transitionKey);
  attempts.delete("super-admin");
  const issuedAt = Date.now();
  writeProof(req, res, { userId, issuedAt, expiresAt: issuedAt + MAX_AGE });
  res.setHeader("Cache-Control", "no-store");
  return true;
}

export async function enterDevelopmentAdminContext(req: Request, res: Response, next: NextFunction) {
  if (res.writableEnded || res.destroyed) { next(); return; }
  if (req.developmentSuperAdmin && req.authUserId && isDevelopmentSuperAdmin(req.authUserId)) { next(); return; }
  const proof = readProof(req);
  if (!proof || proof.userId !== req.authUserId) { next(); return; }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) {
    res.status(403).json({ message: "Cross-site Super Admin requests are not allowed." }); return;
  }
  try {
    const sessionId = getAuth(req).sessionId;
    if (!sessionId || (proof.sessionId && proof.sessionId !== sessionId)) { next(); return; }
    const session = await clerkClient.sessions.getSession(sessionId);
    if (session.userId !== proof.userId || session.status !== "active" || session.createdAt < proof.issuedAt) { next(); return; }
    if (!proof.sessionId) writeProof(req, res, { ...proof, sessionId });
    req.developmentSuperAdmin = true;
    const current: Scope = { userId: proof.userId, sessionId, active: true, expiresAt: proof.expiresAt };
    const end = () => { current.active = false; };
    res.once("finish", end);
    res.once("close", end);
    scope.run(current, next);
  } catch {
    // A failed provider check cannot turn a session into a platform admin.
    res.status(503).json({ message: "Super Admin session verification is temporarily unavailable." });
  }
}

export function clearDevelopmentAdminLogin(req: Request, res: Response) {
  if (!sameOrigin(req)) return;
  const { maxAge: _maxAge, ...options } = cookieOptions(req);
  res.clearCookie(COOKIE, options);
}

declare global {
  namespace Express {
    interface Request { developmentSuperAdmin?: boolean }
  }
}
