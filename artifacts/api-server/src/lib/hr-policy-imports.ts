import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, onbHrPolicyImports } from "@workspace/db";
import { getPrivateFile, ownerStorageKey } from "./objectStorage";
import { HrPolicyError, requirePolicyMaintainer } from "./hr-policy-library";
import { configuredMalwareScanner } from "./onboarding/malware-scanner";
import { extractPolicyDocument, policyDocumentFormat } from "./hr-policy-document-extraction";

type ImportDependencies = {
  store: (path: string, bytes: Buffer) => Promise<void>;
  scan: (bytes: Buffer) => Promise<string>;
  extract: typeof extractPolicyDocument;
};
const productionDependencies: ImportDependencies = {
  store: async (path, bytes) => {
    await getPrivateFile(path).save(bytes, {
      resumable: false, contentType: "application/octet-stream",
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { cacheControl: "private, no-store" },
    });
  },
  scan: async (bytes) => {
    const scanner = configuredMalwareScanner();
    return scanner ? scanner.scan(bytes, AbortSignal.timeout(20000)) : "unavailable";
  },
  extract: extractPolicyDocument,
};
export async function authorizePolicyImport(organizationId: string, userId: string) {
  await db.transaction((tx) => requirePolicyMaintainer(tx, organizationId, userId));
}

function preview(row: typeof onbHrPolicyImports.$inferSelect) {
  return {
    importId: row.id, status: row.status, filename: row.filename, mediaType: row.mediaType,
    byteSize: row.byteSize, sha256: row.sha256, uploadedAt: row.createdAt.toISOString(),
    malwareVerdict: row.malwareVerdict, authenticity: "not_verified" as const,
    text: row.status === "ready" ? row.extraction?.text ?? null : null,
    extractor: row.extraction?.extractor ?? null,
    warnings: row.extraction?.warnings ?? [
      row.malwareVerdict === "unavailable" ? "Private malware scanning is unavailable. Configure and validate the approved private scanner before re-uploading."
        : row.malwareVerdict === "clean" ? "Malware scan was clean, but text extraction failed or the document is unsupported, encrypted, empty, active, or exceeds limits."
        : "File did not clear private storage and malware checks.",
      "File remains quarantined. It cannot be used as policy guidance or saved as an imported draft.",
    ],
  };
}

export async function getPolicyImport(organizationId: string, userId: string, id: string) {
  return db.transaction(async (tx) => {
    await requirePolicyMaintainer(tx, organizationId, userId);
    const [row] = await tx.select().from(onbHrPolicyImports).where(and(
      eq(onbHrPolicyImports.id, id), eq(onbHrPolicyImports.organizationId, organizationId),
      eq(onbHrPolicyImports.uploadedByUserId, userId),
    )).for("update");
    if (!row) throw new HrPolicyError("Policy import not found.", 404);
    return preview(row);
  });
}

export async function uploadPolicyImport(organizationId: string, userId: string, file: { originalname: string; mimetype: string; buffer: Buffer }, dependencies: ImportDependencies = productionDependencies) {
  const filename = file.originalname.replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 180);
  let format;
  try { format = policyDocumentFormat(filename, file.mimetype, file.buffer); }
  catch (error) { throw new HrPolicyError((error as Error).message); }
  const id = randomUUID();
  const objectPath = `/objects/hr-policy-imports/${ownerStorageKey(organizationId)}/${id}`;
  // Reserve the object path durably BEFORE writing bytes. Nothing serves this
  // namespace; quarantine cannot be bypassed by a signed URL or human approval.
  await db.transaction(async (tx) => {
    await requirePolicyMaintainer(tx, organizationId, userId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`policy-import:${organizationId}:${userId}`}, 0))`);
    const recent = await tx.select({ id: onbHrPolicyImports.id }).from(onbHrPolicyImports).where(and(
      eq(onbHrPolicyImports.organizationId, organizationId), eq(onbHrPolicyImports.uploadedByUserId, userId),
      gt(onbHrPolicyImports.createdAt, new Date(Date.now() - 86400000)),
    ));
    if (recent.length >= 20) throw new HrPolicyError("Daily document import limit reached (20 files).", 409);
    await tx.insert(onbHrPolicyImports).values({
      id, organizationId, uploadedByUserId: userId, filename, mediaType: file.mimetype,
      byteSize: file.buffer.length, sha256: createHash("sha256").update(file.buffer).digest("hex"),
      objectPath, status: "processing",
    });
  });
  let verdict = "pending";
  let extraction: { text: string; extractor: string; warnings: string[] } | null = null;
  try {
    await dependencies.store(objectPath, file.buffer);
    verdict = await dependencies.scan(file.buffer);
    if (verdict === "clean") extraction = await dependencies.extract(file.buffer, format);
  } catch {
    // No raw parser errors or document contents in logs/responses.
    if (verdict === "pending") verdict = "storage_failed";
  }
  // Re-check live authority before making extraction visible. On revocation
  // the durable processing record stays inaccessible and unusable.
  await db.transaction(async (tx) => {
    await requirePolicyMaintainer(tx, organizationId, userId);
    await tx.select().from(onbHrPolicyImports).where(eq(onbHrPolicyImports.id, id)).for("update");
    await tx.update(onbHrPolicyImports).set({
      status: extraction ? "ready" : "quarantined", malwareVerdict: verdict, extraction,
    }).where(and(eq(onbHrPolicyImports.id, id), eq(onbHrPolicyImports.status, "processing")));
  });
  return getPolicyImport(organizationId, userId, id);
}

export async function discardPolicyImport(organizationId: string, userId: string, id: string) {
  return db.transaction(async (tx) => {
    await requirePolicyMaintainer(tx, organizationId, userId);
    const [row] = await tx.select().from(onbHrPolicyImports).where(and(
      eq(onbHrPolicyImports.id, id), eq(onbHrPolicyImports.organizationId, organizationId),
      eq(onbHrPolicyImports.uploadedByUserId, userId),
    )).for("update");
    if (!row) throw new HrPolicyError("Policy import not found.", 404);
    if (row.status === "consumed" || row.status === "processing") throw new HrPolicyError("An attached or processing source cannot be discarded.", 409);
    // Use the same row fence as draft attachment. Sources attached to governed
    // versions are retained, never deleted through the staging endpoint.
    await getPrivateFile(row.objectPath).delete({ ignoreNotFound: true });
    await tx.update(onbHrPolicyImports).set({ status: "discarded", extraction: null }).where(eq(onbHrPolicyImports.id, id));
    return { discarded: true };
  });
}
