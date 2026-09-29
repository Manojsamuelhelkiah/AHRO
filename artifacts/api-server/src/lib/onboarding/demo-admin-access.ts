import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  accessNamedGrants,
  onbAuthorityAssignments,
  onbCases,
  onbSettings,
  organizationMembershipsTable,
  type OnbSyntheticProvenance,
} from "@workspace/db/schema";
import {
  demoPrincipalSettingKey,
  parseRegisteredDemoProfile,
} from "../demo-principal";
import type { OnboardingDbTransaction } from "./settings";
import { seedDemoFullCoverage } from "./demo-full-coverage";
import {
  getSensitiveLifecycleAuthorityContextInTransaction,
} from "./governance";
import {
  evaluateCaseDerivedLifecycleGateInTransaction,
  jurisdictionForWorkforceContext,
} from "./sensitive-lifecycle";
import {
  isUatRunIsolatedCase,
  SYNTHETIC_OFFLINE_MARKER,
  SYNTHETIC_DEMO_AUTHORITY_SOURCE,
} from "./synthetic-offline";

const DEMO_CASE_READ_KEYS = [
  "data.case.profile.read",
  "data.case.notes.read",
  "data.case.readiness.read",
  "data.documents.read",
  "flow.case.read",
] as const;

type DemoAdminCase = {
  id: number;
  notes: string | null;
  scenarioKey: string | null;
  syntheticProvenance?: OnbSyntheticProvenance | null;
  candidateEmailAuthorizedAt?: Date | null;
  candidateEmailAuthorizedBy?: string | null;
  workforceContext?: unknown;
};

const DEMO_SYNTHETIC_PROVENANCE = new Set<OnbSyntheticProvenance>([
  "onboarding-demo-fictional",
  "synthetic-reset",
  "demo-full-coverage",
  "demo-controller-fictional",
]);

export function isExplicitSyntheticDemoCase(
  caseRow: Pick<DemoAdminCase, "notes" | "scenarioKey"> &
    Partial<Pick<DemoAdminCase, "syntheticProvenance">>,
): boolean {
  return caseRow.syntheticProvenance != null &&
    DEMO_SYNTHETIC_PROVENANCE.has(caseRow.syntheticProvenance) &&
    caseRow.notes?.includes(SYNTHETIC_OFFLINE_MARKER) === true &&
    !isUatRunIsolatedCase(caseRow);
}

export function isVerifiedHybridDemoControllerCase(
  caseRow: Pick<
    DemoAdminCase,
    "notes" | "candidateEmailAuthorizedAt" | "candidateEmailAuthorizedBy"
  > &
    Partial<Pick<DemoAdminCase, "scenarioKey">>,
): boolean {
  return caseRow.candidateEmailAuthorizedAt != null &&
    caseRow.candidateEmailAuthorizedBy === "demo-controller" &&
    /\[demo-controller-run:[^\]]+\]/.test(caseRow.notes ?? "") &&
    !isUatRunIsolatedCase(caseRow);
}

