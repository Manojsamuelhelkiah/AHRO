import { deleteTestOrganizations, requireOwnedOrganizationTestSchema } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbApprovals,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCases,
  onbCommunications,
  onbConnectors,
  onbDocuments,
  onbEffectJournal,
  onbGovernanceDecisions,
  onbGovernanceDecisionReviews,
  onbGovernanceDispatchMarkers,
  onbGovernanceAuthorityAssignments,
  onbGovernanceRequirements,
  onbReadinessSlaAttestations,
  onbReadinessSlaCaseState,
  onbReadinessSlaPolicies,
  onbPolicyAuthorities,
  onbSensitiveLifecyclePolicies,
  organizationMembershipsTable,
  onbSettings,
  onbSystemChecks,
  organizationsTable,
  accessSecurityGroups,
  accessSecurityGroupPolicies,
  accessSecurityGroupUserGroups,
  accessSecurityGroupAttachments,
  accessUserGroups,
  accessUserGroupMembers,
} from "@workspace/db";
import onboardingRouter from "../../routes/onboarding";
import {
  initializeLearningWorkforceStepTasks,
  OPERATIONAL_REQUEST_SETTING_PREFIX,
  reconcileWorkforceConnectorContinuation,
  recoverWorkforceConnectorContinuations,
  WORKFORCE_CONTINUATION_SETTING_PREFIX,
} from "./operational-requests";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";
import { recordHumanPermissionDecision } from "../human-permissions";
import { SENSITIVE_DATA_CLASSES } from "./sensitive-lifecycle";
import {
  governanceSnapshotForNewCase,
  withGovernanceDecisionSnapshot,
  type GovernanceCaseSnapshot,
} from "./governance-runtime";
import { EXECUTION_AUTHORIZATION_RULES } from "./decision-authority";
import { dispatchWorkstreamConnectorMutations } from "./workstream-connectors";
import { runWorkstreams } from "./engine";
import { ensureReadinessSlaEnrollment } from "./readiness-sla-policy";
import {
  changeStandardOperationsStartDate,
  getStandardOperationsView,
  reconcileStandardOperationsStartDateImpact,
} from "./standard-operations";

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `operational-a-${suffix}`;
const orgB = `operational-b-${suffix}`;
const user = `operational-user-${suffix}`;
const accessOwner = `operational-access-owner-${suffix}`;
let baseUrl: string;
let server: Server;
let caseA: number;
let caseB: number;
let offlineCase: number;
let workforceCase: number;
let allNonblockingCase: number;
let officeNoSiteCase: number;
let liveGovernanceSnapshot: GovernanceCaseSnapshot;
const unrelatedSpecialist = `unrelated-${suffix}`;
const payrollUserGroupId = `operational-payroll-users-${suffix}`;
const payrollSecurityGroupId = `operational-payroll-access-${suffix}`;

function caseValues(organizationId: string, name: string, notes: string | null = null) {
  return {
    organizationId,
    createdByUserId: user,
    workerName: name,
    workerEmail: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Example",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    workforceContext: { workCountry: "US" },
    notes,
    // A released rule-generated plan is the entry boundary for these domain
    // task tests. Pending acceptance/intake belongs to gateway tests.
    offerAcceptanceComplete: true,
    lifecycleStage: "plan-generated",
    orchestrationStatus: "checklist-blocked",
    orchestrationCheckpoint: "blocked:before-workstreams",
    readiness: [
      { key: "access", label: "Access", status: "pending" },
      { key: "assets", label: "Assets", status: "pending" },
    ],
    workstreams: [],
  };
}

async function establishLiveGovernanceFixture(
  organizationId: string,
): Promise<GovernanceCaseSnapshot> {
  await governanceSnapshotForNewCase(organizationId);
  const decisions = await db.select().from(onbGovernanceDecisions).where(
    eq(onbGovernanceDecisions.organizationId, organizationId),
  );
  for (const decision of decisions) {
    const reviewer = `operational-fixture:${decision.accountableRole}`;
    await db.insert(organizationMembershipsTable).values({ organizationId, clerkUserId: reviewer, role: "admin" }).onConflictDoNothing();
    const authority = await db.transaction(tx => recordHumanPermissionDecision(tx, {
      organizationId, actorUserId: reviewer, requiredKeys: ["tool.policy.manage"],
      decision: "explicit-policy-review", reviewedRevision: decision.revision,
    }));
    await db.insert(onbGovernanceDecisionReviews).values({
      organizationId,
      decisionKey: decision.key,
      decisionRevision: decision.revision,
      outcome: "approved",
      reason: "Operational request fixture approved decision",
      authorityAssignmentId: authority!.id,
      reviewedByUserId: reviewer,
      verificationReference: reviewer,
    });
    await db.update(onbGovernanceDecisions).set({
      status: "approved",
      approvedByUserId: reviewer,
      approvedAt: new Date(),
    }).where(and(
      eq(onbGovernanceDecisions.organizationId, organizationId),
      eq(onbGovernanceDecisions.key, decision.key),
      eq(onbGovernanceDecisions.revision, decision.revision),
    ));
  }
  await db.update(onbGovernanceRequirements).set({
    implemented: true,
    tested: true,
    configured: true,
    approvedForLive: true,
  }).where(eq(onbGovernanceRequirements.organizationId, organizationId));
  for (const key of ["bgv", "itsm", "payroll"]) {
    await db.insert(onbConnectors).values({
      organizationId,
      key,
      label: key,
      vendor: "operational-fixture-live",
      availableVendors: ["operational-fixture-live"],
      status: "connected",
      trackingMode: "api",
      description: "Fixture configured live provider",
      authoritativeFor: [key],
      lastSyncAt: new Date(),
      configurationProvenance: "trusted-provider",
    }).onConflictDoUpdate({
      target: [onbConnectors.organizationId, onbConnectors.key],
      set: {
        status: "connected",
        lastSyncAt: new Date(),
        configurationProvenance: "trusted-provider",
      },
    });
  }
  return governanceSnapshotForNewCase(organizationId);
}

