import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { db, onbAuthorityAssignments, onbAuthorityGovernance, organizationMembershipsTable, type OnbAuthorityScope, type SeparationReceipt } from "@workspace/db";
import { roleMayExerciseScope } from "../onboarding/decision-authority";
import { resolveEffectiveAccessInTransaction } from "../access-governance";
import { SeparationError } from "./model";
import { registeredDemoProfile } from "../demo-principal";
import { isPlatformSuperAdmin } from "../private-platform-admin";
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function lockTenant(tx: Tx, organizationId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
}
export async function access(tx: Tx, organizationId: string, actor: string, write: boolean, caseId?: number) {
  await lockTenant(tx, organizationId);
  if (await registeredDemoProfile(actor) && (write || !isPlatformSuperAdmin(actor, organizationId))) throw new SeparationError("Demo principals cannot operate real separations.", 403);
  const a = await resolveEffectiveAccessInTransaction(tx, { organizationId, principalType: "human", principalId: actor, caseId, purpose: "controlled-offboarding" });
  const keys = write ? ["flow.case.edit", "data.case.profile.edit"] : ["flow.case.read", "data.case.profile.read"];
  if (keys.some(k => !a.allows.includes(k))) throw new SeparationError("Current explicit case-flow and profile access is required.", 403);
}
/** Opaque source narratives may contain any existing sensitive record class. */
export async function confidentialRead(tx: Tx, org: string, actor: string, country?: string, caseId?: number) {
  await access(tx, org, actor, false, caseId);
  const a = await resolveEffectiveAccessInTransaction(tx, { organizationId: org, principalType: "human", principalId: actor, caseId, purpose: "offboarding-private-evidence" });
  for (const key of ["data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"]) if (!a.allows.includes(key)) throw new SeparationError("Opaque evidence requires current access to all potentially sensitive record classes.", 403);
  // Preserve the separately verified, tenant-bound administrative viewing
  // agreement. This read exception never supplies decision/execution authority.
  if (isPlatformSuperAdmin(actor, org)) return;
  for (const scope of ["hr-compliance-approve", "legal-approve", "payroll-approve", "occupational-health-approve"]) await authority(tx, org, actor, scope, country, caseId);
}
/** Fixed, numeric settlement fields are Payroll data, not opaque narratives. */
export async function payrollRead(tx: Tx, org: string, actor: string, country: string, caseId: number) {
  await access(tx, org, actor, false, caseId);
  const a = await resolveEffectiveAccessInTransaction(tx, { organizationId: org, principalType: "human", principalId: actor, caseId, purpose: "offboarding-settlement-review" });
  if (!a.allows.includes("data.payroll.read")) throw new SeparationError("Current Payroll field access is required.", 403);
  try { await authority(tx, org, actor, "finance-approve", country, caseId); }
  catch (e) { if (!(e instanceof SeparationError)) throw e; await authority(tx, org, actor, "payroll-approve", country, caseId); }
}
export async function authority(tx: Tx, organizationId: string, actor: string, scope: string, country?: string, caseId?: number) {
  if (await registeredDemoProfile(actor)) throw new SeparationError("Synthetic authority cannot operate real separations.", 403);
  const [g] = await tx.select().from(onbAuthorityGovernance).where(eq(onbAuthorityGovernance.organizationId, organizationId));
  const [m] = await tx.select().from(organizationMembershipsTable).where(and(eq(organizationMembershipsTable.organizationId, organizationId), eq(organizationMembershipsTable.clerkUserId, actor), isNull(organizationMembershipsTable.revokedAt)));
  if (g?.status !== "governance-approved" || !m) throw new SeparationError("Verified tenant authority governance and current membership are required.", 403);
  const now = new Date();
  const rows = await tx.select().from(onbAuthorityAssignments).where(and(eq(onbAuthorityAssignments.organizationId, organizationId), eq(onbAuthorityAssignments.personUserId, actor), eq(onbAuthorityAssignments.status, "active"), lte(onbAuthorityAssignments.validFrom, now), or(isNull(onbAuthorityAssignments.validUntil), gt(onbAuthorityAssignments.validUntil, now)))).for("update");
  const row = rows.find(r => r.scopes.includes(scope as OnbAuthorityScope) &&
    roleMayExerciseScope(r.authorityRole, scope as OnbAuthorityScope) &&
    (r.caseId === null || r.caseId === caseId) && !r.siteScope &&
    (!r.jurisdictionScope || r.jurisdictionScope === country) && !r.source.startsWith("synthetic"));
  if (!row) throw new SeparationError(`Current verified ${scope} authority is required. Membership or an owner role is insufficient.`, 403);
  return row;
}
export async function receipt(tx: Tx, input: { organizationId: string; actor: string; scope: string; country?: string; caseId?: number; reference: string; generation: number }): Promise<SeparationReceipt> {
  const a = await authority(tx, input.organizationId, input.actor, input.scope, input.country, input.caseId);
  return { actor: input.actor, authorityId: a.id, authorityRevision: a.revision, scope: input.scope, reference: input.reference, generation: input.generation, recordedAt: new Date().toISOString(), provenance: "human-source-attested" };
}
export async function currentReceipt(tx: Tx, org: string, r: SeparationReceipt | null, country: string, caseId?: number) {
  if (!r) return false;
  try { const a = await authority(tx, org, r.actor, r.scope, country, caseId); return a.id === r.authorityId && a.revision === r.authorityRevision; } catch (e) { if (e instanceof SeparationError) return false; throw e; }
}
