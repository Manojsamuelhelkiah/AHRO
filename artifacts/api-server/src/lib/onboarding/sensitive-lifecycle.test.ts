import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbSensitiveLifecyclePolicies,
  onbSensitiveLifecycleDeletionJobs,
  onbSensitiveLifecycleConfirmations,
  onbSensitiveLifecycleHolds,
  onbSensitiveObjectDerivatives,
  onbSensitiveObjectManifests,
  onbCandidateUploads,
  onbCases,
  onbDocuments,
  onbGovernanceAuthorityAssignments,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import {
  confirmRetentionShortening,
  evaluateSensitiveLifecycleGate,
  previewRetentionShortening,
  recordSensitivePrimaryObjectInTransaction,
  runSensitiveLifecycleDeletionWorker,
  SENSITIVE_DATA_CLASSES,
  saveSensitiveLifecyclePolicy,
  setSensitiveLifecycleHold,
  SensitiveLifecyclePermissionError,
  verifiedSensitiveAuthorityInTransaction,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

const organizationId = `sensitive-lifecycle-${randomUUID()}`;
const otherOrganizationId = `sensitive-lifecycle-other-${randomUUID()}`;
const privacyActor = `privacy-specialist-${randomUUID()}`;
const revokedMembershipActor = `revoked-membership-specialist-${randomUUID()}`;

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Sensitive lifecycle test",
    slug: organizationId,
    joinCodeHash: `hash-${organizationId}`,
    createdByUserId: "test-creator",
  });
  await db.insert(organizationsTable).values({
    id: otherOrganizationId, name: "Other sensitive lifecycle test", slug: otherOrganizationId,
    joinCodeHash: `hash-${otherOrganizationId}`, createdByUserId: "other-creator",
  });
  await db.insert(organizationMembershipsTable).values([
    { organizationId, clerkUserId: privacyActor, role: "member" },
    { organizationId: otherOrganizationId, clerkUserId: privacyActor, role: "member" },
    { organizationId, clerkUserId: revokedMembershipActor, role: "member", revokedAt: new Date() },
  ]);
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId, authorityRole: "privacy", assigneeUserId: privacyActor,
    verificationStatus: "verified", verifiedByUserId: "test-verifier", verificationReference: "test-verification",
  });
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId, authorityRole: "privacy", assigneeUserId: revokedMembershipActor,
    verificationStatus: "verified", verifiedByUserId: "test-verifier", verificationReference: "test-revoked-membership",
  });
});

after(async () => {
  await db.delete(onbCandidateUploads).where(eq(onbCandidateUploads.organizationId, organizationId));
  await db.delete(onbDocuments).where(eq(onbDocuments.organizationId, organizationId));
  await db.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
  await db.delete(onbSensitiveObjectDerivatives).where(eq(onbSensitiveObjectDerivatives.organizationId, organizationId));
  await db.delete(onbSensitiveObjectManifests).where(eq(onbSensitiveObjectManifests.organizationId, organizationId));
  await db.delete(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.organizationId, organizationId));
  await db.delete(onbSensitiveLifecycleHolds).where(eq(onbSensitiveLifecycleHolds.organizationId, organizationId));
  await db.delete(onbSensitiveLifecycleConfirmations).where(eq(onbSensitiveLifecycleConfirmations.organizationId, organizationId));
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
  await db.delete(onbGovernanceAuthorityAssignments).where(eq(onbGovernanceAuthorityAssignments.organizationId, organizationId));
  await db.delete(organizationMembershipsTable).where(inArray(
    organizationMembershipsTable.clerkUserId,
    [privacyActor, revokedMembershipActor],
  ));
  await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
  await deleteTestOrganizations(eq(organizationsTable.id, otherOrganizationId));
});

test("transactional sensitive-authority verification rejects a revoked membership", async () => {
  await assert.rejects(
    () => db.transaction((tx) => verifiedSensitiveAuthorityInTransaction(
      tx,
      organizationId,
      revokedMembershipActor,
    )),
    SensitiveLifecyclePermissionError,
  );
});

