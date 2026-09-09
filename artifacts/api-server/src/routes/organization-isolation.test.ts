import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { and, desc, eq } from "drizzle-orm";
import {
  actualsOverlaysTable,
  customIntentsTable,
  db,
  eaAssessmentsTable,
  flowOverridesTable,
  onbCases,
  onbEvents,
  onbGuardrailEvents,
  onbSettings,
  organizationMembershipsTable,
  organizationsTable,
  pricingRateSetsTable,
  pricingSheetsTable,
  scenarioFilesTable,
  scenarioUploadIntentsTable,
  scenariosTable,
} from "@workspace/db";
import { DEMO_ORGANIZATION_ID } from "@workspace/db/schema";
import scenariosRouter from "./scenarios";
import scenarioFilesRouter from "./scenario-files";
import actualsRouter from "./actuals";
import flowOverridesRouter from "./flow-overrides";
import customIntentsRouter from "./custom-intents";
import onboardingRouter from "./onboarding";
import pricingSheetsRouter from "./pricing-sheets";
import enterpriseArchitectureRouter from "./enterprise-architecture";
import {
  buildBaselineRates,
  loadCurrentRateSet,
} from "../lib/pricing-rate-sets";
import { organizationValues } from "../lib/organization-scope";
import {
  createTenantContextMiddleware,
  lookupMembership,
} from "../middlewares/tenant-context";
import { errorHandler } from "../middlewares/error-handler";
import { scenarioUploadObjectPath } from "../lib/objectStorage";

const suffix = `${process.pid}-${Date.now()}`;
const orgA = `isolation-a-${suffix}`;
const orgB = `isolation-b-${suffix}`;
let server: Server;
let baseUrl: string;

