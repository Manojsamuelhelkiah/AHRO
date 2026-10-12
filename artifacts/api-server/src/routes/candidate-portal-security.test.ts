import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  db,
  onbCandidateLinks,
  onbCandidateExchangeFailures,
  onbCandidateSessions,
  onbCaseLogistics,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCandidateUploads,
  onbCommunications,
  onbCases,
  onbConnectors,
  onbDocuments,
  onbEffectJournal,
  onbEvents,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisions,
  onbGovernanceDecisionReviews,
  onbGovernanceDispatchMarkers,
  onbGovernanceRequirements,
  onbSensitiveLifecyclePolicies,
  onbSettings,
  accessSecurityGroups,
  accessSecurityGroupPolicies,
  accessSecurityGroupUserGroups,
  accessSecurityGroupAttachments,
  accessUserGroups,
  accessUserGroupMembers,
  type OnbAuthorityRole,
  type OnbAuthorityScope,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import candidateAdminRouter from "./candidate-admin";
import candidatePublicRouter from "./candidate-public";
import {
  CANDIDATE_COOKIE,
  CANDIDATE_EXCHANGE_COOLDOWN_MS,
  CANDIDATE_EXCHANGE_FAILURE_LIMIT,
  CandidateExchangeLimiter,
  CANDIDATE_LINK_RETENTION_MS,
  MAX_CANDIDATE_FILE_BYTES,
  cleanupCandidateAccess,
  hashSecret,
} from "../lib/onboarding/candidate-portal";
import {
  CANDIDATE_LINK_RETENTION_DAYS_KEY,
  DAY1_LOGISTICS_DEFAULT_KEY,
  setSetting,
} from "../lib/onboarding/settings";
import {
  AUTOMATED_PORTAL_EMAIL_KEY,
  issueCandidatePortalLink,
} from "../lib/onboarding/portal-link-issuance";
import { seedApprovedSensitiveLifecyclePolicies } from "../test-utils/sensitive-lifecycle-fixtures";
import { setOnboardingConnectorProxyForTests } from "../lib/onboarding/channels";
import { SYNTHETIC_OFFLINE_MARKER, isSyntheticOfflineCase } from "../lib/onboarding/synthetic-offline";
import {
  governanceSnapshotForNewCase,
  withGovernanceDecisionSnapshot,
  type GovernanceCaseSnapshot,
} from "../lib/onboarding/governance-runtime";

const suffix = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const orgA = `candidate-security-a-${suffix}`;
const orgB = `candidate-security-b-${suffix}`;
const userId = `candidate-security-user-${suffix}`;
const policyOwnerUserId = `candidate-security-policy-owner-${suffix}`;
const tokens = {
  active: `active-${"a".repeat(40)}`,
  expired: `expired-${"b".repeat(40)}`,
  revoked: `revoked-${"c".repeat(40)}`,
};

let server: Server;
let baseUrl: string;
let caseA: number;
let caseA2: number;
let caseB: number;
let documentA: number;
let activeLinkId: number;
const governanceSnapshots = new Map<string, GovernanceCaseSnapshot>();

const caseValues = (organizationId: string, workerName: string) => ({
  organizationId,
  workerName,
  workerEmail: `${workerName.toLowerCase().replaceAll(" ", ".")}@example.com`,
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
  processPolicySnapshot: withGovernanceDecisionSnapshot(
    {},
    governanceSnapshots.get(organizationId)!,
  ),
});

