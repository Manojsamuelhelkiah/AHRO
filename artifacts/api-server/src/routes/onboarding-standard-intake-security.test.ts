import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  onbEvents,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCases,
  onbStandardIntakeEvents,
  onbSensitiveLifecyclePolicies,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { seedApprovedSensitiveLifecyclePolicies } from "../test-utils/sensitive-lifecycle-fixtures";
import onboardingStandardIntakeRouter from "./onboarding-standard-intake";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import { errorHandler } from "../middlewares/error-handler";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `standard-intake-security-${process.pid}-${randomUUID()}`;
const orgA = `${suffix}-a`;
const orgB = `${suffix}-b`;
let caseAId = 0;
let server: Server;
let baseUrl = "";

async function createCase(organizationId: string) {
  const [created] = await db.insert(onbCases).values({
    organizationId,
    workerName: "Fixture Worker",
    workerEmail: `${randomUUID()}@example.test`,
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Security",
    geography: "US",
    legalEntity: "Fixture US",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2031-01-10",
    workforceContext: { workCountry: "US" },
    lifecycleStage: "trigger-received",
    orchestrationStatus: "standard-intake-pending-review",
  }).returning();
  return created;
}

async function grantHrEvidenceAuthority(organizationId: string, userId: string, caseId: number) {
  await db.insert(onbAuthorityGovernance).values({
    organizationId,
    status: "governance-approved",
    approvedByUserId: "fixture-governance",
    approvedAt: new Date(),
    governanceSource: "fixture",
    revision: 1,
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `${suffix}-${organizationId}-authority`,
    organizationId,
    personUserId: userId,
    personEmail: `${userId}@example.test`,
    emailResponderAuthorized: false,
    authorityRole: "hr-compliance",
    scopes: ["hr-compliance-approve"],
    caseId,
    siteScope: "US",
    jurisdictionScope: "Fixture US",
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "fixture-governance",
    source: "fixture",
    governanceDecisionRef: "fixture",
  });
}

before(async () => {
  if (!hasDb) return;
  await db.insert(organizationsTable).values([
    { id: orgA, name: orgA, slug: orgA, joinCodeHash: `${orgA}-join`, createdByUserId: "hr-a" },
    { id: orgB, name: orgB, slug: orgB, joinCodeHash: `${orgB}-join`, createdByUserId: "hr-b" },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: "hr-a", role: "owner" },
    { organizationId: orgB, clerkUserId: "hr-b", role: "owner" },
  ]);
  const caseA = await createCase(orgA);
  const caseB = await createCase(orgB);
  caseAId = caseA.id;
  await grantHrEvidenceAuthority(orgA, "hr-a", caseA.id);
  await grantHrEvidenceAuthority(orgB, "hr-b", caseB.id);
  await seedApprovedSensitiveLifecyclePolicies(orgA);
  await db.insert(onbStandardIntakeEvents).values({
    organizationId: orgA,
    sourceId: "fixture-ta",
    sourceEventId: "fixture-event",
    eventType: "accepted-offer",
    sourceIdentity: "Fixture TA",
    acceptanceEvidenceReference: "fixture://restricted/evidence",
    payloadFingerprint: "a".repeat(64),
    intakeSnapshot: {},
    workforceContextSnapshot: {},
    processPolicySnapshot: {},
    caseId: caseA.id,
    state: "created",
  });

  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = String(req.header("x-test-user") ?? "");
    next();
  });
  app.use(createTenantContextMiddleware(lookupMembership));
  app.use(onboardingStandardIntakeRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!hasDb) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(onbStandardIntakeEvents).where(and(
    eq(onbStandardIntakeEvents.organizationId, orgA),
  ));
  await db.delete(onbAuthorityAssignments).where(and(eq(onbAuthorityAssignments.organizationId, orgA)));
  await db.delete(onbAuthorityAssignments).where(and(eq(onbAuthorityAssignments.organizationId, orgB)));
  await db.delete(onbAuthorityGovernance).where(eq(onbAuthorityGovernance.organizationId, orgA));
  await db.delete(onbAuthorityGovernance).where(eq(onbAuthorityGovernance.organizationId, orgB));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgA));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgB));
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, orgA));
  await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, orgA));
  await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, orgB));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB));
});

