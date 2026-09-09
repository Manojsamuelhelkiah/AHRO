import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateScenarioFileUploadIntentBody,
  CreateScenarioFileUploadIntentResponse,
  DeleteScenarioFileParams,
  FinalizeScenarioFileBody,
  FinalizeScenarioFileResponse,
  ListScenarioFilesParams,
  ListScenarioFilesResponse,
  UploadScenarioFileContentParams,
} from "@workspace/api-zod";
import { db, objectCleanupJobsTable, scenarioFilesTable, scenariosTable, scenarioUploadIntentsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/require-auth";
import { setObjectAclPolicy, isObjectOwner } from "../lib/objectAcl";
import {
  getPrivateFile,
  isOwnedUploadPath,
  promoteScenarioFile,
  scenarioFinalObjectPath,
  scenarioUploadObjectPath,
} from "../lib/objectStorage";
import {
  validateDeclaredScenarioFile,
  validateScenarioFileContent,
  MAX_SCENARIO_FILE_BYTES,
} from "../lib/scenario-file-safety";
import {
  cleanupExpiredScenarioUploadIntents,
  pendingUploadQuotaExceeded,
  processObjectCleanupJobs,
} from "../lib/scenario-file-lifecycle";
import { streamScenarioFileDownload } from "../lib/scenario-file-download";
import {
  getOrganizationId,
  organizationValues,
  organizationWhere,
} from "../lib/organization-scope";

const router: IRouter = Router();

function serialize(row: typeof scenarioFilesTable.$inferSelect) {
  return {
    id: row.id,
    scenarioId: row.scenarioId,
    originalName: row.originalName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

async function ownedScenarioExists(
  id: number,
  ownerUserId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db.select({ id: scenariosTable.id }).from(scenariosTable)
    .where(and(
      eq(scenariosTable.id, id),
      organizationWhere(scenariosTable, organizationId),
      eq(scenariosTable.ownerUserId, ownerUserId),
    ));
  return Boolean(row);
}

async function accessibleScenarioExists(
  id: number,
  ownerUserId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db.select({ id: scenariosTable.id }).from(scenariosTable)
    .where(and(
      eq(scenariosTable.id, id),
      organizationWhere(scenariosTable, organizationId),
      or(eq(scenariosTable.ownerUserId, ownerUserId), isNull(scenariosTable.ownerUserId)),
    ));
  return Boolean(row);
}

router.post("/scenario-files/upload-intents", requireAuth, async (req, res, next) => {
  try {
    await cleanupExpiredScenarioUploadIntents();
    await processObjectCleanupJobs();
    const body = CreateScenarioFileUploadIntentBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    const declared = validateDeclaredScenarioFile(body.name, body.contentType, body.size);
    const id = randomUUID();
    const objectPath = scenarioUploadObjectPath(req.authUserId!, id);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${organizationId}:${req.authUserId!}`}))`);
      const [usage] = await tx.select({
        count: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${scenarioUploadIntentsTable.sizeBytes}), 0)::int`,
      }).from(scenarioUploadIntentsTable).where(and(
        organizationWhere(scenarioUploadIntentsTable, organizationId),
        eq(scenarioUploadIntentsTable.ownerUserId, req.authUserId!),
        inArray(scenarioUploadIntentsTable.status, ["pending", "uploading", "uploaded", "processing"]),
        gt(scenarioUploadIntentsTable.expiresAt, new Date()),
      ));
      if (pendingUploadQuotaExceeded(usage?.count ?? 0, usage?.bytes ?? 0, body.size)) {
        throw new Error("Pending upload quota exceeded; finish or wait for current uploads to expire");
      }
      await tx.insert(scenarioUploadIntentsTable).values({
        id,
        ...organizationValues(organizationId),
        ownerUserId: req.authUserId!,
        objectPath,
        finalObjectPath: scenarioFinalObjectPath(req.authUserId!, id),
        originalName: body.name,
        contentType: declared.contentType,
        sizeBytes: body.size,
        expiresAt: new Date(Date.now() + 2 * 60_000),
      });
    });
    const intent = {
      uploadUrl: `/api/scenario-files/upload-intents/${id}/content`,
      objectPath,
    };
    res.json(CreateScenarioFileUploadIntentResponse.parse(intent));
  } catch (error) {
    if (error instanceof Error && /pending upload quota/i.test(error.message)) {
      res.status(429).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /supported|size|name/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.put("/scenario-files/upload-intents/:intentId/content", requireAuth, async (req, res, next) => {
  try {
    await cleanupExpiredScenarioUploadIntents();
    const { intentId } = UploadScenarioFileContentParams.parse(req.params);
    const organizationId = getOrganizationId(req);
    const [declaration] = await db.select().from(scenarioUploadIntentsTable).where(and(
      eq(scenarioUploadIntentsTable.id, intentId),
      organizationWhere(scenarioUploadIntentsTable, organizationId),
      eq(scenarioUploadIntentsTable.ownerUserId, req.authUserId!),
      eq(scenarioUploadIntentsTable.status, "pending"),
      gt(scenarioUploadIntentsTable.expiresAt, new Date()),
    ));
    if (!declaration) {
      res.status(409).json({ error: "Upload intent is expired, already used, or currently in progress" });
      return;
    }
    if (!req.is("application/octet-stream")) {
      const error = new Error("Upload transport Content-Type must be application/octet-stream");
      error.name = "UnsupportedUploadMediaTypeError";
      throw error;
    }
    const declaredLength = Number(req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SCENARIO_FILE_BYTES) {
      const error = new Error("Uploaded body exceeds the maximum file size");
      error.name = "UploadTooLargeError";
      throw error;
    }
    if (Number.isFinite(declaredLength) && declaredLength !== declaration.sizeBytes) {
      throw new Error("Content-Length does not match the declared upload size");
    }
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += bytes.length;
      if (bytesRead > MAX_SCENARIO_FILE_BYTES || bytesRead > declaration.sizeBytes) {
        const error = new Error("Uploaded body exceeds the declared or maximum file size");
        error.name = "UploadTooLargeError";
        throw error;
      }
      chunks.push(bytes);
    }
    if (bytesRead !== declaration.sizeBytes) throw new Error("Uploaded byte count does not match the declared upload size");
    await db.transaction(async (tx) => {
      const [claimed] = await tx.update(scenarioUploadIntentsTable).set({ status: "uploading" }).where(and(
        eq(scenarioUploadIntentsTable.id, intentId),
        organizationWhere(scenarioUploadIntentsTable, organizationId),
        eq(scenarioUploadIntentsTable.ownerUserId, req.authUserId!),
        eq(scenarioUploadIntentsTable.status, "pending"),
        gt(scenarioUploadIntentsTable.expiresAt, new Date()),
      )).returning();
      if (!claimed) {
        const error = new Error("Upload intent is expired, already used, or currently in progress");
        error.name = "UploadIntentConflictError";
        throw error;
      }
      await getPrivateFile(claimed.objectPath).save(Buffer.concat(chunks), {
        contentType: claimed.contentType,
        resumable: false,
      });
      const transitioned = await tx.update(scenarioUploadIntentsTable).set({ status: "uploaded" }).where(and(
        eq(scenarioUploadIntentsTable.id, claimed.id),
        organizationWhere(scenarioUploadIntentsTable, organizationId),
        eq(scenarioUploadIntentsTable.ownerUserId, req.authUserId!),
        eq(scenarioUploadIntentsTable.status, "uploading"),
      )).returning({ id: scenarioUploadIntentsTable.id });
      if (transitioned.length !== 1) throw new Error("Upload lifecycle transition failed");
    });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.name === "UploadTooLargeError") {
      res.status(413).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.name === "UnsupportedUploadMediaTypeError") {
      res.status(415).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /Content-Length|byte count/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.name === "UploadIntentConflictError") {
      res.status(409).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.post("/scenario-files/finalize", requireAuth, async (req, res, next) => {
  try {
    await cleanupExpiredScenarioUploadIntents();
    await processObjectCleanupJobs();
    const body = FinalizeScenarioFileBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    const declared = validateDeclaredScenarioFile(body.name, body.contentType, body.size);
    if (!isOwnedUploadPath(body.objectPath, req.authUserId!)) {
      res.status(404).json({ error: "Uploaded object not found" });
      return;
    }
    if (
      body.scenarioId &&
      !(await ownedScenarioExists(body.scenarioId, req.authUserId!, organizationId))
    ) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    const row = await db.transaction(async (tx) => {
      const [claimed] = await tx.update(scenarioUploadIntentsTable).set({
        status: "processing",
        processingAt: new Date(),
      }).where(and(
        organizationWhere(scenarioUploadIntentsTable, organizationId),
        eq(scenarioUploadIntentsTable.ownerUserId, req.authUserId!),
        eq(scenarioUploadIntentsTable.objectPath, body.objectPath),
        eq(scenarioUploadIntentsTable.originalName, body.name),
        eq(scenarioUploadIntentsTable.contentType, declared.contentType),
        eq(scenarioUploadIntentsTable.sizeBytes, body.size),
        eq(scenarioUploadIntentsTable.status, "uploaded"),
        gt(scenarioUploadIntentsTable.expiresAt, new Date()),
      )).returning();
      if (!claimed) {
        const error = new Error("Upload intent is expired, already finalized, or does not match its declaration");
        error.name = "UploadIntentConflictError";
        throw error;
      }
      if (!claimed.finalObjectPath) throw new Error("Upload intent has no reserved final object path");
      const stagingFile = getPrivateFile(claimed.objectPath);
      const finalFile = getPrivateFile(claimed.finalObjectPath);
      const [[stagingExists], [finalExists]] = await Promise.all([stagingFile.exists(), finalFile.exists()]);
      const sourceFile = finalExists ? finalFile : stagingExists ? stagingFile : undefined;
      if (!sourceFile) throw new Error("Uploaded object not found");
      const [metadata] = await sourceFile.getMetadata();
      const actualSize = Number(metadata.size);
      const actualType = String(metadata.contentType ?? "").toLowerCase();
      if (actualSize !== body.size || actualType !== declared.contentType) {
        throw new Error("Uploaded object metadata does not match the upload intent");
      }
      const [bytes] = await sourceFile.download();
      validateScenarioFileContent(declared.extension, bytes);
      const promoted = finalExists
        ? { file: finalFile, objectPath: claimed.finalObjectPath }
        : await promoteScenarioFile(stagingFile, claimed.finalObjectPath);
      await setObjectAclPolicy(promoted.file, {
        owner: req.authUserId!,
        visibility: "private",
      });

      let result: typeof scenarioFilesTable.$inferSelect;
      if (body.replaceFileId) {
        const [existing] = await tx.select().from(scenarioFilesTable).where(and(
          eq(scenarioFilesTable.id, body.replaceFileId!),
          organizationWhere(scenarioFilesTable, organizationId),
          eq(scenarioFilesTable.ownerUserId, req.authUserId!),
        )).for("update");
        if (!existing) throw new Error("File to replace not found");
        if (body.scenarioId !== undefined && existing.scenarioId !== body.scenarioId) {
          throw new Error("Replacement file must remain linked to its current scenario");
        }
        const [updated] = await tx.update(scenarioFilesTable).set({
          objectPath: promoted.objectPath,
          originalName: body.name,
          contentType: declared.contentType,
          sizeBytes: actualSize,
          updatedAt: new Date(),
        }).where(and(
          eq(scenarioFilesTable.id, existing.id),
          organizationWhere(scenarioFilesTable, organizationId),
          eq(scenarioFilesTable.ownerUserId, req.authUserId!),
        )).returning();
        if (!updated) throw new Error("File replacement transition failed");
        await tx.insert(objectCleanupJobsTable).values({ objectPath: existing.objectPath }).onConflictDoNothing();
        result = updated;
      } else {
        if (body.scenarioId !== undefined) {
          const [scenario] = await tx.select({ id: scenariosTable.id }).from(scenariosTable).where(and(
            eq(scenariosTable.id, body.scenarioId),
            organizationWhere(scenariosTable, organizationId),
            eq(scenariosTable.ownerUserId, req.authUserId!),
          )).for("update");
          if (!scenario) throw new Error("Scenario not found");
        }
        const [created] = await tx.insert(scenarioFilesTable).values({
          ...organizationValues(organizationId),
          ownerUserId: req.authUserId!,
          scenarioId: body.scenarioId ?? null,
          objectPath: promoted.objectPath,
          originalName: body.name,
          contentType: declared.contentType,
          sizeBytes: actualSize,
        }).returning();
        if (!created) throw new Error("File metadata creation failed");
        result = created;
      }
      const finalized = await tx.update(scenarioUploadIntentsTable).set({
        status: "finalized",
        finalizedAt: new Date(),
      }).where(and(
        eq(scenarioUploadIntentsTable.id, claimed.id),
        organizationWhere(scenarioUploadIntentsTable, organizationId),
        eq(scenarioUploadIntentsTable.status, "processing"),
      )).returning({ id: scenarioUploadIntentsTable.id });
      if (finalized.length !== 1) throw new Error("Finalize lifecycle transition failed");
      return result;
    });
    await processObjectCleanupJobs();
    res.status(201).json(FinalizeScenarioFileResponse.parse(serialize(row)));
  } catch (error) {
    if (error instanceof Error && error.name === "UploadIntentConflictError") {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /supported|size|name|signature|plain text|safe text|encoded|active|embedded|package|macro|external link|formula|content|xml|docx/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get("/scenarios/:id/files", requireAuth, async (req, res, next) => {
  try {
    const { id } = ListScenarioFilesParams.parse(req.params);
    const organizationId = getOrganizationId(req);
    if (!(await accessibleScenarioExists(id, req.authUserId!, organizationId))) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    const rows = await db.select().from(scenarioFilesTable).where(and(
      organizationWhere(scenarioFilesTable, organizationId),
      eq(scenarioFilesTable.scenarioId, id),
      eq(scenarioFilesTable.ownerUserId, req.authUserId!),
    )).orderBy(scenarioFilesTable.createdAt);
    res.json(ListScenarioFilesResponse.parse(rows.map(serialize)));
  } catch (error) {
    next(error);
  }
});

router.get("/scenario-files/:id/download", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const organizationId = getOrganizationId(req);
    const [row] = await db.select().from(scenarioFilesTable).where(and(
      eq(scenarioFilesTable.id, id),
      organizationWhere(scenarioFilesTable, organizationId),
      eq(scenarioFilesTable.ownerUserId, req.authUserId!),
    ));
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const file = getPrivateFile(row.objectPath);
    if (!(await isObjectOwner(file, req.authUserId!))) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.setHeader("Content-Type", row.contentType);
    res.setHeader("Content-Length", String(row.sizeBytes));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(row.originalName)}`,
    );
    await streamScenarioFileDownload(file.createReadStream(), res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    next(error);
  }
});

router.delete("/scenario-files/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = DeleteScenarioFileParams.parse(req.params);
    const organizationId = getOrganizationId(req);
    const existing = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(scenarioFilesTable).where(and(
        eq(scenarioFilesTable.id, id),
        organizationWhere(scenarioFilesTable, organizationId),
        eq(scenarioFilesTable.ownerUserId, req.authUserId!),
      )).for("update");
      if (!row) return undefined;
      await tx.insert(objectCleanupJobsTable).values({ objectPath: row.objectPath }).onConflictDoNothing();
      await tx.delete(scenarioFilesTable).where(and(
        eq(scenarioFilesTable.id, id),
        organizationWhere(scenarioFilesTable, organizationId),
        eq(scenarioFilesTable.ownerUserId, req.authUserId!),
      ));
      return row;
    });
    if (!existing) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    await processObjectCleanupJobs();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;