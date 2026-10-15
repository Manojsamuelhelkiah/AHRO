import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { db, onbCases, organizationsTable, organizationMembershipsTable, caseFlowBindings, caseFlowDefinitions, caseFlowTransitions, onbSensitiveLifecyclePolicies } from "@workspace/db";
import onboardingRouter from "../../routes/onboarding";
import { requireOwnedOrganizationTestSchema, deleteTestOrganizations } from "../../test-support/organization-fixtures";
import { bindNewCaseInTransaction, reconcileBindingInTransaction, guardDomainAction, observationMayRequestContinuation, validateTransitionInTransaction } from "./manager";
import { projectCaseFlow } from "./projection";
import { ONBOARDING_V1, definitionDigest } from "./definitions";
import { LEGACY_CHECKLIST, readinessFromChecklist } from "../onboarding/settings";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";
import { reconcileDocumentationReadiness } from "../onboarding/document-validation";

const org = `flow-contract-${randomUUID()}`;
let server: Server;
let origin: string;
before(async () => {
  await requireOwnedOrganizationTestSchema();
  await db.insert(organizationsTable).values({ id: org, name: org, slug: org, joinCodeHash: org, createdByUserId: "fixture-owner" });
  await seedApprovedSensitiveLifecyclePolicies(org);
  await db.insert(organizationMembershipsTable).values({ organizationId: org, clerkUserId: "fixture-owner", role: "admin" });
  const app = express();
  app.use((req, _res, next) => {
    req.organizationId = String(req.header("x-test-organization") ?? org);
    req.authUserId = req.header("x-test-user");
    next();
  });
  app.use(onboardingRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db.delete(onbCases).where(eq(onbCases.organizationId, org));
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, org));
  await deleteTestOrganizations(eq(organizationsTable.id, org));
});

async function admitted(overrides: Partial<typeof onbCases.$inferInsert> = {}, bind = true) {
  return db.transaction(async tx => {
    const [c] = await tx.insert(onbCases).values({
      organizationId: org, workerName: "Flow fixture", workerEmail: "flow@example.invalid", hireType: "external-fte",
      workerCategory: "full-time", role: "Engineer", department: "Engineering", geography: "US",
      workforceContext: { workCountry: "US" }, legalEntity: "Fixture Co", managerName: "Manager", recruiterName: "Recruiter",
      joiningDate: "2030-01-01", readiness: readinessFromChecklist(LEGACY_CHECKLIST), workstreams: [],
      checklistSnapshot: LEGACY_CHECKLIST.map(i => ({ ...i })), lifecycleStage: "trigger-received",
      orchestrationStatus: "idle", ...overrides,
    }).returning();
    if (bind) await bindNewCaseInTransaction(tx, org, c.id, "onboarding");
    return c;
  });
}

test("admission binds immutable bytes without changing domain state; jsonb ordering does not change the digest", async () => {
  const c = await admitted();
  const [current] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
  assert.deepEqual(current, c);
  const [stored] = await db.select().from(caseFlowDefinitions).where(and(eq(caseFlowDefinitions.id, "onboarding.base"), eq(caseFlowDefinitions.version, 1)));
  assert.equal(definitionDigest(stored.definition as unknown as typeof ONBOARDING_V1), stored.digest);
  const causeMatches = (pattern: RegExp) => (error: unknown) => pattern.test(String((error as { cause?: Error }).cause?.message));
  await assert.rejects(db.execute(sql`UPDATE case_flow_definitions SET digest = 'tampered' WHERE id = 'onboarding.base'`), causeMatches(/immutable/));
  await assert.rejects(db.execute(sql`UPDATE case_flow_bindings SET definition_version = 2 WHERE organization_id = ${org} AND case_id = ${c.id}`), causeMatches(/cannot be replaced/));
});

test("reads never establish authority, bind a legacy case or dispatch continuation", async () => {
  const c = await admitted({ orchestrationCheckpoint: "unrecognized-legacy-cursor", orchestrationStatus: "running" }, false);
  const before = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
  const view = await projectCaseFlow(db, org, c.id, true);
  assert.equal(view?.mode, "compatibility-review");
  assert.equal(view?.definition, undefined);
  assert.equal(await observationMayRequestContinuation(db, org, c.id), false);
  assert.deepEqual(await db.select().from(onbCases).where(eq(onbCases.id, c.id)), before);
  assert.equal((await db.select().from(caseFlowBindings).where(eq(caseFlowBindings.caseId, c.id))).length, 0);
  assert.equal((await db.select().from(caseFlowTransitions).where(eq(caseFlowTransitions.caseId, c.id))).length, 0);
  assert.equal(await projectCaseFlow(db, `${org}-other`, c.id, true), null);
  await assert.rejects(db.transaction(tx => guardDomainAction(tx, c, "reconcile", "unknown-history")), /compatibility/);
});

