import { and, eq, sql } from "drizzle-orm";

/** Only the isolated browser server imports this module. No provider enrollment,
 * directory verification, real recipient or external effect is created. */
export async function seedExchangeBrowserFixture(p, people) {
  if (process.env.ONBOARDING_E2E_TEST !== "true" || process.env.NODE_ENV !== "test") throw new Error("Isolated browser fixture only");
  const schema = (await p.db.execute(sql`SELECT current_schema() AS s`)).rows[0]?.s;
  if (!/^browser_regression_/.test(schema)) throw new Error("Owned migrated browser schema required");
  const { provisionExchangePilots } = await import("./src/lib/offboarding/exchange-service.ts");
  const { actionSeparation } = await import("./src/lib/offboarding/service.ts");
  const { savePolicy, decidePolicy } = await import("./src/lib/offboarding/policy.ts");
  const { recordHumanPermissionDecision } = await import("./src/lib/human-permissions.ts");
  const { SENSITIVE_DATA_CLASSES } = await import("./src/lib/onboarding/sensitive-lifecycle.ts");
  const { runWithProviderDeny } = await import("./src/lib/onboarding/provider-policy.ts");
  const keys = ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit", "tool.case.read", "tool.approval.decide",
    "tool.policy.manage", "tool.notification.send", "tool.external.dispatch", "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"];
  return runWithProviderDeny(async () => {
    for (const user of [people.actor, people.legal]) {
      await p.db.insert(p.organizationMembershipsTable).values({ organizationId: "demo", clerkUserId: user, role: "member" }).onConflictDoNothing();
      const grants = await p.db.select().from(p.accessNamedGrants).where(and(eq(p.accessNamedGrants.organizationId, "demo"), eq(p.accessNamedGrants.principalId, user)));
      for (const resourceKey of keys.filter(k => !grants.some(g => g.resourceKey === k))) await p.db.insert(p.accessNamedGrants).values({
        organizationId: "demo", principalType: "human", principalId: user, scope: "tenant",
        resourceType: resourceKey.startsWith("flow.") ? "flow" : resourceKey.startsWith("tool.") ? "tool" : "field", resourceKey,
        source: "named", effect: "allow", status: "active", createdByUserId: "fixture-grantor", approvedByUserId: "fixture-independent-grantor", approvedAt: new Date(),
      });
    }
    await p.db.transaction(async tx => {
      const old = await tx.select().from(p.onbSensitiveLifecyclePolicies).where(eq(p.onbSensitiveLifecyclePolicies.organizationId, "demo"));
      const revision = Math.max(0, ...old.map(v => v.revision)) + 1;
      const decision = await recordHumanPermissionDecision(tx, { organizationId: "demo", actorUserId: people.legal,
        requiredKeys: ["tool.policy.manage"], reviewedRevision: revision, evidenceGeneration: revision, decision: "policy-approved" });
      await tx.update(p.onbSensitiveLifecyclePolicies).set({ isCurrent: false, supersededAt: new Date() }).where(eq(p.onbSensitiveLifecyclePolicies.organizationId, "demo"));
      for (const dataClass of SENSITIVE_DATA_CLASSES) await tx.insert(p.onbSensitiveLifecyclePolicies).values({
        organizationId: "demo", dataClass, jurisdiction: "US", revision, purpose: "Isolated contextual browser fixture", lawfulBasis: "Isolated fixture basis",
        retentionDays: 30, providerSharingApproved: false, permittedProviders: [], policyReference: "isolated-contextual-policy",
        approvalReference: "isolated-contextual-review", approvedByUserId: people.legal, approvedAuthorityAssignmentId: decision.id,
      });
    });
    const created = await provisionExchangePilots("demo", people.actor, { confirmAddThree: true });
    const draft = await savePolicy("demo", people.actor, { expectedVersion: 0, policy: {
      country: "US", role: "Engineer", workerCategory: "Employee", timeZone: "America/New_York", endOfLwd: "18:00",
      rulesReference: "isolated-contextual-rules", retentionReference: "isolated-contextual-retention", defaultAssets: [], obligations: [],
    } });
    await decidePolicy("demo", people.legal, draft.id, draft.version, { decision: "approve", reference: "independent-browser-review" });
    for (const id of created.caseIds) {
      const act = async (action, rest) => {
        const [row] = await p.db.select().from(p.offbCases).where(eq(p.offbCases.id, id));
        return actionSeparation("demo", people.actor, id, { expectedVersion: row.version, action, reference: `browser:${action}`, ...rest });
      };
      await act("screen", { sensitiveTriggers: [] });
      await act("classify", { confirmed: true, classification: "Human-reviewed resignation", urgency: "Standard",
        flags: { privileged: false, highRisk: false, clientFacing: false, peopleManager: false, statutory: false } });
      await act("adopt-policy", { policyId: draft.id, policyVersion: draft.version });
    }
    return { caseIds: created.caseIds, organizationId: "demo", userId: people.actor, sent: 0 };
  });
}
