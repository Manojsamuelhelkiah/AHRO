import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbAuditEntries,
  onbAuditLifecycles,
  onbAuthorityAssignments,
  onbCases,
} from "@workspace/db/schema";
import { getOrganizationId } from "../lib/organization-scope";
import { registeredDemoProfile } from "../lib/demo-principal";
import {
  appendProtectedAudit,
  appendProtectedAuditInTransaction,
  listProtectedAudit,
  listRetainedApprovalHistory,
  protectedAuditCaseReference,
  verifyProtectedAudit,
  verifiedAuditAuthority,
  type AuditFilter,
  type AuditOutcome,
} from "../lib/onboarding/protected-audit";
import {
  enqueueAuditLegalHoldInTransaction,
  legalHoldReasonFingerprint,
} from "../lib/onboarding/external-audit-anchor";
import {
  hasOpaqueNarrativeAccess,
  resolveSensitiveAccess,
} from "../lib/onboarding/sensitive-access";
import {
  isSyntheticOfflineCase,
  SYNTHETIC_DEMO_AUTHORITY_SOURCE,
} from "../lib/onboarding/synthetic-offline";

const router: IRouter = Router();

async function requireAuditReviewer(req: Request, res: Response): Promise<boolean> {
  const organizationId = getOrganizationId(req);
  const role = req.authUserId
    ? await verifiedAuditAuthority(organizationId, req.authUserId)
    : null;
  if (role === "owner" || role === "admin") return true;
  res.status(403).json({ message: "Organization owner or admin role required for protected audit review." });
  return false;
}

