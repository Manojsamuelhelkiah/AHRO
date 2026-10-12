import { createHash, randomBytes } from "node:crypto";
import { clerkClient, getAuth } from "@clerk/express";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, organizationMembershipsTable, uatAdmissionsTable } from "@workspace/db";
import type { Request, Response } from "express";
import { getClerkProxyHost } from "../middlewares/clerkProxyMiddleware";

export const UAT_COOKIE = "hro_uat_admission";
export const UAT_CHALLENGE_COOKIE = "hro_uat_challenge";
export const UAT_ADMISSION_MS = 30 * 60_000;
export const UAT_CHALLENGE_MS = 10 * 60_000;
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newUatToken = () => randomBytes(32).toString("base64url");
// None supports the proxied preview iframe; strict same-origin checks protect
// every mutation and reject cross-origin reads regardless of cookie transport.
export const uatCookieOptions = { httpOnly: true, secure: true, sameSite: "none" as const, path: "/" };

export function isUatProtectedPath(path: string) {
  // Express routes are case-insensitive by default; the guard must agree.
  return /^\/onboarding\/uat(?:\/|$)/i.test(path) || /^\/policies\/evaluation(?:\/|$)/i.test(path);
}

export function uatSameOrigin(req: Request) {
  if (req.header("sec-fetch-site") === "cross-site") return false;
  try {
    const origin = new URL(req.header("origin") ?? "");
    const protocol = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
    return origin.host === getClerkProxyHost(req) && origin.protocol === `${protocol}:`;
  } catch { return false; }
}

export function readUatCookie(req: Request, name: string): string | null {
  const value = req.cookies?.[name];
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export type UatPrincipal = {
  id: string; userId: string; clientId: string; status: string; createdAt: number;
  expireAt: number; abandonAt: number; actor: Record<string, unknown> | null;
};
async function realUatMembership(userId: string, organizationId: string) {
  const [membership] = await db.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.clerkUserId, userId),
    eq(organizationMembershipsTable.organizationId, organizationId),
    isNull(organizationMembershipsTable.revokedAt),
  )).limit(1);
  return membership ?? null;
}
export function createActiveUatPrincipal(
  authFor: (req: Request) => { userId: string | null; sessionId: string | null } = getAuth,
  sessionFor: (id: string) => Promise<UatPrincipal> = (id) => clerkClient.sessions.getSession(id),
  memberFor: (userId: string, organizationId: string) => Promise<{ role: "owner" | "admin" | "member" } | null> = realUatMembership,
) {
 return async (req: Request) => {
  const auth = authFor(req);
  if (!auth.userId || !auth.sessionId || auth.userId !== req.authUserId) return null;
  if (!req.organizationId) return null;
  const session = await sessionFor(auth.sessionId);
  if (session.id !== auth.sessionId || session.userId !== auth.userId || session.status !== "active" ||
    session.expireAt <= Date.now() || session.abandonAt <= Date.now() || session.actor) return null;
  // Do not use lookupMembership: private administration may resolve tenants
  // without membership, but that capability must not silently admit UAT.
  const membership = await memberFor(auth.userId, req.organizationId);
  if (!membership) return null;
  req.organizationRole = membership.role;
  return session;
 };
}
export const activeUatPrincipal = createActiveUatPrincipal();

export type UatAdmissionRecord = typeof uatAdmissionsTable.$inferSelect;
export function admissionMatches(row: UatAdmissionRecord | undefined, userId: string, sessionId: string, organizationId: string, now = Date.now()) {
  return Boolean(row && row.kind === "admission" && !row.revokedAt &&
    row.expiresAt.getTime() > now && row.createdAt.getTime() <= now &&
    row.userId === userId && row.sessionId === sessionId && row.organizationId === organizationId);
}

