import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  db,
  onbCandidateUploadReservations,
  onbCases,
  onbDocuments,
  onbSensitiveLifecycleHolds,
  onbSensitiveLifecyclePolicies,
  onbSensitiveObjectManifests,
} from "@workspace/db";
import { getPrivateFile } from "../objectStorage";
import {
  jurisdictionForWorkforceContext,
  effectiveSensitiveDataClassesForCandidateUpload,
  sensitiveDataClassForDocument,
  type SensitiveDataClass,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

export const CANDIDATE_UPLOAD_RESERVATION_LEASE_MS = 15 * 60_000;
export const CANDIDATE_UPLOAD_RESERVATION_RETRY_MS = 5 * 60_000;
const CANDIDATE_UPLOAD_STORAGE_PROVIDER = "replit-object-storage";
/**
 * Candidate file bytes are opaque at every intake boundary. A checklist
 * category is useful routing metadata, but cannot prove that a PDF/image does
 * not also contain another sensitive class.
 */
export const OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES = effectiveSensitiveDataClassesForCandidateUpload();

type Reservation = typeof onbCandidateUploadReservations.$inferSelect;
type FinalizeResult<T> = { uploadId: number; value: T };
type ReservationCase = typeof onbCases.$inferSelect;

function hasEveryOpaqueUploadPolicy(
  policies: Array<{
    dataClass: string;
    id: number;
    revision: number;
    providerSharingApproved: boolean;
    permittedProviders: string[];
  }>,
  reservation: Pick<Reservation, "dataClass" | "policyId" | "policyRevision">,
  exactPolicyRevision: boolean,
): boolean {
  if (
    new Set(policies.map((policy) => policy.dataClass)).size !== OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES.length ||
    policies.some((policy) =>
      !policy.providerSharingApproved ||
      !policy.permittedProviders.includes(CANDIDATE_UPLOAD_STORAGE_PROVIDER)
    )
  ) {
    return false;
  }
  const nominalPolicy = policies.find((policy) => policy.dataClass === reservation.dataClass);
  return !!nominalPolicy && (
    !exactPolicyRevision ||
    (nominalPolicy.id === reservation.policyId && nominalPolicy.revision === reservation.policyRevision)
  );
}

function cleanupError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function reservationEligibleInTransaction(
  tx: any,
  reservation: Reservation,
  options: { exactPolicyRevision: boolean },
): Promise<{ reason: string | null; caseRow?: ReservationCase }> {
  const [[caseRow], [document]] = await Promise.all([
    tx.select().from(onbCases).where(and(
      eq(onbCases.organizationId, reservation.organizationId),
      eq(onbCases.id, reservation.caseId),
    )).for("update"),
    tx.select({
      key: onbDocuments.key, label: onbDocuments.label, category: onbDocuments.category,
    }).from(onbDocuments).where(and(
      eq(onbDocuments.organizationId, reservation.organizationId),
      eq(onbDocuments.id, reservation.documentId),
      eq(onbDocuments.caseId, reservation.caseId),
    )).for("update"),
  ]);
  if (
    !caseRow ||
    jurisdictionForWorkforceContext(caseRow.workforceContext) !== reservation.jurisdiction ||
    caseRow.workforceContextVersion !== reservation.workforceContextVersion ||
    !document ||
    sensitiveDataClassForDocument(document) !== reservation.dataClass
  ) {
    return {
      reason: "The server-recorded case context or document classification no longer matches this pending upload.",
    };
  }
  const [manifest] = await tx.select({ id: onbSensitiveObjectManifests.id })
    .from(onbSensitiveObjectManifests).where(and(
      eq(onbSensitiveObjectManifests.organizationId, reservation.organizationId),
      eq(onbSensitiveObjectManifests.objectPath, reservation.objectPath),
      eq(onbSensitiveObjectManifests.dataClass, reservation.dataClass),
      eq(onbSensitiveObjectManifests.caseId, reservation.caseId),
    )).for("update");
  if (!manifest) return { reason: "The pending upload has no durable object manifest; reconciliation fails closed." };

  const policyWhere = [
    eq(onbSensitiveLifecyclePolicies.organizationId, reservation.organizationId),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, reservation.jurisdiction),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    inArray(onbSensitiveLifecyclePolicies.dataClass, OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES),
  ];
  const policies = await tx.select({
    dataClass: onbSensitiveLifecyclePolicies.dataClass,
    id: onbSensitiveLifecyclePolicies.id,
    revision: onbSensitiveLifecyclePolicies.revision,
    providerSharingApproved: onbSensitiveLifecyclePolicies.providerSharingApproved,
    permittedProviders: onbSensitiveLifecyclePolicies.permittedProviders,
  })
    .from(onbSensitiveLifecyclePolicies).where(and(...policyWhere)).for("update");
  if (!hasEveryOpaqueUploadPolicy(policies, reservation, options.exactPolicyRevision)) {
    return {
      reason: options.exactPolicyRevision
        ? "The approved lifecycle policy revision changed while the upload was in flight."
        : "No current server-recorded lifecycle policy authorizes pending-upload reconciliation.",
    };
  }

  const [hold] = await tx.select({ id: onbSensitiveLifecycleHolds.id })
    .from(onbSensitiveLifecycleHolds).where(and(
      eq(onbSensitiveLifecycleHolds.organizationId, reservation.organizationId),
      eq(onbSensitiveLifecycleHolds.active, true),
      or(
        isNull(onbSensitiveLifecycleHolds.dataClass),
        inArray(onbSensitiveLifecycleHolds.dataClass, OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES),
      ),
      or(isNull(onbSensitiveLifecycleHolds.caseId), eq(onbSensitiveLifecycleHolds.caseId, reservation.caseId)),
      or(isNull(onbSensitiveLifecycleHolds.objectPath), eq(onbSensitiveLifecycleHolds.objectPath, reservation.objectPath)),
    )).limit(1);
  if (hold) return { reason: "An active legal/privacy hold retains this pending upload." };
  return { reason: null, caseRow };
}

