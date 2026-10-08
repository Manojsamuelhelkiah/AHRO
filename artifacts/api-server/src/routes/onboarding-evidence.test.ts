import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbCandidateUploads,
  onbCases,
  onbCommunications,
  onbConnectors,
  onbDocuments,
  onbEmployeeRecords,
  onbApprovals,
  onbSensitiveLifecyclePolicies,
  onbSystemChecks,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbGovernanceAuthorityAssignments,
  accessSecurityGroups,
  accessSecurityGroupPolicies,
  accessSecurityGroupUserGroups,
  accessSecurityGroupAttachments,
  accessPrincipalSecurityGroupAttachments,
  accessUserGroups,
  accessUserGroupMembers,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import onboardingRouter, {
  setAfterSensitiveLifecycleGateHookForTests,
} from "./onboarding";
import onboardingAuditRouter from "./onboarding-audit";
import { saveSensitiveLifecyclePolicy } from "../lib/onboarding/sensitive-lifecycle";

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `evidence-a-${suffix}`;
const orgB = `evidence-b-${suffix}`;
const user = `evidence-user-${suffix}`;
const governanceOwnerUser = `evidence-governance-owner-${suffix}`;
const allAccessUser = `evidence-all-classes-${suffix}`;
const identityOnlyUser = `evidence-identity-${suffix}`;
const medicalOnlyUser = `evidence-medical-${suffix}`;
const groupOnlyUser = `evidence-group-only-${suffix}`;
const revokedUser = `evidence-revoked-${suffix}`;
const otherTenantUser = `evidence-other-tenant-${suffix}`;
const specialistUserGroupId = `evidence-specialists-${suffix}`;
const fullAccessUserGroupId = `evidence-full-access-${suffix}`;
const caseReadOnlyUserGroupId = `evidence-case-read-only-${suffix}`;
const specialistSecurityGroupId = `evidence-specialist-policy-${suffix}`;
const fullAccessSecurityGroupId = `evidence-full-access-policy-${suffix}`;
const caseReadOnlySecurityGroupId = `evidence-case-read-only-policy-${suffix}`;
const auditSecurityGroupId = `evidence-audit-read-policy-${suffix}`;
let baseUrl: string;
let caseA: number;
let caseB: number;
let documentA: number;
let uploadA: number;
let mixedUpload: number;
let server: Server;

const caseValues = (organizationId: string, name: string) => ({
  organizationId,
  workerName: name,
  workerEmail: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
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
  workforceClassification: {
    label: "needs-review" as const,
    source: "authorized-correction" as const,
    rationale: "Classification correction references medical clearance and payroll routing.",
    confidence: "medium" as const,
    correction: {
      label: "needs-review" as const,
      by: "authorized-reviewer@example.test",
      reason: "Medical accommodation and payroll account detail require review.",
      at: "2030-01-01T00:00:00.000Z",
    },
  },
  readiness: [{ key: "documentation", label: "Documentation", status: "in-progress" }],
});

async function call(path: string, organizationId: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-organization-id": organizationId,
      "x-test-user": user,
      "x-test-role": "owner",
      ...(init?.headers ?? {}),
    },
  });
}

