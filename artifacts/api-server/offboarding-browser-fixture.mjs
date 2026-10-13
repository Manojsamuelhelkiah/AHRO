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
  await p.db.insert(p.organizationsTable).values({ id: org, name: "Provider-denied Separation Test", slug: org, joinCodeHash: `${suffix}:unused`, createdByUserId: actor });
  for (const person of [actor, legal, viewer]) {
    await p.db.insert(p.organizationMembershipsTable).values({ organizationId: org, clerkUserId: person, role: person === actor ? "admin" : "member" });
    for (const key of ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit", ...(person === viewer ? [] : ["tool.approval.decide", "tool.policy.manage", "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"])])
      await p.db.insert(p.accessNamedGrants).values({ organizationId: org, principalType: "human", principalId: person, scope: "tenant", resourceType: key.startsWith("flow.") ? "flow" : key.startsWith("tool.") ? "tool" : "field", resourceKey: key, effect: "allow", status: "active", source: "named", createdByUserId: "fixture-grantor", approvedByUserId: "fixture-independent-approver", approvedAt: new Date() });
  }
  const { seedApprovedSensitiveLifecyclePolicies } = await import("./src/test-utils/sensitive-lifecycle-fixtures.ts");
  await seedApprovedSensitiveLifecyclePolicies(org, { permittedProviders: [] });
  return { org, actor, legal, viewer };
}