async function seedCurrentExecutionApprovals(caseId: number): Promise<void> {
  await db.insert(onbAuthorityGovernance).values({
    organizationId: orgA,
    status: "governance-approved",
    approvedByUserId: "operational-fixture",
    approvedAt: new Date(),
    governanceSource: "fixture",
    revision: 1,
  }).onConflictDoUpdate({
    target: onbAuthorityGovernance.organizationId,
    set: { status: "governance-approved", revision: 1, updatedAt: new Date() },
  });
  const operationAuthorities = [
    ["documents", "legal", "legal-approve"],
    ["background-verification", "hr-compliance", "hr-compliance-approve"],
    ["iam", "it-security", "it-security-approve"],
    ["payroll", "payroll", "payroll-approve"],
  ] as const;
  for (const [connector, authorityRole, authorityScope] of operationAuthorities) {
    const reviewer = `operational-${connector}-reviewer`;
    const authorityId = `operational-${connector}-${caseId}`;
    await db.insert(organizationMembershipsTable).values({
      organizationId: orgA,
      clerkUserId: reviewer,
      role: "admin",
    }).onConflictDoNothing();
    await db.insert(onbAuthorityAssignments).values({
      id: authorityId,
      organizationId: orgA,
      personUserId: reviewer,
      authorityRole,
      scopes: [authorityScope],
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60_000),
      status: "active",
      revision: 1,
      grantorUserId: "operational-fixture",
      source: "fixture",
      governanceDecisionRef: "OPERATIONAL-FIXTURE",
    });
    const [approval] = await db.insert(onbApprovals).values({
      organizationId: orgA,
      caseId,
      agent: "workstreams",
      ruleRef: EXECUTION_AUTHORIZATION_RULES[connector],
      hitlPattern: "approve-before-act",
      recommendation: "Fixture-approved provider execution",
      rationale: "Current scoped authority approved this fixture execution.",
      resumeAction: "continue-after-plan",
      status: "approved",
      authorityScope,
      decidedAuthorityId: authorityId,
      decidedAuthorityRevision: 1,
      idempotencyKey: `orchestration:${caseId}:approval:execution:${connector}`,
    }).returning();
    const decision = await db.transaction(tx => recordHumanPermissionDecision(tx, {
      organizationId: orgA, caseId, actorUserId: reviewer, requiredKeys: ["tool.approval.decide", "flow.case.edit"],
      decision: "approved", reviewedRevision: approval.version,
    }));
    await db.update(onbApprovals).set({
      decidedBy: reviewer, decidedAt: new Date(), decidedAuthorityId: `human-permission/v1:approval:${approval.id}`,
      decidedAuthorityRevision: approval.version, permissionDecision: decision.authorization,
    }).where(eq(onbApprovals.id, approval.id));
  }
  if (caseId !== caseA) {
    await db.insert(onbAuthorityAssignments).values({
      id: `operational-current-user-payroll-${caseId}`,
      organizationId: orgA,
      caseId,
      personUserId: user,
      authorityRole: "payroll",
      scopes: ["payroll-approve"],
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60_000),
      status: "active",
      revision: 1,
      grantorUserId: "operational-fixture",
      source: "fixture",
      governanceDecisionRef: "OPERATIONAL-FIXTURE",
    });
  }
}

async function seedTrustedAccessReleaseEvidence(caseId: number): Promise<void> {
  const [caseRow] = await db.select({ joiningDate: onbCases.joiningDate }).from(onbCases)
    .where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, caseId)));
  assert.ok(caseRow);
  await db.insert(onbSystemChecks).values({
    organizationId: orgA,
    caseId,
    system: "bgv",
    mode: "push",
    externalRef: `operational-fixture-bgv-${caseId}`,
    status: "done",
    dueAt: new Date(),
    completedAt: new Date(),
    lastCheckedAt: new Date(),
    evidenceProvenance: "trusted-provider",
  });
  await ensureReadinessSlaEnrollment(orgA, caseId, "operational-fixture");
  // Deliberately retain a known pre-change cutoff. The date-impact regression
  // below proves this old timing fact cannot replace payroll's reconciliation
  // decision after a start-date correction.
  await db.update(onbReadinessSlaCaseState).set({
    payrollCutoff: new Date("2030-01-01T00:00:00Z"),
  }).where(and(
    eq(onbReadinessSlaCaseState.organizationId, orgA),
    eq(onbReadinessSlaCaseState.caseId, caseId),
  ));
  await db.insert(onbReadinessSlaAttestations).values({
    organizationId: orgA,
    caseId,
    snapshotVersion: 1,
    streamKey: "hris",
    complete: true,
    reason: "Operational fixture HRIS source attestation",
    attestedBy: "operational-fixture",
    attestedRole: "hr-operations",
    evidenceProvenance: "trusted-provider",
    sourceStartDate: caseRow.joiningDate,
    sourceEvidenceRevision: `operational-fixture-oracle-${caseId}`,
  });
}

async function call(
  path: string,
  organizationId: string,
  init?: RequestInit,
  role = "owner",
) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-organization-id": organizationId,
      "x-test-user": user,
      "x-test-role": role,
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 409) console.info("Isolated fixture conflict:", path, await response.clone().text());
  return response;
}

