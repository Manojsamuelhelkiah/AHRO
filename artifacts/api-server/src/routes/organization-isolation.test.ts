import { deleteTestOrganizations, requireOwnedOrganizationTestSchema } from "../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  actualsOverlaysTable,
  customIntentsTable,
  db,
  eaAssessmentsTable,
  flowOverridesTable,
  onbCaseLogistics,
  onbCases,
  onbAuditEntries,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCommunications,
  onbChecklistProfiles,
  onbConnectors,
  onbEffectJournal,
  onbEvents,
  onbGuardrailEvents,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisionReviews,
  onbGovernanceDecisions,
  onbGovernanceDispatchMarkers,
  onbGovernanceHistory,
  onbGovernanceReminders,
  onbGovernanceRequirements,
  onbIntakeBatches,
  onbIntakeBatchPeople,
  onbSettings,
  onbReadinessSlaPolicies,
  onbSensitiveLifecyclePolicies,
  organizationMembershipsTable,
  organizationsTable,
  pricingRateSetsTable,
  pricingSheetsTable,
  scenarioFilesTable,
  scenarioUploadIntentsTable,
  accessSecurityGroups,
  accessSecurityGroupPolicies,
  accessSecurityGroupUserGroups,
  accessSecurityGroupAttachments,
  accessUserGroups,
  accessUserGroupMembers,
  scenariosTable,
} from "@workspace/db";
import { DEMO_ORGANIZATION_ID } from "@workspace/db/schema";
import scenariosRouter from "./scenarios";
import scenarioFilesRouter from "./scenario-files";
import actualsRouter from "./actuals";
import flowOverridesRouter from "./flow-overrides";
import customIntentsRouter from "./custom-intents";
import onboardingRouter, {
  setAfterSensitiveLifecycleGateHookForTests,
} from "./onboarding";
import onboardingBatchIntakeRouter from "./onboarding-batch-intake";
import pricingSheetsRouter from "./pricing-sheets";
import enterpriseArchitectureRouter from "./enterprise-architecture";
import {
  buildBaselineRates,
  loadCurrentRateSet,
} from "../lib/pricing-rate-sets";
import { organizationValues } from "../lib/organization-scope";
import {
  LEGACY_CHECKLIST,
  readinessFromChecklist,
} from "../lib/onboarding/settings";
import {
  createTenantContextMiddleware,
  lookupMembership,
} from "../middlewares/tenant-context";
import { errorHandler } from "../middlewares/error-handler";
import { scenarioUploadObjectPath } from "../lib/objectStorage";
import { withCaseDispatchGuard } from "../lib/onboarding/dispatch-guard";
import { dispatchWorkstreamConnectorMutations } from "../lib/onboarding/workstream-connectors";
import { seedApprovedSensitiveLifecyclePolicies } from "../test-utils/sensitive-lifecycle-fixtures";
import { saveSensitiveLifecyclePolicy } from "../lib/onboarding/sensitive-lifecycle";

const suffix = `${process.pid}-${Date.now()}`;
const orgA = `isolation-a-${suffix}`;
const orgB = `isolation-b-${suffix}`;
const profileReader = `isolation-profile-reader-${suffix}`;
const noFlowReader = `isolation-no-flow-reader-${suffix}`;
let server: Server;
let baseUrl: string;

async function grantOpaqueNarrativeAuthority(caseId: number) {
  const policyOwnerUserId = "test-independent-policy-owner";
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgA,
    clerkUserId: policyOwnerUserId,
    role: "member",
  }).onConflictDoNothing();
  await db.insert(onbAuthorityGovernance).values({
    organizationId: orgA,
    status: "governance-approved",
    approvedByUserId: "test-governance",
    approvedAt: new Date(),
    governanceSource: "route-test",
    revision: 1,
  }).onConflictDoNothing();
  await db.insert(onbAuthorityAssignments).values([
    {
      id: `isolation-opaque-identity-${caseId}-${suffix}`,
      organizationId: orgA,
      personUserId: "test-user-a",
      authorityRole: "hr-compliance",
      scopes: ["hr-compliance-approve"],
      caseId,
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60_000),
      status: "active",
      revision: 1,
      grantorUserId: "test-governance",
      source: "route-test",
      governanceDecisionRef: "route-test",
    },
    {
      id: `isolation-opaque-medical-${caseId}-${suffix}`,
      organizationId: orgA,
      personUserId: "test-user-a",
      authorityRole: "occupational-health",
      scopes: ["occupational-health-approve"],
      caseId,
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60_000),
      status: "active",
      revision: 1,
      grantorUserId: "test-governance",
      source: "route-test",
      governanceDecisionRef: "route-test",
    },
    {
      id: `isolation-opaque-payroll-${caseId}-${suffix}`,
      organizationId: orgA,
      personUserId: "test-user-a",
      authorityRole: "payroll",
      scopes: ["payroll-approve"],
      caseId,
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60_000),
      status: "active",
      revision: 1,
      grantorUserId: "test-governance",
      source: "route-test",
      governanceDecisionRef: "route-test",
    },
    {
      id: `isolation-opaque-bgv-${caseId}-${suffix}`,
      organizationId: orgA,
      personUserId: "test-user-a",
      authorityRole: "hr-compliance",
      scopes: ["hr-compliance-approve"],
      caseId,
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60_000),
      status: "active",
      revision: 1,
      grantorUserId: "test-governance",
      source: "route-test",
      governanceDecisionRef: "route-test",
    },
  ]);
  const userGroupId = `isolation-opaque-user-group-${caseId}-${suffix}`;
  const securityGroupId = `isolation-opaque-security-group-${caseId}-${suffix}`;
  await db.insert(accessUserGroups).values({
    id: userGroupId,
    organizationId: orgA,
    name: userGroupId,
    ownerUserId: policyOwnerUserId,
    createdByUserId: "test-user-a",
  });
  await db.insert(accessSecurityGroups).values({
    id: securityGroupId,
    organizationId: orgA,
    name: securityGroupId,
    ownerUserId: policyOwnerUserId,
    createdByUserId: "test-user-a",
  });
  await db.insert(accessUserGroupMembers).values({
    organizationId: orgA,
    groupId: userGroupId,
    principalType: "human",
    principalId: "test-user-a",
    requiresApproval: "yes",
    attachedByUserId: "test-user-a",
    approvedByUserId: policyOwnerUserId,
    approvedAt: new Date(),
  });
  await db.insert(accessSecurityGroupUserGroups).values({
    organizationId: orgA,
    securityGroupId,
    userGroupId,
    requiresApproval: "yes",
    approvedByUserId: policyOwnerUserId,
    approvedAt: new Date(),
    approvedPolicyVersion: 1,
    attachedByUserId: "test-user-a",
  });
  await db.insert(accessSecurityGroupPolicies).values({
    organizationId: orgA,
    securityGroupId,
    version: 1,
    policy: {
      fields: [
        ...["identity", "medical", "payroll", "bgv"].flatMap((dataClass) => [
          `data.${dataClass}.read`, `data.${dataClass}.edit`,
        ]),
        "data.case.profile.read",
        "data.case.profile.edit",
        "data.case.notes.read",
        "data.case.notes.edit",
        "data.case.readiness.read",
        "data.case.readiness.edit",
      ],
      flows: ["flow.case.read", "flow.case.edit"],
      tools: [],
    },
    createdByUserId: "test-user-a",
    approvedByUserId: policyOwnerUserId,
    approvedAt: new Date(),
  });
  await db.insert(accessSecurityGroupAttachments).values({
    organizationId: orgA,
    securityGroupId,
    scope: "case",
    caseId,
    requiresApproval: "yes",
    attachedByUserId: "test-user-a",
    approvedByUserId: policyOwnerUserId,
    approvedAt: new Date(),
    approvedPolicyVersion: 1,
  });
}

