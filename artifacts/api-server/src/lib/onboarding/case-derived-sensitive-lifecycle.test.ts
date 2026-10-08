import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbApprovals,
  onbApprovalHistory,
  onbAuditEntries,
  onbCandidateUploads,
  onbCases,
  onbDocuments,
  onbEvents,
  onbSensitiveLifecycleDeletionJobs,
  onbSensitiveLifecyclePolicies,
  onbSensitiveLifecycleScanCursors,
  onbSensitiveObjectManifests,
  onbSettings,
  onbSystemChecks,
  organizationsTable,
} from "@workspace/db";
import { objectStorageClient } from "../objectStorage";
import { appendProtectedAuditInTransaction } from "./protected-audit";
import {
  SENSITIVE_DATA_CLASSES,
  evaluateSensitiveLifecycleGate,
  runSensitiveLifecycleDeletionWorker,
  withCaseDerivedLifecycleWrite,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

const organizationId = `case-envelope-lifecycle-${randomUUID()}`;
const old = new Date(Date.now() - 3 * 86_400_000);

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId, name: "Case envelope lifecycle tests", slug: organizationId,
    joinCodeHash: `hash-${organizationId}`, createdByUserId: "test-creator",
  });
});

after(async () => {
  await db.delete(onbSensitiveLifecycleScanCursors).where(eq(onbSensitiveLifecycleScanCursors.organizationId, organizationId));
  await db.delete(onbCandidateUploads).where(eq(onbCandidateUploads.organizationId, organizationId));
  await db.delete(onbSensitiveObjectManifests).where(eq(onbSensitiveObjectManifests.organizationId, organizationId));
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, organizationId));
  await db.delete(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.organizationId, organizationId));
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
  await db.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
  await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
});

test("a real sensitive collection gate rejects an exact policy when mixed-envelope classes remain unapproved", async () => {
  await db.insert(onbSensitiveLifecyclePolicies).values({
    organizationId, dataClass: "candidate-document", jurisdiction: "GB", revision: 1,
    purpose: "Document intake", lawfulBasis: "Approved basis", retentionDays: 30,
    providerSharingApproved: false, policyReference: "candidate-document-only",
    approvalReference: "candidate-document-only", approvedByUserId: "test-privacy-authority",
    approvedAuthorityAssignmentId: 1,
  });
  const gate = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: false,
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /missing for/i);
  await db.delete(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-document"),
  ));
});

