import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { after, before, test } from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  DEMO_ORGANIZATION_ID,
  onbCases,
  onbCommunications,
  onbConnectors,
  onbEffectJournal,
  onbEvents,
  onbApprovals,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisionReviews,
  onbGovernanceDecisions,
  onbGovernanceDispatchMarkers,
  onbGovernanceRequirements,
  onbSettings,
  onbSystemChecks,
  onbReadinessSlaPolicies,
  onbSensitiveLifecyclePolicies,
  onbWatchEmails,
  accessSecurityGroups,
  accessSecurityGroupPolicies,
  accessSecurityGroupUserGroups,
  accessSecurityGroupAttachments,
  accessUserGroups,
  accessUserGroupMembers,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import onboardingRouter from "../../routes/onboarding";
import { escalateCheck } from "./system-watcher";
import {
  BgvNotificationConflictError,
  BGV_NOTIFICATION_SETTING_PREFIX,
  type BgvNotificationConfig,
  getBgvNotifications,
  recordBgvBlockedEpisode,
  recordBgvReleaseEpisode,
  reconcileBgvNotifications,
  updateBgvNotifications,
  withBgvNotificationCaseFence,
} from "./bgv-notifications";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";
import {
  governanceSnapshotForNewCase,
  withGovernanceDecisionSnapshot,
} from "./governance-runtime";
import {
  evaluateSensitiveLifecycleGate,
  SENSITIVE_DATA_CLASSES,
} from "./sensitive-lifecycle";

/**
 * This suite deliberately runs only in development.  It uses a real
 * development database fixture, but every provider call is replaced with the
 * sender dependency accepted by bgv-notifications.ts.
 */
assert.equal(
  process.env.NODE_ENV,
  "development",
  "BGV notification regression tests must run with NODE_ENV=development",
);

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `bgv-notifications-a-${suffix}`;
const orgB = `bgv-notifications-b-${suffix}`;
const testUser = `bgv-notifications-user-${suffix}`;
const accessOwner = `bgv-notifications-access-owner-${suffix}`;
const addresses = {
  hr: `bgv-hr-${suffix}@example.test`,
  bgvTeam: `bgv-provider-${suffix}@example.test`,
  recruiter: `bgv-recruiter-${suffix}@example.test`,
  hiringManager: `bgv-manager-${suffix}@example.test`,
  compliance: `bgv-compliance-${suffix}@example.test`,
};
const oldAllowedRecipients = process.env.ONBOARDING_ALLOWED_RECIPIENTS;
const createdCases: Array<{ id: number; organizationId: string }> = [];
let baseUrl = "";
let server: Server;

type Flags = NonNullable<BgvNotificationConfig["flags"]>;
type Recipient = NonNullable<BgvNotificationConfig["hr"]>;
type Candidate = NonNullable<BgvNotificationConfig["candidate"]>;
type ConfigOverrides = {
  flags?: Partial<Flags>;
  hr?: Recipient;
  bgvTeam?: Recipient;
  recruiter?: Recipient;
  hiringManager?: Recipient;
  compliance?: Recipient;
  candidate?: Candidate;
};

const fullFlags: Flags = {
  candidateActionRequired: true,
  providerActionRequired: true,
  startDateAtRisk: true,
  coordinationRequired: true,
  dependentWorkOnHold: true,
};

function recipient(email: string | null, enabled = true, purposeAuthorized = true): Recipient {
  return { email, enabled, purposeAuthorized };
}

function configFor(version: number, overrides: ConfigOverrides = {}): BgvNotificationConfig {
  return {
    version,
    flags: { ...fullFlags, ...overrides.flags },
    hr: overrides.hr ?? recipient(addresses.hr),
    bgvTeam: overrides.bgvTeam ?? recipient(addresses.bgvTeam),
    recruiter: overrides.recruiter ?? recipient(addresses.recruiter),
    hiringManager: overrides.hiringManager ?? recipient(addresses.hiringManager),
    compliance: overrides.compliance ?? recipient(addresses.compliance),
    candidate: overrides.candidate ?? { enabled: true, purposeAuthorized: true },
  };
}

type SenderCall = { to: string; subject: string; body: string };
type Sender = (
  to: string,
  subject: string,
  body: string,
) => Promise<{
  status: string;
  failureReason: string | null;
  externalMessageId: string | null;
}>;

function makeSender(
  result: "sent" | "sending" = "sent",
  delayMs = 0,
): { calls: SenderCall[]; sender: Sender } {
  const calls: SenderCall[] = [];
  const senderId = randomUUID();
  return {
    calls,
    sender: async (to, subject, body) => {
      calls.push({ to, subject, body });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        status: result,
        failureReason: result === "sending"
          ? "Provider did not confirm the delivery outcome."
          : null,
        externalMessageId: result === "sent" ? `provider-message-${senderId}-${calls.length}` : null,
      };
    },
  };
}

function makeBarrierSender(): {
  calls: SenderCall[];
  started: Promise<void>;
  release: () => void;
  sender: Sender;
} {
  const calls: SenderCall[] = [];
  const senderId = randomUUID();
  let markStarted!: () => void;
  let releaseSender!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseSender = resolve; });
  return {
    calls,
    started,
    release: () => releaseSender(),
    sender: async (to, subject, body) => {
      calls.push({ to, subject, body });
      markStarted();
      await released;
      return {
        status: "sent",
        failureReason: null,
        externalMessageId: `provider-message-${senderId}-${calls.length}`,
      };
    },
  };
}

