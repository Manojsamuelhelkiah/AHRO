import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, pool, accessNamedGrants, offbCases, offbSources, offbPolicies, offbCheckpoints, onbCases, onbConnectors, onbSettings, onbSystemChecks, onbEvents, onbSensitiveLifecyclePolicies, onbAuthorityAssignments, onbAuthorityGovernance, organizationsTable, organizationMembershipsTable, hroMailboxIngress, hroMailboxRequests, type OnbAuthorityRole, type OnbAuthorityScope, type SeparationFacts } from "@workspace/db";
import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import { onbReadinessSlaPolicies } from "@workspace/db";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";
import { createSeparations, actionSeparation, separationDetail, listSeparations } from "./service";
import { savePolicy, decidePolicy } from "./policy";
import { endOfLwd, facts, initialState, compilePlan } from "./model";
import { configureMailbox, ingestHroMailboxMessage, convertMailbox, reviewMailbox, extractMailboxFields } from "../hro-mailbox-ingress";
import { completeDay1ReadinessGate } from "../onboarding/engine";
import { withCaseDispatchGuard } from "../onboarding/dispatch-guard";
import { withCaseDerivedLifecycleWrite } from "../onboarding/sensitive-lifecycle";
import { isSeparationOrLegacyExit, onboardingCaseCandidateSql } from "../onboarding/separation-isolation";

const base: SeparationFacts = { employeeId: "FIXTURE-EMPLOYEE", workerName: "Offboarding provider-denied regression", exitType: "resignation", exitReason: "Restricted regression-only reason", lastWorkingDay: "2000-01-15", terminationDate: "2000-01-15", timeZone: "America/New_York", role: "Engineer", department: "Regression", country: "US", legalEntity: "Regression fixture only", workerCategory: "Employee", manager: "Fixture manager" };
const flags = { privileged: false, highRisk: false, clientFacing: false, peopleManager: false, statutory: false };
const policy = { country: "US", role: "Engineer", workerCategory: "Employee", timeZone: "America/New_York", endOfLwd: "18:00", rulesReference: "fixture-source-rules", retentionReference: "fixture-source-retention", defaultAssets: ["Unconfirmed fixture laptop"], obligations: [] };
const roles: Array<[OnbAuthorityRole, OnbAuthorityScope]> = [
  ["hr-compliance", "hr-compliance-approve"], ["legal", "legal-approve"], ["occupational-health", "occupational-health-approve"],
  ["payroll", "payroll-approve"], ["hrbp", "hrbp-approve"], ["hr-ethics", "hr-ethics-approve"], ["delivery-head", "delivery-head-approve"], ["finance", "finance-approve"],
  ["manager", "manager-approve"], ["site-operations", "site-fulfillment-approve"], ["application-owner", "application-owner-approve"], ["it-security", "it-security-approve"],
];

test("calendar and all five paths compile without invented closure conditions", () => {
  assert.throws(() => facts({ ...base, terminationDate: "1999-01-01" }), /precede/);
  assert.throws(() => facts({ ...base, lastWorkingDay: "2030-02-30" }), /real.*date/);
  assert.throws(() => facts({ ...base, timeZone: "no/such-zone" }), /time zone/);
  assert.equal(endOfLwd("2030-01-15", "18:00", "America/New_York"), "2030-01-15T23:00:00.000Z");
  assert.throws(() => endOfLwd("2030-03-10", "02:30", "America/New_York"), /ambiguous|nonexistent|unavailable|resolvable/);
  const s = initialState(); s.gatewayA = "clear"; s.classification = "human-reviewed"; s.urgency = "Standard"; s.flags = flags;
  const normal = compilePlan(base, s, policy);
  assert.ok(normal.find(t => t.id === "access-closure")?.notBeforeAt);
  assert.equal(normal.find(t => t.id === "asset-inventory")?.details.confirmed, false);
  for (const cause of ["privileged", "highRisk", "High"] as const) {
    const high = compilePlan(base, { ...s, urgency: cause === "High" ? "High" : "Standard", flags: { ...flags, privileged: cause === "privileged", highRisk: cause === "highRisk" } }, policy);
    assert.equal(high.find(t => t.id === "access-closure")?.activity, "07");
    assert.equal(high.find(t => t.id === "access-closure")?.notBeforeAt, null);
    assert.ok(high.some(t => t.id === "security-review"));
  }
  const client = compilePlan(base, { ...s, flags: { ...flags, clientFacing: true, peopleManager: true } }, policy);
  assert.ok(client.find(t => t.id === "client-continuity")?.prerequisites.includes("client-communication"));
  assert.ok(client.some(t => t.id === "manager-reassignment"));
  assert.ok(client.every(t => !["12", "C"].includes(t.activity)));
  assert.throws(() => compilePlan(base, { ...s, gatewayA: "restricted" }, policy), /Gateway A|confirm/);
  assert.equal(s.closureBlocker, "section-4.6-pending");
});

