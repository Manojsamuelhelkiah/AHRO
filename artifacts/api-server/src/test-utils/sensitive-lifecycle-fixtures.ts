import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  onbSensitiveLifecyclePolicies,
} from "@workspace/db";
import { SENSITIVE_DATA_CLASSES } from "../lib/onboarding/sensitive-lifecycle";

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

  await Promise.all(SENSITIVE_DATA_CLASSES.map(async (dataClass) => {
    const policyReference = `${TEST_POLICY_REFERENCE_PREFIX}${dataClass}:v1`;
    const approvalReference = `${TEST_APPROVAL_REFERENCE_PREFIX}${dataClass}:v1`;
    await db.insert(onbSensitiveLifecyclePolicies).values({
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
      approvedByUserId: "test-sensitive-lifecycle-specialist",
      approvedAuthorityAssignmentId: 1,
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
        approvedByUserId: "test-sensitive-lifecycle-specialist",
        approvedAuthorityAssignmentId: 1,
        isCurrent: true,
        supersededAt: null,
      },
    });
  }));
}