import { and, eq, sql } from "drizzle-orm";
import { db, onbSettings, organizationMembershipsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";
import { hasHumanPermissions } from "./human-permissions";
import { isPlatformSuperAdmin } from "./private-platform-admin";

export class PolicyUploadSettingsError extends Error {
  constructor(message: string, public statusCode: 400 | 403 | 409) { super(message); }
}

const KEY = "hr-policy-upload-approval";
export type PolicyUploadSettings = { revision: number; requiresSeparateReview: boolean };
export async function policyUploadSettingsInTransaction(tx: any, organizationId: string): Promise<PolicyUploadSettings> {
  const [row] = await tx.select().from(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, KEY)));
  if (!row) return { revision: 1, requiresSeparateReview: false };
  const value = JSON.parse(row.value) as Record<string, unknown>;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.requiresSeparateReview !== "boolean") {
    throw new Error("Policy upload approval configuration is invalid; repair it in Client Setup.");
  }
  return { revision: Number(value.revision), requiresSeparateReview: value.requiresSeparateReview };
}
async function authorize(tx: any, organizationId: string, userId: string) {
  if (!await hasHumanPermissions(tx, { organizationId, actorUserId: userId, requiredKeys: ["tool.policy.manage"] })) {
    throw new PolicyUploadSettingsError("Current policy-management permission is required.", 403);
  }
}
export async function getPolicyUploadSettings(organizationId: string, userId: string) {
  return db.transaction(async tx => { await authorize(tx, organizationId, userId); return policyUploadSettingsInTransaction(tx, organizationId); });
}
export async function savePolicyUploadSettings(organizationId: string, userId: string, input: unknown) {
  const b = input as Record<string, unknown> | null;
  if (!b || !Number.isSafeInteger(b.expectedRevision) || typeof b.requiresSeparateReview !== "boolean") {
    throw new PolicyUploadSettingsError("Provide the current revision and review preference.", 400);
  }
  return db.transaction(async tx => {
    await authorize(tx, organizationId, userId);
    const [membership] = await tx.select().from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId), eq(organizationMembershipsTable.clerkUserId, userId), isNull(organizationMembershipsTable.revokedAt),
    )).for("update");
    if (!isPlatformSuperAdmin(userId, organizationId) && membership?.role !== "owner" && membership?.role !== "admin") {
      throw new PolicyUploadSettingsError("A client administrator with policy-management permission must configure the review process.", 403);
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`policy-upload-settings:${organizationId}`}, 0))`);
    const current = await policyUploadSettingsInTransaction(tx, organizationId);
    if (b.expectedRevision !== current.revision) throw new PolicyUploadSettingsError("Policy upload settings changed; reload before saving.", 409);
    const result = { revision: current.revision + 1, requiresSeparateReview: b.requiresSeparateReview };
    const value = JSON.stringify({ ...result, changedByUserId: userId, changedAt: new Date().toISOString() });
    await tx.insert(onbSettings).values({ organizationId, key: KEY, value }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key], set: { value, updatedAt: new Date() },
    });
    return result;
  });
}
