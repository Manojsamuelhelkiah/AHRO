import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { Request } from "express";
import { db } from "@workspace/db";
import {
  onbCandidateLinks,
  onbCandidateSessions,
  onbCases,
} from "@workspace/db/schema";

export const CANDIDATE_COOKIE = "onb_candidate_session";
export const MAX_CANDIDATE_FILE_BYTES = 10 * 1024 * 1024;

export const CANDIDATE_LINK_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
export const newSecret = () => randomBytes(32).toString("base64url");
export const portalEmailRequested = (value: unknown) => value === true;

export const CANDIDATE_EXCHANGE_FAILURE_LIMIT = 5;
export const CANDIDATE_EXCHANGE_COOLDOWN_MS = 60_000;
const MAX_CANDIDATE_EXCHANGE_CLIENTS = 10_000;

type ExchangeFailureWindow = { failures: number; resetsAt: number };
const exchangeFailures = new Map<string, ExchangeFailureWindow>();

export function candidateExchangeClientKey(req: Request) {
  return hashSecret(req.ip || req.socket.remoteAddress || "unknown");
}

export function candidateExchangeRetryAfterMs(clientKey: string, now = Date.now()) {
  const window = exchangeFailures.get(clientKey);
  if (!window) return 0;
  if (window.resetsAt <= now) {
    exchangeFailures.delete(clientKey);
    return 0;
  }
  return window.failures >= CANDIDATE_EXCHANGE_FAILURE_LIMIT
    ? window.resetsAt - now
    : 0;
}

export function recordCandidateExchangeFailure(clientKey: string, now = Date.now()) {
  const current = exchangeFailures.get(clientKey);
  if (!current || current.resetsAt <= now) {
    exchangeFailures.set(clientKey, {
      failures: 1,
      resetsAt: now + CANDIDATE_EXCHANGE_COOLDOWN_MS,
    });
  } else {
    current.failures += 1;
  }
  while (exchangeFailures.size > MAX_CANDIDATE_EXCHANGE_CLIENTS) {
    const oldest = exchangeFailures.keys().next().value;
    if (oldest === undefined) break;
    exchangeFailures.delete(oldest);
  }
}

export function clearCandidateExchangeFailures(clientKey: string) {
  exchangeFailures.delete(clientKey);
}

export function validateLogistics(input: Record<string, unknown>) {
  const clean = (key: string, max: number) => {
    const value = input[key];
    if (value == null || value === "") return null;
    if (typeof value !== "string" || value.trim().length > max) throw new Error(`Invalid ${key}`);
    return value.trim();
  };
  const format = clean("format", 16);
  if (format && !["physical", "remote", "hybrid"].includes(format)) throw new Error("Invalid format");
  const date = clean("orientationDate", 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid orientationDate");
  const time = clean("orientationTime", 5);
  if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Invalid orientationTime");
  const timezone = clean("timezone", 100);
  if (timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new Error("Invalid timezone"); }
  }
  const googleMapsUrl = clean("googleMapsUrl", 1000);
  if (googleMapsUrl) {
    let url: URL;
    try { url = new URL(googleMapsUrl); } catch { throw new Error("Invalid Google Maps URL"); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "maps.google.com" || host === "www.google.com" || host === "goo.gl" || host === "maps.app.goo.gl")) {
      throw new Error("Invalid Google Maps URL");
    }
  }
  const meetingUrl = clean("meetingUrl", 1000);
  if (meetingUrl) {
    try { if (new URL(meetingUrl).protocol !== "https:") throw new Error(); } catch { throw new Error("Invalid meeting URL"); }
  }
  return {
    orientationDate: date, orientationTime: time, timezone, format,
    venueAddress: clean("venueAddress", 1000), googleMapsUrl, meetingUrl,
    reportingContact: clean("reportingContact", 500),
    arrivalInstructions: clean("arrivalInstructions", 4000),
  };
}