before(async () => {
  await requireOwnedOrganizationTestSchema();
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Operational A", slug: orgA, joinCodeHash: `hash-${orgA}`, createdByUserId: user },
    { id: orgB, name: "Operational B", slug: orgB, joinCodeHash: `hash-${orgB}`, createdByUserId: user },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: user, role: "owner" },
    { organizationId: orgA, clerkUserId: accessOwner, role: "owner" },
    { organizationId: orgB, clerkUserId: user, role: "owner" },
    { organizationId: orgA, clerkUserId: unrelatedSpecialist, role: "member" },
  ]);
  await db.insert(accessUserGroups).values({
    id: payrollUserGroupId,
    organizationId: orgA,
    name: payrollUserGroupId,
    ownerUserId: accessOwner,
    createdByUserId: user,
  });
  await db.insert(accessSecurityGroups).values({
    id: payrollSecurityGroupId,
    organizationId: orgA,
    name: payrollSecurityGroupId,
    ownerUserId: accessOwner,
    createdByUserId: user,
  });
  await db.insert(accessUserGroupMembers).values({
    organizationId: orgA,
    groupId: payrollUserGroupId,
    principalType: "human",
    principalId: user,
    attachedByUserId: user,
    status: "active",
    requiresApproval: "yes",
    approvedByUserId: accessOwner,
    approvedAt: new Date(),
  });
  await db.insert(accessSecurityGroupUserGroups).values({
    organizationId: orgA,
    securityGroupId: payrollSecurityGroupId,
    userGroupId: payrollUserGroupId,
    attachedByUserId: user,
    requiresApproval: "yes",
    approvedByUserId: accessOwner,
    approvedAt: new Date(),
    approvedPolicyVersion: 1,
  });
  await db.insert(accessSecurityGroupPolicies).values({
    organizationId: orgA,
    securityGroupId: payrollSecurityGroupId,
    version: 1,
    policy: {
      fields: [
        "data.payroll.read", "data.payroll.edit",
        "data.case.profile.read", "data.case.profile.edit",
        "data.case.notes.read", "data.case.notes.edit",
      ],
      flows: ["flow.case.read", "flow.case.edit"],
      tools: ["tool.workflow.run", "tool.external.dispatch"],
    },
    createdByUserId: user,
    approvedByUserId: accessOwner,
    approvedAt: new Date(),
  });
  await db.insert(accessSecurityGroupAttachments).values({
    organizationId: orgA,
    securityGroupId: payrollSecurityGroupId,
    scope: "tenant",
    attachedByUserId: user,
    requiresApproval: "yes",
    approvedByUserId: accessOwner,
    approvedAt: new Date(),
    approvedPolicyVersion: 1,
  });
  liveGovernanceSnapshot = await establishLiveGovernanceFixture(orgA);
  await Promise.all([orgA, orgB].map(organizationId => seedApprovedSensitiveLifecyclePolicies(organizationId)));
  [caseA, caseB, offlineCase, workforceCase, allNonblockingCase, officeNoSiteCase] = (await db.insert(onbCases).values([
    caseValues(orgA, "Operational Alpha"),
    caseValues(orgB, "Operational Beta"),
    {
      ...caseValues(orgA, "Offline Sample", SYNTHETIC_OFFLINE_MARKER),
      syntheticProvenance: "synthetic-reset",
    },
    {
      ...caseValues(orgA, "Workforce Human"),
      joiningDate: "2020-01-02",
      offerAcceptanceComplete: true,
      readiness: [
        { key: "profile", label: "Profile", status: "ready" },
        { key: "documentation", label: "Documentation", status: "pending" },
        { key: "learning", label: "Learning", status: "pending" },
        { key: "checkpoints", label: "Checkpoints", status: "pending" },
        { key: "payroll", label: "Payroll", status: "pending" },
        { key: "access", label: "Access", status: "pending" },
        { key: "assets", label: "Assets", status: "pending" },
      ],
      workstreams: [],
      checklistSnapshot: [{
        id: "connector-dispatch-boundary",
        label: "Connector dispatch boundary",
        order: 0,
        enabled: true,
        mandatory: false,
        enforcementStage: "before-workstreams",
      }],
      workforceContext: { workCountry: "US", site: "test-site" },
      processPolicySnapshot: withGovernanceDecisionSnapshot({
        processPolicy: {
          semanticsVersion: 2,
          learning: {
            schemaVersion: "workforce-step-runtime/v1",
            ownership: "L&D",
            channel: "manager-led",
            timing: { anchor: "joining-date", offsetDays: 0 },
            steps: [
              { id: "safety", label: "Safety induction", assignedTo: user },
              { id: "role", label: "Role induction", prerequisites: ["safety"] },
            ],
          },
        },
      }, liveGovernanceSnapshot),
    },
    {
      ...caseValues(orgA, "All Nonblocking"),
      workforceContext: { workCountry: "US", site: "test-site" },
      processPolicySnapshot: withGovernanceDecisionSnapshot({
        processPolicy: {
          semanticsVersion: 2,
          learning: {
            ownership: "L&D", channel: "manager-led",
            timing: { anchor: "joining-date", offsetDays: 0 },
            steps: [{ id: "optional-welcome", label: "Optional welcome", nonblocking: true }],
          },
        },
      }, liveGovernanceSnapshot),
    },
    {
      ...caseValues(orgA, "Office no site"),
      workforceContext: {
        workCountry: "US",
        workEnvironment: "office",
        siteExposure: false,
        safetyCritical: false,
      },
      processPolicySnapshot: withGovernanceDecisionSnapshot({
        processPolicy: {
          semanticsVersion: 2,
          learning: {
            ownership: "L&D", channel: "manager-led",
            timing: { anchor: "joining-date", offsetDays: 0 },
            steps: [
              { id: "named-office", label: "Named office induction", assignedTo: user },
              { id: "role-office", label: "Office role induction" },
            ],
          },
        },
      }, liveGovernanceSnapshot),
    },
  ]).returning({ id: onbCases.id })).map((row) => row.id);
  await db.insert(onbAuthorityGovernance).values({
    organizationId: orgA,
    status: "governance-approved",
    approvedByUserId: "operational-fixture",
    approvedAt: new Date(),
    governanceSource: "fixture",
    revision: 1,
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `operational-bootstrap-payroll-${caseA}`,
    organizationId: orgA,
    caseId: caseA,
    personUserId: user,
    authorityRole: "payroll",
    scopes: ["payroll-approve"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "operational-fixture",
    source: "fixture",
    governanceDecisionRef: "OPERATIONAL-FIXTURE",
  });
  await Promise.all([
    seedCurrentExecutionApprovals(workforceCase),
    seedCurrentExecutionApprovals(officeNoSiteCase),
    seedTrustedAccessReleaseEvidence(workforceCase),
    seedTrustedAccessReleaseEvidence(officeNoSiteCase),
  ]);
  await db.insert(onbPolicyAuthorities).values([
    { organizationId: orgA, userId: user, authorityRole: "l-d", caseId: workforceCase, itemId: "learning-role", site: "test-site", assignedBy: user },
    { organizationId: orgA, userId: user, authorityRole: "payroll-operations", caseId: workforceCase, itemId: "payroll-prerequisite", site: "test-site", assignedBy: user },
    { organizationId: orgA, userId: user, authorityRole: "payroll-operations", caseId: workforceCase, itemId: "payroll-setup", site: "test-site", assignedBy: user },
    { organizationId: orgA, userId: unrelatedSpecialist, authorityRole: "l-d", caseId: workforceCase, itemId: "learning-role", site: "wrong-site", assignedBy: user },
    { organizationId: orgA, userId: user, authorityRole: "l-d", caseId: officeNoSiteCase, itemId: "learning-role-office", site: "__organization__", assignedBy: user },
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = String(req.header("x-organization-id") ?? orgA);
    req.organizationRole = req.header("x-test-role") === "member" ? "member" : "owner";
    req.authUserId = String(req.header("x-test-user") ?? user);
    next();
  });
  app.use(onboardingRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof Error && error.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: String(error) });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test("lists every canonical internal operational simulation persona", async () => {
  const response = await call("/onboarding/agents", orgA);
  assert.equal(response.status, 200);
  const catalog = await response.json() as Array<{
    id: string;
    name: string;
    origin: string;
    description: string;
    owner: string;
    capabilities: string[];
    simulated: boolean;
  }>;
  assert.deepEqual(
    catalog.map((agent) => agent.id),
    ["documentation", "access", "assets", "payroll", "learning"],
  );
  assert.ok(catalog.every((agent) =>
    agent.name &&
    agent.description &&
    agent.owner &&
    agent.capabilities.length > 0 &&
    agent.origin === "internal" &&
    agent.simulated === true,
  ));
});

