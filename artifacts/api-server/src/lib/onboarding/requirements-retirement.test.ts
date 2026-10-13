import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db, organizationsTable, onbCases, onbApprovals, onbConnectors, onbSystemChecks,
  onbGovernanceRequirements, onbGovernanceHistory, onbGovernanceDecisions,
  onbGovernanceReminders, onbGovernanceDispatchMarkers, onbEvents, onbEffectJournal, onbCommunications,
} from "@workspace/db";
import governanceRouter from "../../routes/governance";
import { ensureGovernanceSeeded, listGovernanceDecisions, listGovernanceHistory } from "./governance";
import {
  adoptGovernanceDecisionSnapshot, withGovernanceDecisionSnapshot,
  evaluateStoredCaseGovernanceGate,
} from "./governance-runtime";
import { withGovernanceDispatch } from "./governance-dispatch";
import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import { SYNTHETIC_OFFLINE_MARKER, sampleCandidateEmailEligible } from "./synthetic-offline";

// The harness runs this suite in a disposable DB, never against the API
// worker's live database. No index/worker or provider adapter is started here.
const org = `register-retirement-${randomUUID()}`;
const otherOrg = `${org}-other`;
let server: Server;
let baseUrl: string;
let caseRow: typeof onbCases.$inferSelect;
let approval: typeof onbApprovals.$inferSelect;

before(async () => {
  await db.insert(organizationsTable).values([org, otherOrg].map(id => ({
    id, name: "Retirement regression", slug: id, joinCodeHash: `hash-${id}`, createdByUserId: "fixture",
  })));
  const snapshot = withGovernanceDecisionSnapshot({}, adoptGovernanceDecisionSnapshot({
    decisions: [], adoptedAt: "2030-01-01T00:00:00.000Z",
  }));
  [caseRow] = await db.insert(onbCases).values({
    organizationId: org, workerName: "Retirement Fixture", workerEmail: "retirement@example.invalid",
    workerCategory: "contractor", hireType: "contractor", role: "Engineer", department: "Technology",
    geography: "US", legalEntity: "Fixture", managerName: "Manager", recruiterName: "Recruiter",
    joiningDate: "2030-01-01", lifecycleStage: "plan-generated",
    orchestrationStatus: "waiting-approval", processPolicySnapshot: snapshot,
  }).returning();
  [approval] = await db.insert(onbApprovals).values({
    organizationId: org, caseId: caseRow.id, agent: "fixture", recommendation: "Explicit review required",
    rationale: "Retirement cannot continue held work", status: "pending", resumeAction: "continue-after-intake",
  }).returning();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = req.header("x-organization-id") ?? org;
    req.organizationRole = "owner";
    req.authUserId = "fixture";
    next();
  });
  app.use(governanceRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  const orgs = [org, otherOrg];
  await db.delete(onbCases).where(inArray(onbCases.organizationId, orgs));
  for (const table of [
    onbConnectors, onbGovernanceRequirements, onbGovernanceHistory,
    onbGovernanceReminders, onbGovernanceDecisions, onbGovernanceDispatchMarkers,
  ]) await db.delete(table).where(inArray(table.organizationId, orgs));
  await deleteTestOrganizations(inArray(organizationsTable.id, orgs));
});

test("reads seed decisions only; retired API calls retain every historical row and audit event", async () => {
  await ensureGovernanceSeeded(org);
  assert.equal((await db.select().from(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, org))).length, 0);
  const [legacy] = await db.insert(onbGovernanceRequirements).values({
    organizationId: org, key: "REQ-05", title: "Retained coverage",
    sourceReference: "Historical source", reviewOwnerRole: "legal", configured: false, approvedForLive: true,
    relatedImplementation: "Historical implementation", evidenceReference: "Historical evidence",
  }).returning();
  const [event] = await db.insert(onbGovernanceHistory).values({
    organizationId: org, entityType: "requirement", entityKey: "REQ-05", eventType: "coverage-updated",
    actorUserId: "historical-actor", detail: { version: 1, retained: true },
  }).returning();
  assert.ok((await listGovernanceDecisions(org)).length > 0);
  assert.ok((await listGovernanceHistory(org)).some(row => row.id === event.id));
  for (const method of ["GET", "PUT", "POST", "PATCH", "DELETE"]) {
    for (const path of ["/governance/requirements", "/governance/requirements/REQ-05/coverage"]) {
      for (const organizationId of [org, otherOrg]) {
        const response = await fetch(baseUrl + path, {
          method, headers: { "content-type": "application/json", "x-organization-id": organizationId },
          ...(method === "GET" ? {} : { body: JSON.stringify({ expectedVersion: 1, configured: true, approvedForLive: true }) }),
        });
        assert.equal(response.status, 410);
        assert.equal(((await response.json()) as { code: string }).code, "REQUIREMENTS_REGISTER_RETIRED");
      }
    }
  }
  await ensureGovernanceSeeded(org);
  assert.deepEqual(await db.select().from(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, org)), [legacy]);
  assert.deepEqual(await db.select().from(onbGovernanceHistory).where(eq(onbGovernanceHistory.organizationId, org)), [event]);
  assert.equal((await db.select().from(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, otherOrg))).length, 0);
});

