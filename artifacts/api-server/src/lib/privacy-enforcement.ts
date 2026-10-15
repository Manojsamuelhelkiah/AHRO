import { and, eq, isNull } from "drizzle-orm";
import { db, onbSettings, organizationMembershipsTable } from "@workspace/db";
import { hasHumanPermissions } from "./human-permissions";
import { isPlatformSuperAdmin } from "./private-platform-admin";

export const PRIVACY_ENFORCEMENT_KEY = "privacy-enforcement";
export type PrivacyEnforcementMode = "deferred" | "active";
export class PrivacyEnforcementError extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
}

/** Same product default in development and production. Tests explicitly opt
 * into Active so existing privacy-boundary suites retain their coverage. */
export function defaultPrivacyEnforcementMode(environment: Record<string, string | undefined> = process.env): PrivacyEnforcementMode {
  const configured = environment.HRO_PRIVACY_ENFORCEMENT_DEFAULT;
  if (configured && configured !== "active" && configured !== "deferred") {
    throw new Error("Privacy enforcement default is invalid.");
  }
  return configured === "active" ? "active" : "deferred";
}
export async function privacyEnforcementInTransaction(tx: any, organizationId: string) {
  const [row] = await tx.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, PRIVACY_ENFORCEMENT_KEY),
  ));
  if (!row) return { revision: 1, mode: defaultPrivacyEnforcementMode() };
  let value: Record<string, unknown>;
  try { value = JSON.parse(row.value); }
  catch { throw new PrivacyEnforcementError("Privacy configuration is invalid; repair it in Client Setup.", 503); }
  if (!value || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      (value.mode !== "active" && value.mode !== "deferred")) {
    throw new PrivacyEnforcementError("Privacy configuration is invalid; repair it in Client Setup.", 503);
  }
  return { revision: Number(value.revision), mode: value.mode as PrivacyEnforcementMode };
}
export async function privacyRequirementsDeferredInTransaction(tx: any, organizationId: string) {
  return (await privacyEnforcementInTransaction(tx, organizationId)).mode === "deferred";
}
export async function privacyRequirementsDeferred(organizationId: string) {
  return privacyRequirementsDeferredInTransaction(db, organizationId);
}
async function scope(tx: any, organizationId: string, userId: string) {
  const [member] = await tx.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, userId),
    isNull(organizationMembershipsTable.revokedAt),
  )).for("update");
  const platform = isPlatformSuperAdmin(userId, organizationId);
  if (!member && !platform) throw new PrivacyEnforcementError("Active client membership is required.", 403);
  return platform || ((member?.role === "owner" || member?.role === "admin") &&
    await hasHumanPermissions(tx, { organizationId, actorUserId: userId, requiredKeys: ["tool.policy.manage"] }));
}
export async function getPrivacyEnforcement(organizationId: string, userId: string) {
  return db.transaction(async tx => {
    const canManage = await scope(tx, organizationId, userId);
    return { ...await privacyEnforcementInTransaction(tx, organizationId), canManage };
  });
}
export async function savePrivacyEnforcement(organizationId: string, userId: string, input: unknown) {
  const value = input as Record<string, unknown> | null;
  if (!value || !Number.isSafeInteger(value.expectedRevision) ||
      (value.mode !== "active" && value.mode !== "deferred")) {
    throw new PrivacyEnforcementError("Provide the current revision and Deferred or Active mode.", 400);
  }
  const { withSensitiveLifecycleFence } = await import("./onboarding/sensitive-lifecycle");
  const { appendProtectedAuditInTransaction } = await import("./onboarding/protected-audit");
  return withSensitiveLifecycleFence(organizationId, () => db.transaction(async tx => {
    if (!await scope(tx, organizationId, userId)) throw new PrivacyEnforcementError("A client administrator with policy-management permission must change enforcement.", 403);
    const current = await privacyEnforcementInTransaction(tx, organizationId);
    if (value.expectedRevision !== current.revision) throw new PrivacyEnforcementError("Privacy settings changed. Reload before saving.", 409);
    const result = { revision: current.revision + 1, mode: value.mode as PrivacyEnforcementMode, canManage: true };
    await tx.insert(onbSettings).values({ organizationId, key: PRIVACY_ENFORCEMENT_KEY,
      value: JSON.stringify({ revision: result.revision, mode: result.mode }), updatedAt: new Date(),
    }).onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify({ revision: result.revision, mode: result.mode }), updatedAt: new Date() } });
    await appendProtectedAuditInTransaction(tx, { organizationId, actorId: userId, actorKind: "authenticated",
      actorAuthority: "client-policy-management", action: "privacy.enforcement.changed", outcome: "success",
      objectType: "privacy-enforcement", objectId: organizationId, reviewedRevision: result.revision,
      correlationId: `privacy-enforcement:${organizationId}:${result.revision}`, source: "client-setup",
      payload: { previousMode: current.mode, mode: result.mode } });
    return result;
  }));
}
