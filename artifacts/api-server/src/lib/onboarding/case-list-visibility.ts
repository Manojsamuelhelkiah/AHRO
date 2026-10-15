import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, caseListVisibility, caseListVisibilityChanges, onbCases, organizationMembershipsTable, DEMO_ORGANIZATION_ID } from "@workspace/db";
import { UpdateCaseListVisibilityBody } from "@workspace/api-zod";
import { isSharedDemoPrincipalInTransaction, hasHumanPermissions } from "../human-permissions";
import type { OnboardingDbTransaction } from "./settings";
import { actionCenterFamily } from "./action-center-family";

export class CaseListVisibilityError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Deliberately requires named membership, even for an elevated shared Demo login. */
export async function namedCaseListAdministrator(tx: OnboardingDbTransaction, organizationId: string, actor: string) {
  if (organizationId !== DEMO_ORGANIZATION_ID || !actor ||
      await isSharedDemoPrincipalInTransaction(tx, actor)) return false;
  const [member] = await tx.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, actor),
    isNull(organizationMembershipsTable.revokedAt),
  )).limit(1).for("share");
  return !!member && ["owner", "admin"].includes(member.role);
}

/** The caller supplies only case IDs already admitted by its normal list authorization. */
export async function caseListVisibilityProjection(organizationId: string, actor: string, ids: number[]) {
  if (organizationId !== DEMO_ORGANIZATION_ID || !ids.length) return { administrator: false, byCase: new Map<number, { hidden: boolean; version: number }>() };
  return db.transaction(async tx => {
    const rows = await tx.select().from(caseListVisibility).where(and(
      eq(caseListVisibility.organizationId, organizationId), inArray(caseListVisibility.caseId, ids),
    ));
    return { administrator: await namedCaseListAdministrator(tx, organizationId, actor),
      byCase: new Map(rows.map(row => [row.caseId, row])) };
  });
}

export async function updateCaseListVisibility(organizationId: string, actor: string, input: unknown) {
  const parsed = UpdateCaseListVisibilityBody.safeParse(input);
  if (!parsed.success) throw new CaseListVisibilityError(400, "Select 1–100 individual cases and confirm that only the working list changes.");
  const body = parsed.data;
  const ids = body.selection.map(item => item.caseId);
  if (new Set(ids).size !== ids.length || body.selection.some(item =>
    !Number.isSafeInteger(item.caseId) || item.caseId < 1 ||
    !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 0)) {
    throw new CaseListVisibilityError(400, "Selection contains invalid or repeated case references.");
  }
  return db.transaction(async tx => {
    // Same fence used by membership/grant writers; also serializes absent visibility rows.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
    if (!await namedCaseListAdministrator(tx, organizationId, actor)) {
      throw new CaseListVisibilityError(403, "A current named Demo Organization owner or administrator is required.");
    }
    const rows = await tx.select().from(onbCases).where(and(
      eq(onbCases.organizationId, organizationId), inArray(onbCases.id, ids),
    )).orderBy(onbCases.id).for("update");
    if (rows.length !== ids.length) throw new CaseListVisibilityError(403, "One or more selected cases are unavailable. No changes were made.");
    const current = await tx.select().from(caseListVisibility).where(and(
      eq(caseListVisibility.organizationId, organizationId), inArray(caseListVisibility.caseId, ids),
    ));
    const versions = new Map(current.map(row => [row.caseId, row]));
    // Validate the WHOLE batch before writing any metadata or audit.
    for (const row of rows) {
      if (!await hasHumanPermissions(tx, { organizationId, actorUserId: actor, caseId: row.id,
        requiredKeys: ["flow.case.read", "flow.case.edit"], ownerAdminRequired: true })) {
        throw new CaseListVisibilityError(403, "Current read and edit access is required for every selected case. No changes were made.");
      }
      const item = body.selection.find(item => item.caseId === row.id)!;
      const family = actionCenterFamily(row);
      if (!["Onboarding", "Offboarding"].includes(family) || family !== item.caseFamily ||
          (versions.get(row.id)?.version ?? 0) !== item.expectedVersion ||
          (versions.get(row.id)?.hidden ?? false) === body.hidden) {
        throw new CaseListVisibilityError(409, "The selection or its visibility changed. Reload the list and review it again. No changes were made.");
      }
    }
    for (const item of body.selection) {
      const version = item.expectedVersion + 1;
      await tx.insert(caseListVisibility).values({ organizationId, caseId: item.caseId, hidden: body.hidden, version })
        .onConflictDoUpdate({ target: [caseListVisibility.organizationId, caseListVisibility.caseId],
          set: { hidden: body.hidden, version } });
      await tx.insert(caseListVisibilityChanges).values({ organizationId, caseId: item.caseId, hidden: body.hidden, version, actorUserId: actor });
    }
    return { updatedCount: ids.length };
  });
}