before(async () => {
  await requireOwnedOrganizationTestSchema();
  await db.insert(organizationsTable).values([
    {
      id: orgA,
      name: "Isolation A",
      slug: orgA,
      joinCodeHash: `hash-${orgA}`,
      createdByUserId: "test-user-a",
    },
    {
      id: orgB,
      name: "Isolation B",
      slug: orgB,
      joinCodeHash: `hash-${orgB}`,
      createdByUserId: "test-user-b",
    },
  ]);
  await db.insert(organizationMembershipsTable).values([
    {
      organizationId: orgA,
      clerkUserId: "test-user-a",
      role: "owner",
    },
    {
      organizationId: orgB,
      clerkUserId: "test-user-b",
      role: "owner",
    },
    {
      organizationId: orgA,
      clerkUserId: profileReader,
      role: "member",
    },
    {
      organizationId: orgA,
      clerkUserId: noFlowReader,
      role: "member",
    },
  ]);
  for (const [organizationId, principalId] of [[orgA, "test-user-a"], [orgB, "test-user-b"]] as const) {
    const userGroupId = `isolation-case-users-${organizationId}`;
    const securityGroupId = `isolation-case-policy-${organizationId}`;
    await db.insert(accessUserGroups).values({
      id: userGroupId,
      organizationId,
      name: userGroupId,
      ownerUserId: principalId,
      createdByUserId: principalId,
    });
    await db.insert(accessSecurityGroups).values({
      id: securityGroupId,
      organizationId,
      name: securityGroupId,
      ownerUserId: principalId,
      createdByUserId: principalId,
    });
    await db.insert(accessUserGroupMembers).values({
      organizationId,
      groupId: userGroupId,
      principalType: "human",
      principalId,
      attachedByUserId: principalId,
    });
    await db.insert(accessSecurityGroupUserGroups).values({
      organizationId,
      securityGroupId,
      userGroupId,
      attachedByUserId: principalId,
    });
    await db.insert(accessSecurityGroupPolicies).values({
      organizationId,
      securityGroupId,
      version: 1,
      policy: {
        fields: [
          "data.case.profile.read",
          "data.case.profile.edit",
          "data.case.notes.read",
          "data.case.notes.edit",
          "data.case.readiness.read",
          "data.case.readiness.edit",
        ],
        flows: ["flow.case.read", "flow.case.edit"],
        tools: [],
      },
      createdByUserId: principalId,
      approvedByUserId: "independent-isolation-case-approver",
      approvedAt: new Date(),
    });
    await db.insert(accessSecurityGroupAttachments).values({
      organizationId,
      securityGroupId,
      scope: "tenant",
      caseId: null,
      attachedByUserId: principalId,
    });
  }
  const profileReaderGroupId = `isolation-profile-reader-group-${suffix}`;
  const profileReaderSecurityGroupId = `isolation-profile-reader-policy-${suffix}`;
  await db.insert(accessUserGroups).values({
    id: profileReaderGroupId,
    organizationId: orgA,
    name: profileReaderGroupId,
    ownerUserId: profileReader,
    createdByUserId: profileReader,
  });
  await db.insert(accessSecurityGroups).values({
    id: profileReaderSecurityGroupId,
    organizationId: orgA,
    name: profileReaderSecurityGroupId,
    ownerUserId: profileReader,
    createdByUserId: profileReader,
  });
  await db.insert(accessUserGroupMembers).values({
    organizationId: orgA,
    groupId: profileReaderGroupId,
    principalType: "human",
    principalId: profileReader,
    attachedByUserId: profileReader,
  });
  await db.insert(accessSecurityGroupUserGroups).values({
    organizationId: orgA,
    securityGroupId: profileReaderSecurityGroupId,
    userGroupId: profileReaderGroupId,
    attachedByUserId: profileReader,
  });
  await db.insert(accessSecurityGroupPolicies).values({
    organizationId: orgA,
    securityGroupId: profileReaderSecurityGroupId,
    version: 1,
    policy: {
      fields: ["data.case.profile.read"],
      flows: ["flow.case.read"],
      tools: [],
    },
    createdByUserId: profileReader,
    approvedByUserId: "independent-profile-reader-approver",
    approvedAt: new Date(),
  });
  await db.insert(accessSecurityGroupAttachments).values({
    organizationId: orgA,
    securityGroupId: profileReaderSecurityGroupId,
    scope: "tenant",
    caseId: null,
    attachedByUserId: profileReader,
  });
  for (const organizationId of [orgA, orgB]) {
    await db.insert(scenariosTable).values({
      ...organizationValues(organizationId),
      name: `Scenario ${organizationId}`,
      inputs: {
        numSystems: 4,
        annualTransactions: 120_000,
        employees: 8_000,
        sector: "manufacturing",
        companyType: "multi-country",
        isolationTier: "siloed",
        hrHourlyCostUsd: 38,
        hitlHourlyCostUsd: 42,
        countries: 6,
      },
    });
    await db.insert(actualsOverlaysTable).values({
      organizationId,
      clientLabel: `Actuals ${organizationId}`,
      payload: { intents: [] },
    });
    await db.insert(flowOverridesTable).values({
      organizationId,
      intentKey: "payroll-inquiry",
      version: 1,
      status: "draft",
      author: "Isolation test",
      rationale: organizationId,
    });
    await db.insert(customIntentsTable).values({
      organizationId,
      key: `custom-${organizationId}`,
      name: `Custom ${organizationId}`,
      domain: "test",
      flowClass: "simple",
      description: "Tenant isolation fixture",
      asIsHandlingMin: 10,
      toBeHumanMin: 2,
      baseWeight: 1,
      actGetActions: 1,
      actPutActions: 0,
      source: "test",
      author: "test",
    });
    await db.insert(pricingSheetsTable).values({
      ...organizationValues(organizationId),
      name: `Pricing ${organizationId}`,
      inputs: {
        clientsInCohort: 1,
        annualTransactions: 1000,
        channels: 1,
        integrations: 1,
        agents: 1,
        workflows: 1,
        tenantTier: "pooled",
        securityTier: "standard",
        tokenProfile: "light",
        infrastructureTier: "starter",
        supportTier: "essential",
        grossMarginPct: 30,
        buildAmortizationYears: 3,
      },
      recommendation: {
        recommendedMonthlySubscription: 1,
        recommendedAnnualCommitment: 12,
        recommendedTransactionPrice: 1,
        recommendedOveragePrice: 1,
        recommendedImplementationFee: 1,
        includedAnnualTransactions: 1000,
      },
    });
    await db.insert(pricingRateSetsTable).values({
      organizationId,
      effectiveDate: "2025-01-01",
      rationale: `Rates ${organizationId}`,
      rates: buildBaselineRates(),
      createdBy: "test",
    });
    await db.insert(eaAssessmentsTable).values({
      organizationId,
      ownerUserId: "test-user",
      name: `Architecture ${organizationId}`,
      clientName: `Client ${organizationId}`,
      currentPhase: "preliminary",
      content: {},
    });
    await db.insert(onbCases).values({
      organizationId,
      workerName: `Worker ${organizationId}`,
      workerEmail: `${organizationId}@example.com`,
      hireType: "external",
      workerCategory: "full-time",
      role: "Engineer",
      department: "Engineering",
      geography: "US",
      legalEntity: "Example",
      managerName: "Manager",
      recruiterName: "Recruiter",
      joiningDate: "2030-01-01",
      workforceContext: { workCountry: "US" },
      planSummary: "Restricted plan narrative.",
      notes: "Restricted case note.",
    });
  }
  await seedApprovedSensitiveLifecyclePolicies(orgA);
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: orgA,
    authorityRole: "privacy",
    assigneeUserId: "test-user-a",
    verificationStatus: "verified",
    verifiedByUserId: "test-governance",
    verificationReference: "test-lifecycle-policy-authority",
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = String(req.header("x-test-user"));
    Object.assign(req, {
      auth: Object.assign(
        () => ({
          userId,
          sessionClaims: null,
          tokenType: "session_token" as const,
        }),
        { [Symbol.for("@clerk/express.auth")]: true },
      ),
    });
    req.authUserId = userId;
    next();
  });
  app.use(createTenantContextMiddleware(lookupMembership));
  app.use(scenariosRouter);
  app.use(scenarioFilesRouter);
  app.use(actualsRouter);
  app.use(flowOverridesRouter);
  app.use(customIntentsRouter);
  app.use(onboardingRouter);
  app.use(onboardingBatchIntakeRouter);
  app.use(pricingSheetsRouter);
  app.use(enterpriseArchitectureRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  // These positive-lifecycle policies are test-owned and reference the
  // temporary organization without a cascading foreign key.
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, orgA));
  await db.delete(onbEvents).where(eq(onbEvents.organizationId, orgA));
  await db.delete(onbEvents).where(eq(onbEvents.organizationId, orgB));
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, orgA));
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, orgB));
  await db.delete(onbReadinessSlaPolicies).where(eq(onbReadinessSlaPolicies.organizationId, orgA));
  await db.delete(onbReadinessSlaPolicies).where(eq(onbReadinessSlaPolicies.organizationId, orgB));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, orgA));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, orgB));
  await db.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, orgA));
  await db.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, orgB));
  await db.delete(onbIntakeBatchPeople).where(eq(onbIntakeBatchPeople.organizationId, orgA));
  await db.delete(onbIntakeBatchPeople).where(eq(onbIntakeBatchPeople.organizationId, orgB));
  await db.delete(onbIntakeBatches).where(eq(onbIntakeBatches.organizationId, orgA));
  await db.delete(onbIntakeBatches).where(eq(onbIntakeBatches.organizationId, orgB));
  await db.delete(onbCaseLogistics).where(eq(onbCaseLogistics.organizationId, orgA));
  await db.delete(onbCaseLogistics).where(eq(onbCaseLogistics.organizationId, orgB));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgA));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgB));
  // New-case governance snapshots seed ordinary decision/requirement rows.
  // Remove those mutable fixtures after their cases, and remove dependent
  // reviews/reminders before the decision revision rows.
  await db.delete(onbGovernanceDecisionReviews).where(inArray(
    onbGovernanceDecisionReviews.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceAuthorityAssignments).where(inArray(
    onbGovernanceAuthorityAssignments.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceReminders).where(inArray(
    onbGovernanceReminders.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceDispatchMarkers).where(inArray(
    onbGovernanceDispatchMarkers.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceRequirements).where(inArray(
    onbGovernanceRequirements.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceDecisions).where(inArray(
    onbGovernanceDecisions.organizationId, [orgA, orgB],
  ));
  await db.delete(onbChecklistProfiles).where(eq(onbChecklistProfiles.organizationId, orgA));
  await db.delete(onbChecklistProfiles).where(eq(onbChecklistProfiles.organizationId, orgB));
  await db.delete(eaAssessmentsTable).where(eq(eaAssessmentsTable.organizationId, orgA));
  await db.delete(eaAssessmentsTable).where(eq(eaAssessmentsTable.organizationId, orgB));
  await db.delete(pricingSheetsTable).where(eq(pricingSheetsTable.organizationId, orgA));
  await db.delete(pricingSheetsTable).where(eq(pricingSheetsTable.organizationId, orgB));
  await db.delete(pricingRateSetsTable).where(eq(pricingRateSetsTable.organizationId, orgA));
  await db.delete(pricingRateSetsTable).where(eq(pricingRateSetsTable.organizationId, orgB));
  await db.delete(customIntentsTable).where(eq(customIntentsTable.organizationId, orgA));
  await db.delete(customIntentsTable).where(eq(customIntentsTable.organizationId, orgB));
  await db.delete(flowOverridesTable).where(eq(flowOverridesTable.organizationId, orgA));
  await db.delete(flowOverridesTable).where(eq(flowOverridesTable.organizationId, orgB));
  await db.delete(actualsOverlaysTable).where(eq(actualsOverlaysTable.organizationId, orgA));
  await db.delete(actualsOverlaysTable).where(eq(actualsOverlaysTable.organizationId, orgB));
  await db.delete(scenariosTable).where(eq(scenariosTable.organizationId, orgA));
  await db.delete(scenariosTable).where(eq(scenariosTable.organizationId, orgB));
  await db.delete(accessSecurityGroupAttachments).where(inArray(
    accessSecurityGroupAttachments.organizationId, [orgA, orgB],
  ));
  await db.delete(accessSecurityGroupUserGroups).where(inArray(
    accessSecurityGroupUserGroups.organizationId, [orgA, orgB],
  ));
  await db.delete(accessSecurityGroupPolicies).where(inArray(
    accessSecurityGroupPolicies.organizationId, [orgA, orgB],
  ));
  await db.delete(accessUserGroupMembers).where(inArray(
    accessUserGroupMembers.organizationId, [orgA, orgB],
  ));
  await db.delete(accessSecurityGroups).where(inArray(
    accessSecurityGroups.organizationId, [orgA, orgB],
  ));
  await db.delete(accessUserGroups).where(inArray(
    accessUserGroups.organizationId, [orgA, orgB],
  ));
  await db
    .delete(organizationMembershipsTable)
    .where(eq(organizationMembershipsTable.organizationId, orgA));
  await db
    .delete(organizationMembershipsTable)
    .where(eq(organizationMembershipsTable.organizationId, orgB));
  // Protected audit evidence and append-only governance history are never
  // fixture cleanup targets. Keep their tenant shell when either exists;
  // otherwise the temporary organization can be removed normally.
  const [protectedAudits, immutableGovernanceHistory] = await Promise.all([
    db.select({ organizationId: onbAuditEntries.organizationId })
      .from(onbAuditEntries)
      .where(inArray(onbAuditEntries.organizationId, [orgA, orgB]))
      .limit(1),
    db.select({ organizationId: onbGovernanceHistory.organizationId })
      .from(onbGovernanceHistory)
      .where(inArray(onbGovernanceHistory.organizationId, [orgA, orgB]))
      .limit(1),
  ]);
  const retainedOrganizationIds = new Set([
    ...protectedAudits.map((row) => row.organizationId),
    ...immutableGovernanceHistory.map((row) => row.organizationId),
  ]);
  const removableOrganizationIds = [orgA, orgB].filter(
    (organizationId) => !retainedOrganizationIds.has(organizationId),
  );
  if (removableOrganizationIds.length) {
    await deleteTestOrganizations(inArray(
      organizationsTable.id,
      removableOrganizationIds,
    ));
  }
});

async function get(path: string, organizationId: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "x-test-user": organizationId === orgA ? "test-user-a" : "test-user-b",
      "x-organization-id": organizationId,
    },
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<unknown[]>;
}

test("list route families do not expose another organization's records", async () => {
  const cases = [
    ["/scenarios", "name"],
    ["/actuals", "clientLabel"],
    ["/flow-overrides", "rationale"],
    ["/custom-intents", "key"],
    ["/pricing-sheets", "name"],
  ] as const;

  for (const [path, identifyingField] of cases) {
    const rowsA = await get(path, orgA) as Array<Record<string, unknown>>;
    const rowsB = await get(path, orgB) as Array<Record<string, unknown>>;
    assert.equal(rowsA.length, 1, path);
    assert.equal(rowsB.length, 1, path);
    assert.notEqual(rowsA[0]?.[identifyingField], rowsB[0]?.[identifyingField], path);
  }

  const rowsA = await get("/onboarding/cases", orgA) as Array<Record<string, unknown>>;
  const rowsB = await get("/onboarding/cases", orgB) as Array<Record<string, unknown>>;
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  assert.notEqual(rowsA[0]?.id, rowsB[0]?.id, "case records stay tenant-scoped");
  assert.equal(rowsA[0]?.workerName, "Restricted candidate");
  assert.equal(rowsB[0]?.workerName, "Restricted candidate");
});

test("case profile and notes are independently redacted and flow read is enforced", async () => {
  const profileResponse = await fetch(`${baseUrl}/onboarding/cases`, {
    headers: { "x-test-user": profileReader, "x-organization-id": orgA },
  });
  assert.equal(profileResponse.status, 200);
  const profileRows = await profileResponse.json() as Array<Record<string, unknown>>;
  assert.equal(profileRows.length, 1);
  assert.equal(profileRows[0]?.role, "Engineer");
  assert.equal(profileRows[0]?.workerName, "Restricted candidate");
  assert.equal(profileRows[0]?.planSummary, null);
  // Profile-read does not bypass the existing all-class specialist gate for
  // opaque workforce context.
  assert.deepEqual(profileRows[0]?.workforceContext, {});

  const noFlowDetail = await fetch(`${baseUrl}/onboarding/cases/${profileRows[0]?.id}`, {
    headers: { "x-test-user": noFlowReader, "x-organization-id": orgA },
  });
  assert.equal(noFlowDetail.status, 403);
  const noFlowList = await fetch(`${baseUrl}/onboarding/cases`, {
    headers: { "x-test-user": noFlowReader, "x-organization-id": orgA },
  });
  assert.equal(noFlowList.status, 200);
  assert.deepEqual(await noFlowList.json(), []);
});

test("dashboard includes tenant-owned monitor events without a case", async () => {
  const [eventA, eventB] = await db.insert(onbEvents).values([
    {
      organizationId: orgA,
      caseId: null,
      agent: "Inbound email monitor",
      engine: "test",
      title: `Monitor unavailable ${orgA}`,
      detail: "Mailbox polling failed.",
    },
    {
      organizationId: orgB,
      caseId: null,
      agent: "Inbound email monitor",
      engine: "test",
      title: `Monitor unavailable ${orgB}`,
      detail: "Mailbox polling failed.",
    },
  ]).returning({ id: onbEvents.id });

  const response = await fetch(`${baseUrl}/onboarding/dashboard`, {
    headers: {
      "x-test-user": "test-user-a",
      "x-organization-id": orgA,
    },
  });
  assert.equal(response.status, 200);
  const dashboard = await response.json() as {
    recentEvents: Array<{
      id: number;
      caseId: number | null;
      title: string;
      detail: string;
    }>;
  };
  const ownedEvent = dashboard.recentEvents.find((event) => event.id === eventA!.id);
  assert.ok(ownedEvent, "the tenant-owned monitor event is returned");
  assert.deepEqual({
    id: ownedEvent.id,
    caseId: ownedEvent.caseId,
    title: ownedEvent.title,
    detail: ownedEvent.detail,
  }, {
    id: eventA!.id,
    caseId: null,
    title: "Restricted confidential onboarding record.",
    detail: "Restricted confidential onboarding record.",
  });
  assert.equal(
    dashboard.recentEvents.some((event) => event.id === eventB!.id),
    false,
    "another tenant's monitor event is never returned",
  );
});

test("dashboard/analytics and ordinary case mutations exclude a durably linked UAT case", async () => {
  const [uatCase] = await db.insert(onbCases).values({
    organizationId: orgA,
    workerName: "UAT aggregate fence",
    workerEmail: `uat-${suffix}@example.invalid`,
    hireType: "external",
    workerCategory: "full-time",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Example",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    workforceContext: { workCountry: "US" },
    scenarioKey: "UAT-STD-01",
    notes: null,
  }).returning({ id: onbCases.id });
  assert.ok(uatCase);
  await db.insert(onbSettings).values({
    organizationId: orgA,
    key: `onboarding-uat.run.v1:${randomUUID()}`,
    value: JSON.stringify({ runId: randomUUID(), linkedCaseIds: [uatCase.id] }),
  });
  const [uatEvent] = await db.insert(onbEvents).values({
    organizationId: orgA,
    caseId: uatCase.id,
    agent: "UAT",
    engine: "test",
    title: "UAT event must not appear in dashboard",
    detail: "UAT event must not appear in dashboard",
  }).returning({ id: onbEvents.id });
  const headers = {
    "x-test-user": "test-user-a",
    "x-organization-id": orgA,
  };
  const dashboardResponse = await fetch(`${baseUrl}/onboarding/dashboard`, { headers });
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json() as {
    totalCases: number;
    recentEvents: Array<{ id: number }>;
  };
  const nonUatCases = await db.select({ id: onbCases.id }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    sql`${onbCases.id} <> ${uatCase.id}`,
  ));
  assert.equal(dashboard.totalCases, nonUatCases.length);
  assert.equal(dashboard.recentEvents.some((event) => event.id === uatEvent!.id), false);
  const analyticsResponse = await fetch(`${baseUrl}/onboarding/analytics`, { headers });
  assert.equal(analyticsResponse.status, 200);
  const analytics = await analyticsResponse.json() as { narrative: string | null };
  assert.ok(
    analytics.narrative?.startsWith(`${nonUatCases.length} onboarding cases are represented`),
    "UAT cases are excluded from the aggregate narrative",
  );
  const mutation = await fetch(`${baseUrl}/onboarding/cases/${uatCase.id}/offer-acceptance`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(mutation.status, 409);
});

test("rejected Twilio webhooks persist an explicit platform audit event", async () => {
  const detail =
    "Webhook to /onboarding/webhooks/twilio/whatsapp failed Twilio signature validation — request discarded.";
  const existing = await db
    .select({ id: onbGuardrailEvents.id })
    .from(onbGuardrailEvents)
    .where(and(
      eq(onbGuardrailEvents.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbGuardrailEvents.guardrailKey, "webhook-signature"),
      eq(onbGuardrailEvents.detail, detail),
    ));
  const existingIds = new Set(existing.map(({ id }) => id));
  let auditId: number | undefined;
  process.env.TWILIO_AUTH_TOKEN = "organization-isolation-test-token";

  try {
    const response = await fetch(
      `${baseUrl}/onboarding/webhooks/twilio/whatsapp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-organization-id": orgA,
          "x-test-user": "test-user-a",
          "x-twilio-signature": "invalid-signature",
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 403);

    const audits = await db
      .select()
      .from(onbGuardrailEvents)
      .where(and(
        eq(onbGuardrailEvents.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbGuardrailEvents.guardrailKey, "webhook-signature"),
        eq(onbGuardrailEvents.detail, detail),
      ))
      .orderBy(desc(onbGuardrailEvents.id));
    const audit = audits.find(({ id }) => !existingIds.has(id));
    assert.ok(audit);
    auditId = audit.id;
    assert.equal(audit.caseId, null);
    assert.equal(audit.action, "rejected");
  } finally {
    delete process.env.TWILIO_AUTH_TOKEN;
    if (auditId !== undefined) {
      await db
        .delete(onbGuardrailEvents)
        .where(eq(onbGuardrailEvents.id, auditId));
    }
  }
});

test("accepted signed Twilio webhook records pre-attempt and linked outcome without callback data", async () => {
  const [caseRow] = await db.select({ id: onbCases.id }).from(onbCases)
    .where(eq(onbCases.organizationId, orgA)).limit(1);
  assert.ok(caseRow);
  const token = "organization-isolation-signed-webhook-token";
  const messageSid = `SM-${randomUUID()}`;
  await db.insert(onbCommunications).values({
    organizationId: orgA, caseId: caseRow.id, channel: "whatsapp", direction: "outbound",
    toAddress: "redacted", subject: null, body: "not callback data", status: "sent",
    externalMessageId: messageSid,
  });
  const params = { MessageSid: messageSid, MessageStatus: "delivered" };
  const path = "/onboarding/webhooks/twilio/whatsapp-status";
  const signature = createHmac("sha1", token)
    .update(`${baseUrl}${path}${Object.keys(params).sort().map((key) => `${key}${params[key as keyof typeof params]}`).join("")}`, "utf8")
    .digest("base64");
  process.env.TWILIO_AUTH_TOKEN = token;
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-signature": signature,
        "x-organization-id": orgA,
        "x-test-user": "test-user-a",
      },
      body: JSON.stringify(params),
    });
    assert.equal(response.status, 204, await response.text());
    const audit = await db.select().from(onbAuditEntries).where(and(
      eq(onbAuditEntries.organizationId, orgA),
      sql`${onbAuditEntries.action} in ('onboarding.twilio.whatsapp-status.attempted', 'onboarding.twilio.whatsapp-status.accepted')`,
    )).orderBy(desc(onbAuditEntries.sequence));
    const accepted = audit.find((entry) => entry.action.endsWith(".accepted"));
    const attempted = audit.find((entry) => entry.action.endsWith(".attempted"));
    assert.ok(attempted);
    assert.ok(accepted);
    assert.equal(accepted.correctionOfId, attempted.id);
    assert.ok(!JSON.stringify(audit).includes(params.MessageSid));
  } finally {
    delete process.env.TWILIO_AUTH_TOKEN;
  }
});

test("record routes return not found for another organization's identifiers", async () => {
  const [scenario] = await db
    .select({ id: scenariosTable.id })
    .from(scenariosTable)
    .where(eq(scenariosTable.organizationId, orgB));
  const [actuals] = await db
    .select({ id: actualsOverlaysTable.id })
    .from(actualsOverlaysTable)
    .where(eq(actualsOverlaysTable.organizationId, orgB));
  const [onboardingCase] = await db
    .select({ id: onbCases.id })
    .from(onbCases)
    .where(eq(onbCases.organizationId, orgB));
  const [pricingSheet] = await db
    .select({ id: pricingSheetsTable.id })
    .from(pricingSheetsTable)
    .where(eq(pricingSheetsTable.organizationId, orgB));
  const [assessment] = await db
    .select({ id: eaAssessmentsTable.id })
    .from(eaAssessmentsTable)
    .where(eq(eaAssessmentsTable.organizationId, orgB));

  for (const path of [
    `/scenarios/${scenario!.id}`,
    `/actuals/${actuals!.id}`,
    `/pricing-sheets/${pricingSheet!.id}`,
    `/custom-intents/custom-${orgB}`,
    `/onboarding/cases/${onboardingCase!.id}`,
    `/onboarding/cases/${onboardingCase!.id}/events`,
    `/enterprise-architecture/assessments/${assessment!.id}`,
  ]) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        "x-test-user": "test-user-a",
        "x-organization-id": orgA,
      },
    });
    assert.equal(response.status, 404, path);
  }
});

test("rate-set resolution only reads the requesting organization", async () => {
  const ratesA = await loadCurrentRateSet(orgA);
  const ratesB = await loadCurrentRateSet(orgB);
  assert.equal(ratesA?.rationale, `Rates ${orgA}`);
  assert.equal(ratesB?.rationale, `Rates ${orgB}`);
});

test("cross-tenant pricing and architecture writes are rejected", async () => {
  const [pricingSheet] = await db
    .select({ id: pricingSheetsTable.id })
    .from(pricingSheetsTable)
    .where(eq(pricingSheetsTable.organizationId, orgB));
  const [assessment] = await db
    .select({ id: eaAssessmentsTable.id })
    .from(eaAssessmentsTable)
    .where(eq(eaAssessmentsTable.organizationId, orgB));

  const attempts = [
    {
      path: `/pricing-sheets/${pricingSheet!.id}`,
      body: { name: "cross-tenant mutation" },
    },
    {
      path: `/enterprise-architecture/assessments/${assessment!.id}`,
      body: { expectedVersion: 1, name: "cross-tenant mutation" },
    },
  ];
  for (const attempt of attempts) {
    const response = await fetch(`${baseUrl}${attempt.path}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-test-user": "test-user-a",
        "x-organization-id": orgA,
      },
      body: JSON.stringify(attempt.body),
    });
    assert.equal(response.status, 404, attempt.path);
  }
});

