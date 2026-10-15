import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";

export async function exchangeBrowserBoundary() {
  const { withExchangeTestIdentity } = await import("./src/lib/offboarding/exchange-test-boundary.ts");
  const { withOffboardingTestProvider } = await import("./src/lib/offboarding/exchange-runtime.ts");
  const { externalProviderDispatchDenied } = await import("./src/lib/onboarding/provider-policy.ts");
  const owner = "browser-exchange-owner", escalation = "browser-exchange-escalation";
  const ownerAddress = "owner@offboarding-fixture.com", escalationAddress = "escalation@offboarding-fixture.com";
  const mailbox = "channel@offboarding-fixture.com";
  let sent = 0, probes = 0;
  process.env.ONBOARDING_ALLOWED_RECIPIENTS = `${ownerAddress},${escalationAddress}`;
  const provider = {
    get: async path => {
      assert.equal(externalProviderDispatchDenied(), true);
      assert.equal(path, "/gmail/v1/users/me/profile", "No inbox reads in this fixture");
      probes++;
      return { ok: true, json: async () => ({ emailAddress: mailbox }) };
    },
    send: async to => {
      assert.equal(externalProviderDispatchDenied(), true);
      assert.ok([ownerAddress, escalationAddress].includes(to), "Only owned fake contacts");
      sent++;
      return { status: "sent", externalMessageId: `browser-exchange-${sent}` };
    },
  };
  return {
    owner, escalation, ownerAddress, escalationAddress, agentId: "browser-exchange-agent",
    run: action => withExchangeTestIdentity({ mailbox, members: [[ownerAddress, owner], [escalationAddress, escalation]] },
      () => withOffboardingTestProvider(provider, action)),
    counts: () => ({ sent, probes }),
  };
}

/** Only the isolated browser server imports this module. No provider enrollment,
 * directory verification, real recipient or external effect is created. */