function allowAddress(address: string): void {
  const current = new Set(
    (process.env.ONBOARDING_ALLOWED_RECIPIENTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  current.add(address);
  process.env.ONBOARDING_ALLOWED_RECIPIENTS = [...current].join(",");
}

async function createCase(
  organizationId: string,
  options: { candidateAuthorized?: boolean; offline?: boolean } = {},
): Promise<number> {
  const workerEmail = `bgv-candidate-${createdCases.length}-${suffix}@example.test`;
  allowAddress(workerEmail);
  const processPolicySnapshot = organizationId === DEMO_ORGANIZATION_ID
    ? undefined
    : withGovernanceDecisionSnapshot(
      {},
      await governanceSnapshotForNewCase(organizationId),
    );
  const [created] = await db.insert(onbCases).values({
    organizationId,
    workerName: `BGV Regression Candidate ${createdCases.length}`,
    workerEmail,
    channelPreference: "both",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "BGV Regression Co",
    workforceContext: { workCountry: "US" },
    managerName: "Regression Manager",
    recruiterName: "Regression Recruiter",
    joiningDate: "2030-01-01",
    lifecycleStage: "preboarding",
    readiness: [],
    workstreams: [],
    processPolicySnapshot,
    notes: options.offline ? SYNTHETIC_OFFLINE_MARKER : null,
    syntheticProvenance: options.offline ? "synthetic-reset" : null,
    candidateEmailAuthorizedAt: options.candidateAuthorized ? new Date() : null,
    candidateEmailAuthorizedBy: options.candidateAuthorized ? testUser : null,
  }).returning({ id: onbCases.id });
  createdCases.push({ id: created.id, organizationId });
  if (organizationId === orgA) {
    const userGroupId = `bgv-case-user-group-${created.id}-${suffix}`;
    const securityGroupId = `bgv-case-security-group-${created.id}-${suffix}`;
    await db.insert(accessUserGroups).values({
      id: userGroupId,
      organizationId,
      name: userGroupId,
      ownerUserId: accessOwner,
      createdByUserId: testUser,
    });
    await db.insert(accessSecurityGroups).values({
      id: securityGroupId,
      organizationId,
      name: securityGroupId,
      ownerUserId: accessOwner,
      createdByUserId: testUser,
    });
    await db.insert(accessUserGroupMembers).values({
      organizationId,
      groupId: userGroupId,
      principalType: "human",
      principalId: testUser,
      attachedByUserId: testUser,
      requiresApproval: "yes",
      approvedByUserId: accessOwner,
      approvedAt: new Date(),
    });
    await db.insert(accessSecurityGroupUserGroups).values({
      organizationId,
      securityGroupId,
      userGroupId,
      attachedByUserId: testUser,
      requiresApproval: "yes",
      approvedByUserId: accessOwner,
      approvedAt: new Date(),
      approvedPolicyVersion: 1,
    });
    await db.insert(accessSecurityGroupPolicies).values({
      organizationId,
      securityGroupId,
      version: 1,
      policy: {
        fields: ["data.bgv.read", "data.bgv.edit"],
        flows: [],
        tools: ["tool.notification.send"],
      },
      createdByUserId: testUser,
      approvedByUserId: accessOwner,
      approvedAt: new Date(),
    });
    await db.insert(accessSecurityGroupAttachments).values({
      organizationId,
      securityGroupId,
      scope: "case",
      caseId: created.id,
      attachedByUserId: testUser,
      requiresApproval: "yes",
      approvedByUserId: accessOwner,
      approvedAt: new Date(),
      approvedPolicyVersion: 1,
    });
  }
  return created.id;
}

async function establishLiveGovernanceFixture(organizationId: string): Promise<void> {
  await governanceSnapshotForNewCase(organizationId);
  const decisions = await db.select().from(onbGovernanceDecisions).where(
    eq(onbGovernanceDecisions.organizationId, organizationId),
  );
  for (const decision of decisions) {
    const reviewer = `bgv-fixture:${decision.accountableRole}`;
    const [authority] = await db.insert(onbGovernanceAuthorityAssignments).values({
      organizationId,
      authorityRole: decision.accountableRole,
      assigneeUserId: reviewer,
      verificationStatus: "verified",
      verifiedByUserId: "bgv-fixture-operator",
      verificationReference: reviewer,
    }).returning({ id: onbGovernanceAuthorityAssignments.id });
    await db.insert(onbGovernanceDecisionReviews).values({
      organizationId,
      decisionKey: decision.key,
      decisionRevision: decision.revision,
      outcome: "approved",
      reason: "BGV fixture approved decision",
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
}

async function configureCase(
  organizationId: string,
  caseId: number,
  overrides: ConfigOverrides = {},
): Promise<Awaited<ReturnType<typeof getBgvNotifications>>> {
  const current = await getBgvNotifications({ organizationId, caseId, role: "owner" });
  return updateBgvNotifications({
    organizationId,
    caseId,
    role: "owner",
    version: current.version,
    config: configFor(current.version, overrides),
  });
}

type PublicNotification = {
  role: string;
  email: string | null;
  reason: string;
  actualDeliveryState: string;
  liveSendAuthorized: boolean;
  communicationIds: number[];
};
type PublicCycle = {
  cycleId: string;
  episode: "blocked" | "release";
  sourceProvenance: string;
  classifications: string[];
  flags: Flags & {
    delay: boolean;
    missingInfo: boolean;
    discrepancy: boolean;
    reviewRequired: boolean;
  };
  notifications: PublicNotification[];
};

function publicCycle(
  envelope: Awaited<ReturnType<typeof getBgvNotifications>>,
  index = 0,
): PublicCycle {
  const cycle = envelope.cycles[index] as PublicCycle | undefined;
  assert.ok(cycle, `expected public BGV cycle at index ${index}`);
  return cycle;
}

function notificationsByRole(cycle: PublicCycle): Map<string, PublicNotification> {
  return new Map(cycle.notifications.map((notification) => [notification.role, notification]));
}

// Keep this assertion coupled to the generated client operation URL:
// getReconcileOnboardingBgvNotificationsUrl(caseId).
function generatedReconcilePath(caseId: number): string {
  return `/api/onboarding/cases/${caseId}/bgv-notifications/reconcile`;
}

function rowForRole(rows: Array<typeof onbCommunications.$inferSelect>, cycleId: string, role: string) {
  return rows.find((row) => {
    const key = `bgv:${createdCases.find((candidate) => candidate.id === row.caseId)?.id ?? row.caseId}:${cycleId}:${role}:purpose`;
    return row.idempotencyKey === key ||
    row.idempotencyKey === `${key}:simulation` ||
    row.idempotencyKey === `${key}:live`;
  });
}

async function communicationRows(caseId: number) {
  return db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseId));
}

async function routeCall(
  path: string,
  organizationId: string,
  role: "owner" | "admin" | "member",
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-organization-id": organizationId,
      "x-test-role": role,
      "x-test-user": testUser,
      ...(init.headers ?? {}),
    },
  });
}