test("standard intake evidence is not disclosed across tenants", { skip: !hasDb }, async () => {
  const own = await fetch(`${baseUrl}/onboarding/cases/${caseAId}/standard-intake-evidence`, {
    headers: { "x-test-user": "hr-a", "x-organization-id": orgA },
  });
  assert.equal(own.status, 200);
  const ownBody = await own.json() as { acceptanceEvidenceReference: string };
  assert.equal(ownBody.acceptanceEvidenceReference, "fixture://restricted/evidence");

  const crossTenant = await fetch(`${baseUrl}/onboarding/cases/${caseAId}/standard-intake-evidence`, {
    headers: { "x-test-user": "hr-b", "x-organization-id": orgB },
  });
  assert.equal(crossTenant.status, 403);
  assert.doesNotMatch(await crossTenant.text(), /fixture:\/\/restricted\/evidence/);
});

test("tenant/source/event uniqueness fences concurrent replay inserts", { skip: !hasDb }, async () => {
  const values = {
    organizationId: orgA,
    sourceId: "race-source",
    sourceEventId: "same-replayed-event",
    eventType: "accepted-offer" as const,
    sourceIdentity: "Fixture TA",
    acceptanceEvidenceReference: "fixture://race",
    payloadFingerprint: "b".repeat(64),
    intakeSnapshot: {},
    workforceContextSnapshot: {},
    processPolicySnapshot: {},
    state: "duplicate-active" as const,
  };
  const results = await Promise.allSettled([
    db.insert(onbStandardIntakeEvents).values(values),
    db.insert(onbStandardIntakeEvents).values(values),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rows = await db.select({ sourceEventId: onbStandardIntakeEvents.sourceEventId })
    .from(onbStandardIntakeEvents).where(and(
      eq(onbStandardIntakeEvents.organizationId, orgA),
      eq(onbStandardIntakeEvents.sourceId, "race-source"),
      eq(onbStandardIntakeEvents.sourceEventId, "same-replayed-event"),
    ));
  assert.equal(rows.length, 1);
});

test("case deletion minimizes retained intake evidence but preserves the dedup tombstone", { skip: !hasDb }, async () => {
  const deletedCase = await createCase(orgA);
  const values = {
    organizationId: orgA,
    sourceId: "tombstone-source",
    sourceEventId: "deleted-case-event",
    eventType: "accepted-offer" as const,
    sourceIdentity: "Fixture TA",
    acceptanceEvidenceReference: "fixture://must-not-survive-case-deletion",
    payloadFingerprint: "c".repeat(64),
    intakeSnapshot: { eventMetadata: "retained-before-deletion" },
    workforceContextSnapshot: { workCountry: "US" },
    processPolicySnapshot: { profileId: "fixture" },
    caseId: deletedCase.id,
    state: "created" as const,
  };
  await db.insert(onbStandardIntakeEvents).values(values);
  await db.delete(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, deletedCase.id),
  ));

  const [tombstone] = await db.select().from(onbStandardIntakeEvents).where(and(
    eq(onbStandardIntakeEvents.organizationId, orgA),
    eq(onbStandardIntakeEvents.sourceId, values.sourceId),
    eq(onbStandardIntakeEvents.sourceEventId, values.sourceEventId),
  ));
  assert.ok(tombstone);
  assert.equal(tombstone.caseId, null);
  assert.equal(tombstone.state, "case-deleted");
  assert.equal(tombstone.acceptanceEvidenceReference, "[minimized: linked case deleted]");
  assert.deepEqual(tombstone.intakeSnapshot, {});
  assert.deepEqual(tombstone.workforceContextSnapshot, {});
  assert.deepEqual(tombstone.processPolicySnapshot, {});
  assert.equal(tombstone.payloadFingerprint, values.payloadFingerprint);

  const replayInsert = await db.insert(onbStandardIntakeEvents).values(values)
    .onConflictDoNothing()
    .returning({ sourceEventId: onbStandardIntakeEvents.sourceEventId });
  assert.deepEqual(replayInsert, []);
});

