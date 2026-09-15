import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbAuthorityAssignments,
  onbCases,
  onbSettings,
  organizationMembershipsTable,
  type OnbAuthorityRole,
} from "@workspace/db/schema";
import {
  demoPrincipalSettingKey,
  parseRegisteredDemoProfile,
} from "../demo-principal";
import type { OnboardingDbTransaction } from "./settings";
import { AUTHORITY_ROLES, ROLE_SCOPE_MATRIX } from "./decision-authority";
import { seedDemoFullCoverage } from "./demo-full-coverage";
import {
  isSyntheticOfflineCase,
  SYNTHETIC_DEMO_AUTHORITY_SOURCE,
} from "./synthetic-offline";

export function syntheticDemoAuthorityRows(
  userId: string,
  cases: Array<{ id: number; notes: string | null; scenarioKey: string | null }>,
) {
  return cases
    .filter(isSyntheticOfflineCase)
    .flatMap((caseRow) =>
      AUTHORITY_ROLES.map((authorityRole: OnbAuthorityRole) => ({
        id: `synthetic-demo:${userId}:${caseRow.id}:${authorityRole}`,
        organizationId: DEMO_ORGANIZATION_ID,
        personUserId: userId,
        emailResponderAuthorized: false,
        authorityRole,
        scopes: [...ROLE_SCOPE_MATRIX[authorityRole]],
        caseId: caseRow.id,
        status: "active",
        grantorUserId: userId,
        source: SYNTHETIC_DEMO_AUTHORITY_SOURCE,
        governanceDecisionRef: `synthetic-demo-only:${caseRow.id}`,
      })),
    );
}

/**
 * Transaction-only grant for a just-created offline demo case. Rechecking the
 * registered profile and active membership in the same transaction as the
 * case insert prevents a stale request from obtaining authority after either
 * control has been withdrawn.
 */
export class SyntheticDemoCaseAuthorityDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyntheticDemoCaseAuthorityDeniedError";
  }
}

export async function grantSyntheticDemoAuthorityForCase(
  tx: OnboardingDbTransaction,
  userId: string,
  caseRow: { id: number; organizationId: string; notes: string | null; scenarioKey: string | null },
): Promise<void> {
  if (caseRow.organizationId !== DEMO_ORGANIZATION_ID || !isSyntheticOfflineCase(caseRow)) {
    throw new SyntheticDemoCaseAuthorityDeniedError(
      "Synthetic Demo authority can be granted only for a server-marked Demo Organization case.",
    );
  }

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${DEMO_ORGANIZATION_ID}))`);
  const [[membership], [profile]] = await Promise.all([
    tx.select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, userId),
        isNull(organizationMembershipsTable.revokedAt),
      ))
      .limit(1),
    tx.select({ value: onbSettings.value })
      .from(onbSettings)
      .where(and(
        eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbSettings.key, demoPrincipalSettingKey(userId)),
      ))
      .limit(1),
  ]);
  if (!membership || parseRegisteredDemoProfile(profile?.value) !== "administrator") {
    throw new SyntheticDemoCaseAuthorityDeniedError(
      "A current registered Demo Administrator profile and Demo Organization membership are required.",
    );
  }

  const grants = syntheticDemoAuthorityRows(userId, [caseRow]);
  if (!grants.length) {
    throw new SyntheticDemoCaseAuthorityDeniedError(
      "The new case is not eligible for synthetic Demo authority.",
    );
  }
  await tx.insert(onbAuthorityAssignments).values(grants).onConflictDoNothing({
    target: onbAuthorityAssignments.id,
  });
}

/**
 * Gives the dedicated demo administrator complete case-scoped authority over
 * server-marked synthetic cases. It never promotes the account's tenant role,
 * grants organization-wide authority, or touches non-synthetic cases.
 */
export async function ensureSyntheticDemoAdminAccess(userId: string): Promise<void> {
  const existing = await db
    .select({
      id: organizationMembershipsTable.id,
      revokedAt: organizationMembershipsTable.revokedAt,
    })
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
      eq(organizationMembershipsTable.clerkUserId, userId),
    ))
    .limit(1);
  if (existing[0]?.revokedAt) {
    throw new Error("The synthetic demo administrator membership has been revoked.");
  }

  await db
    .insert(organizationMembershipsTable)
    .values({
      organizationId: DEMO_ORGANIZATION_ID,
      clerkUserId: userId,
      role: "member",
    })
    .onConflictDoNothing({
      target: [
        organizationMembershipsTable.organizationId,
        organizationMembershipsTable.clerkUserId,
      ],
    });

  await seedDemoFullCoverage(DEMO_ORGANIZATION_ID, userId);

  const cases = await db
    .select({
      id: onbCases.id,
      notes: onbCases.notes,
      scenarioKey: onbCases.scenarioKey,
    })
    .from(onbCases)
    .where(eq(onbCases.organizationId, DEMO_ORGANIZATION_ID));
  const grants = syntheticDemoAuthorityRows(userId, cases);
  if (grants.length === 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${DEMO_ORGANIZATION_ID}))`);
    const [membership] = await tx
      .select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, userId),
        isNull(organizationMembershipsTable.revokedAt),
      ))
      .limit(1);
    if (!membership) {
      throw new Error("A current Demo Organization membership is required.");
    }
    await tx.insert(onbAuthorityAssignments).values(grants).onConflictDoNothing({
      target: onbAuthorityAssignments.id,
    });
  });
}