before(async () => {
  await db.insert(organizationsTable).values([
    {
      id: orgA,
      name: "BGV Notification Regression A",
      slug: orgA,
      joinCodeHash: `hash-${orgA}`,
      createdByUserId: testUser,
    },
    {
      id: orgB,
      name: "BGV Notification Regression B",
      slug: orgB,
      joinCodeHash: `hash-${orgB}`,
      createdByUserId: testUser,
    },
  ]);
  for (const address of Object.values(addresses)) allowAddress(address);
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgA,
    clerkUserId: testUser,
    role: "owner",
  });
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgA,
    clerkUserId: accessOwner,
    role: "owner",
  });
  await db.insert(onbAuthorityGovernance).values({
    organizationId: orgA,
    status: "governance-approved",
    operatorUserId: testUser,
    approvedByUserId: testUser,
    governanceSource: "bgv-test-sensitive-access",
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `bgv-sensitive-access-${suffix}`,
    organizationId: orgA,
    personUserId: testUser,
    authorityRole: "hr-compliance",
    scopes: ["hr-compliance-approve"],
    grantorUserId: testUser,
    source: "test-fixture",
    governanceDecisionRef: "bgv-test-sensitive-access",
  });
  await establishLiveGovernanceFixture(orgA);
  await establishLiveGovernanceFixture(orgB);
  // Live BGV coordination carries opaque copies through case-derived
  // lifecycle handling. The positive fixture must therefore satisfy every
  // class policy at the concrete Gmail provider boundary.
  await db.insert(onbSensitiveLifecyclePolicies).values(
    SENSITIVE_DATA_CLASSES.map((dataClass) => ({
      organizationId: orgA,
      dataClass,
      jurisdiction: "US",
      revision: 1,
      purpose: "Minimal BGV onboarding coordination notices",
      lawfulBasis: "Approved test lifecycle basis",
      retentionDays: 30,
      providerSharingApproved: true,
      permittedProviders: ["gmail"],
      policyReference: `bgv-test-policy-${dataClass}`,
      approvalReference: `bgv-test-approval-${dataClass}`,
      approvedByUserId: testUser,
      approvedAuthorityAssignmentId: 1,
    })),
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = String(req.header("x-organization-id") ?? orgA);
    const requestedRole = req.header("x-test-role");
    req.organizationRole =
      requestedRole === "admin" || requestedRole === "member" ? requestedRole : "owner";
    req.authUserId = testUser;
    next();
  });
  app.use(onboardingRouter);
  // Mount the same router under the generated client URL prefix so the
  // route regression below catches accidental path drift.
  app.use("/api", onboardingRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: String(error) });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const caseIds = createdCases.map(({ id }) => id);
  // Both organizations are suite-owned, even if a future focused selection
  // creates no cases for one of them. Remove every ordinary settings row they
  // created (including background-worker/checkpoint rows), not only BGV
  // notification settings, before their organization rows are removed.
  const organizationIds = [orgA, orgB];
  if (caseIds.length > 0) {
    await db.delete(onbConnectors).where(inArray(onbConnectors.organizationId, organizationIds));
    await db.delete(onbWatchEmails).where(inArray(onbWatchEmails.caseId, caseIds));
    await db.delete(onbEvents).where(inArray(onbEvents.caseId, caseIds));
    await db.delete(onbApprovals).where(inArray(onbApprovals.caseId, caseIds));
    await db.delete(onbEffectJournal).where(inArray(onbEffectJournal.caseId, caseIds));
    await db.delete(onbCommunications).where(inArray(onbCommunications.caseId, caseIds));
    await db.delete(onbSystemChecks).where(inArray(onbSystemChecks.caseId, caseIds));
    await db.delete(onbCases).where(inArray(onbCases.id, caseIds));
  }
  await db.delete(onbSettings).where(inArray(onbSettings.organizationId, organizationIds));
  await db.delete(onbReadinessSlaPolicies).where(inArray(onbReadinessSlaPolicies.organizationId, [orgA, orgB]));
  await db.delete(onbSensitiveLifecyclePolicies).where(inArray(
    onbSensitiveLifecyclePolicies.organizationId,
    [orgA, orgB],
  ));
  await db.delete(onbAuthorityAssignments).where(inArray(
    onbAuthorityAssignments.organizationId,
    [orgA, orgB],
  ));
  await db.delete(onbGovernanceDispatchMarkers).where(inArray(
    onbGovernanceDispatchMarkers.organizationId,
    [orgA, orgB],
  ));
  await db.delete(onbGovernanceDecisionReviews).where(inArray(
    onbGovernanceDecisionReviews.organizationId,
    [orgA, orgB],
  ));
  await db.delete(onbGovernanceAuthorityAssignments).where(inArray(
    onbGovernanceAuthorityAssignments.organizationId,
    [orgA, orgB],
  ));
  await db.delete(onbGovernanceRequirements).where(inArray(
    onbGovernanceRequirements.organizationId,
    [orgA, orgB],
  ));
  await db.delete(onbGovernanceDecisions).where(inArray(
    onbGovernanceDecisions.organizationId,
    [orgA, orgB],
  ));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgA, orgB]));
  if (oldAllowedRecipients === undefined) delete process.env.ONBOARDING_ALLOWED_RECIPIENTS;
  else process.env.ONBOARDING_ALLOWED_RECIPIENTS = oldAllowedRecipients;
});

test("case fence blocks on the same PostgreSQL advisory key across independent clients", async () => {
  const lockOrganization = `bgv-lock-${suffix}`;
  const lockCaseId = 900000 + Math.floor(Math.random() * 1000);
  const key = `bgv-notifications:${lockOrganization}:${lockCaseId}`;
  const remoteClient = await pool.connect();
  let workerEntered = false;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let releaseWorker!: () => void;
  const holdWorker = new Promise<void>((resolve) => { releaseWorker = resolve; });
  try {
    await remoteClient.query("select pg_advisory_lock(hashtext($1))", [key]);
    const worker = withBgvNotificationCaseFence(
      lockOrganization,
      lockCaseId,
      async () => {
        workerEntered = true;
        markEntered();
        await holdWorker;
        return "entered";
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(workerEntered, false, "worker must wait for a remote session lock");
    await remoteClient.query("select pg_advisory_unlock(hashtext($1))", [key]);
    await entered;
    const availableResult = await db.execute<{ available: number }>(
      sql`select 1 as available`,
    );
    assert.equal(
      Number(availableResult.rows[0]?.available),
      1,
      "main work pool remains available while the lock is held",
    );
    releaseWorker();
    assert.equal(await worker, "entered");
  } finally {
    releaseWorker?.();
    try {
      await remoteClient.query("select pg_advisory_unlock(hashtext($1))", [key]);
    } catch {
      // The explicit unlock above may already have released it.
    }
    remoteClient.release();
  }
});

test("trusted exception creates a live compliance cycle after simulated history", async () => {
  const caseId = await createCase(orgA, { candidateAuthorized: true });
  await configureCase(orgA, caseId);
  const [check] = await db.insert(onbSystemChecks).values({
    organizationId: orgA,
    caseId,
    system: "bgv",
    mode: "email",
    externalRef: `BGV-PROVENANCE-${caseId}`,
    status: "overdue",
    dueAt: new Date(Date.now() - 60_000),
    note: "generic provider timeout",
  }).returning();
  const simulated = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "status-email",
    provenance: "simulated",
    reason: "generic provider timeout",
  });
  const simulatedCycle = publicCycle(simulated);
  const simulatedHr = rowForRole(
    await communicationRows(caseId),
    simulatedCycle.cycleId,
    "hr",
  );
  assert.equal(simulatedHr?.status, "simulated");

  const sender = makeSender();
  const trusted = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "generic exception requires restricted review",
    classifications: ["discrepancy", "review-required"],
    sender: sender.sender,
  });
  const trustedCycle = publicCycle(trusted);
  assert.equal(trustedCycle.sourceProvenance, "trusted-provider");
  assert.notEqual(trustedCycle.cycleId, simulatedCycle.cycleId);
  assert.equal(
    notificationsByRole(trustedCycle).get("compliance")?.actualDeliveryState,
    "sent",
  );
  const rows = await communicationRows(caseId);
  assert.equal(
    rows.filter((row) =>
      row.idempotencyKey?.includes(`:${simulatedCycle.cycleId}:hr:purpose`),
    ).length,
    1,
  );
  assert.equal(
    rows.find((row) =>
      row.idempotencyKey?.includes(`:${trustedCycle.cycleId}:compliance:purpose`),
    )?.status,
    "sent",
  );
  assert.ok(sender.calls.some((call) => call.to === addresses.compliance));
  assert.ok(sender.calls.some((call) => call.to === addresses.hr),
    "simulated HR history must not suppress the first real HR notice");
  assert.equal(notificationsByRole(trustedCycle).get("hr")?.actualDeliveryState, "sent");
  assert.ok(sender.calls.every((call) => !call.body.includes("generic exception")));
  assert.equal(check.status, "overdue");
});