async function establishApprovedGovernanceFixture(
  organizationId: string,
): Promise<GovernanceCaseSnapshot> {
  await governanceSnapshotForNewCase(organizationId);
  const decisions = await db.select().from(onbGovernanceDecisions).where(
    eq(onbGovernanceDecisions.organizationId, organizationId),
  );
  for (const decision of decisions) {
    const reviewer = `candidate-security-fixture:${decision.accountableRole}`;
    const [authority] = await db.insert(onbGovernanceAuthorityAssignments).values({
      organizationId,
      authorityRole: decision.accountableRole,
      assigneeUserId: reviewer,
      verificationStatus: "verified",
      verifiedByUserId: "candidate-security-fixture",
      verificationReference: reviewer,
    }).returning({ id: onbGovernanceAuthorityAssignments.id });
    await db.insert(onbGovernanceDecisionReviews).values({
      organizationId,
      decisionKey: decision.key,
      decisionRevision: decision.revision,
      outcome: "approved",
      reason: "Candidate portal security fixture approved decision",
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

async function createSession(
  secret: string,
  organizationId: string,
  targetCaseId: number,
  linkId = activeLinkId,
  expiresAt = new Date(Date.now() + 10 * 60_000),
) {
  await db.insert(onbCandidateSessions).values({
    idHash: hashSecret(secret),
    organizationId,
    caseId: targetCaseId,
    linkId,
    expiresAt,
  });
}

async function portal(secret: string) {
  return fetch(`${baseUrl}/candidate/portal`, {
    headers: { cookie: `${CANDIDATE_COOKIE}=${secret}` },
  });
}

function oversizedUpload(secret: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/candidate/documents/${documentA}/upload`);
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        cookie: `${CANDIDATE_COOKIE}=${secret}`,
        "x-file-name": "too-large.pdf",
        "x-file-type": "application/pdf",
        "content-length": String(MAX_CANDIDATE_FILE_BYTES + 1),
      },
    }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

before(async () => {
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Candidate Security A", slug: orgA, joinCodeHash: `hash-${orgA}`, createdByUserId: userId },
    { id: orgB, name: "Candidate Security B", slug: orgB, joinCodeHash: `hash-${orgB}`, createdByUserId: userId },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: userId, role: "owner" },
    { organizationId: orgA, clerkUserId: policyOwnerUserId, role: "member" },
    { organizationId: orgB, clerkUserId: userId, role: "owner" },
  ]);
  await db.insert(onbAuthorityGovernance).values([
    { organizationId: orgA, status: "governance-approved", operatorUserId: userId, approvedByUserId: userId, governanceSource: "candidate-security-test" },
    { organizationId: orgB, status: "governance-approved", operatorUserId: userId, approvedByUserId: userId, governanceSource: "candidate-security-test" },
  ]);
  await Promise.all([
    // The exercised portal link and pre-storage validation path use the
    // suite's in-process provider boundaries; no production mail provider is
    // allowlisted here.
    seedApprovedSensitiveLifecyclePolicies(orgA, {
      permittedProviders: ["internal-candidate-portal", "replit-object-storage"],
    }),
    seedApprovedSensitiveLifecyclePolicies(orgB, {
      permittedProviders: ["internal-candidate-portal", "replit-object-storage"],
    }),
  ]);
  governanceSnapshots.set(orgA, await establishApprovedGovernanceFixture(orgA));
  governanceSnapshots.set(orgB, await establishApprovedGovernanceFixture(orgB));
  [caseA, caseA2, caseB] = (await db.insert(onbCases).values([
    caseValues(orgA, "Candidate Alpha"),
    caseValues(orgA, "Candidate Alpha Two"),
    caseValues(orgB, "Candidate Beta"),
  ]).returning({ id: onbCases.id })).map((row) => row.id);
  const fullCaseAuthorities: Array<{
    organizationId: string;
    caseId: number;
    authorityRole: OnbAuthorityRole;
    scopes: OnbAuthorityScope[];
  }> = [
      { organizationId: orgA, caseId: caseA, authorityRole: "hr-compliance", scopes: ["hr-compliance-approve"] as const },
      { organizationId: orgA, caseId: caseA, authorityRole: "occupational-health", scopes: ["occupational-health-approve"] as const },
      { organizationId: orgA, caseId: caseA, authorityRole: "payroll", scopes: ["payroll-approve"] as const },
      { organizationId: orgA, caseId: caseA2, authorityRole: "hr-compliance", scopes: ["hr-compliance-approve"] as const },
      { organizationId: orgA, caseId: caseA2, authorityRole: "occupational-health", scopes: ["occupational-health-approve"] as const },
      { organizationId: orgA, caseId: caseA2, authorityRole: "payroll", scopes: ["payroll-approve"] as const },
      { organizationId: orgB, caseId: caseB, authorityRole: "hr-compliance", scopes: ["hr-compliance-approve"] as const },
      { organizationId: orgB, caseId: caseB, authorityRole: "occupational-health", scopes: ["occupational-health-approve"] as const },
      { organizationId: orgB, caseId: caseB, authorityRole: "payroll", scopes: ["payroll-approve"] as const },
    ];
  await db.insert(onbAuthorityAssignments).values(
    fullCaseAuthorities.map((assignment) => ({
      ...assignment,
      id: `candidate-security-authority-${assignment.organizationId}-${assignment.caseId}-${assignment.authorityRole}`,
      personUserId: userId,
      grantorUserId: userId,
      source: "test-fixture",
      governanceDecisionRef: "candidate-security-test",
    })),
  );
  for (const targetCaseId of [caseA, caseA2]) {
    const userGroupId = `candidate-security-full-user-group-${targetCaseId}-${suffix}`;
    const securityGroupId = `candidate-security-full-security-group-${targetCaseId}-${suffix}`;
    await db.insert(accessUserGroups).values({
      id: userGroupId,
      organizationId: orgA,
      name: userGroupId,
      ownerUserId: policyOwnerUserId,
      createdByUserId: userId,
    });
    await db.insert(accessSecurityGroups).values({
      id: securityGroupId,
      organizationId: orgA,
      name: securityGroupId,
      ownerUserId: policyOwnerUserId,
      createdByUserId: userId,
    });
    await db.insert(accessUserGroupMembers).values({
      organizationId: orgA,
      groupId: userGroupId,
      principalType: "human",
      principalId: userId,
      attachedByUserId: userId,
      requiresApproval: "yes",
      approvedByUserId: policyOwnerUserId,
      approvedAt: new Date(),
    });
    await db.insert(accessSecurityGroupUserGroups).values({
      organizationId: orgA,
      securityGroupId,
      userGroupId,
      attachedByUserId: userId,
      requiresApproval: "yes",
      approvedByUserId: policyOwnerUserId,
      approvedAt: new Date(),
      approvedPolicyVersion: 1,
    });
    await db.insert(accessSecurityGroupPolicies).values({
      organizationId: orgA,
      securityGroupId,
      version: 1,
      policy: {
        fields: ["identity", "medical", "payroll", "bgv"].flatMap((dataClass) => [
          `data.${dataClass}.read`, `data.${dataClass}.edit`,
        ]),
        flows: [],
        tools: ["tool.notification.send"],
      },
      createdByUserId: userId,
      approvedByUserId: policyOwnerUserId,
      approvedAt: new Date(),
    });
    await db.insert(accessSecurityGroupAttachments).values({
      organizationId: orgA,
      securityGroupId,
      scope: "case",
      caseId: targetCaseId,
      attachedByUserId: userId,
      requiresApproval: "yes",
      approvedByUserId: policyOwnerUserId,
      approvedAt: new Date(),
      approvedPolicyVersion: 1,
    });
  }
  [documentA] = (await db.insert(onbDocuments).values({
    organizationId: orgA,
    caseId: caseA,
    key: "id-proof",
    label: "ID proof",
    category: "identity",
  }).returning({ id: onbDocuments.id })).map((row) => row.id);
  [activeLinkId] = (await db.insert(onbCandidateLinks).values([
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(tokens.active), expiresAt: new Date(Date.now() + 60 * 60_000), issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(tokens.expired), expiresAt: new Date(Date.now() - 60_000), issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(tokens.revoked), expiresAt: new Date(Date.now() + 60 * 60_000), revokedAt: new Date(), issuedBy: userId },
  ]).returning({ id: onbCandidateLinks.id })).map((row) => row.id);

  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser());
  app.use(express.json());
  app.use(candidatePublicRouter);
  app.use((req, _res, next) => {
    req.authUserId = String(req.header("x-test-user") ?? userId);
    req.organizationId = String(req.header("x-organization-id") ?? orgA);
    next();
  });
  app.use(candidateAdminRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(onbSettings).where(inArray(onbSettings.organizationId, [orgA, orgB]));
  await db.delete(onbEffectJournal).where(inArray(onbEffectJournal.organizationId, [orgA, orgB]));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgA));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgB));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, orgA));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, orgB));
  await db.delete(onbGovernanceDispatchMarkers).where(inArray(
    onbGovernanceDispatchMarkers.organizationId, [orgA, orgB],
  ));
  await db.delete(onbAuthorityAssignments).where(inArray(
    onbAuthorityAssignments.organizationId, [orgA, orgB],
  ));
  await db.delete(onbAuthorityGovernance).where(inArray(
    onbAuthorityGovernance.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceDecisionReviews).where(inArray(
    onbGovernanceDecisionReviews.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceAuthorityAssignments).where(inArray(
    onbGovernanceAuthorityAssignments.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceRequirements).where(inArray(
    onbGovernanceRequirements.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceDecisions).where(inArray(
    onbGovernanceDecisions.organizationId, [orgA, orgB],
  ));
  await db.delete(onbSensitiveLifecyclePolicies).where(inArray(
    onbSensitiveLifecyclePolicies.organizationId, [orgA, orgB],
  ));
  await db.delete(accessSecurityGroups).where(inArray(accessSecurityGroups.organizationId, [orgA, orgB]));
  await db.delete(accessUserGroups).where(inArray(accessUserGroups.organizationId, [orgA, orgB]));
  await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, orgA));
  await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, orgB));
  await deleteTestOrganizations(eq(organizationsTable.id, orgA));
  await deleteTestOrganizations(eq(organizationsTable.id, orgB));
  await db.delete(onbCandidateExchangeFailures);
});

test("expired and revoked links cannot be exchanged", async () => {
  for (const token of [tokens.expired, tokens.revoked]) {
    const response = await fetch(`${baseUrl}/candidate/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(response.status, 401);
  }
});

test("admin portal access reports a clear missing state without inserting logistics on read", async () => {
  await db.delete(onbCaseLogistics).where(and(
    eq(onbCaseLogistics.organizationId, orgA),
    eq(onbCaseLogistics.caseId, caseA2),
  ));

  const response = await fetch(`${baseUrl}/onboarding/cases/${caseA2}/portal`, {
    headers: { "x-organization-id": orgA },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { logistics: Record<string, string | null> | null };
  assert.equal(body.logistics, null);

  const [stored] = await db.select().from(onbCaseLogistics).where(and(
    eq(onbCaseLogistics.organizationId, orgA),
    eq(onbCaseLogistics.caseId, caseA2),
  ));
  assert.equal(stored, undefined);
});

test("missing lifecycle policy blocks logistics creation without an insert", async () => {
  await db.delete(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, orgA),
    eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-document"),
  ));
  const response = await fetch(`${baseUrl}/onboarding/cases/${caseA2}/logistics`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-organization-id": orgA },
    body: JSON.stringify({ orientationDate: "2030-01-01", format: "remote" }),
  });
  assert.equal(response.status, 409);
  const [stored] = await db.select().from(onbCaseLogistics).where(and(
    eq(onbCaseLogistics.organizationId, orgA),
    eq(onbCaseLogistics.caseId, caseA2),
  ));
  assert.equal(stored, undefined);
  await seedApprovedSensitiveLifecyclePolicies(orgA, {
    permittedProviders: ["internal-candidate-portal", "replit-object-storage"],
  });
});

test("bearer portal links and opaque logistics require live full case-scoped authority", async () => {
  const ordinaryUser = `candidate-security-ordinary-${suffix}`;
  const partialUser = `candidate-security-partial-${suffix}`;
  const revokedUser = `candidate-security-revoked-${suffix}`;
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: ordinaryUser, role: "member" },
    { organizationId: orgA, clerkUserId: partialUser, role: "member" },
    { organizationId: orgA, clerkUserId: revokedUser, role: "member", revokedAt: new Date() },
  ]);
  await db.insert(onbAuthorityAssignments).values([
    {
      id: `candidate-security-partial-${suffix}`,
      organizationId: orgA, caseId: caseA, personUserId: partialUser,
      authorityRole: "hr-compliance", scopes: ["hr-compliance-approve"] as OnbAuthorityScope[],
      grantorUserId: userId, source: "test-fixture", governanceDecisionRef: "candidate-security-test",
    },
    {
      id: `candidate-security-revoked-hr-${suffix}`,
      organizationId: orgA, caseId: caseA, personUserId: revokedUser,
      authorityRole: "hr-compliance", scopes: ["hr-compliance-approve"] as OnbAuthorityScope[],
      grantorUserId: userId, source: "test-fixture", governanceDecisionRef: "candidate-security-test",
    },
    {
      id: `candidate-security-revoked-medical-${suffix}`,
      organizationId: orgA, caseId: caseA, personUserId: revokedUser,
      authorityRole: "occupational-health", scopes: ["occupational-health-approve"] as OnbAuthorityScope[],
      grantorUserId: userId, source: "test-fixture", governanceDecisionRef: "candidate-security-test",
    },
    {
      id: `candidate-security-revoked-payroll-${suffix}`,
      organizationId: orgA, caseId: caseA, personUserId: revokedUser,
      authorityRole: "payroll", scopes: ["payroll-approve"] as OnbAuthorityScope[],
      grantorUserId: userId, source: "test-fixture", governanceDecisionRef: "candidate-security-test",
    },
  ]);
  const postLink = (actor: string, organizationId = orgA, id = caseA) => fetch(
    `${baseUrl}/onboarding/cases/${id}/portal-links`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-organization-id": organizationId, "x-test-user": actor },
      body: JSON.stringify({ sendEmail: false }),
    },
  );
  assert.equal((await postLink(ordinaryUser)).status, 403);
  assert.equal((await postLink(partialUser)).status, 403);
  assert.equal((await postLink(revokedUser)).status, 403);
  assert.equal((await postLink(userId, orgB)).status, 403, "cross-tenant paths never issue a bearer URL");
  const full = await postLink(userId);
  assert.equal(full.status, 201);
  const fullBody = await full.json() as { portalUrl?: string };
  assert.match(fullBody.portalUrl ?? "", /#token=/);
  const [backfilled] = await db.select().from(onbCaseLogistics).where(and(
    eq(onbCaseLogistics.organizationId, orgA),
    eq(onbCaseLogistics.caseId, caseA),
  ));
  assert.ok(backfilled, "an explicit authorized link issue backfills legacy missing logistics once");
  await setSetting(orgA, DAY1_LOGISTICS_DEFAULT_KEY, JSON.stringify({
    orientationDate: "2040-01-01",
    orientationTime: "08:00",
    timezone: "Etc/UTC",
    format: "remote",
    venueAddress: null,
    googleMapsUrl: null,
    meetingUrl: "https://meet.example.test/new-default",
    reportingContact: "New default",
    arrivalInstructions: null,
  }));
  assert.equal((await postLink(userId)).status, 201);
  const [unchanged] = await db.select().from(onbCaseLogistics).where(and(
    eq(onbCaseLogistics.organizationId, orgA),
    eq(onbCaseLogistics.caseId, caseA),
  ));
  assert.deepEqual(unchanged, backfilled, "later tenant defaults never overwrite persisted case logistics");

  const ordinaryLogistics = await fetch(`${baseUrl}/onboarding/cases/${caseA}/portal`, {
    headers: { "x-organization-id": orgA, "x-test-user": ordinaryUser },
  });
  assert.equal(ordinaryLogistics.status, 403);
  const ordinaryLogisticsWrite = await fetch(`${baseUrl}/onboarding/cases/${caseA}/logistics`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-organization-id": orgA, "x-test-user": ordinaryUser },
    body: JSON.stringify({ orientationDate: "2030-01-01", format: "remote" }),
  });
  assert.equal(ordinaryLogisticsWrite.status, 403);
});

