import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  onbCandidateUploadReservations,
  onbCases,
  onbDocuments,
  onbSensitiveLifecycleHolds,
  onbSensitiveLifecyclePolicies,
  onbSensitiveObjectManifests,
  organizationsTable,
} from "@workspace/db";
import {
  CANDIDATE_UPLOAD_RESERVATION_LEASE_MS,
  CANDIDATE_UPLOAD_RESERVATION_RETRY_MS,
  recoverPendingCandidateUploadReservations,
  finalizeCandidateUploadReservation,
  OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES,
  reserveCandidateUploadObject,
  saveReservedCandidateUpload,
} from "./candidate-upload-reservations";
import type { SensitiveDataClass } from "./sensitive-lifecycle";

const organizationId = `candidate-upload-reservation-${randomUUID()}`;
let caseId: number;
let documentId: number;
let policyId: number;
const policyIds = new Map<string, number>();

function input(
  objectPath: string,
  now = new Date(),
  dataClass: SensitiveDataClass = "identity",
) {
  return {
    organizationId,
    caseId,
    documentId,
    objectPath,
    dataClass,
    jurisdiction: "GB",
    workforceContextVersion: 1,
    policyId: policyIds.get(dataClass) ?? policyId,
    policyRevision: 1,
    now,
  };
}

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Candidate upload reservation test",
    slug: organizationId,
    joinCodeHash: `hash-${organizationId}`,
    createdByUserId: "test-creator",
  });
  [caseId] = (await db.insert(onbCases).values({
    organizationId,
    workerName: "Reservation Candidate",
    workerEmail: "reservation@example.test",
    hireType: "employee",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "GB",
    legalEntity: "Employer Ltd",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    workforceContext: { workCountry: "GB" },
  }).returning({ id: onbCases.id })).map((row) => row.id);
  [documentId] = (await db.insert(onbDocuments).values({
    organizationId, caseId, key: "passport", label: "Passport", category: "identity",
  }).returning({ id: onbDocuments.id })).map((row) => row.id);
  const policies = await db.insert(onbSensitiveLifecyclePolicies).values(
    OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES.map((dataClass) => ({
      organizationId,
      dataClass,
      jurisdiction: "GB",
      revision: 1,
      purpose: "Opaque candidate document lifecycle",
      lawfulBasis: "Recorded approved basis",
      retentionDays: 30,
      providerSharingApproved: true,
      permittedProviders: ["replit-object-storage"],
      policyReference: `reservation-policy-${dataClass}`,
      approvalReference: `reservation-approval-${dataClass}`,
      approvedByUserId: "test-privacy-reviewer",
      approvedAuthorityAssignmentId: 1,
    })),
  ).returning({ id: onbSensitiveLifecyclePolicies.id, dataClass: onbSensitiveLifecyclePolicies.dataClass });
  for (const policy of policies) policyIds.set(policy.dataClass, policy.id);
  policyId = policyIds.get("identity")!;
});

after(async () => {
  await db.delete(onbCandidateUploadReservations).where(eq(onbCandidateUploadReservations.organizationId, organizationId));
  await db.delete(onbSensitiveLifecycleHolds).where(eq(onbSensitiveLifecycleHolds.organizationId, organizationId));
  await db.delete(onbSensitiveObjectManifests).where(eq(onbSensitiveObjectManifests.organizationId, organizationId));
  await db.delete(onbDocuments).where(eq(onbDocuments.organizationId, organizationId));
  await db.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
});

test("a failure after object save keeps a manifest until fenced compensation succeeds", async () => {
  const objectPath = `/objects/candidate-documents/test/${randomUUID()}`;
  let saved = false;
  let observedPreSaveInventory = false;
  const deleted: string[] = [];
  await assert.rejects(
    saveReservedCandidateUpload({
      reservation: input(objectPath),
      save: async () => {
        const [[reservation], [manifest]] = await Promise.all([
          db.select().from(onbCandidateUploadReservations).where(and(
            eq(onbCandidateUploadReservations.organizationId, organizationId),
            eq(onbCandidateUploadReservations.objectPath, objectPath),
          )),
          db.select().from(onbSensitiveObjectManifests).where(and(
            eq(onbSensitiveObjectManifests.organizationId, organizationId),
            eq(onbSensitiveObjectManifests.objectPath, objectPath),
          )),
        ]);
        observedPreSaveInventory = reservation?.state === "reserved" &&
          manifest?.manifestState === "reconciliation-required";
        saved = true;
      },
      // Simulates a database/finalization crash point after durable bytes exist.
      finalize: async () => { throw new Error("injected finalize failure"); },
      deleteObject: async (path) => { deleted.push(path); },
    }),
    /injected finalize failure/,
  );
  assert.equal(saved, true);
  assert.equal(observedPreSaveInventory, true, "the object path is durable before the storage save begins");
  assert.deepEqual(deleted, [objectPath]);
  const [reservation] = await db.select().from(onbCandidateUploadReservations).where(and(
    eq(onbCandidateUploadReservations.organizationId, organizationId),
    eq(onbCandidateUploadReservations.objectPath, objectPath),
  ));
  assert.equal(reservation?.state, "cleanup-completed");
  const manifests = await db.select().from(onbSensitiveObjectManifests).where(and(
    eq(onbSensitiveObjectManifests.organizationId, organizationId),
    eq(onbSensitiveObjectManifests.objectPath, objectPath),
  ));
  assert.equal(manifests.length, 0);
});