export function freshUatSignIn(challenge: UatAdmissionRecord | undefined,
  session: { id: string; userId: string; createdAt: number },
  client: { lastActiveSessionId: string | null; lastAuthenticationStrategy: string | null },
  now = Date.now()) {
  const strategy = client.lastAuthenticationStrategy;
  const supported = strategy === "password" || strategy === "email_code" || strategy === "email_link" ||
    strategy === "passkey" || strategy === "phone_code" || Boolean(strategy?.startsWith("oauth_")) || Boolean(strategy?.startsWith("saml"));
  return Boolean(challenge && challenge.kind === "challenge" && !challenge.consumedAt && !challenge.revokedAt &&
    challenge.expiresAt.getTime() > now && challenge.createdAt.getTime() < session.createdAt &&
    challenge.sessionId !== session.id && client.lastActiveSessionId === session.id && supported);
}

export async function findUatRecord(token: string): Promise<UatAdmissionRecord | undefined> {
  const [row] = await db.select().from(uatAdmissionsTable).where(eq(uatAdmissionsTable.tokenHash, tokenHash(token))).limit(1);
  return row;
}
export function createLiveUatAdmissionVerifier(principal = activeUatPrincipal, record = findUatRecord) {
 return async (req: Request): Promise<UatAdmissionRecord | null> => {
  const token = readUatCookie(req, UAT_COOKIE);
  if (!token || !req.organizationId) return null;
  const session = await principal(req);
  if (!session) return null;
  const row = await record(token);
  return row && admissionMatches(row, session.userId, session.id, req.organizationId) ? row : null;
 };
}
export const requireLiveUatAdmission = createLiveUatAdmissionVerifier();

export async function consumeUatChallenge(token: string, admissionToken: string, session: UatPrincipal,
  organizationId: string, requestKey: string, now: Date, expiresAt: Date) {
  return db.transaction(async (tx) => {
    const claimed = await tx.update(uatAdmissionsTable).set({ consumedAt: now }).where(and(
      eq(uatAdmissionsTable.tokenHash, tokenHash(token)), eq(uatAdmissionsTable.kind, "challenge"),
      gt(uatAdmissionsTable.expiresAt, now), isNull(uatAdmissionsTable.consumedAt),
      isNull(uatAdmissionsTable.revokedAt),
    )).returning();
    if (!claimed.length) return false;
    await tx.insert(uatAdmissionsTable).values({
      tokenHash: tokenHash(admissionToken), kind: "admission", userId: session.userId, sessionId: session.id,
      organizationId, requestKey, createdAt: now, expiresAt,
    });
    return true;
  });
}

export async function revokeUatCookie(req: Request, res: Response) {
  const token = readUatCookie(req, UAT_COOKIE);
  if (token) await db.update(uatAdmissionsTable).set({ revokedAt: new Date() })
    .where(and(eq(uatAdmissionsTable.tokenHash, tokenHash(token)), eq(uatAdmissionsTable.kind, "admission")));
  res.clearCookie(UAT_COOKIE, uatCookieOptions);
}

export async function createUatChallenge(req: Request, res: Response) {
  // Durable rate cap, serialized across workers. Store only a one-way IP hash.
  const key = tokenHash(req.ip ?? "unknown");
  const token = newUatToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UAT_CHALLENGE_MS);
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`uat-challenge:${key}`}))`);
    const recent = await tx.select({ id: uatAdmissionsTable.tokenHash }).from(uatAdmissionsTable).where(and(
      eq(uatAdmissionsTable.requestKey, key), eq(uatAdmissionsTable.kind, "challenge"),
      gt(uatAdmissionsTable.createdAt, new Date(now.getTime() - 15 * 60_000)),
    )).limit(10);
    if (recent.length >= 10) return false;
    const previous = getAuth(req).sessionId ?? null;
    await tx.insert(uatAdmissionsTable).values({
      tokenHash: tokenHash(token), kind: "challenge", sessionId: previous,
      requestKey: key, createdAt: now, expiresAt,
    });
    return true;
  });
  if (!created) { res.status(429).json({ message: "Too many UAT sign-in attempts. Try again in 15 minutes." }); return; }
  await revokeUatCookie(req, res);
  res.cookie(UAT_CHALLENGE_COOKIE, token, { ...uatCookieOptions, maxAge: UAT_CHALLENGE_MS });
  res.json({ expiresAt: expiresAt.toISOString() });
}