test("missing, false and true legacy flags never replace trusted provider or source evidence", async () => {
  for (const flags of [null, false, true]) {
    await db.delete(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, org));
    if (flags !== null) await db.insert(onbGovernanceRequirements).values({
      organizationId: org, key: "REQ-05", title: "History", sourceReference: "History", reviewOwnerRole: "legal",
      implemented: flags, tested: flags, configured: flags, approvedForLive: flags,
    });
    await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, org));
    await db.delete(onbSystemChecks).where(eq(onbSystemChecks.organizationId, org));
    for (const workflow of ["background-verification", "payroll-benefits", "it-identity-access"] as const) {
      const result = await evaluateStoredCaseGovernanceGate({ caseRow, workflow });
      assert.ok(result.blockers.some(blocker => blocker.kind === "provider-not-configured"), `${flags}: ${workflow}`);
      assert.ok(!result.blockers.some(blocker => blocker.kind.startsWith("requirement-")));
      if (workflow === "it-identity-access") assert.ok(result.blockers.some(blocker => blocker.kind === "evidence-not-available"));
    }
    // A connected label plus simulated timestamps is not trusted configuration.
    await db.insert(onbConnectors).values({
      organizationId: org, key: "itsm", label: "Fixture", vendor: "fixture", description: "No network adapter",
      status: "connected", lastSyncAt: new Date(), configurationProvenance: "simulated",
    });
    let result = await evaluateStoredCaseGovernanceGate({ caseRow, workflow: "it-identity-access" });
    assert.ok(result.blockers.some(blocker => blocker.kind === "provider-not-configured"));
    await db.update(onbConnectors).set({ configurationProvenance: "trusted-provider" }).where(eq(onbConnectors.organizationId, org));
    result = await evaluateStoredCaseGovernanceGate({ caseRow, workflow: "it-identity-access" });
    assert.deepEqual(result.blockers.map(blocker => blocker.kind), ["evidence-not-available"]);
    await db.insert(onbSystemChecks).values({
      organizationId: org, caseId: caseRow.id, system: "bgv", mode: "poll", externalRef: "fixture-only",
      status: "done", dueAt: new Date(), completedAt: new Date(), evidenceProvenance: "simulated",
    });
    assert.equal((await evaluateStoredCaseGovernanceGate({ caseRow, workflow: "it-identity-access" })).allowed, false);
    await db.update(onbSystemChecks).set({ evidenceProvenance: "trusted-provider" }).where(eq(onbSystemChecks.organizationId, org));
    assert.equal((await evaluateStoredCaseGovernanceGate({ caseRow, workflow: "it-identity-access" })).allowed, true);
  }
});

test("policy, permission receipts, snapshot adoption, standard hire evidence and tenant scope still fail closed", async () => {
  const missingSnapshot = await evaluateStoredCaseGovernanceGate({
    caseRow: { ...caseRow, processPolicySnapshot: {} }, workflow: "it-identity-access",
  });
  assert.deepEqual(missingSnapshot.blockers.map(row => row.kind), ["case-governance-snapshot-missing"]);
  for (const status of ["provisional", "approved"] as const) {
    const snapshot = withGovernanceDecisionSnapshot({}, adoptGovernanceDecisionSnapshot({
      decisions: [{ key: "GD-04", revision: 1, domain: "legal", impactedWorkflows: ["it-identity-access"], status }],
      adoptedAt: "2030-01-01T00:00:00.000Z",
    }));
    const result = await evaluateStoredCaseGovernanceGate({
      caseRow: { ...caseRow, processPolicySnapshot: snapshot }, workflow: "it-identity-access",
    });
    assert.ok(result.blockers.some(row => row.kind === (status === "approved" ? "reviewer-authority-inactive" : "unapproved-sensitive-decision")));
  }
  const standard = await evaluateStoredCaseGovernanceGate({
    caseRow: { ...caseRow, workerCategory: "employee", hireType: "external-fte" }, workflow: "assets-workplace",
  });
  assert.ok(standard.blockers.some(row => row.kind === "hris-not-active"));
  const foreign = await evaluateStoredCaseGovernanceGate({
    caseRow: { ...caseRow, organizationId: otherOrg }, workflow: "it-identity-access",
  });
  assert.deepEqual(foreign.blockers.map(row => row.kind), ["provider-not-configured", "evidence-not-available"]);
  const historical = await evaluateStoredCaseGovernanceGate({
    caseRow: { ...caseRow, syntheticProvenance: "synthetic-reset", notes: SYNTHETIC_OFFLINE_MARKER },
    workflow: "it-identity-access",
  });
  assert.equal(historical.execution, "isolated-simulation");
  assert.equal(sampleCandidateEmailEligible({
    ...caseRow, syntheticProvenance: "synthetic-reset", notes: SYNTHETIC_OFFLINE_MARKER,
  }), false);
});

test("retirement does not continue holds, decide approvals, create effects or copy coverage into new fences", async () => {
  const beforeCase = (await db.select().from(onbCases).where(eq(onbCases.id, caseRow.id)))[0];
  const beforeApproval = (await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval.id)))[0];
  await listGovernanceDecisions(org);
  await listGovernanceHistory(org);
  await evaluateStoredCaseGovernanceGate({ caseRow, workflow: "it-identity-access" });
  assert.deepEqual((await db.select().from(onbCases).where(eq(onbCases.id, caseRow.id)))[0], beforeCase);
  assert.deepEqual((await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval.id)))[0], beforeApproval);
  assert.equal((await db.select().from(onbEvents).where(eq(onbEvents.organizationId, org))).length, 0);
  assert.equal((await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.organizationId, org))).length, 0);
  assert.equal((await db.select().from(onbCommunications).where(eq(onbCommunications.organizationId, org))).length, 0);
  assert.equal((await db.select().from(onbGovernanceDispatchMarkers).where(eq(onbGovernanceDispatchMarkers.organizationId, org))).length, 0);
  // Explicit, in-process non-delivery callback tests fence capture only.
  await withGovernanceDispatch({ organizationId: org, operation: "fixture-definitive-no-send" }, async fence => {
    assert.equal("requirements" in fence, false);
    return { disposition: "definitive-not-sent", value: null };
  });
});