test("sample portal email uses full live authority without authorizing any non-email workflow", async () => {
  const [original] = await db.select().from(onbCases).where(eq(onbCases.id, caseA2));
  let calls = 0;
  setOnboardingConnectorProxyForTests(async () => {
    calls++;
    return new Response(JSON.stringify({ id: "fake-sample-portal" }), { status: 200 });
  });
  const key = `sample-portal-email:${caseA2}`;
  try {
    await seedApprovedSensitiveLifecyclePolicies(orgA, {
      permittedProviders: ["gmail", "internal-candidate-portal", "replit-object-storage"],
    });
    await db.update(onbCases).set({
      workerEmail: "sample-portal@fake-provider.mailhost.com", channelPreference: "whatsapp",
      candidateEmailAuthorizedAt: null, candidateEmailAuthorizedBy: null,
      syntheticProvenance: "demo-full-coverage", notes: SYNTHETIC_OFFLINE_MARKER,
      scenarioKey: "UAT-DEMO-COVERAGE:portal-email",
    }).where(eq(onbCases.id, caseA2));
    const result = await issueCandidatePortalLink({
      organizationId: orgA, caseId: caseA2, issuedBy: userId, publicBase: baseUrl,
      sendEmail: true, idempotencyKey: key,
    });
    assert.ok(result?.portalUrl);
    assert.equal(calls, 1);
    const [message] = await db.select().from(onbCommunications).where(eq(onbCommunications.idempotencyKey, key));
    assert.equal(message.status, "sent");
    assert.doesNotMatch(message.body, /#token=/);
    const [current] = await db.select().from(onbCases).where(eq(onbCases.id, caseA2));
    assert.equal(isSyntheticOfflineCase(current), true);
    assert.equal(current.offerAcceptanceComplete, original.offerAcceptanceComplete);
    assert.equal(current.orchestrationStatus, original.orchestrationStatus);
  } finally {
    setOnboardingConnectorProxyForTests(null);
    await db.update(onbCases).set({
      workerEmail: original.workerEmail, channelPreference: original.channelPreference,
      syntheticProvenance: original.syntheticProvenance, notes: original.notes, scenarioKey: original.scenarioKey,
    }).where(eq(onbCases.id, caseA2));
    await seedApprovedSensitiveLifecyclePolicies(orgA, {
      permittedProviders: ["internal-candidate-portal", "replit-object-storage"],
    });
  }
});

test("automatic portal delivery is idempotent and never persists the secret link", async () => {
  await db.update(onbCases).set({
    candidateEmailAuthorizedAt: null,
    candidateEmailAuthorizedBy: null,
    channelPreference: "whatsapp",
    workerEmail: "portal@fake-provider.mailhost.com",
  }).where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, caseA2)));
  const key = AUTOMATED_PORTAL_EMAIL_KEY(caseA2);

  try {
    const first = await issueCandidatePortalLink({
      organizationId: orgA,
      caseId: caseA2,
      issuedBy: userId,
      publicBase: baseUrl,
      sendEmail: true,
      idempotencyKey: key,
    });
    const second = await issueCandidatePortalLink({
      organizationId: orgA,
      caseId: caseA2,
      issuedBy: userId,
      publicBase: baseUrl,
      sendEmail: true,
      idempotencyKey: key,
    });

    assert.ok(first?.portalUrl?.includes("/candidate#token="));
    assert.equal(second?.portalUrl, null);
    const deliveries = await db.select().from(onbCommunications).where(and(
      eq(onbCommunications.organizationId, orgA),
      eq(onbCommunications.idempotencyKey, key),
    ));
    assert.equal(deliveries.length, 1);
    assert.doesNotMatch(deliveries[0].body, /candidate#token=/);
    assert.match(deliveries[0].body, /secret link is not retained/i);
  } finally {
    await db.delete(onbEffectJournal).where(and(
      eq(onbEffectJournal.organizationId, orgA),
      eq(onbEffectJournal.logicalOperationKey, `candidate-communication:${key}`),
    ));
    await db.delete(onbCommunications).where(and(
      eq(onbCommunications.organizationId, orgA),
      eq(onbCommunications.idempotencyKey, key),
    ));
    await db.update(onbCases).set({
      candidateEmailAuthorizedAt: null,
      candidateEmailAuthorizedBy: null,
      channelPreference: "both",
      workerEmail: "candidate.alpha.two@example.com",
    }).where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, caseA2)));
  }
});

