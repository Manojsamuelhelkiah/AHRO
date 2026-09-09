import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  objectCleanupJobsTable,
  scenarioFilesTable,
  scenarioUploadIntentsTable,
} from "@workspace/db";
import { getPrivateFile } from "./objectStorage";

export const UPLOAD_INTENT_TTL_MS = 2 * 60_000;
export const MAX_PENDING_UPLOAD_INTENTS_PER_OWNER = 8;
export const MAX_PENDING_UPLOAD_BYTES_PER_OWNER = 40 * 1024 * 1024;
export const ACTIVE_UPLOAD_INTENT_STATUSES = ["pending", "uploading", "uploaded", "processing"] as const;

export function uploadTransitionAllowed(from: string, to: string): boolean {
  return (from === "pending" && to === "uploading") ||
    (from === "uploading" && (to === "pending" || to === "uploaded")) ||
    (from === "uploaded" && to === "processing") ||
    (from === "processing" && to === "finalized") ||
    (["pending", "uploading", "uploaded", "processing", "finalized", "cleaning"].includes(from) && to === "cleaning");
}

export function cleanupFenceEligible(
  status: string,
  expiresAtMs: number,
  processingAtMs: number | null,
  cleaningAtMs: number | null,
  nowMs: number,
  staleMs = 5 * 60_000,
): boolean {
  if (status === "finalized") return true;
  if (["pending", "uploading", "uploaded"].includes(status)) return expiresAtMs < nowMs;
  if (status === "processing") return processingAtMs !== null && processingAtMs < nowMs - staleMs;
  return status === "cleaning" && cleaningAtMs !== null && cleaningAtMs < nowMs - staleMs;
}

export function pendingUploadQuotaExceeded(
  count: number,
  declaredBytes: number,
  nextBytes: number,
): boolean {
  return count >= MAX_PENDING_UPLOAD_INTENTS_PER_OWNER ||
    declaredBytes + nextBytes > MAX_PENDING_UPLOAD_BYTES_PER_OWNER;
}

export async function cleanupExpiredScenarioUploadIntents(limit = 25): Promise<number> {
  const now = new Date();
  const staleProcessingCutoff = new Date(now.getTime() - 5 * 60_000);
  const staleCleaningCutoff = staleProcessingCutoff;
  const expired = await db.select().from(scenarioUploadIntentsTable)
    .where(or(
      and(
        inArray(scenarioUploadIntentsTable.status, ["pending", "uploading", "uploaded"]),
        lt(scenarioUploadIntentsTable.expiresAt, now),
      ),
      and(
        eq(scenarioUploadIntentsTable.status, "processing"),
        isNotNull(scenarioUploadIntentsTable.processingAt),
        lt(scenarioUploadIntentsTable.processingAt, staleProcessingCutoff),
      ),
      eq(scenarioUploadIntentsTable.status, "finalized"),
      and(
        eq(scenarioUploadIntentsTable.status, "cleaning"),
        isNotNull(scenarioUploadIntentsTable.cleaningAt),
        lt(scenarioUploadIntentsTable.cleaningAt, staleCleaningCutoff),
      ),
    ))
    .orderBy(scenarioUploadIntentsTable.expiresAt)
    .limit(limit);
  let cleaned = 0;
  for (const intent of expired) {
    try {
      const stalePredicate = intent.status === "processing"
        ? and(isNotNull(scenarioUploadIntentsTable.processingAt), lt(scenarioUploadIntentsTable.processingAt, staleProcessingCutoff))
        : intent.status === "cleaning"
          ? and(isNotNull(scenarioUploadIntentsTable.cleaningAt), lt(scenarioUploadIntentsTable.cleaningAt, staleCleaningCutoff))
          : intent.status === "finalized"
            ? undefined
            : lt(scenarioUploadIntentsTable.expiresAt, now);
      const [claimed] = await db.update(scenarioUploadIntentsTable).set({
        status: "cleaning",
        cleaningAt: now,
      }).where(and(
        eq(scenarioUploadIntentsTable.id, intent.id),
        eq(scenarioUploadIntentsTable.status, intent.status),
        stalePredicate,
      )).returning();
      if (!claimed) continue;
      const [active] = claimed.finalObjectPath
        ? await db.select({ id: scenarioFilesTable.id }).from(scenarioFilesTable)
            .where(eq(scenarioFilesTable.objectPath, claimed.finalObjectPath))
        : [];
      await getPrivateFile(claimed.objectPath).delete({ ignoreNotFound: true });
      if (!active && claimed.finalObjectPath) {
        await getPrivateFile(claimed.finalObjectPath).delete({ ignoreNotFound: true });
      }
      const deleted = await db.delete(scenarioUploadIntentsTable).where(and(
        eq(scenarioUploadIntentsTable.id, claimed.id),
        eq(scenarioUploadIntentsTable.status, "cleaning"),
      )).returning({ id: scenarioUploadIntentsTable.id });
      cleaned += deleted.length;
    } catch {
      // Keep the durable intent so a later tick retries object deletion.
    }
  }
  return cleaned;
}

export async function processObjectCleanupJobs(limit = 25): Promise<number> {
  const jobs = await db.select().from(objectCleanupJobsTable)
    .orderBy(objectCleanupJobsTable.createdAt)
    .limit(limit);
  let cleaned = 0;
  for (const job of jobs) {
    try {
      await getPrivateFile(job.objectPath).delete({ ignoreNotFound: true });
      const deleted = await db.delete(objectCleanupJobsTable)
        .where(eq(objectCleanupJobsTable.id, job.id))
        .returning({ id: objectCleanupJobsTable.id });
      cleaned += deleted.length;
    } catch (error) {
      await db.update(objectCleanupJobsTable).set({
        attempts: sql`${objectCleanupJobsTable.attempts} + 1`,
        lastError: error instanceof Error ? error.message.slice(0, 1000) : "Object deletion failed",
        updatedAt: new Date(),
      }).where(eq(objectCleanupJobsTable.id, job.id));
    }
  }
  return cleaned;
}

export async function runScenarioFileMaintenance(): Promise<{
  expiredUploads: number;
  deletedObjects: number;
}> {
  const [expiredUploads, deletedObjects] = await Promise.all([
    cleanupExpiredScenarioUploadIntents(),
    processObjectCleanupJobs(),
  ]);
  return { expiredUploads, deletedObjects };
}