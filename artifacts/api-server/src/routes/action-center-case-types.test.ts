import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool, onbCases, onbDocuments, onbCommunications, offbCases, offbExchanges,
  onbEarlyTenureAssignments, onbEarlyTenureReminders,
  organizationsTable, organizationMembershipsTable, accessNamedGrants } from "@workspace/db";
import { initialState } from "../lib/offboarding/model";
import { actionCenterFamily, actionCenterFamilies, matchesActionCenterContext } from "../lib/onboarding/action-center-family";
import { getActionCenter } from "../lib/onboarding/action-center";
import { HRO_BATCH_TEMPLATES, hroRequestForRow } from "../lib/onboarding/hro-batch-templates";
import { getEarlyTenureReminderInbox } from "../lib/onboarding/early-tenure";
import actionCenterRouter from "./action-center";
import onboardingRouter from "./onboarding";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";

// run-tests.mjs runs this suite in a disposable migrated schema. These fixtures
// have no contacts, consent, source operations, providers, policies or workers.
const suffix = randomUUID();
const org = `action-family-${suffix}`, otherOrg = `action-family-other-${suffix}`;
const owner = `family-owner-${suffix}`, reader = `family-reader-${suffix}`, denied = `family-denied-${suffix}`;
const ids: number[] = [], separations: number[] = [];
let payrollId: number, onboardingId: number, hiddenId: number;
let server: Server, url: string;
async function envelope(organizationId: string, name: string, hireType = "external", scenarioKey: string | null = null) {
  const [row] = await db.insert(onbCases).values({
    organizationId, workerName: name, workerEmail: "", channelPreference: "email",
    hireType, workerCategory: "full-time", role: "Fixture role", department: "Fixture department",
    geography: "US", legalEntity: "Fixture legal entity", managerName: "", recruiterName: "",
    joiningDate: "2099-01-01", lifecycleStage: hireType === "separation" ? "separation-held" : "complete",
    orchestrationStatus: hireType === "separation" ? "separation-only" : "idle",
    workforceContext: { workCountry: "US" }, readiness: [], workstreams: [], checklistSnapshot: [],
    scenarioKey,
  }).returning();
  ids.push(row!.id); return row!.id;
}
async function allow(caseId: number, keys = ["flow.case.read", "data.case.profile.read"]) {
  await db.insert(accessNamedGrants).values(keys.map(resourceKey => ({
    organizationId: org, principalType: "human" as const, principalId: reader, scope: "case" as const, caseId,
    resourceType: resourceKey.startsWith("flow.") ? "flow" as const : "field" as const,
    resourceKey, source: "named" as const, effect: "allow" as const, createdByUserId: owner,
    approvedByUserId: owner, approvedAt: new Date(),
  })));
}
async function read(query = "", actor = owner, organizationId = org, path = "/onboarding/action-center") {
  const response = await fetch(`${url}${path}?${query}`, { headers: {
    "x-organization-id": organizationId, "x-test-user": actor,
  } });
  return { status: response.status, body: await response.json() as any };
}
before(async () => {
  await db.insert(organizationsTable).values([org, otherOrg].map(id => ({
    id, name: id, slug: id, joinCodeHash: `fixture-${id}`, createdByUserId: owner,
  })));
  await db.insert(organizationMembershipsTable).values([
    { organizationId: org, clerkUserId: owner, role: "owner" },
    { organizationId: otherOrg, clerkUserId: owner, role: "owner" },
    { organizationId: org, clerkUserId: reader, role: "member" },
    { organizationId: org, clerkUserId: denied, role: "member" },
  ]);
  onboardingId = await envelope(org, "Private onboarding narrative");
  payrollId = await envelope(org, "Private payroll narrative");
  const payrollTemplate = HRO_BATCH_TEMPLATES.find(t => t.family === "Payroll")!;
  await db.update(onbCases).set({ processPolicySnapshot: { batchIntake:
    hroRequestForRow(payrollTemplate, { request_id: "fixture-payroll", worker_name: "Private payroll narrative" }),
  } }).where(eq(onbCases.id, payrollId));
  hiddenId = await envelope(org, "Private hidden narrative");
  await allow(onboardingId);
  await allow(payrollId);
  for (const caseId of [onboardingId, payrollId, hiddenId]) {
    await db.insert(onbDocuments).values({ organizationId: org, caseId,
      key: "fixture-doc", label: "Private fixture document", category: "identity", status: "pending", required: true });
    await db.insert(onbCommunications).values({ organizationId: org, caseId, direction: "outbound",
      channel: "email", audience: "candidate", toAddress: "private@example.test",
      subject: `Recorded private notice ${caseId}`, body: "Private body", status: "logged-only" });
  }
  for (let i = 0; i < 3; i++) {
    const caseId = await envelope(org, `Separation ${i}`, "separation");
    separations.push(caseId); await allow(caseId);
    await db.insert(offbCases).values({ id: caseId, organizationId: org, employeeId: `FIXTURE-${i}`,
      activeKey: `FIXTURE-${i}`, status: "held", state: initialState(), facts: {
        employeeId: `FIXTURE-${i}`, workerName: `Separation ${i}`, exitType: "resignation",
        exitReason: "Private reason", lastWorkingDay: "2099-01-01", terminationDate: "2099-01-01",
        country: "US", timeZone: "UTC", legalEntity: "Fixture", role: "Fixture", department: "Fixture",
        manager: "Fixture", workerCategory: "full-time",
      } });
  }
  const foreign = await envelope(otherOrg, "Foreign separation", "separation");
  await db.insert(offbCases).values({ id: foreign, organizationId: otherOrg,
    employeeId: "FOREIGN", state: initialState(), facts: {
      employeeId: "FOREIGN", workerName: "Foreign", exitType: "resignation", exitReason: "Private",
      lastWorkingDay: "2099-01-01", terminationDate: "2099-01-01", country: "US", timeZone: "UTC",
      legalEntity: "Fixture", role: "Fixture", department: "Fixture", manager: "Fixture", workerCategory: "full-time",
    } });
  const app = express();
  app.use((req, _res, next) => { req.authUserId = req.header("x-test-user")!; next(); });
  app.use(createTenantContextMiddleware(lookupMembership));
  app.use(actionCenterRouter);
  app.use(onboardingRouter);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(500).json({ message: "Fixture source failed" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>(r => server.close(() => r()));
  await db.delete(offbExchanges).where(inArray(offbExchanges.organizationId, [org, otherOrg]));
  await db.delete(offbCases).where(inArray(offbCases.organizationId, [org, otherOrg]));
  await db.delete(onbDocuments).where(inArray(onbDocuments.caseId, ids));
  await db.delete(onbCommunications).where(inArray(onbCommunications.caseId, ids));
  await db.delete(accessNamedGrants).where(eq(accessNamedGrants.organizationId, org));
  await db.delete(onbCases).where(inArray(onbCases.id, ids));
  await deleteTestOrganizations(inArray(organizationsTable.id, [org, otherOrg]));
  await pool.end();
});
test("canonical family taxonomy and legacy fallback agree; unknown context is not false", () => {
  assert.equal(actionCenterFamilies.length, 12);
  assert.equal(actionCenterFamily({ hireType: "separation", processPolicySnapshot: {} }), "Offboarding");
  for (const [scenarioKey, expected] of [["payroll-bank-change", "Payroll"],
    ["it-privileged-access", "IT Access"], ["learning-mandatory-certification", "Learning"]]) {
    assert.equal(actionCenterFamily({ hireType: "external", processPolicySnapshot: {},
      scenarioKey: `UAT-DEMO-COVERAGE:${scenarioKey}` }), expected);
  }
  assert.equal(matchesActionCenterContext({ workforceContext: {} }, { siteExposure: false }), false);
  assert.equal(matchesActionCenterContext({ workforceContext: {} }, { safetyCritical: true }), false);
});
test("All has three distinct separations without onboarding child actions and no invented work", async () => {
  const { status, body } = await read("scope=all");
  assert.equal(status, 200);
  assert.equal(body.caseSummaries.filter((c: any) => separations.includes(c.caseId)).length, 3);
  assert.equal(new Set(body.caseSummaries.map((c: any) => c.caseId)).size, body.caseSummaries.length);
  assert.deepEqual(body.domainRecords, []);
  for (const key of ["documentFollowups", "notifications", "approvals", "opportunities", "workItems", "completed"]) {
    assert.ok(body[key].every((r: any) => !separations.includes(r.caseId)));
  }
  assert.ok(body.caseSummaries.filter((c: any) => c.caseType === "Offboarding")
    .every((c: any) => c.caseHref === `/cases/separations/${c.caseId}`));
});
test("Offboarding remains discoverable in every scope, but summaries do not count as actions", async () => {
  for (const scope of ["active", "all", "completed"]) {
    const { status, body } = await read(`caseType=Offboarding&scope=${scope}&limit=1`);
    assert.equal(status, 200);
    assert.deepEqual(body.caseSummaries.map((c: any) => c.caseId).sort(), [...separations].sort());
    assert.ok(Object.values(body.counts).every(n => n === 0));
    assert.deepEqual(body.domainRecords, []);
  }
  const approvals = await read("caseType=Offboarding", owner, org, "/onboarding/approvals");
  assert.equal(approvals.status, 200); assert.deepEqual(approvals.body, []);
});
test("Onboarding and Payroll filter before source limits; counts reconcile with authorized rows", async () => {
  const { body } = await read("caseType=Payroll&scope=all&limit=1", reader);
  assert.deepEqual(body.caseSummaries.map((c: any) => c.caseId), [payrollId]);
  assert.equal(body.documentFollowups.length, 1);
  assert.equal(body.documentFollowups[0].caseId, payrollId);
  assert.equal(body.counts.missingDocuments, body.documentFollowups.length);
  assert.equal(body.counts.notifications, body.notifications.length);
  const first = await read("caseType=Onboarding&limit=1", reader);
  assert.equal(first.body.documentFollowups.length, 1);
  assert.equal(first.body.documentFollowups[0].caseId, onboardingId,
    "Newer inaccessible documents must not consume the first visible slot.");
  const service = await getActionCenter(org, "active", 1, { caseType: "Payroll" }, "standard", reader);
  assert.equal(service.documentFollowups[0]?.caseId, payrollId);
});
test("authorized narrative is meaningful; a typed fallback protects recipients and actors", async () => {
  const ownerResult = await read("caseType=Payroll");
  assert.equal(ownerResult.body.notifications[0].title, `Recorded private notice ${payrollId}`);
  assert.match(ownerResult.body.notifications[0].recipient, /private@example.test/);
  const readerResult = await read("caseType=Payroll", reader);
  assert.equal(readerResult.body.notifications[0].title, "Communication recorded");
  assert.equal(readerResult.body.notifications[0].recipient, "Restricted");
  assert.equal(readerResult.body.notifications[0].initiator, "Restricted");
  assert.doesNotMatch(JSON.stringify(readerResult.body), /Private body|Recorded private notice|private@example/);
});
test("explicit job context, invalid types and absent provisioning have distinct results", async () => {
  assert.equal((await read("caseType=unknown")).status, 400);
  assert.equal((await read("safetyCritical=unknown")).status, 400);
  assert.equal((await read("limit=1.5")).status, 400);
  assert.equal((await read("caseType=unknown", owner, org, "/onboarding/approvals")).status, 400);
  const filtered = await read("caseType=Offboarding&safetyCritical=true");
  assert.equal(filtered.status, 200); assert.deepEqual(filtered.body.caseSummaries, []);
  assert.deepEqual((await read("caseType=Offboarding&siteExposure=false")).body.caseSummaries, []);
  const absent = await read("caseType=Payroll", owner, otherOrg);
  assert.equal(absent.status, 200); assert.deepEqual(absent.body.caseSummaries, []);
});
test("cross-client records and denied separation sources never disclose envelopes or evidence", async () => {
  const result = await read("caseType=Offboarding", denied);
  assert.equal(result.status, 200);
  assert.equal(result.body.offboardingSource, "denied");
  assert.deepEqual(result.body.caseSummaries, []);
  assert.doesNotMatch(JSON.stringify(result.body), /Private reason|Separation 0|Foreign/);
  const foreign = await read("caseType=Offboarding", reader, otherOrg);
  assert.equal(foreign.status, 403);
});
test("offboarding source failure is explicit, not an empty success or raw database error", async () => {
  // Disposable schema only. Restore even when the assertion fails.
  await db.execute(sql`ALTER TABLE offb_cases RENAME TO action_family_unavailable`);
  try {
    const result = await read("caseType=Offboarding");
    assert.equal(result.status, 503);
    assert.equal(result.body.message, "Offboarding records could not be loaded.");
  } finally { await db.execute(sql`ALTER TABLE action_family_unavailable RENAME TO offb_cases`); }
});
test("revoked case access disappears on refresh and cannot contribute to filtered counts", async () => {
  await db.delete(accessNamedGrants).where(and(eq(accessNamedGrants.organizationId, org),
    eq(accessNamedGrants.principalId, reader), eq(accessNamedGrants.caseId, payrollId)));
  const result = await read("caseType=Payroll", reader);
  assert.equal(result.status, 200); assert.deepEqual(result.body.caseSummaries, []);
  assert.equal(result.body.counts.notifications, 0); assert.equal(result.body.counts.missingDocuments, 0);
});
test("recorded task state is separate from case presence, stale outcomes and cancelled work", async () => {
  const state = initialState();
  state.tasks = [{ id: "fixture", activity: "02", label: "Private task label", stream: "restricted",
    scope: "legal-approve", owner: null, prerequisites: [], dueAt: null, notBeforeAt: null,
    status: "verified", evidence: null, details: { privateReference: "Private evidence" } }];
  await db.update(offbCases).set({ state }).where(eq(offbCases.id, separations[0]!));
  const active = await read("caseType=Offboarding&scope=active", reader);
  assert.equal(active.body.caseSummaries.length, 3);
  assert.equal(active.body.domainRecords.length, 1);
  assert.equal(active.body.domainRecords[0].category, "attention");
  assert.equal(active.body.domainRecords[0].status, "blocked", "Stale verified evidence is not a completion.");
  assert.doesNotMatch(JSON.stringify(active.body), /Private task label|Private evidence/);
  assert.deepEqual((await read("caseType=Offboarding&scope=completed", reader)).body.domainRecords, []);
  await db.update(offbCases).set({ status: "cancelled", activeKey: null }).where(eq(offbCases.id, separations[0]!));
  assert.deepEqual((await read("caseType=Offboarding&scope=active", reader)).body.domainRecords, []);
  await db.update(offbCases).set({ status: "held", activeKey: "FIXTURE-0", state: initialState() }).where(eq(offbCases.id, separations[0]!));
});
test("authorized older separation summaries survive more than 200 newer denied envelopes", async () => {
  const [template] = await db.select().from(onbCases).where(eq(onbCases.id, separations[0]!));
  const { id: _id, ...values } = template!;
  const newEnvelopes = await db.insert(onbCases).values(Array.from({ length: 201 }, (_, i) => ({
    ...values, workerName: `Denied boundary fixture ${i}`, createdAt: new Date(),
  }))).returning({ id: onbCases.id });
  ids.push(...newEnvelopes.map(e => e.id));
  const [original] = await db.select().from(offbCases).where(eq(offbCases.id, separations[0]!));
  await db.insert(offbCases).values(newEnvelopes.map((e, i) => ({
    id: e.id, organizationId: org, employeeId: `BOUNDARY-${i}`, facts: {
      ...original!.facts, employeeId: `BOUNDARY-${i}`, workerName: `Denied boundary fixture ${i}`,
    }, state: initialState(), createdAt: new Date(),
  })));
  const result = await read("caseType=Offboarding&scope=all&limit=1", reader);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.caseSummaries.map((c: any) => c.caseId).sort(), [...separations].sort());
  assert.equal(result.body.offboardingSource, "partial");
  assert.doesNotMatch(JSON.stringify(result.body), /Denied boundary fixture/);
});
test("ancillary reminders apply family and unknown context before acknowledging in-app visibility", async () => {
  const [assignment] = await db.insert(onbEarlyTenureAssignments).values({
    organizationId: org, caseId: onboardingId, snapshotVersion: 1, obligationKey: "filter-inbox",
    revision: 1, kind: "induction", title: "Assigned task", ownerName: "Fixture member", ownerUserId: reader,
    dueAt: new Date(), taskDetails: {},
  }).returning();
  const [reminder] = await db.insert(onbEarlyTenureReminders).values({
    organizationId: org, caseId: onboardingId, targetType: "assignment", targetId: assignment!.id,
    targetRevision: 1, eventKey: `family-${suffix}`, intendedRecipient: "Fixture member",
    dueAt: new Date(), availableAt: new Date(),
  }).returning();
  try {
    assert.deepEqual(await getEarlyTenureReminderInbox(org, reader, { caseType: "Offboarding" }), []);
    assert.deepEqual(await getEarlyTenureReminderInbox(org, reader, { caseType: "Onboarding", safetyCritical: false }), []);
    const [unshown] = await db.select().from(onbEarlyTenureReminders).where(eq(onbEarlyTenureReminders.id, reminder!.id));
    assert.equal(unshown!.status, "pending");
    const inbox = await getEarlyTenureReminderInbox(org, reader, { caseType: "Onboarding" });
    assert.equal(inbox.length, 1); assert.equal(inbox[0]!.obligationLabel, "Assigned task");
    assert.ok(!("caseId" in inbox[0]!));
    assert.doesNotMatch(JSON.stringify(inbox), /workerName|workerEmail|department/);
  } finally {
    await db.delete(onbEarlyTenureReminders).where(eq(onbEarlyTenureReminders.id, reminder!.id));
    await db.delete(onbEarlyTenureAssignments).where(eq(onbEarlyTenureAssignments.id, assignment!.id));
  }
});