before(async () => {
  await db.insert(organizationsTable).values([
    {
      id: orgA,
      name: "Isolation A",
      slug: orgA,
      joinCodeHash: `hash-${orgA}`,
      createdByUserId: "test-user-a",
    },
    {
      id: orgB,
      name: "Isolation B",
      slug: orgB,
      joinCodeHash: `hash-${orgB}`,
      createdByUserId: "test-user-b",
    },
  ]);
  await db.insert(organizationMembershipsTable).values([
    {
      organizationId: orgA,
      clerkUserId: "test-user-a",
      role: "owner",
    },
    {
      organizationId: orgB,
      clerkUserId: "test-user-b",
      role: "owner",
    },
  ]);

  for (const organizationId of [orgA, orgB]) {
    await db.insert(scenariosTable).values({
      ...organizationValues(organizationId),
      name: `Scenario ${organizationId}`,
      inputs: {
        numSystems: 4,
        annualTransactions: 120_000,
        employees: 8_000,
        sector: "manufacturing",
        companyType: "multi-country",
        isolationTier: "siloed",
        hrHourlyCostUsd: 38,
        hitlHourlyCostUsd: 42,
        countries: 6,
      },
    });
    await db.insert(actualsOverlaysTable).values({
      organizationId,
      clientLabel: `Actuals ${organizationId}`,
      payload: { intents: [] },
    });
    await db.insert(flowOverridesTable).values({
      organizationId,
      intentKey: "payroll-inquiry",
      version: 1,
      status: "draft",
      author: "Isolation test",
      rationale: organizationId,
    });
    await db.insert(customIntentsTable).values({
      organizationId,
      key: `custom-${organizationId}`,
      name: `Custom ${organizationId}`,
      domain: "test",
      flowClass: "simple",
      description: "Tenant isolation fixture",
      asIsHandlingMin: 10,
      toBeHumanMin: 2,
      baseWeight: 1,
      actGetActions: 1,
      actPutActions: 0,
      source: "test",
      author: "test",
    });
    await db.insert(pricingSheetsTable).values({
      ...organizationValues(organizationId),
      name: `Pricing ${organizationId}`,
      inputs: {
        clientsInCohort: 1,
        annualTransactions: 1000,
        channels: 1,
        integrations: 1,
        agents: 1,
        workflows: 1,
        tenantTier: "pooled",
        securityTier: "standard",
        tokenProfile: "light",
        infrastructureTier: "starter",
        supportTier: "essential",
        grossMarginPct: 30,
        buildAmortizationYears: 3,
      },
      recommendation: {
        recommendedMonthlySubscription: 1,
        recommendedAnnualCommitment: 12,
        recommendedTransactionPrice: 1,
        recommendedOveragePrice: 1,
        recommendedImplementationFee: 1,
        includedAnnualTransactions: 1000,
      },
    });
    await db.insert(pricingRateSetsTable).values({
      organizationId,
      effectiveDate: "2025-01-01",
      rationale: `Rates ${organizationId}`,
      rates: buildBaselineRates(),
      createdBy: "test",
    });
    await db.insert(eaAssessmentsTable).values({
      organizationId,
      ownerUserId: "test-user",
      name: `Architecture ${organizationId}`,
      clientName: `Client ${organizationId}`,
      currentPhase: "preliminary",
      content: {},
    });
    await db.insert(onbCases).values({
      organizationId,
      workerName: `Worker ${organizationId}`,
      workerEmail: `${organizationId}@example.com`,
      hireType: "external",
      workerCategory: "full-time",
      role: "Engineer",
      department: "Engineering",
      geography: "US",
      legalEntity: "Example",
      managerName: "Manager",
      recruiterName: "Recruiter",
      joiningDate: "2030-01-01",
    });
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = String(req.header("x-test-user"));
    Object.assign(req, {
      auth: Object.assign(
        () => ({
          userId,
          sessionClaims: null,
          tokenType: "session_token" as const,
        }),
        { [Symbol.for("@clerk/express.auth")]: true },
      ),
    });
    req.authUserId = userId;
    next();
  });
  app.use(createTenantContextMiddleware(lookupMembership));
  app.use(scenariosRouter);
  app.use(scenarioFilesRouter);
  app.use(actualsRouter);
  app.use(flowOverridesRouter);
  app.use(customIntentsRouter);
  app.use(onboardingRouter);
  app.use(pricingSheetsRouter);
  app.use(enterpriseArchitectureRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  await db.delete(onbEvents).where(eq(onbEvents.organizationId, orgA));
  await db.delete(onbEvents).where(eq(onbEvents.organizationId, orgB));
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, orgA));
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, orgB));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgA));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgB));
  await db.delete(eaAssessmentsTable).where(eq(eaAssessmentsTable.organizationId, orgA));
  await db.delete(eaAssessmentsTable).where(eq(eaAssessmentsTable.organizationId, orgB));
  await db.delete(pricingSheetsTable).where(eq(pricingSheetsTable.organizationId, orgA));
  await db.delete(pricingSheetsTable).where(eq(pricingSheetsTable.organizationId, orgB));
  await db.delete(pricingRateSetsTable).where(eq(pricingRateSetsTable.organizationId, orgA));
  await db.delete(pricingRateSetsTable).where(eq(pricingRateSetsTable.organizationId, orgB));
  await db.delete(customIntentsTable).where(eq(customIntentsTable.organizationId, orgA));
  await db.delete(customIntentsTable).where(eq(customIntentsTable.organizationId, orgB));
  await db.delete(flowOverridesTable).where(eq(flowOverridesTable.organizationId, orgA));
  await db.delete(flowOverridesTable).where(eq(flowOverridesTable.organizationId, orgB));
  await db.delete(actualsOverlaysTable).where(eq(actualsOverlaysTable.organizationId, orgA));
  await db.delete(actualsOverlaysTable).where(eq(actualsOverlaysTable.organizationId, orgB));
  await db.delete(scenariosTable).where(eq(scenariosTable.organizationId, orgA));
  await db.delete(scenariosTable).where(eq(scenariosTable.organizationId, orgB));
  await db
    .delete(organizationMembershipsTable)
    .where(eq(organizationMembershipsTable.organizationId, orgA));
  await db
    .delete(organizationMembershipsTable)
    .where(eq(organizationMembershipsTable.organizationId, orgB));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB));
});

async function get(path: string, organizationId: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "x-test-user": organizationId === orgA ? "test-user-a" : "test-user-b",
      "x-organization-id": organizationId,
    },
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<unknown[]>;
}

test("list route families do not expose another organization's records", async () => {
  const cases = [
    ["/scenarios", "name"],
    ["/actuals", "clientLabel"],
    ["/flow-overrides", "rationale"],
    ["/custom-intents", "key"],
    ["/pricing-sheets", "name"],
    ["/onboarding/cases", "workerName"],
  ] as const;

  for (const [path, identifyingField] of cases) {
    const rowsA = await get(path, orgA) as Array<Record<string, unknown>>;
    const rowsB = await get(path, orgB) as Array<Record<string, unknown>>;
    assert.equal(rowsA.length, 1, path);
    assert.equal(rowsB.length, 1, path);
    assert.notEqual(rowsA[0]?.[identifyingField], rowsB[0]?.[identifyingField], path);
  }
});

