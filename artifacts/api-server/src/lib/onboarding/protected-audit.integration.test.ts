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
  onbSettings,
  onbCandidateLinks,
  onbCandidateSessions,
  onbCases,
  onbSensitiveLifecyclePolicies,
  organizationsTable,
} from "@workspace/db";
import { appendApprovalDecisionHistory } from "./approval-version";
import {
  appendProtectedAudit,
  appendProtectedAuditInTransaction,
  listProtectedAudit,
  listRetainedApprovalHistory,
  protectedAuditCaseReference,
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
  externalAuditAnchorSafeStatus,
  externalAnchoringStatus,
  legalHoldReasonFingerprint,
  registerExternalAuditAnchorProvider,
  resetExternalAuditAnchorProviderForTests,
  runExternalAuditArchiveDrill,
  runAuditAnchorTick,
  type ExternalAnchorReceipt,
  type ExternalAuditAnchorProvider,
} from "./external-audit-anchor";
import {
  EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY,
  EXTERNAL_AUDIT_ARCHIVE_GENERATION_KEY,
  getExternalAuditArchiveDrills,
  getExternalAuditArchiveSnapshot,
  recordExternalAuditArchiveDrill,
  saveExternalAuditArchiveConfig,
} from "./settings";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";

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

async function configureArchiveProvider(organizationId: string, providerId: string): Promise<void> {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: `Audit integration ${organizationId}`,
    slug: `audit-integration-${organizationId}`,
    joinCodeHash: `audit-integration-join-${organizationId}`,
    createdByUserId: "audit-integration-test",
  }).onConflictDoNothing({ target: organizationsTable.id });
  await db.insert(onbSettings).values({
    organizationId,
    key: EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY,
    value: JSON.stringify({
      providerId,
      archiveNamespace: `${organizationId}:archive`,
      retentionPolicyStatementOrReference: "integration-test policy reference",
      independentAdministratorContact: "integration-admin@example.test",
      independentAdministratorRole: "independent archive administrator",
      credentialSecretReferenceName: `vault:${providerId}`,
    }),
  });
  await db.insert(onbSettings).values({
    organizationId,
    key: EXTERNAL_AUDIT_ARCHIVE_GENERATION_KEY,
    value: "1",
  });
}

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
    await seedApprovedSensitiveLifecyclePolicies(organizationId);
    const [caseRow] = await db.insert(onbCases).values({
      organizationId, workerName: "Audit history fixture", workerEmail: `${organizationId}@example.invalid`,
      hireType: "new-hire", workerCategory: "employee", role: "Engineer", department: "Engineering",
      geography: "US", legalEntity: "Test Co", managerName: "Manager", recruiterName: "Recruiter",
      joiningDate: "2031-01-01", workforceContext: { workCountry: "US" },
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
    await seedApprovedSensitiveLifecyclePolicies(organizationId);
    const [caseRow] = await db.insert(onbCases).values({
      organizationId, workerName: "Candidate cleanup fixture", workerEmail: `${organizationId}@example.invalid`,
      hireType: "new-hire", workerCategory: "employee", role: "Engineer", department: "Engineering",
      geography: "US", legalEntity: "Test Co", managerName: "Manager", recruiterName: "Recruiter",
      joiningDate: "2031-01-01", workforceContext: { workCountry: "US" },
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
    await seedApprovedSensitiveLifecyclePolicies(organizationId);
    const [caseRow] = await db.insert(onbCases).values({
      organizationId, workerName: "Candidate exchange fixture", workerEmail: `${organizationId}@example.invalid`,
      hireType: "new-hire", workerCategory: "employee", role: "Engineer", department: "Engineering",
      geography: "US", legalEntity: "Test Co", managerName: "Manager", recruiterName: "Recruiter",
      joiningDate: "2031-01-01", workforceContext: { workCountry: "US" },
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

  test("demo projection includes authorized case evidence and only the acting user's unscoped events", async () => {
    const organizationId = tenant("demo-projection");
    await appendProtectedAudit({
      ...input(organizationId, "authorized-case"),
      actorId: "demo-administrator",
      caseReference: "case:101",
    });
    await appendProtectedAudit({
      ...input(organizationId, "other-case"),
      actorId: null,
      actorKind: "system",
      caseReference: "case:202",
    });
    await appendProtectedAudit({
      ...input(organizationId, "own-unscoped"),
      actorId: "demo-administrator",
      caseReference: null,
    });
    await appendProtectedAudit({
      ...input(organizationId, "other-unscoped"),
      actorId: "another-demo-user",
      caseReference: null,
    });

    const entries = await listProtectedAudit(organizationId, {
      caseReferences: [protectedAuditCaseReference(101)],
      includeUnscopedActorId: "demo-administrator",
    });
    assert.deepEqual(entries.map((entry) => entry.action), [
      "authorized-case",
      "own-unscoped",
    ]);
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

    let independentReceipt!: ExternalAnchorReceipt;
    let receivedContext: { organizationId: string; archiveNamespace: string; credentialSecretReferenceName: string } | null = null;
    const externalProvider: ExternalAuditAnchorProvider = {
      id: "integration-independent-provider",
      kind: "external",
      independent: true,
      async anchor(operation, context) {
        receivedContext = context;
        independentReceipt = {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
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
      async runRestoreDrill(context) {
        return {
          providerId: this.id,
          organizationId: context.organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
          kind: "restore",
          passed: true,
          proof: "independently-verified-restore-drill",
          issuedAt: new Date().toISOString(),
        };
      },
      async runLegalHoldDrill(context) {
        return {
          providerId: this.id,
          organizationId: context.organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
          kind: "legal_hold",
          passed: true,
          proof: "independently-verified-legal-hold-drill",
          issuedAt: new Date().toISOString(),
        };
      },
      async verifyDrillReceipt(receipt) {
        return receipt.proof.startsWith("independently-verified-");
      },
    };
    await configureArchiveProvider(organizationId, externalProvider.id);
    registerExternalAuditAnchorProvider(externalProvider);
    const reanchored = await runAuditAnchorTick({ organizationId });
    assert.equal(reanchored.delivered, 1);
    assert.deepEqual(receivedContext, {
      organizationId,
      archiveNamespace: `${organizationId}:archive`,
      credentialSecretReferenceName: `vault:${externalProvider.id}`,
      providerId: externalProvider.id,
      configGeneration: 1,
    });
    await runExternalAuditArchiveDrill(organizationId, "restore");
    await runExternalAuditArchiveDrill(organizationId, "legal_hold");
    const receipts = await db.select().from(onbAuditAnchorReceipts).where(eq(
      onbAuditAnchorReceipts.organizationId, organizationId,
    ));
    assert.deepEqual(receipts.map((row) => row.providerKind).sort(), ["external", "simulated"]);
    const outboxKey = queued[0]!.idempotencyKey;
    assert.equal(outboxKey, `${organizationId}:checkpoint:${entry.sequence}:${entry.entryHash}`);
    assert.ok(receipts.every((row) => row.idempotencyKey !== outboxKey));
    assert.ok(receipts.some((row) => row.providerKind === "simulated" && /:g0:ctx[0-9a-f]{32}$/.test(row.idempotencyKey)));
    assert.ok(receipts.some((row) => row.providerKind === "external" && /:g1:ctx[0-9a-f]{32}$/.test(row.idempotencyKey)));
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

  test("an unconfigured tenant never falls back to a registered client adapter", async () => {
    const configuredOrganizationId = tenant("configured-client-adapter");
    const unconfiguredOrganizationId = tenant("unconfigured-client-adapter");
    const calls = {
      anchor: [] as string[],
      fetchCurrentCheckpoint: 0,
      legalHoldDrill: 0,
    };
    const provider: ExternalAuditAnchorProvider = {
      id: "client-adapter-fallback-regression",
      kind: "external",
      independent: true,
      async anchor(operation, context) {
        calls.anchor.push(operation.kind);
        return {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
          ...(operation.kind === "checkpoint"
            ? { checkpointSequence: operation.sequence, checkpointHash: operation.hash }
            : {}),
          ...(operation.kind === "legal_hold" ? { reasonFingerprint: operation.reasonFingerprint } : {}),
          legalHoldActive: operation.legalHoldActive,
          retentionStatementPresent: operation.retentionStatementPresent,
          proof: "must-not-be-used-by-unconfigured-tenant",
          issuedAt: new Date().toISOString(),
        };
      },
      async verifyReceipt() {
        return true;
      },
      async fetchCurrentCheckpoint() {
        calls.fetchCurrentCheckpoint += 1;
        return null;
      },
      async runLegalHoldDrill() {
        calls.legalHoldDrill += 1;
        throw new Error("must not reach an unconfigured tenant");
      },
    };
    await configureArchiveProvider(configuredOrganizationId, provider.id);
    registerExternalAuditAnchorProvider(provider);

    const entry = await appendProtectedAudit(input(
      unconfiguredOrganizationId,
      "onboarding.anchor.unconfigured-regression",
    ));
    await db.transaction((tx) => enqueueAuditLegalHoldInTransaction(tx, {
      organizationId: unconfiguredOrganizationId,
      active: true,
      reasonFingerprint: legalHoldReasonFingerprint("unconfigured regression"),
      retentionStatementPresent: false,
      transitionId: `${unconfiguredOrganizationId}:regression`,
    }));

    // Separate ticks deliver the checkpoint and legal-hold operations in
    // order. Both must use simulation rather than the registered adapter.
    await runAuditAnchorTick({ organizationId: unconfiguredOrganizationId });
    await runAuditAnchorTick({ organizationId: unconfiguredOrganizationId });
    const receipts = await db.select({
      providerKind: onbAuditAnchorReceipts.providerKind,
      receipt: onbAuditAnchorReceipts.receipt,
      checkpointSequence: onbAuditAnchorReceipts.checkpointSequence,
    }).from(onbAuditAnchorReceipts).where(eq(
      onbAuditAnchorReceipts.organizationId,
      unconfiguredOrganizationId,
    ));
    assert.deepEqual(receipts.map(({ providerKind, receipt }) => [providerKind, receipt.operationKind]), [
      ["simulated", "checkpoint"],
      ["simulated", "legal_hold"],
    ]);
    assert.equal(receipts[0]?.checkpointSequence, entry.sequence);

    const safeHealth = await externalAuditAnchorSafeStatus(unconfiguredOrganizationId);
    assert.deepEqual(safeHealth, {
      delivery: "clear",
      providerRead: "not-applicable",
      receiptVerification: "not-applicable",
    });
    const archiveHealth = await externalAnchoringStatus(unconfiguredOrganizationId);
    assert.equal(archiveHealth.providerKind, "simulated");
    assert.equal(archiveHealth.configured, false);
    assert.equal(archiveHealth.regulatedProductionLaunchBlocked, true);
    assert.equal(calls.anchor.length, 0);
    assert.equal(calls.fetchCurrentCheckpoint, 0);
    assert.equal(calls.legalHoldDrill, 0);
  });

  test("same provider is re-anchored after a generation and namespace replacement", async () => {
    const organizationId = tenant("provider-generation-transition");
    await configureArchiveProvider(organizationId, "generation-transition-provider");
    await appendProtectedAudit(input(organizationId, "onboarding.anchor.generation.one"));
    const contexts: string[] = [];
    const providerKeys: string[] = [];
    const cachedReceipts = new Map<string, ExternalAnchorReceipt>();
    let anchorCalls = 0;
    let latestReceipt: ExternalAnchorReceipt | null = null;
    const provider: ExternalAuditAnchorProvider = {
      id: "generation-transition-provider",
      kind: "external",
      independent: true,
      async anchor(operation, context) {
        anchorCalls += 1;
        contexts.push(`${context.configGeneration}:${context.archiveNamespace}`);
        providerKeys.push(operation.idempotencyKey);
        const cached = cachedReceipts.get(operation.idempotencyKey);
        if (cached) return cached;
        const receipt: ExternalAnchorReceipt = {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
          ...(operation.kind === "checkpoint"
            ? { checkpointSequence: operation.sequence, checkpointHash: operation.hash }
            : {}),
          proof: `generation-${context.configGeneration}`,
          issuedAt: new Date().toISOString(),
        };
        cachedReceipts.set(operation.idempotencyKey, receipt);
        latestReceipt = receipt;
        return receipt;
      },
      async verifyReceipt(receipt, _operation, context) {
        return receipt.proof === `generation-${context.configGeneration}`;
      },
      async fetchCurrentCheckpoint(_organizationId, context) {
        return latestReceipt && latestReceipt.proof === `generation-${context.configGeneration}`
          ? latestReceipt
          : null;
      },
    };
    registerExternalAuditAnchorProvider(provider);
    assert.equal((await runAuditAnchorTick({ organizationId })).delivered, 1);
    assert.equal(anchorCalls, 1);

    await saveExternalAuditArchiveConfig(organizationId, {
      providerId: provider.id,
      archiveNamespace: `${organizationId}:archive-b`,
      retentionPolicyStatementOrReference: "generation transition policy reference",
      independentAdministratorContact: "generation-admin@example.test",
      independentAdministratorRole: "independent archive administrator",
      credentialSecretReferenceName: "env:GENERATION_TRANSITION_TOKEN",
    });
    await appendProtectedAudit(input(organizationId, "onboarding.anchor.generation.two"));
    // The first delivered operation is requeued because its explicit receipt
    // generation is stale. The second operation cannot pass it in the same
    // tick, so this call must invoke the same provider under generation 2.
    await runAuditAnchorTick({ organizationId });
    assert.equal(anchorCalls, 2);
    assert.deepEqual(contexts, [
      `1:${organizationId}:archive`,
      `2:${organizationId}:archive-b`,
    ]);
    assert.equal(new Set(providerKeys).size, 2);
    const transitionalStatus = await verifyProtectedAudit(organizationId);
    assert.equal(transitionalStatus.externalAnchoring.comparison, "external-behind");
    assert.equal(transitionalStatus.externalAnchoring.configured, false);
    const receipts = await db.select({
      configGeneration: onbAuditAnchorReceipts.configGeneration,
      providerId: onbAuditAnchorReceipts.providerId,
    }).from(onbAuditAnchorReceipts).where(eq(onbAuditAnchorReceipts.organizationId, organizationId));
    assert.deepEqual(receipts.map((row) => row.configGeneration), [1, 2]);
    assert.ok(receipts.every((row) => row.providerId === provider.id));
    resetExternalAuditAnchorProviderForTests();
  });

  test("configured but unregistered providers never fall back to simulation", async () => {
    const organizationId = tenant("missing-provider-adapter");
    await configureArchiveProvider(organizationId, "missing-provider-adapter");
    await appendProtectedAudit(input(organizationId, "onboarding.anchor.missing-provider"));
    resetExternalAuditAnchorProviderForTests();
    const tick = await runAuditAnchorTick({ organizationId });
    assert.equal(tick.delivered, 0);
    const [row] = await db.select({
      status: onbAuditAnchorOutbox.status,
      lastError: onbAuditAnchorOutbox.lastError,
    }).from(onbAuditAnchorOutbox).where(eq(onbAuditAnchorOutbox.organizationId, organizationId));
    assert.equal(row.status, "failed");
    assert.match(row.lastError ?? "", /^missing-provider-adapter:missing-provider-adapter$/);
    const status = await verifyProtectedAudit(organizationId);
    assert.equal(status.externalAnchoring.providerKind, "unavailable");
    assert.equal(status.externalAnchoring.configured, false);
    assert.match(status.externalAnchoring.limitation, /not registered/);
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
    await configureArchiveProvider(organizationId, hangingProvider.id);
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
      async anchor(operation, context) {
        anchorStarted();
        await gate;
        return {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
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
    await configureArchiveProvider(fenceOrganizationId, delayedProvider.id);
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

  test("locally rewritten drill receipts remain blocked without provider verification", async () => {
    const organizationId = tenant("anchor-unverifiable-drill");
    const entry = await appendProtectedAudit(input(organizationId, "onboarding.anchor.drill"));
    const provider: ExternalAuditAnchorProvider = {
      id: "unverifiable-drill-provider",
      kind: "external",
      independent: true,
      async anchor(operation, context) {
        return {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
          ...(operation.kind === "checkpoint"
            ? { checkpointSequence: operation.sequence, checkpointHash: operation.hash }
            : {}),
          legalHoldActive: operation.legalHoldActive,
          retentionStatementPresent: operation.retentionStatementPresent,
          ...(operation.kind === "legal_hold" ? { reasonFingerprint: operation.reasonFingerprint } : {}),
          proof: "valid-anchor-proof",
          issuedAt: new Date().toISOString(),
        };
      },
      async verifyReceipt(receipt) {
        return receipt.proof === "valid-anchor-proof";
      },
      async fetchCurrentCheckpoint(_organizationId, context) {
        return {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: "checkpoint",
          idempotencyKey: `${organizationId}:checkpoint:${entry.sequence}:${entry.entryHash}`,
          organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
          checkpointSequence: entry.sequence,
          checkpointHash: entry.entryHash,
          legalHoldActive: false,
          retentionStatementPresent: false,
          proof: "valid-anchor-proof",
          issuedAt: new Date().toISOString(),
        };
      },
      async verifyDrillReceipt() {
        return false;
      },
    };
    await configureArchiveProvider(organizationId, provider.id);
    registerExternalAuditAnchorProvider(provider);
    await runAuditAnchorTick({ organizationId });
    const archiveNamespace = `${organizationId}:archive`;
    await db.insert(onbSettings).values({
      organizationId,
      key: "external_audit_archive_drills",
      value: JSON.stringify([
        {
          kind: "restore",
          providerId: provider.id,
          configGeneration: 1,
          receipt: {
            providerId: provider.id,
            organizationId,
            configGeneration: 1,
            archiveNamespace,
            kind: "restore",
            passed: true,
            proof: "forged-local-success",
            issuedAt: new Date().toISOString(),
          },
          recordedAt: new Date().toISOString(),
        },
        {
          kind: "legal_hold",
          providerId: provider.id,
          configGeneration: 1,
          receipt: {
            providerId: provider.id,
            organizationId,
            configGeneration: 1,
            archiveNamespace,
            kind: "legal_hold",
            passed: true,
            proof: "forged-local-success",
            issuedAt: new Date().toISOString(),
          },
          recordedAt: new Date().toISOString(),
        },
      ]),
    });
    const integrity = await verifyProtectedAudit(organizationId);
    assert.equal(integrity.externalAnchoring.restoreDrillPassed, false);
    assert.equal(integrity.externalAnchoring.legalHoldDrillPassed, false);
    assert.equal(integrity.externalAnchoring.regulatedProductionLaunchBlocked, true);
    resetExternalAuditAnchorProviderForTests();
  });

  test("archive replacement fences simultaneous drill recording and clears old evidence", async () => {
    const organizationId = tenant("archive-generation-race");
    await configureArchiveProvider(organizationId, "generation-race-provider");
    const oldDrill = {
      kind: "restore" as const,
      providerId: "generation-race-provider",
      configGeneration: 1,
      receipt: {
        providerId: "generation-race-provider",
        organizationId,
        configGeneration: 1,
        archiveNamespace: `${organizationId}:archive`,
        kind: "restore" as const,
        passed: true as const,
        proof: "provider-signed-proof",
        issuedAt: new Date().toISOString(),
      },
      recordedAt: new Date().toISOString(),
    };
    const [, replacement] = await Promise.allSettled([
      recordExternalAuditArchiveDrill(organizationId, oldDrill),
      saveExternalAuditArchiveConfig(organizationId, {
        providerId: "replacement-provider",
        archiveNamespace: `${organizationId}:replacement`,
        retentionPolicyStatementOrReference: "replacement policy reference",
        independentAdministratorContact: "replacement-admin@example.test",
        independentAdministratorRole: "independent archive administrator",
        credentialSecretReferenceName: "vault:replacement/provider",
      }),
    ]);
    assert.equal(replacement.status, "fulfilled");
    const snapshot = await getExternalAuditArchiveSnapshot(organizationId);
    assert.equal(snapshot.generation, 2);
    assert.equal(snapshot.config?.providerId, "replacement-provider");
    assert.deepEqual(await getExternalAuditArchiveDrills(organizationId), []);
  });

  test("restore status fences an audit-head append that races provider verification", async () => {
    const organizationId = tenant("stale-head-race");
    const entry = await appendProtectedAudit(input(organizationId, "onboarding.anchor.race.initial"));
    await configureArchiveProvider(organizationId, "stale-head-provider");
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider: ExternalAuditAnchorProvider = {
      id: "stale-head-provider",
      kind: "external",
      independent: true,
      async anchor(operation, context) {
        return {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
          ...(operation.kind === "checkpoint"
            ? { checkpointSequence: operation.sequence, checkpointHash: operation.hash }
            : {}),
          proof: "stale-head-proof",
          issuedAt: new Date().toISOString(),
        };
      },
      async verifyReceipt(receipt) {
        return receipt.proof === "stale-head-proof";
      },
      async fetchCurrentCheckpoint(_organizationId, context) {
        started();
        await gate;
        return {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: "checkpoint",
          idempotencyKey: `${organizationId}:checkpoint:${entry.sequence}:${entry.entryHash}`,
          organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
          checkpointSequence: entry.sequence,
          checkpointHash: entry.entryHash,
          proof: "stale-head-proof",
          issuedAt: new Date().toISOString(),
        };
      },
    };
    registerExternalAuditAnchorProvider(provider);
    const statusPromise = verifyProtectedAudit(organizationId);
    await startedPromise;
    await appendProtectedAudit(input(organizationId, "onboarding.anchor.race.concurrent"));
    release();
    const status = await statusPromise;
    assert.equal(status.externalAnchoring.staleSnapshot, true);
    assert.equal(status.externalAnchoring.regulatedProductionLaunchBlocked, true);
    resetExternalAuditAnchorProviderForTests();
  });

  test("archive replacement waits for provider dispatch lock before changing context", async () => {
    const organizationId = tenant("provider-context-race");
    await appendProtectedAudit(input(organizationId, "onboarding.anchor.context-race"));
    await configureArchiveProvider(organizationId, "context-race-provider");
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider: ExternalAuditAnchorProvider = {
      id: "context-race-provider",
      kind: "external",
      independent: true,
      async anchor(operation, context) {
        started();
        await gate;
        return {
          receiptVersion: 1,
          providerId: this.id,
          providerKind: this.kind,
          operationKind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          organizationId: operation.organizationId,
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
          ...(operation.kind === "checkpoint"
            ? { checkpointSequence: operation.sequence, checkpointHash: operation.hash }
            : {}),
          proof: "context-race-proof",
          issuedAt: new Date().toISOString(),
        };
      },
      async verifyReceipt(receipt) {
        return receipt.proof === "context-race-proof";
      },
      async fetchCurrentCheckpoint() {
        return null;
      },
    };
    registerExternalAuditAnchorProvider(provider);
    const tickPromise = runAuditAnchorTick({ organizationId });
    await startedPromise;
    const replacementPromise = saveExternalAuditArchiveConfig(organizationId, {
      providerId: "replacement-context-provider",
      archiveNamespace: `${organizationId}:replacement`,
      retentionPolicyStatementOrReference: "replacement policy reference",
      independentAdministratorContact: "replacement-admin@example.test",
      independentAdministratorRole: "independent archive administrator",
      credentialSecretReferenceName: "env:REPLACEMENT_AUDIT_TOKEN",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const [tick] = await Promise.all([tickPromise, replacementPromise]);
    assert.equal(tick.delivered, 1);
    const [row] = await db.select({ status: onbAuditAnchorOutbox.status }).from(onbAuditAnchorOutbox)
      .where(eq(onbAuditAnchorOutbox.organizationId, organizationId));
    assert.equal(row.status, "delivered");
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
      async anchor(operation, context) {
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
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
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
    await configureArchiveProvider(organizationId, provider.id);
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
      async anchor(operation, context) {
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
          configGeneration: context.configGeneration,
          archiveNamespace: context.archiveNamespace,
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
    await configureArchiveProvider(organizationId, provider.id);
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