/**
 * Transaction-only read access for a just-created synthetic Demo case.
 * Volunteered hybrid cases must pass the current lifecycle gate; no synthetic
 * case receives specialist authority from this path.
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
  caseRow: DemoAdminCase & { organizationId: string },
): Promise<void> {
  const isVerifiedHybridControllerCase =
    isVerifiedHybridDemoControllerCase(caseRow);
  if (
    caseRow.organizationId !== DEMO_ORGANIZATION_ID ||
    isUatRunIsolatedCase(caseRow) ||
    (!isExplicitSyntheticDemoCase(caseRow) && !isVerifiedHybridControllerCase)
  ) {
    throw new SyntheticDemoCaseAuthorityDeniedError(
      "Demo authority requires explicit server-owned synthetic provenance or a verified volunteer-backed Demo Controller run.",
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

  if (caseRow.candidateEmailAuthorizedAt) {
    const jurisdiction = jurisdictionForWorkforceContext(caseRow.workforceContext);
    if (!isVerifiedHybridControllerCase || !jurisdiction) {
      throw new SyntheticDemoCaseAuthorityDeniedError(
        "Volunteered Demo cases require an explicit Demo Controller run and work-country policy.",
      );
    }
    const [lifecycle, authority] = await Promise.all([
      evaluateCaseDerivedLifecycleGateInTransaction(tx, {
        organizationId: caseRow.organizationId,
        jurisdiction,
      }),
      getSensitiveLifecycleAuthorityContextInTransaction(tx, caseRow.organizationId),
    ]);
    if (!lifecycle.allowed || authority.authorityStatus !== "verified") {
      throw new SyntheticDemoCaseAuthorityDeniedError(
        `SENSITIVE_LIFECYCLE_BLOCKED:${!lifecycle.allowed
          ? lifecycle.reason ?? "Current lifecycle policy does not allow this volunteered case."
          : "A current server-verified privacy or legal reviewer is required before this volunteer can be used."}`,
      );
    }
  }

  if (!caseRow.candidateEmailAuthorizedAt && !isExplicitSyntheticDemoCase(caseRow)) {
    throw new SyntheticDemoCaseAuthorityDeniedError(
      "The new case is not eligible for synthetic Demo authority.",
    );
  }
  await insertMissingCaseReadGrants(
    tx,
    userId,
    [caseRow],
    isVerifiedHybridControllerCase ? [caseRow.id] : [],
  );
}

async function insertMissingCaseReadGrants(
  tx: Pick<OnboardingDbTransaction, "select" | "insert">,
  userId: string,
  cases: DemoAdminCase[],
  verifiedHybridCaseIds: readonly number[] = [],
): Promise<void> {
  const hybridCaseIds = new Set(verifiedHybridCaseIds);
  const eligible = cases.filter((caseRow) =>
    isExplicitSyntheticDemoCase(caseRow) || hybridCaseIds.has(caseRow.id),
  );
  if (!eligible.length) return;
  const grants = eligible.flatMap((caseRow) =>
    DEMO_CASE_READ_KEYS.map((resourceKey) => ({
      organizationId: DEMO_ORGANIZATION_ID,
      principalType: "human" as const,
      principalId: userId,
      scope: "case" as const,
      caseId: caseRow.id,
      resourceType: resourceKey.startsWith("flow.") ? "flow" as const : "field" as const,
      resourceKey,
      source: "named" as const,
      effect: "allow" as const,
      createdByUserId: userId,
    })),
  );
  const existing = await tx.select({
    caseId: accessNamedGrants.caseId,
    resourceKey: accessNamedGrants.resourceKey,
  }).from(accessNamedGrants).where(and(
    eq(accessNamedGrants.organizationId, DEMO_ORGANIZATION_ID),
    eq(accessNamedGrants.principalType, "human"),
    eq(accessNamedGrants.principalId, userId),
    eq(accessNamedGrants.scope, "case"),
    inArray(accessNamedGrants.caseId, eligible.map((caseRow) => caseRow.id)),
    eq(accessNamedGrants.source, "named"),
  ));
  const existingKeys = new Set(existing.map((grant) => `${grant.caseId}:${grant.resourceKey}`));
  const missing = grants.filter((grant) => !existingKeys.has(`${grant.caseId}:${grant.resourceKey}`));
  if (missing.length) await tx.insert(accessNamedGrants).values(missing);
}

/**
 * Gives the dedicated Demo Administrator case-scoped read access to fictional
 * offline cases. No branch promotes a tenant role, grants organization-wide
 * access, or delegates specialist authority.
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
      syntheticProvenance: onbCases.syntheticProvenance,
      candidateEmailAuthorizedAt: onbCases.candidateEmailAuthorizedAt,
      candidateEmailAuthorizedBy: onbCases.candidateEmailAuthorizedBy,
    })
    .from(onbCases)
    .where(eq(onbCases.organizationId, DEMO_ORGANIZATION_ID));
  const fictionalOfflineCases = cases.filter((caseRow) =>
    !caseRow.candidateEmailAuthorizedAt &&
    !caseRow.candidateEmailAuthorizedBy &&
    isExplicitSyntheticDemoCase(caseRow),
  );
  const syntheticCaseIds = cases
    .filter((caseRow) =>
      isUatRunIsolatedCase(caseRow) || isExplicitSyntheticDemoCase(caseRow)
    )
    .map((caseRow) => caseRow.id);
  const legacyMarkerOnlyCaseIds = cases
    .filter((caseRow) =>
      !caseRow.syntheticProvenance &&
      !caseRow.candidateEmailAuthorizedAt &&
      caseRow.notes?.includes(SYNTHETIC_OFFLINE_MARKER) === true &&
      !isUatRunIsolatedCase(caseRow),
    )
    .map((caseRow) => caseRow.id);
  if (
    fictionalOfflineCases.length === 0 &&
    syntheticCaseIds.length === 0 &&
    legacyMarkerOnlyCaseIds.length === 0
  ) return;

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
    if (legacyMarkerOnlyCaseIds.length > 0) {
      // Remove grants issued by the legacy notes-only eligibility rule. This
      // is a revocation only: marker text is never used to grant provenance.
      await tx.delete(accessNamedGrants).where(and(
        eq(accessNamedGrants.organizationId, DEMO_ORGANIZATION_ID),
        eq(accessNamedGrants.scope, "case"),
        inArray(accessNamedGrants.caseId, legacyMarkerOnlyCaseIds),
        eq(accessNamedGrants.source, "named"),
        eq(accessNamedGrants.effect, "allow"),
        inArray(accessNamedGrants.resourceKey, [...DEMO_CASE_READ_KEYS]),
      ));
    }
    if (fictionalOfflineCases.length > 0) {
      await insertMissingCaseReadGrants(tx, userId, fictionalOfflineCases);
    }
    if (syntheticCaseIds.length > 0) {
      await tx.update(onbAuthorityAssignments).set({
        status: "revoked",
        revision: sql`${onbAuthorityAssignments.revision} + 1`,
        revokedByUserId: userId,
        revokedAt: new Date(),
        revokeReason: "Demo Admin case-scoped read access does not delegate specialist authority.",
        updatedAt: new Date(),
      }).where(and(
        eq(onbAuthorityAssignments.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbAuthorityAssignments.personUserId, userId),
        inArray(onbAuthorityAssignments.caseId, syntheticCaseIds),
        eq(onbAuthorityAssignments.source, SYNTHETIC_DEMO_AUTHORITY_SOURCE),
        eq(onbAuthorityAssignments.status, "active"),
      ));
    }
  });
}