test("trusted provider notices include all required stakeholders without exposing private finding details", async () => {
  const caseId = await createCase(orgA, { candidateAuthorized: true });
  const configured = await configureCase(orgA, caseId);
  const sender = makeSender();
  const result = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "raw adverse finding SSN-RAW-REGRESSION-123 requires restricted review",
    sender: sender.sender,
  });
  const cycle = publicCycle(result);
  const notifications = notificationsByRole(cycle);

  assert.equal(configured.version, 2);
  assert.equal(cycle.sourceProvenance, "trusted-provider");
  assert.deepEqual([...notifications.keys()], [
    "hr",
    "bgvTeam",
    "recruiter",
    "hiringManager",
    "compliance",
    "candidate",
  ]);
  assert.deepEqual(cycle.classifications, ["discrepancy", "review-required"]);
  assert.deepEqual(cycle.flags, {
    delay: false,
    missingInfo: false,
    discrepancy: true,
    reviewRequired: true,
    candidateActionRequired: true,
    providerActionRequired: true,
    startDateAtRisk: true,
    coordinationRequired: true,
    dependentWorkOnHold: true,
  });
  assert.equal(notifications.get("hr")?.reason, "authorized");
  assert.equal(notifications.get("hr")?.actualDeliveryState, "sent");
  assert.equal(notifications.get("hr")?.liveSendAuthorized, true);
  assert.equal(notifications.get("bgvTeam")?.actualDeliveryState, "simulated");
  assert.equal(sender.calls.length, 5);
  assert.equal(result.policy.rawFindingsExposed, false);
  assert.equal(result.policy.automaticEmploymentDecision, false);
  assert.equal(result.policy.bGVClearAuthorityChanged, false);

  const rows = await communicationRows(caseId);
  assert.equal(rows.length, 9, "six stakeholder rows plus three simulated internal holds");
  assert.ok(rows.every((row) => row.sensitive));
  assert.ok(rows.every((row) => !row.body.includes("SSN-RAW-REGRESSION-123")));
  assert.ok(rows.every((row) => !row.body.includes("raw adverse finding")));
  const liveRows = rows.filter((row) => row.status === "sent");
  assert.equal(liveRows.length, 5);
  assert.ok(liveRows.every((row) => row.externalMessageId?.startsWith("provider-message-")));
  const complianceRow = rows.find((row) => row.idempotencyKey?.includes(":compliance:purpose"));
  assert.ok(complianceRow?.sensitive);
  assert.match(complianceRow?.body ?? "", /restricted case state requires human review/i);
  assert.doesNotMatch(complianceRow?.body ?? "", /SSN-RAW-REGRESSION-123/);
  const stakeholderRows = rows.filter((row) => !row.idempotencyKey?.includes(":internal:"));
  assert.ok(stakeholderRows.every((row) =>
    row.subject?.includes(`Case #${caseId}`) &&
    row.body.includes(`Case #${caseId}`),
  ));
  assert.ok(stakeholderRows.every((row) =>
    !row.body.includes("BGV Regression Candidate") &&
    !row.body.includes("2030-01-01"),
  ));
  assert.doesNotMatch(complianceRow?.body ?? "", /BGV workspace|authorized review workspace/i);

  const effects = await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.caseId, caseId));
  assert.equal(effects.length, 5);
  assert.ok(effects.every((effect) =>
    effect.toolName === "send-bgv-notification" &&
    effect.providerIdempotency === false &&
    effect.status === "confirmed" &&
    effect.externalEffectId?.startsWith("provider-message-"),
  ));
});

test("an injected BGV sender is fenced by the exact approved Gmail lifecycle provider", async () => {
  const caseId = await createCase(orgB, { candidateAuthorized: true });
  await configureCase(orgB, caseId, {
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(null, false, false),
    hiringManager: recipient(null, false, false),
    compliance: recipient(null, false, false),
    candidate: { enabled: false, purposeAuthorized: false },
  });
  const sender = makeSender();
  const [storedCase] = await db.select({ workforceContext: onbCases.workforceContext })
    .from(onbCases)
    .where(eq(onbCases.id, caseId));
  assert.deepEqual(storedCase?.workforceContext, { workCountry: "US" });

  const denied = await recordBgvBlockedEpisode({
    organizationId: orgB,
    caseId,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "provider exception requires review",
    sender: sender.sender,
  });
  assert.equal(sender.calls.length, 0);
  const deniedHr = rowForRole(await communicationRows(caseId), publicCycle(denied).cycleId, "hr");
  // Collection is denied before a BGV communication row is created; a
  // lifecycle-policy absence must not be converted into retained evidence.
  assert.equal(deniedHr, undefined);

  const [wrongProviderPolicy] = await db.insert(onbSensitiveLifecyclePolicies).values({
    organizationId: orgB,
    dataClass: "bgv",
    jurisdiction: "US",
    revision: 1,
    purpose: "Minimal BGV onboarding coordination notices",
    lawfulBasis: "Approved test lifecycle basis",
    retentionDays: 30,
    providerSharingApproved: true,
    permittedProviders: ["not-gmail"],
    policyReference: "bgv-wrong-provider-test-policy",
    approvalReference: "bgv-wrong-provider-test-approval",
    approvedByUserId: testUser,
    approvedAuthorityAssignmentId: 1,
  }).returning();
  assert.equal(wrongProviderPolicy.isCurrent, true);
  const wrongProviderGate = await evaluateSensitiveLifecycleGate({
    organizationId: orgB,
    jurisdiction: "US",
    dataClass: "bgv",
    disclosure: true,
    providerId: "gmail",
  });
  assert.equal(wrongProviderGate.allowed, false);
  assert.match(
    wrongProviderGate.reason ?? "",
    /does not authorize this concrete provider disclosure/i,
  );
  // Keep the wrong-provider assertion isolated to BGV. All other classes are
  // approved for Gmail before the concrete BGV provider policy is corrected.
  await db.insert(onbSensitiveLifecyclePolicies).values(
    SENSITIVE_DATA_CLASSES
      .filter((dataClass) => dataClass !== "bgv")
      .map((dataClass) => ({
        organizationId: orgB,
        dataClass,
        jurisdiction: "US",
        revision: 1,
        purpose: "Minimal BGV onboarding coordination notices",
        lawfulBasis: "Approved test lifecycle basis",
        retentionDays: 30,
        providerSharingApproved: true,
        permittedProviders: ["gmail"],
        policyReference: `bgv-wrong-provider-supporting-policy-${dataClass}`,
        approvalReference: `bgv-wrong-provider-supporting-approval-${dataClass}`,
        approvedByUserId: testUser,
        approvedAuthorityAssignmentId: 1,
      })),
  );
  const wrongProviderCase = await createCase(orgB, { candidateAuthorized: true });
  await configureCase(orgB, wrongProviderCase, {
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(null, false, false),
    hiringManager: recipient(null, false, false),
    compliance: recipient(null, false, false),
    candidate: { enabled: false, purposeAuthorized: false },
  });
  const wrongProvider = await recordBgvBlockedEpisode({
    organizationId: orgB,
    caseId: wrongProviderCase,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "provider exception requires review",
    sender: sender.sender,
  });
  assert.equal(sender.calls.length, 0);
  const wrongProviderHr = rowForRole(
    await communicationRows(wrongProviderCase),
    publicCycle(wrongProvider).cycleId,
    "hr",
  );
  assert.equal(wrongProviderHr?.status, "logged-only");
  assert.match(
    wrongProviderHr?.failureReason ?? "",
    /does not authorize this concrete provider disclosure/i,
  );

  await db.update(onbSensitiveLifecyclePolicies).set({
    permittedProviders: ["gmail"],
  }).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, orgB),
    eq(onbSensitiveLifecyclePolicies.dataClass, "bgv"),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
  ));
  const approvedCase = await createCase(orgB, { candidateAuthorized: true });
  await configureCase(orgB, approvedCase, {
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(null, false, false),
    hiringManager: recipient(null, false, false),
    compliance: recipient(null, false, false),
    candidate: { enabled: false, purposeAuthorized: false },
  });
  const approved = await recordBgvBlockedEpisode({
    organizationId: orgB,
    caseId: approvedCase,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "provider exception requires review",
    sender: sender.sender,
  });
  assert.equal(sender.calls.length, 1);
  const approvedHr = rowForRole(
    await communicationRows(approvedCase),
    publicCycle(approved).cycleId,
    "hr",
  );
  assert.equal(approvedHr?.status, "sent");
  assert.ok(sender.calls.every((call) =>
    !/provider exception|discrepancy|adverse|BGV Regression Candidate/i.test(call.body),
  ));
});