async function demoAuditFilter(req: Request, res: Response): Promise<Pick<AuditFilter, "caseReferences" | "includeUnscopedActorId"> | null> {
  const organizationId = getOrganizationId(req);
  const userId = req.authUserId!;
  const [profile, membershipRole] = await Promise.all([
    registeredDemoProfile(userId),
    verifiedAuditAuthority(organizationId, userId),
  ]);
  if (
    organizationId !== DEMO_ORGANIZATION_ID ||
    profile !== "administrator" ||
    membershipRole === null
  ) {
    res.status(403).json({
      message: "A current Demo Administrator profile is required for demo-scoped audit review.",
    });
    return null;
  }

  const assignments = await db.select({
    caseId: onbAuthorityAssignments.caseId,
    notes: onbCases.notes,
    scenarioKey: onbCases.scenarioKey,
  }).from(onbAuthorityAssignments).innerJoin(onbCases, and(
    eq(onbCases.organizationId, onbAuthorityAssignments.organizationId),
    eq(onbCases.id, onbAuthorityAssignments.caseId),
  )).where(and(
    eq(onbAuthorityAssignments.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbAuthorityAssignments.personUserId, userId),
    eq(onbAuthorityAssignments.status, "active"),
    eq(onbAuthorityAssignments.source, SYNTHETIC_DEMO_AUTHORITY_SOURCE),
    isNull(onbAuthorityAssignments.revokedAt),
  ));
  const caseReferences = [...new Set(assignments
    .filter((row) => row.caseId !== null && isSyntheticOfflineCase(row))
    .map((row) => protectedAuditCaseReference(row.caseId!)))];
  return { caseReferences, includeUnscopedActorId: userId };
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function queryFilter(req: Request): AuditFilter | null {
  const outcome = typeof req.query.outcome === "string" ? req.query.outcome : undefined;
  if (outcome && !["attempted", "success", "denied", "failure"].includes(outcome)) return null;
  const from = optionalDate(req.query.from);
  const to = optionalDate(req.query.to);
  if ((req.query.from && !from) || (req.query.to && !to) || (from && to && from > to)) return null;
  const stringQuery = (key: string, max = 200) => {
    const value = req.query[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
  };
  return {
    from, to,
    action: stringQuery("action", 160),
    objectType: stringQuery("objectType", 120),
    objectId: stringQuery("objectId"),
    actorId: stringQuery("actorId"),
    outcome: outcome as AuditOutcome | undefined,
    afterSequence: positiveInteger(req.query.cursor),
    limit: positiveInteger(req.query.limit),
  };
}

function entryView(entry: Awaited<ReturnType<typeof listProtectedAudit>>[number]) {
  return {
    id: entry.id,
    sequence: entry.sequence,
    occurredAt: entry.occurredAt.toISOString(),
    actorId: entry.actorId,
    actorKind: entry.actorKind,
    actorAuthority: entry.actorAuthority,
    action: entry.action,
    outcome: entry.outcome,
    objectType: entry.objectType,
    objectId: entry.objectId,
    caseReference: entry.caseReference,
    reviewedRevision: entry.reviewedRevision,
    source: entry.source,
    correlationId: entry.correlationId,
    payload: entry.payload,
    correctionOfId: entry.correctionOfId,
    previousHash: entry.previousHash,
    entryHash: entry.entryHash,
  };
}

export function auditCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet formula execution when exported audit is opened.
  const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

/** Deliberately excludes payload data; keep export construction testable. */
export function protectedAuditCsv(
  entries: Awaited<ReturnType<typeof listProtectedAudit>>,
  integrity: Awaited<ReturnType<typeof verifyProtectedAudit>>,
  nextCursor: string | null = null,
): string {
  const header = [
    "sequence", "occurredAt", "actorId", "actorKind", "actorAuthority",
    "action", "outcome", "objectType", "objectId", "caseReference",
    "reviewedRevision", "source", "correlationId", "correctionOfId",
    "previousHash", "entryHash",
  ];
  const rows = entries.map((entry) => [
    entry.sequence, entry.occurredAt.toISOString(), entry.actorId, entry.actorKind,
    entry.actorAuthority, entry.action, entry.outcome, entry.objectType,
    entry.objectId, entry.caseReference, entry.reviewedRevision, entry.source,
    entry.correlationId, entry.correctionOfId, entry.previousHash, entry.entryHash,
  ].map(auditCsvCell).join(","));
  const integrityFooter = [
    `# integrity_status=${integrity.status}`,
    `# checked_entries=${integrity.checkedEntries}`,
    `# external_anchoring_required_for_launch=${integrity.externalAnchoring.requiredForLaunch}`,
    `# external_anchoring_provider_kind=${integrity.externalAnchoring.providerKind ?? "unknown"}`,
    `# external_anchoring_configured=${integrity.externalAnchoring.configured}`,
    `# external_anchoring_verified=${integrity.externalAnchoring.verified ?? false}`,
    `# external_anchoring_local_comparison=${integrity.externalAnchoring.comparison ?? "unknown"}`,
    `# regulated_production_launch_blocked=${integrity.externalAnchoring.regulatedProductionLaunchBlocked}`,
    "# export_page_limit=500",
    `# export_truncated=${nextCursor !== null}`,
    `# next_cursor=${nextCursor ?? ""}`,
  ];
  return [header.join(","), ...rows, ...integrityFooter].join("\n");
}

async function lifecycleView(organizationId: string) {
  const [row] = await db.select().from(onbAuditLifecycles)
    .where(eq(onbAuditLifecycles.organizationId, organizationId));
  return {
    retentionStatement: row?.retentionStatement ?? null,
    reviewedBy: row?.reviewedBy ?? null,
    reviewedAt: row?.reviewedAt?.toISOString() ?? null,
    legalHold: {
      active: row?.legalHoldActive ?? false,
      reason: row?.legalHoldReason ?? null,
      setBy: row?.legalHoldSetBy ?? null,
      setAt: row?.legalHoldSetAt?.toISOString() ?? null,
      releasedBy: row?.legalHoldReleasedBy ?? null,
      releasedAt: row?.legalHoldReleasedAt?.toISOString() ?? null,
    },
    automaticPurge: false,
    retentionDeadline: null,
    historicalCoverage: "Existing events and approval snapshots predate protected audit capture. They are retained historical coverage, not retroactively immutable or attributed.",
  };
}

router.get("/onboarding/audit", async (req, res, next) => {
  try {
    const demoScope = req.query.scope === "demo";
    if (req.query.scope && req.query.scope !== "organization" && !demoScope) {
      res.status(400).json({ message: "Invalid audit scope." });
      return;
    }
    const internalScope = demoScope
      ? await demoAuditFilter(req, res)
      : null;
    if (demoScope && !internalScope) return;
    if (!demoScope && !(await requireAuditReviewer(req, res))) return;
    const filter = queryFilter(req);
    if (!filter) {
      res.status(400).json({ message: "Invalid audit filters." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const entries = await listProtectedAudit(organizationId, {
      ...filter,
      ...internalScope,
    });
    const integrity = demoScope ? null : await verifyProtectedAudit(organizationId);
    res.json({
      entries: entries.map(entryView),
      nextCursor: entries.length === (filter.limit ?? 100) ? String(entries.at(-1)?.sequence ?? "") : null,
      integrity,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/onboarding/audit/export", async (req, res, next) => {
  try {
    if (!(await requireAuditReviewer(req, res))) return;
    const filter = queryFilter(req);
    if (!filter) {
      res.status(400).json({ message: "Invalid audit filters." });
      return;
    }
    const organizationId = getOrganizationId(req);
    await appendProtectedAudit({
      organizationId, actorId: req.authUserId!, actorKind: "authenticated",
      actorAuthority: `tenant-membership:${req.organizationRole}`,
      action: "onboarding.audit.export", outcome: "success",
      objectType: "audit-export", source: "http",
      correlationId: req.header("x-request-id") ?? null,
      payload: { exportFormat: "csv" },
    });
    const [fetchedEntries, integrity] = await Promise.all([
      // Fetch one extra row so CSV never silently omits matching evidence.
      listProtectedAudit(organizationId, { ...filter, limit: 501 }),
      verifyProtectedAudit(organizationId),
    ]);
    const hasMore = fetchedEntries.length > 500;
    const entries = hasMore ? fetchedEntries.slice(0, 500) : fetchedEntries;
    const nextCursor = hasMore ? String(entries.at(-1)!.sequence) : null;
    res.type("text/csv").attachment("onboarding-protected-audit.csv")
      .send(protectedAuditCsv(entries, integrity, nextCursor));
  } catch (error) {
    next(error);
  }
});

router.get("/onboarding/audit/integrity", async (req, res, next) => {
  try {
    if (!(await requireAuditReviewer(req, res))) return;
    res.json(await verifyProtectedAudit(getOrganizationId(req)));
  } catch (error) {
    next(error);
  }
});

/**
 * This is intentionally independent of a live approval lookup. Approval
 * snapshots are historical evidence and must remain reviewable after the
 * case/approval record has been deleted.
 */
router.get("/onboarding/audit/approval-history/:approvalId", async (req, res, next) => {
  try {
    if (!(await requireAuditReviewer(req, res))) return;
    const approvalId = positiveInteger(req.params.approvalId);
    if (!approvalId) {
      res.status(400).json({ message: "approvalId must be a positive integer." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const entries = await listRetainedApprovalHistory(organizationId, approvalId);
    res.json(await Promise.all(entries.map(async (entry) => {
      const opaqueSnapshotPresent = Boolean(
        entry.comment ||
        entry.reason ||
        (entry.snapshot && Object.keys(entry.snapshot).length > 0),
      );
      const access = await resolveSensitiveAccess({
        organizationId,
        caseId: entry.caseId,
        actorUserId: req.authUserId,
      });
      if (opaqueSnapshotPresent && !hasOpaqueNarrativeAccess(access)) {
        // Historical evidence remains append-only in storage, but the
        // reviewer-facing projection does not disclose its sensitive content
        // merely because the reviewer is a tenant owner/admin.
        return {
          id: entry.id,
          approvalId: entry.approvalId,
          caseId: entry.caseId,
          version: entry.version,
          eventType: entry.eventType,
          status: entry.status,
          restricted: true,
          comment: null,
          reason: "Restricted specialist approval history.",
          snapshot: { restricted: true },
          createdAt: entry.createdAt,
          decidedAt: entry.decidedAt,
        };
      }
      return entry;
    })));
  } catch (error) {
    next(error);
  }
});

router.get("/onboarding/audit/lifecycle", async (req, res, next) => {
  try {
    if (!(await requireAuditReviewer(req, res))) return;
    res.json(await lifecycleView(getOrganizationId(req)));
  } catch (error) {
    next(error);
  }
});

router.put("/onboarding/audit/lifecycle/retention", async (req, res, next) => {
  try {
    if (!(await requireAuditReviewer(req, res))) return;
    const retentionStatement = typeof req.body?.retentionStatement === "string"
      ? req.body.retentionStatement.trim().slice(0, 2000) : "";
    if (!retentionStatement) {
      res.status(400).json({ message: "A reviewed retention statement is required; retention deadlines are not accepted." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(onbAuditLifecycles).values({
        organizationId, retentionStatement, reviewedBy: req.authUserId!,
        reviewedAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: onbAuditLifecycles.organizationId,
        set: { retentionStatement, reviewedBy: req.authUserId!, reviewedAt: now, updatedAt: now },
      });
      await appendProtectedAuditInTransaction(tx, {
        organizationId, actorId: req.authUserId!, actorKind: "authenticated",
        actorAuthority: `tenant-membership:${req.organizationRole}`,
        action: "onboarding.audit.retention.reviewed", outcome: "success",
        objectType: "audit-lifecycle", source: "http",
        correlationId: req.header("x-request-id") ?? null,
        payload: { statementLength: retentionStatement.length },
      });
    });
    res.json(await lifecycleView(organizationId));
  } catch (error) {
    next(error);
  }
});

router.post("/onboarding/audit/lifecycle/legal-hold", async (req, res, next) => {
  try {
    if (!(await requireAuditReviewer(req, res))) return;
    const action = req.body?.action;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 2000) : "";
    if ((action !== "set" && action !== "release") || !reason) {
      res.status(400).json({ message: "action must be set or release and a reason is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const now = new Date();
    await db.transaction(async (tx) => {
      const set = action === "set"
        ? {
            legalHoldActive: true, legalHoldReason: reason, legalHoldSetBy: req.authUserId!,
            legalHoldSetAt: now, legalHoldReleasedBy: null, legalHoldReleasedAt: null, updatedAt: now,
          }
        : {
            legalHoldActive: false, legalHoldReason: null, legalHoldReleasedBy: req.authUserId!,
            legalHoldReleasedAt: now, updatedAt: now,
          };
      await tx.insert(onbAuditLifecycles).values({ organizationId, ...set }).onConflictDoUpdate({
        target: onbAuditLifecycles.organizationId, set,
      });
      const [lifecycle] = await tx.select({
        retentionStatement: onbAuditLifecycles.retentionStatement,
      }).from(onbAuditLifecycles).where(eq(onbAuditLifecycles.organizationId, organizationId));
      const auditEntry = await appendProtectedAuditInTransaction(tx, {
        organizationId, actorId: req.authUserId!, actorKind: "authenticated",
        actorAuthority: `tenant-membership:${req.organizationRole}`,
        action: action === "set" ? "onboarding.audit.legal-hold.set" : "onboarding.audit.legal-hold.released",
        outcome: "success", objectType: "audit-lifecycle", source: "http",
        correlationId: req.header("x-request-id") ?? null,
        payload: { reasonProvided: true },
      });
      // The protected audit sequence is the durable transition identity. It
      // prevents set/release/set with the same reason from colliding while
      // keeping the lifecycle mutation, audit record, and provider outbox
      // atomic.
      await enqueueAuditLegalHoldInTransaction(tx, {
        organizationId,
        active: action === "set",
        reasonFingerprint: legalHoldReasonFingerprint(reason),
        retentionStatementPresent: Boolean(lifecycle?.retentionStatement),
        transitionId: String(auditEntry.sequence),
      });
    });
    res.json(await lifecycleView(organizationId));
  } catch (error) {
    next(error);
  }
});

router.post("/onboarding/audit/corrections", async (req, res, next) => {
  try {
    if (!(await requireAuditReviewer(req, res))) return;
    const entryId = positiveInteger(req.body?.entryId);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!entryId || !reason || reason.length > 2000) {
      res.status(400).json({ message: "A valid entryId and correction reason are required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const [original] = await db.select({ id: onbAuditEntries.id }).from(onbAuditEntries).where(and(
      eq(onbAuditEntries.id, entryId), eq(onbAuditEntries.organizationId, organizationId),
    ));
    if (!original) {
      res.status(404).json({ message: "Audit entry not found." });
      return;
    }
    const entry = await appendProtectedAudit({
      organizationId, actorId: req.authUserId!, actorKind: "authenticated",
      actorAuthority: `tenant-membership:${req.organizationRole}`,
      action: "onboarding.audit.correction.recorded", outcome: "success",
      objectType: "audit-correction", objectId: String(entryId), source: "http",
      correlationId: req.header("x-request-id") ?? null, correctionOfId: entryId,
      payload: { reasonProvided: true },
    });
    res.status(201).json(entryView(entry));
  } catch (error) {
    next(error);
  }
});

export default router;