async function retainForLater(
  tx: any,
  reservation: Reservation,
  ownerToken: string,
  now: Date,
  message: string,
) {
  await tx.update(onbCandidateUploadReservations).set({
    // A held or policy-unresolved reservation remains a positive durable
    // inventory record.  Never delete its manifest before object deletion.
    state: "reserved",
    ownerToken,
    leaseUntil: new Date(now.getTime() + CANDIDATE_UPLOAD_RESERVATION_RETRY_MS),
    lastError: message,
    updatedAt: now,
  }).where(and(
    eq(onbCandidateUploadReservations.id, reservation.id),
    eq(onbCandidateUploadReservations.ownerToken, ownerToken),
  ));
}

export async function reserveCandidateUploadObject(input: {
  organizationId: string;
  caseId: number;
  documentId: number;
  objectPath: string;
  dataClass: SensitiveDataClass;
  jurisdiction: string;
  workforceContextVersion: number;
  policyId: number;
  policyRevision: number;
  now?: Date;
}): Promise<Reservation> {
  const now = input.now ?? new Date();
  const id = randomUUID();
  const ownerToken = randomUUID();
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [[caseRow], [document], policies] = await Promise.all([
      tx.select().from(onbCases).where(and(
        eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId),
      )).for("update"),
      tx.select({ key: onbDocuments.key, label: onbDocuments.label, category: onbDocuments.category })
        .from(onbDocuments).where(and(
          eq(onbDocuments.organizationId, input.organizationId),
          eq(onbDocuments.id, input.documentId),
          eq(onbDocuments.caseId, input.caseId),
        )).for("update"),
      tx.select({
        dataClass: onbSensitiveLifecyclePolicies.dataClass,
        id: onbSensitiveLifecyclePolicies.id,
        revision: onbSensitiveLifecyclePolicies.revision,
        providerSharingApproved: onbSensitiveLifecyclePolicies.providerSharingApproved,
        permittedProviders: onbSensitiveLifecyclePolicies.permittedProviders,
      }).from(onbSensitiveLifecyclePolicies).where(and(
        eq(onbSensitiveLifecyclePolicies.organizationId, input.organizationId),
        eq(onbSensitiveLifecyclePolicies.jurisdiction, input.jurisdiction),
        eq(onbSensitiveLifecyclePolicies.isCurrent, true),
        inArray(onbSensitiveLifecyclePolicies.dataClass, OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES),
      )).for("update"),
    ]);
    if (
      !caseRow ||
      jurisdictionForWorkforceContext(caseRow.workforceContext) !== input.jurisdiction ||
      caseRow.workforceContextVersion !== input.workforceContextVersion ||
      !document ||
      sensitiveDataClassForDocument(document) !== input.dataClass ||
      !hasEveryOpaqueUploadPolicy(policies, input, true)
    ) {
      throw new Error("Candidate upload reservation rejected because the server-recorded case context, classification, or lifecycle policy changed.");
    }
    await tx.insert(onbSensitiveObjectManifests).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      objectPath: input.objectPath,
      dataClass: input.dataClass,
      manifestState: "reconciliation-required",
      updatedAt: now,
    });
    const [reservation] = await tx.insert(onbCandidateUploadReservations).values({
      id,
      organizationId: input.organizationId,
      caseId: input.caseId,
      documentId: input.documentId,
      objectPath: input.objectPath,
      dataClass: input.dataClass,
      jurisdiction: input.jurisdiction,
      workforceContextVersion: input.workforceContextVersion,
      policyId: input.policyId,
      policyRevision: input.policyRevision,
      ownerToken,
      state: "reserved",
      leaseUntil: new Date(now.getTime() + CANDIDATE_UPLOAD_RESERVATION_LEASE_MS),
      updatedAt: now,
    }).returning();
    return reservation!;
  }));
}

