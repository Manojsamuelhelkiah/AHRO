import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import express from "express";
import { RetiredCaseCapabilityError } from "../lib/retired-case-capabilities";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  DEMO_ORGANIZATION_ID,
  db,
  accessNamedGrants,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbActionCenterActions,
  onbApprovals,
  onbCandidateUploads,
  onbCases,
  onbCommunications,
  onbConnectors,
  onbDocuments,
  onbEffectJournal,
  onbEvents,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisionReviews,
  onbGovernanceDecisions,
  onbGovernanceDispatchMarkers,
  onbGovernanceHistory,
  onbGovernanceReminders,
  onbGovernanceRequirements,
  onbSettings,
  onbSensitiveLifecyclePolicies,
  onbSystemChecks,
  organizationMembershipsTable,
  organizationsTable,
  accessSecurityGroups,
  accessSecurityGroupPolicies,
  accessSecurityGroupUserGroups,
  accessSecurityGroupAttachments,
  accessUserGroups,
  accessUserGroupMembers,
} from "@workspace/db";
import { ReplitConnectors } from "@replit/connectors-sdk";
import actionCenterRouter from "./action-center";
import { createRequireAuth } from "../middlewares/require-auth";
import {
  createTenantContextMiddleware,
  lookupMembership,
} from "../middlewares/tenant-context";
import {
  ActionCenterConflictError,
  ActionCenterOfflineError,
  ActionCenterPermissionError,
  getActionCenter,
  recordDocumentReminder,
  recordManualCallOutcome,
  recordWorkItem,
} from "../lib/onboarding/action-center";
import {
  ACTION_CENTER_IDENTITIES_KEY,
  ActionCenterIdentityConflictError,
  type ActionCenterIdentityRole,
  type ActionCenterMailboxType,
  getActionCenterIdentities,
  updateActionCenterIdentities,
} from "../lib/onboarding/action-center-identities";
import {
  isSyntheticOfflineCase,
  SYNTHETIC_OFFLINE_MARKER,
} from "../lib/onboarding/synthetic-offline";
import { setOnboardingConnectorProxyForTests } from "../lib/onboarding/channels";
import {
  governanceSnapshotForNewCase,
  withGovernanceDecisionSnapshot,
  type GovernanceCaseSnapshot,
} from "../lib/onboarding/governance-runtime";
import { SENSITIVE_DATA_CLASSES } from "../lib/onboarding/sensitive-lifecycle";
import { demoPrincipalSettingKey } from "../lib/demo-principal";

/**
 * This suite uses only test-owned organizations and cases.  The one Demo
 * Organization case is an isolated simulation fixture and is deleted by id in
 * teardown; no existing Demo settings or volunteer allowlist is changed.
 *
 * Cases are deliberately terminal/non-watchable.  They never enter the
 * orchestration or approval workflow while this suite is exercising the
 * Action Center projection and append-only ledger.
 */

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `action-center-a-${suffix}`;
const orgB = `action-center-b-${suffix}`;
const orgC = `action-center-c-${suffix}`;
const ownerA = `action-center-owner-a-${suffix}`;
const memberA = `action-center-member-a-${suffix}`;
const accessOwnerA = `action-center-access-owner-a-${suffix}`;
const ownerB = `action-center-owner-b-${suffix}`;
const offlineAccessUserGroupId = `action-center-offline-users-${suffix}`;
const offlineAccessSecurityGroupId = `action-center-offline-policy-${suffix}`;
const demoMember = `action-center-demo-member-${suffix}`;
const demoAdministrator = `action-center-demo-administrator-${suffix}`;
const demoReviewer = `action-center-demo-reviewer-${suffix}`;
const actorName = ownerA;
const actionCenterUserGroupId = `action-center-sensitive-users-${suffix}`;
const actionCenterSecurityGroupId = `action-center-sensitive-policy-${suffix}`;

let server: Server | undefined;
let baseUrl = "";
const caseIds: number[] = [];
const documentIds: number[] = [];
let safetyCriticalCaseId: number;
let syntheticDemoCaseId: number;
const organizationIds = [orgA, orgB, orgC];
let liveGovernanceSnapshot: GovernanceCaseSnapshot | undefined;

type JsonRecord = Record<string, any>;
type IdentityInputMap = Record<
  ActionCenterIdentityRole,
  { name: string | null; mailboxType: ActionCenterMailboxType }
>;

function caseValues(organizationId: string, options: {
  name: string;
  email?: string;
  notes?: string | null;
  syntheticProvenance?: "synthetic-reset" | null;
  candidateAuthorized?: boolean;
  workforceContext?: { siteExposure?: boolean; safetyCritical?: boolean };
  workforceClassification?: {
    label: "white-collar" | "blue-collar-frontline" | "mixed" | "needs-review";
    source: "deterministic-job-context" | "authorized-correction";
    rationale: string;
    confidence: "high" | "medium" | "uncertain";
  };
}): typeof onbCases.$inferInsert {
  return {
    organizationId,
    workerName: options.name,
    workerEmail: options.email ?? `${options.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}@fake-provider.mailhost.com`,
    channelPreference: "email",
    hireType: "external",
    workerCategory: "full-time",
    role: "Regression Engineer",
    department: "Quality",
    geography: "US",
    legalEntity: "Action Center Regression Co",
    managerName: "Regression Manager",
    recruiterName: "Regression Recruiter",
    joiningDate: "2099-01-01",
    // Terminal cases keep background workers and approval transitions out of
    // this test fixture while remaining valid Action Center records.
    lifecycleStage: "complete",
    orchestrationStatus: "idle",
    notes: options.notes ?? null,
    syntheticProvenance: options.syntheticProvenance ?? null,
    candidateEmailAuthorizedAt: options.candidateAuthorized ? new Date() : null,
    candidateEmailAuthorizedBy: options.candidateAuthorized ? actorName : null,
    readiness: [],
    workstreams: [],
    checklistSnapshot: [],
    processPolicySnapshot: organizationId === orgA && liveGovernanceSnapshot
      ? withGovernanceDecisionSnapshot({}, liveGovernanceSnapshot)
      : undefined,
    workforceContext: options.workforceContext ?? { workCountry: "US" },
    workforceClassification: options.workforceClassification ?? null,
  };
}