test("legacy stored requests remain readable with safe identity resolution", async () => {
  await db.insert(onbSettings).values({
    organizationId: orgB,
    key: `${OPERATIONAL_REQUEST_SETTING_PREFIX}${caseB}`,
    value: JSON.stringify({
      version: 1,
      requests: [
        {
          id: "access",
          label: "Legacy access request",
          owner: "IT / Security",
          agent: "access",
          teamRecipientLabel: "IT / Security team",
          method: "agent",
          status: "requested",
          reference: "SIMULATED-OPS-legacy-access",
          simulated: true,
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          blockedAt: null,
          lastRetryAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          failureReason: null,
          history: [{
            status: "requested",
            at: "2026-01-01T00:00:00.000Z",
            actor: "legacy-human",
            reason: null,
            requestId: null,
            communicationId: null,
          }],
        },
        {
          id: "retired",
          label: "Legacy unknown request",
          owner: "Unknown",
          agent: "retired-agent",
          teamRecipientLabel: "Unknown team",
          method: "agent",
          status: "requested",
          reference: "SIMULATED-OPS-legacy-retired",
          simulated: true,
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          blockedAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastRetryAt: null,
          failureReason: null,
          history: [{
            status: "requested",
            at: "2026-01-01T00:00:00.000Z",
            actor: "legacy-human",
            reason: null,
            requestId: null,
            communicationId: null,
          }],
        },
      ],
      initializationRequestIds: {},
    }),
  });
  const response = await call(
    `/onboarding/cases/${caseB}/operational-requests`,
    orgB,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    requests: Array<{
      id: string;
      agentIdentity?: { id: string; origin: string } | null;
      history: Array<{ actor: string; agentIdentity?: unknown }>;
    }>;
  };
  const known = body.requests.find((request) => request.id === "access")!;
  assert.deepEqual(known.agentIdentity, {
    id: "access",
    name: "IT Access & Identity Agent",
    origin: "internal",
    description:
      "Tracks access requirements and identity dependencies. Account provisioning requires a confirmed identity-provider result.",
    owner: "IT / Security",
    capabilities: [
      "Track access setup tasks",
      "Record identity dependencies",
      "Record access blockers",
    ],
    simulated: true,
  });
  assert.equal(known.history[0]!.actor, "legacy-human");
  assert.equal(known.history[0]!.agentIdentity, null);
  assert.equal(
    body.requests.find((request) => request.id === "retired")!.agentIdentity,
    null,
  );
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await db.delete(onbSettings).where(inArray(onbSettings.organizationId, [orgA, orgB]));
  await db.delete(onbPolicyAuthorities).where(inArray(onbPolicyAuthorities.organizationId, [orgA, orgB]));
  await db.delete(onbEffectJournal).where(inArray(onbEffectJournal.organizationId, [orgA, orgB]));
  await db.delete(onbReadinessSlaPolicies).where(inArray(onbReadinessSlaPolicies.organizationId, [orgA, orgB]));
  await db.delete(onbGovernanceDispatchMarkers).where(inArray(onbGovernanceDispatchMarkers.organizationId, [orgA, orgB]));
  await db.delete(onbGovernanceDecisionReviews).where(inArray(onbGovernanceDecisionReviews.organizationId, [orgA, orgB]));
  await db.delete(onbGovernanceAuthorityAssignments).where(inArray(onbGovernanceAuthorityAssignments.organizationId, [orgA, orgB]));
  await db.delete(onbGovernanceRequirements).where(inArray(onbGovernanceRequirements.organizationId, [orgA, orgB]));
  await db.delete(onbGovernanceDecisions).where(inArray(onbGovernanceDecisions.organizationId, [orgA, orgB]));
  await db.delete(onbAuthorityAssignments).where(inArray(onbAuthorityAssignments.organizationId, [orgA, orgB]));
  await db.delete(onbAuthorityGovernance).where(inArray(onbAuthorityGovernance.organizationId, [orgA, orgB]));
  await db.delete(onbSensitiveLifecyclePolicies).where(inArray(onbSensitiveLifecyclePolicies.organizationId, [orgA, orgB]));
  await db.delete(onbConnectors).where(inArray(onbConnectors.organizationId, [orgA, orgB]));
  await db.delete(onbCases).where(inArray(onbCases.id, [caseA, caseB, offlineCase, workforceCase, allNonblockingCase, officeNoSiteCase]));
  await deleteTestOrganizations(inArray(organizationsTable.id, [orgA, orgB]));
});

