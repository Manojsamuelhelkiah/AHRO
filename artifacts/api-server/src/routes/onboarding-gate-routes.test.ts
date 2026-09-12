import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbApprovalHistory,
  onbApprovals,
  onbAuthorityAudit,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCases,
  onbConnectors,
  onbDocuments,
  onbEffectJournal,
  onbEvents,
  onbReadinessSlaPolicies,
  onbSystemChecks,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { reopenApprovalInTransaction } from "../lib/onboarding/approval-version";
import { decideApproval } from "../lib/onboarding/approval-decisions";
import { backfillDocumentPacks, documentPackFor } from "../lib/onboarding/documents";
import onboardingRouter from "./onboarding";

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `gateway-route-a-${suffix}`;
const orgB = `gateway-route-b-${suffix}`;
const user = `gateway-route-user-${suffix}`;
const requesterUser = `gateway-route-requester-${suffix}`;
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
  await db.insert(onbAuthorityGovernance).values({
    organizationId: orgA,
    status: "governance-approved",
    approvedByUserId: "test-governance",
    approvedAt: new Date(),
    governanceSource: "test",
    revision: 1,
  });
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgA,
    clerkUserId: user,
    role: "member",
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `gate-a-authority-${suffix}`,
    organizationId: orgA,
    personUserId: user,
    authorityRole: "hr-compliance",
    scopes: ["hr-compliance-approve"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "test-governance",
    source: "test",
    governanceDecisionRef: "GOV-TEST",
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `authority-admin-${suffix}`,
    organizationId: orgA,
    personUserId: user,
    authorityRole: "governance",
    scopes: ["authority-administration"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "test-governance",
    source: "test",
    governanceDecisionRef: "GOV-TEST",
  });
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
  // deterministic intake hard-block below; wait for the claim to release
  // before removing its case-owned rows so a late event cannot race deletion.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await db.select({
      orchestrationStatus: onbCases.orchestrationStatus,
      orchestrationClaimOwner: onbCases.orchestrationClaimOwner,
    }).from(onbCases).where(inArray(onbCases.organizationId, [orgA, orgB]));
    if (!rows.some((row) => row.orchestrationStatus === "running" || row.orchestrationClaimOwner)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (caseIds.length) await db.delete(onbCases).where(inArray(onbCases.id, caseIds));
  // If a route fails before returning its case id (for example while an
  // enrollment service is being rolled out), still remove every fixture case
  // before dropping the temporary organizations.
  await db.delete(onbCases).where(inArray(onbCases.organizationId, [orgA, orgB]));
  await db.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, orgA));
  await db.delete(onbConnectors).where(inArray(onbConnectors.organizationId, [orgA, orgB]));
  // SLA policy rows are organization-scoped without ON DELETE CASCADE;
  // remove them after case-owned snapshots/ledger rows cascade and before the
  // temporary test organizations are dropped.
  await db.delete(onbReadinessSlaPolicies).where(inArray(
    onbReadinessSlaPolicies.organizationId,
    [orgA, orgB],
  ));
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
    // Gate A's durable requestor is deliberately not the specialist that
    // confirms it below.
    createdByUserId: requesterUser,
    joiningDate: "2030-01-01",
    notes: "bgv fixture hard-block",
    offerAcceptanceComplete,
  };
}

test("create refuses an asserted Gate A; dedicated confirmation owns its evidence", async () => {
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
  assert.equal(checked.status, 400);
});