test("forged organization selectors are rejected before route access", async () => {
  const response = await fetch(`${baseUrl}/scenarios`, {
    headers: {
      "x-test-user": "test-user-a",
      "x-organization-id": orgB,
    },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    message: "You are not a member of the requested organization",
    code: "ORGANIZATION_ACCESS_DENIED",
  });
});

test("candidate-link retention settings are validated, persisted, and tenant-scoped", async () => {
  const headers = {
    "content-type": "application/json",
    "x-test-user": "test-user-a",
    "x-organization-id": orgA,
  };
  const invalid = await fetch(`${baseUrl}/onboarding/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ candidateLinkRetentionDays: 45 }),
  });
  assert.equal(invalid.status, 400);

  const saved = await fetch(`${baseUrl}/onboarding/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ candidateLinkRetentionDays: 30 }),
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (await saved.json() as { candidateLinkRetentionDays: number }).candidateLinkRetentionDays,
    30,
  );

  const [tenantA, tenantB] = await Promise.all([
    fetch(`${baseUrl}/onboarding/settings`, { headers }),
    fetch(`${baseUrl}/onboarding/settings`, {
      headers: {
        "x-test-user": "test-user-b",
        "x-organization-id": orgB,
      },
    }),
  ]);
  assert.equal(
    (await tenantA.json() as { candidateLinkRetentionDays: number }).candidateLinkRetentionDays,
    30,
  );
  assert.equal(
    (await tenantB.json() as { candidateLinkRetentionDays: number }).candidateLinkRetentionDays,
    90,
  );
});