test("GET is read-only and initialization persists tenant-scoped simulated communications", async () => {
  const before = await call(`/onboarding/cases/${caseA}/operational-requests`, orgA);
  assert.equal(before.status, 200);
  assert.deepEqual((await before.json() as { requests: unknown[] }).requests, []);
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseA))).length,
    0,
  );

  const initialized = await call(`/onboarding/cases/${caseA}/operational-requests`, orgA, {
    method: "POST",
    body: JSON.stringify({ requestId: "initialize-1", method: "agent" }),
  });
  assert.equal(initialized.status, 200);
  const envelope = await initialized.json() as {
    version: number;
    simulated: boolean;
    requests: Array<{
      id: string;
      status: string;
      method: string;
      simulated: boolean;
      agentIdentity?: { id: string; name: string; origin: string; simulated: boolean } | null;
      history: Array<{ actor: string; agentIdentity?: { id: string; origin: string } | null }>;
    }>;
  };
  assert.equal(envelope.version, 1);
  assert.equal(envelope.simulated, true);
  assert.equal(envelope.requests.length, 5);
  assert.ok(envelope.requests.every((request) =>
    request.status === "requested" &&
    request.method === "agent" &&
    request.simulated === true &&
    request.agentIdentity?.id === request.id &&
    request.agentIdentity?.origin === "internal" &&
    request.agentIdentity?.simulated === true &&
    request.history.length === 1 &&
    request.history[0]?.actor === "system" &&
    request.history[0]?.agentIdentity?.id === request.id,
  ));
  const communications = await db.select().from(onbCommunications)
    .where(eq(onbCommunications.caseId, caseA));
  assert.equal(communications.length, 5);
  assert.ok(communications.every((row) =>
    row.status === "logged-only" &&
    row.channel === "agent" &&
    row.body.includes("[REQUEST RECORD") &&
    row.body.includes("no email was sent") &&
    row.body.includes("AI agent role:") &&
    row.body.includes("origin: internal"),
  ));
  assert.equal((await db.select().from(onbDocuments).where(eq(onbDocuments.caseId, caseA))).length, 0);
  assert.equal((await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.caseId, caseA))).length, 0);
  assert.equal((await db.select().from(onbApprovals).where(eq(onbApprovals.caseId, caseA))).length, 0);
  const repeatedInitialization = await call(
    `/onboarding/cases/${caseA}/operational-requests`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "initialize-1", method: "agent" }),
    },
  );
  assert.equal(repeatedInitialization.status, 200);
  assert.equal((await repeatedInitialization.json() as { idempotent: boolean }).idempotent, true);
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseA))).length,
    5,
  );
  const legacyRuntime = await initializeLearningWorkforceStepTasks({
    organizationId: orgA, caseId: caseA, actor: "orchestrator",
  });
  assert.equal(legacyRuntime.active, false);
  assert.equal(legacyRuntime.version, 1);
  assert.equal(legacyRuntime.initializedRequestIds.length, 0);
});

test("actions are fenced, idempotent, and do not mutate readiness", async () => {
  // Completing access is now a release assertion. Supply the same durable,
  // trusted provider facts and current scoped execution approval that the
  // production release guard requires, only after the initialization test has
  // verified that simulated request creation itself produces none of them.
  await db.update(onbCases).set({
    offerAcceptanceComplete: true,
  }).where(eq(onbCases.id, caseA));
  await Promise.all([
    seedCurrentExecutionApprovals(caseA),
    seedTrustedAccessReleaseEvidence(caseA),
  ]);
  const beforeCase = (await db.select().from(onbCases).where(eq(onbCases.id, caseA)))[0]!;
  const emailMethod = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "access-method-1",
        action: "select-method",
        method: "email",
        expectedVersion: 1,
      }),
    },
  );
  assert.equal(emailMethod.status, 200);

  const start = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "access-start-1", action: "start", expectedVersion: 2 }),
    },
  );
  assert.equal(start.status, 200);
  const repeatedStart = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "access-start-1", action: "start", expectedVersion: 2 }),
    },
  );
  assert.equal(repeatedStart.status, 200);
  assert.equal((await repeatedStart.json() as { idempotent: boolean }).idempotent, true);

  const progress = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "access-progress-1", action: "progress", reason: "Simulation in progress.", expectedVersion: 3 }),
    },
  );
  assert.equal(progress.status, 200);
  const completed = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "access-complete-1", action: "complete", expectedVersion: 4 }),
    },
  );
  assert.equal(completed.status, 200);

  const afterCase = (await db.select().from(onbCases).where(eq(onbCases.id, caseA)))[0]!;
  assert.deepEqual(afterCase.readiness, beforeCase.readiness);
  assert.deepEqual(afterCase.workstreams, beforeCase.workstreams);
  const emailCommunication = (await db.select().from(onbCommunications)
    .where(and(eq(onbCommunications.caseId, caseA), eq(onbCommunications.channel, "email"))))[0];
  assert.ok(emailCommunication);
  assert.ok(emailCommunication.toAddress.includes("responsible team; no delivery address"));
  assert.ok(emailCommunication.body.includes("no email was sent"));
  assert.ok(emailCommunication.body.includes("AI agent identity: none"));
  assert.ok(emailCommunication.body.includes("recipient label is not an AI agent"));
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseA))).length,
    9,
  );

  const stale = await call(
    `/onboarding/cases/${caseA}/operational-requests/documentation/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "assets-stale-1",
        action: "start",
        expectedVersion: 0,
      }),
    },
  );
  assert.equal(stale.status, 409);
  const malformed = await call(
    `/onboarding/cases/${caseA}/operational-requests/documentation/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "assets-malformed-1", action: "unknown", expectedVersion: 5 }),
    },
  );
  assert.equal(malformed.status, 400);
});