test("legacy document recovery holds, binds the explicit requester, and dispatches only documents after legal approval", async () => {
  const legalUser = `legacy-document-legal-${suffix}`;
  await db.insert(organizationMembershipsTable).values({
    organizationId: orgA, clerkUserId: legalUser, role: "member",
  });
  await db.insert(onbAuthorityAssignments).values({
    id: `legacy-document-legal-authority-${suffix}`,
    organizationId: orgA,
    personUserId: legalUser,
    authorityRole: "legal",
    scopes: ["legal-approve"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "test-governance",
    source: "test",
    governanceDecisionRef: "GOV-TEST",
  });
  const [legacy] = await db.insert(onbCases).values({
    ...intake("Legacy Missing Documents", false),
    organizationId: orgA,
    hireType: "internal-transfer",
    lifecycleStage: "profile-validated",
    orchestrationStatus: "idle",
    createdByUserId: null,
  }).returning();
  caseIds.push(legacy.id);
  const [completed] = await db.insert(onbCases).values({
    ...intake("Completed Missing Documents", false),
    organizationId: orgA,
    hireType: "internal-transfer",
    lifecycleStage: "complete",
    orchestrationStatus: "complete",
    createdByUserId: null,
  }).returning();
  caseIds.push(completed.id);

  // Startup recovery sees the missing legacy pack but cannot invent a
  // requester principal. It must report zero inserted document rows and leave
  // the completed row untouched.
  assert.equal(await backfillDocumentPacks({ organizationId: orgA, caseId: legacy.id }), 0);
  assert.equal((await db.select().from(onbDocuments).where(and(
    eq(onbDocuments.organizationId, orgA), eq(onbDocuments.caseId, legacy.id),
  ))).length, 0);
  assert.equal((await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, orgA), eq(onbApprovals.caseId, legacy.id),
  ))).length, 0);
  assert.equal((await db.select().from(onbDocuments).where(and(
    eq(onbDocuments.organizationId, orgA), eq(onbDocuments.caseId, completed.id),
  ))).length, 0, "completed history is not replayed");
  assert.equal(await backfillDocumentPacks({ organizationId: orgA, caseId: completed.id }), 0);
  const completedRecovery = await call(`/onboarding/cases/${completed.id}/document-recovery`, orgA, {
    method: "POST",
  });
  assert.equal(completedRecovery.status, 409);
  assert.match((await completedRecovery.json() as { message: string }).message, /preserve their history/i);

  const queued = await call(`/onboarding/cases/${legacy.id}/document-recovery`, orgA, {
    method: "POST",
  });
  assert.equal(queued.status, 202);
  const [approval] = await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, orgA),
    eq(onbApprovals.caseId, legacy.id),
    eq(onbApprovals.idempotencyKey, `orchestration:${legacy.id}:approval:execution:documents`),
  ));
  assert.equal(approval.requestedByUserId, user, "the authenticated recovery initiator owns the new request");
  const [preservedCase] = await db.select().from(onbCases).where(eq(onbCases.id, legacy.id));
  assert.equal(preservedCase.createdByUserId, null, "legacy creator provenance remains explicitly unknown");

  const legalDecision = await decideApproval({
    organizationId: orgA,
    approvalId: approval.id,
    expectedVersion: approval.version,
    decision: "approved",
    decidedBy: "untrusted legal display label",
    actorUserId: legalUser,
  });
  assert.equal(legalDecision.outcome, "decided");

  let documents = [] as Array<typeof onbDocuments.$inferSelect>;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    documents = await db.select().from(onbDocuments).where(and(
      eq(onbDocuments.organizationId, orgA), eq(onbDocuments.caseId, legacy.id),
    ));
    if (documents.length) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(documents.length, documentPackFor(legacy).length);
  assert.ok(documents.every((document) => document.status === "pending"));
  assert.equal((await db.select().from(onbSystemChecks).where(and(
    eq(onbSystemChecks.organizationId, orgA), eq(onbSystemChecks.caseId, legacy.id),
  ))).length, 0, "document recovery never opens BGV/IAM/payroll system work");
  const effects = await db.select().from(onbEffectJournal).where(and(
    eq(onbEffectJournal.organizationId, orgA), eq(onbEffectJournal.caseId, legacy.id),
  ));
  assert.equal(effects.length, 1);
  assert.match(effects[0]?.toolName ?? "", /documents/);
  assert.equal(
    await backfillDocumentPacks({ organizationId: orgA, caseId: legacy.id }),
    0,
    "backfill counts only newly inserted documents",
  );
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
    // The confirming HR specialist is `user`; persist a separate requestor
    // principal so Gate A can enforce separation of duties.
    createdByUserId: requesterUser,
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
    method: "POST", headers: { "x-test-role": "member" }, body: JSON.stringify({ decision: "approved", expectedVersion: 1 }),
  });
  assert.equal(readerDecision.status, 403);
  const permissionError = await readerDecision.json() as { message: string };
  assert.match(permissionError.message, /authority is required/i);
  const [unchangedApproval] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval.id));
  assert.equal(unchangedApproval.status, "pending");
  assert.equal(unchangedApproval.version, 1);
  const crossTenant = await call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgB, {
    method: "POST", body: JSON.stringify({ note: "wrong tenant" }),
  });
  assert.equal(crossTenant.status, 404);

  const [first, second] = await Promise.all([
    call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgA, {
      method: "POST", headers: { "x-test-role": "admin" }, body: JSON.stringify({ note: "HR evidence checked", expectedVersion: 1 }),
    }),
    call(`/onboarding/cases/${caseRow.id}/offer-acceptance`, orgA, {
      method: "POST", body: JSON.stringify({ note: "concurrent retry", expectedVersion: 1 }),
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
  const [gateApproval] = await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, orgA),
    eq(onbApprovals.caseId, caseRow.id),
    eq(onbApprovals.idempotencyKey, `gateway-a:${caseRow.id}:human-queue`),
  ));
  assert.equal(gateApproval.status, "approved");
  assert.equal(gateApproval.authorityScope, "hr-compliance-approve");
  assert.equal(gateApproval.decidedAuthorityId, `gate-a-authority-${suffix}`);
  assert.equal(gateApproval.decidedAuthorityRevision, 1);
  assert.equal(gateApproval.decidedBy, user);
  const [history] = await db.select().from(onbApprovalHistory).where(and(
    eq(onbApprovalHistory.organizationId, orgA),
    eq(onbApprovalHistory.approvalId, gateApproval.id),
    eq(onbApprovalHistory.eventType, "decision"),
  ));
  assert.equal(history.decidedBy, user);
  assert.equal((history.snapshot as { decidedAuthorityId?: string }).decidedAuthorityId, `gate-a-authority-${suffix}`);
  assert.equal((history.snapshot as { decidedAuthorityRevision?: number }).decidedAuthorityRevision, 1);
  await db.transaction((tx) => reopenApprovalInTransaction(tx, {
    organizationId: orgA,
    caseId: caseRow.id,
    approvalId: gateApproval.id,
    reason: "Gate A authority-history retention fixture",
    actor: "test",
  }));
  const [historyAfterReopen] = await db.select().from(onbApprovalHistory).where(and(
    eq(onbApprovalHistory.organizationId, orgA),
    eq(onbApprovalHistory.approvalId, gateApproval.id),
    eq(onbApprovalHistory.eventType, "decision"),
  ));
  assert.equal(historyAfterReopen.decidedBy, user);
  assert.equal((historyAfterReopen.snapshot as { decidedAuthorityId?: string }).decidedAuthorityId, `gate-a-authority-${suffix}`);
});