/**
 * Atomically turns a reserved inventory record into an upload row and complete
 * manifest.  The caller performs concrete provider authorization immediately
 * before this boundary; this function independently fences class, hold, and
 * policy-revision changes.
 */
export async function finalizeCandidateUploadReservation<T>(input: {
  reservation: Reservation;
  finalize: (tx: any, reservation: Reservation, caseRow: ReservationCase) => Promise<FinalizeResult<T>>;
  now?: Date;
}): Promise<T> {
  const now = input.now ?? new Date();
  return withSensitiveLifecycleFence(input.reservation.organizationId, () => db.transaction(async (tx) => {
    const [reservation] = await tx.select().from(onbCandidateUploadReservations).where(and(
      eq(onbCandidateUploadReservations.id, input.reservation.id),
      eq(onbCandidateUploadReservations.organizationId, input.reservation.organizationId),
      eq(onbCandidateUploadReservations.ownerToken, input.reservation.ownerToken!),
      eq(onbCandidateUploadReservations.state, "reserved"),
    )).for("update");
    if (!reservation) throw new Error("Candidate upload reservation is no longer owned by this request.");
    const eligibility = await reservationEligibleInTransaction(tx, reservation, { exactPolicyRevision: true });
    if (eligibility.reason || !eligibility.caseRow) {
      throw new Error(eligibility.reason ?? "The current candidate case is unavailable for reservation finalization.");
    }
    const [manifest] = await tx.select().from(onbSensitiveObjectManifests).where(and(
      eq(onbSensitiveObjectManifests.organizationId, reservation.organizationId),
      eq(onbSensitiveObjectManifests.objectPath, reservation.objectPath),
      eq(onbSensitiveObjectManifests.dataClass, reservation.dataClass),
      eq(onbSensitiveObjectManifests.caseId, reservation.caseId),
      eq(onbSensitiveObjectManifests.manifestState, "reconciliation-required"),
    )).for("update");
    if (!manifest) throw new Error("Candidate upload reservation has no pending object manifest.");
    const result = await input.finalize(tx, reservation, eligibility.caseRow);
    const [finished] = await tx.update(onbCandidateUploadReservations).set({
      state: "finalized",
      ownerToken: null,
      finalizedUploadId: result.uploadId,
      completedAt: now,
      lastError: null,
      updatedAt: now,
    }).where(and(
      eq(onbCandidateUploadReservations.id, reservation.id),
      eq(onbCandidateUploadReservations.ownerToken, reservation.ownerToken!),
      eq(onbCandidateUploadReservations.state, "reserved"),
    )).returning({ id: onbCandidateUploadReservations.id });
    if (!finished) throw new Error("Candidate upload reservation finalization lost its ownership fence.");
    await tx.update(onbSensitiveObjectManifests).set({
      manifestState: "complete", reconciledAt: now, updatedAt: now,
    }).where(eq(onbSensitiveObjectManifests.id, manifest.id));
    return result.value;
  }));
}

export type CandidateUploadReservationCleanup = {
  state: "cleaned" | "retained" | "skipped";
  error?: Error;
};

