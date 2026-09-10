import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, onbApprovals, onbCases, onbEffectJournal, onbEvents, organizationsTable } from "@workspace/db";
import onboardingRouter from "./onboarding";

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `gateway-route-a-${suffix}`;
const orgB = `gateway-route-b-${suffix}`;
const user = `gateway-route-user-${suffix}`;
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

before(async () => {
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Gateway Route A", slug: orgA, joinCodeHash: `hash-${orgA}`, createdByUserId: user },
    { id: orgB, name: "Gateway Route B", slug: orgB, joinCodeHash: `hash-${orgB}`, createdByUserId: user },
  ]);
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
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  // The route deliberately starts asynchronous orchestration. Fixtures use a
  // deterministic intake hard-block below; let that short handoff settle
  // before removing its case-owned rows.
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (caseIds.length) await db.delete(onbCases).where(inArray(onbCases.id, caseIds));
  await db.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, orgA));
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
    joiningDate: "2030-01-01",
    notes: "bgv fixture hard-block",
    offerAcceptanceComplete,
  };
}

test("create persists unchecked and HR-attested checked Gate A metadata", async () => {
  const unchecked = await call("/onboarding/cases", orgA, {
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
  assert.equal(checked.status, 201);
  const checkedCase = await checked.json() as Record<string, unknown>;
  caseIds.push(checkedCase.id as number);
  assert.equal(checkedCase.offerAcceptanceComplete, true);
  assert.ok(checkedCase.offerAcceptanceCompletedAt);
  assert.equal(checkedCase.offerAcceptanceCompletedBy, user);
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
    joiningDate: "2030-01-01",
    notes: "bgv fixture hard-block",
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
    method: "POST", headers: { "x-test-role": "member" }, body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(readerDecision.status, 403);
  const crossTenant = await call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgB, {
    method: "POST", body: JSON.stringify({ note: "wrong tenant" }),
  });
  assert.equal(crossTenant.status, 404);

  const [first, second] = await Promise.all([
    call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgA, {
      method: "POST", headers: { "x-test-role": "admin" }, body: JSON.stringify({ note: "HR evidence checked" }),
    }),
    call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgA, {
      method: "POST", body: JSON.stringify({ note: "concurrent retry" }),
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
  assert.equal(events.length, 1);
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
  }).returning();
  caseIds.push(tenantA.id, tenantB.id);

  const filtered = await call(
    `/onboarding/analytics/outcome-kpis?period=7&region=${encodeURIComponent(region)}`,
    orgA,
  );
  assert.equal(filtered.status, 200);
  const filteredBody = await filtered.json() as {
    caseCount: number;
    metrics: Array<{ id: string; eligibleCount: number }>;
  };
  assert.equal(filteredBody.caseCount, 1);
  assert.equal(
    filteredBody.metrics.find((item) => item.id === "cycle-time")?.eligibleCount,
    1,
  );

  const unsupported = await call(
    `/onboarding/analytics/outcome-kpis?period=7&region=${encodeURIComponent(region)}&domain=Payroll`,
    orgA,
  );
  assert.equal(unsupported.status, 200);
  const unsupportedBody = await unsupported.json() as { caseCount: number };
  assert.equal(unsupportedBody.caseCount, 0);
});