test("manual simulation keeps a separate history row from later live delivery", async () => {
  const caseId = await createCase(orgA, { candidateAuthorized: true });
  const disabledRecipients = {
    hr: recipient(addresses.hr, false),
    bgvTeam: recipient(addresses.bgvTeam, false),
    recruiter: recipient(addresses.recruiter, false),
    hiringManager: recipient(addresses.hiringManager, false),
    compliance: recipient(addresses.compliance, false),
    candidate: { enabled: false, purposeAuthorized: true },
  };
  await configureCase(orgA, caseId, disabledRecipients);
  await db.insert(onbSystemChecks).values({
    organizationId: orgA,
    caseId,
    system: "bgv",
    mode: "poll",
    externalRef: `BGV-SIMULATION-HISTORY-${caseId}`,
    status: "overdue",
    dueAt: new Date(Date.now() - 60_000),
    note: "history fixture",
  });
  await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "scheduled-poll",
    provenance: "trusted-provider",
    reason: "verification delay",
  });
  await configureCase(orgA, caseId);
  await reconcileBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    reason: "manual",
    simulation: true,
  });

  const simulatedRows = await communicationRows(caseId);
  const simulatedHr = simulatedRows.find((row) =>
    row.idempotencyKey?.endsWith(":hr:purpose:simulation"));
  assert.equal(simulatedHr?.status, "simulated");
  assert.equal(simulatedHr?.externalMessageId, null);

  const sender = makeSender();
  const live = await reconcileBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    reason: "manual",
    sender: sender.sender,
  });
  const rows = await communicationRows(caseId);
  const hrRows = rows.filter((row) =>
    row.idempotencyKey?.includes(":hr:purpose"));
  assert.deepEqual(hrRows.map((row) => row.status).sort(), ["sent", "simulated"]);
  assert.ok(sender.calls.length >= 4);
  const hrNotification = notificationsByRole(publicCycle(live)).get("hr");
  assert.equal(hrNotification?.actualDeliveryState, "sent");
  assert.equal(hrNotification?.communicationIds.length, 2);
  assert.equal(hrNotification?.email, addresses.hr);
  assert.ok(hrNotification?.communicationIds.includes(simulatedHr!.id));
  assert.ok(rows.filter((row) => row.status === "simulated").every((row) =>
    row.externalMessageId === null));
});

test("historical delivery keeps its original recipient after configuration changes", async () => {
  const caseId = await createCase(orgA, { candidateAuthorized: true });
  const oldRecipient = `bgv-old-hr-${suffix}@example.test`;
  const newRecipient = `bgv-new-hr-${suffix}@example.test`;
  allowAddress(oldRecipient);
  allowAddress(newRecipient);
  await configureCase(orgA, caseId, {
    hr: recipient(oldRecipient),
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(null, false, false),
    hiringManager: recipient(null, false, false),
    compliance: recipient(null, false, false),
    candidate: { enabled: false, purposeAuthorized: false },
  });
  await db.insert(onbSystemChecks).values({
    organizationId: orgA,
    caseId,
    system: "bgv",
    mode: "poll",
    externalRef: `BGV-RECIPIENT-HISTORY-${caseId}`,
    status: "overdue",
    dueAt: new Date(Date.now() - 60_000),
    note: "recipient history fixture",
  });
  const sender = makeSender();
  const delivered = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "verification delay",
    sender: sender.sender,
  });
  assert.equal(sender.calls[0]?.to, oldRecipient);
  assert.equal(notificationsByRole(publicCycle(delivered)).get("hr")?.email, oldRecipient);

  const current = await getBgvNotifications({ organizationId: orgA, caseId, role: "owner" });
  await updateBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    version: current.version,
    config: configFor(current.version, {
      hr: recipient(newRecipient),
      bgvTeam: recipient(null, false, false),
      recruiter: recipient(null, false, false),
      hiringManager: recipient(null, false, false),
      compliance: recipient(null, false, false),
      candidate: { enabled: false, purposeAuthorized: false },
    }),
  });
  const after = await getBgvNotifications({ organizationId: orgA, caseId, role: "owner" });
  const hrNotification = notificationsByRole(publicCycle(after)).get("hr");
  assert.equal(hrNotification?.email, oldRecipient);
  assert.equal(hrNotification?.actualDeliveryState, "sent");
  assert.equal(hrNotification?.communicationIds.length, 1);
});

test("candidate and manager-impact gates are closed until their policy flags are enabled", async () => {
  const caseId = await createCase(orgA, { candidateAuthorized: true });
  const initial = await configureCase(orgA, caseId, {
    flags: {
      candidateActionRequired: false,
      providerActionRequired: false,
      startDateAtRisk: false,
      coordinationRequired: false,
      dependentWorkOnHold: false,
    },
  });
  const sender = makeSender();
  const first = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "scheduled-poll",
    provenance: "trusted-provider",
    reason: "provider delay",
    sender: sender.sender,
  });
  const closed = notificationsByRole(publicCycle(first));
  assert.deepEqual([...closed.keys()], ["hr", "bgvTeam"]);
  assert.equal(closed.has("candidate"), false);
  assert.equal(closed.has("recruiter"), false);
  assert.equal(closed.has("hiringManager"), false);

  const opened = await updateBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    version: initial.version,
    config: configFor(initial.version, {
      flags: {
        candidateActionRequired: true,
        providerActionRequired: true,
        startDateAtRisk: true,
        coordinationRequired: true,
        dependentWorkOnHold: true,
      },
    }),
  });
  const reconciled = await reconcileBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    reason: "manual",
    sender: sender.sender,
  });
  const enabled = notificationsByRole(publicCycle(reconciled));
  assert.equal(opened.version, 3);
  assert.equal(enabled.get("candidate")?.reason, "authorized");
  assert.equal(enabled.get("recruiter")?.reason, "authorized");
  assert.equal(enabled.get("hiringManager")?.reason, "authorized");
  assert.equal(sender.calls.length, 4, "HR plus three newly enabled live stakeholder sends");
});

test("missing recipients and authorization failures remain explicit, with no fabricated delivery", async () => {
  const caseId = await createCase(orgA);
  await configureCase(orgA, caseId, {
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(addresses.recruiter, true, false),
    candidate: { enabled: true, purposeAuthorized: true },
  });
  const sender = makeSender();
  const result = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "overdue",
    provenance: "trusted-provider",
    reason: "missing candidate information",
    sender: sender.sender,
  });
  const notifications = notificationsByRole(publicCycle(result));
  assert.equal(notifications.get("bgvTeam")?.reason, "missing-recipient");
  assert.equal(notifications.get("bgvTeam")?.actualDeliveryState, "missing-recipient");
  assert.equal(notifications.get("recruiter")?.reason, "live-authorization-required");
  assert.equal(notifications.get("candidate")?.reason, "candidate-email-authorization-required");
  assert.equal(notifications.get("candidate")?.actualDeliveryState, "skipped");
  assert.equal(sender.calls.length, 2, "HR and authorized hiring-manager notices only");

  const rows = await communicationRows(caseId);
  assert.equal(rows.filter((row) => row.idempotencyKey?.includes(":bgvTeam:purpose")).length, 0);
  const skipped = rows.filter((row) =>
    row.idempotencyKey?.includes(":recruiter:purpose") ||
    row.idempotencyKey?.includes(":candidate:purpose"),
  );
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((row) =>
    row.status === "skipped" &&
    /live-authorization-required|candidate-email-authorization-required/.test(row.failureReason ?? ""),
  ));
});

