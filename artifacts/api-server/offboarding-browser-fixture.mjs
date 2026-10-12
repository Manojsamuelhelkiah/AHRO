/**
 * Disposable browser fixture only. The caller has already created an isolated
 * migrated schema and wraps every real API request in the provider-deny fence.
 * No Clerk identities, real tenants, mail or remote effects are created here.
 */
export async function seedOffboardingBrowserFixture(p, suffix) {
  if (process.env.ONBOARDING_E2E_TEST !== "true") throw new Error("Offboarding fixture is test-only");
  const org = `offboarding-browser-${suffix}`;
  const actor = "browser-e2e-offboarding-operator";
  const legal = "browser-e2e-offboarding-legal";
  const viewer = "browser-e2e-offboarding-viewer";
  const roles = [
    ["hr-compliance", "hr-compliance-approve"], ["hrbp", "hrbp-approve"],
    ["hr-ethics", "hr-ethics-approve"], ["legal", "legal-approve"],
    ["payroll", "payroll-approve"], ["finance", "finance-approve"],
    ["occupational-health", "occupational-health-approve"],
    ["it-security", "it-security-approve"], ["manager", "manager-approve"],
    ["delivery-head", "delivery-head-approve"],
  ];
  await p.db.insert(p.organizationsTable).values({ id: org, name: "Provider-denied Separation Test", slug: org, joinCodeHash: `${suffix}:unused`, createdByUserId: actor });
  await p.db.insert(p.onbAuthorityGovernance).values({ organizationId: org, status: "governance-approved", revision: 1, approvedByUserId: "fixture-independent-governance", approvedAt: new Date(), governanceSource: "isolated-provider-denied-test" });
  for (const person of [actor, legal, viewer]) {
    await p.db.insert(p.organizationMembershipsTable).values({ organizationId: org, clerkUserId: person, role: "member" });
    for (const key of ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit", ...(person === viewer ? [] : ["data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"])])
      await p.db.insert(p.accessNamedGrants).values({ organizationId: org, principalType: "human", principalId: person, scope: "tenant", resourceType: key.startsWith("flow.") ? "flow" : "field", resourceKey: key, effect: "allow", status: "active", source: "named", createdByUserId: "fixture-grantor", approvedByUserId: "fixture-independent-approver", approvedAt: new Date() });
  }
  for (const [role, scope] of roles)
    await p.db.insert(p.onbAuthorityAssignments).values({ id: `${org}:${role}`, organizationId: org, personUserId: actor, authorityRole: role, scopes: [scope], validFrom: new Date(Date.now() - 60000), grantorUserId: "fixture-independent-governance", source: "isolated-provider-denied-test", governanceDecisionRef: "isolated-fixture-only" });
  await p.db.insert(p.onbAuthorityAssignments).values({ id: `${org}:independent-legal`, organizationId: org, personUserId: legal, authorityRole: "legal", scopes: ["legal-approve"], validFrom: new Date(Date.now() - 60000), grantorUserId: "fixture-independent-governance", source: "isolated-provider-denied-test", governanceDecisionRef: "isolated-fixture-only" });
  const { seedApprovedSensitiveLifecyclePolicies } = await import("./src/test-utils/sensitive-lifecycle-fixtures.ts");
  await seedApprovedSensitiveLifecyclePolicies(org, { permittedProviders: [] });
  return { org, actor, legal, viewer };
}
