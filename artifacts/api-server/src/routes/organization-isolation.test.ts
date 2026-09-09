import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  actualsOverlaysTable,
  customIntentsTable,
  db,
  eaAssessmentsTable,
  flowOverridesTable,
  onbCases,
  organizationMembershipsTable,
  organizationsTable,
  pricingRateSetsTable,
  pricingSheetsTable,
  scenariosTable,
} from "@workspace/db";
import scenariosRouter from "./scenarios";
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
    req.authUserId = String(req.header("x-test-user"));
    next();
  });
  app.use(createTenantContextMiddleware(lookupMembership));
  app.use(scenariosRouter);
  app.use(actualsRouter);
  app.use(flowOverridesRouter);
  app.use(customIntentsRouter);
  app.use(onboardingRouter);
  app.use(pricingSheetsRouter);
  app.use(enterpriseArchitectureRouter);
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