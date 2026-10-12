import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbCandidateUploads, onbCases, onbDocuments,
} from "@workspace/db/schema";
import type { OnbReadinessItemRow } from "@workspace/db/schema";
import { getPrivateFile } from "../lib/objectStorage";
import {
  CANDIDATE_COOKIE, MAX_CANDIDATE_FILE_BYTES, candidateContext,
  candidateExchangeClientKey, candidateExchangeLimiter, candidateObjectPath,
  detectCandidateFile, exchangeToken,
} from "../lib/onboarding/candidate-portal";
import { ensureCaseLogistics } from "../lib/onboarding/case-logistics";
import { malwareUploadIsClean } from "../lib/onboarding/malware-policy";
import { reconcileDocumentationReadiness } from "../lib/onboarding/document-validation";
import { reopenApprovalInTransaction } from "../lib/onboarding/approval-version";
import { candidatePortalIntakeAllowed } from "../lib/onboarding/workforce-step-runtime";
import { appendProtectedAudit, appendProtectedAuditInTransaction } from "../lib/onboarding/protected-audit";
import {
  dispatchWithProviderGovernance,
  evaluateProviderGovernanceGate,
  PROVIDER_GOVERNANCE_WORKFLOW,
} from "../lib/onboarding/governance-provider-boundary";
import {
  evaluateSensitiveLifecycleGate,
  sensitiveDataClassForDocument,
  jurisdictionForWorkforceContext,
} from "../lib/onboarding/sensitive-lifecycle";
import { sensitiveClassForDocument } from "../lib/onboarding/sensitive-access";
import {
  finalizeCandidateUploadReservation,
  OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES,
  saveReservedCandidateUpload,
} from "../lib/onboarding/candidate-upload-reservations";
import { isUatRunIsolatedCase } from "../lib/onboarding/synthetic-offline";
import { isHistoricalTestRecord } from "../lib/onboarding/historical-test-record";
import { isAuthoritativelyUatRunOwnedCase } from "../lib/onboarding/uat-isolation";