test("mixed invalid token formats share one privacy-safe client throttle", async () => {
  const clientAddress = `198.51.100.${Math.floor(Math.random() * 100) + 1}`;
  const otherClientAddress = "203.0.113.200";
  const invalidTokens = [
    "",
    "short",
    42,
    null,
    `unknown-${"x".repeat(40)}`,
  ];
  for (let index = 0; index < CANDIDATE_EXCHANGE_FAILURE_LIMIT; index += 1) {
    const response = await fetch(`${baseUrl}/candidate/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `10.0.0.${index + 1}, ${clientAddress}`,
      },
      body: JSON.stringify({ token: invalidTokens[index % invalidTokens.length] }),
    });
    assert.equal(response.status, 401);
  }

  const throttled = await fetch(`${baseUrl}/candidate/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `192.0.2.99, ${clientAddress}`,
    },
    body: JSON.stringify({ token: `another-${"y".repeat(40)}` }),
  });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "60");

  const independent = await fetch(`${baseUrl}/candidate/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `192.0.2.99, ${otherClientAddress}`,
    },
    body: JSON.stringify({ token: "short" }),
  });
  assert.equal(independent.status, 401);

  const key = hashSecret(clientAddress);
  const limiter = new CandidateExchangeLimiter();
  assert.ok(await limiter.retryAfterMs(key, Date.now()) > 0);
  assert.equal(
    await limiter.retryAfterMs(key, Date.now() + CANDIDATE_EXCHANGE_COOLDOWN_MS + 1),
    0,
  );
});

test("sessions cannot cross organizations or cases", async () => {
  const crossOrg = `cross-org-${"d".repeat(40)}`;
  const crossCase = `cross-case-${"e".repeat(40)}`;
  await createSession(crossOrg, orgB, caseB);
  await createSession(crossCase, orgA, caseA2);
  assert.equal((await portal(crossOrg)).status, 401);
  assert.equal((await portal(crossCase)).status, 401);
});

test("expired sessions are rejected and revocation immediately ends active sessions", async () => {
  const expiredSession = `expired-session-${"f".repeat(40)}`;
  await createSession(expiredSession, orgA, caseA, activeLinkId, new Date(Date.now() - 1_000));
  assert.equal((await portal(expiredSession)).status, 401);

  const exchange = await fetch(`${baseUrl}/candidate/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tokens.active }),
  });
  assert.equal(exchange.status, 204);
  const cookie = exchange.headers.get("set-cookie");
  assert.ok(cookie);
  const secret = /onb_candidate_session=([^;]+)/.exec(cookie)?.[1];
  assert.ok(secret);
  assert.equal((await portal(secret)).status, 200);

  const revoke = await fetch(`${baseUrl}/onboarding/cases/${caseA}/portal-links/${activeLinkId}`, {
    method: "DELETE",
    headers: { "x-organization-id": orgA },
  });
  assert.equal(revoke.status, 204);
  assert.equal((await portal(secret)).status, 401);
});