async function establishLiveProviderGovernance(organizationId: string): Promise<GovernanceCaseSnapshot> {
  await governanceSnapshotForNewCase(organizationId);
  const decisions = await db.select().from(onbGovernanceDecisions).where(
    eq(onbGovernanceDecisions.organizationId, organizationId),
  );
  for (const decision of decisions) {
    const reviewer = `action-center-fixture:${decision.accountableRole}`;
    const [authority] = await db.insert(onbGovernanceAuthorityAssignments).values({
      organizationId,
      authorityRole: decision.accountableRole,
      assigneeUserId: reviewer,
      verificationStatus: "verified",
      verifiedByUserId: "action-center-fixture",
      verificationReference: reviewer,
    }).returning({ id: onbGovernanceAuthorityAssignments.id });
    await db.insert(onbGovernanceDecisionReviews).values({
      organizationId,
      decisionKey: decision.key,
      decisionRevision: decision.revision,
      outcome: "approved",
      reason: "Action Center fixture approved decision",
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
  return governanceSnapshotForNewCase(organizationId);
}

async function createCase(
  organizationId: string,
  options: Parameters<typeof caseValues>[1],
): Promise<number> {
  const [row] = await db.insert(onbCases).values(caseValues(organizationId, options)).returning({
    id: onbCases.id,
  });
  assert.ok(row);
  caseIds.push(row.id);
  return row.id;
}

async function createDocument(
  organizationId: string,
  caseId: number,
  options: {
    key: string;
    status?: string;
    note?: string | null;
    required?: boolean;
    updatedAt?: Date;
    reminderCount?: number;
    reminderNextAt?: Date | null;
  },
): Promise<number> {
  const [row] = await db.insert(onbDocuments).values({
    organizationId,
    caseId,
    key: options.key,
    label: options.key,
    category: "statutory",
    status: options.status ?? "pending",
    required: options.required ?? true,
    note: options.note ?? null,
    updatedAt: options.updatedAt ?? new Date(Date.now() - 2 * 86_400_000),
    reminderCount: options.reminderCount ?? 0,
    reminderNextAt: options.reminderNextAt ?? null,
  }).returning({ id: onbDocuments.id });
  assert.ok(row);
  documentIds.push(row.id);
  return row.id;
}

async function createValidationUpload(
  organizationId: string,
  caseId: number,
  documentId: number,
  validationState: string,
): Promise<number> {
  const [row] = await db.insert(onbCandidateUploads).values({
    organizationId,
    caseId,
    documentId,
    objectPath: `action-center/${suffix}/${randomUUID()}.pdf`,
    originalName: "regression-fixture.pdf",
    contentType: "application/pdf",
    sizeBytes: 4,
    validationState,
  }).returning({ id: onbCandidateUploads.id });
  assert.ok(row);
  return row.id;
}

async function request(
  path: string,
  options: RequestInit = {},
  context: {
    userId?: string | null;
    organizationId?: string | null;
  } = {},
): Promise<{ response: Response; body: unknown }> {
  const organizationHeader =
    context.organizationId === undefined ? orgA : context.organizationId;
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-test-user": context.userId ?? ownerA,
      ...(organizationHeader ? { "x-organization-id": organizationHeader } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Keep non-JSON error bodies available to the assertion.
    }
  }
  return { response, body };
}

function bodyRecord(value: unknown): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonRecord;
}

function identityInput(
  overrides: Partial<IdentityInputMap> = {},
): IdentityInputMap {
  const empty: IdentityInputMap[ActionCenterIdentityRole] = {
    name: null,
    mailboxType: "not-configured",
  };
  return {
    hr: { ...empty, ...overrides.hr },
    bgvTeam: { ...empty, ...overrides.bgvTeam },
    recruiter: { ...empty, ...overrides.recruiter },
    hiringManager: { ...empty, ...overrides.hiringManager },
    compliance: { ...empty, ...overrides.compliance },
  };
}

async function insertCommunicationRows(caseId: number, organizationId: string): Promise<void> {
  await db.insert(onbCommunications).values([
    ["simulated", "[SIMULATED] Simulated notice"],
    ["logged-only", "Not sent notice"],
    ["logged-only", "[SIMULATED] Legacy simulated notice"],
    ["sent", "Sent notice"],
    ["delivered", "Delivered notice"],
    ["confirmed", "Confirmed notice"],
    ["sending", "Sending notice"],
    ["failed", "Failed notice"],
    ["blocked", "Blocked notice"],
    ["unknown_effect_manual_repair", "Manual repair notice"],
  ].map(([status, subject]) => ({
    organizationId,
    caseId,
    channel: "email",
    direction: "outbound",
    audience: "candidate",
    toAddress: "masked@example.test",
    subject,
    body: `${subject} body`,
    status,
  })));
}

before(async () => {
  await db.insert(organizationsTable).values([
    {
      id: orgA,
      name: "Action Center Regression A",
      slug: orgA,
      joinCodeHash: `hash-${orgA}`,
      createdByUserId: ownerA,
    },
    {
      id: orgB,
      name: "Action Center Regression B",
      slug: orgB,
      joinCodeHash: `hash-${orgB}`,
      createdByUserId: ownerB,
    },
    {
      id: orgC,
      name: "Action Center Regression C",
      slug: orgC,
      joinCodeHash: `hash-${orgC}`,
      createdByUserId: ownerA,
    },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: ownerA, role: "owner" },
    { organizationId: orgA, clerkUserId: accessOwnerA, role: "owner" },
    { organizationId: orgC, clerkUserId: ownerA, role: "owner" },
    { organizationId: orgA, clerkUserId: memberA, role: "member" },
    { organizationId: orgB, clerkUserId: ownerB, role: "owner" },
    { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: demoMember, role: "member" },
    { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: demoAdministrator, role: "member" },
    { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: demoReviewer, role: "member" },
  ]);
  await db.insert(accessUserGroups).values({
    id: actionCenterUserGroupId,
    organizationId: orgA,
    name: actionCenterUserGroupId,
    ownerUserId: accessOwnerA,
    createdByUserId: ownerA,
  });
  await db.insert(accessSecurityGroups).values({
    id: actionCenterSecurityGroupId,
    organizationId: orgA,
    name: actionCenterSecurityGroupId,
    ownerUserId: accessOwnerA,
    createdByUserId: ownerA,
  });
  await db.insert(accessUserGroupMembers).values([ownerA, memberA].map((principalId) => ({
    organizationId: orgA,
    groupId: actionCenterUserGroupId,
    principalType: "human" as const,
    principalId,
    status: "active" as const,
    requiresApproval: "yes" as const,
    attachedByUserId: ownerA,
    approvedByUserId: accessOwnerA,
    approvedAt: new Date(),
  })));
  await db.insert(accessSecurityGroupUserGroups).values({
    organizationId: orgA,
    securityGroupId: actionCenterSecurityGroupId,
    userGroupId: actionCenterUserGroupId,
    attachedByUserId: ownerA,
    requiresApproval: "yes",
    approvedByUserId: accessOwnerA,
    approvedAt: new Date(),
    approvedPolicyVersion: 1,
  });
  await db.insert(accessSecurityGroupPolicies).values({
    organizationId: orgA,
    securityGroupId: actionCenterSecurityGroupId,
    version: 1,
    policy: {
      fields: ["identity", "medical", "payroll", "bgv"].flatMap((dataClass) => [
        `data.${dataClass}.read`, `data.${dataClass}.edit`,
      ]).concat([
        "data.case.profile.read",
        "data.case.profile.edit",
        "data.case.notes.read",
        "data.case.notes.edit",
        "data.case.readiness.read",
        "data.case.readiness.edit",
      ]),
      flows: ["flow.case.read", "flow.case.edit"],
      tools: ["tool.documents.edit", "tool.notification.send"],
    },
    createdByUserId: ownerA,
    approvedByUserId: accessOwnerA,
    approvedAt: new Date(),
  });
  await db.insert(accessSecurityGroupAttachments).values({
    organizationId: orgA,
    securityGroupId: actionCenterSecurityGroupId,
    scope: "tenant",
    attachedByUserId: ownerA,
    requiresApproval: "yes",
    approvedByUserId: accessOwnerA,
    approvedAt: new Date(),
    approvedPolicyVersion: 1,
  });
  await db.insert(accessUserGroups).values({
    id: offlineAccessUserGroupId,
    organizationId: orgB,
    name: offlineAccessUserGroupId,
    ownerUserId: ownerB,
    createdByUserId: ownerB,
  });
  await db.insert(accessSecurityGroups).values({
    id: offlineAccessSecurityGroupId,
    organizationId: orgB,
    name: offlineAccessSecurityGroupId,
    ownerUserId: ownerB,
    createdByUserId: ownerB,
  });
  await db.insert(accessUserGroupMembers).values({
    organizationId: orgB,
    groupId: offlineAccessUserGroupId,
    principalType: "human",
    principalId: ownerB,
    attachedByUserId: ownerB,
  });
  await db.insert(accessSecurityGroupUserGroups).values({
    organizationId: orgB,
    securityGroupId: offlineAccessSecurityGroupId,
    userGroupId: offlineAccessUserGroupId,
    attachedByUserId: ownerB,
  });
  await db.insert(accessSecurityGroupPolicies).values({
    organizationId: orgB,
    securityGroupId: offlineAccessSecurityGroupId,
    version: 1,
    policy: {
      fields: [
        "data.case.profile.read", "data.case.profile.edit",
        "data.case.notes.read", "data.case.notes.edit",
      ],
      flows: ["flow.case.read", "flow.case.edit"],
      tools: [],
    },
    createdByUserId: ownerB,
  });
  await db.insert(accessSecurityGroupAttachments).values({
    organizationId: orgB,
    securityGroupId: offlineAccessSecurityGroupId,
    scope: "tenant",
    attachedByUserId: ownerB,
  });
  await db.insert(onbSettings).values([
    {
      organizationId: DEMO_ORGANIZATION_ID,
      key: demoPrincipalSettingKey(demoAdministrator),
      value: "administrator",
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      key: demoPrincipalSettingKey(demoReviewer),
      value: "reviewer",
    },
  ]);
  await db.insert(onbAuthorityGovernance).values({
    organizationId: orgA,
    status: "governance-approved",
    approvedByUserId: "test-governance",
    approvedAt: new Date(),
    governanceSource: "test",
  });
  await db.insert(onbAuthorityAssignments).values([
    {
      id: `action-center-hr-${suffix}`,
      organizationId: orgA,
      personUserId: ownerA,
      authorityRole: "hr-compliance",
      scopes: ["hr-compliance-approve"],
      validFrom: new Date(Date.now() - 60_000),
      grantorUserId: "test-governance",
      source: "test",
      governanceDecisionRef: "test-governance",
    },
    {
      id: `action-center-medical-${suffix}`,
      organizationId: orgA,
      personUserId: ownerA,
      authorityRole: "occupational-health",
      scopes: ["occupational-health-approve"],
      validFrom: new Date(Date.now() - 60_000),
      grantorUserId: "test-governance",
      source: "test",
      governanceDecisionRef: "test-governance",
    },
    {
      id: `action-center-payroll-${suffix}`,
      organizationId: orgA,
      personUserId: ownerA,
      authorityRole: "payroll",
      scopes: ["payroll-approve"],
      validFrom: new Date(Date.now() - 60_000),
      grantorUserId: "test-governance",
      source: "test",
      governanceDecisionRef: "test-governance",
    },
  ]);
  // Live Action Center sends can retain opaque, case-derived copies at
  // several stages. Seed every class policy rather than approving only the
  // immediate contact class, so this positive fixture proves the all-class
  // lifecycle fence without bypassing it.
  await db.insert(onbSensitiveLifecyclePolicies).values(
    SENSITIVE_DATA_CLASSES.map((dataClass) => ({
      organizationId: orgA,
      dataClass,
      jurisdiction: "US",
      revision: 1,
      purpose: "candidate onboarding reminder",
      lawfulBasis: "employment onboarding",
      retentionDays: 30,
      providerSharingApproved: true,
      permittedProviders: ["gmail"],
      policyReference: `test-policy-${dataClass}`,
      approvalReference: `test-approval-${dataClass}`,
      approvedByUserId: ownerA,
      approvedAuthorityAssignmentId: 1,
    })),
  );
  liveGovernanceSnapshot = await establishLiveProviderGovernance(orgA);

  const liveCaseId = await createCase(orgA, {
    name: `Action Center Live ${suffix}`,
    email: `action-center-live-${suffix}@fake-provider.mailhost.com`,
    candidateAuthorized: true,
  });
  await createDocument(orgA, liveCaseId, {
    key: `pending-${suffix}`,
    updatedAt: new Date(Date.now() - 2 * 86_400_000),
  });

  // A due BGV notification and a not-yet-due operational check exercise the
  // latest/eligible projection without creating a watched orchestration case.
  await db.insert(onbSystemChecks).values([
    {
      organizationId: orgA,
      caseId: liveCaseId,
      system: "bgv",
      mode: "poll",
      externalRef: `BGV-${suffix}`,
      status: "overdue",
      dueAt: new Date(Date.now() - 60_000),
      note: "Action Center projection fixture",
    },
    {
      organizationId: orgA,
      caseId: liveCaseId,
      system: "hris",
      mode: "poll",
      externalRef: `HRIS-${suffix}`,
      status: "pending",
      dueAt: new Date(Date.now() + 86_400_000),
      note: "Future check must not project as due",
    },
  ]);
  await db.insert(onbApprovals).values({
    organizationId: orgA,
    caseId: liveCaseId,
    agent: "action-center-regression",
    ruleRef: "test-only",
    hitlPattern: "approve-before-act",
    recommendation: "Review fixture",
    rationale: "Read-only regression fixture",
    status: "pending",
  });
  await db.insert(onbEvents).values({
    organizationId: orgA,
    caseId: liveCaseId,
    agent: "action-center-regression",
    engine: "test",
    title: "Recorded exception fixture",
    detail: "Review this recorded exception.",
  });

  const offlineCaseId = await createCase(orgB, {
    name: `Action Center Offline ${suffix}`,
    email: `action-center-offline-${suffix}@example.test`,
    notes: SYNTHETIC_OFFLINE_MARKER,
    syntheticProvenance: "synthetic-reset",
  });
  await createDocument(orgB, offlineCaseId, {
    key: `offline-${suffix}`,
    updatedAt: new Date(Date.now() - 2 * 86_400_000),
  });

  // This case is only for Demo simulation and is always deleted by its exact
  // case id in teardown.  It does not touch the Demo settings table.
  const demoCaseId = await createCase(DEMO_ORGANIZATION_ID, {
    name: `Action Center Demo Simulation ${suffix}`,
    email: `action-center-demo-${suffix}@example.test`,
    candidateAuthorized: true,
  });
  await createDocument(DEMO_ORGANIZATION_ID, demoCaseId, {
    key: `demo-${suffix}`,
    updatedAt: new Date(Date.now() - 2 * 86_400_000),
  });
  syntheticDemoCaseId = await createCase(DEMO_ORGANIZATION_ID, {
    name: `Action Center Synthetic Demo ${suffix}`,
    email: `action-center-synthetic-demo-${suffix}@example.test`,
    notes: SYNTHETIC_OFFLINE_MARKER,
    syntheticProvenance: "synthetic-reset",
    candidateAuthorized: true,
    workforceContext: { siteExposure: true, safetyCritical: true },
  });
  await db.insert(accessNamedGrants).values([
    { resourceType: "flow" as const, resourceKey: "flow.case.read" },
    { resourceType: "flow" as const, resourceKey: "flow.case.edit" },
    { resourceType: "field" as const, resourceKey: "data.case.profile.read" },
    { resourceType: "field" as const, resourceKey: "data.case.notes.edit" },
  ].map((grant) => ({
    organizationId: DEMO_ORGANIZATION_ID,
    principalType: "human" as const,
    principalId: demoAdministrator,
    scope: "case" as const,
    caseId: syntheticDemoCaseId,
    source: "named" as const,
    effect: "allow" as const,
    createdByUserId: "action-center-test-fixture",
    ...grant,
  })));
  await db.insert(accessNamedGrants).values(
    ["flow.case.edit", "data.case.notes.edit"].map((resourceKey) => ({
      organizationId: DEMO_ORGANIZATION_ID,
      principalType: "human" as const,
      principalId: demoAdministrator,
      scope: "case" as const,
      caseId: caseIds[2]!,
      resourceType: resourceKey.startsWith("flow.") ? "flow" as const : "field" as const,
      resourceKey,
      source: "named" as const,
      effect: "allow" as const,
      createdByUserId: "action-center-test-fixture",
    })),
  );
  await createDocument(DEMO_ORGANIZATION_ID, syntheticDemoCaseId, {
    key: `synthetic-demo-${suffix}`,
    updatedAt: new Date(Date.now() - 2 * 86_400_000),
  });
  // Add after the legacy [live, offline, demo] fixture order. Several
  // regression cases intentionally address those original caseIds by index.
  safetyCriticalCaseId = await createCase(orgA, {
    name: `Action Center Safety ${suffix}`,
    email: `action-center-safety-${suffix}@example.test`,
    workforceContext: { siteExposure: true, safetyCritical: true },
    workforceClassification: {
      label: "blue-collar-frontline",
      source: "deterministic-job-context",
      rationale: "Explicit safety fixture",
      confidence: "high",
    },
  });
  await createDocument(orgA, safetyCriticalCaseId, {
    key: `safety-pending-${suffix}`,
    updatedAt: new Date(Date.now() - 2 * 86_400_000),
  });

  const app = express();
  app.use(express.json());
  const authenticate = createRequireAuth();
  app.use((req, res, next) => {
    const rawUser = req.header("x-test-user");
    const userId = rawUser === "unauthenticated" ? null : rawUser ?? ownerA;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    req.authUserId = userId ?? undefined;
    authenticate(req, res, next);
  });
  app.use(createTenantContextMiddleware(lookupMembership));
  app.use(actionCenterRouter);
  app.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof RetiredCaseCapabilityError) {
      res.status(410).json({ code: error.code, message: error.message });
      return;
    }
    res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server!.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  }
  // Child rows are deleted explicitly so this cleanup is safe even if a
  // database fixture has a historical non-cascading foreign key.
  await db.delete(accessNamedGrants).where(and(
    eq(accessNamedGrants.organizationId, DEMO_ORGANIZATION_ID),
    inArray(accessNamedGrants.caseId, [syntheticDemoCaseId, caseIds[2]!]),
  ));
  await db.delete(onbEffectJournal).where(
    inArray(onbEffectJournal.organizationId, organizationIds),
  );
  if (caseIds.length > 0) {
    await db.delete(onbActionCenterActions).where(inArray(onbActionCenterActions.caseId, caseIds));
    await db.delete(onbApprovals).where(inArray(onbApprovals.caseId, caseIds));
    await db.delete(onbCommunications).where(inArray(onbCommunications.caseId, caseIds));
    await db.delete(onbCandidateUploads).where(inArray(onbCandidateUploads.caseId, caseIds));
    await db.delete(onbDocuments).where(inArray(onbDocuments.caseId, caseIds));
    await db.delete(onbEvents).where(inArray(onbEvents.caseId, caseIds));
    await db.delete(onbSystemChecks).where(inArray(onbSystemChecks.caseId, caseIds));
    await db.delete(onbCases).where(inArray(onbCases.id, caseIds));
  }
  await db.delete(onbSettings).where(and(
    inArray(onbSettings.organizationId, organizationIds),
    eq(onbSettings.key, ACTION_CENTER_IDENTITIES_KEY),
  ));
  await db.delete(onbConnectors).where(inArray(onbConnectors.organizationId, organizationIds));
  // Lifecycle gates can append non-cascading governance evidence while this
  // suite exercises candidate-facing action paths.
  await db.delete(onbGovernanceDecisionReviews).where(
    inArray(onbGovernanceDecisionReviews.organizationId, organizationIds),
  );
  await db.delete(onbGovernanceReminders).where(
    inArray(onbGovernanceReminders.organizationId, organizationIds),
  );
  await db.delete(onbGovernanceRequirements).where(
    inArray(onbGovernanceRequirements.organizationId, organizationIds),
  );
  await db.delete(onbGovernanceHistory).where(
    inArray(onbGovernanceHistory.organizationId, organizationIds),
  );
  await db.delete(onbGovernanceDispatchMarkers).where(
    inArray(onbGovernanceDispatchMarkers.organizationId, organizationIds),
  );
  await db.delete(onbGovernanceAuthorityAssignments).where(
    inArray(onbGovernanceAuthorityAssignments.organizationId, organizationIds),
  );
  await db.delete(onbGovernanceDecisions).where(
    inArray(onbGovernanceDecisions.organizationId, organizationIds),
  );
  await db.delete(onbAuthorityAssignments).where(
    inArray(onbAuthorityAssignments.organizationId, organizationIds),
  );
  await db.delete(onbAuthorityGovernance).where(
    inArray(onbAuthorityGovernance.organizationId, organizationIds),
  );
  await db.delete(onbSensitiveLifecyclePolicies).where(
    inArray(onbSensitiveLifecyclePolicies.organizationId, organizationIds),
  );
  await db.delete(accessUserGroups).where(
    inArray(accessUserGroups.organizationId, organizationIds),
  );
  await db.delete(accessSecurityGroups).where(
    inArray(accessSecurityGroups.organizationId, organizationIds),
  );
  await db.delete(organizationMembershipsTable).where(
    inArray(organizationMembershipsTable.organizationId, organizationIds),
  );
  await db.delete(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
    inArray(organizationMembershipsTable.clerkUserId, [
      demoMember,
      demoAdministrator,
      demoReviewer,
    ]),
  ));
  await db.delete(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    inArray(onbSettings.key, [
      demoPrincipalSettingKey(demoAdministrator),
      demoPrincipalSettingKey(demoReviewer),
    ]),
  ));
  await deleteTestOrganizations(inArray(organizationsTable.id, organizationIds));
});

