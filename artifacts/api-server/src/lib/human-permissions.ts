import { and, eq, isNull } from "drizzle-orm";
import { onbSettings, organizationMembershipsTable, DEMO_ORGANIZATION_ID, humanPermissionDecisions } from "@workspace/db";
import { resolveEffectiveAccessInTransaction, type AccessGovernanceKey } from "./access-governance";
import { demoPrincipalSettingKey, parseRegisteredDemoProfile } from "./demo-principal";
import type { OnboardingDbTransaction } from "./onboarding/settings";

export type HumanPermissionReceipt = {
  schema: "human-permission/v1";
  organizationId: string;
  caseId: number | null;
  actorUserId: string;
  requiredKeys: AccessGovernanceKey[];
  reviewedRevision: number;
  evidenceGeneration: number;
  decision: string;
  recordedAt: string;
  /** Route administration additionally requires current owner/admin status. */
  ownerAdminRequired: boolean;
};

export async function isSharedDemoPrincipalInTransaction(tx: OnboardingDbTransaction, actorUserId: string): Promise<boolean> {
  const [demo] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, demoPrincipalSettingKey(actorUserId)),
  )).limit(1);
  return Boolean(parseRegisteredDemoProfile(demo?.value));
}

/** Named membership and exact effective permissions, never professional qualifications. */
export async function hasHumanPermissions(tx: OnboardingDbTransaction, input: {
  organizationId: string; actorUserId: string; caseId?: number;
  requiredKeys: readonly AccessGovernanceKey[]; ownerAdminRequired?: boolean;
}): Promise<boolean> {
  if (!input.actorUserId || !input.requiredKeys.length) return false;
  if (await isSharedDemoPrincipalInTransaction(tx, input.actorUserId)) return false;
  const [member] = await tx.select({ role: organizationMembershipsTable.role }).from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, input.organizationId),
    eq(organizationMembershipsTable.clerkUserId, input.actorUserId),
    isNull(organizationMembershipsTable.revokedAt),
  )).limit(1);
  if (!member || (input.ownerAdminRequired && !["owner", "admin"].includes(member.role))) return false;
  const effective = await resolveEffectiveAccessInTransaction(tx, {
    organizationId: input.organizationId, principalType: "human", principalId: input.actorUserId,
    caseId: input.caseId, purpose: "named-human-decision",
  });
  return input.requiredKeys.every(key => effective.allows.includes(key));
}

export async function permissionReceiptStillCurrent(
  tx: OnboardingDbTransaction,
  receipt: HumanPermissionReceipt | null | undefined,
  input: { organizationId: string; caseId?: number; requiredKeys: readonly AccessGovernanceKey[];
    reviewedRevision?: number; evidenceGeneration?: number; ownerAdminRequired?: boolean },
): Promise<boolean> {
  if (!receipt || receipt.schema !== "human-permission/v1" ||
    receipt.organizationId !== input.organizationId || receipt.caseId !== (input.caseId ?? null) ||
    !Array.isArray(receipt.requiredKeys) ||
    input.requiredKeys.some(key => !receipt.requiredKeys.includes(key)) ||
    (input.ownerAdminRequired && !receipt.ownerAdminRequired) ||
    (input.reviewedRevision !== undefined && receipt.reviewedRevision !== input.reviewedRevision) ||
    (input.evidenceGeneration !== undefined && receipt.evidenceGeneration !== input.evidenceGeneration)) return false;
  if (typeof receipt.actorUserId !== "string" || !receipt.actorUserId.trim() ||
      !receipt.requiredKeys.length || !receipt.requiredKeys.every(key => typeof key === "string") ||
      !Number.isSafeInteger(receipt.reviewedRevision) || receipt.reviewedRevision < 0 ||
      !Number.isSafeInteger(receipt.evidenceGeneration) || receipt.evidenceGeneration < 0 ||
      typeof receipt.decision !== "string" || !receipt.decision ||
      typeof receipt.recordedAt !== "string" || !Number.isFinite(Date.parse(receipt.recordedAt)) ||
      typeof receipt.ownerAdminRequired !== "boolean") return false;
  return hasHumanPermissions(tx, {
    organizationId: input.organizationId, actorUserId: receipt.actorUserId, caseId: input.caseId,
    requiredKeys: [...new Set([...receipt.requiredKeys, ...input.requiredKeys])],
    ownerAdminRequired: receipt.ownerAdminRequired || input.ownerAdminRequired,
  });
}

/** Negative IDs in retained compatibility columns distinguish permission receipts
 * from every positive historical specialist assignment. No legacy row is reused. */
export async function recordHumanPermissionDecision(tx: OnboardingDbTransaction, input: {
  organizationId: string; actorUserId: string; caseId?: number; requiredKeys: readonly AccessGovernanceKey[];
  reviewedRevision: number; evidenceGeneration?: number; decision: string;
}) {
  if (!await hasHumanPermissions(tx, input)) throw new Error("CURRENT_HUMAN_PERMISSIONS_REQUIRED");
  const authorization: HumanPermissionReceipt = {
    schema: "human-permission/v1", organizationId: input.organizationId, actorUserId: input.actorUserId,
    caseId: input.caseId ?? null, requiredKeys: [...input.requiredKeys], reviewedRevision: input.reviewedRevision,
    evidenceGeneration: input.evidenceGeneration ?? input.reviewedRevision, decision: input.decision,
    recordedAt: new Date().toISOString(), ownerAdminRequired: false,
  };
  const [record] = await tx.insert(humanPermissionDecisions).values({
    organizationId: input.organizationId, actorUserId: input.actorUserId,
    reviewedRevision: input.reviewedRevision, authorization,
  }).returning({ id: humanPermissionDecisions.id });
  if (!record) throw new Error("Human permission decision was not persisted.");
  return { id: -record.id, authorization };
}

export async function recordedHumanPermissionDecisionCurrent(tx: OnboardingDbTransaction, organizationId: string,
  compatibilityId: number | null, requiredKeys: readonly AccessGovernanceKey[], reviewedRevision?: number, caseId?: number, actorUserId?: string): Promise<boolean> {
  if (!compatibilityId || !Number.isSafeInteger(compatibilityId) || compatibilityId >= 0) return false;
  const [record] = await tx.select().from(humanPermissionDecisions).where(and(
    eq(humanPermissionDecisions.organizationId, organizationId), eq(humanPermissionDecisions.id, -compatibilityId),
  )).limit(1);
  return !!record && (!actorUserId || record.actorUserId === actorUserId) &&
    record.authorization.actorUserId === record.actorUserId &&
    permissionReceiptStillCurrent(tx, record.authorization as HumanPermissionReceipt, {
    organizationId, requiredKeys, reviewedRevision, caseId,
  });
}