test("missing class/jurisdiction policy blocks collection and external disclosure", async () => {
  const missing = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: false,
  });
  assert.equal(missing.allowed, false);

  await db.insert(onbSensitiveLifecyclePolicies).values({
    organizationId,
    dataClass: "candidate-document",
    jurisdiction: "GB",
    revision: 1,
    purpose: "Verified onboarding document intake",
    lawfulBasis: "Recorded approved basis",
    retentionDays: 31,
    providerSharingApproved: false,
    policyReference: "test-policy-ref",
    approvalReference: "test-approval-ref",
    approvedByUserId: "verified-specialist",
    approvedAuthorityAssignmentId: 1,
  });

  const collection = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: false,
  });
  assert.equal(collection.allowed, false);
  assert.match(collection.reason ?? "", /missing for/i);
  const mixedEnvelopeClasses = SENSITIVE_DATA_CLASSES.filter((dataClass) => dataClass !== "candidate-document");
  await db.insert(onbSensitiveLifecyclePolicies).values(mixedEnvelopeClasses.map((dataClass) => ({
    organizationId, dataClass, jurisdiction: "GB", revision: 1,
    purpose: `${dataClass} onboarding`, lawfulBasis: "Recorded approved basis", retentionDays: 31,
    providerSharingApproved: false, policyReference: `test-${dataClass}-policy`,
    approvalReference: `test-${dataClass}-approval`, approvedByUserId: "verified-specialist",
    approvedAuthorityAssignmentId: 1,
  })));
  const allClassCollection = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: false,
  });
  assert.equal(allClassCollection.allowed, true);
  const disclosure = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: true,
  });
  assert.equal(disclosure.allowed, false);

  await db.update(onbSensitiveLifecyclePolicies).set({
    providerSharingApproved: true,
    permittedProviders: ["replit-object-storage"],
  }).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-document"),
  ));
  const wrongProvider = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: true, providerId: "gmail",
  });
  assert.equal(wrongProvider.allowed, false);
  const approvedProvider = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-document", disclosure: true, providerId: "replit-object-storage",
  });
  assert.equal(approvedProvider.allowed, true);
  // Preserve the following test's proof that a distinct class is blocked
  // without its own approved policy.
  await db.delete(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    inArray(onbSensitiveLifecyclePolicies.dataClass, mixedEnvelopeClasses),
  ));
});