test("source observations remain retainable on a compatibility-held case and do not pin or continue it", async () => {
  const c = await admitted({ orchestrationCheckpoint: "unrecognized-legacy-cursor", lifecycleStage: "preboarding" }, false);
  await reconcileDocumentationReadiness(org, c.id);
  const [after] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
  assert.equal(after.lifecycleStage, "preboarding");
  assert.equal(after.orchestrationCheckpoint, c.orchestrationCheckpoint);
  assert.equal(after.readiness.find(r => r.key === "documentation")?.status, "in-progress");
  assert.equal((await db.select().from(caseFlowBindings).where(eq(caseFlowBindings.caseId, c.id))).length, 0);
});

test("stale generations and direct sequencing bypasses fail before any transition is committed", async () => {
  const c = await admitted();
  await assert.rejects(db.transaction(tx => validateTransitionInTransaction(tx, {
    organizationId: org, caseId: c.id, actionId: "intake",
    expectedVersion: c.orchestrationClaimToken, expectedGeneration: c.workforceContextVersion + 1,
  })), /stale/);
  await assert.rejects(db.transaction(tx => guardDomainAction(tx, c, "workstreams", "bypass")), /offer|plan|prerequisite/);
  assert.equal((await db.select().from(caseFlowTransitions).where(eq(caseFlowTransitions.caseId, c.id))).length, 0);
});

test("duplicate concurrent validations converge on one case-scoped metadata operation without copying evidence", async () => {
  const c = await admitted();
  await Promise.all([1, 2].map(() => db.transaction(async tx => {
    const [locked] = await tx.select().from(onbCases).where(eq(onbCases.id, c.id)).for("update");
    await guardDomainAction(tx, locked, "start", "same-operation");
  })));
  const history = await db.select().from(caseFlowTransitions).where(eq(caseFlowTransitions.caseId, c.id));
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, "validated");
  const redacted = await projectCaseFlow(db, org, c.id, false);
  assert.equal(redacted?.progressRedacted, true);
  assert.equal(redacted?.history.length, 0);
  assert.equal(redacted?.tasks.length, 0);
  assert.ok(redacted?.actions.every(a => !a.eligible));
});

test("unsupported families stay explicitly review-only and never inherit onboarding execution", async () => {
  const c = await admitted({ hireType: "service-request" }, false);
  assert.equal((await projectCaseFlow(db, org, c.id, true))?.mode, "review-only");
  await assert.rejects(db.transaction(tx => guardDomainAction(tx, c, "start", "unsupported")), /compatibility/);
});
test("confident legacy mapping preserves domain progress and does not complete parallel tasks or dispatch work", async () => {
  const c = await admitted({
    offerAcceptanceComplete: true, lifecycleStage: "preboarding",
    orchestrationStatus: "checklist-blocked", orchestrationCheckpoint: "workstreams-complete",
    readiness: [{ key: "profile", label: "Profile", status: "ready" }],
    workstreams: [
      { key: "documents", label: "Documents", agent: "documentation", owner: "HR", status: "ready", blockers: [] },
      { key: "access", label: "Access", agent: "access", owner: "IT", status: "in-progress", blockers: [] },
    ],
  }, false);
  await db.transaction(async tx => {
    const [locked] = await tx.select().from(onbCases).where(eq(onbCases.id, c.id)).for("update");
    await reconcileBindingInTransaction(tx, locked);
  });
  assert.deepEqual((await db.select().from(onbCases).where(eq(onbCases.id, c.id)))[0], c);
  const view = await projectCaseFlow(db, org, c.id, true);
  assert.equal(view?.mode, "executable");
  assert.equal(view?.stages.find(s => s.id === "workstreams")?.status, "active");
  assert.equal(view?.tasks.find(t => t.id === "access")?.status, "in-progress");
  assert.deepEqual(view?.history, []);
});

test("the validated API is case-permission scoped, cross-tenant isolated and has no read-side binding or execution effects", async () => {
  const c = await admitted({ notes: "PRIVATE_CASE_EVIDENCE_DO_NOT_COPY" });
  const before = await db.select().from(caseFlowTransitions).where(eq(caseFlowTransitions.caseId, c.id));
  const path = `${origin}/onboarding/cases/${c.id}/flow`;
  assert.equal((await fetch(path)).status, 403);
  assert.equal((await fetch(path, { headers: { "x-test-user": "fixture-owner", "x-test-organization": `${org}-other` } })).status, 404);
  const response = await fetch(path, { headers: { "x-test-user": "fixture-owner" } });
  assert.equal(response.status, 200);
  const text = await response.text();
  const view = JSON.parse(text);
  assert.equal(view.mode, "executable");
  assert.equal(view.definitionVersion, 1);
  assert.doesNotMatch(text, /PRIVATE_CASE_EVIDENCE_DO_NOT_COPY|flow@example.invalid/);
  assert.deepEqual(await db.select().from(caseFlowTransitions).where(eq(caseFlowTransitions.caseId, c.id)), before);
});
