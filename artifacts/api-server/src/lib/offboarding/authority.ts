import { sql } from "drizzle-orm";
import { db, type SeparationReceipt } from "@workspace/db";
import { hasHumanPermissions, permissionReceiptStillCurrent, type HumanPermissionReceipt } from "../human-permissions";
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
  // Class permissions above are the sole data-access prerequisite.
}
/** Fixed, numeric settlement fields are Payroll data, not opaque narratives. */
export async function payrollRead(tx: Tx, org: string, actor: string, country: string, caseId: number) {
  await access(tx, org, actor, false, caseId);
  const a = await resolveEffectiveAccessInTransaction(tx, { organizationId: org, principalType: "human", principalId: actor, caseId, purpose: "offboarding-settlement-review" });
  if (!a.allows.includes("data.payroll.read")) throw new SeparationError("Current Payroll field access is required.", 403);
  // Reading settlement fields is not an approval decision.
}
export async function authority(tx: Tx, organizationId: string, actor: string, scope: string, country?: string, caseId?: number) {
  if (!await hasHumanPermissions(tx, { organizationId, actorUserId: actor, caseId,
    requiredKeys: ["flow.case.edit", "data.case.profile.edit"] }))
    throw new SeparationError("A named client member with current case-flow and profile edit permissions is required.", 403);
  return { id: `human-permission/v1:${actor}`, revision: 1 };
}
export async function receipt(tx: Tx, input: { organizationId: string; actor: string; scope: string; country?: string; caseId?: number; reference: string; generation: number; policyAction?: boolean }): Promise<SeparationReceipt> {
  const a = await authority(tx, input.organizationId, input.actor, input.scope, input.country, input.caseId);
  const actionKey = input.policyAction ? "tool.policy.manage" as const : "tool.approval.decide" as const;
  if (!await hasHumanPermissions(tx, { organizationId: input.organizationId, actorUserId: input.actor, caseId: input.caseId,
    requiredKeys: [actionKey] })) throw new SeparationError(`Current ${actionKey} permission is required.`, 403);
  const recordedAt = new Date().toISOString();
  return { actor: input.actor, authorityId: a.id, authorityRevision: a.revision, scope: input.scope,
    reference: input.reference, generation: input.generation, recordedAt, provenance: "human-source-attested",
    authorization: { schema: "human-permission/v1", organizationId: input.organizationId,
      caseId: input.caseId ?? null, actorUserId: input.actor,
      requiredKeys: [actionKey, "flow.case.edit", "data.case.profile.edit"],
      reviewedRevision: input.generation, evidenceGeneration: input.generation,
      decision: "source-attested", recordedAt, ownerAdminRequired: false } };
}
export async function currentReceipt(tx: Tx, org: string, r: SeparationReceipt | null, country: string, caseId?: number, policyAction = false) {
  if (!r) return false;
  if (r.actor !== r.authorization?.actorUserId) return false;
  return permissionReceiptStillCurrent(tx, r.authorization as HumanPermissionReceipt | undefined, {
    organizationId: org, caseId,
    requiredKeys: [policyAction ? "tool.policy.manage" : "tool.approval.decide", "flow.case.edit", "data.case.profile.edit"],
    reviewedRevision: r.generation, evidenceGeneration: r.generation,
  });
}