before(async () => {
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Evidence A", slug: orgA, joinCodeHash: `hash-${orgA}`, createdByUserId: user },
    { id: orgB, name: "Evidence B", slug: orgB, joinCodeHash: `hash-${orgB}`, createdByUserId: user },
  ]);
  // The positive paths below use a real, current authority record. The
  // request's owner role alone must not be relied upon by sensitive routes.
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: user, role: "owner" },
    { organizationId: orgA, clerkUserId: governanceOwnerUser, role: "member" },
    { organizationId: orgA, clerkUserId: revokedUser, role: "owner" },
    { organizationId: orgA, clerkUserId: otherTenantUser, role: "owner" },
    { organizationId: orgA, clerkUserId: identityOnlyUser, role: "member" },
    { organizationId: orgA, clerkUserId: medicalOnlyUser, role: "member" },
    { organizationId: orgA, clerkUserId: allAccessUser, role: "member" },
    { organizationId: orgA, clerkUserId: groupOnlyUser, role: "member" },
    { organizationId: orgB, clerkUserId: otherTenantUser, role: "owner" },
  ]);
  await db.insert(onbAuthorityGovernance).values([orgA, orgB].map((organizationId) => ({
    organizationId,
    status: "governance-approved",
    approvedByUserId: "test-governance",
    approvedAt: new Date(),
    governanceSource: "test",
  })));
  [caseA, caseB] = (await db.insert(onbCases).values([
    caseValues(orgA, "Evidence Alpha"),
    caseValues(orgB, "Evidence Beta"),
  ]).returning({ id: onbCases.id })).map((row) => row.id);
  await db.insert(onbAuthorityAssignments).values({
    id: `test-hr-authority-${suffix}`,
    organizationId: orgA,
    personUserId: user,
    authorityRole: "hr-compliance",
    scopes: ["hr-compliance-approve"],
    validFrom: new Date(Date.now() - 60_000),
    grantorUserId: "test-governance",
    source: "test",
    governanceDecisionRef: "test-governance-approved",
  });
  await db.insert(onbAuthorityAssignments).values([
    {
      id: `test-all-classes-hr-authority-${suffix}`,
      organizationId: orgA, personUserId: allAccessUser, authorityRole: "hr-compliance",
      scopes: ["hr-compliance-approve"], validFrom: new Date(Date.now() - 60_000),
      grantorUserId: "test-governance", source: "test", governanceDecisionRef: "test-governance-approved",
    },
    {
      id: `test-occupational-authority-${suffix}`,
      organizationId: orgA, personUserId: allAccessUser, authorityRole: "occupational-health",
      scopes: ["occupational-health-approve"], validFrom: new Date(Date.now() - 60_000),
      grantorUserId: "test-governance", source: "test", governanceDecisionRef: "test-governance-approved",
    },
    {
      id: `test-payroll-authority-${suffix}`,
      organizationId: orgA, personUserId: allAccessUser, authorityRole: "payroll",
      scopes: ["payroll-approve"], validFrom: new Date(Date.now() - 60_000),
      grantorUserId: "test-governance", source: "test", governanceDecisionRef: "test-governance-approved",
    },
    {
      id: `test-identity-only-authority-${suffix}`,
      organizationId: orgA, personUserId: identityOnlyUser, authorityRole: "hr-compliance",
      scopes: ["hr-compliance-approve"], validFrom: new Date(Date.now() - 60_000),
      grantorUserId: "test-governance", source: "test", governanceDecisionRef: "test-governance-approved",
    },
    {
      id: `test-medical-only-authority-${suffix}`,
      organizationId: orgA, personUserId: medicalOnlyUser, authorityRole: "occupational-health",
      scopes: ["occupational-health-approve"], validFrom: new Date(Date.now() - 60_000),
      grantorUserId: "test-governance", source: "test", governanceDecisionRef: "test-governance-approved",
    },
    {
      id: `test-revoked-occupational-authority-${suffix}`,
      organizationId: orgA,
      personUserId: user,
      authorityRole: "occupational-health",
      scopes: ["occupational-health-approve"],
      validFrom: new Date(Date.now() - 60_000),
      status: "revoked",
      grantorUserId: "test-governance",
      source: "test",
      governanceDecisionRef: "test-revoked-occupational",
      revokedByUserId: "test-governance",
      revokedAt: new Date(),
      revokeReason: "test",
    },
    {
      id: `test-revoked-authority-${suffix}`,
      organizationId: orgA,
      personUserId: revokedUser,
      authorityRole: "hr-compliance",
      scopes: ["hr-compliance-approve"],
      validFrom: new Date(Date.now() - 60_000),
      status: "revoked",
      grantorUserId: "test-governance",
      source: "test",
      governanceDecisionRef: "test-revoked",
      revokedByUserId: "test-governance",
      revokedAt: new Date(),
      revokeReason: "test",
    },
    {
      id: `test-other-tenant-authority-${suffix}`,
      organizationId: orgB,
      personUserId: otherTenantUser,
      authorityRole: "hr-compliance",
      scopes: ["hr-compliance-approve"],
      validFrom: new Date(Date.now() - 60_000),
      grantorUserId: "test-governance",
      source: "test",
      governanceDecisionRef: "test-other-tenant",
    },
  ]);
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: orgA,
    authorityRole: "privacy",
    assigneeUserId: user,
    verificationStatus: "verified",
    verifiedByUserId: "test-governance",
    verificationReference: "test-lifecycle-policy-authority",
  });
  await db.insert(accessUserGroups).values([
    {
      id: specialistUserGroupId, organizationId: orgA, name: specialistUserGroupId,
      ownerUserId: governanceOwnerUser,
      createdByUserId: user,
    },
    {
      id: fullAccessUserGroupId, organizationId: orgA, name: fullAccessUserGroupId,
      ownerUserId: governanceOwnerUser,
      createdByUserId: user,
    },
    {
      id: caseReadOnlyUserGroupId, organizationId: orgA, name: caseReadOnlyUserGroupId,
      ownerUserId: governanceOwnerUser,
      createdByUserId: user,
    },
  ]);
  await db.insert(accessSecurityGroups).values([
    {
      id: specialistSecurityGroupId, organizationId: orgA, name: specialistSecurityGroupId,
      ownerUserId: governanceOwnerUser,
      createdByUserId: user,
    },
    {
      id: fullAccessSecurityGroupId, organizationId: orgA, name: fullAccessSecurityGroupId,
      ownerUserId: governanceOwnerUser,
      createdByUserId: user,
    },
    {
      id: caseReadOnlySecurityGroupId, organizationId: orgA, name: caseReadOnlySecurityGroupId,
      ownerUserId: governanceOwnerUser,
      createdByUserId: user,
    },
    {
      id: auditSecurityGroupId, organizationId: orgA, name: auditSecurityGroupId,
      ownerUserId: governanceOwnerUser,
      createdByUserId: user,
    },
  ]);
  await db.insert(accessUserGroupMembers).values([
    {
      organizationId: orgA, groupId: specialistUserGroupId, principalType: "human",
      principalId: user, attachedByUserId: user, requiresApproval: "yes",
      approvedByUserId: governanceOwnerUser, approvedAt: new Date(),
    },
    {
      organizationId: orgA, groupId: specialistUserGroupId, principalType: "human",
      principalId: revokedUser, attachedByUserId: user, requiresApproval: "yes",
      approvedByUserId: governanceOwnerUser, approvedAt: new Date(),
    },
    {
      organizationId: orgA, groupId: fullAccessUserGroupId, principalType: "human",
      principalId: allAccessUser, attachedByUserId: user, requiresApproval: "yes",
      approvedByUserId: governanceOwnerUser, approvedAt: new Date(),
    },
    {
      organizationId: orgA, groupId: fullAccessUserGroupId, principalType: "human",
      principalId: groupOnlyUser, attachedByUserId: user, requiresApproval: "yes",
      approvedByUserId: governanceOwnerUser, approvedAt: new Date(),
    },
    ...[identityOnlyUser, medicalOnlyUser].map((principalId) => ({
      organizationId: orgA,
      groupId: caseReadOnlyUserGroupId,
      principalType: "human" as const,
      principalId,
      attachedByUserId: user,
    })),
  ]);
  await db.insert(accessSecurityGroupUserGroups).values([
    {
      organizationId: orgA, securityGroupId: specialistSecurityGroupId, userGroupId: specialistUserGroupId,
      attachedByUserId: user, requiresApproval: "yes", approvedByUserId: governanceOwnerUser,
      approvedAt: new Date(), approvedPolicyVersion: 1,
    },
    {
      organizationId: orgA, securityGroupId: fullAccessSecurityGroupId, userGroupId: fullAccessUserGroupId,
      attachedByUserId: user, requiresApproval: "yes", approvedByUserId: governanceOwnerUser,
      approvedAt: new Date(), approvedPolicyVersion: 1,
    },
    {
      organizationId: orgA, securityGroupId: caseReadOnlySecurityGroupId,
      userGroupId: caseReadOnlyUserGroupId, attachedByUserId: user,
    },
  ]);
  const allSensitiveDataFields = ["identity", "medical", "payroll", "bgv"]
    .flatMap((dataClass) => [`data.${dataClass}.read`, `data.${dataClass}.edit`]);
  await db.insert(accessSecurityGroupPolicies).values([
    {
      organizationId: orgA,
      securityGroupId: specialistSecurityGroupId,
      version: 1,
      policy: {
        fields: [
          "data.identity.read",
          "data.identity.edit",
          "data.bgv.read",
          "data.case.readiness.read",
          "data.case.readiness.edit",
          "data.documents.read",
          "data.documents.edit",
          "data.case.profile.read",
          "data.case.profile.edit",
          "data.case.notes.read",
          "data.case.notes.edit",
        ],
        flows: ["flow.case.read", "flow.case.edit", "flow.document-review.read", "flow.document-review.edit"],
        tools: ["tool.documents.edit", "tool.notification.send"],
      },
      createdByUserId: user,
      approvedByUserId: governanceOwnerUser,
      approvedAt: new Date(),
    },
    {
      organizationId: orgA,
      securityGroupId: fullAccessSecurityGroupId,
      version: 1,
      policy: {
        fields: [
          ...allSensitiveDataFields,
          "data.case.readiness.read",
          "data.case.readiness.edit",
          "data.documents.read",
          "data.documents.edit",
          "data.case.profile.read",
          "data.case.notes.read",
        ],
        flows: ["flow.case.read", "flow.document-review.read", "flow.document-review.edit"],
        tools: ["tool.documents.edit", "tool.notification.send", "tool.workflow.run"],
      },
      createdByUserId: user,
      approvedByUserId: governanceOwnerUser,
      approvedAt: new Date(),
    },
    {
      organizationId: orgA,
      securityGroupId: caseReadOnlySecurityGroupId,
      version: 1,
      policy: {
        fields: ["data.documents.read"],
        flows: ["flow.case.read", "flow.document-review.read"],
        tools: [],
      },
      createdByUserId: user,
    },
    {
      organizationId: orgA,
      securityGroupId: auditSecurityGroupId,
      version: 1,
      policy: { fields: ["data.audit.read"], flows: [], tools: [] },
      createdByUserId: user,
      approvedByUserId: governanceOwnerUser,
      approvedAt: new Date(),
    },
  ]);
  await db.insert(accessSecurityGroupAttachments).values([
    {
      organizationId: orgA, securityGroupId: specialistSecurityGroupId, scope: "case",
      caseId: caseA, attachedByUserId: user, requiresApproval: "yes",
      approvedByUserId: governanceOwnerUser, approvedAt: new Date(), approvedPolicyVersion: 1,
    },
    {
      organizationId: orgA, securityGroupId: fullAccessSecurityGroupId, scope: "case",
      caseId: caseA, attachedByUserId: user, requiresApproval: "yes",
      approvedByUserId: governanceOwnerUser, approvedAt: new Date(), approvedPolicyVersion: 1,
    },
    {
      organizationId: orgA, securityGroupId: caseReadOnlySecurityGroupId, scope: "case",
      caseId: caseA, attachedByUserId: user,
    },
    {
      organizationId: orgA, securityGroupId: auditSecurityGroupId, scope: "tenant",
      attachedByUserId: user, requiresApproval: "yes",
      approvedByUserId: governanceOwnerUser, approvedAt: new Date(), approvedPolicyVersion: 1,
    },
  ]);
  await db.insert(accessPrincipalSecurityGroupAttachments).values({
    organizationId: orgA,
    principalType: "human",
    principalId: user,
    securityGroupId: auditSecurityGroupId,
    scope: "tenant",
    status: "active",
    requiresApproval: "yes",
    attachedByUserId: user,
    approvedByUserId: governanceOwnerUser,
    approvedAt: new Date(),
    approvedPolicyVersion: 1,
  });
  await db.insert(onbSensitiveLifecyclePolicies).values([
    "candidate-document", "identity", "medical", "payroll",
    "bgv", "candidate-contact", "candidate-voice", "candidate-portal",
  ].map((dataClass) => ({
    organizationId: orgA,
    dataClass,
    jurisdiction: "US",
    revision: 1,
    purpose: "test evidence lifecycle",
    lawfulBasis: "employment onboarding",
    retentionDays: 30,
    providerSharingApproved: false,
    permittedProviders: [],
    policyReference: "test-policy",
    approvalReference: "test-approval",
    approvedByUserId: user,
    approvedAuthorityAssignmentId: 1,
  })));
  [documentA] = (await db.insert(onbDocuments).values({
    organizationId: orgA, caseId: caseA, key: "id-proof", label: "Government photo ID (passport / national ID)",
    category: "identity", required: true, status: "received",
  }).returning({ id: onbDocuments.id })).map((row) => row.id);
  [uploadA] = (await db.insert(onbCandidateUploads).values({
    organizationId: orgA, caseId: caseA, documentId: documentA,
    objectPath: `test/${suffix}/id-proof.pdf`, originalName: "medical-bank-clearance.pdf",
    contentType: "application/pdf", sizeBytes: 10, validationState: "manual_review",
    checksumSha256: "a".repeat(64), malwareScanState: "clean", malwareScanSha256: "a".repeat(64),
    malwareScannedAt: new Date(),
    validationReasons: [{
      code: "manual_review",
      message: "Provider noted medical clearance and payroll bank routing details.",
    }],
  }).returning({ id: onbCandidateUploads.id })).map((row) => row.id);
  const [mixedDocument] = await db.insert(onbDocuments).values({
    organizationId: orgA, caseId: caseA, key: "medical-passport", label: "Medical passport",
    category: "identity", required: true, status: "received",
  }).returning({ id: onbDocuments.id });
  assert.ok(mixedDocument);
  [mixedUpload] = (await db.insert(onbCandidateUploads).values({
    organizationId: orgA, caseId: caseA, documentId: mixedDocument.id,
    objectPath: `test/${suffix}/medical-passport.pdf`, originalName: "medical-passport.pdf",
    contentType: "application/pdf", sizeBytes: 10, validationState: "manual_review",
    checksumSha256: "b".repeat(64), malwareScanState: "clean", malwareScanSha256: "b".repeat(64),
    malwareScannedAt: new Date(),
  }).returning({ id: onbCandidateUploads.id })).map((row) => row.id);
  await db.insert(onbSystemChecks).values({
    organizationId: orgA, caseId: caseA, system: "bgv", status: "done",
    mode: "poll", externalRef: "bgv-test", requestedAt: new Date(), dueAt: new Date("2030-01-03"),
    note: "Provider remarks include incidental payroll bank routing detail.",
  });
  await db.insert(onbEmployeeRecords).values({
    organizationId: orgA,
    workerEmail: "evidence.alpha@example.com",
    workerName: "Evidence Alpha",
    role: "Engineer",
    department: "Engineering",
    startDate: "2020-01-01",
    endDate: "2024-01-01",
    exitReason: "Medical accommodation required at exit.",
    noticeRequiredDays: 30,
    noticeServedDays: 30,
    performanceRating: "4.0",
    rehireEligible: true,
    notes: "Archive feedback includes payroll account follow-up.",
  });
  await db.insert(onbCommunications).values([
    {
      organizationId: orgA, caseId: caseA, channel: "email", direction: "outbound",
      audience: "candidate", toAddress: "masked@example.test", subject: "BGV update",
      body: "Background verification finding.", status: "sent", sensitive: true, sensitiveDataClass: "bgv",
    },
    {
      organizationId: orgA, caseId: caseA, channel: "voice", direction: "outbound",
      audience: "candidate", toAddress: "masked@example.test", subject: "Voice follow-up",
      body: "Private candidate voice follow-up.", status: "sent", sensitive: true, sensitiveDataClass: "candidate-voice",
    },
    {
      organizationId: orgA, caseId: caseA, channel: "email", direction: "inbound",
      audience: "candidate", toAddress: "masked@example.test", subject: "Legacy",
      body: "Opaque legacy confidential payload.", status: "received", sensitive: true, sensitiveDataClass: "unclassified-legacy",
    },
    {
      organizationId: orgA, caseId: caseA, channel: "voice", direction: "inbound",
      audience: "candidate", toAddress: "masked@example.test", subject: "Follow-up",
      body: "Candidate mentioned an unrecognized treatment and bank routing details.",
      status: "received", sensitive: true, sensitiveDataClass: "candidate-contact",
    },
  ]);
  await db.insert(onbApprovals).values({
    organizationId: orgA,
    caseId: caseA,
    agent: "policy",
    ruleRef: "legacy-private-evidence",
    recommendation: "Candidate medical accommodation and bank account details were reviewed.",
    rationale: "Opaque private historical decision evidence.",
    status: "pending",
    authorityReviewStatus: "unresolved",
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = String(req.header("x-organization-id") ?? orgA);
    const role = req.header("x-test-role");
    req.organizationRole = role === "member" || role === "admin" ? role : "owner";
    req.authUserId = String(req.header("x-test-user") ?? user);
    next();
  });
  app.use(onboardingRouter);
  app.use(onboardingAuditRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(onbCases).where(inArray(onbCases.id, [caseA, caseB]));
  await db.delete(onbEmployeeRecords).where(inArray(onbEmployeeRecords.organizationId, [orgA, orgB]));
  await db.delete(onbGovernanceAuthorityAssignments).where(
    inArray(onbGovernanceAuthorityAssignments.organizationId, [orgA, orgB]),
  );
  await db.delete(onbConnectors).where(inArray(onbConnectors.organizationId, [orgA, orgB]));
  await db.delete(onbSensitiveLifecyclePolicies).where(
    inArray(onbSensitiveLifecyclePolicies.organizationId, [orgA, orgB]),
  );
  await db.delete(onbGovernanceAuthorityAssignments).where(
    inArray(onbGovernanceAuthorityAssignments.organizationId, [orgA, orgB]),
  );
  await db.delete(accessSecurityGroups).where(eq(accessSecurityGroups.organizationId, orgA));
  await db.delete(accessUserGroups).where(eq(accessUserGroups.organizationId, orgA));
  await deleteTestOrganizations(inArray(organizationsTable.id, [orgA, orgB]));
});

