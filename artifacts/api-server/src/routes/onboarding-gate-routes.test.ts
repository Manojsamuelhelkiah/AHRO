import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbApprovalHistory,
  onbApprovals,
  onbAuthorityAudit,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCaseLogistics,
  onbCases,
  onbConnectors,
  onbDocuments,
  onbEffectJournal,
  onbEvents,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisionReviews,
  onbGovernanceDecisions,
  onbGovernanceHistory,
  onbGovernanceReminders,
  onbGovernanceRequirements,
  onbIntakeBatchPeople,
  onbIntakeBatches,
  onbReadinessSlaPolicies,
  onbSensitiveLifecyclePolicies,
  onbSystemChecks,
  accessSecurityGroupAttachments,
  accessSecurityGroupPolicies,
  accessSecurityGroupUserGroups,
  accessSecurityGroups,
  accessUserGroupMembers,
  accessUserGroups,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { reopenApprovalInTransaction } from "../lib/onboarding/approval-version";
import { decideApproval } from "../lib/onboarding/approval-decisions";
import { backfillDocumentPacks } from "../lib/onboarding/documents";
import { seedApprovedSensitiveLifecyclePolicies } from "../test-utils/sensitive-lifecycle-fixtures";
import onboardingRouter from "./onboarding";
import batchIntakeRouter from "./onboarding-batch-intake";

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `gateway-route-a-${suffix}`;
const orgB = `gateway-route-b-${suffix}`;
const user = `gateway-route-user-${suffix}`;
const requesterUser = `gateway-route-requester-${suffix}`;
const caseIds: number[] = [];
let baseUrl: string;
let server: Server;

async function call(path: string, organizationId: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-organization-id": organizationId,
      "x-test-role": "owner",
      ...(init?.headers ?? {}),
    },
  });
}

async function callWithinIntakeTimeout(
  path: string,
  organizationId: string,
  init: RequestInit,
): Promise<Response> {
  return await Promise.race([
    call(path, organizationId, init),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error(`Intake route timed out: ${path}`)),
      5_000,
    )),
  ]);
}