test("candidate access cleanup is tenant-safe, idempotent, and preserves active and recently revoked links", async () => {
  const now = new Date();
  const old = new Date(now.getTime() - CANDIDATE_LINK_RETENTION_MS - 1);
  const recent = new Date(now.getTime() - CANDIDATE_LINK_RETENTION_MS + 1);
  const future = new Date(now.getTime() + 60_000);
  const links = await db.insert(onbCandidateLinks).values([
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`cleanup-old-expired-${suffix}`), expiresAt: old, issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`cleanup-old-revoked-${suffix}`), expiresAt: old, revokedAt: old, issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`cleanup-recent-revoked-${suffix}`), expiresAt: old, revokedAt: recent, issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`cleanup-active-${suffix}`), expiresAt: future, issuedBy: userId },
    { organizationId: orgB, caseId: caseB, tokenHash: hashSecret(`cleanup-other-tenant-${suffix}`), expiresAt: old, issuedBy: userId },
  ]).returning({ id: onbCandidateLinks.id });
  const expiredSessionSecret = `cleanup-session-${suffix}`;
  await createSession(expiredSessionSecret, orgA, caseA, links[3].id, old);

  const cleanup = await cleanupCandidateAccess({ now, organizationId: orgA });
  assert.ok(cleanup.expiredSessions >= 1);
  assert.equal(cleanup.retainedLinksDeleted, 2);
  assert.deepEqual(await cleanupCandidateAccess({ now, organizationId: orgA }), {
    expiredSessions: 0,
    retainedLinksDeleted: 0,
  });

  const survivors = await db.select({ id: onbCandidateLinks.id })
    .from(onbCandidateLinks)
    .where(and(
      eq(onbCandidateLinks.organizationId, orgA),
      inArray(onbCandidateLinks.id, [links[2].id, links[3].id]),
    ));
  assert.equal(survivors.length, 2);
  const [otherTenant] = await db.select({ id: onbCandidateLinks.id })
    .from(onbCandidateLinks)
    .where(eq(onbCandidateLinks.id, links[4].id));
  assert.equal(otherTenant.id, links[4].id);
});