test("evidence and BGV lists are tenant scoped", async () => {
  assert.equal((await call(`/onboarding/cases/${caseA}/evidence`, orgA)).status, 200);
  assert.equal((await call(`/onboarding/cases/${caseA}/bgv`, orgA)).status, 200);
  assert.equal((await call(`/onboarding/cases/${caseA}/evidence`, orgB)).status, 404);
  assert.equal((await call(`/onboarding/cases/${caseA}/bgv`, orgB)).status, 404);
});

test("document-review and readiness keys supplement specialist, case, and lifecycle gates", async () => {
  const noDocumentRead = await call(`/onboarding/cases/${caseA}/evidence`, orgA, {
    headers: { "x-test-user": otherTenantUser },
  });
  assert.equal(noDocumentRead.status, 403);
  assert.equal((await noDocumentRead.json() as { code: string }).code, "DOCUMENT_ACCESS_REQUIRED");

  const reviewReader = await call(`/onboarding/cases/${caseA}/evidence`, orgA, {
    headers: { "x-test-user": identityOnlyUser },
  });
  assert.equal(reviewReader.status, 200);
  const documents = await call(`/onboarding/cases/${caseA}/documents`, orgA, {
    headers: { "x-test-user": identityOnlyUser },
  });
  assert.equal(documents.status, 200);

  const caseView = await call(`/onboarding/cases/${caseA}`, orgA, {
    headers: { "x-test-user": identityOnlyUser },
  });
  assert.equal(caseView.status, 200);
  const readinessView = await caseView.json() as {
    readiness: unknown[];
    gateways: { a: { status: string }; b: { status: string }; c: { status: string } };
  };
  assert.deepEqual(readinessView.readiness, []);
  assert.deepEqual(
    [readinessView.gateways.a.status, readinessView.gateways.b.status, readinessView.gateways.c.status],
    ["restricted", "restricted", "restricted"],
  );

  const noReadinessEdit = await call(`/onboarding/cases/${caseA}/checklist/custom-readiness-item`, orgA, {
    method: "PUT",
    headers: { "x-test-user": identityOnlyUser },
    body: JSON.stringify({ status: "ready" }),
  });
  assert.equal(noReadinessEdit.status, 403);
});