export async function compensateCandidateUploadReservation(
  reservationInput: Reservation,
  options: {
    ownerToken?: string;
    now?: Date;
    deleteObject?: (objectPath: string) => Promise<void>;
    /** Only the bounded recovery worker may replace an expired owner lease. */
    reclaimExpired?: boolean;
  } = {},
): Promise<CandidateUploadReservationCleanup> {
  const now = options.now ?? new Date();
  const ownerToken = options.ownerToken ?? reservationInput.ownerToken;
  if (!ownerToken) return { state: "skipped" };
  const deleteObject = options.deleteObject ?? ((path) => getPrivateFile(path).delete({ ignoreNotFound: true }));
  return withSensitiveLifecycleFence(reservationInput.organizationId, async () => {
    const staged = await db.transaction(async (tx) => {
      let [reservation] = await tx.select().from(onbCandidateUploadReservations).where(and(
        eq(onbCandidateUploadReservations.id, reservationInput.id),
        eq(onbCandidateUploadReservations.organizationId, reservationInput.organizationId),
      )).for("update");
      if (!reservation || !["reserved", "cleanup-processing"].includes(reservation.state)) {
        return { state: "skipped" as const };
      }
      if (!reservation.ownerToken) {
        // A malformed legacy row is still inventory, but cannot safely be
        // claimed through an ownership predicate.
        return { state: "retained" as const };
      }
      if (reservation.ownerToken !== ownerToken) {
        if (!options.reclaimExpired || reservation.leaseUntil > now) return { state: "skipped" as const };
        // A crash releases the advisory fence. Rotate the expired owner before
        // deletion so a very late former worker cannot finalize or compensate
        // the same object after this recovery has claimed it.
        const [reclaimed] = await tx.update(onbCandidateUploadReservations).set({
          state: "reserved",
          ownerToken,
          leaseUntil: new Date(now.getTime() + CANDIDATE_UPLOAD_RESERVATION_LEASE_MS),
          updatedAt: now,
        }).where(and(
          eq(onbCandidateUploadReservations.id, reservation.id),
          eq(onbCandidateUploadReservations.ownerToken, reservation.ownerToken!),
          inArray(onbCandidateUploadReservations.state, ["reserved", "cleanup-processing"]),
          lte(onbCandidateUploadReservations.leaseUntil, now),
        )).returning();
        if (!reclaimed) return { state: "skipped" as const };
        reservation = reclaimed;
      }
      const eligibility = await reservationEligibleInTransaction(tx, reservation, { exactPolicyRevision: false });
      if (eligibility.reason) {
        await retainForLater(tx, reservation, ownerToken, now, eligibility.reason);
        return { state: "retained" as const };
      }
      const [claimed] = await tx.update(onbCandidateUploadReservations).set({
        state: "cleanup-processing",
        ownerToken,
        leaseUntil: new Date(now.getTime() + CANDIDATE_UPLOAD_RESERVATION_LEASE_MS),
        lastError: null,
        updatedAt: now,
      }).where(and(
        eq(onbCandidateUploadReservations.id, reservation.id),
        eq(onbCandidateUploadReservations.ownerToken, ownerToken),
        inArray(onbCandidateUploadReservations.state, ["reserved", "cleanup-processing"]),
      )).returning();
      return claimed ? { state: "ready" as const, reservation: claimed } : { state: "skipped" as const };
    });
    if (staged.state !== "ready") return staged;
    try {
      await deleteObject(staged.reservation.objectPath);
    } catch (error) {
      const message = cleanupError(error);
      await db.update(onbCandidateUploadReservations).set({
        state: "reserved",
        ownerToken,
        leaseUntil: new Date(now.getTime() + CANDIDATE_UPLOAD_RESERVATION_RETRY_MS),
        lastError: message,
        updatedAt: now,
      }).where(and(
        eq(onbCandidateUploadReservations.id, staged.reservation.id),
        eq(onbCandidateUploadReservations.ownerToken, ownerToken),
        eq(onbCandidateUploadReservations.state, "cleanup-processing"),
      ));
      // Deliberately leave the pending manifest in place on all storage errors.
      return { state: "retained", error: error instanceof Error ? error : new Error(message) };
    }
    const finalized = await db.transaction(async (tx) => {
      const [reservation] = await tx.select().from(onbCandidateUploadReservations).where(and(
        eq(onbCandidateUploadReservations.id, staged.reservation.id),
        eq(onbCandidateUploadReservations.organizationId, staged.reservation.organizationId),
        eq(onbCandidateUploadReservations.ownerToken, ownerToken),
        eq(onbCandidateUploadReservations.state, "cleanup-processing"),
      )).for("update");
      if (!reservation) return "skipped" as const;
      const eligibility = await reservationEligibleInTransaction(tx, reservation, { exactPolicyRevision: false });
      if (eligibility.reason) {
        // A hold writer uses the same tenant fence, so it cannot race between
        // the pre-delete check and this positive terminal reconciliation.
        await retainForLater(tx, reservation, ownerToken, now, eligibility.reason);
        return "retained" as const;
      }
      const [completed] = await tx.update(onbCandidateUploadReservations).set({
        state: "cleanup-completed",
        ownerToken: null,
        completedAt: now,
        lastError: null,
        updatedAt: now,
      }).where(and(
        eq(onbCandidateUploadReservations.id, reservation.id),
        eq(onbCandidateUploadReservations.ownerToken, ownerToken),
        eq(onbCandidateUploadReservations.state, "cleanup-processing"),
      )).returning({ id: onbCandidateUploadReservations.id });
      if (!completed) return "skipped" as const;
      await tx.delete(onbSensitiveObjectManifests).where(and(
        eq(onbSensitiveObjectManifests.organizationId, reservation.organizationId),
        eq(onbSensitiveObjectManifests.objectPath, reservation.objectPath),
      ));
      return "cleaned" as const;
    });
    return { state: finalized };
  });
}