test("an all-class fenced case envelope minimises medical and BGV originals while preserving case status and protected audit", async () => {
  const [caseRow] = await db.insert(onbCases).values({
    organizationId,
    workerName: "Medical BGV Candidate",
    workerEmail: "medical-bgv@example.test",
    workerPhone: "+441234567890",
    hireType: "employee", workerCategory: "employee", role: "Engineer", department: "Engineering",
    geography: "GB", legalEntity: "Employer Ltd", managerName: "Manager Name", recruiterName: "Recruiter Name",
    joiningDate: "2030-01-01", lifecycleStage: "workstreams-running", orchestrationStatus: "paused",
    workforceContext: { workCountry: "GB", accessibilityNeed: "medical accommodation" } as any,
    readiness: [{ label: "Medical clearance", detail: "health restriction" }] as any,
    workstreams: [{ label: "BGV", detail: "criminal screening narrative" }] as any,
    planSummary: "medical support plan", notes: "BGV candidate notes", createdAt: old, updatedAt: old,
  }).returning();
  assert.ok(caseRow);
  const [documentRow] = await db.insert(onbDocuments).values({
    organizationId, caseId: caseRow.id, key: "medical-bgv-file",
    label: "Medical and BGV evidence file", category: "identity", note: "medical restriction and BGV details", updatedAt: old,
  }).returning({ id: onbDocuments.id });
  const objectPath = `/objects/test-bucket/${organizationId}/medical-bgv-evidence.pdf`;
  const [upload] = await db.insert(onbCandidateUploads).values({
    organizationId, caseId: caseRow.id, documentId: documentRow!.id, objectPath,
    originalName: "medical-bgv-evidence.pdf", contentType: "application/pdf", sizeBytes: 42, createdAt: old,
  }).returning();
  await db.insert(onbSensitiveObjectManifests).values({
    organizationId, caseId: caseRow.id, objectPath, dataClass: "medical", manifestState: "complete",
    reconciledAt: old, createdAt: old, updatedAt: old,
  });
  await db.insert(onbEvents).values({
    organizationId, caseId: caseRow.id, agent: "System Watcher", engine: "rules",
    title: "Medical BGV escalation", detail: "Medical condition and background check finding", createdAt: old,
  });
  await db.insert(onbApprovals).values({
    organizationId, caseId: caseRow.id, agent: "HR", recommendation: "Review medical BGV evidence",
    rationale: "Medical accommodation and criminal history", comment: "private BGV comment",
    recordsEvidence: [{ answer: "medical and BGV raw evidence" }] as any, createdAt: old,
  });
  // The authority provenance is immutable audit evidence, but this exact
  // server-owned V2 projection carries no approval narrative or comments.
  // Its presence proves case-envelope minimisation recognizes V2 as safe and
  // does not rewrite it.
  await db.insert(onbApprovalHistory).values({
    organizationId, approvalId: 9_999_980, caseId: caseRow.id, version: 1,
    eventType: "decision", status: "approved", decidedBy: "verified-reviewer",
    comment: null, reason: null, projectionKind: "governed-minimal-v2",
    snapshot: {
      schema: "governed-minimal-v2",
      decidedAuthorityId: "test-verified-authority",
      decidedAuthorityRevision: 1,
    },
  });
  await db.insert(onbSystemChecks).values({
    organizationId, caseId: caseRow.id, system: "bgv", mode: "poll",
    externalRef: "BGV-PRIVATE-123", dueAt: new Date(Date.now() + 86_400_000),
    note: "medical and background finding", requestedAt: old,
  });
  await db.insert(onbSettings).values([
    {
      organizationId, key: `operational_requests:${caseRow.id}`,
      value: JSON.stringify({ requests: [{ reason: "medical/BGV private request" }] }),
      updatedAt: old,
    },
    {
      organizationId, key: "demo-controller.run.v1:matching-case",
      value: JSON.stringify({ caseId: caseRow.id, metadata: { note: "private medical/BGV ledger" } }),
      updatedAt: old,
    },
    {
      organizationId, key: "demo-controller.run.v1:other-case",
      value: JSON.stringify({ caseId: caseRow.id + 10_000, metadata: { note: "other case private ledger" } }),
      updatedAt: old,
    },
    { organizationId, key: "unrelated-config", value: "preserve-me", updatedAt: old },
  ]);
  const protectedAudit = await db.transaction((tx) => appendProtectedAuditInTransaction(tx as any, {
    organizationId, actorKind: "system", actorAuthority: "test",
    action: "test.case-envelope-before-minimisation", outcome: "success",
    objectType: "case", objectId: String(caseRow.id), caseReference: `case:${caseRow.id}`, source: "test",
  }));

  const policies = await db.insert(onbSensitiveLifecyclePolicies).values(
    SENSITIVE_DATA_CLASSES.map((dataClass) => ({
      organizationId, dataClass, jurisdiction: "GB", revision: 1, retentionDays: 0,
      purpose: `Approved ${dataClass} lifecycle`, lawfulBasis: "Reviewed basis",
      providerSharingApproved: false, permittedProviders: [], policyReference: `policy-${dataClass}`,
      approvalReference: `approval-${dataClass}`, approvedByUserId: "privacy-reviewer",
      approvedAuthorityAssignmentId: 1,
    })),
  ).returning();
  const revisions = Object.fromEntries(policies.map((policy) => [
    policy.dataClass, { id: policy.id, revision: policy.revision },
  ]));
  await db.insert(onbSensitiveLifecycleDeletionJobs).values(policies.map((policy) => ({
    organizationId, caseId: caseRow.id, dataClass: policy.dataClass,
    recordKind: "candidate-upload" as const, recordId: `case-derived-envelope:${caseRow.id}`,
    policyId: policy.id, policyRevision: policy.revision, policyRevisions: revisions,
  })));

  const originalBucket = (objectStorageClient as any).bucket;
  process.env.PRIVATE_OBJECT_DIR = "test-bucket";
  (objectStorageClient as any).bucket = () => ({ file: () => ({ delete: async () => undefined }) });
  try {
    await runSensitiveLifecycleDeletionWorker({ now: new Date(), limit: 100, organizationId });
  } finally {
    (objectStorageClient as any).bucket = originalBucket;
  }
  // This request originates outside the lifecycle fence's AsyncLocal context.
  // It queues behind the post-minimisation fence and must re-check the current
  // case rather than resurrecting a narrative after collection completed.
  const outsideRequest = new AsyncResource("independent-sensitive-writer");
  let writerSettled = false;
  let queuedWriter: Promise<unknown> | undefined;
  await withSensitiveLifecycleFence(organizationId, async () => {
    queuedWriter = outsideRequest.runInAsyncScope(() => withCaseDerivedLifecycleWrite(
      { organizationId, caseId: caseRow.id },
      (tx) => tx.insert(onbEvents).values({
        organizationId, caseId: caseRow.id, agent: "race-test", engine: "system",
        title: "raw resurrection", detail: "medical BGV text must never be reinserted",
      }),
    )).finally(() => { writerSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(writerSettled, false, "independent writer must queue behind lifecycle minimisation fence");
  });
  assert.ok(queuedWriter);
  await assert.rejects(queuedWriter, /SENSITIVE_LIFECYCLE_BLOCKED/i);

  const [minimizedCase] = await db.select().from(onbCases).where(eq(onbCases.id, caseRow.id));
  const [document] = await db.select().from(onbDocuments).where(and(
    eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseRow.id),
  ));
  const [event] = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseRow.id));
  const resurrectedEvents = await db.select({ id: onbEvents.id }).from(onbEvents).where(and(
    eq(onbEvents.caseId, caseRow.id),
    eq(onbEvents.agent, "race-test"),
  ));
  const retainedSettings = await db.select({ key: onbSettings.key, value: onbSettings.value })
    .from(onbSettings).where(eq(onbSettings.organizationId, organizationId));
  const [approval] = await db.select().from(onbApprovals).where(eq(onbApprovals.caseId, caseRow.id));
  const [check] = await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.caseId, caseRow.id));
  const uploads = await db.select().from(onbCandidateUploads).where(eq(onbCandidateUploads.caseId, caseRow.id));
  const manifests = await db.select().from(onbSensitiveObjectManifests).where(eq(onbSensitiveObjectManifests.caseId, caseRow.id));
  const jobs = await db.select().from(onbSensitiveLifecycleDeletionJobs).where(and(
    eq(onbSensitiveLifecycleDeletionJobs.organizationId, organizationId),
    eq(onbSensitiveLifecycleDeletionJobs.recordKind, "candidate-upload"),
    eq(onbSensitiveLifecycleDeletionJobs.recordId, `case-derived-envelope:${caseRow.id}`),
  ));
  const [audit] = await db.select().from(onbAuditEntries).where(and(
    eq(onbAuditEntries.organizationId, organizationId),
    eq(onbAuditEntries.action, "privacy.sensitive-lifecycle.case-derived-envelope-minimized"),
  ));
  const [preservedAudit] = await db.select().from(onbAuditEntries).where(eq(onbAuditEntries.id, protectedAudit.id));
  const [preservedApprovalHistory] = await db.select().from(onbApprovalHistory).where(and(
    eq(onbApprovalHistory.organizationId, organizationId),
    eq(onbApprovalHistory.approvalId, 9_999_980),
  ));

  assert.equal(minimizedCase?.id, caseRow.id);
  assert.equal(minimizedCase?.lifecycleStage, "workstreams-running");
  assert.equal(minimizedCase?.orchestrationStatus, "paused");
  assert.equal(minimizedCase?.workerName, "[minimized]");
  assert.equal(minimizedCase?.workerEmail, `case-${caseRow.id}@minimized.invalid`);
  assert.deepEqual(minimizedCase?.readiness, []);
  assert.deepEqual(minimizedCase?.workstreams, []);
  assert.equal(document?.label, "[minimized]");
  assert.equal(document?.note, null);
  assert.equal(uploads.length, 0);
  assert.equal(manifests.length, 0);
  assert.equal(event?.detail, "[minimized]");
  assert.equal(resurrectedEvents.length, 0);
  assert.deepEqual(retainedSettings.sort((a, b) => a.key.localeCompare(b.key)), [
    {
      key: "demo-controller.run.v1:other-case",
      value: JSON.stringify({ caseId: caseRow.id + 10_000, metadata: { note: "other case private ledger" } }),
    },
    { key: "unrelated-config", value: "preserve-me" },
  ]);
  assert.equal(approval?.rationale, "[minimized]");
  assert.equal(approval?.comment, null);
  assert.equal(approval?.recordsEvidence, null);
  assert.equal(check?.externalRef, "[minimized]");
  assert.equal(check?.note, null);
  assert.ok(jobs.length >= SENSITIVE_DATA_CLASSES.length);
  assert.ok(jobs.every((job) => job.status === "completed"));
  assert.equal(preservedAudit?.entryHash, protectedAudit.entryHash);
  assert.equal(preservedAudit?.action, "test.case-envelope-before-minimisation");
  assert.deepEqual(preservedApprovalHistory?.snapshot, {
    schema: "governed-minimal-v2",
    decidedAuthorityId: "test-verified-authority",
    decidedAuthorityRevision: 1,
  });
  assert.equal(audit?.objectType, "case-derived-envelope");
});