test("dedicated lifecycle reaches 01–11, fences conflicts, source intake, privacy, recovery and every closure path", { timeout: 120_000 }, async () => {
  const org = `offb-regression-${randomUUID()}`, other = `${org}-other`;
  const actor = `${org}:operator`, legal = `${org}:independent-legal`, viewer = `${org}:viewer`;
  const createOrg = async (id: string) => {
    await db.insert(organizationsTable).values({ id, name: "Provider-denied offboarding regression", slug: id, joinCodeHash: `${id}:unused`, createdByUserId: actor });
    await seedApprovedSensitiveLifecyclePolicies(id);
    await db.insert(onbAuthorityGovernance).values({ organizationId: id, status: "governance-approved", revision: 1, approvedByUserId: "fixture-external-governance", approvedAt: new Date(), governanceSource: "provider-denied-regression-only" });
    for (const user of [actor, legal, viewer]) {
      await db.insert(organizationMembershipsTable).values({ organizationId: id, clerkUserId: user, role: "member" });
      for (const key of ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit", ...(user === viewer ? [] : ["data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"])]) {
        await db.insert(accessNamedGrants).values({ organizationId: id, principalType: "human", principalId: user, scope: "tenant", resourceType: key.startsWith("flow.") ? "flow" : "field", resourceKey: key, source: "named", effect: "allow", status: "active", createdByUserId: "fixture-grantor", approvedByUserId: "fixture-independent-approver", approvedAt: new Date() });
      }
    }
    for (const [role, scope] of roles) await db.insert(onbAuthorityAssignments).values({ id: `${id}:${role}`, organizationId: id, personUserId: actor, authorityRole: role, scopes: [scope], validFrom: new Date(Date.now() - 60_000), validUntil: new Date(Date.now() + 3600_000), grantorUserId: "fixture-independent-governance", source: "provider-denied-regression-only", governanceDecisionRef: "fixture-reviewed-authority-only" });
    await db.insert(onbAuthorityAssignments).values({ id: `${id}:independent-legal`, organizationId: id, personUserId: legal, authorityRole: "legal", scopes: ["legal-approve"], validFrom: new Date(Date.now() - 60_000), grantorUserId: "fixture-independent-governance", source: "provider-denied-regression-only", governanceDecisionRef: "fixture-reviewed-authority-only" });
  };
  const entry = (employeeId: string, overrides = {}) => ({ sourceReference: randomUUID(), facts: { ...base, employeeId, ...overrides } });
  const row = async (id: number) => (await db.select().from(offbCases).where(eq(offbCases.id, id)))[0];
  const act = async (id: number, action: string, extra: object = {}, who = actor) => actionSeparation(org, who, id, { expectedVersion: (await row(id)).version, action, reference: `fixture:${action}:${randomUUID()}`, ...extra });
  const draft = async () => {
    const p = await savePolicy(org, actor, { expectedVersion: 0, policy });
    await assert.rejects(decidePolicy(org, actor, p.id, p.version, { decision: "approve", reference: "fixture-self-review" }), /independent/);
    await decidePolicy(org, legal, p.id, p.version, { decision: "approve", reference: "fixture-independent-legal" });
    return p;
  };
  const plan = async (id: number, p: { id: string; version: number }, overrides = {}) => {
    await act(id, "screen", { sensitiveTriggers: [] });
    await act(id, "classify", { classification: "human confirmed fixture", confirmed: true, urgency: "Standard", flags, ...overrides });
    await act(id, "adopt-policy", { policyId: p.id, policyVersion: p.version });
  };
  try {
    await createOrg(org); await createOrg(other);
    const same = entry("DUPLICATE");
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => createSeparations(org, actor, same)));
    const id = duplicates[0][0].caseId;
    assert.equal((await db.select({ id: onbCases.id }).from(onbCases).where(and(eq(onbCases.id, id), onboardingCaseCandidateSql()))).length, 0, "onboarding worker candidates exclude separation");
    assert.ok(duplicates.every(r => r[0].caseId === id));
    assert.equal((await db.select().from(offbCases).where(and(eq(offbCases.organizationId, org), eq(offbCases.employeeId, "DUPLICATE")))).length, 1);
    assert.equal((await db.select().from(offbSources).where(eq(offbSources.caseId, id))).length, 1);
    await assert.rejects(createSeparations(org, actor, { ...same, facts: { ...same.facts, department: "Changed" } }), /reference.*different/);
    const conflict = await createSeparations(org, actor, entry("DUPLICATE", { manager: "Different fixture manager" }), "manager-request");
    assert.equal(conflict[0].caseId, id); assert.equal(conflict[0].conflict, true);
    await act(id, "screen", { sensitiveTriggers: [] });
    assert.equal((await row(id)).state.gatewayA, "restricted");
    await assert.rejects(act(id, "classify", { confirmed: true, classification: "cannot bypass", urgency: "Standard", flags }), /Gateway A/);
    await act(id, "hrbp-reconcile", { facts: same.facts });
    const p = await draft();
    await plan(id, p, { flags: { ...flags, clientFacing: true, peopleManager: true } });
    await assert.rejects(separationDetail(other, actor, id), /not found/);
    const restricted = await separationDetail(org, viewer, id);
    assert.equal(restricted.privateFacts, null); assert.deepEqual(restricted.sources, []);
    assert.deepEqual(restricted.state.decisions, []);
    assert.ok(restricted.state.tasks.every(t => t.evidence === null && !Object.keys(t.details).length));
    assert.ok(!(JSON.stringify(await listSeparations(org, actor))).includes(base.exitReason));
    let providerCalled = false;
    await withCaseDispatchGuard(id, async () => { providerCalled = true; });
    assert.equal(providerCalled, false);
    assert.equal(await completeDay1ReadinessGate(id), false);
    await assert.rejects(withCaseDerivedLifecycleWrite({ organizationId: org, caseId: id }, async () => {}), /dedicated separation/);
    for (const action of ["finalize", "close", "archive", "alumni", "rehire-eligibility", "publish-insight"]) await assert.rejects(act(id, action), /section 4.6/);
    await assert.rejects(db.update(onbCases).set({ lifecycleStage: "complete", orchestrationStatus: "done" }).where(eq(onbCases.id, id)), (e: any) => e.cause?.constraint === "onb_separation_envelope_no_completion");
    await assert.rejects(db.update(offbCases).set({ status: "closed" }).where(eq(offbCases.id, id)), (e: any) => e.cause?.constraint === "offb_finalization_unavailable");
    const accessTask = "access-inventory";
    await act(id, "assign", { taskId: accessTask, owner: actor });
    await assert.rejects(act(id, "task-evidence", { taskId: accessTask, simulated: true, provenance: "human-source-attested" }), /Simulated/);
    await assert.rejects(act(id, "task-evidence", { taskId: accessTask, provenance: "mailbox" }), /Simulated/);
    await act(id, "settlement-version", { items: { basePay: 1000, noticeAdjustment: -100, assetRecovery: -50, statutory: 10, equity: 0 }, currency: "USD", rulesReference: "source-attested-fixture-calculation" });
    const details: Record<string, object> = {
      "asset-inventory": { confirmed: true }, "knowledge-risk": { riskPresent: false }, "kt-signoff": { receivingManagerOrSuccessor: "source-attested fixture successor" },
      "kt-access-exception": { exceptionRequired: false }, "asset-recovery": { disposition: "recovery-approved" },
      "payroll-reconciliation": { hrisMatchesPayroll: true, hrisReference: "fixture-hris-human-extract", payrollReference: "fixture-payroll-extract" },
      "payroll-ready": { ready: true }, "access-closure": { sourceConfirmedClosed: true, dependenciesResolved: true },
      "client-access": { sourceConfirmedClosed: true, dependenciesResolved: true },
      "client-communication": { humanAuthored: true, approved: true, contentReference: "fixture-private-content" },
      "privacy-retention": { action: "source-attested-retention" },
    };
    let pending = (await row(id)).state.tasks.map(t => t.id);
    while (pending.length) {
      const current = await row(id);
      const task = current.state.tasks.find(t => pending.includes(t.id) && t.prerequisites.every(p => current.state.tasks.find(x => x.id === p)?.status === "verified"));
      assert.ok(task, "topological evidence path must remain reachable");
      await act(id, "assign", { taskId: task.id, owner: actor });
      await act(id, "task-evidence", { taskId: task.id, provenance: "human-source-attested", details: details[task.id] ?? {} });
      pending = pending.filter(key => key !== task.id);
    }
    assert.equal((await row(id)).status, "closure-preparation");
    const complete = await separationDetail(org, actor, id);
    assert.equal(complete.finalizationAvailable, false); assert.equal(complete.gatewayC, "unavailable");
    assert.ok(complete.state.tasks.every(t => t.status === "verified"));
    assert.ok(complete.history.length > 30);
    // Changing upstream evidence must invalidate prior Payroll/closure readiness.
    await act(id, "task-blocked", { taskId: "asset-return", uncertain: true });
    assert.equal((await row(id)).state.tasks.find(t => t.id === "payroll-ready")?.status, "blocked");
    assert.equal((await row(id)).status, "active");
    const staleVersion = (await row(id)).version;
    const race = await Promise.allSettled([true, false].map(uncertain => actionSeparation(org, actor, id, { action: "task-blocked", taskId: "asset-return", uncertain, expectedVersion: staleVersion, reference: "fixture-version-race" })));
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    await act(id, "pause");
    await assert.rejects(act(id, "task-evidence", { taskId: "access-inventory", provenance: "human-source-attested" }), /paused/);
    await assert.rejects(actionSeparation(org, actor, id, { action: "task-evidence", taskId: "access-inventory", expectedVersion: staleVersion, provenance: "human-source-attested", reference: "fixture-late-callback" }), /changed/);
    await act(id, "hrbp-disposition", { disposition: "resume" });
    assert.equal((await row(id)).status, "held");
    await plan(id, p);
    await decidePolicy(org, legal, p.id, p.version, { decision: "withdraw", reference: "fixture-withdrawal" });
    await assert.rejects(act(id, "assign", { taskId: "access-inventory", owner: actor }), /withdrawn/);
    await act(id, "pause"); await act(id, "hrbp-disposition", { disposition: "convert-to-transfer" });
    assert.equal((await row(id)).activeKey, null);
    await assert.rejects(act(id, "screen", { sensitiveTriggers: [] }), /no longer active/);
    const p2 = await draft();
    const futureId = (await createSeparations(org, actor, entry("FUTURE", { lastWorkingDay: "2035-01-15", terminationDate: "2035-01-15" })))[0].caseId;
    await plan(futureId, p2);
    for (const taskId of ["access-inventory", "shared-accounts", "kt-access-exception", "access-closure"]) {
      await act(futureId, "assign", { taskId, owner: actor });
      if (taskId !== "access-closure") await act(futureId, "task-evidence", { taskId, provenance: "human-source-attested", details: taskId === "kt-access-exception" ? { exceptionRequired: false } : {} });
    }
    await assert.rejects(act(futureId, "task-evidence", { taskId: "access-closure", provenance: "human-source-attested", details: details["access-closure"] }), /not due/);
    const urgentId = (await createSeparations(org, actor, entry("URGENT"), "security-request"))[0].caseId;
    await act(urgentId, "screen", { sensitiveTriggers: ["posh", "death-in-service"] });
    await act(urgentId, "emergency-security-plan", { confirmed: true, details: { policyReference: "fixture-approved-emergency-policy", breakGlassReference: "fixture-independent-security-basis" } });
    await act(urgentId, "assign", { taskId: "emergency-closure", owner: actor });
    await act(urgentId, "task-evidence", { taskId: "emergency-closure", provenance: "human-source-attested", details: { sourceConfirmedClosed: true, dependenciesResolved: true, accessInventoryReference: "fixture-inventory" } });
    await act(urgentId, "assign", { taskId: "emergency-review", owner: legal }, legal);
    await act(urgentId, "task-evidence", { taskId: "emergency-review", provenance: "human-source-attested", details: { reviewCompleted: true, breakGlassReference: "fixture-review" } }, legal);
    await act(urgentId, "screen", { sensitiveTriggers: [] });
    assert.equal((await row(urgentId)).state.gatewayA, "restricted");
    await act(urgentId, "hrbp-reconcile", { facts: { ...base, employeeId: "URGENT" } });
    await act(urgentId, "screen", { sensitiveTriggers: [] });
    await act(urgentId, "classify", { confirmed: true, classification: "Reviewed human-led sensitive pathway", urgency: "Standard", flags });
    for (const taskId of ["ethics-review", "legal-review"]) {
      await act(urgentId, "assign", { taskId, owner: actor });
      await assert.rejects(act(urgentId, "task-evidence", { taskId, provenance: "human-source-attested", details: {} }), /review|disposition/i);
      await act(urgentId, "task-evidence", { taskId, provenance: "human-source-attested", details: { antiRetaliationReviewed: true, noSurpriseReviewed: true, humanLedDispositionReviewed: true, nomineeBenefitsReviewed: true, exitInterviewExcluded: true } });
    }
    const restrictedPolicy = await draft();
    await assert.rejects(act(urgentId, "adopt-policy", { policyId: restrictedPolicy.id, policyVersion: 1 }), /Explicit human-led/);
    await act(urgentId, "adopt-policy", { confirmed: true, policyId: restrictedPolicy.id, policyVersion: 1 });
    assert.equal((await row(urgentId)).state.restrictedManual, true);
    assert.equal((await row(urgentId)).state.gatewayA, "restricted");
    await act(urgentId, "settlement-version", { currency: "USD", items: { basePay: 100 }, rulesReference: "human-reviewed-benefit-calculation" });
    await act(urgentId, "legal-hold");
    await assert.rejects(db.delete(onbCases).where(eq(onbCases.id, urgentId)), (e: any) => e.cause?.code === "23503");
    const ingress = await configureMailbox(org, actor, { allowedSenders: ["fixture-sender@example.test"], reference: "fixture-reviewed-shared-ingress" });
    const providerMessageId = `fixture-message-${randomUUID()}`;
    const missingCountryMessage = `fixture-missing-country-${randomUUID()}`;
    const missingCountryBody = Object.entries({ ...base, employeeId: "MISSING-COUNTRY" }).filter(([k]) => k !== "country").map(([k, v]) => `${k}: ${v}`).join("\n");
    await ingestHroMailboxMessage({ id: missingCountryMessage } as any, "fixture-sender@example.test", `[HRO-INTAKE:${ingress.token}]`, missingCountryBody);
    const missingRequest = (await reviewMailbox(org, actor)).find(r => r.providerMessageId === missingCountryMessage)!;
    assert.equal(missingRequest.status, "collection-review-required");
    assert.deepEqual(missingRequest.fields, {}, "unapproved jurisdiction retains no employee content");
    assert.ok(missingRequest.missingFields.includes("country"));
    await convertMailbox(org, actor, missingRequest.id, { facts: { ...base, employeeId: "MISSING-COUNTRY" }, attachmentsReviewed: true });
    const rawBody = Object.entries({ ...base, employeeId: "MAILBOX" }).map(([k, v]) => `${k}: ${v}`).join("\n");
    await ingestHroMailboxMessage({ id: providerMessageId, payload: { parts: [{ filename: "private-untrusted-fixture.pdf", mimeType: "application/pdf" }] } }, "fixture-sender@example.test", `[HRO-INTAKE:${ingress.token}]`, rawBody);
    await ingestHroMailboxMessage({ id: providerMessageId }, "fixture-sender@example.test", `[HRO-INTAKE:${ingress.token}]`, rawBody);
    const requests = (await reviewMailbox(org, actor)).filter(r => r.providerMessageId === providerMessageId);
    assert.equal(requests.length, 1); assert.equal(requests[0].attachments[0].status, "quarantined-not-imported");
    await assert.rejects(convertMailbox(org, actor, requests[0].id, { facts: { ...base, employeeId: "MAILBOX" } }), /quarantined/);
    const converted = await convertMailbox(org, actor, requests[0].id, { facts: { ...base, employeeId: "MAILBOX" }, attachmentsReviewed: true });
    assert.equal((await row(converted.caseId)).status, "held");
    assert.equal((await convertMailbox(org, actor, requests[0].id, { facts: { ...base, employeeId: "MAILBOX" }, attachmentsReviewed: true })).caseId, converted.caseId);
    await assert.rejects(convertMailbox(org, actor, requests[0].id, { facts: { ...base, employeeId: "MAILBOX", department: "Changed after conversion" }, attachmentsReviewed: true }), /reference.*different/);
    assert.throws(() => extractMailboxFields("employeeId: one\nemployeeId: two"), /Repeated/i);
    const beforeSources = (await db.select().from(offbSources).where(eq(offbSources.organizationId, org))).length;
    await db.update(onbAuthorityAssignments).set({ status: "revoked", revision: 2 }).where(eq(onbAuthorityAssignments.id, `${org}:hr-compliance`));
    await assert.rejects(createSeparations(org, actor, entry("REVOKED")), /verified/);
    assert.equal((await db.select().from(offbSources).where(eq(offbSources.organizationId, org))).length, beforeSources);
  } catch (error) {
    console.error("Offboarding regression failed before teardown:", error);
    throw error;
  } finally {
    for (const id of [org, other]) await deleteTestOrganizations(eq(organizationsTable.id, id), async tx => {
      await tx.delete(hroMailboxRequests).where(eq(hroMailboxRequests.organizationId, id));
      await tx.delete(hroMailboxIngress).where(eq(hroMailboxIngress.organizationId, id));
      await tx.delete(offbCheckpoints).where(eq(offbCheckpoints.organizationId, id));
      await tx.delete(offbSources).where(eq(offbSources.organizationId, id));
      await tx.delete(offbCases).where(eq(offbCases.organizationId, id));
      await tx.delete(offbPolicies).where(eq(offbPolicies.organizationId, id));
      await tx.delete(onbCases).where(eq(onbCases.organizationId, id));
      await tx.delete(onbSystemChecks).where(eq(onbSystemChecks.organizationId, id));
      await tx.delete(onbConnectors).where(eq(onbConnectors.organizationId, id));
      await tx.delete(onbSettings).where(eq(onbSettings.organizationId, id));
      await tx.delete(onbEvents).where(eq(onbEvents.organizationId, id));
      await tx.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, id));
      await tx.delete(onbReadinessSlaPolicies).where(eq(onbReadinessSlaPolicies.organizationId, id));
    });
    await pool.end();
  }
});

test("historical exits are review-only and runtime finalization denials cannot be bypassed by imports", () => {
  assert.equal(isSeparationOrLegacyExit({ hireType: "service-request", processPolicySnapshot: { batchIntake: { templateId: "offboarding-separation" } } }), true);
  assert.equal(isSeparationOrLegacyExit({ hireType: "external-fte" }), false);
});