test("candidate access cleanup honors each tenant retention policy without deleting active links", async () => {
  const now = new Date();
  await setSetting(orgA, CANDIDATE_LINK_RETENTION_DAYS_KEY, "30");
  await setSetting(orgB, CANDIDATE_LINK_RETENTION_DAYS_KEY, "180");
  const expired45DaysAgo = new Date(now.getTime() - 45 * 24 * 60 * 60_000);
  const future = new Date(now.getTime() + 60_000);
  const links = await db.insert(onbCandidateLinks).values([
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`policy-a-expired-${suffix}`), expiresAt: expired45DaysAgo, issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`policy-a-active-${suffix}`), expiresAt: future, issuedBy: userId },
    { organizationId: orgB, caseId: caseB, tokenHash: hashSecret(`policy-b-expired-${suffix}`), expiresAt: expired45DaysAgo, issuedBy: userId },
  ]).returning({ id: onbCandidateLinks.id });

  const cleanup = await cleanupCandidateAccess({ now });
  assert.ok(cleanup.retainedLinksDeleted >= 1);
  const survivors = await db.select({ id: onbCandidateLinks.id }).from(onbCandidateLinks)
    .where(inArray(onbCandidateLinks.id, links.map((link) => link.id)));
  assert.deepEqual(
    new Set(survivors.map((link) => link.id)),
    new Set([links[1].id, links[2].id]),
  );
});