/**
 * Holds the tenant lifecycle fence across storage save, final metadata write,
 * and compensation. A timed-out request therefore cannot be reclaimed while
 * its original save can still complete in this live process.
 */
export async function saveReservedCandidateUpload<T>(input: {
  reservation: Parameters<typeof reserveCandidateUploadObject>[0];
  save: () => Promise<void>;
  finalize: (reservation: Reservation) => Promise<T>;
  deleteObject?: (objectPath: string) => Promise<void>;
}): Promise<T> {
  return withSensitiveLifecycleFence(input.reservation.organizationId, async () => {
    const reservation = await reserveCandidateUploadObject(input.reservation);
    try {
      // This is the last reservation/context check before invoking the storage
      // callback. The surrounding tenant lifecycle fence excludes a governed
      // workforce-context change between this check and the provider boundary.
      const current = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(onbCandidateUploadReservations).where(and(
          eq(onbCandidateUploadReservations.id, reservation.id),
          eq(onbCandidateUploadReservations.organizationId, reservation.organizationId),
          eq(onbCandidateUploadReservations.ownerToken, reservation.ownerToken!),
          eq(onbCandidateUploadReservations.state, "reserved"),
        )).for("update");
        if (!locked) throw new Error("Candidate upload reservation is no longer owned by this request.");
        const eligibility = await reservationEligibleInTransaction(tx, locked, { exactPolicyRevision: true });
        if (eligibility.reason) throw new Error(eligibility.reason);
        return locked;
      });
      await input.save();
      return await input.finalize(current);
    } catch (error) {
      const compensation = await compensateCandidateUploadReservation(reservation, {
        deleteObject: input.deleteObject,
      });
      if (compensation.error) {
        throw new AggregateError([error, compensation.error], "Candidate upload failed and object compensation failed");
      }
      throw error;
    }
  });
}

/** Bounded crash recovery for reservations whose owner lease expired. */
export async function recoverPendingCandidateUploadReservations(options: {
  now?: Date;
  limit?: number;
  /** Internal lifecycle-worker/test scope; public callers never supply this. */
  organizationId?: string;
  deleteObject?: (objectPath: string) => Promise<void>;
} = {}) {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const reservations = await db.select().from(onbCandidateUploadReservations).where(and(
    inArray(onbCandidateUploadReservations.state, ["reserved", "cleanup-processing"]),
    lte(onbCandidateUploadReservations.leaseUntil, now),
    options.organizationId
      ? eq(onbCandidateUploadReservations.organizationId, options.organizationId)
      : undefined,
  )).orderBy(onbCandidateUploadReservations.createdAt).limit(limit);
  let cleaned = 0;
  let retained = 0;
  for (const reservation of reservations) {
    const result = await compensateCandidateUploadReservation(reservation, {
      ownerToken: randomUUID(),
      now,
      deleteObject: options.deleteObject,
      reclaimExpired: true,
    });
    if (result.state === "cleaned") cleaned += 1;
    if (result.state === "retained") retained += 1;
  }
  return { examined: reservations.length, cleaned, retained };
}