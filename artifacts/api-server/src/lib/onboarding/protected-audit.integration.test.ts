import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  onbApprovals,
  onbAuditEntries,
  onbAuditHeads,
  onbAuditLifecycles,
  onbCandidateLinks,
  onbCandidateSessions,
  onbCases,
  organizationsTable,
} from "@workspace/db";
import { appendApprovalDecisionHistory } from "./approval-version";
import {
  appendProtectedAudit,
  appendProtectedAuditInTransaction,
  listProtectedAudit,
  listRetainedApprovalHistory,
  reconcileAbandonedProtectedAuditAttempts,
  verifyProtectedAudit,
  verifyProtectedAuditRows,
} from "./protected-audit";
import { protectedAuditCsv } from "../../routes/onboarding-audit";
import { executeSyntheticReset, type SyntheticResetManifest } from "./synthetic-reset";
import { cleanupCandidateAccess, exchangeToken, hashSecret } from "./candidate-portal";
import { recordGuardrailEvent } from "./guardrails";

const hasDb = Boolean(process.env.DATABASE_URL);
const prefix = `audit-it-${process.pid}-${randomUUID()}`;
const tenants: string[] = [];
const tenant = (name: string) => {
  const id = `${prefix}-${name}`;
  tenants.push(id);
  return id;
};

const input = (organizationId: string, action = "onboarding.case.updated") => ({
  organizationId,
  actorId: "audit-integration-user",
  actorKind: "authenticated" as const,
  actorAuthority: "tenant-membership:admin",
  action,
  outcome: "success" as const,
  objectType: "case",
  objectId: "raw-object-id-must-not-persist",
  caseReference: "raw-case-reference-must-not-persist",
  reviewedRevision: 3,
  source: "integration-test",
  correlationId: "raw-correlation-must-not-persist",
  payload: { safeStatus: "updated", documentBody: "must-not-persist" },
});