test("upload route enforces type and size boundaries before storage", async () => {
  const [link] = await db.insert(onbCandidateLinks).values({
    organizationId: orgA,
    caseId: caseA,
    tokenHash: hashSecret(`upload-${"g".repeat(40)}`),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    issuedBy: userId,
  }).returning({ id: onbCandidateLinks.id });
  const secret = `upload-session-${"h".repeat(40)}`;
  await createSession(secret, orgA, caseA, link.id);

  const unsupported = await fetch(`${baseUrl}/candidate/documents/${documentA}/upload`, {
    method: "POST",
    headers: {
      cookie: `${CANDIDATE_COOKIE}=${secret}`,
      "x-file-name": "malware.exe",
      "x-file-type": "application/octet-stream",
    },
    body: Buffer.from("MZ"),
  });
  assert.equal(unsupported.status, 415);

  const mismatched = await fetch(`${baseUrl}/candidate/documents/${documentA}/upload`, {
    method: "POST",
    headers: {
      cookie: `${CANDIDATE_COOKIE}=${secret}`,
      "x-file-name": "fake.pdf",
      "x-file-type": "application/pdf",
    },
    body: Buffer.from("not a pdf"),
  });
  assert.equal(mismatched.status, 415);
  assert.equal(await oversizedUpload(secret), 413);
});

test("an opaque medical passport upload requires every class policy and exact storage-provider approval", async () => {
  await db.update(onbDocuments).set({
    // The label/category are deliberately medical, while the bytes remain
    // opaque. Neither may bypass identity or payroll lifecycle decisions.
    key: "passport",
    label: "Medical passport packet",
    category: "medical",
  }).where(eq(onbDocuments.id, documentA));
  const [link] = await db.insert(onbCandidateLinks).values({
    organizationId: orgA,
    caseId: caseA,
    tokenHash: hashSecret(`opaque-upload-${suffix}`),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    issuedBy: userId,
  }).returning({ id: onbCandidateLinks.id });
  const secret = `opaque-upload-session-${suffix}`;
  await createSession(secret, orgA, caseA, link!.id);

  await db.delete(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, orgA),
    eq(onbSensitiveLifecyclePolicies.dataClass, "identity"),
  ));
  const missingIdentity = await fetch(`${baseUrl}/candidate/documents/${documentA}/upload`, {
    method: "POST",
    headers: {
      cookie: `${CANDIDATE_COOKIE}=${secret}`,
      "x-file-name": "medical-passport.pdf",
      "x-file-type": "application/pdf",
    },
    body: Buffer.from("opaque bytes"),
  });
  assert.equal(missingIdentity.status, 409);

  await seedApprovedSensitiveLifecyclePolicies(orgA, {
    permittedProviders: ["internal-candidate-portal", "replit-object-storage"],
  });
  await db.update(onbSensitiveLifecyclePolicies).set({
    providerSharingApproved: true,
    permittedProviders: ["internal-candidate-portal"],
  }).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, orgA),
    eq(onbSensitiveLifecyclePolicies.dataClass, "payroll"),
  ));
  const payrollProviderDenied = await fetch(`${baseUrl}/candidate/documents/${documentA}/upload`, {
    method: "POST",
    headers: {
      cookie: `${CANDIDATE_COOKIE}=${secret}`,
      "x-file-name": "medical-payroll.pdf",
      "x-file-type": "application/pdf",
    },
    body: Buffer.from("opaque bytes"),
  });
  assert.equal(payrollProviderDenied.status, 409);
  const [{ value: uploadCount }] = await db.select({ value: count() }).from(onbCandidateUploads).where(
    eq(onbCandidateUploads.organizationId, orgA),
  );
  assert.equal(uploadCount, 0, "denied opaque uploads never reach object storage metadata");
  await seedApprovedSensitiveLifecyclePolicies(orgA, {
    permittedProviders: ["internal-candidate-portal", "replit-object-storage"],
  });
});

