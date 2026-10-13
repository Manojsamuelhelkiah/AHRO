import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  onbSensitiveLifecyclePolicies,
  organizationMembershipsTable,
  accessNamedGrants,
} from "@workspace/db";
import { SENSITIVE_DATA_CLASSES } from "../lib/onboarding/sensitive-lifecycle";
import { recordHumanPermissionDecision } from "../lib/human-permissions";

type SensitiveLifecycleFixtureOptions = {
  permittedProviders?: string[];
};

const TEST_POLICY_REFERENCE_PREFIX = "test-sensitive-lifecycle-policy:US:";
const TEST_APPROVAL_REFERENCE_PREFIX = "test-sensitive-lifecycle-approval:US:";

function isTestOwnedPolicy(policy: {
  policyReference: string;
  approvalReference: string;
}): boolean {
  return policy.policyReference.startsWith(TEST_POLICY_REFERENCE_PREFIX) &&
    policy.approvalReference.startsWith(TEST_APPROVAL_REFERENCE_PREFIX);
}

/**
 * Test-only explicit policy setup for positive lifecycle-gated fixtures.
 * Runtime code must continue to fail closed when no approved policy exists,
 * and this fixture must never mutate a reserved/shared tenant.
 */
export async function seedApprovedSensitiveLifecyclePolicies(
  organizationId: string,
  options: SensitiveLifecycleFixtureOptions = {},
): Promise<void> {
  if (organizationId === DEMO_ORGANIZATION_ID) {
    throw new Error("Sensitive lifecycle test fixtures require an isolated organization; the shared demo organization is reserved.");
  }
  const permittedProviders = options.permittedProviders ?? [];
  const providerSharingApproved = permittedProviders.length > 0;
  const existing = await db.select({
    dataClass: onbSensitiveLifecyclePolicies.dataClass,
    policyReference: onbSensitiveLifecyclePolicies.policyReference,
    approvalReference: onbSensitiveLifecyclePolicies.approvalReference,
  }).from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, "US"),
    inArray(onbSensitiveLifecyclePolicies.dataClass, [...SENSITIVE_DATA_CLASSES]),
  ));
  if (existing.some((policy) => !isTestOwnedPolicy(policy))) {
    throw new Error("Sensitive lifecycle test fixture refuses to overwrite a non-test policy.");
  }

  await db.transaction(async tx => {
    const reviewer = `test-permission-reviewer:${organizationId}`;
    await tx.insert(organizationMembershipsTable).values({
      organizationId, clerkUserId: reviewer, role: "member",
    }).onConflictDoNothing();
    const grants = await tx.select().from(accessNamedGrants).where(and(
      eq(accessNamedGrants.organizationId, organizationId), eq(accessNamedGrants.principalId, reviewer),
    ));
    if (!grants.length) await tx.insert(accessNamedGrants).values({
      organizationId, principalType: "human", principalId: reviewer, scope: "tenant",
      resourceType: "tool", resourceKey: "tool.policy.manage", source: "named", effect: "allow", status: "active",
      createdByUserId: "independent-test-access-owner", approvedByUserId: "independent-test-access-owner", approvedAt: new Date(),
    });
    for (const dataClass of SENSITIVE_DATA_CLASSES) {
    const decision = await recordHumanPermissionDecision(tx, {
      organizationId, actorUserId: reviewer, requiredKeys: ["tool.policy.manage"],
      reviewedRevision: 1, evidenceGeneration: 1, decision: "policy-approved",
    });
    const policyReference = `${TEST_POLICY_REFERENCE_PREFIX}${dataClass}:v1`;
    const approvalReference = `${TEST_APPROVAL_REFERENCE_PREFIX}${dataClass}:v1`;
    await tx.insert(onbSensitiveLifecyclePolicies).values({
      organizationId,
      dataClass,
      jurisdiction: "US",
      revision: 1,
      purpose: `Test-approved ${dataClass} onboarding lifecycle`,
      lawfulBasis: "Test-approved onboarding administration basis",
      retentionDays: 30,
      providerSharingApproved,
      permittedProviders,
      policyReference,
      approvalReference,
       approvedByUserId: reviewer,
       approvedAuthorityAssignmentId: decision.id,
      isCurrent: true,
      supersededAt: null,
    }).onConflictDoUpdate({
      target: [
        onbSensitiveLifecyclePolicies.organizationId,
        onbSensitiveLifecyclePolicies.dataClass,
        onbSensitiveLifecyclePolicies.jurisdiction,
        onbSensitiveLifecyclePolicies.revision,
      ],
      set: {
        purpose: `Test-approved ${dataClass} onboarding lifecycle`,
        lawfulBasis: "Test-approved onboarding administration basis",
        retentionDays: 30,
        providerSharingApproved,
        permittedProviders,
        policyReference,
        approvalReference,
         approvedByUserId: reviewer,
         approvedAuthorityAssignmentId: decision.id,
        isCurrent: true,
        supersededAt: null,
      },
    });
    }
  });
}