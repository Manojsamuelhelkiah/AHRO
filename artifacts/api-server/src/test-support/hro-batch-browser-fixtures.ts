import { randomBytes, randomUUID } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import {
  accessNamedGrants,
  db,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCaseLogistics,
  onbCases,
  onbConnectors,
  onbEffectJournal,
  onbEvents,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisionReviews,
  onbGovernanceDecisions,
  onbGovernanceDispatchMarkers,
  onbGovernanceHistory,
  onbGovernanceReminders,
  onbGovernanceRequirements,
  onbIntakeBatchPeople,
  onbIntakeBatches,
  onbReadinessSlaCaseState,
  onbReadinessSlaLedger,
  onbReadinessSlaOutbox,
  onbReadinessSlaPolicies,
  onbReadinessSlaSnapshots,
  onbSensitiveLifecycleConfirmations,
  onbSensitiveLifecycleDeletionJobs,
  onbSensitiveLifecycleHolds,
  onbSensitiveLifecyclePolicies,
  onbSensitiveObjectDerivatives,
  onbSensitiveObjectManifests,
  onbSettings,
  organizationsTable,
  organizationMembershipsTable,
} from "@workspace/db";
import { governanceSnapshotForNewCase } from "../lib/onboarding/governance-runtime";
import { seedApprovedSensitiveLifecyclePolicies } from "../test-utils/sensitive-lifecycle-fixtures";
import { deleteTestOrganizations } from "./organization-fixtures";

const PREFIX = "hro-batch-browser-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeClerkFailure(error: unknown, operation: string): Error {
  const e = error as { status?: unknown; errors?: Array<{ code?: unknown }> };
  const status = typeof e?.status === "number" ? ` HTTP ${e.status}` : "";
  const codes = Array.isArray(e?.errors)
    ? e.errors.map((entry) => entry.code).filter((code): code is string => typeof code === "string").join(",")
    : "";
  return new Error(`Clerk ${operation} failed${status}${codes ? ` (${codes})` : ""}.`);
}

/** Create one unprofiled, non-demo development identity. Never returns a password. */
export async function createHroBatchBrowserClerkUser() {
  const fixtureId = randomUUID();
  const shortId = fixtureId.replaceAll("-", "").slice(0, 12);
  const email = `hro-batch-${shortId}+clerk_test@example.com`;
  try {
    const user = await clerkClient.users.createUser({
      emailAddress: [email],
      emailAddressIdentificationStatus: ["reserved"],
      skipPasswordRequirement: true,
      firstName: "Fictional",
      lastName: "Batch Tester",
      privateMetadata: { hroBatchBrowserFixtureId: fixtureId },
    });
    return { fixtureId, actorUserId: user.id, email };
  } catch (error) {
    throw safeClerkFailure(error, "users.createUser");
  }
}

/** Mint only immediately before browser sign-in; callers must not log the ticket. */
export async function mintHroBatchBrowserTicket(actorUserId: string): Promise<string> {
  try {
    const ticket = await clerkClient.signInTokens.createSignInToken({
      userId: actorUserId,
      expiresInSeconds: 120,
    });
    return ticket.token;
  } catch (error) {
    throw safeClerkFailure(error, "signInTokens.createSignInToken");
  }
}