test("a distinct sensitive class remains blocked without its own approved policy", async () => {
  const result = await evaluateSensitiveLifecycleGate({
    organizationId, jurisdiction: "GB", dataClass: "candidate-voice", disclosure: false,
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /No approved class-specific/);
});

test("hold writes serialize behind the deletion lifecycle fence and cannot escalate cross-tenant", async () => {
  let holdFinished = false;
  let pendingHold: Promise<unknown> | undefined;
  await withSensitiveLifecycleFence(organizationId, async () => {
    pendingHold = setSensitiveLifecycleHold({
      organizationId, actorUserId: privacyActor, dataClass: "candidate-contact",
      reason: "Litigation preservation", reference: "LEGAL-TEST-1",
    }).then(() => { holdFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(holdFinished, false, "hold mutation must wait for the shared deletion fence");
  });
  await pendingHold;
  assert.equal(holdFinished, true);

  await assert.rejects(
    setSensitiveLifecycleHold({
      organizationId: otherOrganizationId, actorUserId: privacyActor, dataClass: "identity",
      reason: "Cross tenant attempt", reference: "LEGAL-TEST-2",
    }),
    /verified privacy or legal authority/i,
  );
  await db.delete(onbSensitiveLifecycleHolds).where(and(
    eq(onbSensitiveLifecycleHolds.organizationId, organizationId),
    eq(onbSensitiveLifecycleHolds.reference, "LEGAL-TEST-1"),
  ));
});

test("policy revision writes serialize behind lifecycle deletion fence", async () => {
  let saved = false;
  const policy = {
    dataClass: "payroll", jurisdiction: "GB", purpose: "Payroll onboarding",
    lawfulBasis: "Recorded approved basis", retentionDays: 30,
    providerSharingApproved: false, permittedProviders: [],
    policyReference: "policy-payroll", approvalReference: "approval-payroll", expectedRevision: 0,
  };
  let release!: () => void;
  let acquired!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const deletion = withSensitiveLifecycleFence(organizationId, async () => {
    acquired();
    await released;
  });
  await ready;
  // A separate request must start outside the deletion's async context.
  // Calls made inside that context intentionally reuse its existing fence.
  const pendingSave = saveSensitiveLifecyclePolicy({
      organizationId, actorUserId: privacyActor, policy,
  }).then(() => { saved = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(saved, false, "policy revision must wait for the same fence as deletion");
  } finally {
    release();
    await deletion;
  }
  await pendingSave;
  assert.equal(saved, true);
});

test("a deferred callback with stale fence context reacquires the real lifecycle fence", async () => {
  let releaseDeferred!: () => void;
  const deferredMayRun = new Promise<void>((resolve) => { releaseDeferred = resolve; });
  let deferredStarted!: () => void;
  const deferredStartedPromise = new Promise<void>((resolve) => { deferredStarted = resolve; });
  let deferredFinished = false;
  let deferred!: Promise<void>;

  await withSensitiveLifecycleFence(organizationId, async () => {
    // The timer inherits this fence's AsyncLocalStorage context. It waits until
    // after the owner has returned, which used to leave a stale Set that
    // bypassed a newly acquired independent holder.
    deferred = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void (async () => {
          await deferredMayRun;
          deferredStarted();
          await withSensitiveLifecycleFence(organizationId, async () => {
            deferredFinished = true;
          });
          resolve();
        })().catch(reject);
      }, 0);
    });
  });

  let releaseHolder!: () => void;
  let holderAcquired!: () => void;
  const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const holderReady = new Promise<void>((resolve) => { holderAcquired = resolve; });
  const holder = withSensitiveLifecycleFence(organizationId, async () => {
    holderAcquired();
    await holderRelease;
  });
  await holderReady;
  releaseDeferred();
  await deferredStartedPromise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(deferredFinished, false, "stale inherited context must not bypass an independent lifecycle holder");
  releaseHolder();
  await holder;
  await deferred!;
  assert.equal(deferredFinished, true);
});

test("an in-flight unawaited nested fence may enter a delayed grandchild before owner unlock", async () => {
  let releaseChild!: () => void;
  const childMayFinish = new Promise<void>((resolve) => { releaseChild = resolve; });
  let childStarted!: () => void;
  const childStartedPromise = new Promise<void>((resolve) => { childStarted = resolve; });
  let grandchildEntered = false;
  let outerFinished = false;

  const outer = withSensitiveLifecycleFence(organizationId, async () => {
    // Deliberately do not await this child: root cleanup must drain it, while
    // preserving reentrancy for the grandchild it enters after the owner body
    // has already returned.
    void withSensitiveLifecycleFence(organizationId, async () => {
      childStarted();
      await childMayFinish;
      await withSensitiveLifecycleFence(organizationId, async () => {
        grandchildEntered = true;
      });
    });
  }).then(() => { outerFinished = true; });

  await childStartedPromise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(outerFinished, false, "root fence must wait for an already-started detached child");
  releaseChild();
  await outer;
  assert.equal(grandchildEntered, true);
});