test("checklist replacement route rejects stale snapshots, active claims, and passed gates", async () => {
  const role = `route-policy-role-${suffix}`;
  const gateId = `route-policy-gate-${process.pid}`;
  const headers = {
    "content-type": "application/json",
    "x-test-user": "test-user-a",
    "x-organization-id": orgA,
  };
  const profileResponse = await fetch(`${baseUrl}/onboarding/checklist-profiles`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Route policy profile",
      criteria: { role },
      overrides: [{
        id: gateId,
        label: "Route policy gate",
        order: LEGACY_CHECKLIST.length,
        enabled: true,
        mandatory: true,
        enforcementStage: "before-workstreams",
      }],
      priority: 25,
      enabled: true,
    }),
  });
  assert.equal(profileResponse.status, 201);

  const [policyCase] = await db.insert(onbCases).values({
    organizationId: orgA,
    workerName: "Checklist Route Guard",
    workerEmail: `checklist-route-${suffix}@example.com`,
    hireType: "external",
    workerCategory: "full-time",
    role,
    department: "Engineering",
    geography: "US",
    legalEntity: "Example",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    checklistTemplateVersion: 1,
    checklistSnapshot: [...LEGACY_CHECKLIST],
    checklistProfileId: "default",
    checklistProfileName: "Organization default",
    checklistProfileVersion: 1,
    checklistMatchedCriteria: {},
    checklistMatchExplanation: "Organization default selected.",
    readiness: readinessFromChecklist(LEGACY_CHECKLIST),
    workforceContext: { workCountry: "US" },
  }).returning({ id: onbCases.id });
  await grantOpaqueNarrativeAuthority(policyCase.id);

  const replace = (body: Record<string, unknown>) =>
    fetch(`${baseUrl}/onboarding/cases/${policyCase.id}/checklist-profile`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const expectedSnapshot = {
    expectedChecklistTemplateVersion: 1,
    expectedChecklistProfileId: "default",
    expectedChecklistProfileVersion: 1,
  };

  const stale = await replace({
    action: "recalculate",
    ...expectedSnapshot,
    expectedChecklistTemplateVersion: 2,
  });
  assert.equal(stale.status, 409);
  assert.match(
    (await stale.json() as { message: string }).message,
    /changed since it was loaded/i,
  );

  await db.update(onbCases).set({
    lifecycleStage: "preboarding",
    orchestrationStatus: "running",
    orchestrationCheckpoint: "initial",
    orchestrationClaimOwner: "route-test-claim",
    orchestrationClaimUntil: new Date(Date.now() + 60_000),
  }).where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, policyCase.id)));
  const claimed = await replace({
    action: "replace-active",
    reason: "Route-level active claim regression",
    ...expectedSnapshot,
  });
  assert.equal(claimed.status, 409);
  assert.match(
    (await claimed.json() as { message: string }).message,
    /active orchestration claim/i,
  );

  await db.update(onbCases).set({
    orchestrationStatus: "idle",
    orchestrationCheckpoint: "workstreams-complete",
    orchestrationClaimOwner: null,
    orchestrationClaimUntil: null,
  }).where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, policyCase.id)));
  const [beforeCorrection] = await db.select({ updatedAt: onbCases.updatedAt })
    .from(onbCases).where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, policyCase.id)));
  const correction = await fetch(`${baseUrl}/onboarding/cases/${policyCase.id}/workforce-context`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      expectedUpdatedAt: beforeCorrection.updatedAt.toISOString(),
      reason: "Correct post-workstream office context.",
      workforceContext: { workCountry: "US", workEnvironment: "office", siteExposure: false, safetyCritical: false },
    }),
  });
  assert.equal(correction.status, 200);
  const [afterCorrection] = await db.select({
    orchestrationStatus: onbCases.orchestrationStatus,
    orchestrationCheckpoint: onbCases.orchestrationCheckpoint,
  }).from(onbCases).where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, policyCase.id)));
  assert.equal(afterCorrection.orchestrationStatus, "checklist-blocked");
  assert.equal(afterCorrection.orchestrationCheckpoint, "workstreams-complete");
  const passedGate = await replace({
    action: "replace-active",
    reason: "Route-level passed gate regression",
    ...expectedSnapshot,
  });
  assert.equal(passedGate.status, 409);
  assert.match(
    (await passedGate.json() as { message: string }).message,
    /execution boundary/i,
  );

  await db.update(onbCases).set({ lifecycleStage: "complete" })
    .where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, policyCase.id)));
  const completedLegacyReplacement = await replace({
    action: "replace-active",
    reason: "Completed legacy replacement regression",
    ...expectedSnapshot,
  });
  assert.equal(completedLegacyReplacement.status, 409);
  assert.match((await completedLegacyReplacement.json() as { message: string }).message, /execution boundary/i);
  const [completedCase] = await db.select({
    updatedAt: onbCases.updatedAt,
    orchestrationCheckpoint: onbCases.orchestrationCheckpoint,
  }).from(onbCases).where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, policyCase.id)));
  const terminalCorrection = await fetch(`${baseUrl}/onboarding/cases/${policyCase.id}/workforce-context`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      expectedUpdatedAt: completedCase.updatedAt.toISOString(),
      reason: "Attempt to alter completed legacy context.",
      workforceContext: { workCountry: "US", workEnvironment: "office", siteExposure: false, safetyCritical: false },
    }),
  });
  assert.equal(terminalCorrection.status, 409);
  assert.equal(
    (await db.select({ checkpoint: onbCases.orchestrationCheckpoint }).from(onbCases)
      .where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, policyCase.id))))[0]?.checkpoint,
    completedCase.orchestrationCheckpoint,
  );

  const [unchanged] = await db.select({
    profileId: onbCases.checklistProfileId,
    templateVersion: onbCases.checklistTemplateVersion,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, policyCase.id),
  ));
  assert.deepEqual(unchanged, { profileId: "default", templateVersion: 1 });
});