test("trusted minimal approval history does not block a fully approved live collection", async () => {
  await db.insert(onbApprovalHistory).values({
    organizationId, approvalId: 9_999_990, caseId: 9_999_990, version: 1,
    eventType: "decision", status: "approved", comment: null, reason: null,
    projectionKind: "governed-minimal-v1", snapshot: { schema: "governed-minimal-v1" },
  });
  const gate = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: false,
  });
  assert.equal(gate.allowed, true);
});

test("exact typed V2 authority provenance remains lifecycle-safe", async () => {
  await db.insert(onbApprovalHistory).values({
    organizationId, approvalId: 9_999_989, caseId: 9_999_989, version: 1,
    eventType: "decision", status: "approved", comment: null, reason: null,
    projectionKind: "governed-minimal-v2",
    snapshot: {
      schema: "governed-minimal-v2",
      decidedAuthorityId: "verified-authority-fixture",
      decidedAuthorityRevision: 1,
    },
  });
  const gate = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: false,
  });
  assert.equal(gate.allowed, true, "V1 remains accepted and exact V2 authority provenance is safe");
});

test("immutable private approval history denies live sensitive collection after all class policies are approved", async () => {
  const approved = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: false,
  });
  assert.equal(approved.allowed, true, "all eight current class policies permit collection before immutable history exists");

  const protectedAudit = await db.transaction((tx) => appendProtectedAuditInTransaction(tx as any, {
    organizationId, actorKind: "system", actorAuthority: "test",
    action: "test.history-gate-before-collection", outcome: "success",
    objectType: "approval-history", objectId: "test-immutable-history", source: "test",
  }));
  await db.insert(onbApprovalHistory).values({
    organizationId, approvalId: 9_999_991, caseId: 9_999_991, version: 1,
    eventType: "decision", status: "approved", comment: "private medical/BGV history", snapshot: { opaque: true },
  });

  const denied = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: false,
  });
  const [preservedAudit] = await db.select().from(onbAuditEntries).where(eq(onbAuditEntries.id, protectedAudit.id));
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? "", /append-only approval history/i);
  assert.equal(preservedAudit?.entryHash, protectedAudit.entryHash);
  assert.equal(preservedAudit?.action, "test.history-gate-before-collection");
});

test("malformed V2 approval history remains opaque and blocks collection", async () => {
  await db.insert(onbApprovalHistory).values({
    organizationId, approvalId: 9_999_988, caseId: 9_999_988, version: 1,
    eventType: "decision", status: "approved", comment: null, reason: null,
    projectionKind: "governed-minimal-v2",
    snapshot: {
      schema: "governed-minimal-v2",
      decidedAuthorityId: "verified-authority-fixture",
      decidedAuthorityRevision: 1,
      unreviewedExtra: true,
    },
  });
  const gate = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: false,
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /append-only approval history/i);
});