test("shortening confirmation rejects if eligible inventory changes after preview", async () => {
  const [caseRow] = await db.insert(onbCases).values({
    organizationId, workerName: "Lifecycle Candidate", workerEmail: "candidate@example.test",
    hireType: "employee", workerCategory: "employee", role: "Engineer", department: "Engineering",
    geography: "GB", legalEntity: "Employer Ltd", managerName: "Manager", recruiterName: "Recruiter",
    joiningDate: "2030-01-01", workforceContext: { workCountry: "GB" },
  }).returning({ id: onbCases.id });
  const [document] = await db.insert(onbDocuments).values({
    organizationId, caseId: caseRow!.id, key: "id-proof", label: "Passport", category: "identity",
  }).returning({ id: onbDocuments.id });
  const old = new Date(Date.now() - 400 * 86_400_000);
  const insertUpload = async (suffix: string) => db.insert(onbCandidateUploads).values({
    organizationId, caseId: caseRow!.id, documentId: document!.id,
    objectPath: `/objects/test-bucket/${organizationId}/${suffix}-${randomUUID()}`,
    originalName: "passport.pdf", contentType: "application/pdf", sizeBytes: 10, createdAt: old,
  });
  await insertUpload("first");
  const opaquePolicies = SENSITIVE_DATA_CLASSES
    .filter((dataClass) => dataClass !== "candidate-document")
    .map((dataClass) => ({
      organizationId, dataClass, jurisdiction: "GB", revision: 1,
      purpose: `${dataClass} verification`, lawfulBasis: "Recorded approved basis", retentionDays: 120,
      providerSharingApproved: false, permittedProviders: [], policyReference: `${dataClass}-policy`,
      approvalReference: `${dataClass}-approval`, approvedByUserId: privacyActor, approvedAuthorityAssignmentId: 1,
    }));
  await db.insert(onbSensitiveLifecyclePolicies).values(
    opaquePolicies.filter((policy) => policy.dataClass === "identity"),
  );
  const proposed = {
    dataClass: "identity", jurisdiction: "GB", purpose: "Identity verification",
    lawfulBasis: "Recorded approved basis", retentionDays: 0,
    providerSharingApproved: false, permittedProviders: [], policyReference: "identity-policy",
    approvalReference: "identity-approval", expectedRevision: 1,
  };
  const incompletePreview = await previewRetentionShortening({
    organizationId, actorUserId: privacyActor, policy: proposed,
  });
  assert.equal(incompletePreview.affectedObjectCount, 0, "opaque upload eligibility requires every class policy");
  const currentClasses = new Set((await db.select({
    dataClass: onbSensitiveLifecyclePolicies.dataClass,
  }).from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, "GB"),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
  ))).map((policy) => policy.dataClass));
  await db.insert(onbSensitiveLifecyclePolicies).values(
    opaquePolicies.filter((policy) => !currentClasses.has(policy.dataClass)),
  );
  const preview = await previewRetentionShortening({ organizationId, actorUserId: privacyActor, policy: proposed });
  assert.equal(preview.affectedObjectCount, 1);
  await insertUpload("late-added");
  await assert.rejects(
    confirmRetentionShortening({
      organizationId, actorUserId: privacyActor, confirmationId: preview.confirmationId,
      confirmationPhrase: "AUTHORIZE RETENTION SHORTENING",
    }),
    /inventory changed/i,
  );
});