test("a checklist profile replacement holds the lifecycle fence from its successful gate through persistence", async () => {
  const role = `lifecycle-fenced-profile-${suffix}`;
  const headers = {
    "content-type": "application/json",
    "x-test-user": "test-user-a",
    "x-organization-id": orgA,
  };
  const createdProfile = await fetch(`${baseUrl}/onboarding/checklist-profiles`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `Lifecycle fenced profile ${suffix}`,
      criteria: { role },
      overrides: [{
        id: `lifecycle-fenced-gate-${suffix}`,
        label: "Lifecycle fenced profile gate",
        order: LEGACY_CHECKLIST.length,
        enabled: true,
        mandatory: true,
        enforcementStage: "before-workstreams",
      }],
      priority: 40,
      enabled: true,
    }),
  });
  assert.equal(createdProfile.status, 201);
  const [caseRow] = await db.insert(onbCases).values({
    organizationId: orgA,
    workerName: "Lifecycle-fenced profile replacement",
    workerEmail: `lifecycle-profile-${suffix}@example.com`,
    hireType: "external",
    workerCategory: "full-time",
    role,
    department: "Engineering",
    geography: "US",
    legalEntity: "Example",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    checklistTemplateVersion: 1,
    checklistSnapshot: [...LEGACY_CHECKLIST],
    checklistProfileId: "default",
    checklistProfileName: "Organization default",
    checklistProfileVersion: 1,
    checklistMatchedCriteria: {},
    checklistMatchExplanation: "Organization default selected.",
    readiness: readinessFromChecklist(LEGACY_CHECKLIST),
    workforceContext: { workCountry: "US" },
  }).returning({ id: onbCases.id });
  const [currentPolicy] = await db.select().from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, orgA),
    eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-document"),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, "US"),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
  ));
  assert.ok(currentPolicy);

  let releaseGate!: () => void;
  let gatePassed!: () => void;
  const waitForRelease = new Promise<void>((resolve) => { releaseGate = resolve; });
  const gatePassedPromise = new Promise<void>((resolve) => { gatePassed = resolve; });
  setAfterSensitiveLifecycleGateHookForTests(async (mutation) => {
    if (mutation !== "checklist-profile-replacement") return;
    gatePassed();
    await waitForRelease;
  });

  let policyChanged = false;
  let replacement: Promise<Response> | undefined;
  try {
    replacement = fetch(`${baseUrl}/onboarding/cases/${caseRow!.id}/checklist-profile`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "recalculate",
        expectedChecklistTemplateVersion: 1,
        expectedChecklistProfileId: "default",
        expectedChecklistProfileVersion: 1,
      }),
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const gateOutcome = await Promise.race([
      gatePassedPromise.then(() => ({ kind: "gate" as const })),
      replacement.then(
        (response) => ({ kind: "response" as const, status: response.status }),
        (error) => ({ kind: "error" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), 5_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    assert.equal(
      gateOutcome.kind,
      "gate",
      gateOutcome.kind === "response"
        ? `Checklist replacement completed with HTTP ${gateOutcome.status} before the lifecycle gate hook.`
        : gateOutcome.kind === "error"
          ? `Checklist replacement rejected before the lifecycle gate hook: ${String(gateOutcome.error)}`
          : "Checklist replacement did not reach the lifecycle gate hook within five seconds.",
    );
    // The policy write is launched by the test's independent async context, so
    // it cannot inherit the route's re-entrant lifecycle fence.
    const policyChange = saveSensitiveLifecyclePolicy({
      organizationId: orgA,
      actorUserId: "test-user-a",
      policy: {
        dataClass: "candidate-document", jurisdiction: "US",
        purpose: currentPolicy.purpose, lawfulBasis: currentPolicy.lawfulBasis,
        retentionDays: currentPolicy.retentionDays + 1,
        providerSharingApproved: false, permittedProviders: [],
        policyReference: currentPolicy.policyReference,
        approvalReference: currentPolicy.approvalReference,
        expectedRevision: currentPolicy.revision,
      },
    }).then(() => { policyChanged = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(policyChanged, false, "policy change must wait after the profile gate passes");
    releaseGate();
    assert.equal((await replacement).status, 200);
    await policyChange;
    assert.equal(policyChanged, true);
  } finally {
    setAfterSensitiveLifecycleGateHookForTests(undefined);
    releaseGate?.();
    await replacement?.catch(() => undefined);
  }
});

test("policy mutations fence durable dispatch markers and a winning correction blocks stale recovery", async () => {
  const headers = {
    "content-type": "application/json",
    "x-test-user": "test-user-a",
    "x-organization-id": orgA,
  };
  const readyChecklist = readinessFromChecklist(LEGACY_CHECKLIST).map((item) => ({
    ...item,
    status: "ready" as const,
  }));
  const [policyCase] = await db.insert(onbCases).values({
    organizationId: orgA,
    workerName: "Dispatch Mutation Fence",
    workerEmail: `dispatch-fence-${suffix}@example.com`,
    hireType: "external",
    workerCategory: "full-time",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Example",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    checklistTemplateVersion: 1,
    checklistSnapshot: [...LEGACY_CHECKLIST],
    checklistProfileId: "default",
    checklistProfileName: "Organization default",
    checklistProfileVersion: 1,
    checklistMatchedCriteria: {},
    checklistMatchExplanation: "Organization default selected.",
    readiness: readyChecklist,
    workforceContext: {
      workCountry: "US",
      workEnvironment: "office",
      siteExposure: false,
      safetyCritical: false,
    },
    workforceContextVersion: 1,
  }).returning();
  await grantOpaqueNarrativeAuthority(policyCase.id);
  const replace = () => fetch(
    `${baseUrl}/onboarding/cases/${policyCase.id}/checklist-profile`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "recalculate",
        expectedChecklistTemplateVersion: 1,
        expectedChecklistProfileId: "default",
        expectedChecklistProfileVersion: 1,
      }),
    },
  );
  const correct = (expectedUpdatedAt: string) => fetch(
    `${baseUrl}/onboarding/cases/${policyCase.id}/workforce-context`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedUpdatedAt,
        reason: "Correct the captured office work context.",
        workforceContext: {
          workCountry: "US",
          workEnvironment: "remote",
          siteExposure: false,
          safetyCritical: false,
        },
      }),
    },
  );

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const enteredDispatch = new Promise<void>((resolve) => { entered = resolve; });
  const dispatch = withCaseDispatchGuard(policyCase.id, async () => {
    entered();
    await held;
  });
  await enteredDispatch;

  const [beforeRefusedMutations] = await db.select({
    updatedAt: onbCases.updatedAt,
    workforceContext: onbCases.workforceContext,
    workforceContextVersion: onbCases.workforceContextVersion,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, policyCase.id),
  ));
  const [blockedCorrection, blockedRebase] = await Promise.all([
    correct(beforeRefusedMutations.updatedAt.toISOString()),
    replace(),
  ]);
  assert.equal(blockedCorrection.status, 409);
  assert.match(
    (await blockedCorrection.json() as { message: string }).message,
    /active provider dispatch marker/i,
  );
  assert.equal(blockedRebase.status, 409);
  assert.match(
    (await blockedRebase.json() as { message: string }).message,
    /active provider dispatch marker/i,
  );
  const [unchangedWhileDispatching] = await db.select({
    workforceContext: onbCases.workforceContext,
    workforceContextVersion: onbCases.workforceContextVersion,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, policyCase.id),
  ));
  assert.deepEqual(unchangedWhileDispatching, {
    workforceContext: beforeRefusedMutations.workforceContext,
    workforceContextVersion: beforeRefusedMutations.workforceContextVersion,
  });

  release();
  await dispatch;

  // Capture a still-policy-open row, then let correction win. The subsequent
  // recovery call receives the stale object but must re-read under the same
  // dispatch fence and observe the new before-workstreams review blocker.
  const [staleRecoveryCase] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, policyCase.id),
  ));
  const correction = await correct(staleRecoveryCase.updatedAt.toISOString());
  assert.equal(correction.status, 200);
  let writes = 0;
  await dispatchWorkstreamConnectorMutations(staleRecoveryCase, {
    write: async () => { writes += 1; },
  });
  assert.equal(writes, 0, "a correction that wins the mutation fence blocks stale recovery");
});