export async function seedExchangeBrowserFixture(p, people, boundary) {
  if (process.env.ONBOARDING_E2E_TEST !== "true" || process.env.NODE_ENV !== "test") throw new Error("Isolated browser fixture only");
  const schema = (await p.db.execute(sql`SELECT current_schema() AS s`)).rows[0]?.s;
  if (!/^browser_regression_/.test(schema)) throw new Error("Owned migrated browser schema required");
  const { PILOT_PROVENANCE } = await import("./src/lib/offboarding/exchange-service.ts");
  const { initialPilotState } = await import("./src/lib/offboarding/exchange-contract.ts");
  const { createFixedPilotSeparationInTransaction, actionSeparation } = await import("./src/lib/offboarding/service.ts");
  const { savePolicy, decidePolicy } = await import("./src/lib/offboarding/policy.ts");
  const { recordHumanPermissionDecision } = await import("./src/lib/human-permissions.ts");
  const { SENSITIVE_DATA_CLASSES } = await import("./src/lib/onboarding/sensitive-lifecycle.ts");
  const { runWithProviderDeny } = await import("./src/lib/onboarding/provider-policy.ts");
  const keys = ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit", "tool.case.read", "tool.approval.decide",
    "tool.policy.manage", "tool.notification.send", "tool.external.dispatch", "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"];
  return runWithProviderDeny(async () => {
    for (const user of [people.actor, people.legal, boundary.owner, boundary.escalation]) {
      await p.db.insert(p.organizationMembershipsTable).values({ organizationId: "demo", clerkUserId: user, role: user === people.actor ? "admin" : "member" }).onConflictDoNothing();
      const grants = await p.db.select().from(p.accessNamedGrants).where(and(eq(p.accessNamedGrants.organizationId, "demo"), eq(p.accessNamedGrants.principalId, user)));
      for (const resourceKey of keys.filter(k => user !== people.actor && !grants.some(g => g.resourceKey === k))) await p.db.insert(p.accessNamedGrants).values({
        organizationId: "demo", principalType: "human", principalId: user, scope: "tenant",
        resourceType: resourceKey.startsWith("flow.") ? "flow" : resourceKey.startsWith("tool.") ? "tool" : "field", resourceKey,
        source: "named", effect: "allow", status: "active", createdByUserId: "fixture-grantor", approvedByUserId: "fixture-independent-grantor", approvedAt: new Date(),
      });
    }
    await p.db.insert(p.accessAgents).values({ organizationId: "demo", id: boundary.agentId, name: "Conversation agent",
      ownerUserId: people.actor, createdByUserId: people.actor });
    // Explicit initial settings for the missing-contact validation path.
    // All subsequent changes go through the real browser defaults endpoint.
    await p.db.insert(p.onbSettings).values({ organizationId: "demo", key: "offboarding-gmail-defaults",
      value: JSON.stringify({ revision: 1, agentId: "", recipients: [], enabled: false, escalationEnabled: true,
        clientControlConfigured: false, operator: null, mailbox: null }) });
    await p.db.insert(p.accessNamedGrants).values(keys.filter(k => k !== "tool.approval.decide").map(resourceKey => ({
      organizationId: "demo", principalType: "agent", principalId: boundary.agentId, scope: "tenant",
      resourceType: resourceKey.startsWith("flow.") ? "flow" : resourceKey.startsWith("tool.") ? "tool" : "field",
      resourceKey, source: "named", effect: "allow", status: "active", createdByUserId: "fixture-grantor",
      approvedByUserId: "fixture-independent-grantor", approvedAt: new Date(),
    })));
    await p.db.transaction(async tx => {
      const old = await tx.select().from(p.onbSensitiveLifecyclePolicies).where(eq(p.onbSensitiveLifecyclePolicies.organizationId, "demo"));
      const revision = Math.max(0, ...old.map(v => v.revision)) + 1;
      const decision = await recordHumanPermissionDecision(tx, { organizationId: "demo", actorUserId: people.legal,
        requiredKeys: ["tool.policy.manage"], reviewedRevision: revision, evidenceGeneration: revision, decision: "policy-approved" });
      await tx.update(p.onbSensitiveLifecyclePolicies).set({ isCurrent: false, supersededAt: new Date() }).where(eq(p.onbSensitiveLifecyclePolicies.organizationId, "demo"));
      for (const dataClass of SENSITIVE_DATA_CLASSES) await tx.insert(p.onbSensitiveLifecyclePolicies).values({
        organizationId: "demo", dataClass, jurisdiction: "US", revision, purpose: "Isolated contextual browser fixture", lawfulBasis: "Isolated fixture basis",
        retentionDays: 30, providerSharingApproved: true, permittedProviders: ["gmail"], policyReference: "isolated-contextual-policy",
        approvalReference: "isolated-contextual-review", approvedByUserId: people.legal, approvedAuthorityAssignmentId: decision.id,
      });
    });
    // Only two pre-existing, contact-free cases. The browser later calls the
    // real provision endpoint to create the missing scenario AFTER enablement.
    const caseIds = await p.db.transaction(async tx => {
      const ids = [];
      for (const scenario of ["success", "delayed"]) {
        const result = await createFixedPilotSeparationInTransaction(tx, "demo", people.actor, scenario);
        await tx.update(p.onbCases).set({ scenarioKey: `OFFB-CONTEXTUAL:${scenario}`, syntheticProvenance: "demo-full-coverage",
          notes: "[synthetic-offline-reset:v1]" }).where(eq(p.onbCases.id, result.caseId));
        const state = initialPilotState(new Date(Date.now() + 3 * 86400000).toISOString());
        state.clock = new Date().toISOString();
        state.tasks.forEach(t => { t.dueAt = ""; t.notBeforeAt = null; });
        await tx.insert(p.offbExchangePilots).values({ caseId: result.caseId, organizationId: "demo", provenance: PILOT_PROVENANCE,
          scenario, createdBy: people.actor, state });
        ids.push(result.caseId);
      }
      return ids;
    });
    const draft = await savePolicy("demo", people.actor, { expectedVersion: 0, policy: {
      country: "US", role: "Engineer", workerCategory: "Employee", timeZone: "America/New_York", endOfLwd: "18:00",
      rulesReference: "isolated-contextual-rules", retentionReference: "isolated-contextual-retention", defaultAssets: [], obligations: [],
    } });
    await decidePolicy("demo", people.legal, draft.id, draft.version, { decision: "approve", reference: "independent-browser-review" });
    for (const id of caseIds) {
      const act = async (action, rest) => {
        const [row] = await p.db.select().from(p.offbCases).where(eq(p.offbCases.id, id));
        return actionSeparation("demo", people.actor, id, { expectedVersion: row.version, action, reference: `browser:${action}`, ...rest });
      };
      await act("screen", { sensitiveTriggers: [] });
      await act("classify", { confirmed: true, classification: "Human-reviewed resignation", urgency: "Standard",
        flags: { privileged: false, highRisk: false, clientFacing: false, peopleManager: false, statutory: false } });
      await act("adopt-policy", { policyId: draft.id, policyVersion: draft.version });
    }
    const actorGrants = await p.db.select().from(p.accessNamedGrants).where(and(eq(p.accessNamedGrants.organizationId, "demo"),
      eq(p.accessNamedGrants.principalId, people.actor)));
    assert.equal(actorGrants.length, 0, "Named client administrator uses membership, not individual grants");
    return { caseIds, organizationId: "demo", userId: people.actor, policy: { id: draft.id, version: draft.version },
      administratorNamedGrants: actorGrants.length, ...boundary.counts() };
  });
}

export async function inspectExchangeBrowserFixture(p, fixture, boundary) {
  const rows = await p.db.select().from(p.offbExchanges).where(eq(p.offbExchanges.organizationId, "demo"));
  return { ...boundary.counts(), exchanges: rows.map(({ id, caseId, direction, status }) => ({ id, caseId, direction, status })),
    caseIds: fixture.caseIds };
}