before(async () => {
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Gateway Route A", slug: orgA, joinCodeHash: `hash-${orgA}`, createdByUserId: user },
    { id: orgB, name: "Gateway Route B", slug: orgB, joinCodeHash: `hash-${orgB}`, createdByUserId: user },
  ]);
  await db.insert(onbAuthorityGovernance).values([orgA, orgB].map((organizationId) => ({
    organizationId,
    status: "governance-approved",
    approvedByUserId: "test-governance",
    approvedAt: new Date(),
    governanceSource: "test",
    revision: 1,
  })));
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: user, role: "member" },
    { organizationId: orgB, clerkUserId: user, role: "owner" },
  ]);
  for (const organizationId of [orgA, orgB]) {
    const userGroupId = `case-access-users-${organizationId}`;
    const securityGroupId = `case-access-policy-${organizationId}`;
    await db.insert(accessUserGroups).values({
      id: userGroupId,
      organizationId,
      name: userGroupId,
      ownerUserId: user,
      createdByUserId: user,
    });
    await db.insert(accessSecurityGroups).values({
      id: securityGroupId,
      organizationId,
      name: securityGroupId,
      ownerUserId: user,
      createdByUserId: user,
    });
    await db.insert(accessUserGroupMembers).values({
      organizationId,
      groupId: userGroupId,
      principalType: "human",
      principalId: user,
      attachedByUserId: user,
    });
    await db.insert(accessSecurityGroupUserGroups).values({
      organizationId,
      securityGroupId,
      userGroupId,
      attachedByUserId: user,
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
          "data.documents.edit",
        ],
        flows: ["flow.case.read", "flow.case.edit", "flow.document-review.edit"],
        tools: [],
      },
      createdByUserId: user,
      approvedByUserId: "independent-case-access-approver",
      approvedAt: new Date(),
    });
    await db.insert(accessSecurityGroupAttachments).values({
      organizationId,
      securityGroupId,
      scope: "tenant",
      caseId: null,
      attachedByUserId: user,
    });
  }
  await seedApprovedSensitiveLifecyclePolicies(orgA);
  await db.insert(onbAuthorityAssignments).values({
    id: `gate-a-authority-${suffix}`,
    organizationId: orgA,
    personUserId: user,
    authorityRole: "hr-compliance",
    scopes: ["hr-compliance-approve"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "test-governance",
    source: "test",
    governanceDecisionRef: "GOV-TEST",
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `authority-admin-${suffix}`,
    organizationId: orgA,
    personUserId: user,
    authorityRole: "governance",
    scopes: ["authority-administration"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "test-governance",
    source: "test",
    governanceDecisionRef: "GOV-TEST",
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = String(req.header("x-organization-id") ?? orgA);
    const role = req.header("x-test-role");
    req.organizationRole = role === "member" || role === "admin" ? role : "owner";
    req.authUserId = user;
    next();
  });
  app.use(onboardingRouter);
  app.use(batchIntakeRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  // The positive lifecycle fixture owns only these policy revisions. Remove
  // them before the temporary organizations so their required organization FK
  // cannot block teardown if a later fixture exits early.
  await db.delete(onbSensitiveLifecyclePolicies).where(inArray(
    onbSensitiveLifecyclePolicies.organizationId, [orgA, orgB],
  ));
  // The route deliberately starts asynchronous orchestration. Fixtures use a
  // normal detached orchestration path; wait for the claim to release before
  // removing case-owned rows so a late event cannot race deletion.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await db.select({
      orchestrationStatus: onbCases.orchestrationStatus,
      orchestrationClaimOwner: onbCases.orchestrationClaimOwner,
    }).from(onbCases).where(inArray(onbCases.organizationId, [orgA, orgB]));
    if (!rows.some((row) => row.orchestrationStatus === "running" || row.orchestrationClaimOwner)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  await db.delete(onbIntakeBatchPeople).where(inArray(
    onbIntakeBatchPeople.organizationId, [orgA, orgB],
  ));
  await db.delete(onbIntakeBatches).where(inArray(
    onbIntakeBatches.organizationId, [orgA, orgB],
  ));
  if (caseIds.length) await db.delete(onbCases).where(inArray(onbCases.id, caseIds));
  // If a route fails before returning its case id (for example while an
  // enrollment service is being rolled out), still remove every fixture case
  // before dropping the temporary organizations.
  await db.delete(onbCases).where(inArray(onbCases.organizationId, [orgA, orgB]));
  await db.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, orgA));
  await db.delete(onbConnectors).where(inArray(onbConnectors.organizationId, [orgA, orgB]));
  // SLA policy rows are organization-scoped without ON DELETE CASCADE;
  // remove them after case-owned snapshots/ledger rows cascade and before the
  // temporary test organizations are dropped.
  await db.delete(onbReadinessSlaPolicies).where(inArray(
    onbReadinessSlaPolicies.organizationId,
    [orgA, orgB],
  ));
  await db.delete(onbGovernanceDecisionReviews).where(inArray(
    onbGovernanceDecisionReviews.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceAuthorityAssignments).where(inArray(
    onbGovernanceAuthorityAssignments.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceReminders).where(inArray(
    onbGovernanceReminders.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceHistory).where(inArray(
    onbGovernanceHistory.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceRequirements).where(inArray(
    onbGovernanceRequirements.organizationId, [orgA, orgB],
  ));
  await db.delete(onbGovernanceDecisions).where(inArray(
    onbGovernanceDecisions.organizationId, [orgA, orgB],
  ));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgA, orgB]));
});

function intake(name: string, offerAcceptanceComplete: boolean) {
  return {
    workerName: name,
    workerEmail: `${name.replaceAll(" ", ".").toLowerCase()}-${suffix}@example.com`,
    channelPreference: "whatsapp",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Test Co",
    managerName: "Manager",
    recruiterName: "Recruiter",
    // Gate A's durable requestor is deliberately not the specialist that
    // confirms it below.
    createdByUserId: requesterUser,
    joiningDate: "2030-01-01",
    offerAcceptanceComplete,
    workforceContext: { workCountry: "US" },
  };
}

test("create refuses an asserted Gate A; dedicated confirmation owns its evidence", async () => {
  const unchecked = await callWithinIntakeTimeout("/onboarding/cases", orgA, {
    method: "POST",
    body: JSON.stringify(intake("Unchecked Offer", false)),
  });
  assert.equal(unchecked.status, 201);
  const uncheckedCase = await unchecked.json() as Record<string, unknown>;
  caseIds.push(uncheckedCase.id as number);
  assert.equal(uncheckedCase.offerAcceptanceComplete, false);
  assert.equal(uncheckedCase.offerAcceptanceCompletedAt, null);
  assert.equal(uncheckedCase.offerAcceptanceCompletedBy, null);

  const checked = await call("/onboarding/cases", orgA, {
    method: "POST",
    body: JSON.stringify(intake("Checked Offer", true)),
  });
  assert.equal(checked.status, 400);
});