export async function candidateContext(req: Request) {
  const secret = req.cookies?.[CANDIDATE_COOKIE];
  if (typeof secret !== "string") return undefined;
  const [row] = await db.select({
    organizationId: onbCandidateSessions.organizationId,
    caseId: onbCandidateSessions.caseId,
    linkId: onbCandidateSessions.linkId,
  }).from(onbCandidateSessions).innerJoin(
    onbCandidateLinks,
    eq(onbCandidateLinks.id, onbCandidateSessions.linkId),
  ).where(and(
    eq(onbCandidateSessions.idHash, hashSecret(secret)),
    gt(onbCandidateSessions.expiresAt, new Date()),
    gt(onbCandidateLinks.expiresAt, new Date()),
    isNull(onbCandidateLinks.revokedAt),
    eq(onbCandidateSessions.organizationId, onbCandidateLinks.organizationId),
    eq(onbCandidateSessions.caseId, onbCandidateLinks.caseId),
  ));
  return row;
}

export async function exchangeToken(token: string) {
  const [link] = await db.select().from(onbCandidateLinks).where(and(
    eq(onbCandidateLinks.tokenHash, hashSecret(token)),
    gt(onbCandidateLinks.expiresAt, new Date()),
    isNull(onbCandidateLinks.revokedAt),
  ));
  if (!link) return undefined;
  const [caseRow] = await db.select({ id: onbCases.id }).from(onbCases).where(and(
    eq(onbCases.id, link.caseId), eq(onbCases.organizationId, link.organizationId),
  ));
  if (!caseRow) return undefined;
  const secret = newSecret();
  const sessionExpiry = new Date(Math.min(link.expiresAt.getTime(), Date.now() + 30 * 60_000));
  await db.insert(onbCandidateSessions).values({
    idHash: hashSecret(secret), organizationId: link.organizationId,
    caseId: link.caseId, linkId: link.id, expiresAt: sessionExpiry,
  });
  return { secret, expiresAt: sessionExpiry };
}

export async function cleanupCandidateAccess(input: {
  now?: Date;
  organizationId?: string;
  limit?: number;
} = {}): Promise<{ expiredSessions: number; retainedLinksDeleted: number }> {
  const now = input.now ?? new Date();
  const limit = Math.max(
    1,
    Math.min(input.limit ?? CANDIDATE_ACCESS_CLEANUP_BATCH_SIZE, CANDIDATE_ACCESS_CLEANUP_BATCH_SIZE),
  );
  const tenantSessionFilter = input.organizationId
    ? eq(onbCandidateSessions.organizationId, input.organizationId)
    : undefined;
  const expiredSessionIds = db
    .select({ idHash: onbCandidateSessions.idHash })
    .from(onbCandidateSessions)
    .where(and(lte(onbCandidateSessions.expiresAt, now), tenantSessionFilter))
    .limit(limit);
  const deletedSessions = await db
    .delete(onbCandidateSessions)
    .where(and(
      inArray(onbCandidateSessions.idHash, expiredSessionIds),
      tenantSessionFilter,
    ))
    .returning({ idHash: onbCandidateSessions.idHash });

  const retentionCutoff = new Date(now.getTime() - CANDIDATE_LINK_RETENTION_MS);
  const tenantLinkFilter = input.organizationId
    ? eq(onbCandidateLinks.organizationId, input.organizationId)
    : undefined;
  const retainedLinkIds = db
    .select({ id: onbCandidateLinks.id })
    .from(onbCandidateLinks)
    .where(and(
      or(
        and(
          isNull(onbCandidateLinks.revokedAt),
          lte(onbCandidateLinks.expiresAt, retentionCutoff),
        ),
        lte(onbCandidateLinks.revokedAt, retentionCutoff),
      ),
      tenantLinkFilter,
    ))
    .limit(limit);
  const deletedLinks = await db
    .delete(onbCandidateLinks)
    .where(and(
      inArray(onbCandidateLinks.id, retainedLinkIds),
      tenantLinkFilter,
    ))
    .returning({ id: onbCandidateLinks.id });

  return {
    expiredSessions: deletedSessions.length,
    retainedLinksDeleted: deletedLinks.length,
  };
}
export function candidateObjectPath(organizationId: string, caseId: number) {
  const org = hashSecret(organizationId).slice(0, 24);
  return `/objects/candidate-documents/${org}/${caseId}/${randomUUID()}`;
}

export function detectCandidateFile(bytes: Buffer): string | undefined {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  return undefined;
}

export const CANDIDATE_ACCESS_CLEANUP_BATCH_SIZE = 500;
