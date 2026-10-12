import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db, organizationsTable, organizationMembershipsTable, flowOverridesTable,
  scenariosTable, scenarioFilesTable, pricingRateSetsTable } from "@workspace/db";
import router from "./scenarios";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import { errorHandler } from "../middlewares/error-handler";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { intents } from "../data/intents";
import { buildBaselineRates } from "../lib/pricing-rate-sets";
import { ResolveScenarioFlowBasisResponse, GetScenarioResponse, CreateScenarioResponse } from "@workspace/api-zod";

const orgA = `base-setup-a-${randomUUID()}`;
const orgB = `base-setup-b-${randomUUID()}`;
const userA = `base-user-a-${randomUUID()}`;
const userB = `base-user-b-${randomUUID()}`;
let server: Server;
let base: string;
const setup = {
  clientName: "Base setup fixture", sector: "Technology", employees: 1000,
  countries: 1, annualTransactions: 50000, companyType: "single-country",
  isolationTier: "siloed", landscapeMaturity: "mixed", hrHourlyCostUsd: 50, hitlHourlyCostUsd: 65,
  processMode: "recommended", selectedDomains: ["Hire"], notes: "",
  systems: [{ id: "hris-1", key: "hris", name: "Fixture HRIS", vendor: "Fixture", mode: "manual", ownerEmail: "" }],
  personas: [{ role: "Implementation lead", name: "Fixture", email: "fixture@example.com" }],
};
const inputs = { numSystems: 1, employees: 1000, countries: 1, annualTransactions: 50000,
  sector: "technology", companyType: "single-country", isolationTier: "siloed", hrHourlyCostUsd: 50, hitlHourlyCostUsd: 65 };