test("general intake permits an ordinary case but rejects notes and accessibility needs, including corrections", async () => {
  const permitted = await call("/onboarding/cases", orgA, {
    method: "POST",
    body: JSON.stringify(intake("Ordinary Intake Regression", false)),
  });
  const permittedBody = await permitted.text();
  assert.equal(permitted.status, 201, permittedBody);
  const permittedCase = JSON.parse(permittedBody) as { id: number; updatedAt: string };
  caseIds.push(permittedCase.id);

  const casePermissions = await call(`/onboarding/cases/${permittedCase.id}/access-permissions`, orgA);
  assert.equal(casePermissions.status, 200);
  const permissionBody = await casePermissions.json() as {
    caseId: number;
    access: {
      flowRead: boolean;
      profileRead: boolean;
      profileEdit: boolean;
      notesRead: boolean;
      notesEdit: boolean;
      flowEdit: boolean;
      readinessRead: boolean;
      readinessEdit: boolean;
      documentsRead: boolean;
      documentsEdit: boolean;
      documentReviewRead: boolean;
      documentReviewEdit: boolean;
    };
    sensitive: { identity: { read: boolean; edit: boolean } };
  };
  assert.equal(permissionBody.caseId, permittedCase.id);
  assert.deepEqual(permissionBody.access, {
    flowRead: true,
    profileRead: true,
    profileEdit: true,
    notesRead: true,
    notesEdit: true,
    flowEdit: true,
    readinessRead: true,
    readinessEdit: true,
    documentsRead: false,
    documentsEdit: true,
    documentReviewRead: false,
    documentReviewEdit: true,
  });
  assert.deepEqual(permissionBody.sensitive.identity, { read: false, edit: false });
  assert.equal((await call(`/onboarding/cases/${permittedCase.id}/access-permissions`, orgB)).status, 404);

  const notes = await call("/onboarding/cases", orgA, {
    method: "POST",
    body: JSON.stringify({
      ...intake("Notes Intake Regression", false),
      notes: "Nonblank ordinary recruiter note.",
    }),
  });
  assert.equal(notes.status, 409);
  const notesBody = await notes.json() as { message: string };
  assert.match(notesBody.message, /general case intake cannot save/i);
  assert.match(notesBody.message, /no specialist handoff is available here/i);

  const accessibility = await call("/onboarding/cases", orgA, {
    method: "POST",
    body: JSON.stringify({
      ...intake("Accessibility Intake Regression", false),
      workforceContext: { workCountry: "US", accessibilityNeeds: "Step-free access." },
    }),
  });
  assert.equal(accessibility.status, 409);
  const accessibilityBody = await accessibility.json() as { message: string };
  assert.match(accessibilityBody.message, /general case intake cannot save/i);
  assert.match(accessibilityBody.message, /no specialist handoff is available here/i);

  const [correctionCase] = await db.insert(onbCases).values({
    ...intake("Accessibility Correction Regression", false),
    organizationId: orgA,
    lifecycleStage: "preboarding",
    orchestrationStatus: "idle",
  }).returning({ id: onbCases.id, updatedAt: onbCases.updatedAt });
  assert.ok(correctionCase);
  caseIds.push(correctionCase.id);
  const correction = await call(`/onboarding/cases/${correctionCase.id}/workforce-context`, orgA, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: correctionCase.updatedAt.toISOString(),
      reason: "Accessibility correction regression.",
      workforceContext: { workCountry: "US", accessibilityNeeds: "Step-free access." },
    }),
  });
  assert.equal(correction.status, 409);
  const correctionBody = await correction.json() as { message: string };
  assert.match(correctionBody.message, /workforce-context correction cannot be saved/i);
  assert.match(correctionBody.message, /no specialist handoff is available here/i);
  assert.doesNotMatch(correctionBody.message, /accessibility|medical/i);
});