test("offline, demo, and ordinary simulated cases never reach the sender", async () => {
  const offlineCase = await createCase(orgA, { candidateAuthorized: true });
  await configureCase(orgA, offlineCase);
  const configuredOffline = await getBgvNotifications({
    organizationId: orgA,
    caseId: offlineCase,
    role: "owner",
  });
  await db.update(onbCases)
    .set({
      notes: SYNTHETIC_OFFLINE_MARKER,
      syntheticProvenance: "synthetic-reset",
    })
    .where(eq(onbCases.id, offlineCase));
  const offlineBefore = await getBgvNotifications({
    organizationId: orgA,
    caseId: offlineCase,
    role: "owner",
  });
  assert.equal(offlineBefore.authority.offline, true);
  assert.equal(offlineBefore.authority.canManage, true);
  assert.equal(offlineBefore.authority.reason, "Paused offline case is read-only.");
  const [offlineSettingBefore] = await db.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, orgA),
    eq(onbSettings.key, `${BGV_NOTIFICATION_SETTING_PREFIX}${offlineCase}`),
  ));
  const offlineSender = makeSender();
  const offlineResult = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId: offlineCase,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "offline adverse state",
    sender: offlineSender.sender,
  });
  assert.equal(offlineResult.cycles.length, 0);
  assert.equal(offlineSender.calls.length, 0);
  await reconcileBgvNotifications({
    organizationId: orgA,
    caseId: offlineCase,
    reason: "heartbeat",
  });
  assert.equal((await communicationRows(offlineCase)).length, 0);
  const [offlineSettingAfter] = await db.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, orgA),
    eq(onbSettings.key, `${BGV_NOTIFICATION_SETTING_PREFIX}${offlineCase}`),
  ));
  assert.equal(offlineSettingAfter?.value, offlineSettingBefore?.value);
  await assert.rejects(
    reconcileBgvNotifications({
      organizationId: orgA,
      caseId: offlineCase,
      role: "owner",
      reason: "manual",
    }),
    BgvNotificationConflictError,
  );
  await assert.rejects(
    updateBgvNotifications({
      organizationId: orgA,
      caseId: offlineCase,
      role: "owner",
      version: configuredOffline.version,
      config: configuredOffline.config,
    }),
    BgvNotificationConflictError,
  );

  const demoCase = await createCase(DEMO_ORGANIZATION_ID, { candidateAuthorized: true });
  await configureCase(DEMO_ORGANIZATION_ID, demoCase);
  const demoSender = makeSender();
  const demoResult = await recordBgvBlockedEpisode({
    organizationId: DEMO_ORGANIZATION_ID,
    caseId: demoCase,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "demo adverse state",
    sender: demoSender.sender,
  });
  assert.equal(demoSender.calls.length, 0);
  assert.ok((await communicationRows(demoCase)).every((row) => row.status === "simulated"));
  const demoMember = await getBgvNotifications({
    organizationId: DEMO_ORGANIZATION_ID,
    caseId: demoCase,
    role: "member",
  });
  assert.equal(demoMember.authority.offline, false);
  assert.equal(demoMember.authority.canManage, true);
  assert.equal(demoMember.authority.reason, "Demo notifications are simulation-only.");
  const demoUpdated = await updateBgvNotifications({
    organizationId: DEMO_ORGANIZATION_ID,
    caseId: demoCase,
    role: "member",
    version: demoMember.version,
    config: demoMember.config,
  });
  assert.equal(demoUpdated.version, demoMember.version + 1);
  const demoSimulation = await reconcileBgvNotifications({
    organizationId: DEMO_ORGANIZATION_ID,
    caseId: demoCase,
    role: "member",
    reason: "manual",
    simulation: true,
    sender: demoSender.sender,
  });
  assert.equal(demoSimulation.authority.offline, false);
  assert.equal(demoSender.calls.length, 0);

  const simulatedCase = await createCase(orgA, { candidateAuthorized: true });
  await configureCase(orgA, simulatedCase);
  await db.insert(onbSystemChecks).values({
    organizationId: orgA,
    caseId: simulatedCase,
    system: "bgv",
    mode: "poll",
    externalRef: `BGV-SYNTHETIC-${simulatedCase}`,
    status: "overdue",
    dueAt: new Date(),
    note: "ordinary synthetic fixture",
  });
  const simulationSender = makeSender();
  const simulatedResult = await reconcileBgvNotifications({
    organizationId: orgA,
    caseId: simulatedCase,
    role: "owner",
    reason: "manual",
    simulation: true,
    sender: simulationSender.sender,
  });
  assert.equal(publicCycle(simulatedResult).sourceProvenance, "simulated");
  assert.equal(simulationSender.calls.length, 0);
  assert.ok((await communicationRows(simulatedCase)).every((row) => row.status === "simulated"));
});

test("ordinary members cannot forge heartbeat/startup reasons, and admin reconcile follows the generated POST path", async () => {
  const caseId = await createCase(orgA);
  const reconcilePath = generatedReconcilePath(caseId);
  assert.equal(
    reconcilePath,
    `/api/onboarding/cases/${caseId}/bgv-notifications/reconcile`,
  );

  for (const reason of ["heartbeat", "startup"] as const) {
    const forged = await routeCall(reconcilePath, orgA, "member", {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    assert.equal(forged.status, 403, `forged ${reason} must remain forbidden`);
    const body = await forged.json() as { message?: string };
    assert.match(body.message ?? "", /HR\/compliance specialist authority|owner or admin/i);
  }

  const admin = await routeCall(reconcilePath, orgA, "admin", {
    method: "POST",
    body: JSON.stringify({ reason: "heartbeat" }),
  });
  assert.equal(admin.status, 200);
  const result = await admin.json() as {
    caseId?: number;
    authority?: { canManage?: boolean };
  };
  assert.equal(result.caseId, caseId);
  assert.equal(result.authority?.canManage, true);
});

test("ordinary-tenant vendor-email simulation is never trusted and never live-sends", async () => {
  const caseId = await createCase(orgA, { candidateAuthorized: true });
  await configureCase(orgA, caseId);
  const [check] = await db.insert(onbSystemChecks).values({
    organizationId: orgA,
    caseId,
    system: "bgv",
    mode: "email",
    externalRef: `BGV-SIMULATED-${caseId}`,
    status: "pending",
    dueAt: new Date(Date.now() + 60_000),
    note: "ordinary email-watch fixture",
  }).returning();

  const response = await routeCall("/api/onboarding/systems/email-watch/simulate", orgA, "member", {
    method: "POST",
    body: JSON.stringify({
      caseId,
      system: "bgv",
      outcome: "exception",
    }),
  });
  assert.equal(response.status, 200);
  const responseBody = await response.json() as { ok?: boolean; message?: string };
  assert.equal(responseBody.ok, true);
  assert.match(responseBody.message ?? "", /escalated/i);

  const [updatedCheck] = await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.id, check.id));
  assert.equal(updatedCheck.status, "overdue");
  const result = await getBgvNotifications({ organizationId: orgA, caseId, role: "owner" });
  const cycle = publicCycle(result);
  assert.equal(cycle.sourceProvenance, "simulated");
  assert.deepEqual(cycle.classifications, ["discrepancy", "review-required"]);
  const rows = await communicationRows(caseId);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.status === "simulated"));
  assert.ok(rows.every((row) => row.externalMessageId === null));
  assert.equal(
    (await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.caseId, caseId))).length,
    0,
    "simulation must not claim an external provider effect",
  );
});

