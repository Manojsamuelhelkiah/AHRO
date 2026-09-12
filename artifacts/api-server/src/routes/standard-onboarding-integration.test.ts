import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbCases,
  onbEffectJournal,
  onbEvents,
  onbSettings,
  onbStandardIntakeEvents,
  onbSensitiveLifecyclePolicies,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { seedApprovedSensitiveLifecyclePolicies } from "../test-utils/sensitive-lifecycle-fixtures";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import { errorHandler } from "../middlewares/error-handler";
import onboardingStandardIntakeRouter from "./onboarding-standard-intake";
import onboardingStandardOperationsRouter from "./onboarding-standard-operations";
import { scheduledPreboardingDueAt } from "../lib/onboarding/standard-intake";
import {
  changeStandardOperationsStartDate,
  reconcileStandardOperationsStartDateImpact,
  setStandardOperationsException,
  setStandardOperationsManualFulfillment,
} from "../lib/onboarding/standard-operations";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `standard-onboarding-integration-${process.pid}-${randomUUID()}`;
const orgA = `${suffix}-a`;
const orgB = `${suffix}-b`;
const ownerA = `${suffix}-owner-a`;
const memberA = `${suffix}-member-a`;
const ownerB = `${suffix}-owner-b`;
let server: Server;
let baseUrl = "";

type IntakeResponse = {
  results: Array<{ status: string; caseId?: number }>;
};

function intakeEvent(
  sourceEventId: string,
  workerEmail: string,
  eventType: "accepted-offer" | "scheduled-preboarding" = "accepted-offer",
) {
  return {
    sourceEventId,
    eventType,
    acceptanceEvidenceReference: `fixture://${sourceEventId}`,
    person: {
      personKey: `person-${sourceEventId}`,
      workerName: "Standard Fixture Worker",
      workerEmail,
      hireType: "external-fte",
      workerCategory: "employee",
      role: "Engineer",
      department: "Engineering",
      geography: "US",
      legalEntity: "Fixture US",
      managerName: "Fixture Manager",
      recruiterName: "Fixture Recruiter",
      joiningDate: "2036-06-15",
      workforceContext: { workCountry: "US", workEnvironment: "office" },
    },
  };
}

async function request(
  userId: string,
  organizationId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-user": userId,
      "x-organization-id": organizationId,
      ...(init.headers ?? {}),
    },
  });
}

async function intakeAsOwner(event: ReturnType<typeof intakeEvent>): Promise<IntakeResponse> {
  const response = await request(ownerA, orgA, "/onboarding/standard-intake/events", {
    method: "POST",
    body: JSON.stringify({ events: [event] }),
  });
  const body = await response.json() as IntakeResponse;
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

async function effectsForFixtureOrganizations() {
  return db.select({ organizationId: onbEffectJournal.organizationId })
    .from(onbEffectJournal)
    .where(inArray(onbEffectJournal.organizationId, [orgA, orgB]));
}

before(async () => {
  if (!hasDb) return;
  await db.insert(organizationsTable).values([
    { id: orgA, name: orgA, slug: orgA, joinCodeHash: `${orgA}-join`, createdByUserId: ownerA },
    { id: orgB, name: orgB, slug: orgB, joinCodeHash: `${orgB}-join`, createdByUserId: ownerB },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: ownerA, role: "owner" },
    { organizationId: orgA, clerkUserId: memberA, role: "member" },
    { organizationId: orgB, clerkUserId: ownerB, role: "owner" },
  ]);
  // The intake route is allowed to persist an inert case only when its
  // case-derived retention policies are approved. This fixture configures no
  // connector and never releases a case, so it cannot contact a provider.
  await seedApprovedSensitiveLifecyclePolicies(orgA);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = String(req.header("x-test-user") ?? "");
    next();
  });
  app.use(createTenantContextMiddleware(lookupMembership));
  app.use(onboardingStandardIntakeRouter);
  app.use(onboardingStandardOperationsRouter);
  app.use(errorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!hasDb) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  await db.delete(onbEffectJournal).where(inArray(onbEffectJournal.organizationId, [orgA, orgB]));
  await db.delete(onbSettings).where(inArray(onbSettings.organizationId, [orgA, orgB]));
  await db.delete(onbStandardIntakeEvents).where(inArray(
    onbStandardIntakeEvents.organizationId,
    [orgA, orgB],
  ));
  await db.delete(onbEvents).where(inArray(onbEvents.organizationId, [orgA, orgB]));
  await db.delete(onbCases).where(inArray(onbCases.organizationId, [orgA, orgB]));
  await db.delete(onbSensitiveLifecyclePolicies).where(inArray(
    onbSensitiveLifecyclePolicies.organizationId,
    [orgA, orgB],
  ));
  await db.delete(organizationMembershipsTable).where(inArray(
    organizationMembershipsTable.organizationId,
    [orgA, orgB],
  ));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgA, orgB]));
});