test("workforce-context correction cannot replace a legacy stored accessibility need from a redacted view", async () => {
  const [legacyCase] = await db.insert(onbCases).values({
    ...intake("Legacy Stored Accessibility Regression", false),
    organizationId: orgA,
    workforceContext: { workCountry: "US", accessibilityNeeds: "Legacy accommodation detail." },
    lifecycleStage: "preboarding",
    orchestrationStatus: "idle",
  }).returning({
    id: onbCases.id,
    workforceContext: onbCases.workforceContext,
    updatedAt: onbCases.updatedAt,
  });
  assert.ok(legacyCase);
  caseIds.push(legacyCase.id);
  const before = {
    workforceContext: legacyCase.workforceContext,
    updatedAt: legacyCase.updatedAt.toISOString(),
  };

  const correction = await call(`/onboarding/cases/${legacyCase.id}/workforce-context`, orgA, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: before.updatedAt,
      reason: "Benign context replacement regression.",
      workforceContext: {
        workCountry: "US",
        workEnvironment: "office",
        siteExposure: false,
        safetyCritical: false,
      },
    }),
  });
  assert.equal(correction.status, 409);
  const correctionBody = await correction.json() as { message: string };
  assert.match(correctionBody.message, /no specialist handoff is available here/i);
  assert.match(correctionBody.message, /no changes were made/i);
  assert.doesNotMatch(correctionBody.message, /accessibility|medical/i);

  const [after] = await db.select({
    workforceContext: onbCases.workforceContext,
    updatedAt: onbCases.updatedAt,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, legacyCase.id),
  ));
  assert.ok(after);
  assert.deepEqual(after.workforceContext, before.workforceContext);
  assert.equal(after.updatedAt.toISOString(), before.updatedAt);
});

test("redacted callers cannot replace hidden workforce context, and stale versions keep the normal conflict", async () => {
  const storedContext = {
    workCountry: "US",
    workEnvironment: "office" as const,
    hazards: ["warehouse traffic"],
    languagePreference: "en",
    siteExposure: true,
    safetyCritical: false,
  };
  const [legacyCase] = await db.insert(onbCases).values({
    ...intake("Hidden Workforce Context Regression", false),
    organizationId: orgA,
    workforceContext: storedContext,
    lifecycleStage: "preboarding",
    orchestrationStatus: "idle",
  }).returning({
    id: onbCases.id,
    workforceContext: onbCases.workforceContext,
    updatedAt: onbCases.updatedAt,
  });
  assert.ok(legacyCase);
  caseIds.push(legacyCase.id);
  const before = {
    workforceContext: legacyCase.workforceContext,
    updatedAt: legacyCase.updatedAt,
  };
  const benignContext = {
    workEnvironment: "remote" as const,
    siteExposure: false,
    safetyCritical: false,
  };

  const rejected = await call(`/onboarding/cases/${legacyCase.id}/workforce-context`, orgA, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: before.updatedAt.toISOString(),
      reason: "Benign hidden-context replacement regression.",
      workforceContext: benignContext,
    }),
  });
  assert.equal(rejected.status, 409);
  const rejectedBody = await rejected.json() as { message: string };
  assert.match(rejectedBody.message, /workforce-context correction cannot be saved/i);
  assert.match(rejectedBody.message, /no specialist handoff is available here/i);
  assert.match(rejectedBody.message, /no changes were made/i);
  assert.doesNotMatch(rejectedBody.message, /accessibility|medical|hazard|language|country/i);

  const [afterRejected] = await db.select({
    workforceContext: onbCases.workforceContext,
    updatedAt: onbCases.updatedAt,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, legacyCase.id),
  ));
  assert.ok(afterRejected);
  assert.equal(JSON.stringify(afterRejected.workforceContext), JSON.stringify(before.workforceContext));
  assert.equal(afterRejected.updatedAt.toISOString(), before.updatedAt.toISOString());

  const stale = await call(`/onboarding/cases/${legacyCase.id}/workforce-context`, orgA, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: new Date(before.updatedAt.getTime() - 1).toISOString(),
      reason: "Stale hidden-context replacement regression.",
      workforceContext: { ...benignContext, accessibilityNeeds: "Must not affect stale conflict." },
    }),
  });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json() as { message: string };
  assert.match(staleBody.message, /changed since it was loaded/i);
  assert.doesNotMatch(staleBody.message, /accessibility|medical|handoff/i);
});