test("protected audit review requires both reviewer role and data.audit.read", async () => {
  const missingDataGrant = await call("/onboarding/audit/lifecycle", orgA, {
    headers: { "x-test-user": revokedUser },
  });
  assert.equal(missingDataGrant.status, 403);
  assert.equal((await missingDataGrant.json() as { code: string }).code, "AUDIT_ACCESS_REQUIRED");

  const memberWithoutReviewerRole = await call("/onboarding/audit/lifecycle", orgA, {
    headers: { "x-test-user": groupOnlyUser },
  });
  assert.equal(memberWithoutReviewerRole.status, 403);

  const authorized = await call("/onboarding/audit/lifecycle", orgA);
  assert.equal(authorized.status, 200);
});

test("Gate C approval list, history, capability, and decision honor readiness keys", async () => {
  const [approval] = await db.insert(onbApprovals).values({
    organizationId: orgA,
    caseId: caseA,
    agent: "day1-readiness-gate",
    ruleRef: "Gate C — Day-1 readiness confirmation",
    recommendation: "Review current readiness.",
    rationale: "Final readiness review.",
    status: "pending",
    authorityScope: "hr-compliance-approve",
    idempotencyKey: `gateway-c:${caseA}:human-queue`,
  }).returning({ id: onbApprovals.id });
  assert.ok(approval);
  try {
    const queue = await call("/onboarding/approvals", orgA, {
      headers: { "x-test-user": identityOnlyUser },
    });
    const queueRows = await queue.json() as Array<{ id: number }>;
    assert.ok(!queueRows.some((row) => row.id === approval.id));

    const history = await call(`/onboarding/approvals/${approval.id}/history`, orgA, {
      headers: { "x-test-user": identityOnlyUser },
    });
    assert.equal(history.status, 403);
    assert.equal((await history.json() as { code: string }).code, "CASE_READINESS_ACCESS_REQUIRED");

    const capability = await call(`/onboarding/approvals/${approval.id}/capability`, orgA, {
      headers: { "x-test-user": identityOnlyUser },
    });
    assert.deepEqual(await capability.json(), {
      canDecide: false,
      reason: "readiness_access_required",
      version: 1,
    });

    const decision = await call(`/onboarding/approvals/${approval.id}/decide`, orgA, {
      method: "POST",
      headers: { "x-test-user": identityOnlyUser },
      body: JSON.stringify({ decision: "approved", expectedVersion: 1 }),
    });
    assert.equal(decision.status, 403);
    assert.match(
      (await decision.json() as { message: string }).message,
      /data\.case\.readiness\.edit grant/i,
    );
    const [unchanged] = await db.select({ status: onbApprovals.status })
      .from(onbApprovals).where(eq(onbApprovals.id, approval.id));
    assert.equal(unchanged?.status, "pending");
  } finally {
    await db.delete(onbApprovals).where(eq(onbApprovals.id, approval.id));
  }
});

