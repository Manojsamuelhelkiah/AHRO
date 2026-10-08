import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  onbCandidateUploads,
  onbCases,
  onbDocuments,
  onbSensitiveLifecyclePolicies,
  organizationsTable,
} from "@workspace/db";
import { LEGACY_CHECKLIST, readinessFromChecklist } from "./settings";
import { documentationGateConfigured, resumeChecklistOrchestration } from "./engine";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `engine-document-gate-${process.pid}-${randomUUID()}`;
const organizationId = `${suffix}-tenant`;
const caseIds: number[] = [];
let sequence = 0;

describe("live document malware gate in orchestration", { skip: !hasDb }, () => {
  before(async () => {
    sequence = 0;
    await db.insert(organizationsTable).values({
      id: organizationId, name: organizationId, slug: organizationId,
      joinCodeHash: `${organizationId}-join`, createdByUserId: "test-owner",
    });
    await seedApprovedSensitiveLifecyclePolicies(organizationId);
  });

  after(async () => {
    for (const caseId of caseIds) {
      // Case-owned rows cascade from this parent.
      await db.delete(onbCases).where(and(
          eq(onbCases.organizationId, organizationId),
        eq(onbCases.id, caseId),
      ));
    }
    await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
    await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
  });

  async function createCase() {
    const readiness = readinessFromChecklist(LEGACY_CHECKLIST).map((item) => ({
      ...item,
      status: "ready",
      note: "Fixture deliberately has a cached ready snapshot",
    }));
    const [created] = await db.insert(onbCases).values({
      organizationId,
      workerName: `Engine Gate ${sequence}`,
      workerEmail: `engine-gate-${suffix}-${sequence}@example.com`,
      hireType: "external",
      workerCategory: "full-time",
      role: "Engineer",
      department: "Engineering",
      geography: "US",
      workforceContext: { workCountry: "US" },
      legalEntity: "Test Co",
      managerName: "Manager",
      recruiterName: "Recruiter",
      joiningDate: "2030-01-01",
      lifecycleStage: "preboarding",
      orchestrationStatus: "checklist-blocked",
      orchestrationCheckpoint: "blocked:before-day1-review",
      readiness,
      checklistSnapshot: LEGACY_CHECKLIST.map((item) => ({ ...item })),
    }).returning({ id: onbCases.id });
    assert.ok(created);
    caseIds.push(created.id);
    sequence += 1;
    return created.id;
  }

  async function createDocument(caseId: number, key: string, required = true) {
    const [document] = await db.insert(onbDocuments).values({
      organizationId,
      caseId,
      key,
      label: key,
      category: "identity",
      required,
      status: "verified",
    }).returning();
    assert.ok(document);
    return document;
  }

  async function createUpload(
    caseId: number,
    documentId: number,
    id: string,
    malwareScanState: "pending" | "clean" = "pending",
  ) {
    const [upload] = await db.insert(onbCandidateUploads).values({
      organizationId,
      caseId,
      documentId,
      objectPath: `engine-document-gate/${suffix}/${id}.pdf`,
      originalName: `${id}.pdf`,
      contentType: "application/pdf",
      sizeBytes: 1,
      checksumSha256: malwareScanState === "clean" ? "a".repeat(64) : null,
      malwareScanState,
      malwareScanSha256: malwareScanState === "clean" ? "a".repeat(64) : null,
      validationState: malwareScanState === "clean" ? "passed" : "queued",
      validationReasons: [],
    }).returning();
    assert.ok(upload);
    return upload;
  }

  test("stale ready documentation cannot pass a stage before scan/reconcile", async () => {
    const caseId = await createCase();
    const document = await createDocument(caseId, "legacy-pending");
    const upload = await createUpload(caseId, document.id, "legacy-pending", "pending");

    const resumed = await resumeChecklistOrchestration(caseId);
    const [current] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
    const [currentUpload] = await db.select().from(onbCandidateUploads).where(eq(onbCandidateUploads.id, upload.id));

    assert.equal(resumed, false);
    assert.equal(current.orchestrationStatus, "checklist-blocked");
    assert.equal(current.orchestrationCheckpoint, "blocked:before-day1-review");
    assert.equal(current.readiness.find((item) => item.key === "documentation")?.status, "ready");
    assert.equal(currentUpload.malwareScanState, "pending");
    // The legacy checklist intentionally keeps documentation at the final
    // review boundary; unrelated earlier work is not newly held by uploads.
    assert.equal(documentationGateConfigured(current, "before-workstreams"), false);
    assert.equal(documentationGateConfigured(current, "before-employee-communications"), false);
    assert.equal(documentationGateConfigured(current, "before-day1-review"), true);
  });

  test("a replacement that wins the case lock is observed before recovery claims the stage", async () => {
    const caseId = await createCase();
    const document = await createDocument(caseId, "raced-replacement");
    await createUpload(caseId, document.id, "raced-original", "clean");

    let releaseReplacement!: () => void;
    const replacementMayCommit = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let replacementHasCaseLock!: () => void;
    const replacementLocked = new Promise<void>((resolve) => {
      replacementHasCaseLock = resolve;
    });

    const replacement = db.transaction(async (tx) => {
      await tx.select({ id: onbCases.id })
        .from(onbCases)
        .where(eq(onbCases.id, caseId))
        .for("update");
      replacementHasCaseLock();
      await tx.insert(onbCandidateUploads).values({
        organizationId,
        caseId,
        documentId: document.id,
        objectPath: `engine-document-gate/${suffix}/raced-new.pdf`,
        originalName: "raced-new.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        checksumSha256: null,
        malwareScanState: "pending",
        validationState: "queued",
        validationReasons: [],
      });
      await tx.update(onbDocuments).set({
        status: "received",
        note: "Replacement upload is pending malware scan.",
      }).where(eq(onbDocuments.id, document.id));
      await replacementMayCommit;
    });
    await replacementLocked;

    // The recovery claim is deliberately started while the replacement owns
    // the case lock. It can only inspect the latest upload after that commit.
    const resumed = resumeChecklistOrchestration(caseId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReplacement();
    const [result] = await Promise.all([resumed, replacement]);

    const [current] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
    assert.equal(result, false);
    assert.equal(current.orchestrationStatus, "checklist-blocked");
    assert.equal(current.orchestrationCheckpoint, "blocked:before-day1-review");
  });

  test("checklist-only cases without uploads retain the existing recovery path", async () => {
    const caseId = await createCase();
    const resumed = await resumeChecklistOrchestration(caseId);
    const [current] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));

    // Live readiness now hands off to the mandatory Gate C HR queue rather
    // than completing the pipeline automatically.
    assert.equal(resumed, false);
    assert.equal(current.orchestrationStatus, "waiting-approval");
    assert.equal(current.orchestrationCheckpoint, "waiting:day1-readiness");
  });

  test("pending uploads for optional documents do not block mandatory documentation readiness", async () => {
    const caseId = await createCase();
    const document = await createDocument(caseId, "optional-pending", false);
    await createUpload(caseId, document.id, "optional-pending", "pending");

    const resumed = await resumeChecklistOrchestration(caseId);
    const [current] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));

    assert.equal(resumed, false);
    assert.equal(current.orchestrationStatus, "waiting-approval");
    assert.equal(current.orchestrationCheckpoint, "waiting:day1-readiness");
  });
});