test("ordinary members cannot submit staff standard intake", { skip: !hasDb }, async () => {
  const beforeCases = await db.select({ id: onbCases.id }).from(onbCases).where(
    eq(onbCases.organizationId, orgA),
  );
  const response = await request(memberA, orgA, "/onboarding/standard-intake/events", {
    method: "POST",
    body: JSON.stringify({ events: [intakeEvent("member-denied", "member-denied@example.test")] }),
  });

  assert.equal(response.status, 403);
  const afterCases = await db.select({ id: onbCases.id }).from(onbCases).where(
    eq(onbCases.organizationId, orgA),
  );
  assert.equal(afterCases.length, beforeCases.length);
});

test("standard intake replay and concurrent worker events create one active case", { skip: !hasDb }, async () => {
  const event = intakeEvent("same-source-event", "replay-worker@example.test");
  const created = await intakeAsOwner(event);
  assert.equal(created.results[0]?.status, "created");
  const caseId = created.results[0]?.caseId;
  assert.ok(caseId);

  const replay = await request(ownerA, orgA, "/onboarding/standard-intake/replay", {
    method: "POST",
    body: JSON.stringify({ events: [event] }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as IntakeResponse).results[0]?.status, "reconciled");

  const workerEmail = "concurrent-worker@example.test";
  const [first, second] = await Promise.all([
    request(ownerA, orgA, "/onboarding/standard-intake/events", {
      method: "POST",
      body: JSON.stringify({ events: [intakeEvent("concurrent-a", workerEmail)] }),
    }),
    request(ownerA, orgA, "/onboarding/standard-intake/events", {
      method: "POST",
      body: JSON.stringify({ events: [intakeEvent("concurrent-b", workerEmail)] }),
    }),
  ]);
  const concurrent = await Promise.all([first.json(), second.json()]) as IntakeResponse[];
  const statuses = concurrent.map((result) => result.results[0]?.status).sort();
  assert.deepEqual(statuses, ["created", "duplicate-active"]);
  const activeCases = await db.select({ id: onbCases.id }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.workerEmail, workerEmail),
  ));
  assert.equal(activeCases.length, 1);
  const workerSourceRows = await db.select({
    caseId: onbStandardIntakeEvents.caseId,
    state: onbStandardIntakeEvents.state,
  }).from(onbStandardIntakeEvents).where(and(
    eq(onbStandardIntakeEvents.organizationId, orgA),
    inArray(onbStandardIntakeEvents.sourceEventId, ["concurrent-a", "concurrent-b"]),
  ));
  assert.equal(workerSourceRows.length, 2);
  assert.deepEqual(workerSourceRows.map((row) => row.caseId), [activeCases[0]!.id, activeCases[0]!.id]);
  assert.deepEqual(workerSourceRows.map((row) => row.state).sort(), ["created", "duplicate-active"]);

  assert.deepEqual(await effectsForFixtureOrganizations(), []);
});

test("cross-tenant standard-operations reads and writes cannot reach a case", { skip: !hasDb }, async () => {
  const created = await intakeAsOwner(intakeEvent("tenant-fence", "tenant-fence@example.test"));
  const caseId = created.results[0]?.caseId;
  assert.ok(caseId);

  const read = await request(ownerB, orgB, `/onboarding/cases/${caseId}/standard-operations`);
  assert.equal(read.status, 404);
  const write = await request(ownerB, orgB, `/onboarding/cases/${caseId}/standard-operations/start-date`, {
    method: "PUT",
    body: JSON.stringify({ startDate: "2036-07-01", expectedVersion: 0, rationale: "Wrong tenant" }),
  });
  assert.equal(write.status, 404);
  const [stored] = await db.select({ joiningDate: onbCases.joiningDate }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, caseId),
  ));
  assert.equal(stored?.joiningDate, "2036-06-15");
});