test("sensitive reads and writes require both current specialist authority and explicit field policy", async () => {
  const legacyAuthorityOnly = await call(`/onboarding/cases/${caseA}/evidence`, orgA, {
    headers: { "x-test-user": identityOnlyUser },
  });
  assert.equal(legacyAuthorityOnly.status, 200);
  const [legacyDocument] = await legacyAuthorityOnly.json() as Array<Record<string, unknown>>;
  assert.equal(legacyDocument.restricted, true, "legacy specialist authority must not auto-map to a security-group field allow");

  const groupWithoutSpecialist = await call(`/onboarding/cases/${caseA}/evidence`, orgA, {
    headers: { "x-test-user": groupOnlyUser },
  });
  assert.equal(groupWithoutSpecialist.status, 200);
  const [groupOnlyDocument] = await groupWithoutSpecialist.json() as Array<Record<string, unknown>>;
  assert.equal(groupOnlyDocument.restricted, true, "a field allow cannot replace the live specialist assignment");

  const specialistAndAllow = await call(`/onboarding/cases/${caseA}/evidence`, orgA);
  assert.equal(specialistAndAllow.status, 200);
  const authorizedDocument = (await specialistAndAllow.json() as Array<Record<string, unknown>>)
    .find((row) => Number(row.id) === uploadA);
  assert.equal(authorizedDocument?.originalName, "Restricted confidential filename.");

  const noDocumentEdit = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST",
    headers: { "x-test-user": identityOnlyUser },
    body: JSON.stringify({ decision: "approve", reason: "Document edit permission is missing." }),
  });
  assert.equal(noDocumentEdit.status, 403);
  const [unchangedUpload] = await db.select({ state: onbCandidateUploads.validationState })
    .from(onbCandidateUploads).where(eq(onbCandidateUploads.id, uploadA));
  assert.equal(unchangedUpload?.state, "manual_review");

  const missingEditField = await call(`/onboarding/cases/${caseA}/bgv-notifications/reconcile`, orgA, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(missingEditField.status, 403, "BGV specialist authority cannot substitute for data.bgv.edit");
});