test("an already-overdue explicit exception adds compliance without duplicating HR", async () => {
  const caseId = await createCase(orgA, { candidateAuthorized: true });
  await configureCase(orgA, caseId);
  const [check] = await db.insert(onbSystemChecks).values({
    organizationId: orgA,
    caseId,
    system: "bgv",
    mode: "email",
    externalRef: `BGV-OVERDUE-${caseId}`,
    status: "overdue",
    dueAt: new Date(Date.now() - 60_000),
    note: "routine timeout",
  }).returning();
  const sender = makeSender();

  const initial = await reconcileBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    reason: "manual",
    simulation: true,
    sender: sender.sender,
  });
  assert.deepEqual(publicCycle(initial).classifications, ["delay"]);
  const initialRows = await communicationRows(caseId);
  assert.equal(initialRows.filter((row) => row.idempotencyKey?.includes(":hr:purpose")).length, 1);

  await escalateCheck(
    check,
    "Routine vendor status update requires an explicit exception review.",
    "email",
    "status-email",
    "simulated",
    ["discrepancy", "review-required"],
  );

  const reconciled = await getBgvNotifications({ organizationId: orgA, caseId, role: "owner" });
  const cycle = publicCycle(reconciled);
  assert.deepEqual(cycle.classifications, ["delay", "discrepancy", "review-required"]);
  assert.equal(notificationsByRole(cycle).get("compliance")?.actualDeliveryState, "simulated");
  const rows = await communicationRows(caseId);
  assert.equal(rows.filter((row) => row.idempotencyKey?.includes(":hr:purpose")).length, 1);
  assert.equal(rows.filter((row) => row.idempotencyKey?.includes(":compliance:purpose")).length, 1);
  assert.equal(sender.calls.length, 0, "simulation and explicit exception handling must not call a provider");
});

test("stale BGV check source is fenced before a newly authorized dispatch", async () => {
  const caseId = await createCase(orgA, { candidateAuthorized: true });
  const emptyRecipients = {
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(null, false, false),
    hiringManager: recipient(null, false, false),
    compliance: recipient(null, false, false),
    candidate: { enabled: false, purposeAuthorized: false },
  };
  await configureCase(orgA, caseId, {
    ...emptyRecipients,
    hr: recipient(null, false, false),
  });
  const [check] = await db.insert(onbSystemChecks).values({
    organizationId: orgA,
    caseId,
    system: "bgv",
    mode: "poll",
    externalRef: `BGV-FENCE-${caseId}`,
    status: "overdue",
    dueAt: new Date(Date.now() - 60_000),
    note: "routine timeout",
  }).returning();
  await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "scheduled-poll",
    provenance: "trusted-provider",
    reason: "routine timeout",
  });
  const beforeConfig = await getBgvNotifications({ organizationId: orgA, caseId, role: "owner" });
  await configureCase(orgA, caseId, {
    ...emptyRecipients,
    hr: recipient(addresses.hr),
  });
  await db.update(onbSystemChecks)
    .set({ lastCheckedAt: new Date() })
    .where(eq(onbSystemChecks.id, check.id));

  const sender = makeSender();
  await reconcileBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    reason: "manual",
    sender: sender.sender,
  });
  assert.equal(sender.calls.length, 0);
  const rows = await communicationRows(caseId);
  assert.equal(rows.filter((row) => row.idempotencyKey?.includes(":hr:purpose")).length, 0);
  const afterConfig = await getBgvNotifications({ organizationId: orgA, caseId, role: "owner" });
  assert.equal(afterConfig.version, beforeConfig.version + 1);
  assert.equal(publicCycle(afterConfig).sourceProvenance, "trusted-provider");
  assert.ok(rows.some((row) => row.idempotencyKey?.includes(":internal:")));
});

test("case dispatch fence keeps same-case configuration mutation behind a stubbed send", async () => {
  const caseId = await createCase(orgA, { candidateAuthorized: true });
  const emptyRecipients = {
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(null, false, false),
    hiringManager: recipient(null, false, false),
    compliance: recipient(null, false, false),
    candidate: { enabled: false, purposeAuthorized: false },
  };
  await configureCase(orgA, caseId, {
    ...emptyRecipients,
    hr: recipient(addresses.hr),
  });
  await db.insert(onbSystemChecks).values({
    organizationId: orgA,
    caseId,
    system: "bgv",
    mode: "poll",
    externalRef: `BGV-BARRIER-${caseId}`,
    status: "overdue",
    dueAt: new Date(Date.now() - 60_000),
    note: "barrier fixture",
  });
  const barrier = makeBarrierSender();
  const dispatch = recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "scheduled-poll",
    provenance: "trusted-provider",
    reason: "barrier fixture",
    sender: barrier.sender,
  });
  await barrier.started;

  const loaded = await getBgvNotifications({ organizationId: orgA, caseId, role: "owner" });
  let updateSettled = false;
  const update = updateBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    version: loaded.version,
    config: loaded.config,
  }).finally(() => {
    updateSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updateSettled, false, "same-case config writes wait for the active dispatch fence");
  barrier.release();
  await dispatch;
  const updated = await update;
  assert.equal(updated.version, loaded.version + 1);
  assert.equal(barrier.calls.length, 1);
});

test("concurrent reconciliation keeps one cycle, one communication, and one provider record", async () => {
  const caseId = await createCase(orgA);
  await configureCase(orgA, caseId, {
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(null, false, false),
    hiringManager: recipient(null, false, false),
    compliance: recipient(null, false, false),
    candidate: { enabled: false, purposeAuthorized: false },
  });
  const sender = makeSender("sent", 25);
  const [first, second] = await Promise.all([
    recordBgvBlockedEpisode({
      organizationId: orgA,
      caseId,
      source: "webhook",
      provenance: "trusted-provider",
      reason: "verification delay",
      sender: sender.sender,
    }),
    recordBgvBlockedEpisode({
      organizationId: orgA,
      caseId,
      source: "webhook",
      provenance: "trusted-provider",
      reason: "verification delay",
      sender: sender.sender,
    }),
  ]);
  assert.equal(sender.calls.length, 1);
  assert.equal(first.cycles.length, 1);
  assert.equal(second.cycles.length, 1);
  const rows = await communicationRows(caseId);
  assert.equal(rows.filter((row) => row.idempotencyKey?.includes(":hr:purpose")).length, 1);
  assert.equal(rows.filter((row) => row.idempotencyKey?.includes(":internal:")).length, 3);
  const [hrRow] = rows.filter((row) => row.idempotencyKey?.includes(":hr:purpose"));
  assert.equal(hrRow.status, "sent");
  assert.match(hrRow.externalMessageId ?? "", /^provider-message-/);
  const [effect] = await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.caseId, caseId));
  assert.equal(effect.providerIdempotency, false);
  assert.match(effect.externalEffectId ?? "", /^provider-message-/);
});