export async function createHroBatchBrowserTenant(fixtureId: string, actorUserId: string) {
  if (!UUID.test(fixtureId) || !actorUserId.startsWith("user_")) {
    throw new Error("A UUID fixture ID and Clerk user ID are required.");
  }
  const organizationId = `${PREFIX}${fixtureId}`;
  const fixtureVerifier = `test-only-verifier:${fixtureId}`;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(organizationsTable).values({
      id: organizationId,
      name: `HRO Batch Browser Test ${fixtureId}`,
      slug: organizationId,
      primaryCountry: "US",
      joinCodeHash: randomBytes(32).toString("hex"),
      createdByUserId: actorUserId,
    });
    await tx.insert(organizationMembershipsTable).values({
      organizationId, clerkUserId: actorUserId, role: "owner",
    });
    const standardGrants = [
      ["flow", "flow.case.read"], ["flow", "flow.case.edit"],
      ["field", "data.case.profile.read"], ["field", "data.case.profile.edit"],
      ["field", "data.case.notes.read"], ["field", "data.case.notes.edit"],
      ["field", "data.case.readiness.read"],
    ] as const;
    await tx.insert(accessNamedGrants).values(standardGrants.map(([resourceType, resourceKey]) => ({
      organizationId, principalType: "human" as const, principalId: actorUserId,
      scope: "tenant" as const, caseId: null, resourceType, resourceKey,
      source: "named" as const, effect: "allow" as const, status: "active" as const,
      requiresApproval: "no" as const, createdByUserId: actorUserId,
    })));
    const sensitiveReadGrants = [
      "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read",
    ];
    await tx.insert(accessNamedGrants).values(sensitiveReadGrants.map((resourceKey) => ({
      organizationId, principalType: "human" as const, principalId: actorUserId,
      scope: "tenant" as const, caseId: null, resourceType: "field" as const, resourceKey,
      source: "named" as const, effect: "allow" as const, status: "active" as const,
      requiresApproval: "yes" as const, createdByUserId: actorUserId,
      approvedByUserId: fixtureVerifier, approvedAt: now,
    })));
    await tx.insert(onbAuthorityGovernance).values({
      organizationId, status: "governance-approved",
      approvedByUserId: fixtureVerifier, approvedAt: now,
      governanceSource: `test-only:${fixtureId}`,
    });
    await tx.insert(onbGovernanceAuthorityAssignments).values({
      organizationId, authorityRole: "privacy", assigneeUserId: actorUserId,
      verificationStatus: "verified", verifiedByUserId: fixtureVerifier,
      verificationReference: `test-only-verified-privacy:${fixtureId}`,
      expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    });
    const scopedAuthorities = [
      ["hr-compliance", "hr-compliance-approve"],
      ["legal", "legal-approve"],
      ["occupational-health", "occupational-health-approve"],
      ["payroll", "payroll-approve"],
      ["fraud-control", "fraud-control-approve"],
    ] as const;
    await tx.insert(onbAuthorityAssignments).values(scopedAuthorities.map(([authorityRole, scope]) => ({
      id: `test-only-${fixtureId}-${scope}`,
      organizationId, personUserId: actorUserId, personEmail: null,
      emailResponderAuthorized: false, authorityRole, scopes: [scope],
      caseId: null, siteScope: null, jurisdictionScope: null,
      validFrom: new Date(now.getTime() - 60_000),
      validUntil: new Date(now.getTime() + 2 * 60 * 60 * 1000),
      status: "active", revision: 1, grantorUserId: fixtureVerifier,
      source: `test-only:${fixtureId}`,
      governanceDecisionRef: `test-only-verified:${fixtureId}:${scope}`,
    })));
  });
  try {
    // Explicit test policy fixture; default options keep external sharing off.
    await seedApprovedSensitiveLifecyclePolicies(organizationId);
    await governanceSnapshotForNewCase(organizationId);
  } catch (error) {
    await cleanupHroBatchBrowserTenant(organizationId);
    throw error;
  }
  return { organizationId };
}

