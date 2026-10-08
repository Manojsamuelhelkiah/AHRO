import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCases,
  onbConnectors,
  onbEarlyTenureSurveyResponses,
  onbEmploymentOutcomeEvidence,
  onbSensitiveLifecyclePolicies,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import {
  loadOutcomeReportingEvidence,
  recordEmploymentOutcomeEvidence,
  recordOutcomeSurveyEvidence,
} from "./outcome-reporting";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";
import outcomeEvidenceRouter from "../../routes/onboarding-early-tenure";

const suffix = `${process.pid}-${randomUUID()}`;
const organizationId = `outcome-evidence-${suffix}`;
const actorUserId = `outcome-evidence-hr-${suffix}`;
let caseId: number;
let server: Server;
let baseUrl: string;

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Outcome reporting evidence",
    slug: organizationId,
    joinCodeHash: `hash-${organizationId}`,
    createdByUserId: `creator-${suffix}`,
  });
  await db.insert(onbAuthorityGovernance).values({
    organizationId,
    status: "governance-approved",
    approvedByUserId: "test-governance",
    approvedAt: new Date(),
    governanceSource: "test",
    revision: 1,
  });
  await db.insert(organizationMembershipsTable).values({
    organizationId,
    clerkUserId: actorUserId,
    role: "owner",
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `outcome-evidence-authority-${suffix}`,
    organizationId,
    personUserId: actorUserId,
    authorityRole: "hr-compliance",
    scopes: ["hr-compliance-approve"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "test-governance",
    source: "test",
    governanceDecisionRef: "OUTCOME-EVIDENCE-TEST",
  });
  await seedApprovedSensitiveLifecyclePolicies(organizationId);
  const [c] = await db.insert(onbCases).values({
    organizationId,
    workerName: "Restricted outcome subject",
    workerEmail: `restricted-${suffix}@example.com`,
    channelPreference: "whatsapp",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Test Co",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2024-01-01",
    workforceContext: { workCountry: "US" },
  }).returning({ id: onbCases.id });
  caseId = c!.id;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = organizationId;
    req.organizationRole = "owner";
    req.authUserId = actorUserId;
    next();
  });
  app.use(outcomeEvidenceRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(onbEarlyTenureSurveyResponses).where(eq(
    onbEarlyTenureSurveyResponses.organizationId, organizationId,
  ));
  await db.delete(onbEmploymentOutcomeEvidence).where(eq(
    onbEmploymentOutcomeEvidence.organizationId, organizationId,
  ));
  await db.delete(onbCases).where(and(
    eq(onbCases.organizationId, organizationId),
    eq(onbCases.id, caseId),
  ));
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(
    onbSensitiveLifecyclePolicies.organizationId, organizationId,
  ));
  await db.delete(onbAuthorityAssignments).where(eq(
    onbAuthorityAssignments.organizationId, organizationId,
  ));
  await db.delete(onbConnectors).where(eq(
    onbConnectors.organizationId, organizationId,
  ));
  await db.delete(organizationMembershipsTable).where(eq(
    organizationMembershipsTable.organizationId, organizationId,
  ));
  await db.delete(onbAuthorityGovernance).where(eq(
    onbAuthorityGovernance.organizationId, organizationId,
  ));
  await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
});

test("outcome evidence loader returns only minimized authoritative projections", async () => {
  await db.insert(onbEarlyTenureSurveyResponses).values({
    organizationId,
    caseId,
    surveyKind: "onboarding-30-day",
    voluntary: true,
    score: 10,
    submittedAt: new Date("2024-02-01T00:00:00.000Z"),
    provenance: "human-authorized",
    // Real grant ID but a different stored revision: exact revision matching
    // is required, not merely an assignment lookup.
    authorityAssignmentId: `outcome-evidence-authority-${suffix}`,
    authorityAssignmentRevision: 3,
    evidenceReference: "must-not-leave-reporting-boundary",
    recordedByUserId: `human-${suffix}`,
  });
  await db.insert(onbEmploymentOutcomeEvidence).values({
    organizationId,
    caseId,
    actualJoinedAt: new Date("2024-01-01T00:00:00.000Z"),
    employmentStatus: "active",
    effectiveAt: null,
    observedAt: new Date("2024-04-01T00:00:00.000Z"),
    provenance: "human-authorized",
    authorityAssignmentId: `authority-${suffix}`,
    authorityAssignmentRevision: 3,
    evidenceReference: "must-not-leave-reporting-boundary",
    recordedByUserId: `human-${suffix}`,
  });

  const loaded = await loadOutcomeReportingEvidence(organizationId, [caseId]);
  assert.deepEqual(Object.keys(loaded.surveyResponses[0]!).sort(), [
    "actualJoinedAt", "caseId", "humanAuthorityVerified", "id", "provenance", "score",
    "sourceConnectorKey", "submittedAt", "surveyKind", "voluntary",
  ]);
  // A row with an actual grant ID but wrong revision is not trustworthy.
  assert.equal(loaded.surveyResponses[0]!.humanAuthorityVerified, false);
  assert.deepEqual(Object.keys(loaded.employmentEvidence[0]!).sort(), [
    "actualJoinedAt", "caseId", "correctsEvidenceId", "effectiveAt", "employmentStatus",
    "humanAuthorityVerified", "id", "observedAt", "provenance",
    "sourceConnectorKey",
  ]);
  // A nonexistent ID is likewise not enough to enter outcome KPI calculation.
  assert.equal(loaded.employmentEvidence[0]!.humanAuthorityVerified, false);
});