describe("Action Center focused regression suite", { concurrency: false }, () => {
  test("filters document followups and missing-document count by explicit safety facts, excluding unknown safety", async () => {
    const response = await request("/onboarding/action-center?scope=active&safetyCritical=true", {}, {
      userId: memberA,
      organizationId: orgA,
    });
    assert.equal(response.response.status, 200);
    const snapshot = bodyRecord(response.body);
    const followups = snapshot.documentFollowups as JsonRecord[];
    assert.equal(Number(bodyRecord(snapshot.counts).missingDocuments), 1);
    assert.equal(followups.length, 1);
    assert.equal(Number(followups[0]?.caseId), safetyCriticalCaseId);
    assert.equal(followups[0]?.key, "restricted");
    assert.equal(followups[0]?.label, "Restricted document");
    assert.doesNotMatch(JSON.stringify(followups[0]), /safety-pending/i);
    // The ordinary fixture's safety context is unknown.  It must not be
    // coerced to false or included in a query for an explicit true fact.
    assert.ok(followups.every((row) => row.caseId !== caseIds[0]));
  });

  test("applies site and workforce filters to document followups and counts", async () => {
    for (const query of ["siteExposure=true", "workforce=blue-collar-frontline"]) {
      const response = await request(`/onboarding/action-center?scope=active&${query}`, {}, {
        userId: ownerA,
        organizationId: orgA,
      });
      assert.equal(response.response.status, 200);
      const snapshot = bodyRecord(response.body);
      assert.equal(Number(bodyRecord(snapshot.counts).missingDocuments), 1);
      assert.deepEqual((snapshot.documentFollowups as JsonRecord[]).map((row) => row.caseId), [safetyCriticalCaseId]);
    }
  });

describe("Action Center routing, tenant scope, and identity CAS", () => {
  test("historical cases stay outside Demo operational queues and all Demo mutations remain retired", async () => {
    const projected = await request(
      "/onboarding/action-center?scope=all&limit=200&safetyCritical=true", {},
      { userId: demoAdministrator, organizationId: DEMO_ORGANIZATION_ID },
    );
    assert.equal(projected.response.status, 200);
    const snapshot = bodyRecord(projected.body);
    assert.equal(bodyRecord(snapshot.capabilities).canAct, false);
    assert.equal(bodyRecord(snapshot.capabilities).canRecordCallOutcome, false);
    assert.equal(bodyRecord(bodyRecord(snapshot.capabilities).aiCall).available, false);
    assert.equal(
      Number(bodyRecord(snapshot.counts).openWorkItems),
      (snapshot.workItems as JsonRecord[]).length,
      "ordinary Demo work items must not affect the synthetic projection count",
    );
    const projectedCaseIds = new Set<number>();
    for (const key of [
      "approvals",
      "notifications",
      "documentFollowups",
      "workItems",
      "completed",
      "opportunities",
    ]) {
      for (const item of snapshot[key] as JsonRecord[]) {
        projectedCaseIds.add(Number(item.caseId));
      }
    }
    const projectedCases = projectedCaseIds.size > 0
      ? await db.select().from(onbCases).where(and(
        eq(onbCases.organizationId, DEMO_ORGANIZATION_ID),
        inArray(onbCases.id, [...projectedCaseIds]),
      ))
      : [];
    assert.equal(projectedCases.length, projectedCaseIds.size);
    assert.ok(projectedCases.every(isSyntheticOfflineCase));
    assert.equal(
      (snapshot.documentFollowups as JsonRecord[]).some((item) => item.caseId === caseIds[2]),
      false,
      "ordinary Demo cases must not appear in the administrator projection",
    );
    const actionableOpportunity = (snapshot.opportunities as JsonRecord[]).find(
      (item) =>
        item.caseId === syntheticDemoCaseId &&
        bodyRecord(item.capabilities).canAct === true,
    );
    assert.equal(actionableOpportunity, undefined, "history must never expose an actionable opportunity");
    assert.equal(projectedCaseIds.size, 0, "historical cases must stay outside operational queues");
    const call = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify({
        requestId: `demo-admin-call-${suffix}`,
        caseId: syntheticDemoCaseId,
        outcome: "no-answer",
        selfReported: true,
      }),
    }, { userId: demoAdministrator, organizationId: DEMO_ORGANIZATION_ID });
    assert.equal(call.response.status, 410);
    assert.match(String(bodyRecord(call.body).message), /retired/i);

    const reminder = await request("/onboarding/action-center/actions/remind-document", {
      method: "POST",
      body: JSON.stringify({
        requestId: `demo-admin-reminder-${suffix}`,
        caseId: syntheticDemoCaseId,
        documentId: documentIds.find((id) => id > 0),
        mode: "simulation",
      }),
    }, { userId: demoAdministrator, organizationId: DEMO_ORGANIZATION_ID });
    assert.equal(reminder.response.status, 403);
    assert.match(String(bodyRecord(reminder.body).message), /not a supported public Demo/i);

    const assign = await request("/onboarding/action-center/actions/assign", {
      method: "POST",
      body: JSON.stringify({
        requestId: `demo-admin-assign-${suffix}`,
        caseId: syntheticDemoCaseId,
        owner: "documentation",
        expectedVersion: 0,
      }),
    }, { userId: demoAdministrator, organizationId: DEMO_ORGANIZATION_ID });
    assert.equal(assign.response.status, 410);

    const ordinaryCaseAttempt = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify({
        requestId: `demo-admin-ordinary-${suffix}`,
        caseId: caseIds[2],
        outcome: "reached",
        selfReported: true,
      }),
    }, { userId: demoAdministrator, organizationId: DEMO_ORGANIZATION_ID });
    assert.equal(ordinaryCaseAttempt.response.status, 410);
    assert.match(String(bodyRecord(ordinaryCaseAttempt.body).message), /retired/i);

    const liveAttempt = await request("/onboarding/action-center/actions/remind-document", {
      method: "POST",
      body: JSON.stringify({
        requestId: `demo-admin-live-${suffix}`,
        caseId: syntheticDemoCaseId,
        documentId: documentIds.find((id) => id > 0),
        mode: "live",
      }),
    }, { userId: demoAdministrator, organizationId: DEMO_ORGANIZATION_ID });
    assert.equal(liveAttempt.response.status, 403);
    assert.match(String(bodyRecord(liveAttempt.body).message), /not a supported public Demo/i);

    const reviewerRead = await request("/onboarding/action-center", {}, {
      userId: demoReviewer,
      organizationId: DEMO_ORGANIZATION_ID,
    });
    assert.equal(reviewerRead.response.status, 403);
    const reviewerMutation = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify({
        requestId: `demo-reviewer-call-${suffix}`,
        caseId: syntheticDemoCaseId,
        outcome: "no-answer",
        selfReported: true,
      }),
    }, { userId: demoReviewer, organizationId: DEMO_ORGANIZATION_ID });
    assert.equal(reviewerMutation.response.status, 403);
  });

  test("requires auth, rejects forged organization context, and projects only tenant-owned rows", async () => {
    const unauthenticated = await request("/onboarding/action-center", {
      headers: { "x-test-user": "unauthenticated" },
    });
    assert.equal(unauthenticated.response.status, 401);

    const missingOrganization = await request("/onboarding/action-center", {}, {
      userId: ownerA,
      organizationId: null,
    });
    assert.equal(missingOrganization.response.status, 409);

    const forgedOrganization = await request(
      "/onboarding/action-center",
      {},
      { userId: ownerA, organizationId: orgB },
    );
    assert.equal(forgedOrganization.response.status, 403);

    const response = await request("/onboarding/action-center?scope=active", {}, {
      userId: memberA,
      organizationId: orgA,
    });
    assert.equal(response.response.status, 200);
    const snapshot = bodyRecord(response.body);
    assert.equal(snapshot.pausedOffline, false);
    assert.match(
      String(bodyRecord(bodyRecord(snapshot.capabilities).aiCall).hrefTemplate),
      /\/cases\/\{caseId\}/,
    );
    assert.ok((snapshot.approvals as JsonRecord[]).every((row) => row.caseId !== caseIds[1]));
    assert.ok((snapshot.notifications as JsonRecord[]).every((row) => row.caseId !== caseIds[1]));
    const firstFollowup = (snapshot.documentFollowups as JsonRecord[]).find(
      (row) => row.caseId === caseIds[0],
    );
    assert.ok(firstFollowup);
    assert.equal(bodyRecord(bodyRecord(firstFollowup).case).pausedOffline, false);
    assert.equal(bodyRecord(bodyRecord(firstFollowup).case).canAct, true);
    assert.equal(bodyRecord(bodyRecord(firstFollowup).capabilities).canRemind, false);
    // An owner/membership context is not specialist authority. The derived
    // action board must not turn a document follow-up into a contact or
    // private-document disclosure.
    assert.equal(bodyRecord(bodyRecord(firstFollowup).case).workerName, "Restricted candidate");
    assert.equal(bodyRecord(bodyRecord(firstFollowup).case).workerEmail, "restricted");
    assert.equal(firstFollowup.label, "Restricted document");
    const [bgvCheck] = await db.select({ id: onbSystemChecks.id }).from(onbSystemChecks).where(and(
      eq(onbSystemChecks.organizationId, orgA),
      eq(onbSystemChecks.system, "bgv"),
    ));
    assert.ok(bgvCheck);
    assert.ok(
      (snapshot.notifications as JsonRecord[]).some(
        (row) => row.id === `system-check:${bgvCheck.id}`,
      ),
    );
    assert.ok(
      (snapshot.notifications as JsonRecord[]).every(
        (row) => row.id !== "system-check:does-not-exist" && row.recipient !== "hris",
      ),
    );

    await db.update(onbSystemChecks).set({ status: "done", completedAt: new Date() }).where(and(
      eq(onbSystemChecks.organizationId, orgA),
      eq(onbSystemChecks.system, "bgv"),
    ));
    const afterLatestCheck = await getActionCenter(orgA, "active");
    assert.equal(
      afterLatestCheck.notifications.some((row) => row.id === `system-check:${bgvCheck.id}`),
      false,
      "a completed latest system check must not remain a stale notification",
    );
  });

  test("ordinary tenant members cannot use any Action Center mutation, including live reminders", async () => {
    const protectedCaseId = await createCase(orgA, {
      name: `Action Center Member Guard ${suffix}`,
      email: `action-center-member-guard-${suffix}@example.test`,
    });
    const protectedDocumentId = await createDocument(orgA, protectedCaseId, {
      key: `member-guard-${suffix}`,
      updatedAt: new Date(Date.now() - 2 * 86_400_000),
    });

    const call = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify({
        requestId: `member-call-${suffix}`,
        caseId: protectedCaseId,
        outcome: "no-answer",
        selfReported: true,
      }),
    }, { userId: memberA, organizationId: orgA });
    assert.equal(call.response.status, 403);
    assert.match(String(bodyRecord(call.body).message), /owner|admin|role/i);

    const ordinaryPersona = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify({
        requestId: `ordinary-persona-${suffix}`,
        caseId: protectedCaseId,
        outcome: "scheduled",
        persona: "standard-fte",
        selfReported: true,
      }),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(ordinaryPersona.response.status, 403);

    const reminder = await request("/onboarding/action-center/actions/remind-document", {
      method: "POST",
      body: JSON.stringify({
        requestId: `member-live-reminder-${suffix}`,
        caseId: protectedCaseId,
        documentId: protectedDocumentId,
        mode: "live",
      }),
    }, { userId: memberA, organizationId: orgA });
    assert.equal(reminder.response.status, 403);
    assert.match(String(bodyRecord(reminder.body).message), /owner|admin|role/i);

    const assign = await request("/onboarding/action-center/actions/assign", {
      method: "POST",
      body: JSON.stringify({
        requestId: `member-assign-${suffix}`,
        caseId: protectedCaseId,
        owner: "documentation",
        expectedVersion: 0,
      }),
    }, { userId: memberA, organizationId: orgA });
    assert.equal(assign.response.status, 403);
    assert.match(String(bodyRecord(assign.body).message), /owner|admin|role/i);

    const escalate = await request("/onboarding/action-center/actions/escalate", {
      method: "POST",
      body: JSON.stringify({
        requestId: `member-escalate-${suffix}`,
        caseId: protectedCaseId,
        owner: "compliance",
        expectedVersion: 0,
      }),
    }, { userId: memberA, organizationId: orgA });
    assert.equal(escalate.response.status, 403);
    assert.match(String(bodyRecord(escalate.body).message), /owner|admin|role/i);

    // Seed one owner-owned work item solely to exercise member reassign/resolve
    // denial; the member must not be able to mutate an existing item either.
    const ownerAssign = await request("/onboarding/action-center/actions/assign", {
      method: "POST",
      body: JSON.stringify({
        requestId: `guard-owner-assign-${suffix}`,
        caseId: protectedCaseId,
        owner: "documentation",
        expectedVersion: 0,
      }),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(ownerAssign.response.status, 200);
    const workItemId = Number(bodyRecord(bodyRecord(ownerAssign.body).action).id);

    const reassign = await request("/onboarding/action-center/actions/reassign", {
      method: "POST",
      body: JSON.stringify({
        requestId: `member-reassign-${suffix}`,
        caseId: protectedCaseId,
        workItemId,
        owner: "compliance",
        expectedVersion: 1,
      }),
    }, { userId: memberA, organizationId: orgA });
    assert.equal(reassign.response.status, 403);
    assert.match(String(bodyRecord(reassign.body).message), /owner|admin|role/i);

    const resolve = await request("/onboarding/action-center/actions/resolve", {
      method: "POST",
      body: JSON.stringify({
        requestId: `member-resolve-${suffix}`,
        caseId: protectedCaseId,
        workItemId,
        expectedVersion: 1,
      }),
    }, { userId: memberA, organizationId: orgA });
    assert.equal(resolve.response.status, 403);
    assert.match(String(bodyRecord(resolve.body).message), /owner|admin|role/i);

    const demoLiveCaseId = await createCase(DEMO_ORGANIZATION_ID, {
      name: `Action Center Demo Live Guard ${suffix}`,
      email: `action-center-demo-live-guard-${suffix}@example.test`,
      candidateAuthorized: true,
    });
    const demoLiveDocumentId = await createDocument(DEMO_ORGANIZATION_ID, demoLiveCaseId, {
      key: `demo-live-guard-${suffix}`,
      updatedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const originalProxy = ReplitConnectors.prototype.proxy;
    let providerCalls = 0;
    (ReplitConnectors.prototype as unknown as {
      proxy: (...args: any[]) => Promise<Response>;
    }).proxy = async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ id: "demo-live-guard-provider" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    setOnboardingConnectorProxyForTests((ReplitConnectors.prototype as unknown as {
      proxy: typeof ReplitConnectors.prototype.proxy;
    }).proxy);
    try {
      const demoLive = await request("/onboarding/action-center/actions/remind-document", {
        method: "POST",
        body: JSON.stringify({
          requestId: `demo-member-live-${suffix}`,
          caseId: demoLiveCaseId,
          documentId: demoLiveDocumentId,
          mode: "live",
        }),
      }, { userId: demoMember, organizationId: DEMO_ORGANIZATION_ID });
      assert.equal(demoLive.response.status, 403);
      assert.match(String(bodyRecord(demoLive.body).message), /simulation|owner|admin|live|controller/i);
      assert.equal(providerCalls, 0, "Demo member live reminder must not cross the provider boundary");
    } finally {
      setOnboardingConnectorProxyForTests(null);
      (ReplitConnectors.prototype as unknown as {
        proxy: (...args: any[]) => Promise<Response>;
      }).proxy = originalProxy;
    }

    const demoSimulationCaseId = await createCase(DEMO_ORGANIZATION_ID, {
      name: `Action Center Demo Member Simulation ${suffix}`,
      email: `action-center-demo-member-simulation-${suffix}@example.test`,
      candidateAuthorized: true,
    });
    const demoSimulationDocumentId = await createDocument(DEMO_ORGANIZATION_ID, demoSimulationCaseId, {
      key: `demo-member-simulation-${suffix}`,
      updatedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const demoSimulation = await request("/onboarding/action-center/actions/remind-document", {
      method: "POST",
      body: JSON.stringify({
        requestId: `demo-member-simulation-${suffix}`,
        caseId: demoSimulationCaseId,
        documentId: demoSimulationDocumentId,
        mode: "simulation",
      }),
    }, { userId: demoMember, organizationId: DEMO_ORGANIZATION_ID });
    assert.equal(demoSimulation.response.status, 403);
  });

  test("named identities use server CAS, parse legacy stakeholder shape, and reject malformed settings", async () => {
    const initial = await getActionCenterIdentities(orgA);
    assert.equal(initial.version, 1);

    const memberAttempt = await request("/onboarding/action-center/identities", {
      method: "PUT",
      body: JSON.stringify({ version: 1, identities: identityInput() }),
    }, { userId: memberA, organizationId: orgA });
    assert.equal(memberAttempt.response.status, 403);

    const updated = await updateActionCenterIdentities({
      organizationId: orgA,
      expectedVersion: initial.version,
      identities: identityInput({
        hr: { name: "  HR Regression Owner  ", mailboxType: "shared" },
      }),
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.identities.hr.name, "HR Regression Owner");
    assert.equal(updated.identities.hr.source, "configured");

    await assert.rejects(
      updateActionCenterIdentities({
        organizationId: orgA,
        expectedVersion: initial.version,
        identities: identityInput(),
      }),
      ActionCenterIdentityConflictError,
    );

    await db.insert(onbSettings).values({
      organizationId: orgA,
      key: ACTION_CENTER_IDENTITIES_KEY,
      value: JSON.stringify({
        version: 3,
        stakeholders: {
          hr: { name: "Legacy HR", role: "shared" },
          bgvTeam: { name: "Legacy BGV", role: "shared" },
          recruiter: { name: "Legacy Recruiter", role: "individual" },
        },
      }),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify({
        version: 3,
        stakeholders: {
          hr: { name: "Legacy HR", role: "shared" },
          bgvTeam: { name: "Legacy BGV", role: "shared" },
          recruiter: { name: "Legacy Recruiter", role: "individual" },
        },
      }) },
    });
    const legacy = await getActionCenterIdentities(orgA);
    assert.equal(legacy.version, 3);
    assert.deepEqual(legacy.identities.hr, {
      name: "Legacy HR",
      mailboxType: "shared",
      source: "configured",
    });
    assert.deepEqual(legacy.identities.recruiter, {
      name: "Legacy Recruiter",
      mailboxType: "individual",
      source: "configured",
    });

    await db.update(onbSettings).set({ value: "{malformed" }).where(and(
      eq(onbSettings.organizationId, orgA),
      eq(onbSettings.key, ACTION_CENTER_IDENTITIES_KEY),
    ));
    await assert.rejects(getActionCenterIdentities(orgA), ActionCenterIdentityConflictError);
  });

  test("first identity write is a real compare-and-set when the settings row does not exist", async () => {
    const outcomes = await Promise.allSettled([
      updateActionCenterIdentities({
        organizationId: orgC,
        expectedVersion: 1,
        identities: identityInput({
          hr: { name: "First writer", mailboxType: "shared" },
        }),
      }),
      updateActionCenterIdentities({
        organizationId: orgC,
        expectedVersion: 1,
        identities: identityInput({
          hr: { name: "Second writer", mailboxType: "individual" },
        }),
      }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof ActionCenterIdentityConflictError);
    const saved = await getActionCenterIdentities(orgC);
    assert.equal(saved.version, 2);
  });
});

describe("Action Center append-only mutations", () => {
  test("replays manual calls, conflicts on changed payload, and preserves actor/evidence/readiness", async () => {
    const [beforeCase] = await db.select({
      readiness: onbCases.readiness,
    }).from(onbCases).where(and(
      eq(onbCases.organizationId, orgA),
      eq(onbCases.id, caseIds[0]!),
    ));
    assert.ok(beforeCase);

    const body = {
      requestId: `manual-call-${suffix}`,
      caseId: caseIds[0],
      outcome: "no-answer",
      notes: "Regression self-report",
      selfReported: true,
    };
    const first = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify(body),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(first.response.status, 200);
    const firstBody = bodyRecord(first.body);
    assert.equal(firstBody.idempotent, false);
    assert.equal(bodyRecord(firstBody.action).actor, ownerA);
    assert.equal(bodyRecord(firstBody.action).selfReported, true);
    assert.equal(bodyRecord(firstBody.action).verified, false);

    const replay = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify(body),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(replay.response.status, 200);
    const replayBody = bodyRecord(replay.body);
    assert.equal(replayBody.idempotent, true);
    assert.deepEqual(replayBody.action, firstBody.action);
    assert.equal(replayBody.actionVersion, firstBody.actionVersion);

    const conflict = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify({ ...body, outcome: "reached" }),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(conflict.response.status, 409);
    assert.match(String(bodyRecord(conflict.body).message), /different action/i);

    const forgedEvidence = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        requestId: `forged-evidence-${suffix}`,
        selfReported: false,
      }),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(forgedEvidence.response.status, 200);
    assert.equal(bodyRecord(bodyRecord(forgedEvidence.body).action).selfReported, true);
    assert.equal(bodyRecord(bodyRecord(forgedEvidence.body).action).verified, false);

    const [stored] = await db.select().from(onbActionCenterActions).where(and(
      eq(onbActionCenterActions.organizationId, orgA),
      eq(onbActionCenterActions.requestId, body.requestId),
    ));
    assert.ok(stored);
    assert.equal(stored.actorUserId, ownerA);
    assert.equal(stored.actorName, ownerA);
    assert.equal(stored.selfReported, true);
    assert.equal(stored.verified, false);

    const [afterCase] = await db.select({
      readiness: onbCases.readiness,
    }).from(onbCases).where(eq(onbCases.id, caseIds[0]!));
    assert.deepEqual(afterCase?.readiness, beforeCase.readiness);
  });

  test("assignment, reassignment, and resolution are fenced by the Action Center version", async () => {
    const assigned = await request("/onboarding/action-center/actions/assign", {
      method: "POST",
      body: JSON.stringify({
        requestId: `assign-${suffix}`,
        caseId: caseIds[0],
        owner: "documentation",
        assignee: "Initial queue",
        reason: "Initial assignment",
        expectedVersion: 2,
      }),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(assigned.response.status, 200);
    const assignedBody = bodyRecord(assigned.body);
    const workItemId = Number(bodyRecord(assignedBody.action).id);
    assert.equal(assignedBody.actionVersion, 3);

    const stale = await request("/onboarding/action-center/actions/escalate", {
      method: "POST",
      body: JSON.stringify({
        requestId: `stale-escalate-${suffix}`,
        caseId: caseIds[0],
        owner: "compliance",
        expectedVersion: 1,
      }),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(stale.response.status, 409);

    const reassignedBody = {
      requestId: `reassign-${suffix}`,
      caseId: caseIds[0],
      workItemId,
      owner: "compliance",
      assignee: "Compliance queue",
      reason: "Compliance owns this review now",
      expectedVersion: 3,
    };
    const reassigned = await request("/onboarding/action-center/actions/reassign", {
      method: "POST",
      body: JSON.stringify(reassignedBody),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(reassigned.response.status, 200);
    assert.equal(bodyRecord(reassigned.body).actionVersion, 4);
    const reassignReplay = await request("/onboarding/action-center/actions/reassign", {
      method: "POST",
      body: JSON.stringify(reassignedBody),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(reassignReplay.response.status, 200);
    const reassignReplayBody = bodyRecord(reassignReplay.body);
    assert.equal(reassignReplayBody.idempotent, true);
    assert.deepEqual(reassignReplayBody.action, bodyRecord(reassigned.body).action);
    assert.equal(reassignReplayBody.actionVersion, bodyRecord(reassigned.body).actionVersion);

    const projected = await getActionCenter(orgA, "all");
    const workItem = projected.workItems.find((item) => item.id === workItemId);
    assert.equal(workItem?.owner, "compliance");
    assert.equal(workItem?.assignee, "Compliance queue");
    assert.equal(workItem?.reason, "Compliance owns this review now");
    assert.equal(workItem?.actionVersion, 4);

    const staleResolve = await request("/onboarding/action-center/actions/resolve", {
      method: "POST",
      body: JSON.stringify({
        requestId: `stale-resolve-${suffix}`,
        caseId: caseIds[0],
        workItemId,
        expectedVersion: 3,
      }),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(staleResolve.response.status, 409);

    const resolved = await request("/onboarding/action-center/actions/resolve", {
      method: "POST",
      body: JSON.stringify({
        requestId: `resolve-${suffix}`,
        caseId: caseIds[0],
        workItemId,
        expectedVersion: 4,
      }),
    }, { userId: ownerA, organizationId: orgA });
    assert.equal(resolved.response.status, 200);
    assert.equal(bodyRecord(resolved.body).actionVersion, 5);

    const activeAfter = await getActionCenter(orgA, "active");
    assert.equal(activeAfter.workItems.some((item) => item.id === workItemId), false);
    const completedAfter = await getActionCenter(orgA, "completed");
    assert.ok(completedAfter.completed.some((item) => item.id === `action-${bodyRecord(resolved.body).action.id}`));
  });

  test("paused synthetic cases are genuinely read-only and produce no Action Center ledger rows", async () => {
    const before = await db.select().from(onbActionCenterActions).where(eq(
      onbActionCenterActions.organizationId,
      orgB,
    ));
    assert.equal(before.length, 0);
    const paused = await getActionCenter(orgB, "active");
    assert.equal(paused.pausedOffline, true);
    assert.equal(paused.capabilities.canAct, false);
    const pausedRecord = paused as unknown as JsonRecord;
    const offlineFollowup = (pausedRecord.documentFollowups as JsonRecord[]).find(
      (row) => row.caseId === caseIds[1],
    );
    assert.equal(offlineFollowup, undefined, "history is not an active document follow-up");

    const mixedOnlineCaseId = await createCase(orgB, {
      name: `Action Center Mixed Online ${suffix}`,
      email: `action-center-mixed-online-${suffix}@example.test`,
    });
    const mixedOnlineDocumentId = await createDocument(orgB, mixedOnlineCaseId, {
      key: `mixed-online-${suffix}`,
      updatedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const mixed = await getActionCenter(orgB, "active");
    assert.equal(mixed.pausedOffline, false, "tenant-level capability remains enabled for mixed cases");
    const mixedRecord = mixed as unknown as JsonRecord;
    const mixedOffline = (mixedRecord.documentFollowups as JsonRecord[]).find(
      (row) => row.caseId === caseIds[1],
    );
    const mixedOnline = (mixedRecord.documentFollowups as JsonRecord[]).find(
      (row) => row.caseId === mixedOnlineCaseId,
    );
    assert.equal(mixedOffline, undefined, "mixing in genuine work must not reactivate history");
    assert.equal(bodyRecord(bodyRecord(mixedOnline).case).pausedOffline, false);
    assert.equal(bodyRecord(bodyRecord(mixedOnline).case).canAct, true);
    assert.equal(mixedOnline?.capabilities.canRemind, true);
    assert.ok(mixedOnlineDocumentId > 0);

    await assert.rejects(
      recordManualCallOutcome({
        organizationId: orgB,
        actorUserId: ownerB,
        actorName: "Should not persist",
        organizationRole: "owner",
        requestId: `offline-call-${suffix}`,
        caseId: caseIds[1]!,
        outcome: "no-answer",
        selfReported: true,
      }),
      RetiredCaseCapabilityError,
    );
    await assert.rejects(
      recordWorkItem({
        organizationId: orgB,
        actorUserId: ownerB,
        actorName: "Should not persist",
        organizationRole: "owner",
        requestId: `offline-assign-${suffix}`,
        caseId: caseIds[1]!,
        kind: "assign",
        owner: "hr",
        expectedVersion: 0,
      }),
      RetiredCaseCapabilityError,
    );
    const routeAttempt = await request("/onboarding/action-center/actions/manual-call-outcome", {
      method: "POST",
      body: JSON.stringify({
        requestId: `offline-route-${suffix}`,
        caseId: caseIds[1],
        outcome: "no-answer",
        selfReported: true,
      }),
    }, { userId: ownerB, organizationId: orgB });
    assert.equal(routeAttempt.response.status, 410);
    const after = await db.select().from(onbActionCenterActions).where(eq(
      onbActionCenterActions.organizationId,
      orgB,
    ));
    assert.equal(after.length, 0);
  });
});

describe("Action Center reminder boundary and projection delivery labels", () => {
  test("Demo simulation is provider-denied, ordinary simulation is rejected, and received/correction states stay distinct", async () => {
    const [demoDocument] = await db.select().from(onbDocuments).where(and(
      eq(onbDocuments.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbDocuments.caseId, caseIds[2]!),
    ));
    assert.ok(demoDocument);
    const beforeCommunications = await db.select().from(onbCommunications).where(eq(
      onbCommunications.caseId,
      caseIds[2]!,
    ));
    // A demo persona/member is not sensitive-document authority.
    await assert.rejects(recordDocumentReminder({
      organizationId: DEMO_ORGANIZATION_ID,
      actorUserId: ownerA,
      actorName,
      organizationRole: "member",
      requestId: `demo-simulation-${suffix}`,
      caseId: caseIds[2]!,
      documentId: demoDocument.id,
      mode: "simulation",
    }));
    assert.equal((await db.select().from(onbCommunications).where(eq(
      onbCommunications.caseId,
      caseIds[2]!,
    ))).length, beforeCommunications.length);
    await assert.rejects(
      recordDocumentReminder({
        organizationId: DEMO_ORGANIZATION_ID,
        actorUserId: ownerA,
        actorName,
        organizationRole: "member",
        requestId: `demo-simulation-${suffix}`,
        caseId: caseIds[2]!,
        documentId: demoDocument.id,
        mode: "live",
      }),
    );

    const ordinarySimulation = await assert.rejects(
      recordDocumentReminder({
        organizationId: orgA,
        actorUserId: ownerA,
        actorName,
        organizationRole: "owner",
        requestId: `ordinary-simulation-${suffix}`,
        caseId: caseIds[0]!,
        documentId: documentIds[0]!,
        mode: "simulation",
      }),
      ActionCenterPermissionError,
    );
    assert.equal(ordinarySimulation, undefined);

    const [receivedForReview] = await db.insert(onbDocuments).values({
      organizationId: orgA,
      caseId: caseIds[0]!,
      key: `received-${suffix}`,
      label: "Received for review",
      category: "statutory",
      status: "received",
      required: true,
      note: "Received; awaiting human review.",
      updatedAt: new Date(Date.now() - 2 * 86_400_000),
    }).returning();
    assert.ok(receivedForReview);
    documentIds.push(receivedForReview.id);
    await createValidationUpload(orgA, caseIds[0]!, receivedForReview.id, "passed");
    await assert.rejects(
      recordDocumentReminder({
        organizationId: orgA,
        actorUserId: ownerA,
        actorName,
        organizationRole: "owner",
        requestId: `received-review-${suffix}`,
        caseId: caseIds[0]!,
        documentId: receivedForReview.id,
        mode: "live",
      }),
      ActionCenterConflictError,
    );

    const quarantinedDocumentId = await createDocument(orgA, caseIds[0]!, {
      key: `quarantined-${suffix}`,
      status: "received",
      // The old free-text implementation would incorrectly treat "correct"
      // in this sentence as a candidate correction request.
      note: "File quarantined; correct handling requires HR/security review.",
      updatedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    await createValidationUpload(orgA, caseIds[0]!, quarantinedDocumentId, "manual_review");
    await assert.rejects(
      recordDocumentReminder({
        organizationId: orgA,
        actorUserId: ownerA,
        actorName,
        organizationRole: "owner",
        requestId: `quarantined-review-${suffix}`,
        caseId: caseIds[0]!,
        documentId: quarantinedDocumentId,
        mode: "live",
      }),
      ActionCenterConflictError,
    );
  });

  test("live reminder delivery is stubbed in-process and nextAt advances once for correction/concurrent retries", async () => {
    const correctionDocumentId = await createDocument(orgA, caseIds[0]!, {
      key: `correction-${suffix}`,
      status: "received",
      // The structured upload state, not a free-text keyword, authorizes the
      // candidate correction reminder.
      note: "Validation result awaiting replacement.",
      updatedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    await createValidationUpload(orgA, caseIds[0]!, correctionDocumentId, "correction_requested");

    const originalProxy = ReplitConnectors.prototype.proxy;
    let providerCalls = 0;
    (ReplitConnectors.prototype as unknown as {
      proxy: (...args: any[]) => Promise<Response>;
    }).proxy = async () => {
      providerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ id: `stubbed-provider-${providerCalls}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    setOnboardingConnectorProxyForTests((ReplitConnectors.prototype as unknown as {
      proxy: typeof ReplitConnectors.prototype.proxy;
    }).proxy);
    try {
      const sent = await recordDocumentReminder({
        organizationId: orgA,
        actorUserId: ownerA,
        actorName,
        organizationRole: "owner",
        requestId: `correction-live-${suffix}`,
        caseId: caseIds[0]!,
        documentId: correctionDocumentId,
        mode: "live",
      });
      assert.equal(sent.action.status, "sent", JSON.stringify(await db.select({
        status: onbCommunications.status,
        failureReason: onbCommunications.failureReason,
      }).from(onbCommunications).where(and(
        eq(onbCommunications.organizationId, orgA),
        eq(onbCommunications.caseId, caseIds[0]!),
      ))));
      assert.equal(providerCalls, 1);
      const [afterSent] = await db.select().from(onbDocuments).where(eq(
        onbDocuments.id,
        correctionDocumentId,
      ));
      assert.ok(afterSent);
      assert.equal(afterSent.reminderCount, 1);
      assert.ok(afterSent.reminderNextAt);
      const delta = afterSent.reminderNextAt!.getTime() - Date.now();
      assert.ok(
        delta > 47 * 3_600_000 && delta < 49 * 3_600_000,
        `expected ~48h next reminder, got delta=${delta}ms at ${afterSent.reminderNextAt!.toISOString()}`,
      );

      // Simulate a worker crash after the communication was claimed but
      // before the Action Center receipt was confirmed. Replaying the same
      // request must reconcile the stable communication/effect journal, not
      // return a permanently stale "sending" action.
      const [sentActionRow] = await db.select().from(onbActionCenterActions).where(eq(
        onbActionCenterActions.id,
        sent.action.id,
      ));
      assert.ok(sentActionRow);
      const sentCommunicationId = Number(
        (sentActionRow.payload.communicationId as number | undefined),
      );
      assert.ok(Number.isInteger(sentCommunicationId));
      await db.update(onbActionCenterActions).set({ status: "sending" }).where(eq(
        onbActionCenterActions.id,
        sent.action.id,
      ));
      await db.update(onbCommunications).set({ status: "sending" }).where(eq(
        onbCommunications.id,
        sentCommunicationId,
      ));
      const reconciled = await recordDocumentReminder({
        organizationId: orgA,
        actorUserId: ownerA,
        actorName,
        organizationRole: "owner",
        requestId: `correction-live-${suffix}`,
        caseId: caseIds[0]!,
        documentId: correctionDocumentId,
        mode: "live",
      });
      assert.equal(reconciled.idempotent, true);
      assert.equal(reconciled.action.status, "sent");
      assert.equal(reconciled.action.providerEffectId, sent.action.providerEffectId);

      // A stale updatedAt alone must not bypass the explicit 48-hour next-due
      // cooldown promised by the reminder contract.
      await db.update(onbDocuments).set({
        updatedAt: new Date(Date.now() - 2 * 86_400_000),
      }).where(eq(onbDocuments.id, correctionDocumentId));
      await assert.rejects(
        recordDocumentReminder({
          organizationId: orgA,
          actorUserId: ownerA,
          actorName,
          organizationRole: "owner",
          requestId: `correction-cooldown-${suffix}`,
          caseId: caseIds[0]!,
          documentId: correctionDocumentId,
          mode: "live",
        }),
        ActionCenterConflictError,
      );

      const concurrentDocumentId = await createDocument(orgA, caseIds[0]!, {
        key: `concurrent-${suffix}`,
        updatedAt: new Date(Date.now() - 2 * 86_400_000),
      });
      await createValidationUpload(orgA, caseIds[0]!, concurrentDocumentId, "passed");
      const [first, second] = await Promise.all([
        recordDocumentReminder({
          organizationId: orgA,
          actorUserId: ownerA,
          actorName,
          organizationRole: "owner",
          requestId: `concurrent-a-${suffix}`,
          caseId: caseIds[0]!,
          documentId: concurrentDocumentId,
          mode: "live",
        }),
        recordDocumentReminder({
          organizationId: orgA,
          actorUserId: ownerA,
          actorName,
          organizationRole: "owner",
          requestId: `concurrent-b-${suffix}`,
          caseId: caseIds[0]!,
          documentId: concurrentDocumentId,
          mode: "live",
        }),
      ]);
      assert.equal(providerCalls, 2, "one provider call per unique document idempotency key");
      assert.ok(["sent", "sending"].includes(first.action.status));
      assert.ok(["sent", "sending"].includes(second.action.status));
      const communications = await db.select().from(onbCommunications).where(and(
        eq(onbCommunications.organizationId, orgA),
        eq(onbCommunications.caseId, caseIds[0]!),
        eq(onbCommunications.idempotencyKey, `document-reminder:${concurrentDocumentId}:1`),
      ));
      assert.equal(communications.length, 1, "manual and scheduled paths share one communication effect");
      const [afterConcurrent] = await db.select().from(onbDocuments).where(eq(
        onbDocuments.id,
        concurrentDocumentId,
      ));
      assert.equal(afterConcurrent?.reminderCount, 1);
    } finally {
      setOnboardingConnectorProxyForTests(null);
      (ReplitConnectors.prototype as unknown as {
        proxy: (...args: any[]) => Promise<Response>;
      }).proxy = originalProxy;
    }
  });

  test("notification projection exposes every persisted delivery label and completed history", async () => {
    await insertCommunicationRows(caseIds[0]!, orgA);
    const projected = await getActionCenter(orgA, "all");
    const labels = new Set(projected.notifications.map((notification) => notification.deliveryLabel));
    assert.deepEqual(
      [...labels].sort(),
      ["Failed", "Not sent", "Recorded", "Sending", "Sent", "Simulated"].sort(),
    );
    assert.ok(projected.completed.some((item) => item.kind === "manual-call-outcome"));
    assert.ok(projected.counts.completed >= 1);
  });
});
});