test("a medical hold blocks deletion of an opaque upload recorded as identity", async () => {
  const [caseRow] = await db.insert(onbCases).values({
    organizationId, workerName: "Opaque upload", workerEmail: "opaque-upload@example.test",
    hireType: "employee", workerCategory: "employee", role: "Engineer", department: "Engineering",
    geography: "GB", legalEntity: "Employer Ltd", managerName: "Manager", recruiterName: "Recruiter",
    joiningDate: "2030-01-01", workforceContext: { workCountry: "GB" },
  }).returning({ id: onbCases.id });
  const [document] = await db.insert(onbDocuments).values({
    organizationId, caseId: caseRow!.id, key: "medical-passport", label: "Medical passport", category: "identity",
  }).returning({ id: onbDocuments.id });
  const objectPath = `/objects/test-bucket/${organizationId}/opaque-${randomUUID()}`;
  const [upload] = await db.insert(onbCandidateUploads).values({
    organizationId, caseId: caseRow!.id, documentId: document!.id, objectPath,
    originalName: "opaque.pdf", contentType: "application/pdf", sizeBytes: 10,
    createdAt: new Date(Date.now() - 400 * 86_400_000),
  }).returning({ id: onbCandidateUploads.id });
  await db.insert(onbSensitiveObjectManifests).values({
    organizationId, caseId: caseRow!.id, objectPath, dataClass: "identity",
    manifestState: "complete", reconciledAt: new Date(),
  });
  const policies = await db.select().from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, "GB"),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
  ));
  assert.equal(policies.length, SENSITIVE_DATA_CLASSES.length);
  const byClass = new Map(policies.map((policy) => [policy.dataClass, policy]));
  const policy = byClass.get("candidate-document")!;
  const [job] = await db.insert(onbSensitiveLifecycleDeletionJobs).values({
    organizationId, dataClass: "candidate-document", caseId: caseRow!.id, uploadId: upload!.id,
    recordKind: "candidate-upload", recordId: String(upload!.id),
    policyId: policy.id, policyRevision: policy.revision,
    policyRevisions: Object.fromEntries(SENSITIVE_DATA_CLASSES.map((dataClass) => {
      const current = byClass.get(dataClass)!;
      return [dataClass, { id: current.id, revision: current.revision }];
    })),
    createdAt: new Date(0),
  }).returning({ id: onbSensitiveLifecycleDeletionJobs.id });
  await setSensitiveLifecycleHold({
    organizationId, actorUserId: privacyActor, dataClass: "medical", caseId: caseRow!.id, objectPath,
    reason: "Medical review hold", reference: "hold-opaque-medical",
  });
  await runSensitiveLifecycleDeletionWorker({ now: new Date(), limit: 1, organizationId });
  const [blocked] = await db.select({ status: onbSensitiveLifecycleDeletionJobs.status })
    .from(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.id, job!.id));
  assert.equal(blocked?.status, "blocked");
});

test("expired processing lease is reclaimed and absent metadata completes idempotently", async () => {
  const now = new Date();
  const [job] = await db.insert(onbSensitiveLifecycleDeletionJobs).values({
    organizationId, dataClass: "candidate-document", caseId: 999_999, uploadId: 999_999,
    recordKind: "candidate-upload", recordId: "999999",
    policyId: 999_999, policyRevision: 1, status: "processing", attempts: 1,
    claimOwner: "crashed-worker", claimUntil: new Date(now.getTime() - 1_000),
    // The worker is explicitly scoped to this fixture tenant below. Keep this
    // recovery job oldest within that tenant without deleting or altering
    // shared queue records from concurrent suites.
    createdAt: new Date(0),
  }).returning({ id: onbSensitiveLifecycleDeletionJobs.id });
  let recovered: typeof onbSensitiveLifecycleDeletionJobs.$inferSelect | undefined;
  // Retry bounded real lease windows while observing only this durable job;
  // the scoped internal worker cannot claim another fixture's queue item.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runSensitiveLifecycleDeletionWorker({
      now: new Date(now.getTime() + attempt * 6 * 60_000),
      limit: 1,
      organizationId,
    });
    [recovered] = await db.select().from(onbSensitiveLifecycleDeletionJobs)
      .where(eq(onbSensitiveLifecycleDeletionJobs.id, job!.id));
    if (recovered?.status === "completed") break;
  }
  assert.equal(recovered?.status, "completed");
  assert.equal(recovered?.claimOwner, null);
  assert.equal(recovered?.claimUntil, null);
});

test("a candidate primary object gets an explicit complete derivative manifest", async () => {
  const objectPath = `/objects/test-bucket/sensitive-lifecycle/${randomUUID()}`;
  await db.transaction((tx) => recordSensitivePrimaryObjectInTransaction(tx, {
    organizationId, caseId: 101, objectPath, dataClass: "candidate-document",
  }));
  const [manifest] = await db.select().from(onbSensitiveObjectManifests).where(and(
    eq(onbSensitiveObjectManifests.organizationId, organizationId),
    eq(onbSensitiveObjectManifests.objectPath, objectPath),
  ));
  assert.equal(manifest?.manifestState, "complete");
  assert.ok(manifest?.reconciledAt);
});