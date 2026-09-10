import { db } from "@workspace/db";
import { onbApprovals, onbCases, onbEvents, type OnbReadinessItemRow } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { LEGACY_CHECKLIST, mandatoryChecklistReady } from "./settings";
import { resumeChecklistOrchestration } from "./engine";

const CONNECTOR_MANAGED_IDS = new Set(LEGACY_CHECKLIST.map((item) => item.id));

export function isChecklistAdministrator(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

export type ChecklistStatusResult =
  | { ok: true; changed: boolean; case: typeof onbCases.$inferSelect }
  | { ok: false; code: "not-found" | "not-custom" | "disabled" };

/** Atomic, tenant-owned manual update. A retry of the same state is a no-op. */
export async function setCustomChecklistItemStatus(opts: {
  organizationId: string;
  caseId: number;
  itemId: string;
  status: "ready" | "pending";
  reviewer: string;
  note?: string | null;
}): Promise<ChecklistStatusResult> {
  const result = await db.transaction(async (tx): Promise<ChecklistStatusResult> => {
    const [c] = await tx.select().from(onbCases).where(and(
      eq(onbCases.id, opts.caseId),
      eq(onbCases.organizationId, opts.organizationId),
    )).for("update");
    if (!c) return { ok: false, code: "not-found" };
    if (CONNECTOR_MANAGED_IDS.has(opts.itemId)) return { ok: false, code: "not-custom" };
    const definition = c.checklistSnapshot.find((item) => item.id === opts.itemId);
    if (!definition) return { ok: false, code: "not-found" };
    if (!definition.enabled) return { ok: false, code: "disabled" };
    const readiness = c.readiness.map((item) => ({ ...item })) as OnbReadinessItemRow[];
    const item = readiness.find((row) => row.key === opts.itemId);
    if (!item) return { ok: false, code: "not-found" };
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
      await tx.update(onbApprovals).set({
        status: "pending", decidedAt: null, decidedBy: null,
        comment: "Automatically reopened because a mandatory readiness item changed; fresh final review is required.",
      }).where(and(
        eq(onbApprovals.organizationId, opts.organizationId),
        eq(onbApprovals.caseId, opts.caseId),
        eq(onbApprovals.status, "approved"),
        eq(onbApprovals.idempotencyKey, `gateway-c:${opts.caseId}:human-queue`),
      ));
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