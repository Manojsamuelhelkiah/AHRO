import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { and, eq, or, sql } from "drizzle-orm";
import {
  db,
  onbApprovals,
  onbAuditEntries,
  onbAuditHeads,
  onbAuditLifecycles,
  onbAuditAnchorOutbox,
  onbAuditAnchorReceipts,
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
import {
  enqueueAuditLegalHoldInTransaction,
  legalHoldReasonFingerprint,
  registerExternalAuditAnchorProvider,
  resetExternalAuditAnchorProviderForTests,
  runAuditAnchorTick,
  type ExternalAnchorReceipt,
  type ExternalAuditAnchorProvider,
} from "./external-audit-anchor";

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

  test("checkpoint delivery is durable, idempotent, and simulation never configures external protection", async () => {
    resetExternalAuditAnchorProviderForTests();
    const organizationId = tenant("anchor-outbox");
    const entry = await appendProtectedAudit(input(organizationId, "onboarding.anchor.fixture"));
    const queued = await db.select().from(onbAuditAnchorOutbox).where(eq(
      onbAuditAnchorOutbox.organizationId, organizationId,
    ));
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.checkpointSequence, entry.sequence);
    assert.equal(queued[0]?.status, "pending");

    const first = await runAuditAnchorTick({ organizationId });
    assert.equal(first.delivered, 1);
    const second = await runAuditAnchorTick({ organizationId });
    assert.equal(second.delivered, 0);
    const [receipt] = await db.select().from(onbAuditAnchorReceipts).where(eq(
      onbAuditAnchorReceipts.organizationId, organizationId,
    ));
    assert.equal(receipt.providerKind, "simulated");
    assert.equal(receipt.verifiedAt instanceof Date, true);
    await assert.rejects(() => db.update(onbAuditAnchorReceipts)
      .set({ providerId: "tampered" })
      .where(eq(onbAuditAnchorReceipts.id, receipt.id)));
    const integrity = await verifyProtectedAudit(organizationId);
    assert.equal(integrity.externalAnchoring.configured, false);
    assert.equal(integrity.externalAnchoring.regulatedProductionLaunchBlocked, true);

    let independentReceipt: ExternalAnchorReceipt | null = null;
    const externalProvider: ExternalAuditAnchorProvider = {
      id: "integration-independent-provider",
      kind: "external",
      independent: true,
      async anchor(operation) {
        independentReceipt = {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          ...(operation.kind === "checkpoint"
            ? { checkpointSequence: operation.sequence, checkpointHash: operation.hash }
            : {}),
          legalHoldActive: operation.legalHoldActive,
          retentionStatementPresent: operation.retentionStatementPresent,
          ...(operation.kind === "legal_hold" ? { reasonFingerprint: operation.reasonFingerprint } : {}),
          proof: "independently-verified-fixture",
          issuedAt: new Date().toISOString(),
        };
        return independentReceipt;
      },
      async verifyReceipt(receipt) {
        return receipt.proof === "independently-verified-fixture";
      },
      async fetchCurrentCheckpoint() {
        return independentReceipt;
      },
    };
    registerExternalAuditAnchorProvider(externalProvider);
    const reanchored = await runAuditAnchorTick({ organizationId });
    assert.equal(reanchored.delivered, 1);
    const receipts = await db.select().from(onbAuditAnchorReceipts).where(eq(
      onbAuditAnchorReceipts.organizationId, organizationId,
    ));
    assert.deepEqual(receipts.map((row) => row.providerKind).sort(), ["external", "simulated"]);
    const configured = await verifyProtectedAudit(organizationId);
    assert.equal(configured.externalAnchoring.configured, true);
    assert.equal(configured.externalAnchoring.comparison, "match");
    assert.equal(configured.externalAnchoring.regulatedProductionLaunchBlocked, false);
    const originalReceipt = independentReceipt!;
    independentReceipt = {
      ...originalReceipt,
      idempotencyKey: `${organizationId}:checkpoint:rollback-ahead`,
      checkpointSequence: originalReceipt.checkpointSequence! + 1,
      checkpointHash: "provider-ahead-hash",
    };
    const ahead = await verifyProtectedAudit(organizationId);
    assert.equal(ahead.externalAnchoring.comparison, "external-ahead");
    assert.equal(ahead.externalAnchoring.regulatedProductionLaunchBlocked, true);
    independentReceipt = {
      ...originalReceipt,
      idempotencyKey: `${organizationId}:checkpoint:mismatch`,
      checkpointHash: "provider-mismatch-hash",
    };
    const mismatch = await verifyProtectedAudit(organizationId);
    assert.equal(mismatch.externalAnchoring.comparison, "mismatch");
    assert.equal(mismatch.externalAnchoring.regulatedProductionLaunchBlocked, true);
    resetExternalAuditAnchorProviderForTests();
  });

  test("provider timeout and stale worker completion remain retryable and fenced", async () => {
    const organizationId = tenant("anchor-timeout-fence");
    await appendProtectedAudit(input(organizationId, "onboarding.anchor.timeout"));
    const hangingProvider: ExternalAuditAnchorProvider = {
      id: "hanging-independent-provider",
      kind: "external",
      independent: true,
      timeoutMs: 5,
      async anchor() {
        return await new Promise<never>(() => {});
      },
      async verifyReceipt() {
        return false;
      },
      async fetchCurrentCheckpoint() {
        return null;
      },
    };
    registerExternalAuditAnchorProvider(hangingProvider);
    const timedOut = await runAuditAnchorTick({ organizationId });
    assert.equal(timedOut.failed, 1);
    const [failedOutbox] = await db.select().from(onbAuditAnchorOutbox).where(eq(
      onbAuditAnchorOutbox.organizationId, organizationId,
    ));
    assert.equal(failedOutbox.status, "failed");
    resetExternalAuditAnchorProviderForTests();

    const fenceOrganizationId = tenant("anchor-fence");
    await appendProtectedAudit(input(fenceOrganizationId, "onboarding.anchor.fence"));
    let anchorStarted!: () => void;
    const started = new Promise<void>((resolve) => (anchorStarted = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const delayedProvider: ExternalAuditAnchorProvider = {
      id: "delayed-independent-provider",
      kind: "external",
      independent: true,
      async anchor(operation) {
        anchorStarted();
        await gate;
        return {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          ...(operation.kind === "checkpoint"
            ? { checkpointSequence: operation.sequence, checkpointHash: operation.hash }
            : {}),
          legalHoldActive: operation.legalHoldActive,
          retentionStatementPresent: operation.retentionStatementPresent,
          ...(operation.kind === "legal_hold" ? { reasonFingerprint: operation.reasonFingerprint } : {}),
          proof: "delayed-proof",
          issuedAt: new Date().toISOString(),
        };
      },
      async verifyReceipt(receipt) {
        return receipt.proof === "delayed-proof";
      },
      async fetchCurrentCheckpoint() {
        return null;
      },
    };
    registerExternalAuditAnchorProvider(delayedProvider);
    const tick = runAuditAnchorTick({ organizationId: fenceOrganizationId });
    await started;
    const [sending] = await db.select().from(onbAuditAnchorOutbox).where(eq(
      onbAuditAnchorOutbox.organizationId, fenceOrganizationId,
    ));
    await db.update(onbAuditAnchorOutbox).set({
      attempts: sending.attempts + 1,
    }).where(eq(onbAuditAnchorOutbox.id, sending.id));
    release();
    const fenced = await tick;
    assert.equal(fenced.delivered, 0);
    const [stillClaimed] = await db.select().from(onbAuditAnchorOutbox).where(eq(
      onbAuditAnchorOutbox.id, sending.id,
    ));
    assert.equal(stillClaimed.status, "sending");
    resetExternalAuditAnchorProviderForTests();
  });

  test("two workers cannot send a later checkpoint before an older delayed row", async () => {
    const organizationId = tenant("anchor-ordered-checkpoints");
    await appendProtectedAudit(input(organizationId, "onboarding.anchor.ordered.first"));
    await appendProtectedAudit(input(organizationId, "onboarding.anchor.ordered.second"));
    const calls: number[] = [];
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let current: ExternalAnchorReceipt | null = null;
    const provider: ExternalAuditAnchorProvider = {
      id: "ordered-checkpoint-provider",
      kind: "external",
      independent: true,
      async anchor(operation) {
        const sequence = operation.kind === "checkpoint" ? operation.sequence : -1;
        calls.push(sequence);
        if (sequence === 1) {
          firstStarted();
          await gate;
        }
        current = {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          ...(operation.kind === "checkpoint"
            ? { checkpointSequence: operation.sequence, checkpointHash: operation.hash }
            : {}),
          legalHoldActive: operation.legalHoldActive,
          retentionStatementPresent: operation.retentionStatementPresent,
          ...(operation.kind === "legal_hold" ? { reasonFingerprint: operation.reasonFingerprint } : {}),
          proof: "ordered-checkpoint-proof",
          issuedAt: new Date().toISOString(),
        };
        return current;
      },
      async verifyReceipt(receipt) {
        return receipt.proof === "ordered-checkpoint-proof";
      },
      async fetchCurrentCheckpoint() {
        return current;
      },
    };
    registerExternalAuditAnchorProvider(provider);
    const firstWorker = runAuditAnchorTick({ organizationId });
    await started;
    const secondWorker = runAuditAnchorTick({ organizationId });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(calls, [1]);
    const beforeRelease = await db.select({
      id: onbAuditAnchorOutbox.id,
      status: onbAuditAnchorOutbox.status,
    }).from(onbAuditAnchorOutbox).where(eq(onbAuditAnchorOutbox.organizationId, organizationId));
    assert.equal(beforeRelease.filter((row) => row.status === "pending").length, 1);
    release();
    await Promise.all([firstWorker, secondWorker]);
    await runAuditAnchorTick({ organizationId });
    assert.deepEqual(calls, [1, 2]);
    assert.ok(current);
    assert.equal((current as ExternalAnchorReceipt).checkpointSequence, 2);
    const rows = await db.select({
      id: onbAuditAnchorOutbox.id,
      status: onbAuditAnchorOutbox.status,
    }).from(onbAuditAnchorOutbox).where(eq(onbAuditAnchorOutbox.organizationId, organizationId));
    assert.ok(rows.every((row) => row.status === "delivered"));
    resetExternalAuditAnchorProviderForTests();
  });

  test("two workers cannot send a later legal-hold transition before an older delayed row", async () => {
    const organizationId = tenant("anchor-ordered-holds");
    await db.transaction(async (tx) => {
      await enqueueAuditLegalHoldInTransaction(tx, {
        organizationId,
        active: true,
        reasonFingerprint: legalHoldReasonFingerprint("ordered hold"),
        retentionStatementPresent: false,
        transitionId: "1",
      });
      await enqueueAuditLegalHoldInTransaction(tx, {
        organizationId,
        active: false,
        reasonFingerprint: legalHoldReasonFingerprint("ordered hold"),
        retentionStatementPresent: false,
        transitionId: "2",
      });
    });
    const calls: boolean[] = [];
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let currentHold: boolean | null = null;
    const provider: ExternalAuditAnchorProvider = {
      id: "ordered-hold-provider",
      kind: "external",
      independent: true,
      async anchor(operation) {
        if (operation.kind !== "legal_hold") throw new Error("expected legal-hold operation");
        calls.push(operation.legalHoldActive);
        if (calls.length === 1) {
          firstStarted();
          await gate;
        }
        currentHold = operation.legalHoldActive;
        return {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          legalHoldActive: operation.legalHoldActive,
          retentionStatementPresent: operation.retentionStatementPresent,
          reasonFingerprint: operation.reasonFingerprint,
          proof: "ordered-hold-proof",
          issuedAt: new Date().toISOString(),
        };
      },
      async verifyReceipt(receipt) {
        return receipt.proof === "ordered-hold-proof";
      },
      async fetchCurrentCheckpoint() {
        return null;
      },
    };
    registerExternalAuditAnchorProvider(provider);
    const firstWorker = runAuditAnchorTick({ organizationId });
    await started;
    const secondWorker = runAuditAnchorTick({ organizationId });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(calls, [true]);
    release();
    await Promise.all([firstWorker, secondWorker]);
    await runAuditAnchorTick({ organizationId });
    assert.deepEqual(calls, [true, false]);
    assert.equal(currentHold, false);
    const rows = await db.select({ status: onbAuditAnchorOutbox.status })
      .from(onbAuditAnchorOutbox).where(eq(onbAuditAnchorOutbox.organizationId, organizationId));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === "delivered"));
    resetExternalAuditAnchorProviderForTests();
  });

  test("a due formerly backed-off head is selected before 26 later due rows", async () => {
    resetExternalAuditAnchorProviderForTests();
    const organizationId = tenant("anchor-head-before-batch");
    const firstEntry = await appendProtectedAudit(input(organizationId, "onboarding.anchor.backed-off-head"));
    const [headRow] = await db.select().from(onbAuditAnchorOutbox).where(and(
      eq(onbAuditAnchorOutbox.organizationId, organizationId),
      eq(onbAuditAnchorOutbox.checkpointSequence, firstEntry.sequence),
    ));
    assert.ok(headRow);
    await db.update(onbAuditAnchorOutbox).set({
      status: "failed",
      nextAttemptAt: new Date(Date.now() + 60_000),
      lastError: "temporarily backed off",
    }).where(eq(onbAuditAnchorOutbox.id, headRow.id));
    for (let index = 0; index < 26; index += 1) {
      await appendProtectedAudit(input(organizationId, `onboarding.anchor.later-${index}`));
    }
    await db.update(onbAuditAnchorOutbox).set({
      nextAttemptAt: new Date(),
    }).where(eq(onbAuditAnchorOutbox.id, headRow.id));

    const firstTick = await runAuditAnchorTick({ organizationId });
    assert.equal(firstTick.delivered, 1);
    const [deliveredHead] = await db.select({
      status: onbAuditAnchorOutbox.status,
    }).from(onbAuditAnchorOutbox).where(eq(onbAuditAnchorOutbox.id, headRow.id));
    assert.equal(deliveredHead.status, "delivered");
    const remainingAfterHead = await db.select({ id: onbAuditAnchorOutbox.id })
      .from(onbAuditAnchorOutbox).where(and(
        eq(onbAuditAnchorOutbox.organizationId, organizationId),
        or(
          eq(onbAuditAnchorOutbox.status, "pending"),
          eq(onbAuditAnchorOutbox.status, "failed"),
          eq(onbAuditAnchorOutbox.status, "sending"),
        ),
      ));
    assert.equal(remainingAfterHead.length, 26);

    let subsequentlyDelivered = 0;
    for (let index = 0; index < 26; index += 1) {
      subsequentlyDelivered += (await runAuditAnchorTick({ organizationId })).delivered;
    }
    assert.equal(subsequentlyDelivered, 26);
    const finalRows = await db.select({ status: onbAuditAnchorOutbox.status })
      .from(onbAuditAnchorOutbox).where(eq(onbAuditAnchorOutbox.organizationId, organizationId));
    assert.equal(finalRows.length, 27);
    assert.ok(finalRows.every((row) => row.status === "delivered"));
  });

  test("same-reason legal-hold transitions receive distinct durable identities", async () => {
    const organizationId = tenant("anchor-hold-transition");
    for (const [index, active] of [true, false, true].entries()) {
      await db.transaction(async (tx) => {
        await tx.insert(onbAuditLifecycles).values({
          organizationId,
          legalHoldActive: active,
          legalHoldReason: active ? "same reason" : null,
          legalHoldSetBy: "anchor-integration",
          legalHoldSetAt: new Date(),
        }).onConflictDoUpdate({
          target: onbAuditLifecycles.organizationId,
          set: { legalHoldActive: active, updatedAt: new Date() },
        });
        const entry = await appendProtectedAuditInTransaction(tx, {
          ...input(organizationId, `onboarding.audit.legal-hold.${index}`),
          objectType: "audit-lifecycle",
        });
        await enqueueAuditLegalHoldInTransaction(tx, {
          organizationId,
          active,
          reasonFingerprint: legalHoldReasonFingerprint("same reason"),
          retentionStatementPresent: false,
          transitionId: String(entry.sequence),
        });
      });
    }
    const holdRows = await db.select().from(onbAuditAnchorOutbox).where(and(
      eq(onbAuditAnchorOutbox.organizationId, organizationId),
      eq(onbAuditAnchorOutbox.kind, "legal_hold"),
    ));
    assert.equal(holdRows.length, 3);
    assert.equal(new Set(holdRows.map((row) => row.idempotencyKey)).size, 3);
  });
});