test("corrected new and batch-held cases rebase before explicit release", async () => {
  const headers = {
    "content-type": "application/json",
    "x-test-user": "test-user-a",
    "x-organization-id": orgA,
  };
  const correct = (caseId: number, expectedUpdatedAt: string) => fetch(
    `${baseUrl}/onboarding/cases/${caseId}/workforce-context`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedUpdatedAt,
        reason: "Correct the captured remote work arrangement.",
        workforceContext: {
          workCountry: "US",
          workEnvironment: "remote",
          siteExposure: false,
          safetyCritical: false,
        },
      }),
    },
  );
  const rebase = (caseId: number, c: {
    checklistTemplateVersion: number;
    checklistProfileId: string | null;
    checklistProfileVersion: number | null;
  }) => fetch(`${baseUrl}/onboarding/cases/${caseId}/checklist-profile`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "recalculate",
      expectedChecklistTemplateVersion: c.checklistTemplateVersion,
      expectedChecklistProfileId: c.checklistProfileId,
      expectedChecklistProfileVersion: c.checklistProfileVersion ?? c.checklistTemplateVersion,
    }),
  });

  // A newly created manual case has no checkpoint. Correction adds the
  // explicit rebase gate, and that unexecuted state is intentionally eligible
  // for the normal audited rebase rather than active-checklist replacement.
  const [manual] = await db.insert(onbCases).values({
    organizationId: orgA,
    workerName: "Manual Corrected New Case",
    workerEmail: `manual-corrected-${suffix}@example.com`,
    hireType: "external",
    workerCategory: "full-time",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Example",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    checklistTemplateVersion: 1,
    checklistSnapshot: [...LEGACY_CHECKLIST],
    checklistProfileId: "default",
    checklistProfileName: "Organization default",
    checklistProfileVersion: 1,
    checklistMatchedCriteria: {},
    checklistMatchExplanation: "Organization default selected.",
    readiness: readinessFromChecklist(LEGACY_CHECKLIST),
    workforceContext: { workCountry: "US" },
    orchestrationStatus: "idle",
    lifecycleStage: "trigger-received",
  }).returning();
  await grantOpaqueNarrativeAuthority(manual.id);
  assert.equal((await correct(manual.id, manual.updatedAt.toISOString())).status, 200);
  const [manualCorrected] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, manual.id),
  ));
  assert.equal(manualCorrected.orchestrationStatus, "checklist-blocked");
  assert.equal(manualCorrected.orchestrationCheckpoint, null);
  assert.ok(manualCorrected.checklistSnapshot.some((item) => item.id === "policy-rebase-required"));
  assert.equal((await rebase(manual.id, manualCorrected)).status, 200);
  const [manualRebased] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, manual.id),
  ));
  assert.equal(manualRebased.orchestrationStatus, "idle");
  assert.equal(manualRebased.orchestrationCheckpoint, null);
  assert.equal(manualRebased.checklistSnapshot.some((item) => item.id === "policy-rebase-required"), false);

  const batchCreate = await fetch(`${baseUrl}/onboarding/batch-intake`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `Corrected batch ${suffix}`,
      idempotencyKey: `corrected-batch-${suffix}`,
      people: [{
        personKey: `corrected-batch-person-${suffix}`,
        workerName: "Batch Corrected Worker",
        workerEmail: `batch-corrected-${suffix}@example.com`,
        hireType: "external",
        workerCategory: "full-time",
        role: "Engineer",
        // Finance causes the ordinary plan approval pause before any LLM or
        // connector boundary, keeping this release-path regression isolated.
        department: "Finance",
        geography: "US",
        legalEntity: "Example",
        managerName: "Manager",
        recruiterName: "Recruiter",
        joiningDate: "2030-01-01",
        workforceContext: {
          workCountry: "US",
          workEnvironment: "office",
          siteExposure: false,
          safetyCritical: false,
        },
      }],
    }),
  });
  assert.equal(batchCreate.status, 201);
  const created = await batchCreate.json() as {
    batchId: string;
    results: Array<{ caseId: number }>;
  };
  const batchId = created.batchId;
  const batchCaseId = created.results[0]!.caseId;
  await grantOpaqueNarrativeAuthority(batchCaseId);
  const [batchCase] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, batchCaseId),
  ));
  assert.equal(batchCase.orchestrationStatus, "batch-intake-pending-review");
  assert.equal((await correct(batchCaseId, batchCase.updatedAt.toISOString())).status, 200);
  const [correctedBatch] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, batchCaseId),
  ));
  assert.equal(correctedBatch.orchestrationStatus, "batch-intake-pending-review");
  assert.ok(correctedBatch.checklistSnapshot.some((item) => item.id === "policy-rebase-required"));

  const heldRelease = await fetch(
    `${baseUrl}/onboarding/batch-intake/${batchId}/cases/${batchCaseId}/release`,
    { method: "POST", headers },
  );
  assert.equal(heldRelease.status, 409);
  assert.match(
    (await heldRelease.json() as { message: string }).message,
    /rebase.*policy before explicit release/i,
  );
  const noDispatchBeforeRelease = await db.select({
    key: onbEffectJournal.logicalOperationKey,
  }).from(onbEffectJournal).where(and(
    eq(onbEffectJournal.organizationId, orgA),
    eq(onbEffectJournal.caseId, batchCaseId),
  ));
  assert.equal(noDispatchBeforeRelease.length, 0);

  assert.equal((await rebase(batchCaseId, correctedBatch)).status, 200);
  const [rebasedBatch] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, batchCaseId),
  ));
  assert.equal(rebasedBatch.orchestrationStatus, "batch-intake-pending-review");
  assert.equal(rebasedBatch.checklistSnapshot.some((item) => item.id === "policy-rebase-required"), false);

  const released = await fetch(
    `${baseUrl}/onboarding/batch-intake/${batchId}/cases/${batchCaseId}/release`,
    { method: "POST", headers },
  );
  assert.equal(released.status, 200);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const [current] = await db.select({
      status: onbCases.orchestrationStatus,
      checkpoint: onbCases.orchestrationCheckpoint,
      claimOwner: onbCases.orchestrationClaimOwner,
    }).from(onbCases).where(and(
      eq(onbCases.organizationId, orgA),
      eq(onbCases.id, batchCaseId),
    ));
    if (
      current.checkpoint &&
      current.status !== "batch-intake-pending-review" &&
      current.status !== "running" &&
      current.claimOwner === null
    ) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const [orchestrated] = await db.select({
    status: onbCases.orchestrationStatus,
    checkpoint: onbCases.orchestrationCheckpoint,
    claimOwner: onbCases.orchestrationClaimOwner,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, batchCaseId),
  ));
  assert.equal(orchestrated.status, "waiting-approval");
  assert.equal(orchestrated.checkpoint, "waiting:plan", "explicit release starts the ordinary orchestration path");
  assert.equal(orchestrated.claimOwner, null);
});