test("release starts a new episode, re-block starts another, and stale blocked cycles are not replayed", async () => {
  const caseId = await createCase(orgA);
  await configureCase(orgA, caseId, {
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(null, false, false),
    hiringManager: recipient(null, false, false),
    compliance: recipient(null, false, false),
    candidate: { enabled: false, purposeAuthorized: false },
  });
  const sender = makeSender();
  const blocked = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "verification delay",
    sender: sender.sender,
  });
  const blockedCycleId = publicCycle(blocked).cycleId;
  const blockedRows = (await communicationRows(caseId)).filter((row) =>
    row.idempotencyKey?.includes(`:${blockedCycleId}:`),
  );
  assert.equal(blockedRows.length, 5, "HR, candidate authorization hold, and three internal simulations");

  const released = await recordBgvReleaseEpisode({
    organizationId: orgA,
    caseId,
    source: "webhook",
    provenance: "trusted-provider",
    sender: sender.sender,
  });
  const releaseCycleId = publicCycle(released).cycleId;
  assert.equal(publicCycle(released).episode, "release");
  assert.notEqual(releaseCycleId, blockedCycleId);
  const afterReleaseReconcile = await reconcileBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    reason: "manual",
    sender: sender.sender,
  });
  assert.equal(publicCycle(afterReleaseReconcile).cycleId, releaseCycleId);
  assert.equal(
    (await communicationRows(caseId)).filter((row) => row.idempotencyKey?.includes(`:${blockedCycleId}:`)).length,
    blockedRows.length,
  );

  const reblocked = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "reopened",
    provenance: "trusted-provider",
    reason: "provider delay after release",
    sender: sender.sender,
  });
  const reblockedCycleId = publicCycle(reblocked).cycleId;
  assert.equal(publicCycle(reblocked).episode, "blocked");
  assert.notEqual(reblockedCycleId, blockedCycleId);
  assert.notEqual(reblockedCycleId, releaseCycleId);
  assert.deepEqual(
    reblocked.cycles.map((cycle) => (cycle as PublicCycle).episode),
    ["blocked", "release", "blocked"],
  );
  const allRows = await communicationRows(caseId);
  assert.equal(
    allRows.filter((row) => row.idempotencyKey?.includes(`:${blockedCycleId}:`)).length,
    blockedRows.length,
  );
  assert.equal(allRows.filter((row) => row.idempotencyKey?.includes(`:${reblockedCycleId}:`)).length, 5);
  assert.equal(sender.calls.length, 3, "only the HR notice in each live episode was sent");
});

test("uncertain provider outcomes become manual-repair state and are never replayed", async () => {
  const caseId = await createCase(orgA);
  await configureCase(orgA, caseId, {
    bgvTeam: recipient(null, false, false),
    recruiter: recipient(null, false, false),
    hiringManager: recipient(null, false, false),
    compliance: recipient(null, false, false),
    candidate: { enabled: false, purposeAuthorized: false },
  });
  const sender = makeSender("sending");
  const first = await recordBgvBlockedEpisode({
    organizationId: orgA,
    caseId,
    source: "webhook",
    provenance: "trusted-provider",
    reason: "verification delay",
    sender: sender.sender,
  });
  const firstRows = await communicationRows(caseId);
  const [uncertain] = firstRows.filter((row) => row.idempotencyKey?.includes(":hr:purpose"));
  assert.equal(uncertain.status, "uncertain");
  assert.match(uncertain.failureReason ?? "", /did not confirm the delivery outcome/i);
  assert.equal(sender.calls.length, 1);

  const retry = await reconcileBgvNotifications({
    organizationId: orgA,
    caseId,
    role: "owner",
    reason: "manual",
    sender: sender.sender,
  });
  assert.equal(sender.calls.length, 1);
  assert.ok(retry.skippedCommunicationIds.includes(uncertain.id));
  const [effect] = await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.caseId, caseId));
  assert.equal(effect.status, "unknown_effect_manual_repair");
  assert.equal(effect.externalEffectId, null);
  assert.equal(publicCycle(first).cycleId, publicCycle(retry).cycleId);
});

test("configuration is version fenced, role protected with 403, and tenant scoped", async () => {
  const caseA = await createCase(orgA);
  const caseB = await createCase(orgB);
  const loaded = await getBgvNotifications({ organizationId: orgA, caseId: caseA, role: "owner" });
  const memberPut = await routeCall(
    `/onboarding/cases/${caseA}/bgv-notifications`,
    orgA,
    "member",
    {
      method: "PUT",
      body: JSON.stringify({ version: loaded.version, config: loaded.config }),
    },
  );
  assert.equal(memberPut.status, 403);

  const crossTenantRead = await routeCall(
    `/onboarding/cases/${caseA}/bgv-notifications`,
    orgB,
    "owner",
  );
  assert.equal(crossTenantRead.status, 403);
  const crossTenantWrite = await routeCall(
    `/onboarding/cases/${caseA}/bgv-notifications`,
    orgB,
    "owner",
    {
      method: "PUT",
      body: JSON.stringify({ version: loaded.version, config: loaded.config }),
    },
  );
  assert.equal(crossTenantWrite.status, 403);

  const ownerPut = await routeCall(
    `/onboarding/cases/${caseA}/bgv-notifications`,
    orgA,
    "owner",
    {
      method: "PUT",
      body: JSON.stringify({ version: loaded.version, config: loaded.config }),
    },
  );
  assert.equal(ownerPut.status, 200);
  const stalePut = await routeCall(
    `/onboarding/cases/${caseA}/bgv-notifications`,
    orgA,
    "owner",
    {
      method: "PUT",
      body: JSON.stringify({ version: loaded.version, config: loaded.config }),
    },
  );
  assert.equal(stalePut.status, 409);
  const staleBody = await stalePut.json() as { version?: number; message?: string };
  assert.equal(staleBody.version, loaded.version + 1);
  assert.match(staleBody.message ?? "", /changed since it was loaded/i);
  assert.equal(caseB !== caseA, true);

  const concurrentCase = await createCase(orgA);
  const concurrentLoaded = await getBgvNotifications({
    organizationId: orgA,
    caseId: concurrentCase,
    role: "owner",
  });
  const concurrentPuts = await Promise.all([
    routeCall(
      `/onboarding/cases/${concurrentCase}/bgv-notifications`,
      orgA,
      "admin",
      {
        method: "PUT",
        body: JSON.stringify({
          version: concurrentLoaded.version,
          config: concurrentLoaded.config,
        }),
      },
    ),
    routeCall(
      `/onboarding/cases/${concurrentCase}/bgv-notifications`,
      orgA,
      "admin",
      {
        method: "PUT",
        body: JSON.stringify({
          version: concurrentLoaded.version,
          config: concurrentLoaded.config,
        }),
      },
    ),
  ]);
  assert.deepEqual(
    concurrentPuts.map((response) => response.status).sort((a, b) => a - b),
    [200, 409],
    "same-version concurrent writes must have one winner and one conflict",
  );

  await assert.rejects(
    updateBgvNotifications({
      organizationId: orgA,
      caseId: caseA,
      role: "member",
      version: loaded.version + 1,
      config: configFor(loaded.version + 1),
    }),
    (error: unknown) =>
      error instanceof BgvNotificationConflictError &&
      /Owner or admin HR role required/i.test(error.message),
  );
});