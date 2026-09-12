import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { onbCaseLogistics } from "@workspace/db/schema";
import { logisticsForCase } from "./logistics-defaults";
import { getDay1LogisticsDefault } from "./settings";
import { withCaseDerivedLifecycleWrite } from "./sensitive-lifecycle";

export async function ensureCaseLogistics(
  organizationId: string,
  caseId: number,
) {
  const [existing] = await db.select()
    .from(onbCaseLogistics)
    .where(and(
      eq(onbCaseLogistics.organizationId, organizationId),
      eq(onbCaseLogistics.caseId, caseId),
    ));
  if (existing) return existing;
  // A read endpoint must not silently create an opaque logistics record.
  // Callers can present this as an explicit missing state; only the
  // lifecycle- and authority-gated PUT path may persist it.
  return null;
}

/**
 * Explicit, lifecycle-gated one-time backfill for legacy cases that predate
 * case logistics. This is never used by a GET/read path. The existing row is
 * locked and returned unchanged, so later tenant-default edits cannot rewrite
 * a case's already-decided Day-1 details.
 */
export async function initializeCaseLogistics(
  organizationId: string,
  caseId: number,
) {
  const defaults = await getDay1LogisticsDefault(organizationId);
  return withCaseDerivedLifecycleWrite({ organizationId, caseId }, async (tx, caseRow) => {
    const [existing] = await tx.select().from(onbCaseLogistics).where(and(
      eq(onbCaseLogistics.organizationId, organizationId),
      eq(onbCaseLogistics.caseId, caseId),
    )).for("update");
    if (existing) return existing;
    const [inserted] = await tx.insert(onbCaseLogistics).values({
      organizationId,
      caseId,
      ...logisticsForCase(defaults, caseRow.joiningDate),
    }).onConflictDoNothing({
      target: [onbCaseLogistics.organizationId, onbCaseLogistics.caseId],
    }).returning();
    if (inserted) return inserted;
    const [concurrent] = await tx.select().from(onbCaseLogistics).where(and(
      eq(onbCaseLogistics.organizationId, organizationId),
      eq(onbCaseLogistics.caseId, caseId),
    ));
    if (!concurrent) throw new Error("Unable to initialize case logistics.");
    return concurrent;
  });
}