test("blocked requests retry without duplicating an identical request id", async () => {
  const blocked = await call(
    `/onboarding/cases/${caseA}/operational-requests/documentation/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "assets-block-1",
        action: "block",
        reason: "Simulation dependency unavailable.",
        expectedVersion: 5,
      }),
    },
  );
  assert.equal(blocked.status, 200);
  const beforeRetry = (await db.select().from(onbCommunications)
    .where(eq(onbCommunications.caseId, caseA))).length;
  const retry = await call(
    `/onboarding/cases/${caseA}/operational-requests/documentation/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "assets-retry-1", action: "retry", expectedVersion: 6 }),
    },
  );
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as { idempotent: boolean }).idempotent, false);
  const repeatedRetry = await call(
    `/onboarding/cases/${caseA}/operational-requests/documentation/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "assets-retry-1", action: "retry", expectedVersion: 6 }),
    },
  );
  assert.equal(repeatedRetry.status, 200);
  const repeatedRetryBody = await repeatedRetry.json() as {
    idempotent: boolean;
    requests: Array<{ id: string; status: string; failureReason: string | null }>;
  };
  assert.equal(repeatedRetryBody.idempotent, true);
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseA))).length,
    beforeRetry + 1,
  );
  const request = repeatedRetryBody.requests
    .find((candidate) => candidate.id === "documentation");
  assert.equal(request?.status, "requested");
  assert.equal(request?.failureReason, null);
});

test("requires integer action versions and serializes same-version simulated mutations", async () => {
  const missingVersion = await call(
    `/onboarding/cases/${caseA}/operational-requests/documentation/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "assets-missing-version", action: "start" }),
    },
  );
  assert.equal(missingVersion.status, 400);

  const current = await call(`/onboarding/cases/${caseA}/operational-requests`, orgA);
  const currentVersion = (await current.json() as { version: number }).version;
  const fractionalVersion = await call(
    `/onboarding/cases/${caseA}/operational-requests/documentation/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "assets-fractional-version",
        action: "start",
        expectedVersion: currentVersion + 0.5,
      }),
    },
  );
  assert.equal(fractionalVersion.status, 409);

  const before = (await db.select().from(onbCommunications)
    .where(eq(onbCommunications.caseId, caseA))).length;
  const [first, second] = await Promise.all([
    call(
      `/onboarding/cases/${caseA}/operational-requests/documentation/actions`,
      orgA,
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "assets-concurrent-a",
          action: "start",
          expectedVersion: currentVersion,
        }),
      },
    ),
    call(
      `/onboarding/cases/${caseA}/operational-requests/documentation/actions`,
      orgA,
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "assets-concurrent-b",
          action: "start",
          expectedVersion: currentVersion,
        }),
      },
    ),
  ]);
  assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [200, 409]);
  const after = await db.select().from(onbCommunications)
    .where(eq(onbCommunications.caseId, caseA));
  assert.equal(after.length, before + 1);
  assert.equal(
    after.filter((row) =>
      row.idempotencyKey === "operational:" + caseA + ":documentation:action:assets-concurrent-a" ||
      row.idempotencyKey === "operational:" + caseA + ":documentation:action:assets-concurrent-b",
    ).length,
    1,
  );
  const assetsCommunication = after.find((row) =>
    row.idempotencyKey === "operational:" + caseA + ":documentation:action:assets-concurrent-a" ||
    row.idempotencyKey === "operational:" + caseA + ":documentation:action:assets-concurrent-b",
  )!;
  assert.match(assetsCommunication.body, /AI agent role: .*id: documentation.*invocation not confirmed/);
  assert.match(assetsCommunication.body, /origin: internal/);
  const assetsRead = await call(
    `/onboarding/cases/${caseA}/operational-requests`,
    orgA,
  );
  const assetsRequest = (await assetsRead.json() as {
    requests: Array<{
      id: string;
      history: Array<{ actor: string; agentIdentity?: { id: string; origin: string } | null }>;
    }>;
  }).requests.find((request) => request.id === "documentation")!;
  const latestAssetsHistory = assetsRequest.history.at(-1)!;
  assert.equal(latestAssetsHistory.actor, user);
  assert.deepEqual(latestAssetsHistory.agentIdentity, {
    id: "documentation",
    name: "Documentation & Compliance Agent",
    origin: "internal",
    description:
      "Tracks documentation requirements, missing inputs and compliance reviews. Source verification and submission require separate authorized processes.",
    owner: "HR Ops",
    capabilities: [
      "Track documentation setup tasks",
      "Identify missing inputs",
      "Record compliance blockers",
    ],
    simulated: true,
  });
});

test("learning policy tasks are human-owned, evidence-gated, ordered, and hold readiness", async () => {
  // Exercise the actual workstream stage rather than constructing an
  // artificial workstream array: it persists open asset/learning blockers
  // before later accountable payroll completion dispatches.
  await runWorkstreams(workforceCase);
  // Payroll timing was initially evidenced for the original start date.
  // Changing that date while the human workforce tasks are still pending
  // must create a stream-specific payroll reconciliation hold, not a
  // whole-plan connector deny-list.
  await changeStandardOperationsStartDate({
    organizationId: orgA,
    caseId: workforceCase,
    startDate: "2020-01-16",
    expectedVersion: 0,
    actorUserId: user,
  });
  const initializedResponse = await call(
    `/onboarding/cases/${workforceCase}/operational-requests`,
    orgA,
  );
  assert.equal(initializedResponse.status, 200);
  const initialized = await initializedResponse.json() as {
    version: number;
    simulated: boolean;
    requests: Array<{ id: string }>;
  };
  assert.equal(initialized.simulated, false);
  assert.deepEqual(initialized.requests.map((request) => request.id).filter((id) =>
    ["learning-safety", "learning-role", "payroll-prerequisite", "payroll-setup", "assets-confirmation"].includes(id),
  ), [
    "learning-safety", "learning-role", "payroll-prerequisite", "payroll-setup", "assets-confirmation",
  ]);
  const [afterWorkstreamInitialization] = await db.select().from(onbCases)
    .where(eq(onbCases.id, workforceCase));
  assert.equal(afterWorkstreamInitialization.workstreams.find((workstream) => workstream.key === "assets")?.status, "in-progress");
  assert.equal(afterWorkstreamInitialization.workstreams.find((workstream) => workstream.key === "learning")?.status, "in-progress");
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, workforceCase))).length,
    2,
  );
  // First v2 dispatch has a persisted incomplete payroll task set. The
  // guarded batch still reaches unrelated document/BGV/IAM writers, while
  // payroll is held without any provider call.
  const [beforePayrollEvidence] = await db.select().from(onbCases)
    .where(eq(onbCases.id, workforceCase));
  await dispatchWorkstreamConnectorMutations(beforePayrollEvidence);
  assert.ok((await db.select().from(onbDocuments).where(eq(onbDocuments.caseId, workforceCase))).length > 0);
  assert.deepEqual(
    (await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.caseId, workforceCase)))
      .map((check) => check.system).sort(),
    ["bgv", "itsm"],
  );
  const unauthorizedNamed = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/learning-safety/actions`,
    orgA,
    { method: "POST", headers: { "x-test-user": unrelatedSpecialist, "x-test-role": "member" }, body: JSON.stringify({
      requestId: "wrong-specialist", action: "start", expectedVersion: initialized.version,
    }) },
    "member",
  );
  assert.equal(unauthorizedNamed.status, 403);
  const wrongSiteRole = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/learning-role/actions`,
    orgA,
    { method: "POST", headers: { "x-test-user": unrelatedSpecialist, "x-test-role": "member" }, body: JSON.stringify({
      requestId: "wrong-site-specialist", action: "start", expectedVersion: initialized.version,
    }) },
    "member",
  );
  assert.equal(wrongSiteRole.status, 403);
  const blockedByPrerequisite = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/learning-role/actions`,
    orgA,
    { method: "POST", body: JSON.stringify({
      requestId: "role-before-safety", action: "start", expectedVersion: initialized.version,
    }) },
  );
  assert.equal(blockedByPrerequisite.status, 409);
  const started = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/learning-safety/actions`,
    orgA,
    { method: "POST", body: JSON.stringify({
      requestId: "safety-start", action: "start", expectedVersion: initialized.version,
    }) },
  );
  assert.equal(started.status, 200);
  const missingEvidence = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/learning-safety/actions`,
    orgA,
    { method: "POST", body: JSON.stringify({
      requestId: "safety-no-evidence", action: "complete", expectedVersion: initialized.version + 1,
    }) },
  );
  assert.equal(missingEvidence.status, 409);
  const completed = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/learning-safety/actions`,
    orgA,
    { method: "POST", body: JSON.stringify({
      requestId: "safety-complete", action: "complete", reason: "Signed induction record", expectedVersion: initialized.version + 1,
    }) },
  );
  assert.equal(completed.status, 200);
  const startedRole = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/learning-role/actions`,
    orgA,
    { method: "POST", body: JSON.stringify({
      requestId: "role-start", action: "start", expectedVersion: initialized.version + 2,
    }) },
  );
  assert.equal(startedRole.status, 200);
  const completedRole = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/learning-role/actions`,
    orgA,
    { method: "POST", body: JSON.stringify({
      requestId: "role-complete", action: "complete", reason: "Manager-led induction record", expectedVersion: initialized.version + 3,
    }) },
  );
  assert.equal(completedRole.status, 200);
  const updated = (await db.select().from(onbCases).where(eq(onbCases.id, workforceCase)))[0]!;
  assert.equal(updated.readiness.find((item) => item.key === "learning")?.status, "ready");
  assert.equal(updated.readiness.find((item) => item.key === "checkpoints")?.status, "ready");
  const payrollStart = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/payroll-prerequisite/actions`,
    orgA, { method: "POST", body: JSON.stringify({ requestId: "payroll-prerequisite-start", action: "start", expectedVersion: initialized.version + 4 }) },
  );
  assert.equal(payrollStart.status, 200);
  const payrollEvidence = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/payroll-prerequisite/actions`,
    orgA, { method: "POST", body: JSON.stringify({ requestId: "payroll-prerequisite-complete", action: "complete", reason: "Verified timesheet and pay details", expectedVersion: initialized.version + 5 }) },
  );
  assert.equal(payrollEvidence.status, 200);
  const payrollSetupStart = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/payroll-setup/actions`,
    orgA, { method: "POST", body: JSON.stringify({ requestId: "payroll-setup-start", action: "start", expectedVersion: initialized.version + 6 }) },
  );
  assert.equal(payrollSetupStart.status, 200);
  // Simulate an unrelated later checklist pause. Completing payroll must
  // still invoke the guarded dispatcher; it must not require replaying the
  // earlier workstream stage or bypass any before-workstreams gate.
  await db.update(onbCases).set({
    orchestrationStatus: "checklist-blocked",
    orchestrationCheckpoint: "blocked:before-employee-communications",
  }).where(eq(onbCases.id, workforceCase));
  const payrollSetupComplete = await call(
    `/onboarding/cases/${workforceCase}/operational-requests/payroll-setup/actions`,
    orgA, { method: "POST", body: JSON.stringify({ requestId: "payroll-setup-complete", action: "complete", reason: "Payroll setup reviewed by accountable specialist", expectedVersion: initialized.version + 7 }) },
  );
  assert.equal(payrollSetupComplete.status, 200);
  const payrollUpdated = (await db.select().from(onbCases).where(eq(onbCases.id, workforceCase)))[0]!;
  assert.equal(payrollUpdated.orchestrationCheckpoint, "waiting:standard-operations-release");
  assert.deepEqual(
    (await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.caseId, workforceCase)))
      .map((check) => check.system).sort(),
    ["bgv", "itsm"],
  );
  const dateHeldContinuationKey = `${WORKFORCE_CONTINUATION_SETTING_PREFIX}${workforceCase}:payroll-setup-complete`;
  assert.ok((await db.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, orgA),
    eq(onbSettings.key, dateHeldContinuationKey),
  )))[0]);

  await reconcileStandardOperationsStartDateImpact({
    organizationId: orgA,
    caseId: workforceCase,
    stream: "payroll",
    resolution: "manual-resolution",
    expectedVersion: 1,
    actorUserId: user,
  });
  await recoverWorkforceConnectorContinuations();
  assert.deepEqual(
    (await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.caseId, workforceCase)))
      .map((check) => check.system).sort(),
    ["bgv", "itsm", "payroll"],
  );
  assert.equal((await db.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, orgA),
    eq(onbSettings.key, dateHeldContinuationKey),
  ))).length, 0);
});