test("dashboard includes tenant-owned monitor events without a case", async () => {
  const titles = {
    a: `Monitor unavailable ${orgA}`,
    b: `Monitor unavailable ${orgB}`,
  };
  await db.insert(onbEvents).values([
    {
      organizationId: orgA,
      caseId: null,
      agent: "Inbound email monitor",
      engine: "test",
      title: titles.a,
      detail: "Mailbox polling failed.",
    },
    {
      organizationId: orgB,
      caseId: null,
      agent: "Inbound email monitor",
      engine: "test",
      title: titles.b,
      detail: "Mailbox polling failed.",
    },
  ]);

  const response = await fetch(`${baseUrl}/onboarding/dashboard`, {
    headers: {
      "x-test-user": "test-user-a",
      "x-organization-id": orgA,
    },
  });
  assert.equal(response.status, 200);
  const dashboard = await response.json() as {
    recentEvents: Array<{ caseId: number | null; title: string }>;
  };
  assert.ok(
    dashboard.recentEvents.some(
      (event) => event.caseId === null && event.title === titles.a,
    ),
  );
  assert.ok(
    dashboard.recentEvents.every((event) => event.title !== titles.b),
  );
});

test("rejected Twilio webhooks persist an explicit platform audit event", async () => {
  const detail =
    "Webhook to /onboarding/webhooks/twilio/whatsapp failed Twilio signature validation — request discarded.";
  const existing = await db
    .select({ id: onbGuardrailEvents.id })
    .from(onbGuardrailEvents)
    .where(and(
      eq(onbGuardrailEvents.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbGuardrailEvents.guardrailKey, "webhook-signature"),
      eq(onbGuardrailEvents.detail, detail),
    ));
  const existingIds = new Set(existing.map(({ id }) => id));
  let auditId: number | undefined;
  process.env.TWILIO_AUTH_TOKEN = "organization-isolation-test-token";

  try {
    const response = await fetch(
      `${baseUrl}/onboarding/webhooks/twilio/whatsapp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-organization-id": orgA,
          "x-test-user": "test-user-a",
          "x-twilio-signature": "invalid-signature",
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 403);

    const audits = await db
      .select()
      .from(onbGuardrailEvents)
      .where(and(
        eq(onbGuardrailEvents.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbGuardrailEvents.guardrailKey, "webhook-signature"),
        eq(onbGuardrailEvents.detail, detail),
      ))
      .orderBy(desc(onbGuardrailEvents.id));
    const audit = audits.find(({ id }) => !existingIds.has(id));
    assert.ok(audit);
    auditId = audit.id;
    assert.equal(audit.caseId, null);
    assert.equal(audit.action, "rejected");
  } finally {
    delete process.env.TWILIO_AUTH_TOKEN;
    if (auditId !== undefined) {
      await db
        .delete(onbGuardrailEvents)
        .where(eq(onbGuardrailEvents.id, auditId));
    }
  }
});

test("record routes return not found for another organization's identifiers", async () => {
  const [scenario] = await db
    .select({ id: scenariosTable.id })
    .from(scenariosTable)
    .where(eq(scenariosTable.organizationId, orgB));
  const [actuals] = await db
    .select({ id: actualsOverlaysTable.id })
    .from(actualsOverlaysTable)
    .where(eq(actualsOverlaysTable.organizationId, orgB));
  const [onboardingCase] = await db
    .select({ id: onbCases.id })
    .from(onbCases)
    .where(eq(onbCases.organizationId, orgB));
  const [pricingSheet] = await db
    .select({ id: pricingSheetsTable.id })
    .from(pricingSheetsTable)
    .where(eq(pricingSheetsTable.organizationId, orgB));
  const [assessment] = await db
    .select({ id: eaAssessmentsTable.id })
    .from(eaAssessmentsTable)
    .where(eq(eaAssessmentsTable.organizationId, orgB));

  for (const path of [
    `/scenarios/${scenario!.id}`,
    `/actuals/${actuals!.id}`,
    `/pricing-sheets/${pricingSheet!.id}`,
    `/custom-intents/custom-${orgB}`,
    `/onboarding/cases/${onboardingCase!.id}`,
    `/onboarding/cases/${onboardingCase!.id}/events`,
    `/enterprise-architecture/assessments/${assessment!.id}`,
  ]) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        "x-test-user": "test-user-a",
        "x-organization-id": orgA,
      },
    });
    assert.equal(response.status, 404, path);
  }
});

test("rate-set resolution only reads the requesting organization", async () => {
  const ratesA = await loadCurrentRateSet(orgA);
  const ratesB = await loadCurrentRateSet(orgB);
  assert.equal(ratesA?.rationale, `Rates ${orgA}`);
  assert.equal(ratesB?.rationale, `Rates ${orgB}`);
});

test("cross-tenant pricing and architecture writes are rejected", async () => {
  const [pricingSheet] = await db
    .select({ id: pricingSheetsTable.id })
    .from(pricingSheetsTable)
    .where(eq(pricingSheetsTable.organizationId, orgB));
  const [assessment] = await db
    .select({ id: eaAssessmentsTable.id })
    .from(eaAssessmentsTable)
    .where(eq(eaAssessmentsTable.organizationId, orgB));

  const attempts = [
    {
      path: `/pricing-sheets/${pricingSheet!.id}`,
      body: { name: "cross-tenant mutation" },
    },
    {
      path: `/enterprise-architecture/assessments/${assessment!.id}`,
      body: { expectedVersion: 1, name: "cross-tenant mutation" },
    },
  ];
  for (const attempt of attempts) {
    const response = await fetch(`${baseUrl}${attempt.path}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-test-user": "test-user-a",
        "x-organization-id": orgA,
      },
      body: JSON.stringify(attempt.body),
    });
    assert.equal(response.status, 404, attempt.path);
  }
});

