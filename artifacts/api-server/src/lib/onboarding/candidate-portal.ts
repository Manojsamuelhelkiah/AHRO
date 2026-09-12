import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Request } from "express";
import { db } from "@workspace/db";
import {
  onbCandidateExchangeFailures,
  onbCandidateLinks,
  onbCandidateSessions,
  onbCases,
  onbAuditLifecycles,
  onbSensitiveLifecycleHolds,
  onbSettings,
} from "@workspace/db/schema";
import {
  CANDIDATE_LINK_RETENTION_DAYS_KEY,
  DEFAULT_CANDIDATE_LINK_RETENTION_DAYS,
  getCandidateLinkRetentionDays,
} from "./settings";
import { appendProtectedAudit, appendProtectedAuditInTransaction } from "./protected-audit";
import {
  evaluateSensitiveLifecycleGate,
  jurisdictionForWorkforceContext,
  sensitiveLifecycleDestructionHeld,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";
export { validateLogistics } from "./logistics-validation";

export const CANDIDATE_COOKIE = "onb_candidate_session";
export const MAX_CANDIDATE_FILE_BYTES = 10 * 1024 * 1024;

export const CANDIDATE_LINK_RETENTION_MS =
  DEFAULT_CANDIDATE_LINK_RETENTION_DAYS * 24 * 60 * 60_000;
export const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
export const newSecret = () => randomBytes(32).toString("base64url");
export const portalEmailRequested = (value: unknown) => value === true;

export const CANDIDATE_EXCHANGE_FAILURE_LIMIT = 5;
export const CANDIDATE_EXCHANGE_COOLDOWN_MS = 60_000;
export const MAX_CANDIDATE_EXCHANGE_CLIENTS = 10_000;

const CANDIDATE_EXCHANGE_LIMITER_LOCK = 224_000_001;
export function candidateExchangeClientKey(req: Request) {
  return hashSecret(req.ip || req.socket.remoteAddress || "unknown");
}

export class CandidateExchangeLimiter {
  async retryAfterMs(clientKey: string, now = Date.now()) {
    const at = new Date(now);
    const [window] = await db.select({
      failures: onbCandidateExchangeFailures.failures,
      expiresAt: onbCandidateExchangeFailures.expiresAt,
    }).from(onbCandidateExchangeFailures).where(and(
      eq(onbCandidateExchangeFailures.clientKey, clientKey),
      gt(onbCandidateExchangeFailures.expiresAt, at),
    ));
    if (window?.failures >= CANDIDATE_EXCHANGE_FAILURE_LIMIT) {
      return Math.max(0, window.expiresAt.getTime() - now);
    }

    // When a rotating-address flood fills the fixed key budget, fail closed
    // for unknown clients until the earliest short-lived row expires.
    if (!window) {
      const [capacity] = await db.select({
        total: count(),
        earliestExpiry: sql<Date | null>`min(${onbCandidateExchangeFailures.expiresAt})`,
      }).from(onbCandidateExchangeFailures).where(gt(onbCandidateExchangeFailures.expiresAt, at));
      if (capacity && capacity.total >= MAX_CANDIDATE_EXCHANGE_CLIENTS && capacity.earliestExpiry) {
        return Math.max(0, new Date(capacity.earliestExpiry).getTime() - now);
      }
    }
    return 0;
  }

  async recordFailure(clientKey: string, now = Date.now()) {
    const at = new Date(now);
    const expiresAt = new Date(now + CANDIDATE_EXCHANGE_COOLDOWN_MS);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CANDIDATE_EXCHANGE_LIMITER_LOCK})`);
      await tx.delete(onbCandidateExchangeFailures).where(lte(onbCandidateExchangeFailures.expiresAt, at));
      const [current] = await tx.select({
        failures: onbCandidateExchangeFailures.failures,
      }).from(onbCandidateExchangeFailures).where(eq(onbCandidateExchangeFailures.clientKey, clientKey));
      if (current) {
        await tx.update(onbCandidateExchangeFailures)
          .set({ failures: current.failures + 1 })
          .where(eq(onbCandidateExchangeFailures.clientKey, clientKey));
        return;
      }
      const [capacity] = await tx.select({ total: count() }).from(onbCandidateExchangeFailures);
      if ((capacity?.total ?? 0) >= MAX_CANDIDATE_EXCHANGE_CLIENTS) return;
      await tx.insert(onbCandidateExchangeFailures).values({ clientKey, failures: 1, expiresAt });
    });
  }

  async clear(clientKey: string) {
    await db.delete(onbCandidateExchangeFailures)
      .where(eq(onbCandidateExchangeFailures.clientKey, clientKey));
  }
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
  // A session hash is a durable bearer-credential derivative. Re-read the
  // revocable link and keep policy evaluation through session persistence
  // under one fence, so a hold/revocation cannot land between them.
  return withSensitiveLifecycleFence(link.organizationId, async () => {
    const [currentLink] = await db.select().from(onbCandidateLinks).where(and(
      eq(onbCandidateLinks.id, link.id),
      eq(onbCandidateLinks.organizationId, link.organizationId),
      gt(onbCandidateLinks.expiresAt, new Date()),
      isNull(onbCandidateLinks.revokedAt),
    ));
    if (!currentLink) return undefined;
    const [caseRow] = await db.select({
      id: onbCases.id, workforceContext: onbCases.workforceContext,
    }).from(onbCases).where(and(
      eq(onbCases.id, currentLink.caseId), eq(onbCases.organizationId, currentLink.organizationId),
    ));
    if (!caseRow) return undefined;
    const lifecycle = await evaluateSensitiveLifecycleGate({
      organizationId: currentLink.organizationId,
      jurisdiction: jurisdictionForWorkforceContext(caseRow.workforceContext),
      dataClass: "candidate-portal",
      disclosure: false,
    });
    if (!lifecycle.allowed) return undefined;
    const secret = newSecret();
    const sessionExpiry = new Date(Math.min(currentLink.expiresAt.getTime(), Date.now() + 30 * 60_000));
    const attempt = await appendProtectedAudit({
      organizationId: currentLink.organizationId,
      actorKind: "system",
      actorAuthority: "candidate-token:validated",
      action: "onboarding.candidate-session.exchange.attempted",
      outcome: "attempted",
      objectType: "candidate-link",
      objectId: String(currentLink.id),
      caseReference: `case:${currentLink.caseId}`,
      source: "candidate-public",
    });
    await db.transaction(async (tx) => {
      await tx.insert(onbCandidateSessions).values({
        idHash: hashSecret(secret), organizationId: currentLink.organizationId,
        caseId: currentLink.caseId, linkId: currentLink.id, expiresAt: sessionExpiry,
      });
      await appendProtectedAuditInTransaction(tx, {
        organizationId: currentLink.organizationId,
        actorKind: "system",
        actorAuthority: "candidate-token:validated",
        action: "onboarding.candidate-session.exchange.outcome",
        outcome: "success",
        objectType: "candidate-link",
        objectId: String(currentLink.id),
        caseReference: `case:${currentLink.caseId}`,
        source: "candidate-public",
        correctionOfId: attempt.id,
      });
    });
    return { secret, expiresAt: sessionExpiry };
  });
}

async function auditLegalHoldActive(organizationId: string): Promise<boolean> {
  const [lifecycle] = await db.select({ active: onbAuditLifecycles.legalHoldActive })
    .from(onbAuditLifecycles)
    .where(eq(onbAuditLifecycles.organizationId, organizationId));
  return lifecycle?.active === true;
}

export async function cleanupCandidateAccess(input: {
  now?: Date;
  organizationId?: string;
  limit?: number;
} = {}): Promise<{ expiredSessions: number; retainedLinksDeleted: number }> {
  if (input.organizationId) {
    return withSensitiveLifecycleFence(input.organizationId, async () => {
      if (await sensitiveLifecycleDestructionHeld(input.organizationId!, "candidate-portal")) {
        return { expiredSessions: 0, retainedLinksDeleted: 0 };
      }
      return cleanupCandidateAccessUnsafe(input);
    });
  }
  return cleanupCandidateAccessUnsafe(input);
}

/**
 * The long-standing settings-approved link cleanup remains intact. The public
 * wrapper merely adds the common lifecycle hold fence; it does not replace a
 * valid existing link-retention approval with an invented statutory period.
 */
async function cleanupCandidateAccessUnsafe(input: {
  now?: Date;
  organizationId?: string;
  limit?: number;
} = {}): Promise<{ expiredSessions: number; retainedLinksDeleted: number }> {
  const now = input.now ?? new Date();
  const limit = Math.max(
    1,
    Math.min(input.limit ?? CANDIDATE_ACCESS_CLEANUP_BATCH_SIZE, CANDIDATE_ACCESS_CLEANUP_BATCH_SIZE),
  );
  // Revocation remains allowed, but physical deletion of candidate sessions or
  // links is privacy-destructive and must pause while evidence is held.
  if (input.organizationId && await auditLegalHoldActive(input.organizationId)) {
    return { expiredSessions: 0, retainedLinksDeleted: 0 };
  }
  const tenantSessionFilter = input.organizationId
    ? eq(onbCandidateSessions.organizationId, input.organizationId)
    : sql`not exists (
      select 1 from ${onbAuditLifecycles}
      where ${onbAuditLifecycles.organizationId} = ${onbCandidateSessions.organizationId}
        and ${onbAuditLifecycles.legalHoldActive} = true
    ) and not exists (
      select 1 from ${onbSensitiveLifecycleHolds}
      where ${onbSensitiveLifecycleHolds.organizationId} = ${onbCandidateSessions.organizationId}
        and ${onbSensitiveLifecycleHolds.active} = true
        and (${onbSensitiveLifecycleHolds.dataClass} is null or ${onbSensitiveLifecycleHolds.dataClass} = 'candidate-portal')
        and (${onbSensitiveLifecycleHolds.caseId} is null or ${onbSensitiveLifecycleHolds.caseId} = ${onbCandidateSessions.caseId})
    )`;
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

  const retentionDays = input.organizationId
    ? await getCandidateLinkRetentionDays(input.organizationId)
    : undefined;
  const tenantLinkFilter = input.organizationId
    ? eq(onbCandidateLinks.organizationId, input.organizationId)
    : sql`not exists (
      select 1 from ${onbAuditLifecycles}
      where ${onbAuditLifecycles.organizationId} = ${onbCandidateLinks.organizationId}
        and ${onbAuditLifecycles.legalHoldActive} = true
    ) and not exists (
      select 1 from ${onbSensitiveLifecycleHolds}
      where ${onbSensitiveLifecycleHolds.organizationId} = ${onbCandidateLinks.organizationId}
        and ${onbSensitiveLifecycleHolds.active} = true
        and (${onbSensitiveLifecycleHolds.dataClass} is null or ${onbSensitiveLifecycleHolds.dataClass} = 'candidate-portal')
        and (${onbSensitiveLifecycleHolds.caseId} is null or ${onbSensitiveLifecycleHolds.caseId} = ${onbCandidateLinks.caseId})
    )`;
  const retainedLongEnough = retentionDays === undefined
    ? or(
        and(
          isNull(onbCandidateLinks.revokedAt),
          sql`${onbCandidateLinks.expiresAt} <= ${now}::timestamptz - (
            case coalesce((
              select ${onbSettings.value}
              from ${onbSettings}
              where ${onbSettings.organizationId} = ${onbCandidateLinks.organizationId}
                and ${onbSettings.key} = ${CANDIDATE_LINK_RETENTION_DAYS_KEY}
            ), ${String(DEFAULT_CANDIDATE_LINK_RETENTION_DAYS)})
              when '30' then interval '30 days'
              when '180' then interval '180 days'
              when '365' then interval '365 days'
              else interval '90 days'
            end
          )`,
        ),
        sql`${onbCandidateLinks.revokedAt} <= ${now}::timestamptz - (
          case coalesce((
            select ${onbSettings.value}
            from ${onbSettings}
            where ${onbSettings.organizationId} = ${onbCandidateLinks.organizationId}
              and ${onbSettings.key} = ${CANDIDATE_LINK_RETENTION_DAYS_KEY}
          ), ${String(DEFAULT_CANDIDATE_LINK_RETENTION_DAYS)})
            when '30' then interval '30 days'
            when '180' then interval '180 days'
            when '365' then interval '365 days'
            else interval '90 days'
          end
        )`,
      )
    : (() => {
        const retentionCutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
        return or(
          and(isNull(onbCandidateLinks.revokedAt), lte(onbCandidateLinks.expiresAt, retentionCutoff)),
          lte(onbCandidateLinks.revokedAt, retentionCutoff),
        );
      })();
  const retainedLinkIds = db
    .select({ id: onbCandidateLinks.id })
    .from(onbCandidateLinks)
    .where(and(
      retainedLongEnough,
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

export const candidateExchangeLimiter = new CandidateExchangeLimiter();