test("batch intake rejects missing lifecycle policies before any case write", async () => {
  const response = await callWithinIntakeTimeout("/onboarding/batch-intake", orgB, {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: `missing-lifecycle-${suffix}`,
      name: "Missing lifecycle policy",
      people: [{
        personKey: "missing-policy",
        workerName: "Missing Lifecycle Policy",
        workerEmail: `missing-lifecycle-${suffix}@example.com`,
        hireType: "external-fte",
        workerCategory: "employee",
        role: "Engineer",
        department: "Engineering",
        geography: "US",
        legalEntity: "Test Co",
        managerName: "Manager",
        recruiterName: "Recruiter",
        joiningDate: "2030-01-01",
        workforceContext: { workCountry: "US" },
      }],
    }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { message: string }).message, /policies are missing/i);
  assert.equal((await db.select().from(onbCases).where(eq(onbCases.organizationId, orgB))).length, 0);
  assert.equal((await db.select().from(onbCaseLogistics).where(eq(onbCaseLogistics.organizationId, orgB))).length, 0);
  assert.equal((await db.select().from(onbEvents).where(eq(onbEvents.organizationId, orgB))).length, 0);
  assert.equal((await db.select().from(onbIntakeBatches).where(eq(onbIntakeBatches.organizationId, orgB))).length, 0);
  assert.equal((await db.select().from(onbIntakeBatchPeople).where(eq(onbIntakeBatchPeople.organizationId, orgB))).length, 0);
});

test("batch intake creates cases with all eight approved lifecycle policies", async () => {
  const response = await callWithinIntakeTimeout("/onboarding/batch-intake", orgA, {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: `governance-lock-${suffix}`,
      name: "Governance lock regression",
      people: [{
        personKey: "one",
        workerName: "Batch Governance Fixture",
        workerEmail: `batch-governance-${suffix}@example.com`,
        hireType: "external-fte",
        workerCategory: "employee",
        role: "Engineer",
        department: "Engineering",
        geography: "US",
        legalEntity: "Test Co",
        managerName: "Manager",
        recruiterName: "Recruiter",
        joiningDate: "2030-01-01",
        workforceContext: { workCountry: "US" },
      }],
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { results: Array<{ caseId: number }> };
  caseIds.push(body.results[0]!.caseId);
  const [createdCase] = await db.select({
    syntheticProvenance: onbCases.syntheticProvenance,
  }).from(onbCases).where(eq(onbCases.id, body.results[0]!.caseId));
  assert.equal(createdCase?.syntheticProvenance, null, "ordinary batch intake must not assign server-owned synthetic provenance");
});

test("legacy document recovery holds, binds the explicit requester, and does not bypass its missing governance snapshot", async () => {
  const legalUser = `legacy-document-legal-${suffix}`;
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgA, clerkUserId: legalUser, role: "member",
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `legacy-document-legal-authority-${suffix}`,
    organizationId: orgA,
    personUserId: legalUser,
    authorityRole: "legal",
    scopes: ["legal-approve"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "test-governance",
    source: "test",
    governanceDecisionRef: "GOV-TEST",
  });
  const [legacy] = await db.insert(onbCases).values({
    ...intake("Legacy Missing Documents", false),
    organizationId: orgA,
    hireType: "internal-transfer",
    lifecycleStage: "profile-validated",
    orchestrationStatus: "idle",
    createdByUserId: null,
  }).returning();
  caseIds.push(legacy.id);
  const [completed] = await db.insert(onbCases).values({
    ...intake("Completed Missing Documents", false),
    organizationId: orgA,
    hireType: "internal-transfer",
    lifecycleStage: "complete",
    orchestrationStatus: "complete",
    createdByUserId: null,
  }).returning();
  caseIds.push(completed.id);

  // Startup recovery sees the missing legacy pack but cannot invent a
  // requester principal. It must report zero inserted document rows and leave
  // the completed row untouched.
  assert.equal(await backfillDocumentPacks({ organizationId: orgA, caseId: legacy.id }), 0);
  assert.equal((await db.select().from(onbDocuments).where(and(
    eq(onbDocuments.organizationId, orgA), eq(onbDocuments.caseId, legacy.id),
  ))).length, 0);
  assert.equal((await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, orgA), eq(onbApprovals.caseId, legacy.id),
  ))).length, 0);
  assert.equal((await db.select().from(onbDocuments).where(and(
    eq(onbDocuments.organizationId, orgA), eq(onbDocuments.caseId, completed.id),
  ))).length, 0, "completed history is not replayed");
  assert.equal(await backfillDocumentPacks({ organizationId: orgA, caseId: completed.id }), 0);
  const completedRecovery = await call(`/onboarding/cases/${completed.id}/document-recovery`, orgA, {
    method: "POST",
  });
  assert.equal(completedRecovery.status, 409);
  assert.match((await completedRecovery.json() as { message: string }).message, /preserve their history/i);

  const queued = await call(`/onboarding/cases/${legacy.id}/document-recovery`, orgA, {
    method: "POST",
  });
  assert.equal(queued.status, 202);
  const [approval] = await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, orgA),
    eq(onbApprovals.caseId, legacy.id),
    eq(onbApprovals.idempotencyKey, `orchestration:${legacy.id}:approval:execution:documents`),
  ));
  assert.equal(approval.requestedByUserId, user, "the authenticated recovery initiator owns the new request");
  const [preservedCase] = await db.select().from(onbCases).where(eq(onbCases.id, legacy.id));
  assert.equal(preservedCase.createdByUserId, null, "legacy creator provenance remains explicitly unknown");

  const legalDecision = await decideApproval({
    organizationId: orgA,
    approvalId: approval.id,
    expectedVersion: approval.version,
    decision: "approved",
    decidedBy: "untrusted legal display label",
    actorUserId: legalUser,
  });
  assert.equal(legalDecision.outcome, "decided");

  let documents = [] as Array<typeof onbDocuments.$inferSelect>;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    documents = await db.select().from(onbDocuments).where(and(
      eq(onbDocuments.organizationId, orgA), eq(onbDocuments.caseId, legacy.id),
    ));
    // The legal compound approval is intentionally insufficient to authorize
    // a new live effect for a historical case without an adopted governance
    // snapshot. Keep polling briefly to prove no delayed writer slips through.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(documents.length, 0);
  assert.equal((await db.select().from(onbSystemChecks).where(and(
    eq(onbSystemChecks.organizationId, orgA), eq(onbSystemChecks.caseId, legacy.id),
  ))).length, 0, "document recovery never opens BGV/IAM/payroll system work");
  const effects = await db.select().from(onbEffectJournal).where(and(
    eq(onbEffectJournal.organizationId, orgA), eq(onbEffectJournal.caseId, legacy.id),
  ));
  assert.equal(effects.length, 0, "governance denies before an effect is claimed");
  assert.equal(
    await backfillDocumentPacks({ organizationId: orgA, caseId: legacy.id }),
    0,
    "backfill counts only newly inserted documents",
  );
});