/** Exact-ID, hold-aware teardown. An active hold aborts cleanup; it is never erased. */
export async function cleanupHroBatchBrowserTenant(organizationId: string): Promise<void> {
  const fixtureId = organizationId.startsWith(PREFIX) ? organizationId.slice(PREFIX.length) : "";
  if (!UUID.test(fixtureId)) throw new Error("Refusing cleanup outside this UUID-prefixed test fixture.");
  const activeHolds = await db.select({ id: onbSensitiveLifecycleHolds.id })
    .from(onbSensitiveLifecycleHolds).where(and(
      eq(onbSensitiveLifecycleHolds.organizationId, organizationId),
      eq(onbSensitiveLifecycleHolds.active, true),
    ));
  if (activeHolds.length) throw new Error("Refusing to clean up a test tenant with active sensitive-lifecycle holds.");
  await deleteTestOrganizations(eq(organizationsTable.id, organizationId), async (tx, ids) => {
    if (ids.length !== 1 || ids[0] !== organizationId) {
      throw new Error("Test cleanup scope did not resolve to the exact fixture tenant.");
    }
    await tx.delete(onbSensitiveLifecycleHolds).where(eq(onbSensitiveLifecycleHolds.organizationId, organizationId));
    await tx.delete(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.organizationId, organizationId));
    await tx.delete(onbSensitiveLifecycleConfirmations).where(eq(onbSensitiveLifecycleConfirmations.organizationId, organizationId));
    await tx.delete(onbSensitiveObjectDerivatives).where(eq(onbSensitiveObjectDerivatives.organizationId, organizationId));
    await tx.delete(onbSensitiveObjectManifests).where(eq(onbSensitiveObjectManifests.organizationId, organizationId));
    await tx.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
    await tx.delete(onbReadinessSlaOutbox).where(eq(onbReadinessSlaOutbox.organizationId, organizationId));
    await tx.delete(onbReadinessSlaLedger).where(eq(onbReadinessSlaLedger.organizationId, organizationId));
    await tx.delete(onbReadinessSlaCaseState).where(eq(onbReadinessSlaCaseState.organizationId, organizationId));
    await tx.delete(onbReadinessSlaSnapshots).where(eq(onbReadinessSlaSnapshots.organizationId, organizationId));
    await tx.delete(onbCaseLogistics).where(eq(onbCaseLogistics.organizationId, organizationId));
    await tx.delete(onbEvents).where(eq(onbEvents.organizationId, organizationId));
    await tx.delete(onbIntakeBatchPeople).where(eq(onbIntakeBatchPeople.organizationId, organizationId));
    await tx.delete(onbIntakeBatches).where(eq(onbIntakeBatches.organizationId, organizationId));
    await tx.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, organizationId));
    await tx.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
    await tx.delete(onbGovernanceDecisionReviews).where(eq(onbGovernanceDecisionReviews.organizationId, organizationId));
    await tx.delete(onbGovernanceReminders).where(eq(onbGovernanceReminders.organizationId, organizationId));
    await tx.delete(onbGovernanceHistory).where(eq(onbGovernanceHistory.organizationId, organizationId));
    await tx.delete(onbGovernanceDispatchMarkers).where(eq(onbGovernanceDispatchMarkers.organizationId, organizationId));
    await tx.delete(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, organizationId));
    await tx.delete(onbGovernanceDecisions).where(eq(onbGovernanceDecisions.organizationId, organizationId));
    await tx.delete(onbGovernanceAuthorityAssignments).where(eq(onbGovernanceAuthorityAssignments.organizationId, organizationId));
    await tx.delete(onbReadinessSlaPolicies).where(eq(onbReadinessSlaPolicies.organizationId, organizationId));
    await tx.delete(onbConnectors).where(eq(onbConnectors.organizationId, organizationId));
    await tx.delete(accessNamedGrants).where(eq(accessNamedGrants.organizationId, organizationId));
    await tx.delete(onbAuthorityAssignments).where(eq(onbAuthorityAssignments.organizationId, organizationId));
    await tx.delete(onbAuthorityGovernance).where(eq(onbAuthorityGovernance.organizationId, organizationId));
    await tx.delete(onbSettings).where(eq(onbSettings.organizationId, organizationId));
  });
}

export async function deleteHroBatchBrowserClerkUser(actorUserId: string, fixtureId: string): Promise<void> {
  if (!UUID.test(fixtureId) || !actorUserId.startsWith("user_")) {
    throw new Error("Refusing to delete an unscoped Clerk test user.");
  }
  const user = await clerkClient.users.getUser(actorUserId);
  const shortId = fixtureId.replaceAll("-", "").slice(0, 12);
  if (user.privateMetadata.hroBatchBrowserFixtureId !== fixtureId ||
      !user.emailAddresses.some((address) => address.emailAddress === `hro-batch-${shortId}+clerk_test@example.com`)) {
    throw new Error("Clerk user does not match this exact synthetic fixture.");
  }
  try {
    await clerkClient.users.deleteUser(actorUserId);
  } catch (error) {
    throw safeClerkFailure(error, "users.deleteUser");
  }
}
