import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbAuthorityAssignments,
  onbSettings,
  organizationMembershipsTable,
} from "@workspace/db/schema";
import { SYNTHETIC_DEMO_AUTHORITY_SOURCE } from "./onboarding/synthetic-offline";
import { isDevelopmentSuperAdmin } from "./development-super-admin";

export type RegisteredDemoProfile = "reviewer" | "administrator";
const DEMO_PRINCIPAL_PREFIX = "registered_demo_principal:";

export function demoPrincipalSettingKey(userId: string): string {
  return `${DEMO_PRINCIPAL_PREFIX}${userId}`;
}

export function parseRegisteredDemoProfile(value: string | undefined):
  RegisteredDemoProfile | null {
  return value === "reviewer" || value === "administrator" ? value : null;
}

export async function registerDemoPrincipal(
  userId: string,
  profile: RegisteredDemoProfile,
): Promise<void> {
  await db.insert(onbSettings).values({
    organizationId: DEMO_ORGANIZATION_ID,
    key: demoPrincipalSettingKey(userId),
    value: profile,
  }).onConflictDoUpdate({
    target: [onbSettings.organizationId, onbSettings.key],
    set: { value: profile, updatedAt: new Date() },
  });
}

export async function enforceDemoPrincipalMembershipCeiling(userId: string): Promise<void> {
  await db.update(organizationMembershipsTable).set({ role: "member" }).where(and(
    eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
    eq(organizationMembershipsTable.clerkUserId, userId),
    isNull(organizationMembershipsTable.revokedAt),
  ));
}

export async function quarantineLegacyDemoPrincipalAuthority(
  userId: string,
  profile: RegisteredDemoProfile,
): Promise<void> {
  const sourceFence = profile === "administrator"
    ? ne(onbAuthorityAssignments.source, SYNTHETIC_DEMO_AUTHORITY_SOURCE)
    : undefined;
  await db.update(onbAuthorityAssignments).set({
    status: "revoked",
    validUntil: new Date(),
    revision: sql`${onbAuthorityAssignments.revision} + 1`,
  }).where(and(
    eq(onbAuthorityAssignments.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbAuthorityAssignments.personUserId, userId),
    eq(onbAuthorityAssignments.status, "active"),
    sourceFence,
  ));
}

export async function registeredDemoProfile(
  userId: string,
): Promise<RegisteredDemoProfile | null> {
  // This is request/session scoped, never a permanent elevation of the
  // publicly usable account. Background and ordinary demo sessions stay capped.
  if (isDevelopmentSuperAdmin(userId)) return null;
  const [row] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, demoPrincipalSettingKey(userId)),
  )).limit(1);
  return parseRegisteredDemoProfile(row?.value);
}