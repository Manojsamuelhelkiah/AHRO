import { db } from "@workspace/db";
import { onbCases, onbEvents, onbPolicyEvidence, onbPolicyAuthorities, type OnbReadinessItemRow } from "@workspace/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { LEGACY_CHECKLIST, mandatoryChecklistReady } from "./settings";
import { resumeChecklistOrchestration } from "./engine";
import { reopenApprovalInTransaction } from "./approval-version";
import { canonicalAuthorityRoleId, workforceAuthorityScope } from "./workforce-policies";
import {
  evaluateCaseDerivedLifecycleGateInTransaction,
  jurisdictionForWorkforceContext,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

const CONNECTOR_MANAGED_IDS = new Set(LEGACY_CHECKLIST.map((item) => item.id));

export function isChecklistAdministrator(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

export type ChecklistStatusResult =
  | { ok: true; changed: boolean; case: typeof onbCases.$inferSelect }
  | {
    ok: false;
    code: "not-found" | "not-custom" | "disabled" | "evidence-required" | "unauthorized" | "lifecycle-blocked";
  };

/** Atomic, tenant-owned manual update. A retry of the same state is a no-op. */
export async function setCustomChecklistItemStatus(opts: {
  organizationId: string;
  caseId: number;
  itemId: string;
  status: "ready" | "pending";
  reviewer: string;
  note?: string | null;
  /** Caller-supplied live authority check runs after row/fence acquisition. */
  authorize?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<boolean>;
}): Promise<ChecklistStatusResult> {
  const mutate = () => db.transaction(async (tx): Promise<ChecklistStatusResult> => {
    // Keep the global lock order uniform: authority/revocation tenant fence,
    // then the case row. This prevents a checklist mutation from holding the
    // case while waiting on a decision/revocation that holds the fence.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${opts.organizationId}))`);
    const [c] = await tx.select().from(onbCases).where(and(
      eq(onbCases.id, opts.caseId),
      eq(onbCases.organizationId, opts.organizationId),
    )).for("update");
    if (!c) return { ok: false, code: "not-found" };
    if (opts.authorize && !(await opts.authorize(tx))) return { ok: false, code: "unauthorized" };
    if (CONNECTOR_MANAGED_IDS.has(opts.itemId)) return { ok: false, code: "not-custom" };
    const definition = c.checklistSnapshot.find((item) => item.id === opts.itemId);
    if (!definition) return { ok: false, code: "not-found" };
    if (opts.itemId === "workforce-context-review" || opts.itemId === "policy-rebase-required") {
      return { ok: false, code: "evidence-required" };
    }
    if (!definition.enabled) return { ok: false, code: "disabled" };
    // A reminder, call result, or generic admin toggle cannot replace the
    // evidence trail for independently required safety/fitness gates.
    if (opts.status === "ready" && definition.evidenceRequired) {
      return { ok: false, code: "evidence-required" };
    }
    const readiness = c.readiness.map((item) => ({ ...item })) as OnbReadinessItemRow[];
    const item = readiness.find((row) => row.key === opts.itemId);
    if (!item) return { ok: false, code: "not-found" };
    if (opts.note?.trim()) {
      const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
        organizationId: opts.organizationId,
        jurisdiction: jurisdictionForWorkforceContext(c.workforceContext),
      });
      if (!lifecycle.allowed) return { ok: false, code: "lifecycle-blocked" };
    }
    if (item.status === opts.status && (opts.note === undefined || item.note === opts.note)) {
      return { ok: true, changed: false, case: c };
    }
    item.status = opts.status;
    if (opts.note !== undefined) item.note = opts.note ?? undefined;
    const shouldDemote =
      opts.status === "pending" &&
      definition.mandatory &&
      (c.lifecycleStage === "day1-review" || c.lifecycleStage === "complete");
    const shouldBlock =
      opts.status === "pending" &&
      definition.mandatory &&
      (c.lifecycleStage === "day1-review" || c.lifecycleStage === "complete");
    if (shouldDemote) {
      await reopenApprovalInTransaction(tx, {
        organizationId: opts.organizationId,
        caseId: opts.caseId,
        idempotencyKey: `gateway-c:${opts.caseId}:human-queue`,
        reason: "Automatically reopened because a mandatory readiness item changed; fresh final review is required.",
        actor: opts.reviewer,
      });
    }
    const [updated] = await tx.update(onbCases).set({
      readiness,
      ...(shouldDemote ? { lifecycleStage: "preboarding" } : {}),
      ...(shouldBlock
        ? {
            orchestrationStatus: "checklist-blocked",
            // Boundaries already completed for a Day-1 case. Reopening never
            // replays remote work or welcome communications; it only requires
            // a fresh all-mandatory review.
            orchestrationCheckpoint: "blocked:re-review",
            orchestrationClaimOwner: null,
            orchestrationClaimUntil: null,
          }
        : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(onbCases.id, opts.caseId),
      eq(onbCases.organizationId, opts.organizationId),
    )).returning();
    await tx.insert(onbEvents).values({
      organizationId: opts.organizationId,
      caseId: opts.caseId,
      agent: "human",
      engine: "human",
      hitlPattern: "human-update",
      ruleRef: "Day-1 checklist",
      title: opts.status === "ready" ? "Checklist item completed" : "Checklist item reopened",
      detail: `${opts.reviewer} ${opts.status === "ready" ? "completed" : "reopened"} "${definition.label}"${opts.note ? ` — ${opts.note}` : ""}.`,
    });
    return { ok: true, changed: true, case: updated };
  });
  const result = opts.note?.trim()
    ? await withSensitiveLifecycleFence(opts.organizationId, mutate)
    : await mutate();
  // Always retry the compare-and-set resume for a ready item. If a previous
  // request committed the status but crashed before resume, an idempotent
  // retry must still be able to continue the case.
  if (result.ok && opts.status === "ready") {
    await resumeChecklistOrchestration(opts.caseId);
  }
  return result;
}

/** Used by watcher promotion without making optional items hard gates. */
export { mandatoryChecklistReady };

export type EvidenceVerificationResult =
  | { ok: true; case: typeof onbCases.$inferSelect }
  | { ok: false; code: "not-found" | "not-evidence-gate" | "wrong-authority" | "not-designated" | "prerequisites-unmet" | "stale-policy" | "lifecycle-blocked" | "access-denied" };

/**
 * The only in-product completion path for a policy evidence gate. It stores
 * a reference (not sensitive source content), authority role, decision, and
 * authenticated verifier before changing readiness.
 */
export async function verifyChecklistEvidence(opts: {
  organizationId: string;
  caseId: number;
  itemId: string;
  evidenceReference: string;
  authorityRole: string;
  decision: "verified" | "rejected";
  reason: string;
  verifier: string;
  verifierUserId: string;
  authorizeAccess?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<boolean>;
  expected: { contextVersion: number; templateVersion: number; profileId: string; profileVersion: number };
}): Promise<EvidenceVerificationResult> {
  const result = await withSensitiveLifecycleFence(opts.organizationId, () => db.transaction(async (tx): Promise<EvidenceVerificationResult> => {
    const [c] = await tx.select().from(onbCases).where(and(
      eq(onbCases.id, opts.caseId),
      eq(onbCases.organizationId, opts.organizationId),
    )).for("update");
    if (!c) return { ok: false, code: "not-found" };
    if (opts.authorizeAccess && !(await opts.authorizeAccess(tx))) {
      return { ok: false, code: "access-denied" };
    }
    if (c.workforceContextVersion !== opts.expected.contextVersion ||
      c.checklistTemplateVersion !== opts.expected.templateVersion ||
      c.checklistProfileId !== opts.expected.profileId ||
      (c.checklistProfileVersion ?? c.checklistTemplateVersion) !== opts.expected.profileVersion) return { ok: false, code: "stale-policy" };
    const definition = c.checklistSnapshot.find((item) => item.id === opts.itemId && item.enabled);
    if (opts.itemId === "workforce-context-review" || opts.itemId === "policy-rebase-required") {
      return { ok: false, code: "not-evidence-gate" };
    }
    if (!definition?.evidenceRequired || definition.completionAuthority !== "designated-human") return { ok: false, code: "not-evidence-gate" };
    const readinessById = new Map(c.readiness.map((item) => [item.key, item.status]));
    if ((definition.prerequisites ?? []).some((id) => readinessById.get(id) !== "ready")) {
      return { ok: false, code: "prerequisites-unmet" };
    }
    const authorityRole = canonicalAuthorityRoleId(opts.authorityRole);
    const configuredRole = definition.responsibleRole && canonicalAuthorityRoleId(definition.responsibleRole);
    if (!authorityRole || !configuredRole || configuredRole !== authorityRole) {
      return { ok: false, code: "wrong-authority" };
    }
    const scope = workforceAuthorityScope(c.workforceContext);
    if (!scope) return { ok: false, code: "not-designated" };
    const [authority] = await tx.select({ userId: onbPolicyAuthorities.userId })
      .from(onbPolicyAuthorities).where(and(
        eq(onbPolicyAuthorities.organizationId, opts.organizationId),
        eq(onbPolicyAuthorities.userId, opts.verifierUserId),
        eq(onbPolicyAuthorities.authorityRole, configuredRole),
        eq(onbPolicyAuthorities.caseId, opts.caseId),
        eq(onbPolicyAuthorities.itemId, opts.itemId),
        eq(onbPolicyAuthorities.site, scope),
      isNull(onbPolicyAuthorities.revokedAt),
      )).limit(1);
    if (!authority) return { ok: false, code: "not-designated" };
    const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
      organizationId: opts.organizationId,
      jurisdiction: jurisdictionForWorkforceContext(c.workforceContext),
    });
    if (!lifecycle.allowed) return { ok: false, code: "lifecycle-blocked" };
    await tx.insert(onbPolicyEvidence).values({
      organizationId: opts.organizationId,
      caseId: opts.caseId,
      itemId: opts.itemId,
      evidenceReference: opts.evidenceReference.trim(),
      authorityRole,
      decision: opts.decision,
      reason: opts.reason.trim(),
      verifiedBy: opts.verifier,
      verifiedByUserId: opts.verifierUserId,
      checklistTemplateVersion: c.checklistTemplateVersion,
      checklistProfileId: c.checklistProfileId,
      checklistProfileVersion: c.checklistProfileVersion ?? c.checklistTemplateVersion,
      workforceContextVersion: c.workforceContextVersion,
      authorityAssignmentId: `${opts.organizationId}:${opts.verifierUserId}:${configuredRole}:${opts.caseId}:${opts.itemId}:${scope}`,
    });
    const readiness = c.readiness.map((item) => ({ ...item })) as OnbReadinessItemRow[];
    const row = readiness.find((item) => item.key === opts.itemId);
    if (!row) return { ok: false, code: "not-found" };
    row.status = opts.decision === "verified" ? "ready" : "exception";
    // Do not expose document IDs, medical clearance details, or rationale in
    // broadly displayed readiness metadata.
    row.note = opts.decision === "verified" ? "Independent evidence verified." : "Independent evidence rejected; authority follow-up required.";
    if (opts.decision === "rejected" && (c.lifecycleStage === "day1-review" || c.lifecycleStage === "complete")) {
      await reopenApprovalInTransaction(tx, {
        organizationId: opts.organizationId,
        caseId: opts.caseId,
        // Gate C is a single durable approval cycle for the case. Reopen that
        // actual row, rather than looking up a per-evidence rejection key that
        // is never used when Gate C is created.
        idempotencyKey: `gateway-c:${opts.caseId}:human-queue`,
        reason: "Mandatory independently verified policy evidence was rejected; final review must be repeated.",
        actor: opts.verifier,
      });
    }
    const rejectedAfterReview = opts.decision === "rejected" && (c.lifecycleStage === "day1-review" || c.lifecycleStage === "complete");
    const [updated] = await tx.update(onbCases).set({
      readiness,
      ...(rejectedAfterReview ? {
        lifecycleStage: "preboarding",
        orchestrationStatus: "checklist-blocked",
        orchestrationCheckpoint: "blocked:re-review",
        orchestrationClaimOwner: null,
        orchestrationClaimUntil: null,
      } : {}),
      updatedAt: new Date(),
    })
      .where(and(eq(onbCases.id, opts.caseId), eq(onbCases.organizationId, opts.organizationId))).returning();
    await tx.insert(onbEvents).values({
      organizationId: opts.organizationId,
      caseId: opts.caseId,
      agent: "designated-human-authority",
      engine: "human",
      hitlPattern: "approve-before-act",
      ruleRef: `Policy evidence:${opts.itemId}`,
      title: opts.decision === "verified" ? "Independent evidence verified" : "Independent evidence rejected",
      detail: `${opts.verifier} acting as assigned ${opts.authorityRole} recorded a ${opts.decision} decision for "${definition.label}". Sensitive evidence reference and rationale are restricted to the evidence register.`,
    });
    return { ok: true, case: updated };
  }));
  if (result.ok && opts.decision === "verified") await resumeChecklistOrchestration(opts.caseId);
  return result;
}