async function request(path: string, method = "GET", body?: unknown, organization = orgA, user = userA) {
  return fetch(`${base}${path}`, { method,
    headers: { "content-type": "application/json", "x-test-user": user, "x-organization-id": organization },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

before(async () => {
  for (const [organization, user] of [[orgA, userA], [orgB, userB]]) {
    await db.insert(organizationsTable).values({ id: organization!, slug: organization!, joinCodeHash: randomUUID(),
      name: "Isolated base-flow fixture", primaryCountry: "US", createdByUserId: user! });
    await db.insert(organizationMembershipsTable).values({ organizationId: organization!, clerkUserId: user!, role: "member" });
    await db.insert(pricingRateSetsTable).values({ organizationId: organization!, effectiveDate: "2026-01-01",
      rationale: "Fixture", createdBy: "fixture", rates: buildBaselineRates() });
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = String(req.header("x-test-user"));
    Object.assign(req, { auth: Object.assign(() => ({ userId, sessionClaims: null, tokenType: "session_token" as const }),
      { [Symbol.for("@clerk/express.auth")]: true }) });
    req.authUserId = userId;
    next();
  });
  app.use(createTenantContextMiddleware(lookupMembership));
  app.use(router);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const ids = [orgA, orgB];
  await db.delete(scenarioFilesTable).where(inArray(scenarioFilesTable.organizationId, ids));
  await db.delete(scenariosTable).where(inArray(scenariosTable.organizationId, ids));
  await db.delete(flowOverridesTable).where(inArray(flowOverridesTable.organizationId, ids));
  await db.delete(pricingRateSetsTable).where(inArray(pricingRateSetsTable.organizationId, ids));
  await deleteTestOrganizations(inArray(organizationsTable.id, ids));
});

test("no-file base and pending adoption save, estimate and reload with exact provenance; members cannot activate", async () => {
  const resolved = await request("/scenario-flow-basis", "POST", { selectedDomains: ["Hire"] });
  assert.equal(resolved.status, 200);
  const flowBasis = ResolveScenarioFlowBasisResponse.parse(await resolved.json());
  const scopedInputs = { ...inputs, intentShareOverrides: flowBasis.intentWeights };
  const estimate = await request("/rollup", "POST", { inputs: scopedInputs, flowBasis });
  assert.equal(estimate.status, 200, await estimate.text());
  for (const processMode of ["recommended", "hybrid", "custom"]) {
    const body = { name: `No-file ${processMode}`, inputs: scopedInputs, fileIds: [],
      setupData: { ...setup, processMode, flowBasis, customizationStatus: processMode === "recommended" ? "none" : "pending-review" } };
    const created = await request("/scenarios", "POST", body);
    assert.equal(created.status, 201);
    const saved = CreateScenarioResponse.parse(await created.json());
    const loaded = await request(`/scenarios/${saved.id}`);
    assert.equal(loaded.status, 200);
    const reloaded = GetScenarioResponse.parse(await loaded.json());
    const savedSetup = reloaded.setupData as Record<string, unknown>;
    assert.deepEqual(savedSetup.flowBasis, flowBasis);
    assert.deepEqual(reloaded.inputs, scopedInputs);
    assert.equal(savedSetup.processMode, processMode);
    assert.deepEqual(reloaded.fileIds, []);
    assert.equal((await request(`/scenarios/${saved.id}`, "GET", undefined, orgB, userB)).status, 404);
    assert.equal((await request(`/scenarios/${saved.id}/activate-system-setup`, "POST", {})).status, 403);
    assert.equal((await request(`/scenarios/${saved.id}`, "PATCH", { setupData: null })).status, 400);
    const changedScope = await request(`/scenarios/${saved.id}`, "PATCH", {
      inputs: { ...scopedInputs, intentShareOverrides: { [Object.keys(flowBasis.intentWeights)[0]!]: 1 } },
    });
    assert.equal(changedScope.status, 400, "Cost Explorer inputs-only saves cannot invalidate reviewed intent scope");
    assert.equal((await request(`/scenarios/${saved.id}`, "PATCH", {
      inputs: { ...scopedInputs, intentShareOverrides: {} },
    })).status, 400, "Clearing scoped weights must not silently restore a global default corpus");
    const allowed = await request(`/scenarios/${saved.id}`, "PATCH", {
      name: `Cost Explorer saved ${processMode}`, inputs: { ...scopedInputs, annualTransactions: 60000 },
    });
    assert.equal(allowed.status, 200, "Non-source scenario assumptions remain editable");
    const afterEdit = GetScenarioResponse.parse(await (await request(`/scenarios/${saved.id}`)).json());
    assert.deepEqual((afterEdit.setupData as Record<string, unknown>).flowBasis, flowBasis);
    assert.deepEqual((afterEdit.inputs as typeof scopedInputs).intentShareOverrides, flowBasis.intentWeights);
    assert.equal((afterEdit.inputs as typeof scopedInputs).annualTransactions, 60000);
    if (processMode === "recommended") {
      const [attached] = await db.insert(scenarioFilesTable).values({ organizationId: orgA, ownerUserId: userA,
        scenarioId: saved.id, objectPath: `private/test/${randomUUID()}`, originalName: "later.txt",
        contentType: "text/plain", sizeBytes: 5 }).returning();
      const later = GetScenarioResponse.parse(await (await request(`/scenarios/${saved.id}`)).json());
      assert.deepEqual(later.fileIds, [attached!.id]);
      assert.equal((later.setupData as Record<string, unknown>).customizationStatus, "pending-review");
      assert.deepEqual((later.setupData as Record<string, unknown>).flowBasis, flowBasis);
    }
  }
  const [legacy] = await db.insert(scenariosTable).values({ organizationId: orgA, ownerUserId: userA,
    name: "Existing custom client", inputs: scopedInputs, setupData: { ...setup, processMode: "custom" } }).returning();
  const old = GetScenarioResponse.parse(await (await request(`/scenarios/${legacy!.id}`)).json());
  assert.equal((old.setupData as Record<string, unknown>).processMode, "custom");
  assert.equal((old.setupData as Record<string, unknown>).flowBasis, undefined);
  assert.deepEqual(old.inputs, scopedInputs);
  assert.equal((await request("/scenarios", "POST", { name: "Unreviewed new setup", inputs: scopedInputs, setupData: setup })).status, 400);
});

test("approved overrides are retained, changed provenance is rejected, and foreign files cannot attach", async () => {
  const original = ResolveScenarioFlowBasisResponse.parse(await (await request("/scenario-flow-basis", "POST", { selectedDomains: ["Hire"] })).json());
  const intentKey = intents.find((intent) => intent.domain === "hire")!.key;
  await db.insert(flowOverridesTable).values({ organizationId: orgA, intentKey, version: 1, status: "approved",
    author: "fixture", rationale: "existing client override", toBeHumanMin: 20 });
  const current = ResolveScenarioFlowBasisResponse.parse(await (await request("/scenario-flow-basis", "POST", { selectedDomains: ["Hire"] })).json());
  assert.equal(current.source, "product-base-with-overrides");
  assert.deepEqual(current.overrideRefs, [`${intentKey}:v1`]);
  const stale = await request("/scenarios", "POST", { name: "Stale", inputs: { ...inputs, intentShareOverrides: original.intentWeights },
    setupData: { ...setup, flowBasis: original, customizationStatus: "none" } });
  assert.equal(stale.status, 400);
  const [foreignFile] = await db.insert(scenarioFilesTable).values({ organizationId: orgB, ownerUserId: userB,
    objectPath: `private/test/${randomUUID()}`, originalName: "foreign.txt", contentType: "text/plain", sizeBytes: 5 }).returning();
  const forgedFile = await request("/scenarios", "POST", { name: "Foreign file", inputs: { ...inputs, intentShareOverrides: current.intentWeights },
    setupData: { ...setup, flowBasis: current, customizationStatus: "pending-review" }, fileIds: [foreignFile!.id] });
  assert.equal(forgedFile.status, 400);
  const forgedTenant = await request("/scenario-flow-basis", "POST", { selectedDomains: ["Hire"] }, orgB, userA);
  assert.equal(forgedTenant.status, 403);
  const [retained] = await db.select().from(flowOverridesTable).where(eq(flowOverridesTable.organizationId, orgA));
  assert.equal(retained?.toBeHumanMin, 20);
  assert.equal((await request("/scenario-flow-basis", "POST", { selectedDomains: ["Unknown"] })).status, 400);
});