test("workforce-context corrections reject unrecognized fields before persistence", async () => {
  const response = await call(`/onboarding/cases/${caseA}/workforce-context`, orgA, {
    method: "PUT",
    body: JSON.stringify({
      workforceContext: { workCountry: "US", unknownSensitiveField: "private payload" },
      reason: "Correct job context",
      expectedUpdatedAt: new Date().toISOString(),
    }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unknown workforce-context correction field/);
});

test("partial document access exposes typed evidence state but not filename or provider narrative", async () => {
  const partial = await call(`/onboarding/cases/${caseA}/evidence`, orgA);
  assert.equal(partial.status, 200);
  const partialEvidence = (await partial.json() as Array<{
    id: number;
    originalName: string;
    validationState: string;
    validationReasons: Array<{ code: string; message: string }>;
  }>).find((row) => row.id === uploadA);
  assert.ok(partialEvidence);
  assert.equal(partialEvidence.validationState, "manual_review");
  assert.equal(partialEvidence.originalName, "Restricted confidential filename.");
  assert.deepEqual(partialEvidence.validationReasons, [{
    code: "restricted",
    message: "Validation details are restricted to the assigned confidential-record reviewers.",
  }]);
  assert.doesNotMatch(JSON.stringify(partialEvidence), /medical-bank|medical clearance|bank routing/i);

  const complete = await call(`/onboarding/cases/${caseA}/evidence`, orgA, {
    headers: { "x-test-user": allAccessUser },
  });
  const completeEvidence = (await complete.json() as Array<{
    id: number;
    originalName: string;
    validationReasons: Array<{ message: string }>;
  }>).find((row) => row.id === uploadA);
  assert.ok(completeEvidence);
  assert.equal(completeEvidence.originalName, "medical-bank-clearance.pdf");
  assert.match(completeEvidence.validationReasons[0]?.message ?? "", /medical clearance.*bank routing/i);
});

test("partial BGV and archive specialists receive typed status but not opaque provider or archive narratives", async () => {
  const partialBgv = await call(`/onboarding/cases/${caseA}/bgv`, orgA);
  assert.equal(partialBgv.status, 200);
  const [partialCheck] = await partialBgv.json() as Array<Record<string, unknown>>;
  assert.equal(partialCheck.status, "clear");
  assert.equal(partialCheck.externalRef, undefined);
  assert.equal(
    partialCheck.note,
    "Background-verification narrative details are restricted to the assigned confidential-record reviewers.",
  );
  assert.doesNotMatch(JSON.stringify(partialCheck), /payroll|bank routing/i);

  const partialArchive = await call(`/onboarding/cases/${caseA}/records`, orgA);
  assert.equal(partialArchive.status, 200);
  const [partialStint] = await partialArchive.json() as Array<Record<string, unknown>>;
  assert.equal(partialStint.role, "Engineer");
  assert.equal(partialStint.exitReason, "Restricted confidential archived-record narrative.");
  assert.equal(partialStint.notes, "Restricted confidential archived-record narrative.");
  assert.doesNotMatch(JSON.stringify(partialStint), /medical accommodation|payroll account/i);

  const completeArchive = await call(`/onboarding/cases/${caseA}/records`, orgA, {
    headers: { "x-test-user": allAccessUser },
  });
  const [completeStint] = await completeArchive.json() as Array<Record<string, unknown>>;
  assert.equal(completeStint.exitReason, "Medical accommodation required at exit.");
  assert.equal(completeStint.notes, "Archive feedback includes payroll account follow-up.");
});

test("watcher projections retain typed system state but redact provider references and mixed narratives", async () => {
  const partial = await call("/onboarding/systems/watcher", orgA);
  assert.equal(partial.status, 200);
  const partialPayload = await partial.json() as { checks: Array<Record<string, unknown>> };
  const partialCheck = partialPayload.checks.find((check) => check.system === "bgv" && check.caseId === caseA);
  assert.ok(partialCheck);
  assert.equal(partialCheck.status, "done");
  assert.equal(partialCheck.externalRef, undefined);
  assert.equal(
    partialCheck.note,
    "System-provider narrative details are restricted to the assigned confidential-record reviewers.",
  );
  assert.doesNotMatch(JSON.stringify(partialCheck), /payroll|bank routing|bgv-test/i);

  const revoked = await call("/onboarding/systems/watcher", orgA, {
    headers: { "x-test-user": revokedUser },
  });
  const revokedPayload = await revoked.json() as { checks: Array<Record<string, unknown>> };
  const revokedCheck = revokedPayload.checks.find((check) => check.system === "bgv" && check.caseId === caseA);
  assert.ok(revokedCheck);
  assert.equal(revokedCheck.restricted, true);
  assert.equal(revokedCheck.note, undefined);
  assert.equal(revokedCheck.externalRef, undefined);

  const complete = await call("/onboarding/systems/watcher", orgA, {
    headers: { "x-test-user": allAccessUser },
  });
  const completePayload = await complete.json() as { checks: Array<Record<string, unknown>> };
  const completeCheck = completePayload.checks.find((check) => check.system === "bgv" && check.caseId === caseA);
  assert.ok(completeCheck);
  assert.equal(completeCheck.externalRef, "bgv-test");
  assert.equal(completeCheck.note, "Provider remarks include incidental payroll bank routing detail.");
});

test("case serialization redacts correction reviewer and rationale narratives without all-class authority", async () => {
  for (const actor of [user, revokedUser]) {
    const response = await call(`/onboarding/cases/${caseA}`, orgA, {
      headers: { "x-test-user": actor },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { workforceClassification: Record<string, unknown> };
    assert.equal(payload.workforceClassification.label, "needs-review");
    assert.equal(payload.workforceClassification.source, "authorized-correction");
    assert.equal(payload.workforceClassification.rationale, "Restricted confidential workforce-classification rationale.");
    assert.deepEqual(payload.workforceClassification.correction, { label: "needs-review" });
    assert.doesNotMatch(JSON.stringify(payload.workforceClassification), /authorized-reviewer|medical accommodation|payroll account/i);
  }

  const complete = await call(`/onboarding/cases/${caseA}`, orgA, {
    headers: { "x-test-user": allAccessUser },
  });
  const fullPayload = await complete.json() as { workforceClassification: Record<string, unknown> };
  assert.equal(
    fullPayload.workforceClassification.rationale,
    "Classification correction references medical clearance and payroll routing.",
  );
  assert.equal(
    (fullPayload.workforceClassification.correction as Record<string, unknown>).reason,
    "Medical accommodation and payroll account detail require review.",
  );
  assert.equal(
    (fullPayload.workforceClassification.correction as Record<string, unknown>).by,
    "authorized-reviewer@example.test",
  );
});

test("communication narratives require every current specialist authority", async () => {
  const authorized = await call(`/onboarding/cases/${caseA}/communications`, orgA, {
    headers: { "x-test-user": allAccessUser },
  });
  assert.equal(authorized.status, 200);
  const authorizedRows = await authorized.json() as Array<{ subject: string; body: string }>;
  assert.equal(authorizedRows.find((row) => row.subject === "BGV update")?.body, "Background verification finding.");
  assert.equal(authorizedRows.find((row) => row.subject === "Voice follow-up")?.body, "Private candidate voice follow-up.");
  assert.equal(
    authorizedRows.find((row) => row.subject === "Follow-up")?.body,
    "Candidate mentioned an unrecognized treatment and bank routing details.",
  );

  for (const partialUser of [identityOnlyUser, medicalOnlyUser, revokedUser]) {
    const unauthorized = await call(`/onboarding/cases/${caseA}/communications`, orgA, {
      headers: { "x-test-user": partialUser, "x-test-role": "owner" },
    });
    assert.equal(unauthorized.status, 200);
    const unauthorizedRows = await unauthorized.json() as Array<{ subject: string; body: string }>;
    assert.ok(unauthorizedRows.every((row) => row.subject === "Restricted confidential onboarding communication"));
    assert.doesNotMatch(JSON.stringify(unauthorizedRows), /unrecognized treatment|bank routing/i);
  }
});

test("owner role alone cannot read unresolved opaque approval evidence", async () => {
  const response = await call("/onboarding/authority/unresolved-approvals", orgA, {
    headers: { "x-test-user": revokedUser, "x-test-role": "owner" },
  });
  assert.equal(response.status, 200);
  const [approval] = await response.json() as Array<Record<string, unknown>>;
  assert.equal(approval.restricted, true);
  assert.equal(approval.recommendation, "Restricted historical approval evidence.");
  assert.doesNotMatch(JSON.stringify(approval), /medical accommodation|bank account|opaque private/i);
});

test("revoked or other-tenant authority assignments never disclose case evidence", async () => {
  for (const actor of [revokedUser, otherTenantUser]) {
    const response = await call(`/onboarding/cases/${caseA}/evidence`, orgA, {
      headers: { "x-test-user": actor },
    });
    if (actor === otherTenantUser) {
      assert.equal(response.status, 403);
    } else {
      assert.equal(response.status, 200);
      const [row] = await response.json() as Array<Record<string, unknown>>;
      assert.equal(row.restricted, true, `actor ${actor} must not receive evidence metadata`);
      assert.equal(row.originalName, undefined);
    }

    const bgv = await call(`/onboarding/cases/${caseA}/bgv`, orgA, {
      headers: { "x-test-user": actor },
    });
    assert.equal(bgv.status, 200);
    const [check] = await bgv.json() as Array<Record<string, unknown>>;
    assert.equal(check.restricted, true, `actor ${actor} must not receive BGV details`);
    assert.equal(check.externalRef, undefined);
  }
});

test("a revoked secondary specialist scope blocks a mixed-class evidence decision", async () => {
  const response = await call(`/onboarding/cases/${caseA}/evidence/${mixedUpload}/decision`, orgA, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", reason: "Reviewed mixed evidence." }),
  });
  assert.equal(response.status, 403);
  const [upload] = await db.select({ state: onbCandidateUploads.validationState })
    .from(onbCandidateUploads).where(eq(onbCandidateUploads.id, mixedUpload));
  assert.equal(upload?.state, "manual_review");
});

test("HR evidence decisions atomically update upload and document, with role and tenant fences", async () => {
  const denied = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", headers: { "x-test-role": "member", "x-test-user": revokedUser },
    body: JSON.stringify({ decision: "approve", reason: "Looks good." }),
  });
  assert.equal(denied.status, 403);

  const crossTenant = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgB, {
    method: "POST", body: JSON.stringify({ decision: "approve", reason: "No cross-tenant decisions." }),
  });
  assert.equal(crossTenant.status, 404);

  const metadata = await call(`/onboarding/cases/${caseA}/evidence`, orgA);
  assert.equal(metadata.status, 200);
  const metadataRows = await metadata.json() as Array<Record<string, unknown>>;
  const metadataRow = metadataRows.find((row) => Number(row.id) === uploadA);
  assert.ok(metadataRow);
  assert.equal(metadataRow.malwareScanState, "clean");
  assert.equal(metadataRow.canReview, true);
  assert.equal(metadataRow.isLatest, true);
  assert.equal(metadataRow.canRequestCorrection, true);
  assert.ok(metadataRow.malwareScannedAt);
  assert.equal("malwareScanId" in metadataRow, false);

  const approved = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "approve", reason: "Looks good." }),
  });
  assert.equal(approved.status, 200);
  const [upload] = await db.select().from(onbCandidateUploads).where(eq(onbCandidateUploads.id, uploadA));
  const [document] = await db.select().from(onbDocuments).where(eq(onbDocuments.id, documentA));
  assert.equal(upload.validationState, "passed");
  assert.equal(document.status, "verified");
  assert.equal(document.reminderNextAt, null);

  await db.update(onbCandidateUploads).set({ validationState: "manual_review" })
    .where(eq(onbCandidateUploads.id, uploadA));
  await db.update(onbDocuments).set({ status: "received" })
    .where(eq(onbDocuments.id, documentA));
  const correction = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "request_correction", reason: "Please upload a clearer copy." }),
  });
  assert.equal(correction.status, 200);
  const [correctedUpload] = await db.select().from(onbCandidateUploads).where(eq(onbCandidateUploads.id, uploadA));
  const [correctedDocument] = await db.select().from(onbDocuments).where(eq(onbDocuments.id, documentA));
  assert.equal(correctedUpload.validationState, "correction_requested");
  assert.equal(correctedDocument.status, "received");
  assert.equal(correctedDocument.note, "Please upload a clearer copy.");

  await db.update(onbCandidateUploads).set({
    validationState: "queued",
    malwareScanState: "infected",
    malwareScanSha256: null,
  }).where(eq(onbCandidateUploads.id, uploadA));
  const malwareCorrection = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "request_correction", reason: "Please submit a different file." }),
  });
  assert.equal(malwareCorrection.status, 200);

  const deniedMalwareStates = [
    "infected", "pending", "scanning", "unavailable", "timeout", "indeterminate",
  ] as const;
  for (const malwareScanState of deniedMalwareStates) {
    await db.update(onbCandidateUploads).set({
      validationState: "manual_review",
      malwareScanState,
      malwareScanSha256: null,
      checksumSha256: "a".repeat(64),
    }).where(eq(onbCandidateUploads.id, uploadA));
    await db.update(onbDocuments).set({ status: "received" }).where(eq(onbDocuments.id, documentA));
    const deniedMalware = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
      method: "POST", body: JSON.stringify({ decision: "approve", reason: `Blocked by ${malwareScanState}.` }),
    });
    assert.equal(deniedMalware.status, 409, `malware state ${malwareScanState} must block approval`);
  }

  await db.update(onbCandidateUploads).set({
    validationState: "manual_review",
    malwareScanState: "clean",
    checksumSha256: null,
    malwareScanSha256: null,
  }).where(eq(onbCandidateUploads.id, uploadA));
  await db.update(onbDocuments).set({ status: "received" }).where(eq(onbDocuments.id, documentA));
  const legacyDenied = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "approve", reason: "Legacy upload without a bound checksum." }),
  });
  assert.equal(legacyDenied.status, 409);

  const [newerUpload] = await db.insert(onbCandidateUploads).values({
    organizationId: orgA, caseId: caseA, documentId: documentA,
    objectPath: `test/${suffix}/id-proof-new.pdf`, originalName: "id-proof-new.pdf",
    contentType: "application/pdf", sizeBytes: 10, validationState: "manual_review",
    checksumSha256: "b".repeat(64), malwareScanState: "clean", malwareScanSha256: "b".repeat(64),
    malwareScannedAt: new Date(),
  }).returning({ id: onbCandidateUploads.id });
  const staleDenied = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "approve", reason: "Stale upload must not be approved." }),
  });
  assert.equal(staleDenied.status, 409);
  const staleCorrectionDenied = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "request_correction", reason: "Obsolete upload must not alter the checklist." }),
  });
  assert.equal(staleCorrectionDenied.status, 409);

  await db.update(onbCandidateUploads).set({
    malwareScanState: "unavailable", malwareScanSha256: null, validationState: "manual_review",
  }).where(eq(onbCandidateUploads.id, newerUpload.id));
  const retryDenied = await call(`/onboarding/cases/${caseA}/evidence/${newerUpload.id}/retry-malware-scan`, orgA, {
    method: "POST", headers: { "x-test-role": "member" },
  });
  assert.equal(retryDenied.status, 403);
  const retryCrossTenant = await call(`/onboarding/cases/${caseA}/evidence/${newerUpload.id}/retry-malware-scan`, orgB, {
    method: "POST",
  });
  assert.equal(retryCrossTenant.status, 404);
  const retry = await call(`/onboarding/cases/${caseA}/evidence/${newerUpload.id}/retry-malware-scan`, orgA, {
    method: "POST",
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as { malwareScanState: string }).malwareScanState, "pending");
});