test("provider refusal leaves a durable workforce continuation for retry", async () => {
  const requestId = `provider-refusal-${suffix}`;
  const key = `${WORKFORCE_CONTINUATION_SETTING_PREFIX}${workforceCase}:${requestId}`;
  await assert.rejects(
    reconcileWorkforceConnectorContinuation({
      organizationId: orgA,
      caseId: workforceCase,
      requestId,
      dependencies: {
        dispatch: async () => {
          throw new Error("Payroll provider refused the submission");
        },
        resume: async () => undefined,
      },
    }),
    /Payroll provider refused/,
  );
  const [pending] = await db.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, orgA),
    eq(onbSettings.key, key),
  ));
  assert.match(pending?.value ?? "", /"status":"pending"/);
  await recoverWorkforceConnectorContinuations();
  // Recovery uses the real guarded dispatch and clears the durable item after
  // the provider refusal has ceased; it does not re-run or invalidate the
  // already committed human task evidence.
  assert.equal((await db.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, orgA),
    eq(onbSettings.key, key),
  ))).length, 0);
});

test("all-nonblocking persisted v2 learning tasks do not create a false readiness blocker", async () => {
  const initialized = await initializeLearningWorkforceStepTasks({
    organizationId: orgA, caseId: allNonblockingCase, actor: "orchestrator",
  });
  assert.equal(initialized.active, true);
  assert.deepEqual(initialized.initializedRequestIds, ["learning-optional-welcome", "payroll-prerequisite", "payroll-setup", "assets-confirmation"]);
  assert.equal(initialized.workstreamBlockingComplete.learning, true);
});

