import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbCandidateUploads, onbCaseLogistics, onbCases, onbDocuments,
} from "@workspace/db/schema";
import { getPrivateFile } from "../lib/objectStorage";
import {
  CANDIDATE_COOKIE, MAX_CANDIDATE_FILE_BYTES, candidateContext,
  candidateExchangeClientKey, candidateExchangeLimiter, candidateObjectPath,
  detectCandidateFile, exchangeToken,
} from "../lib/onboarding/candidate-portal";

const router: IRouter = Router();
const invalid = (res: any) => res.status(401).json({ message: "This portal link is invalid or has expired" });

router.post("/candidate/session", async (req, res, next) => {
  try {
    const clientKey = candidateExchangeClientKey(req);
    const retryAfterMs = await candidateExchangeLimiter.retryAfterMs(clientKey);
    if (retryAfterMs > 0) {
      res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ message: "Too many attempts. Try again shortly." });
    }
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (token.length < 32 || token.length > 200) {
      await candidateExchangeLimiter.recordFailure(clientKey);
      return invalid(res);
    }
    const session = await exchangeToken(token);
    if (!session) {
      await candidateExchangeLimiter.recordFailure(clientKey);
      return invalid(res);
    }
    await candidateExchangeLimiter.clear(clientKey);
    res.cookie(CANDIDATE_COOKIE, session.secret, {
      httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "strict", path: "/api/candidate", expires: session.expiresAt,
    });
    res.status(204).send();
  } catch (error) { next(error); }
});

router.get("/candidate/portal", async (req, res, next) => {
  try {
    const ctx = await candidateContext(req);
    if (!ctx) return invalid(res);
    const [[c], [logistics], documents] = await Promise.all([
      db.select({ workerName: onbCases.workerName, role: onbCases.role, department: onbCases.department, joiningDate: onbCases.joiningDate })
        .from(onbCases).where(and(eq(onbCases.organizationId, ctx.organizationId), eq(onbCases.id, ctx.caseId))),
      db.select().from(onbCaseLogistics).where(and(eq(onbCaseLogistics.organizationId, ctx.organizationId), eq(onbCaseLogistics.caseId, ctx.caseId))),
      db.select({ id: onbDocuments.id, label: onbDocuments.label, required: onbDocuments.required, status: onbDocuments.status, note: onbDocuments.note })
        .from(onbDocuments).where(and(eq(onbDocuments.organizationId, ctx.organizationId), eq(onbDocuments.caseId, ctx.caseId))).orderBy(onbDocuments.id),
    ]);
    if (!c) return invalid(res);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ case: c, logistics: logistics ?? null, documents });
  } catch (error) { next(error); }
});

router.post("/candidate/documents/:documentId/upload", async (req, res, next) => {
  try {
    const ctx = await candidateContext(req);
    if (!ctx) return invalid(res);
    const documentId = Number(req.params.documentId);
    const originalName = String(req.header("x-file-name") ?? "").trim();
    const declaredType = String(req.header("x-file-type") ?? "").toLowerCase();
    if (!Number.isInteger(documentId) || !originalName || originalName.length > 255) return res.status(400).json({ message: "Invalid upload" });
    if (!["application/pdf", "image/jpeg", "image/png"].includes(declaredType)) return res.status(415).json({ message: "Only PDF, JPEG, and PNG files are allowed" });
    const length = Number(req.header("content-length"));
    if (Number.isFinite(length) && length > MAX_CANDIDATE_FILE_BYTES) return res.status(413).json({ message: "File exceeds the 10MB limit" });
    const [doc] = await db.select().from(onbDocuments).where(and(
      eq(onbDocuments.id, documentId), eq(onbDocuments.organizationId, ctx.organizationId), eq(onbDocuments.caseId, ctx.caseId),
    ));
    if (!doc) return res.status(404).json({ message: "Checklist item not found" });
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_CANDIDATE_FILE_BYTES) return res.status(413).json({ message: "File exceeds the 10MB limit" });
      chunks.push(bytes);
    }
    if (!size) return res.status(400).json({ message: "File is empty" });
    const bytes = Buffer.concat(chunks);
    const actualType = detectCandidateFile(bytes);
    if (!actualType || actualType !== declaredType) return res.status(415).json({ message: "File contents do not match an allowed type" });
    const objectPath = candidateObjectPath(ctx.organizationId, ctx.caseId);
    const storedFile = getPrivateFile(objectPath);
    await storedFile.save(bytes, { resumable: false, contentType: actualType });
    const upload = await (async () => {
      try {
        const [created] = await db.transaction(async (tx) => {
          const inserted = await tx.insert(onbCandidateUploads).values({
            organizationId: ctx.organizationId, caseId: ctx.caseId, documentId,
            objectPath, originalName, contentType: actualType, sizeBytes: size,
          }).returning();
          await tx.update(onbDocuments).set({ status: "received", note: "Submitted through the candidate portal", updatedAt: new Date() }).where(and(
            eq(onbDocuments.id, documentId), eq(onbDocuments.organizationId, ctx.organizationId), eq(onbDocuments.caseId, ctx.caseId),
          ));
          return inserted;
        });
        return created;
      } catch (error) {
        try {
          await storedFile.delete({ ignoreNotFound: true });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Candidate upload metadata write and object cleanup both failed");
        }
        throw error;
      }
    })();
    res.status(201).json({ id: upload.id, documentId, originalName, contentType: actualType, sizeBytes: size });
  } catch (error) { next(error); }
});

export default router;