const router: IRouter = Router();
const invalid = (res: any) => res.status(401).json({ message: "This portal link is invalid or has expired" });
class CandidateUploadUnavailableError extends Error {}

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
      ensureCaseLogistics(ctx.organizationId, ctx.caseId),
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
          const sensitiveClasses = sensitiveClassForDocument(doc);
          const restrictedReview = sensitiveClasses.length > 0;
          return {
            // A case-bound candidate may see the requested item and its
            // operational submission state, never HR/provider notes, finding
            // text, or validation reasons. This applies to the candidate's own
            // BGV, medical, payroll, and identity document requests as well.
            id: doc.id,
            label: doc.label,
            required: doc.required,
            status: securityBlocked && doc.status === "verified" ? "received" : doc.status,
            note: securityBlocked
              ? "Security review is required before this document can be verified."
              : restrictedReview
                ? "Submitted items are reviewed through the restricted onboarding process."
                : doc.status === "pending"
                  ? "Action is required in this secure portal."
                  : "Submission status recorded.",
            validationState: upload?.validationState ?? null,
            // Validation messages are staff/provider reasoning and can carry
            // sensitive findings even for an otherwise ordinary document.
            // Candidates receive the generic action state above instead.
            correctionGuidance: null,
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
    const [policyCase] = await db.select().from(onbCases).where(and(
      eq(onbCases.organizationId, ctx.organizationId),
      eq(onbCases.id, ctx.caseId),
    ));
    if (!policyCase) return invalid(res);
    if (isHistoricalTestRecord(policyCase) || await isAuthoritativelyUatRunOwnedCase(policyCase)) {
      res.status(410).json({ code: "CASE_TEST_CAPABILITY_RETIRED", message: "This historical test record is read-only and non-operational." });
      return;
    }
    if (isUatRunIsolatedCase(policyCase) &&
      !await isAuthoritativelyUatRunOwnedCase(policyCase)) {
      return res.status(409).json({
        message: "This isolated UAT case is missing its durable run ownership.",
      });
    }
    const portalAllowed = candidatePortalIntakeAllowed({
      processPolicySnapshot: policyCase.processPolicySnapshot,
      hiringMode: (policyCase.workforceContext as { hiringMode?: unknown } | null)?.hiringMode as string | undefined,
    });
    if (!portalAllowed.allowed) {
      return res.status(409).json({ message: portalAllowed.message });
    }
    const governance = await evaluateProviderGovernanceGate(
      policyCase,
      PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing,
       { allowIsolatedLocalOperation: isUatRunIsolatedCase(policyCase) ? "candidate-private-upload" : undefined },
    );
    if (!governance.allowed) {
      return res.status(409).json({
        message: "Document processing is unavailable pending required policy review.",
      });
    }
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
    const dataClass = sensitiveDataClassForDocument(doc);
    if (!dataClass) {
      return res.status(409).json({
        message: "Document collection is blocked because its sensitive data classification is unresolved.",
      });
    }
    // File bytes are opaque. The checklist category is routing metadata only:
    // an apparent medical/identity document may contain any sensitive class.
    const collectionGates = await Promise.all(OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES.map(async (dataClass) => ({
      dataClass,
      gate: await evaluateSensitiveLifecycleGate({
        organizationId: ctx.organizationId,
        jurisdiction: jurisdictionForWorkforceContext(policyCase.workforceContext),
        dataClass,
        disclosure: false,
      }),
    })));
    const collectionDenied = collectionGates.find(({ gate }) => !gate.allowed);
    if (collectionDenied) {
      return res.status(409).json({ message: collectionDenied.gate.reason });
    }
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

    const finalGovernance = await evaluateProviderGovernanceGate(
      policyCase,
      PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing,
      { allowIsolatedLocalOperation: isUatRunIsolatedCase(policyCase) ? "candidate-private-upload" : undefined },
    );
    if (!finalGovernance.allowed) {
      return res.status(409).json({
        message: "Document processing is unavailable pending required policy review.",
      });
    }
    const storageGates = await Promise.all(OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES.map(async (dataClass) => ({
      dataClass,
      gate: await evaluateSensitiveLifecycleGate({
        organizationId: ctx.organizationId,
        jurisdiction: jurisdictionForWorkforceContext(policyCase.workforceContext),
        dataClass,
        disclosure: true,
        providerId: "replit-object-storage",
      }),
    })));
    const storageDenied = storageGates.find(({ gate }) => !gate.allowed || !("policy" in gate));
    if (storageDenied) {
      return res.status(409).json({ message: storageDenied.gate.reason });
    }
    if (!actualType || actualType !== declaredType) return res.status(415).json({ message: "File contents do not match an allowed type" });

    const auditAttempt = await appendProtectedAudit({
      organizationId: ctx.organizationId,
      actorKind: "system",
      actorAuthority: "candidate-session:validated",
      action: "onboarding.candidate-document.upload.attempted",
      outcome: "attempted",
      objectType: "document",
      objectId: String(documentId),
      caseReference: `case:${ctx.caseId}`,
      source: "candidate-public",
    });
    const initialPolicyGate = storageGates.find(({ dataClass: gateDataClass }) => gateDataClass === dataClass)?.gate;
    const initialPolicy = initialPolicyGate && "policy" in initialPolicyGate
      ? initialPolicyGate.policy
      : undefined;
    if (!initialPolicy) {
      return res.status(409).json({ message: "Document processing approval is unavailable." });
    }
    const objectPath = candidateObjectPath(ctx.organizationId, ctx.caseId);
    const storedFile = getPrivateFile(objectPath);
    let upload;
    try {
      upload = await saveReservedCandidateUpload({
        reservation: {
          organizationId: ctx.organizationId,
          caseId: ctx.caseId,
          documentId,
          objectPath,
          dataClass,
          jurisdiction: jurisdictionForWorkforceContext(policyCase.workforceContext)!,
          workforceContextVersion: policyCase.workforceContextVersion,
          policyId: initialPolicy.id,
          policyRevision: initialPolicy.revision,
        },
        // The reservation helper holds the same reentrant lifecycle fence
        // through this save, the final policy check, metadata commit, and any
        // compensation. A live timed-out save cannot race its recovery worker.
        save: async () => {
          const storageDispatch = await dispatchWithProviderGovernance({
            caseRow: policyCase,
            workflow: PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing,
            operation: `candidate-document-upload:${ctx.caseId}:${documentId}`,
            providerId: "replit-object-storage",
            dataClass,
            minimalTypedPayload: false,
            // The only isolated dispatch exception is the UAT case's private
            // object-storage write. All vendor/worker effects remain fenced.
             allowIsolatedLocalOperation: isUatRunIsolatedCase(policyCase) ? "candidate-private-upload" : undefined,
            dispatch: () => storedFile.save(bytes, { resumable: false, contentType: actualType }),
            disposition: () => "sent",
          });
          if (!storageDispatch.dispatched) {
            throw new CandidateUploadUnavailableError(
              "Document processing is unavailable pending required policy review.",
            );
          }
        },
        finalize: async (reservation) => {
          // Policy/provider approvals are intentionally checked again after
          // bytes were saved. A changed approval never creates an upload row;
          // the reservation remains inventory until fenced cleanup succeeds.
          return finalizeCandidateUploadReservation({
            reservation,
            finalize: async (tx, lockedReservation, currentCase) => {
          // The reservation helper has a FOR UPDATE lock on the current case,
          // and verifies its normalized jurisdiction/context version before
          // this callback. Never reuse the request-time case snapshot here.
          const currentGovernance = await evaluateProviderGovernanceGate(
            currentCase,
            PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing,
               { allowIsolatedLocalOperation: isUatRunIsolatedCase(currentCase) ? "candidate-private-upload" : undefined },
          );
          if (!currentGovernance.allowed) {
            throw new CandidateUploadUnavailableError(
              "Document processing is unavailable pending required policy review.",
            );
          }
           const currentStorageGates = await Promise.all(OPAQUE_CANDIDATE_UPLOAD_DATA_CLASSES.map(async (dataClass) => ({
             dataClass,
             gate: await evaluateSensitiveLifecycleGate({
               organizationId: ctx.organizationId,
               jurisdiction: jurisdictionForWorkforceContext(currentCase.workforceContext),
               dataClass,
               disclosure: true,
               providerId: "replit-object-storage",
             }),
           })));
           const currentDenied = currentStorageGates.find(({ gate }) => !gate.allowed || !("policy" in gate));
           const currentPolicyGate = currentStorageGates.find(
             ({ dataClass: gateDataClass }) => gateDataClass === lockedReservation.dataClass,
           )?.gate;
           const currentPolicy = currentPolicyGate && "policy" in currentPolicyGate
             ? currentPolicyGate.policy
             : undefined;
           if (currentDenied ||
              !currentPolicy ||
              currentPolicy.id !== lockedReservation.policyId ||
              currentPolicy.revision !== lockedReservation.policyRevision) {
            throw new CandidateUploadUnavailableError(
              "Document processing approval changed while the upload was in progress.",
            );
          }
          // Orchestration locks the case before checking its live evidence.
          // Demote readiness in this same transaction, not only after commit.
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
              readiness: (currentCase.readiness as OnbReadinessItemRow[]).map((item) => item.key === "documentation"
                ? { ...item, status: "in-progress" as const, note: "Required document quarantined pending security scan and verification." }
                : item),
              updatedAt: new Date(),
            }).where(and(eq(onbCases.id, ctx.caseId), eq(onbCases.organizationId, ctx.organizationId)));
          }
          await appendProtectedAuditInTransaction(tx, {
            organizationId: ctx.organizationId,
            actorKind: "system",
            actorAuthority: "candidate-session:validated",
            action: "onboarding.candidate-document.upload.outcome",
            outcome: "success",
            objectType: "document",
            objectId: String(documentId),
            caseReference: `case:${ctx.caseId}`,
            source: "candidate-public",
            correctionOfId: auditAttempt.id,
          });
              return { uploadId: inserted[0]!.id, value: inserted[0]! };
            },
          });
        },
      });
    } catch (error) {
      if (error instanceof CandidateUploadUnavailableError) {
        return res.status(409).json({ message: error.message });
      }
      throw error;
    }
    // A replacement must demote any cached checklist readiness after the
    // upload is durable. Keep the object: reconciliation failure must not
    // turn a persisted candidate submission into an orphaned object.
    await reconcileDocumentationReadiness(ctx.organizationId, ctx.caseId);
    res.status(201).json({ id: upload.id, documentId, originalName, contentType: actualType, sizeBytes: size });
  } catch (error) { next(error); }
});

export default router;