test("only tenant owner/admin can atomically confirm Gate A", async () => {
  const [caseRow] = await db.insert(onbCases).values({
    organizationId: orgA,
    workerName: "Confirmation Target",
    workerEmail: `confirmation-${suffix}@example.com`,
    channelPreference: "whatsapp",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Test Co",
    managerName: "Manager",
    recruiterName: "Recruiter",
    // The confirming HR specialist is `user`; persist a separate requestor
    // principal so Gate A can enforce separation of duties.
    createdByUserId: requesterUser,
    joiningDate: "2030-01-01",
    notes: "bgv fixture hard-block",
    workforceContext: { workCountry: "US" },
    orchestrationStatus: "waiting-approval",
    orchestrationCheckpoint: "waiting:offer-acceptance",
  }).returning();
  caseIds.push(caseRow.id);

  const reader = await call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgA, {
    method: "POST", headers: { "x-test-role": "member" }, body: JSON.stringify({ note: "reader cannot confirm" }),
  });
  assert.equal(reader.status, 403);
  const [approval] = await db.insert(onbApprovals).values({
    organizationId: orgA, caseId: caseRow.id, agent: "fixture",
    ruleRef: "Gate C — Day-1 readiness confirmation", hitlPattern: "approve-before-act",
    recommendation: "Confirm", rationale: "Fixture", resumeAction: "none",
    idempotencyKey: `fixture-reader-denied:${caseRow.id}`,
  }).returning();
  const readerDecision = await call(`/onboarding/approvals/${approval.id}/decide`, orgA, {
    method: "POST", headers: { "x-test-role": "member" }, body: JSON.stringify({ decision: "approved", expectedVersion: 1 }),
  });
  assert.equal(readerDecision.status, 403);
  const permissionError = await readerDecision.json() as { message: string };
  assert.match(permissionError.message, /authority is required/i);
  const [unchangedApproval] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval.id));
  assert.equal(unchangedApproval.status, "pending");
  assert.equal(unchangedApproval.version, 1);
  const crossTenant = await call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgB, {
    method: "POST", body: JSON.stringify({ note: "wrong tenant" }),
  });
  assert.equal(crossTenant.status, 404);

  const [first, second] = await Promise.all([
    call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgA, {
      method: "POST", headers: { "x-test-role": "admin" }, body: JSON.stringify({ note: "HR evidence checked", expectedVersion: 1 }),
    }),
    call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgA, {
      method: "POST", body: JSON.stringify({ note: "concurrent retry", expectedVersion: 1 }),
    }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const [current] = await db.select().from(onbCases).where(and(
    eq(onbCases.id, caseRow.id), eq(onbCases.organizationId, orgA),
  ));
  const events = await db.select().from(onbEvents).where(and(
    eq(onbEvents.organizationId, orgA),
    eq(onbEvents.idempotencyKey, `gateway-a:${caseRow.id}:confirmed`),
  ));
  assert.equal(current.offerAcceptanceComplete, true);
  assert.equal(current.offerAcceptanceCompletedBy, user);
  assert.equal(events.length, 1);
  const [gateApproval] = await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, orgA),
    eq(onbApprovals.caseId, caseRow.id),
    eq(onbApprovals.idempotencyKey, `gateway-a:${caseRow.id}:human-queue`),
  ));
  assert.equal(gateApproval.status, "approved");
  assert.equal(gateApproval.authorityScope, "hr-compliance-approve");
  assert.equal(gateApproval.decidedAuthorityId, `gate-a-authority-${suffix}`);
  assert.equal(gateApproval.decidedAuthorityRevision, 1);
  assert.equal(gateApproval.decidedBy, user);
  const [history] = await db.select().from(onbApprovalHistory).where(and(
    eq(onbApprovalHistory.organizationId, orgA),
    eq(onbApprovalHistory.approvalId, gateApproval.id),
    eq(onbApprovalHistory.eventType, "decision"),
  ));
  assert.equal(history.decidedBy, user);
  assert.equal((history.snapshot as { decidedAuthorityId?: string }).decidedAuthorityId, `gate-a-authority-${suffix}`);
  assert.equal((history.snapshot as { decidedAuthorityRevision?: number }).decidedAuthorityRevision, 1);
  await db.transaction((tx) => reopenApprovalInTransaction(tx, {
    organizationId: orgA,
    caseId: caseRow.id,
    approvalId: gateApproval.id,
    reason: "Gate A authority-history retention fixture",
    actor: "test",
  }));
  const [historyAfterReopen] = await db.select().from(onbApprovalHistory).where(and(
    eq(onbApprovalHistory.organizationId, orgA),
    eq(onbApprovalHistory.approvalId, gateApproval.id),
    eq(onbApprovalHistory.eventType, "decision"),
  ));
  assert.equal(historyAfterReopen.decidedBy, user);
  assert.equal((historyAfterReopen.snapshot as { decidedAuthorityId?: string }).decidedAuthorityId, `gate-a-authority-${suffix}`);
});