test("active and ambiguous dispatch markers fence concurrent standard-operations mutations", { skip: !hasDb }, async () => {
  for (const status of ["dispatching", "unknown_effect_manual_repair"] as const) {
    const created = await intakeAsOwner(intakeEvent(
      `dispatch-marker-${status}`,
      `dispatch-marker-${status}@example.test`,
    ));
    const caseId = created.results[0]?.caseId;
    assert.ok(caseId);
    await db.insert(onbEffectJournal).values({
      organizationId: orgA,
      tenantId: orgA,
      caseId,
      logicalOperationKey: `provider-dispatch-marker-${status}-${caseId}`,
      toolName: "provider-dispatch-guard",
      argumentsHash: "fixture-marker",
      providerIdempotency: false,
      status,
    });
    const blocked = await Promise.allSettled([
      setStandardOperationsException({
        organizationId: orgA, caseId, type: "no-response", expectedVersion: 0, actorUserId: ownerA,
      }),
      changeStandardOperationsStartDate({
        organizationId: orgA, caseId, startDate: "2036-07-01", expectedVersion: 0, actorUserId: ownerA,
      }),
      reconcileStandardOperationsStartDateImpact({
        organizationId: orgA, caseId, stream: "hris", resolution: "manual-resolution", expectedVersion: 0, actorUserId: ownerA,
      }),
      setStandardOperationsManualFulfillment({
        organizationId: orgA, caseId, area: "bgv", expectedVersion: 0, actorUserId: ownerA,
        status: "in-progress", evidenceStatus: "not-recorded", consentStatus: "pending",
        cutoffStatus: "not-applicable", reconciliationStatus: "not-started", failureStatus: "none",
      }),
    ]);
    assert.ok(blocked.every((result) =>
      result.status === "rejected" && /provider dispatch is active or requires manual repair/.test(String(result.reason)),
    ));
    const [caseRow] = await db.select({ joiningDate: onbCases.joiningDate }).from(onbCases).where(eq(onbCases.id, caseId));
    assert.equal(caseRow?.joiningDate, "2036-06-15");
    const [settings] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, orgA),
      eq(onbSettings.key, `standard_operations:${caseId}`),
    ));
    assert.equal(settings, undefined);
    await db.delete(onbEffectJournal).where(and(
      eq(onbEffectJournal.organizationId, orgA),
      eq(onbEffectJournal.caseId, caseId),
    ));
  }
});

test("completed cases reject every standard-operations mutation", { skip: !hasDb }, async () => {
  const created = await intakeAsOwner(intakeEvent("completed-standard-operations", "completed-standard-operations@example.test"));
  const caseId = created.results[0]?.caseId;
  assert.ok(caseId);
  await db.update(onbCases).set({ lifecycleStage: "complete" }).where(eq(onbCases.id, caseId));
  const rejected = await Promise.allSettled([
    setStandardOperationsException({
      organizationId: orgA, caseId, type: "no-response", expectedVersion: 0, actorUserId: ownerA,
    }),
    changeStandardOperationsStartDate({
      organizationId: orgA, caseId, startDate: "2036-07-01", expectedVersion: 0, actorUserId: ownerA,
    }),
    reconcileStandardOperationsStartDateImpact({
      organizationId: orgA, caseId, stream: "hris", resolution: "manual-resolution", expectedVersion: 0, actorUserId: ownerA,
    }),
    setStandardOperationsManualFulfillment({
      organizationId: orgA, caseId, area: "bgv", expectedVersion: 0, actorUserId: ownerA,
      status: "in-progress", evidenceStatus: "not-recorded", consentStatus: "pending",
      cutoffStatus: "not-applicable", reconciliationStatus: "not-started", failureStatus: "none",
    }),
  ]);
  assert.ok(rejected.every((result) =>
    result.status === "rejected" && /Completed cases are immutable/.test(String(result.reason)),
  ));
});