test("another demo member cannot access an owner-bound historical scenario", async () => {
  const ownerUserId = `historical-owner-${suffix}`;
  const otherUserId = `historical-intruder-${suffix}`;
  await db.insert(organizationMembershipsTable).values([
    {
      organizationId: DEMO_ORGANIZATION_ID,
      clerkUserId: ownerUserId,
      role: "owner",
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      clerkUserId: otherUserId,
      role: "member",
    },
  ]);
  const [scenario] = await db.insert(scenariosTable).values({
    organizationId: DEMO_ORGANIZATION_ID,
    ownerUserId,
    name: "Historical private scenario",
    inputs: {
      numSystems: 4,
      annualTransactions: 120_000,
      employees: 8_000,
      sector: "manufacturing",
      companyType: "multi-country",
      isolationTier: "siloed",
      hrHourlyCostUsd: 38,
      hitlHourlyCostUsd: 42,
      countries: 6,
    },
  }).returning({ id: scenariosTable.id });

  try {
    const ownerResponse = await fetch(`${baseUrl}/scenarios/${scenario!.id}`, {
      headers: {
        "x-organization-id": DEMO_ORGANIZATION_ID,
        "x-test-user": ownerUserId,
      },
    });
    assert.equal(ownerResponse.status, 200);

    const otherListResponse = await fetch(`${baseUrl}/scenarios`, {
      headers: {
        "x-organization-id": DEMO_ORGANIZATION_ID,
        "x-test-user": otherUserId,
      },
    });
    assert.equal(otherListResponse.status, 200);
    const otherScenarios = await otherListResponse.json() as Array<{ id: number }>;
    assert.ok(otherScenarios.every(({ id }) => id !== scenario!.id));

    for (const attempt of [
      { method: "GET" },
      { method: "PATCH", body: JSON.stringify({ name: "stolen" }) },
      { method: "DELETE" },
    ]) {
      const response = await fetch(`${baseUrl}/scenarios/${scenario!.id}`, {
        method: attempt.method,
        headers: {
          "content-type": "application/json",
          "x-organization-id": DEMO_ORGANIZATION_ID,
          "x-test-user": otherUserId,
        },
        body: attempt.body,
      });
      assert.equal(response.status, 404, attempt.method);
    }
    const [preserved] = await db
      .select({ name: scenariosTable.name })
      .from(scenariosTable)
      .where(eq(scenariosTable.id, scenario!.id));
    assert.equal(preserved?.name, "Historical private scenario");
  } finally {
    await db.delete(scenariosTable).where(eq(scenariosTable.id, scenario!.id));
    await db
      .delete(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, ownerUserId),
      ));
    await db
      .delete(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, otherUserId),
      ));
  }
});