test("candidate metadata uses generic security guidance and hides scan details", async () => {
  const [link] = await db.insert(onbCandidateLinks).values({
    organizationId: orgA,
    caseId: caseA,
    tokenHash: hashSecret(`malware-guidance-${suffix}`),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    issuedBy: userId,
  }).returning({ id: onbCandidateLinks.id });
  const secret = `malware-guidance-session-${"m".repeat(40)}`;
  await createSession(secret, orgA, caseA, link.id);
  await db.update(onbDocuments).set({ status: "verified" }).where(eq(onbDocuments.id, documentA));
  await db.insert(onbCandidateUploads).values({
    organizationId: orgA,
    caseId: caseA,
    documentId: documentA,
    objectPath: `test/${suffix}/malware-guidance.pdf`,
    originalName: "malware-guidance.pdf",
    contentType: "application/pdf",
    sizeBytes: 10,
    validationState: "manual_review",
    malwareScanState: "infected",
    malwareScanId: "engine-private-id",
    malwareScanSha256: null,
    checksumSha256: "c".repeat(64),
  });

  const response = await portal(secret);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    documents: Array<Record<string, unknown>>;
  };
  const document = body.documents.find((item) => item.id === documentA);
  assert.ok(document);
  assert.equal(document.status, "received");
  assert.match(String(document.malwareGuidance), /different copy/i);
  assert.equal("malwareScanState" in document, false);
  assert.equal("malwareScanId" in document, false);
  assert.doesNotMatch(String(document.malwareGuidance), /infected|engine|scan id/i);
});

test("issuing links with sendEmail omitted or false does not authorize or send email", async () => {
  const [{ count: eventsBefore }] = await db.select({ count: count() }).from(onbEvents)
    .where(and(eq(onbEvents.organizationId, orgA), eq(onbEvents.caseId, caseA2)));
  for (const body of [{ expiresInHours: 24 }, { expiresInHours: 24, sendEmail: false }]) {
    const response = await fetch(`${baseUrl}/onboarding/cases/${caseA2}/portal-links`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-organization-id": orgA },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json() as { delivery: unknown }).delivery, null);
  }
  const [updatedCase] = await db.select({
    authorizedAt: onbCases.candidateEmailAuthorizedAt,
    authorizedBy: onbCases.candidateEmailAuthorizedBy,
  }).from(onbCases).where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, caseA2)));
  const [{ count: eventsAfter }] = await db.select({ count: count() }).from(onbEvents)
    .where(and(eq(onbEvents.organizationId, orgA), eq(onbEvents.caseId, caseA2)));
  assert.equal(updatedCase.authorizedAt, null);
  assert.equal(updatedCase.authorizedBy, null);
  assert.equal(eventsAfter, eventsBefore);
});

test("candidate exchange throttling is shared across instances and replaces expired windows", async () => {
  const clientKey = hashSecret(`shared-window-${suffix}`);
  const now = Date.now();
  const firstInstance = new CandidateExchangeLimiter();
  const secondInstance = new CandidateExchangeLimiter();

  await Promise.all(
    Array.from({ length: CANDIDATE_EXCHANGE_FAILURE_LIMIT }, () =>
      firstInstance.recordFailure(clientKey, now)),
  );
  assert.equal(
    await secondInstance.retryAfterMs(clientKey, now),
    CANDIDATE_EXCHANGE_COOLDOWN_MS,
  );

  const [stored] = await db.select({
    failures: onbCandidateExchangeFailures.failures,
    expiresAt: onbCandidateExchangeFailures.expiresAt,
  }).from(onbCandidateExchangeFailures)
    .where(eq(onbCandidateExchangeFailures.clientKey, clientKey));
  assert.equal(stored.failures, CANDIDATE_EXCHANGE_FAILURE_LIMIT);

  const afterExpiry = stored.expiresAt.getTime() + 1;
  await secondInstance.recordFailure(clientKey, afterExpiry);
  const [renewed] = await db.select({
    failures: onbCandidateExchangeFailures.failures,
    expiresAt: onbCandidateExchangeFailures.expiresAt,
  }).from(onbCandidateExchangeFailures)
    .where(eq(onbCandidateExchangeFailures.clientKey, clientKey));
  assert.equal(renewed.failures, 1);
  assert.ok(renewed.expiresAt > stored.expiresAt);

  await firstInstance.clear(clientKey);
  assert.equal(await secondInstance.retryAfterMs(clientKey, afterExpiry), 0);
});