test("forged organization selectors are rejected before route access", async () => {
  const response = await fetch(`${baseUrl}/scenarios`, {
    headers: {
      "x-test-user": "test-user-a",
      "x-organization-id": orgB,
    },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    message: "You are not a member of the requested organization",
    code: "ORGANIZATION_ACCESS_DENIED",
  });
});

test("candidate-link retention settings are validated, persisted, and tenant-scoped", async () => {
  const headers = {
    "content-type": "application/json",
    "x-test-user": "test-user-a",
    "x-organization-id": orgA,
  };
  const invalid = await fetch(`${baseUrl}/onboarding/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ candidateLinkRetentionDays: 45 }),
  });
  assert.equal(invalid.status, 400);

  const saved = await fetch(`${baseUrl}/onboarding/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ candidateLinkRetentionDays: 30 }),
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (await saved.json() as { candidateLinkRetentionDays: number }).candidateLinkRetentionDays,
    30,
  );

  const [tenantA, tenantB] = await Promise.all([
    fetch(`${baseUrl}/onboarding/settings`, { headers }),
    fetch(`${baseUrl}/onboarding/settings`, {
      headers: {
        "x-test-user": "test-user-b",
        "x-organization-id": orgB,
      },
    }),
  ]);
  assert.equal(
    (await tenantA.json() as { candidateLinkRetentionDays: number }).candidateLinkRetentionDays,
    30,
  );
  assert.equal(
    (await tenantB.json() as { candidateLinkRetentionDays: number }).candidateLinkRetentionDays,
    90,
  );
});

test("another demo member cannot access an owner-bound historical scenario", async () => {
  const ownerUserId = `historical-owner-${suffix}`;
  const otherUserId = `historical-intruder-${suffix}`;
  await db.insert(organizationMembershipsTable).values([
    {
      organizationId: DEMO_ORGANIZATION_ID,
      clerkUserId: ownerUserId,
      role: "owner",
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      clerkUserId: otherUserId,
      role: "member",
    },
  ]);
  const [scenario] = await db.insert(scenariosTable).values({
    organizationId: DEMO_ORGANIZATION_ID,
    ownerUserId,
    name: "Historical private scenario",
    inputs: {
      numSystems: 4,
      annualTransactions: 120_000,
      employees: 8_000,
      sector: "manufacturing",
      companyType: "multi-country",
      isolationTier: "siloed",
      hrHourlyCostUsd: 38,
      hitlHourlyCostUsd: 42,
      countries: 6,
    },
  }).returning({ id: scenariosTable.id });

  try {
    const ownerResponse = await fetch(`${baseUrl}/scenarios/${scenario!.id}`, {
      headers: {
        "x-organization-id": DEMO_ORGANIZATION_ID,
        "x-test-user": ownerUserId,
      },
    });
    assert.equal(ownerResponse.status, 200);

    const otherListResponse = await fetch(`${baseUrl}/scenarios`, {
      headers: {
        "x-organization-id": DEMO_ORGANIZATION_ID,
        "x-test-user": otherUserId,
      },
    });
    assert.equal(otherListResponse.status, 200);
    const otherScenarios = await otherListResponse.json() as Array<{ id: number }>;
    assert.ok(otherScenarios.every(({ id }) => id !== scenario!.id));

    for (const attempt of [
      { method: "GET" },
      { method: "PATCH", body: JSON.stringify({ name: "stolen" }) },
      { method: "DELETE" },
    ]) {
      const response = await fetch(`${baseUrl}/scenarios/${scenario!.id}`, {
        method: attempt.method,
        headers: {
          "content-type": "application/json",
          "x-organization-id": DEMO_ORGANIZATION_ID,
          "x-test-user": otherUserId,
        },
        body: attempt.body,
      });
      assert.equal(response.status, 404, attempt.method);
    }
    const [preserved] = await db
      .select({ name: scenariosTable.name })
      .from(scenariosTable)
      .where(eq(scenariosTable.id, scenario!.id));
    assert.equal(preserved?.name, "Historical private scenario");
  } finally {
    await db.delete(scenariosTable).where(eq(scenariosTable.id, scenario!.id));
    await db
      .delete(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, ownerUserId),
      ));
    await db
      .delete(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, otherUserId),
      ));
  }
});