test("writers reject invalid evidence before it can become a KPI input", async () => {
  await assert.rejects(
    recordOutcomeSurveyEvidence({
      organizationId,
      caseId,
      actorUserId: `human-${suffix}`,
      score: 11,
      submittedAt: "2024-02-01T00:00:00.000Z",
      evidenceReference: "bad-score",
      provenance: "human-authorized",
    }),
    /score must be an integer/,
  );
  await assert.rejects(
    recordEmploymentOutcomeEvidence({
      organizationId,
      caseId,
      actorUserId: `human-${suffix}`,
      actualJoinedAt: "2024-02-02T00:00:00.000Z",
      employmentStatus: "active",
      effectiveAt: "2024-02-03T00:00:00.000Z",
      observedAt: "2024-02-04T00:00:00.000Z",
      evidenceReference: "active-cannot-have-effective-date",
      provenance: "human-authorized",
    }),
    /Only terminated/,
  );
  await assert.rejects(
    recordOutcomeSurveyEvidence({
      organizationId,
      caseId,
      actorUserId: `unauthorized-${suffix}`,
      score: 9,
      submittedAt: "2024-02-01T00:00:00.000Z",
      evidenceReference: "must-not-probe-joining-anchor",
      provenance: "human-authorized",
    }),
    /Current governance-approved HR compliance authority/,
  );
  await assert.rejects(
    recordEmploymentOutcomeEvidence({
      organizationId,
      caseId,
      actorUserId: `unauthorized-${suffix}`,
      actualJoinedAt: "2024-01-01T00:00:00.000Z",
      employmentStatus: "active",
      correctsEvidenceId: 999_999,
      observedAt: "2024-04-01T00:00:00.000Z",
      evidenceReference: "must-not-probe-correction",
      provenance: "human-authorized",
    }),
    /Current governance-approved HR compliance authority/,
  );
});

test("trusted survey evidence rejects an unrelated trusted HRIS connector", async () => {
  await db.insert(onbConnectors).values({
    organizationId,
    key: "hris",
    label: "Trusted HRIS",
    vendor: "Test HRIS",
    status: "connected",
    configurationProvenance: "trusted-provider",
    trackingMode: "api",
    description: "Trusted HR record source only",
    authoritativeFor: ["worker identity"],
  });
  await assert.rejects(
    recordOutcomeSurveyEvidence({
      organizationId,
      caseId,
      actorUserId,
      score: 9,
      submittedAt: "2024-02-02T00:00:00.000Z",
      evidenceReference: "must-not-borrow-hris-trust",
      provenance: "trusted-provider",
      sourceConnectorKey: "hris",
    }),
    /not explicitly authorized for voluntary onboarding survey outcomes/,
  );
});

test("restricted routes record only server-authorized human outcome evidence", async () => {
  const call = (path: string, body: Record<string, unknown>) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const employment = await call("/onboarding/analytics/outcome-evidence/employment", {
    caseId,
    actualJoinedAt: "2024-01-01T00:00:00.000Z",
    employmentStatus: "active",
    observedAt: "2024-04-01T00:00:00.000Z",
    evidenceReference: "human-employment-route-record",
  });
  assert.equal(employment.status, 201);
  const survey = await call("/onboarding/analytics/outcome-evidence/surveys", {
    caseId,
    surveyKind: "onboarding-30-day",
    voluntary: true,
    score: 9,
    submittedAt: "2024-02-02T00:00:00.000Z",
    evidenceReference: "human-survey-route-record",
  });
  assert.equal(survey.status, 204);
  const claimedProvider = await call("/onboarding/analytics/outcome-evidence/employment", {
    caseId,
    actualJoinedAt: "2024-01-01T00:00:00.000Z",
    employmentStatus: "active",
    observedAt: "2024-04-01T00:00:00.000Z",
    evidenceReference: "claimed-provider-record",
    provenance: "trusted-provider",
  });
  assert.equal(claimedProvider.status, 400);
  const rows = await loadOutcomeReportingEvidence(organizationId, [caseId]);
  assert.equal(rows.surveyResponses[0]?.humanAuthorityVerified, true);
  assert.equal(rows.employmentEvidence[0]?.humanAuthorityVerified, true);
});

test("loader preserves an immutable verified authority receipt after later grant revocation/context changes", async () => {
  await db.update(onbAuthorityAssignments).set({ siteScope: "CA", status: "revoked" }).where(and(
    eq(onbAuthorityAssignments.organizationId, organizationId),
    eq(onbAuthorityAssignments.id, `outcome-evidence-authority-${suffix}`),
  ));
  const rows = await loadOutcomeReportingEvidence(organizationId, [caseId]);
  const routedSurvey = rows.surveyResponses.find((row) => row.humanAuthorityVerified);
  const routedEmployment = rows.employmentEvidence.find((row) => row.humanAuthorityVerified);
  assert.ok(routedSurvey);
  assert.ok(routedEmployment);
});