test("stale date writes do not overwrite and stream reconciliation persists across reads", { skip: !hasDb }, async () => {
  const created = await intakeAsOwner(intakeEvent("date-reconciliation", "date-reconciliation@example.test"));
  const caseId = created.results[0]?.caseId;
  assert.ok(caseId);

  const changed = await request(ownerA, orgA, `/onboarding/cases/${caseId}/standard-operations/start-date`, {
    method: "PUT",
    body: JSON.stringify({ startDate: "2036-07-01", expectedVersion: 0, rationale: "Corrected start date" }),
  });
  assert.equal(changed.status, 200);
  const firstView = await changed.json() as { version: number };
  assert.equal(firstView.version, 1);

  const stale = await request(ownerA, orgA, `/onboarding/cases/${caseId}/standard-operations/start-date`, {
    method: "PUT",
    body: JSON.stringify({ startDate: "2036-08-01", expectedVersion: 0, rationale: "Stale overwrite attempt" }),
  });
  assert.equal(stale.status, 409);
  const [caseAfterStaleWrite] = await db.select({ joiningDate: onbCases.joiningDate }).from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, caseId),
  ));
  assert.equal(caseAfterStaleWrite?.joiningDate, "2036-07-01");

  const staleHrisProof = await request(ownerA, orgA, `/onboarding/cases/${caseId}/standard-operations/start-date/impacts/hris/reconcile`, {
    method: "POST",
    body: JSON.stringify({ resolution: "source-proof", expectedVersion: 1, rationale: "Old HRIS evidence must not prove the changed date" }),
  });
  assert.equal(staleHrisProof.status, 409);

  const hris = await request(ownerA, orgA, `/onboarding/cases/${caseId}/standard-operations/start-date/impacts/hris/reconcile`, {
    method: "POST",
    body: JSON.stringify({ resolution: "manual-resolution", expectedVersion: 1, rationale: "HRIS owner recorded a manual resolution" }),
  });
  assert.equal(hris.status, 200);
  const hrisView = await hris.json() as { version: number };
  assert.equal(hrisView.version, 2);

  const afterHris = await request(ownerA, orgA, `/onboarding/cases/${caseId}/standard-operations`);
  assert.equal(afterHris.status, 200);
  const persistedHris = await afterHris.json() as {
    startDateImpacts: Array<{ stream: string; status: string }>;
  };
  assert.equal(persistedHris.startDateImpacts.find((impact) => impact.stream === "hris")?.status, "manual-resolution");
  assert.equal(persistedHris.startDateImpacts.find((impact) => impact.stream === "payroll")?.status, "review-required");

  const payroll = await request(ownerA, orgA, `/onboarding/cases/${caseId}/standard-operations/start-date/impacts/payroll/reconcile`, {
    method: "POST",
    body: JSON.stringify({ resolution: "manual-resolution", expectedVersion: 2, rationale: "Payroll owner recorded a manual resolution" }),
  });
  assert.equal(payroll.status, 200);

  const finalRead = await request(ownerA, orgA, `/onboarding/cases/${caseId}/standard-operations`);
  const persistedBoth = await finalRead.json() as {
    startDateImpacts: Array<{ stream: string; status: string }>;
  };
  assert.equal(persistedBoth.startDateImpacts.find((impact) => impact.stream === "hris")?.status, "manual-resolution");
  assert.equal(persistedBoth.startDateImpacts.find((impact) => impact.stream === "payroll")?.status, "manual-resolution");
  assert.deepEqual(await effectsForFixtureOrganizations(), []);
});

test("start-date correction atomically resets a held scheduled-intake due window", { skip: !hasDb }, async () => {
  const created = await intakeAsOwner(intakeEvent(
    "scheduled-date-reset",
    "scheduled-date-reset@example.test",
    "scheduled-preboarding",
  ));
  const caseId = created.results[0]?.caseId;
  assert.ok(caseId);
  const changed = await request(ownerA, orgA, `/onboarding/cases/${caseId}/standard-operations/start-date`, {
    method: "PUT",
    body: JSON.stringify({ startDate: "2036-07-15", expectedVersion: 0, rationale: "The source start date was corrected." }),
  });
  assert.equal(changed.status, 200);
  const [event] = await db.select({
    activationDueAt: onbStandardIntakeEvents.activationDueAt,
    activationStatus: onbStandardIntakeEvents.activationStatus,
    activationReviewRequestedAt: onbStandardIntakeEvents.activationReviewRequestedAt,
  }).from(onbStandardIntakeEvents).where(and(
    eq(onbStandardIntakeEvents.organizationId, orgA),
    eq(onbStandardIntakeEvents.caseId, caseId),
  ));
  assert.equal(event?.activationDueAt?.toISOString(), scheduledPreboardingDueAt("2036-07-15")?.toISOString());
  assert.equal(event?.activationStatus, "scheduled");
  assert.equal(event?.activationReviewRequestedAt, null);
});