test("confirmed office context without a site permits named and organization-scoped authorities", async () => {
  const initialized = await initializeLearningWorkforceStepTasks({
    organizationId: orgA, caseId: officeNoSiteCase, actor: "orchestrator",
  });
  const action = (taskId: string, requestId: string, actionName: "start" | "complete", version: number, reason?: string) =>
    call(`/onboarding/cases/${officeNoSiteCase}/operational-requests/${taskId}/actions`, orgA, {
      method: "POST",
      body: JSON.stringify({ requestId, action: actionName, expectedVersion: version, ...(reason ? { reason } : {}) }),
    });
  assert.equal((await action("learning-named-office", "office-named-start", "start", initialized.version)).status, 200);
  assert.equal((await action("learning-named-office", "office-named-complete", "complete", initialized.version + 1, "Manager-led office induction record")).status, 200);
  assert.equal((await action("learning-role-office", "office-role-start", "start", initialized.version + 2)).status, 200);
  assert.equal((await action("learning-role-office", "office-role-complete", "complete", initialized.version + 3, "Accountable office induction record")).status, 200);
});

test("date reconciliation cannot reuse stale HRIS activation evidence for access release", async () => {
  await db.update(onbCases).set({ offerAcceptanceComplete: true }).where(eq(onbCases.id, officeNoSiteCase));
  await changeStandardOperationsStartDate({
    organizationId: orgA,
    caseId: officeNoSiteCase,
    startDate: "2030-02-01",
    expectedVersion: 0,
    actorUserId: user,
  });
  for (const [index, stream] of (["hris", "provisioning", "payroll", "benefits", "schedules"] as const).entries()) {
    await reconcileStandardOperationsStartDateImpact({
      organizationId: orgA,
      caseId: officeNoSiteCase,
      stream,
      resolution: "manual-resolution",
      expectedVersion: index + 1,
      actorUserId: user,
    });
  }

  const stale = await getStandardOperationsView(orgA, officeNoSiteCase);
  assert.equal(stale.startDateImpacts.every((impact) => impact.status === "manual-resolution"), true);
  assert.equal(stale.release.access.eligible, false);
  assert.match(stale.release.access.blockers.join(" "), /authoritative HRIS activation/);

  await db.insert(onbReadinessSlaAttestations).values({
    organizationId: orgA,
    caseId: officeNoSiteCase,
    snapshotVersion: 1,
    streamKey: "hris",
    complete: true,
    evidenceProvenance: "trusted-provider",
    sourceStartDate: "2030-02-01",
    sourceEvidenceRevision: `fresh-oracle-receipt-${officeNoSiteCase}`,
    reason: "Fresh Oracle HCM source receipt matched the corrected effective date.",
    attestedBy: "server-oracle-hcm-classifier",
    attestedRole: "system",
  });
  const refreshed = await getStandardOperationsView(orgA, officeNoSiteCase);
  assert.equal(refreshed.release.access.eligible, true, refreshed.release.access.blockers.join("; "));
  assert.equal(refreshed.release.assets.eligible, true, refreshed.release.assets.blockers.join("; "));
});

test("tenant and offline fences apply to reads and mutations", async () => {
  const crossTenant = await call(`/onboarding/cases/${caseA}/operational-requests`, orgB);
  assert.equal(crossTenant.status, 404);
  const crossTenantAction = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgB,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "cross-tenant-1", action: "start", expectedVersion: 0 }),
    },
  );
  assert.equal(crossTenantAction.status, 404);

  const offlineRead = await call(`/onboarding/cases/${offlineCase}/operational-requests`, orgA);
  assert.equal(offlineRead.status, 200);
  assert.equal((await offlineRead.json() as { offlinePaused: boolean }).offlinePaused, true);
  const offlineMutation = await call(`/onboarding/cases/${offlineCase}/operational-requests`, orgA, {
    method: "POST",
    body: JSON.stringify({ requestId: "offline-1" }),
  });
  assert.equal(offlineMutation.status, 409);
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, offlineCase))).length,
    0,
  );
});