describe("protected onboarding audit (isolated real database)", { skip: !hasDb }, () => {
  // Protected audit/history is intentionally append-only. These test tenants
  // remain as immutable evidence rather than deleting the rows after a test.
  after(async () => {
    for (const organizationId of tenants) {
      await db.delete(onbAuditLifecycles).where(eq(onbAuditLifecycles.organizationId, organizationId));
    }
  });

  test("concurrent appends serialize one tenant chain and remain tenant-isolated", async () => {
    const firstTenant = tenant("concurrent-a");
    const secondTenant = tenant("concurrent-b");
    await Promise.all(Array.from({ length: 16 }, (_, index) =>
      appendProtectedAudit(input(firstTenant, `onboarding.case.updated-${index}`)),
    ));
    await appendProtectedAudit(input(secondTenant));

    const first = await listProtectedAudit(firstTenant, { limit: 100 });
    const second = await listProtectedAudit(secondTenant, { limit: 100 });
    assert.deepEqual(first.map((entry) => entry.sequence), Array.from({ length: 16 }, (_, index) => index + 1));
    assert.equal(second.length, 1);
    assert.equal(second[0]?.sequence, 1);
    assert.equal((await verifyProtectedAudit(firstTenant)).status, "verified");
    assert.equal((await verifyProtectedAudit(secondTenant)).status, "verified");

    const observations = await Promise.all([
      ...Array.from({ length: 8 }, (_, index) =>
        appendProtectedAudit(input(firstTenant, `onboarding.case.concurrent-${index}`)),
      ),
      ...Array.from({ length: 8 }, () => verifyProtectedAudit(firstTenant)),
    ]);
    const verificationResults = observations.filter(
      (result): result is Awaited<ReturnType<typeof verifyProtectedAudit>> =>
        "status" in result,
    );
    assert.ok(verificationResults.every(({ status }) => status === "verified"));
  });

  test("ordinary SQL cannot update, delete, or truncate audit evidence", async () => {
    const organizationId = tenant("trigger-protection");
    const entry = await appendProtectedAudit(input(organizationId));
    await assert.rejects(() =>
      db.update(onbAuditEntries).set({ action: "tampered" }).where(eq(onbAuditEntries.id, entry.id)),
    );
    await assert.rejects(() =>
      db.delete(onbAuditEntries).where(eq(onbAuditEntries.id, entry.id)),
    );
    await assert.rejects(() => db.execute(sql`truncate table onb_audit_entries`));
    assert.equal((await verifyProtectedAudit(organizationId)).status, "verified");
  });

  test("integrity verification catches simulated field corruption, reordering, and deletion", async () => {
    const organizationId = tenant("integrity");
    await appendProtectedAudit(input(organizationId, "onboarding.case.created"));
    await appendProtectedAudit(input(organizationId, "onboarding.case.updated"));
    await appendProtectedAudit(input(organizationId, "onboarding.case.approved"));
    const entries = await listProtectedAudit(organizationId, { limit: 100 });
    const [head] = await db.select().from(onbAuditHeads)
      .where(eq(onbAuditHeads.organizationId, organizationId));

    assert.equal(verifyProtectedAuditRows(entries, head).status, "verified");
    assert.equal(verifyProtectedAuditRows(
      entries.map((entry, index) => index === 1 ? { ...entry, action: "tampered" } : entry),
      head,
    ).status, "broken");
    assert.equal(verifyProtectedAuditRows([entries[1]!, entries[0]!, entries[2]!], head).status, "broken");
    assert.equal(verifyProtectedAuditRows(entries.slice(1), head).status, "broken");
  });

  test("CSV export is redacted and spreadsheet-safe", async () => {
    const organizationId = tenant("export");
    await appendProtectedAudit({
      ...input(organizationId),
      actorId: "=FORMULA",
      payload: { safeStatus: "updated", secretValue: "super-secret-export-value" },
    });
    const entries = await listProtectedAudit(organizationId, { limit: 100 });
    const csv = protectedAuditCsv(entries, await verifyProtectedAudit(organizationId));
    assert.doesNotMatch(csv, /payload/i);
    assert.doesNotMatch(csv, /super-secret-export-value|raw-object-id|raw-case-reference|raw-correlation/i);
    assert.match(csv, /"'=FORMULA"/);
  });

  test("approval history survives deletion of its live case and approval", async () => {
    const organizationId = tenant("history-survives");
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Protected audit test tenant",
      slug: organizationId,
      joinCodeHash: `hash-${organizationId}`,
      createdByUserId: "audit-integration-owner",
    });
    const [caseRow] = await db.insert(onbCases).values({
      organizationId, workerName: "Audit history fixture", workerEmail: `${organizationId}@example.invalid`,
      hireType: "new-hire", workerCategory: "employee", role: "Engineer", department: "Engineering",
      geography: "US", legalEntity: "Test Co", managerName: "Manager", recruiterName: "Recruiter",
      joiningDate: "2031-01-01",
    }).returning();
    const [approval] = await db.insert(onbApprovals).values({
      organizationId, caseId: caseRow.id, agent: "audit-history-test", ruleRef: "audit-history-test",
      hitlPattern: "approve-before-act", recommendation: "Proceed", rationale: "Historical fixture",
      resumeAction: "none", idempotencyKey: `${organizationId}:approval`, status: "pending",
    }).returning();
    await db.transaction((tx) => appendApprovalDecisionHistory(
      tx, approval, "approved", "audit-integration-owner", null, new Date(),
    ));
    await db.delete(onbCases).where(and(
      eq(onbCases.organizationId, organizationId),
      eq(onbCases.id, caseRow.id),
    ));
    const history = await listRetainedApprovalHistory(organizationId, approval.id);
    assert.equal(history.length, 1);
  });

  test("an active legal hold prevents synthetic reset before destructive work", async () => {
    const organizationId = tenant("legal-hold");
    await db.insert(onbAuditLifecycles).values({
      organizationId, legalHoldActive: true, legalHoldReason: "integration test",
      legalHoldSetBy: "audit-integration-owner", legalHoldSetAt: new Date(),
    });
    const manifest: SyntheticResetManifest = [{
      organizationId,
      id: 987_654_321,
      expected: { workerName: "No-op protected fixture", scenarioKey: null },
    }];
    const result = await executeSyntheticReset({
      organizationId, actorId: "audit-integration-owner", expectedRevision: "any", manifest,
    });
    assert.equal(result.kind, "conflict");
    const [lifecycle] = await db.select().from(onbAuditLifecycles)
      .where(eq(onbAuditLifecycles.organizationId, organizationId));
    assert.equal(lifecycle.legalHoldActive, true);
  });

  test("an active legal hold also pauses privacy-destructive candidate cleanup", async () => {
    const organizationId = tenant("candidate-cleanup-hold");
    await db.insert(organizationsTable).values({
      id: organizationId, name: "Candidate cleanup hold fixture", slug: organizationId,
      joinCodeHash: `hash-${organizationId}`, createdByUserId: "audit-integration-owner",
    });
    const [caseRow] = await db.insert(onbCases).values({
      organizationId, workerName: "Candidate cleanup fixture", workerEmail: `${organizationId}@example.invalid`,
      hireType: "new-hire", workerCategory: "employee", role: "Engineer", department: "Engineering",
      geography: "US", legalEntity: "Test Co", managerName: "Manager", recruiterName: "Recruiter",
      joiningDate: "2031-01-01",
    }).returning();
    const expired = new Date(Date.now() - 366 * 24 * 60 * 60_000);
    const [link] = await db.insert(onbCandidateLinks).values({
      organizationId, caseId: caseRow.id, tokenHash: hashSecret(`held-link-${organizationId}`),
      expiresAt: expired, issuedBy: "audit-integration-owner",
    }).returning();
    await db.insert(onbCandidateSessions).values({
      idHash: hashSecret(`held-session-${organizationId}`), organizationId, caseId: caseRow.id,
      linkId: link.id, expiresAt: expired,
    });
    await db.insert(onbAuditLifecycles).values({
      organizationId, legalHoldActive: true, legalHoldReason: "integration test",
      legalHoldSetBy: "audit-integration-owner", legalHoldSetAt: new Date(),
    });
    assert.deepEqual(await cleanupCandidateAccess({ organizationId, now: new Date() }), {
      expiredSessions: 0, retainedLinksDeleted: 0,
    });
    const [survivingLink] = await db.select({ id: onbCandidateLinks.id })
      .from(onbCandidateLinks).where(eq(onbCandidateLinks.id, link.id));
    assert.equal(survivingLink.id, link.id);
  });

  test("candidate token exchange records safe pre-attempt and outcome evidence", async () => {
    const organizationId = tenant("candidate-exchange");
    await db.insert(organizationsTable).values({
      id: organizationId, name: "Candidate exchange fixture", slug: organizationId,
      joinCodeHash: `hash-${organizationId}`, createdByUserId: "audit-integration-owner",
    });
    const [caseRow] = await db.insert(onbCases).values({
      organizationId, workerName: "Candidate exchange fixture", workerEmail: `${organizationId}@example.invalid`,
      hireType: "new-hire", workerCategory: "employee", role: "Engineer", department: "Engineering",
      geography: "US", legalEntity: "Test Co", managerName: "Manager", recruiterName: "Recruiter",
      joiningDate: "2031-01-01",
    }).returning();
    const rawToken = `candidate-token-${randomUUID()}`;
    const [link] = await db.insert(onbCandidateLinks).values({
      organizationId, caseId: caseRow.id, tokenHash: hashSecret(rawToken),
      expiresAt: new Date(Date.now() + 60_000), issuedBy: "audit-integration-owner",
    }).returning();
    assert.ok(await exchangeToken(rawToken));
    const entries = await listProtectedAudit(organizationId, { limit: 100 });
    assert.deepEqual(entries.map(({ action, outcome }) => [action, outcome]), [
      ["onboarding.candidate-session.exchange.attempted", "attempted"],
      ["onboarding.candidate-session.exchange.outcome", "success"],
    ]);
    assert.ok(entries.every((entry) =>
      !JSON.stringify(entry).includes(rawToken) && !JSON.stringify(entry).includes(link.tokenHash),
    ));
    assert.equal(
      (await listProtectedAudit(organizationId, { objectId: String(link.id) })).length,
      2,
    );
    assert.equal(
      (await listProtectedAudit(organizationId, { objectId: entries[0].objectId! })).length,
      2,
    );
  });

  test("guardrail activity-feed throttling retains every suppressed protected attempt", async () => {
    const organizationId = tenant("guardrail-throttle");
    await db.insert(organizationsTable).values({
      id: organizationId, name: "Guardrail throttle fixture", slug: organizationId,
      joinCodeHash: `hash-${organizationId}`, createdByUserId: "audit-integration-owner",
    });
    for (let count = 0; count < 25; count += 1) {
      await recordGuardrailEvent({
        organizationId, key: "webhook-signature", action: "rejected",
        detail: "untrusted data deliberately excluded from protected metadata",
      });
    }
    const entries = await listProtectedAudit(organizationId, { limit: 100 });
    assert.equal(entries.length, 25);
    const suppressed = entries.filter((entry) => entry.action === "onboarding.guardrail.suppressed-attempt");
    assert.deepEqual(suppressed.map((entry) => entry.payload.suppressedCount), [1, 2, 3, 4, 5]);
    assert.ok(suppressed.every((entry) => entry.payload.guardrailAction === "rejected"));
  });

  test("crash-window attempts receive a durable recovery-required resolution", async () => {
    const organizationId = tenant("attempt-reconciliation");
    const attempt = await appendProtectedAudit({
      ...input(organizationId, "onboarding.case.update.attempted"),
      outcome: "attempted",
    });
    assert.equal(await reconcileAbandonedProtectedAuditAttempts(organizationId, 0), 1);
    const entries = await listProtectedAudit(organizationId, { limit: 10 });
    assert.equal(entries[1]?.action, "onboarding.audit-outcome.recovery-required");
    assert.equal(entries[1]?.outcome, "failure");
    assert.equal(entries[1]?.correctionOfId, attempt.id);
    assert.equal(entries[1]?.objectId, attempt.objectId);
  });

  test("retention statement and its audit event commit together", async () => {
    const organizationId = tenant("retention");
    await db.transaction(async (tx) => {
      await tx.insert(onbAuditLifecycles).values({
        organizationId, retentionStatement: "Reviewed retention statement",
        reviewedBy: "audit-integration-owner", reviewedAt: new Date(),
      });
      await appendProtectedAuditInTransaction(tx, {
        ...input(organizationId, "onboarding.audit.retention.reviewed"),
        objectType: "audit-lifecycle",
        payload: { statementLength: 28 },
      });
    });
    const [lifecycle] = await db.select().from(onbAuditLifecycles)
      .where(eq(onbAuditLifecycles.organizationId, organizationId));
    assert.equal(lifecycle.retentionStatement, "Reviewed retention statement");
    assert.equal((await verifyProtectedAudit(organizationId)).status, "verified");
  });
});