test("an unrelated opaque-class hold retains a reservation manifest through compensation", async () => {
  const objectPath = `/objects/candidate-documents/test/${randomUUID()}`;
  const reservedAt = new Date(Date.now() - CANDIDATE_UPLOAD_RESERVATION_LEASE_MS - 1_000);
  await reserveCandidateUploadObject(input(objectPath, reservedAt));
  // Model the precise crash-recovery path: a former janitor had claimed the
  // reservation, then its lease elapsed before it could reach object storage.
  await db.update(onbCandidateUploadReservations).set({
    state: "cleanup-processing",
    ownerToken: "crashed-cleanup-owner",
    leaseUntil: reservedAt,
  }).where(and(
    eq(onbCandidateUploadReservations.organizationId, organizationId),
    eq(onbCandidateUploadReservations.objectPath, objectPath),
  ));
  await db.insert(onbSensitiveLifecycleHolds).values({
    organizationId,
    objectPath,
    dataClass: "payroll",
    reason: "Preserve interrupted upload",
    reference: "RESERVATION-HOLD",
    setByUserId: "test-privacy-reviewer",
    setAuthorityAssignmentId: 1,
  });

  const noDelete: string[] = [];
  const held = await recoverPendingCandidateUploadReservations({
    now: new Date(),
    limit: 1,
    organizationId,
    deleteObject: async (path) => { noDelete.push(path); },
  });
  assert.deepEqual(held, { examined: 1, cleaned: 0, retained: 1 });
  assert.deepEqual(noDelete, []);
  const [retained] = await db.select().from(onbCandidateUploadReservations).where(
    eq(onbCandidateUploadReservations.objectPath, objectPath),
  );
  assert.equal(retained?.state, "reserved");
  const [manifest] = await db.select().from(onbSensitiveObjectManifests).where(
    eq(onbSensitiveObjectManifests.objectPath, objectPath),
  );
  assert.ok(manifest, "a held pending object remains inventoried");

  await db.delete(onbSensitiveLifecycleHolds).where(and(
    eq(onbSensitiveLifecycleHolds.organizationId, organizationId),
    eq(onbSensitiveLifecycleHolds.objectPath, objectPath),
  ));
  const deleted: string[] = [];
  const recovered = await recoverPendingCandidateUploadReservations({
    now: new Date(Date.now() + CANDIDATE_UPLOAD_RESERVATION_RETRY_MS + 1_000),
    limit: 1,
    organizationId,
    deleteObject: async (path) => { deleted.push(path); },
  });
  assert.deepEqual(recovered, { examined: 1, cleaned: 1, retained: 0 });
  assert.deepEqual(deleted, [objectPath]);
});

test("a failed recovery delete retains the reservation and manifest for retry", async () => {
  const objectPath = `/objects/candidate-documents/test/${randomUUID()}`;
  const reservedAt = new Date(Date.now() - CANDIDATE_UPLOAD_RESERVATION_LEASE_MS - 1_000);
  await reserveCandidateUploadObject(input(objectPath, reservedAt));
  const failed = await recoverPendingCandidateUploadReservations({
    now: new Date(),
    limit: 1,
    organizationId,
    deleteObject: async () => { throw new Error("injected object delete failure"); },
  });
  assert.deepEqual(failed, { examined: 1, cleaned: 0, retained: 1 });
  const [[reservation], [manifest]] = await Promise.all([
    db.select().from(onbCandidateUploadReservations).where(and(
      eq(onbCandidateUploadReservations.organizationId, organizationId),
      eq(onbCandidateUploadReservations.objectPath, objectPath),
    )),
    db.select().from(onbSensitiveObjectManifests).where(and(
      eq(onbSensitiveObjectManifests.organizationId, organizationId),
      eq(onbSensitiveObjectManifests.objectPath, objectPath),
    )),
  ]);
  assert.equal(reservation?.state, "reserved");
  assert.match(reservation?.lastError ?? "", /injected object delete failure/);
  assert.ok(manifest, "object inventory is never removed after a delete failure");
});

