import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import {
  db,
  onbCommunications,
  onbEffectJournal,
  onbEvents,
  onbCases,
  organizationsTable,
} from "@workspace/db";
import {
  DEMO_FULL_COVERAGE_SCENARIO_KEYS,
  isDemoFullCoverageScenarioKey,
  originalDemoFullCoverageScenarioKey,
  seedDemoFullCoverage,
} from "./demo-full-coverage";
import onboardingRouter from "../../routes/onboarding";
import {
  getUatCaseIsolation,
  isAuthoritativelyUatRunOwnedCase,
  ordinaryCaseSql,
} from "./uat-isolation";

const hasDb = Boolean(process.env.DATABASE_URL);
const organizationId = `demo-full-coverage-${process.pid}-${randomUUID()}`;
const customerOrganizationId = `customer-full-coverage-${process.pid}-${randomUUID()}`;
let routeBaseUrl = "";
let routeServer: any;

describe("offline Demo full coverage seed", { skip: !hasDb }, () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.organizationId = String(req.header("x-organization-id") ?? "");
      req.organizationRole = "owner";
      req.authUserId = "test-user";
      next();
    });
    app.use(onboardingRouter);
    routeServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => routeServer.once("listening", resolve));
    const address = routeServer.address();
    assert.ok(address && typeof address !== "string");
    routeBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (routeServer) await new Promise<void>((resolve) => routeServer.close(() => resolve()));
    await db.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, organizationId));
    await db.delete(onbCommunications).where(eq(onbCommunications.organizationId, organizationId));
    await db.delete(onbEvents).where(eq(onbEvents.organizationId, organizationId));
    await db.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(onbCases).where(eq(onbCases.organizationId, customerOrganizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, customerOrganizationId));
  });

  test("creates every family exactly once without execution side effects", async () => {
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Offline coverage test",
      slug: organizationId,
      joinCodeHash: `hash-${organizationId}`,
      createdByUserId: "test",
    });

    const [first, second] = await Promise.all([
      seedDemoFullCoverage(organizationId, "test-user"),
      seedDemoFullCoverage(organizationId, "test-user"),
    ]);
    assert.equal(first.createdCaseIds.length + second.createdCaseIds.length, DEMO_FULL_COVERAGE_SCENARIO_KEYS.length);

    const rows = await db.select().from(onbCases).where(eq(onbCases.organizationId, organizationId));
    assert.equal(rows.length, DEMO_FULL_COVERAGE_SCENARIO_KEYS.length);
    assert.deepEqual(
      [...rows.map((row) => originalDemoFullCoverageScenarioKey(row.scenarioKey)).sort()],
      [...DEMO_FULL_COVERAGE_SCENARIO_KEYS].sort(),
    );
    assert.ok(rows.every((row) =>
      row.notes?.includes("[synthetic-offline-reset:v1]") &&
      isDemoFullCoverageScenarioKey(row.scenarioKey) &&
      row.workerEmail.endsWith(".invalid") &&
      row.workerPhone === null &&
      row.candidateEmailAuthorizedAt === null &&
      row.orchestrationStatus === "blocked" &&
      row.orchestrationCheckpoint === "synthetic-offline",
    ));

    const retry = await seedDemoFullCoverage(organizationId, "test-user");
    assert.equal(retry.createdCaseIds.length, 0);
    assert.equal(retry.existingCaseIds.length, DEMO_FULL_COVERAGE_SCENARIO_KEYS.length);

    // The reserved key, not mutable notes, is the fence. These cases have no
    // UAT ledger record, so the exceptional portal/local-operation paths are
    // unavailable as well.
    await db.update(onbCases).set({ notes: null }).where(eq(onbCases.organizationId, organizationId));
    const clearedRows = await db.select().from(onbCases).where(eq(onbCases.organizationId, organizationId));
    assert.ok(clearedRows.every((row) => isDemoFullCoverageScenarioKey(row.scenarioKey)));
    assert.ok((await Promise.all(clearedRows.map(async (row) => {
      const isolation = await getUatCaseIsolation(row);
      return isolation.isolated && !await isAuthoritativelyUatRunOwnedCase(row);
    }))).every(Boolean));
    const ordinaryRows = await db.select({ id: onbCases.id }).from(onbCases).where(
      ordinaryCaseSql(onbCases.organizationId, onbCases.id),
    );
    assert.equal(ordinaryRows.filter((row) => clearedRows.some((sample) => sample.id === row.id)).length, 0);
    const retryAfterNotesCleared = await seedDemoFullCoverage(organizationId, "test-user");
    assert.equal(retryAfterNotesCleared.createdCaseIds.length, 0);
    assert.equal(retryAfterNotesCleared.existingCaseIds.length, DEMO_FULL_COVERAGE_SCENARIO_KEYS.length);

    const [events, communications, effects] = await Promise.all([
      db.select().from(onbEvents).where(eq(onbEvents.organizationId, organizationId)),
      db.select().from(onbCommunications).where(eq(onbCommunications.organizationId, organizationId)),
      db.select().from(onbEffectJournal).where(eq(onbEffectJournal.organizationId, organizationId)),
    ]);
    assert.equal(events.length, 0);
    assert.equal(communications.length, 0);
    assert.equal(effects.length, 0);
  });

  test("refuses a customer-tenant HTTP seed without creating a case", async () => {
    await db.insert(organizationsTable).values({
      id: customerOrganizationId,
      name: "Customer coverage test",
      slug: customerOrganizationId,
      joinCodeHash: `hash-${customerOrganizationId}`,
      createdByUserId: "test",
    });
    const response = await fetch(`${routeBaseUrl}/onboarding/demo/full-coverage`, {
      method: "POST",
      headers: { "x-organization-id": customerOrganizationId },
    });
    assert.equal(response.status, 403);
    const rows = await db.select().from(onbCases).where(eq(onbCases.organizationId, customerOrganizationId));
    assert.equal(rows.length, 0);
  });
});