test("an evidence decision holds the lifecycle fence from its successful gate through persistence", async () => {
  const [document] = await db.insert(onbDocuments).values({
    organizationId: orgA, caseId: caseA, key: `fenced-evidence-${suffix}`,
    label: "Fenced evidence", category: "identity", required: true, status: "received",
  }).returning({ id: onbDocuments.id });
  const [upload] = await db.insert(onbCandidateUploads).values({
    organizationId: orgA, caseId: caseA, documentId: document!.id,
    objectPath: `test/${suffix}/fenced-evidence.pdf`, originalName: "fenced-evidence.pdf",
    contentType: "application/pdf", sizeBytes: 10, validationState: "manual_review",
    checksumSha256: "c".repeat(64), malwareScanState: "clean", malwareScanSha256: "c".repeat(64),
    malwareScannedAt: new Date(),
  }).returning({ id: onbCandidateUploads.id });
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
    if (mutation !== "evidence-decision") return;
    gatePassed();
    await waitForRelease;
  });

  let policyChanged = false;
  let decision: Promise<Response> | undefined;
  try {
    decision = call(`/onboarding/cases/${caseA}/evidence/${upload!.id}/decision`, orgA, {
      method: "POST",
      // This custom document is an opaque four-class envelope. Use the
      // fixture's genuine all-class authority rather than relying on the
      // owner's identity-only HR authority.
      headers: { "x-test-user": allAccessUser, "x-test-role": "member" },
      body: JSON.stringify({ decision: "approve", reason: "Fence the lifecycle policy revision." }),
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const gateOutcome = await Promise.race([
      gatePassedPromise.then(() => ({ kind: "gate" as const })),
      decision.then(
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
        ? `Evidence decision completed with HTTP ${gateOutcome.status} before the lifecycle gate hook.`
        : gateOutcome.kind === "error"
          ? `Evidence decision rejected before the lifecycle gate hook: ${String(gateOutcome.error)}`
          : "Evidence decision did not reach the lifecycle gate hook within five seconds.",
    );
    // This begins from the test's independent async context, not the request's
    // re-entrant fence context. It must wait for the route to persist.
    const policyChange = saveSensitiveLifecyclePolicy({
      organizationId: orgA,
      actorUserId: user,
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
    assert.equal(policyChanged, false, "policy change must wait after the evidence gate passes");
    releaseGate();
    assert.equal((await decision).status, 200);
    await policyChange;
    assert.equal(policyChanged, true);
  } finally {
    setAfterSensitiveLifecycleGateHookForTests(undefined);
    releaseGate?.();
    await decision?.catch(() => undefined);
  }
});