test("Gate A fails closed for a legacy case with no durable requester principal", async () => {
  const [legacyCase] = await db.insert(onbCases).values({
    organizationId: orgA,
    workerName: "Legacy Gate A requester",
    workerEmail: `legacy-gate-a-${suffix}@example.com`,
    channelPreference: "whatsapp",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Test Co",
    managerName: "Manager",
    recruiterName: "Legacy Recruiter",
    // Deliberately model a pre-principal legacy row. Contact/display data
    // cannot become a requester identity for a Gate A approval.
    createdByUserId: null,
    joiningDate: "2030-01-01",
    notes: "legacy requester provenance fixture",
    workforceContext: { workCountry: "US" },
    orchestrationStatus: "waiting-approval",
    orchestrationCheckpoint: "waiting:offer-acceptance",
  }).returning();
  caseIds.push(legacyCase.id);

  const response = await call(`/onboarding/cases/${legacyCase.id}/offer-acceptance`, orgA, {
    method: "POST",
    body: JSON.stringify({ note: "must not authorize legacy requester", expectedVersion: 1 }),
  });
  assert.equal(response.status, 403);
  const [current] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, legacyCase.id),
  ));
  assert.equal(current.offerAcceptanceComplete, false);
  const [gateApproval] = await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, orgA),
    eq(onbApprovals.caseId, legacyCase.id),
    eq(onbApprovals.idempotencyKey, `gateway-a:${legacyCase.id}:human-queue`),
  ));
  assert.equal(gateApproval.status, "pending");
  assert.equal(gateApproval.requestedByUserId, null);
});

test("governance withdrawal is transactional and immediately fails authority closed", async () => {
  const response = await call("/onboarding/authority/governance/withdraw", orgA, {
    method: "POST",
    body: JSON.stringify({ reason: "Emergency authority withdrawal fixture" }),
  });
  assert.equal(response.status, 200);
  const [governance] = await db.select().from(onbAuthorityGovernance).where(
    eq(onbAuthorityGovernance.organizationId, orgA),
  );
  assert.equal(governance.status, "withdrawn");
  assert.equal(governance.revision, 2);
  const [audit] = await db.select().from(onbAuthorityAudit).where(and(
    eq(onbAuthorityAudit.organizationId, orgA),
    eq(onbAuthorityAudit.action, "governance-withdrawn"),
  ));
  assert.ok(audit);
  const assignment = await call("/onboarding/authority/assignments", orgA);
  assert.equal(assignment.status, 403);
});

