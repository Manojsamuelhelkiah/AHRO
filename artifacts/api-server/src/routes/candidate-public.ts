import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbCandidateUploads, onbCases, onbDocuments,
} from "@workspace/db/schema";
import { getPrivateFile } from "../lib/objectStorage";
import {
  CANDIDATE_COOKIE, MAX_CANDIDATE_FILE_BYTES, candidateContext,
  candidateExchangeClientKey, candidateExchangeLimiter, candidateObjectPath,
  detectCandidateFile, exchangeToken,
} from "../lib/onboarding/candidate-portal";
import { ensureCaseLogistics } from "../lib/onboarding/case-logistics";
import { actionableCorrectionReason } from "../lib/onboarding/document-validation-policy";
import { malwareUploadIsClean } from "../lib/onboarding/malware-policy";
import { reconcileDocumentationReadiness } from "../lib/onboarding/document-validation";
import { reopenApprovalInTransaction } from "../lib/onboarding/approval-version";

const router: IRouter = Router();
const invalid = (res: any) => res.status(401).json({ message: "This portal link is invalid or has expired" });

function candidateMalwareGuidance(state: string | null | undefined, clean = false): string | null {
  switch (state) {
    case "pending":
    case "scanning":
      return "Your document is being securely checked before review.";
    case "infected":
      return "This file could not be accepted. Please upload a different copy.";
    case "unavailable":
    case "timeout":
    case "indeterminate":
      return "This document needs another security check before it can be reviewed. Please try again or upload a different copy.";
    case "clean":
      return clean ? null : "Your document needs another security check before it can be reviewed.";
    default:
      return "Your document needs a security check before it can be reviewed.";
  }
}

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
    const [c] = await db.select({ workerName: onbCases.workerName, role: onbCases.role, department: onbCases.department, joiningDate: onbCases.joiningDate })
      .from(onbCases).where(and(eq(onbCases.organizationId, ctx.organizationId), eq(onbCases.id, ctx.caseId)));
    if (!c) return invalid(res);
    const [logistics, documents, uploads] = await Promise.all([
      ensureCaseLogistics(ctx.organizationId, ctx.caseId, c.joiningDate),
      db.select({ id: onbDocuments.id, label: onbDocuments.label, required: onbDocuments.required, status: onbDocuments.status, note: onbDocuments.note })
        .from(onbDocuments).where(and(eq(onbDocuments.organizationId, ctx.organizationId), eq(onbDocuments.caseId, ctx.caseId))).orderBy(onbDocuments.id),
      db.select({
        documentId: onbCandidateUploads.documentId,
        checksumSha256: onbCandidateUploads.checksumSha256,
        validationState: onbCandidateUploads.validationState,
        validationReasons: onbCandidateUploads.validationReasons,
        malwareScanState: onbCandidateUploads.malwareScanState,
        malwareScannedAt: onbCandidateUploads.malwareScannedAt,
        malwareScanSha256: onbCandidateUploads.malwareScanSha256,
      })
          .from(onbCandidateUploads).where(and(eq(onbCandidateUploads.organizationId, ctx.organizationId), eq(onbCandidateUploads.caseId, ctx.caseId))).orderBy(desc(onbCandidateUploads.id)),
    ]);
    res.setHeader("Cache-Control", "private, no-store");
     const latest = new Map<number, typeof uploads[number]>();
     for (const upload of uploads) if (!latest.has(upload.documentId)) latest.set(upload.documentId, upload);
      res.json({
        case: c,
        logistics,
        documents: documents.map((doc) => {
          const upload = latest.get(doc.id);
          const malwareScanState = upload?.malwareScanState ?? null;
          const malwareClean = upload ? malwareUploadIsClean(upload) : false;
          const securityBlocked = !!upload && !malwareClean;
          return {
            ...doc,
            status: securityBlocked && doc.status === "verified" ? "received" : doc.status,
            note: securityBlocked ? "Security review is required before this document can be verified." : doc.note,
            validationState: upload?.validationState ?? null,
            correctionGuidance: upload?.validationReasons?.find(actionableCorrectionReason)?.message ?? null,
            malwareGuidance: upload ? candidateMalwareGuidance(malwareScanState, malwareClean) : null,
            malwareCheckPending: !!upload && (malwareScanState === "pending" || malwareScanState === "scanning"),
            malwareScannedAt: upload?.malwareScannedAt ?? null,
          };
        }),
      });
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
          // Orchestration locks the case before checking its live evidence.
          // Demote readiness in this same transaction, not only after commit.
          const [currentCase] = await tx.select().from(onbCases).where(and(
            eq(onbCases.id, ctx.caseId), eq(onbCases.organizationId, ctx.organizationId),
          )).for("update");
          if (!currentCase) throw new Error("Candidate case is no longer available");
          // Case -> checklist -> upload is the shared lock order. Review and
          // scanner workers never acquire the case lock while holding the latter.
          await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(
            eq(onbDocuments.id, documentId),
            eq(onbDocuments.organizationId, ctx.organizationId),
            eq(onbDocuments.caseId, ctx.caseId),
          )).for("update");
          const inserted = await tx.insert(onbCandidateUploads).values({
            organizationId: ctx.organizationId, caseId: ctx.caseId, documentId,
            objectPath, originalName, contentType: actualType, sizeBytes: size,
            checksumSha256: createHash("sha256").update(bytes).digest("hex"),
            malwareScanState: "pending",
            validationState: "queued",
          }).returning();
          await tx.update(onbDocuments).set({ status: "received", note: "Submitted through the candidate portal", updatedAt: new Date() }).where(and(
            eq(onbDocuments.id, documentId), eq(onbDocuments.organizationId, ctx.organizationId), eq(onbDocuments.caseId, ctx.caseId),
          ));
          if (doc.required) {
            // A replacement invalidates the evidence that Gate C approved.
            // Reopen inside the same case lock so a scan that later becomes
            // clean cannot let the old HR decision auto-complete the case.
            await reopenApprovalInTransaction(tx, {
              organizationId: ctx.organizationId,
              caseId: ctx.caseId,
              idempotencyKey: `gateway-c:${ctx.caseId}:human-queue`,
              reason: "Automatically reopened because a required document was replaced; fresh final review is required.",
              actor: "candidate-portal",
            });
            await tx.update(onbCases).set({
              readiness: currentCase.readiness.map((item) => item.key === "documentation"
                ? { ...item, status: "in-progress" as const, note: "Required document quarantined pending security scan and verification." }
                : item),
              updatedAt: new Date(),
            }).where(and(eq(onbCases.id, ctx.caseId), eq(onbCases.organizationId, ctx.organizationId)));
          }
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
    // A replacement must demote any cached checklist readiness after the
    // upload is durable. Keep the object: reconciliation failure must not
    // turn a persisted candidate submission into an orphaned object.
    await reconcileDocumentationReadiness(ctx.organizationId, ctx.caseId);
    res.status(201).json({ id: upload.id, documentId, originalName, contentType: actualType, sizeBytes: size });
  } catch (error) { next(error); }
});

export default router;