test("a workforce jurisdiction change between reservation and finalization retains inventory without finalizing stale disclosure", async () => {
  const objectPath = `/objects/candidate-documents/test/${randomUUID()}`;
  let storageWriteStarted = false;
  const deleted: string[] = [];
  await assert.rejects(
    saveReservedCandidateUpload({
      reservation: input(objectPath),
      save: async () => {
        storageWriteStarted = true;
        // Deterministically model a context correction that completed after
        // reservation but before the final metadata boundary.
        await db.update(onbCases).set({
          workforceContext: { workCountry: "US" },
          workforceContextVersion: 2,
        }).where(and(
          eq(onbCases.organizationId, organizationId),
          eq(onbCases.id, caseId),
        ));
      },
      finalize: async (reservation) => finalizeCandidateUploadReservation({
        reservation,
        finalize: async () => ({ uploadId: 0, value: undefined }),
      }),
      deleteObject: async (path) => { deleted.push(path); },
    }),
    /case context or document classification no longer matches/,
  );
  assert.equal(storageWriteStarted, true);
  assert.deepEqual(deleted, [], "a jurisdiction mismatch keeps the object manifest for governed reconciliation");
  const [[reservation], [manifest]] = await Promise.all([
    db.select().from(onbCandidateUploadReservations).where(and(
      eq(onbCandidateUploadReservations.organizationId, organizationId),
      eq(onbCandidateUploadReservations.objectPath, objectPath),
    )),
    db.select().from(onbSensitiveObjectManifests).where(and(
      eq(onbSensitiveObjectManifests.organizationId, organizationId),
      eq(onbSensitiveObjectManifests.objectPath, objectPath),
    )),
  ]);
  assert.equal(reservation?.state, "reserved");
  assert.equal(reservation?.jurisdiction, "GB");
  assert.equal(reservation?.workforceContextVersion, 1);
  assert.ok(manifest, "the stale object remains durably inventoried");
});

test("a stale A-to-B jurisdiction is rejected before a new storage save or manifest reservation", async () => {
  const objectPath = `/objects/candidate-documents/test/${randomUUID()}`;
  let saved = false;
  await assert.rejects(
    saveReservedCandidateUpload({
      // The case was deterministically corrected to US by the preceding
      // in-flight test, while this request still presents its GB approval.
      reservation: input(objectPath),
      save: async () => { saved = true; },
      finalize: async () => undefined,
      deleteObject: async () => {},
    }),
    /case context, classification, or lifecycle policy changed/,
  );
  assert.equal(saved, false, "the obsolete jurisdiction never reaches storage");
  const [reservation] = await db.select().from(onbCandidateUploadReservations).where(and(
    eq(onbCandidateUploadReservations.organizationId, organizationId),
    eq(onbCandidateUploadReservations.objectPath, objectPath),
  ));
  assert.equal(reservation, undefined, "no stale-jurisdiction manifest/reservation is created");
});

test("opaque medical uploads require identity and payroll storage policy approval too", async () => {
  await db.update(onbCases).set({
    workforceContext: { workCountry: "GB" },
    workforceContextVersion: 1,
  }).where(eq(onbCases.id, caseId));
  await db.update(onbDocuments).set({ category: "medical" }).where(eq(onbDocuments.id, documentId));

  // A medical checklist label does not narrow opaque passport/image bytes to
  // medical alone: absent identity approval must block before reservation.
  await db.delete(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    eq(onbSensitiveLifecyclePolicies.dataClass, "identity"),
  ));
  await assert.rejects(
    reserveCandidateUploadObject(input(`/objects/candidate-documents/test/${randomUUID()}`, new Date(), "medical")),
    /classification, or lifecycle policy changed/,
  );

  const [identity] = await db.insert(onbSensitiveLifecyclePolicies).values({
    organizationId,
    dataClass: "identity",
    jurisdiction: "GB",
    revision: 1,
    purpose: "Opaque candidate document lifecycle",
    lawfulBasis: "Recorded approved basis",
    retentionDays: 30,
    providerSharingApproved: true,
    permittedProviders: ["replit-object-storage"],
    policyReference: "reservation-policy-identity-restored",
    approvalReference: "reservation-approval-identity-restored",
    approvedByUserId: "test-privacy-reviewer",
    approvedAuthorityAssignmentId: 1,
  }).returning({ id: onbSensitiveLifecyclePolicies.id });
  policyIds.set("identity", identity!.id);
  await db.delete(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    eq(onbSensitiveLifecyclePolicies.dataClass, "payroll"),
  ));
  await assert.rejects(
    reserveCandidateUploadObject(input(`/objects/candidate-documents/test/${randomUUID()}`, new Date(), "medical")),
    /classification, or lifecycle policy changed/,
    "a missing payroll policy blocks the medical upload",
  );
  await db.insert(onbSensitiveLifecyclePolicies).values({
    organizationId,
    dataClass: "payroll",
    jurisdiction: "GB",
    revision: 1,
    purpose: "Opaque candidate document lifecycle",
    lawfulBasis: "Recorded approved basis",
    retentionDays: 30,
    providerSharingApproved: false,
    permittedProviders: [],
    policyReference: "reservation-policy-payroll-provider-denied",
    approvalReference: "reservation-approval-payroll-provider-denied",
    approvedByUserId: "test-privacy-reviewer",
    approvedAuthorityAssignmentId: 1,
  });
  await assert.rejects(
    reserveCandidateUploadObject(input(`/objects/candidate-documents/test/${randomUUID()}`, new Date(), "medical")),
    /classification, or lifecycle policy changed/,
    "a missing exact payroll storage-provider approval blocks the medical upload",
  );
});