test("a former member cannot reach old uploads through another organization", async () => {
  const formerMember = `former-upload-member-${suffix}`;
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgA,
    clerkUserId: formerMember,
    role: "member",
  });
  const [scenario] = await db.insert(scenariosTable).values({
    organizationId: orgA,
    ownerUserId: formerMember,
    name: "Former member scenario",
    inputs: {},
  }).returning({ id: scenariosTable.id });
  const [file] = await db.insert(scenarioFilesTable).values({
    organizationId: orgA,
    ownerUserId: formerMember,
    scenarioId: scenario!.id,
    objectPath: `private/scenarios/${formerMember}/old-upload.txt`,
    originalName: "old-upload.txt",
    contentType: "text/plain",
    sizeBytes: 4,
  }).returning({ id: scenarioFilesTable.id });
  const contentIntentId = randomUUID();
  const finalizeIntentId = randomUUID();
  const contentObjectPath = scenarioUploadObjectPath(
    formerMember,
    contentIntentId,
  );
  const finalizeObjectPath = scenarioUploadObjectPath(
    formerMember,
    finalizeIntentId,
  );
  await db.insert(scenarioUploadIntentsTable).values([
    {
      id: contentIntentId,
      organizationId: orgA,
      ownerUserId: formerMember,
      objectPath: contentObjectPath,
      originalName: "content.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    },
    {
      id: finalizeIntentId,
      organizationId: orgA,
      ownerUserId: formerMember,
      objectPath: finalizeObjectPath,
      originalName: "finalize.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      status: "uploaded",
      expiresAt: new Date(Date.now() + 60_000),
    },
  ]);
  await db
    .delete(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, orgA),
      eq(organizationMembershipsTable.clerkUserId, formerMember),
    ));
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgB,
    clerkUserId: formerMember,
    role: "member",
  });

  try {
    const listResponse = await fetch(
      `${baseUrl}/scenarios/${scenario!.id}/files`,
      {
        headers: {
          "x-organization-id": orgB,
          "x-test-user": formerMember,
        },
      },
    );
    assert.equal(listResponse.status, 404);

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(
        `${baseUrl}/scenario-files/${file!.id}${method === "GET" ? "/download" : ""}`,
        {
          method,
          headers: {
            "x-organization-id": orgB,
            "x-test-user": formerMember,
          },
        },
      );
      assert.equal(response.status, 404, method);
    }

    const contentResponse = await fetch(
      `${baseUrl}/scenario-files/upload-intents/${contentIntentId}/content`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-organization-id": orgB,
          "x-test-user": formerMember,
        },
        body: "test",
      },
    );
    assert.equal(contentResponse.status, 409);

    const finalizeResponse = await fetch(
      `${baseUrl}/scenario-files/finalize`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-organization-id": orgB,
          "x-test-user": formerMember,
        },
        body: JSON.stringify({
          objectPath: finalizeObjectPath,
          name: "finalize.txt",
          contentType: "text/plain",
          size: 4,
        }),
      },
    );
    assert.equal(finalizeResponse.status, 409);

    const [preserved] = await db
      .select({ id: scenarioFilesTable.id })
      .from(scenarioFilesTable)
      .where(eq(scenarioFilesTable.id, file!.id));
    assert.equal(preserved?.id, file!.id);
  } finally {
    await db
      .delete(scenarioUploadIntentsTable)
      .where(eq(scenarioUploadIntentsTable.id, contentIntentId));
    await db
      .delete(scenarioUploadIntentsTable)
      .where(eq(scenarioUploadIntentsTable.id, finalizeIntentId));
    await db.delete(scenarioFilesTable).where(eq(scenarioFilesTable.id, file!.id));
    await db.delete(scenariosTable).where(eq(scenariosTable.id, scenario!.id));
    await db
      .delete(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, orgB),
        eq(organizationMembershipsTable.clerkUserId, formerMember),
      ));
  }
});