test("only a canonical scheduled event controls release when accepted-offer duplicates arrive first", { skip: !hasDb }, async () => {
  const scheduledCase = await createCase(orgA);
  const joiningDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await db.update(onbCases).set({ joiningDate }).where(eq(onbCases.id, scheduledCase.id));

  // The active-case duplicate can be received before the canonical event. It
  // must never become the authority for evidence display or release decisions.
  await db.insert(onbStandardIntakeEvents).values({
    organizationId: orgA,
    sourceId: "accepted-duplicate-first",
    sourceEventId: "accepted-duplicate-first",
    eventType: "accepted-offer",
    sourceIdentity: "Fixture TA",
    acceptanceEvidenceReference: "fixture://accepted-duplicate",
    payloadFingerprint: "d".repeat(64),
    intakeSnapshot: {},
    workforceContextSnapshot: {},
    processPolicySnapshot: {},
    caseId: scheduledCase.id,
    state: "duplicate-active",
  });
  await db.insert(onbStandardIntakeEvents).values({
    organizationId: orgA,
    sourceId: "scheduled-canonical-second",
    sourceEventId: "scheduled-canonical-second",
    eventType: "scheduled-preboarding",
    sourceIdentity: "Fixture TA",
    acceptanceEvidenceReference: "fixture://scheduled-canonical",
    payloadFingerprint: "e".repeat(64),
    intakeSnapshot: {},
    workforceContextSnapshot: {},
    processPolicySnapshot: {},
    caseId: scheduledCase.id,
    state: "created",
    activationDueAt: new Date(Date.now() + 86_400_000),
    activationStatus: "scheduled",
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `${suffix}-scheduled-authority`,
    organizationId: orgA,
    personUserId: "hr-a",
    personEmail: "hr-a@example.test",
    emailResponderAuthorized: false,
    authorityRole: "hr-compliance",
    scopes: ["hr-compliance-approve"],
    caseId: scheduledCase.id,
    siteScope: "US",
    jurisdictionScope: "Fixture US",
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "fixture-governance",
    source: "fixture",
    governanceDecisionRef: "fixture",
  });

  const evidence = await fetch(`${baseUrl}/onboarding/cases/${scheduledCase.id}/standard-intake-evidence`, {
    headers: { "x-test-user": "hr-a", "x-organization-id": orgA },
  });
  assert.equal(evidence.status, 200);
  assert.equal((await evidence.json() as { sourceEventId: string }).sourceEventId, "scheduled-canonical-second");

  const earlyRelease = await fetch(`${baseUrl}/onboarding/cases/${scheduledCase.id}/standard-intake/release`, {
    method: "POST",
    headers: { "x-test-user": "hr-a", "x-organization-id": orgA },
  });
  assert.equal(earlyRelease.status, 409);
  assert.match(await earlyRelease.text(), /not due/i);

  await db.update(onbStandardIntakeEvents).set({
    activationDueAt: new Date(Date.now() - 60_000),
    activationStatus: "due-review",
  }).where(and(
    eq(onbStandardIntakeEvents.organizationId, orgA),
    eq(onbStandardIntakeEvents.sourceId, "scheduled-canonical-second"),
    eq(onbStandardIntakeEvents.sourceEventId, "scheduled-canonical-second"),
    eq(onbStandardIntakeEvents.state, "created"),
  ));
  const released = await fetch(`${baseUrl}/onboarding/cases/${scheduledCase.id}/standard-intake/release`, {
    method: "POST",
    headers: { "x-test-user": "hr-a", "x-organization-id": orgA },
  });
  assert.equal(released.status, 200, await released.text());

  const rows = await db.select({
    sourceId: onbStandardIntakeEvents.sourceId,
    activationStatus: onbStandardIntakeEvents.activationStatus,
    activationReleasedAt: onbStandardIntakeEvents.activationReleasedAt,
  }).from(onbStandardIntakeEvents).where(eq(onbStandardIntakeEvents.caseId, scheduledCase.id));
  const canonical = rows.find((row) => row.sourceId === "scheduled-canonical-second");
  const duplicate = rows.find((row) => row.sourceId === "accepted-duplicate-first");
  assert.equal(canonical?.activationStatus, "released");
  assert.ok(canonical?.activationReleasedAt);
  assert.equal(duplicate?.activationStatus, "awaiting-review");
  assert.equal(duplicate?.activationReleasedAt, null);

  // Release intentionally starts the existing engine detached. Wait until it
  // owns the case before suite teardown can remove this isolated fixture.
  let gateAEventWritten = false;
  for (let attempt = 0; attempt < 50 && !gateAEventWritten; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [gateAEvent] = await db.select({ id: onbEvents.id })
      .from(onbEvents).where(and(
        eq(onbEvents.caseId, scheduledCase.id),
        eq(onbEvents.idempotencyKey, `gateway-a:${scheduledCase.id}:blocked`),
      ));
    gateAEventWritten = Boolean(gateAEvent);
  }
  assert.equal(gateAEventWritten, true);
});