test("Gate A fails closed for a legacy case with no durable requester principal", async () => {
  const [legacyCase] = await db.insert(onbCases).values({
    organizationId: orgA,
    workerName: "Legacy Gate A requester",
    workerEmail: `legacy-gate-a-${suffix}@example.com`,
    channelPreference: "whatsapp",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Test Co",
    managerName: "Manager",
    recruiterName: "Legacy Recruiter",
    // Deliberately model a pre-principal legacy row. Contact/display data
    // cannot become a requester identity for a Gate A approval.
    createdByUserId: null,
    joiningDate: "2030-01-01",
    notes: "legacy requester provenance fixture",
    orchestrationStatus: "waiting-approval",
    orchestrationCheckpoint: "waiting:offer-acceptance",
  }).returning();
  caseIds.push(legacyCase.id);

  const response = await call(`/onboarding/cases/${legacyCase.id}/offer-acceptance`, orgA, {
    method: "POST",
    body: JSON.stringify({ note: "must not authorize legacy requester", expectedVersion: 1 }),
  });
  assert.equal(response.status, 403);
  const [current] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, orgA),
    eq(onbCases.id, legacyCase.id),
  ));
  assert.equal(current.offerAcceptanceComplete, false);
  const [gateApproval] = await db.select().from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, orgA),
    eq(onbApprovals.caseId, legacyCase.id),
    eq(onbApprovals.idempotencyKey, `gateway-a:${legacyCase.id}:human-queue`),
  ));
  assert.equal(gateApproval.status, "pending");
  assert.equal(gateApproval.requestedByUserId, null);
});

test("governance withdrawal is transactional and immediately fails authority closed", async () => {
  const response = await call("/onboarding/authority/governance/withdraw", orgA, {
    method: "POST",
    body: JSON.stringify({ reason: "Emergency authority withdrawal fixture" }),
  });
  assert.equal(response.status, 200);
  const [governance] = await db.select().from(onbAuthorityGovernance).where(
    eq(onbAuthorityGovernance.organizationId, orgA),
  );
  assert.equal(governance.status, "withdrawn");
  assert.equal(governance.revision, 2);
  const [audit] = await db.select().from(onbAuthorityAudit).where(and(
    eq(onbAuthorityAudit.organizationId, orgA),
    eq(onbAuthorityAudit.action, "governance-withdrawn"),
  ));
  assert.ok(audit);
  const assignment = await call("/onboarding/authority/assignments", orgA);
  assert.equal(assignment.status, 403);
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