test("outcome KPI analytics is tenant-scoped and honors period, region, and domain filters", async () => {
  const region = `KPI-${suffix}`;
  const [tenantA] = await db.insert(onbCases).values({
    organizationId: orgA,
    workerName: "Outcome KPI tenant A",
    workerEmail: `outcome-a-${suffix}@example.com`,
    channelPreference: "whatsapp",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: region,
    legalEntity: "Test Co",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    notes: "outcome KPI route fixture",
    workforceContext: { workCountry: "US" },
  }).returning();
  const [tenantB] = await db.insert(onbCases).values({
    organizationId: orgB,
    workerName: "Outcome KPI tenant B",
    workerEmail: `outcome-b-${suffix}@example.com`,
    channelPreference: "whatsapp",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: region,
    legalEntity: "Test Co",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    notes: "outcome KPI route fixture",
    workforceContext: { workCountry: "US" },
  }).returning();
  caseIds.push(tenantA.id, tenantB.id);

  const filtered = await call(
    `/onboarding/analytics/outcome-kpis?period=7&region=${encodeURIComponent(region)}`,
    orgA,
  );
  assert.equal(filtered.status, 200);
  const filteredBody = await filtered.json() as {
    caseCount: number;
    metrics: Array<{
      id: string;
      eligibleCount: number | null;
      sampleSize: number | null;
      unknownCount: number | null;
      value: number | null;
      status: string;
    }>;
  };
  assert.equal(filteredBody.caseCount, 1);
  assert.equal(
    filteredBody.metrics.find((item) => item.id === "cycle-time")?.eligibleCount,
    1,
  );
  const restrictedEnps = filteredBody.metrics.find((item) => item.id === "enps");
  assert.deepEqual(
    {
      status: restrictedEnps?.status,
      value: restrictedEnps?.value,
      sampleSize: restrictedEnps?.sampleSize,
      eligibleCount: restrictedEnps?.eligibleCount,
      unknownCount: restrictedEnps?.unknownCount,
    },
    { status: "insufficient-data", value: null, sampleSize: null, eligibleCount: null, unknownCount: null },
  );

  const unsupported = await call(
    `/onboarding/analytics/outcome-kpis?period=7&region=${encodeURIComponent(region)}&domain=Payroll`,
    orgA,
  );
  assert.equal(unsupported.status, 200);
  const unsupportedBody = await unsupported.json() as { caseCount: number };
  assert.equal(unsupportedBody.caseCount, 0);
});

test("privacy-scoped outcome export requires a verified privacy/legal assignment and never emits case evidence", async () => {
  const denied = await call("/onboarding/analytics/outcome-kpis/export", orgA);
  assert.equal(denied.status, 403);

  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: orgA,
    authorityRole: "privacy",
    assigneeUserId: user,
    verificationStatus: "verified",
    verifiedByUserId: "test-governance",
    verificationReference: "task254-outcome-export",
  });
  const allowed = await call("/onboarding/analytics/outcome-kpis/export?format=json", orgA);
  assert.equal(allowed.status, 200);
  const payload = await allowed.json() as {
    integrationState: string;
    individualLevelDataIncluded: boolean;
    rows: Array<Record<string, unknown>>;
  };
  assert.equal(payload.integrationState, "pending-powerbi");
  assert.equal(payload.individualLevelDataIncluded, false);
  assert.ok(payload.rows.length > 0);
  assert.ok(payload.rows.every((row) => !("caseId" in row) && !("workerName" in row)));
  assert.ok(payload.rows.every((row) =>
    row.publicationStatus === "published" || row.value === null,
  ));

  const csv = await call("/onboarding/analytics/outcome-kpis/export?format=csv", orgA);
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /# integration_state=pending-powerbi/);
});

test("LMS and calendar registry requirements cannot be toggled into a fake integration", async () => {
  for (const key of ["lms", "calendar"]) {
    const response = await call(`/onboarding/connectors/${key}`, orgA, {
      method: "PATCH",
      body: JSON.stringify({ status: "connected" }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { code: string; requirements: string[] };
    assert.equal(body.code, "CONNECTOR_ACTIVATION_REQUIREMENTS_PENDING");
    assert.ok(body.requirements.length >= 4);
  }
});