test("a former member cannot reach old uploads through another organization", async () => {
  const formerMember = `former-upload-member-${suffix}`;
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgA,
    clerkUserId: formerMember,
    role: "member",
  });
  const [scenario] = await db.insert(scenariosTable).values({
    organizationId: orgA,
    ownerUserId: formerMember,
    name: "Former member scenario",
    inputs: {},
  }).returning({ id: scenariosTable.id });
  const [file] = await db.insert(scenarioFilesTable).values({
    organizationId: orgA,
    ownerUserId: formerMember,
    scenarioId: scenario!.id,
    objectPath: `private/scenarios/${formerMember}/old-upload.txt`,
    originalName: "old-upload.txt",
    contentType: "text/plain",
    sizeBytes: 4,
  }).returning({ id: scenarioFilesTable.id });
  const contentIntentId = randomUUID();
  const finalizeIntentId = randomUUID();
  const contentObjectPath = scenarioUploadObjectPath(
    formerMember,
    contentIntentId,
  );
  const finalizeObjectPath = scenarioUploadObjectPath(
    formerMember,
    finalizeIntentId,
  );
  await db.insert(scenarioUploadIntentsTable).values([
    {
      id: contentIntentId,
      organizationId: orgA,
      ownerUserId: formerMember,
      objectPath: contentObjectPath,
      originalName: "content.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    },
    {
      id: finalizeIntentId,
      organizationId: orgA,
      ownerUserId: formerMember,
      objectPath: finalizeObjectPath,
      originalName: "finalize.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      status: "uploaded",
      expiresAt: new Date(Date.now() + 60_000),
    },
  ]);
  await db
    .delete(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, orgA),
      eq(organizationMembershipsTable.clerkUserId, formerMember),
    ));
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgB,
    clerkUserId: formerMember,
    role: "member",
  });

  try {
    const listResponse = await fetch(
      `${baseUrl}/scenarios/${scenario!.id}/files`,
      {
        headers: {
          "x-organization-id": orgB,
          "x-test-user": formerMember,
        },
      },
    );
    assert.equal(listResponse.status, 404);

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(
        `${baseUrl}/scenario-files/${file!.id}${method === "GET" ? "/download" : ""}`,
        {
          method,
          headers: {
            "x-organization-id": orgB,
            "x-test-user": formerMember,
          },
        },
      );
      assert.equal(response.status, 404, method);
    }

    const contentResponse = await fetch(
      `${baseUrl}/scenario-files/upload-intents/${contentIntentId}/content`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-organization-id": orgB,
          "x-test-user": formerMember,
        },
        body: "test",
      },
    );
    assert.equal(contentResponse.status, 409);

    const finalizeResponse = await fetch(
      `${baseUrl}/scenario-files/finalize`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-organization-id": orgB,
          "x-test-user": formerMember,
        },
        body: JSON.stringify({
          objectPath: finalizeObjectPath,
          name: "finalize.txt",
          contentType: "text/plain",
          size: 4,
        }),
      },
    );
    assert.equal(finalizeResponse.status, 409);

    const [preserved] = await db
      .select({ id: scenarioFilesTable.id })
      .from(scenarioFilesTable)
      .where(eq(scenarioFilesTable.id, file!.id));
    assert.equal(preserved?.id, file!.id);
  } finally {
    await db
      .delete(scenarioUploadIntentsTable)
      .where(eq(scenarioUploadIntentsTable.id, contentIntentId));
    await db
      .delete(scenarioUploadIntentsTable)
      .where(eq(scenarioUploadIntentsTable.id, finalizeIntentId));
    await db.delete(scenarioFilesTable).where(eq(scenarioFilesTable.id, file!.id));
    await db.delete(scenariosTable).where(eq(scenariosTable.id, scenario!.id));
    await db
      .delete(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, orgB),
        eq(organizationMembershipsTable.clerkUserId, formerMember),
      ));
  }
});
