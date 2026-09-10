import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, onbCandidateUploads, onbCases, onbDocuments, onbEvents, onbSystemChecks } from "@workspace/db";
import { getPrivateFile } from "../objectStorage";
import { detectCandidateFile } from "./candidate-portal";
import { candidateEmailAuthorization, sendOutbound } from "./channels";
import { candidateEmailMaySend } from "./channel-routing";
export { normalizeBgvStatus, reminderEligible } from "./document-validation-policy";
import { actionableCorrectionReason, decideValidationOutcome } from "./document-validation-policy";
import { documentationGateReady } from "./document-validation-policy";
import { checklistStageBlockers, mandatoryChecklistReady } from "./settings";
import { documentMalwareGateSql } from "./document-malware-gate";
import { malwareUploadIsClean } from "./malware-policy";

export type ValidationReason = { code: string; message: string; evidence?: string };


/** Provider-neutral contract. Providers must never be treated as local proof. */
export interface AuthoritativeDocumentProvider {
  verify(input: { checksumSha256: string; documentType: string; bytes: Buffer }): Promise<
    { status: "verified" | "rejected" | "manual_review"; reasons?: ValidationReason[] }
  >;
}

export async function reconcileDocumentationReadiness(organizationId: string, caseId: number): Promise<void> {
  let checklistResumeReady = false;
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId))).for("update");
    if (!c) return;
    const required = await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId), eq(onbDocuments.required, true)));
    const verified = await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId), eq(onbDocuments.required, true), eq(onbDocuments.status, "verified"), documentMalwareGateSql()));
    const [bgv] = await tx.select({ status: onbSystemChecks.status }).from(onbSystemChecks).where(and(eq(onbSystemChecks.organizationId, organizationId), eq(onbSystemChecks.caseId, caseId), eq(onbSystemChecks.system, "bgv")));
    const bgvApplicable = c.hireType !== "internal-transfer";
    const ready = documentationGateReady({ bgvApplicable, bgvClear: bgv?.status === "done", requiredDocuments: required.length, verifiedDocuments: verified.length });
    const readiness = c.readiness.map((row) => ({ ...row }));
    const item = readiness.find((r) => r.key === "documentation");
    if (!item) return;
    item.status = ready ? "ready" : "in-progress";
    item.note = ready
      ? bgvApplicable
        ? "BGV is clear and every required document is verified."
        : "Every required document is verified; BGV is not applicable."
      : `${bgvApplicable && bgv?.status !== "done" ? "BGV clearance is pending. " : ""}Required document verification: ${verified.length}/${required.length}.`;
    const promoted =
      ready &&
      mandatoryChecklistReady({ ...c, readiness }) &&
      c.lifecycleStage === "preboarding" &&
      c.orchestrationStatus === "idle" &&
      !c.orchestrationCheckpoint;
    const blockedStage = c.orchestrationCheckpoint?.replace("blocked:", "") as
      | "before-workstreams"
      | "before-employee-communications"
      | "before-day1-review"
      | undefined;
    checklistResumeReady =
      c.orchestrationStatus === "checklist-blocked" &&
      (blockedStage === "before-workstreams" ||
        blockedStage === "before-employee-communications" ||
        blockedStage === "before-day1-review") &&
      checklistStageBlockers({ ...c, readiness }, blockedStage).length === 0;
    await tx.update(onbCases).set({
      readiness,
      updatedAt: new Date(),
      ...(promoted ? { lifecycleStage: "day1-review" } : {}),
    }).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId)));
  });
  if (checklistResumeReady) {
    const { resumeChecklistOrchestration } = await import("./engine");
    await resumeChecklistOrchestration(caseId);
  }
}

const unavailable: ValidationReason = {
  code: "authoritative_check_unavailable",
  message: "Authenticity and identity require manual review; no authoritative provider is configured.",
};

function structureReason(type: string, bytes: Buffer): ValidationReason | null {
  if (type === "application/pdf" && (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || !bytes.includes(Buffer.from("%%EOF")))) {
    return { code: "unreadable_structure", message: "The PDF structure could not be read." };
  }
  if (type === "image/jpeg" && !bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) {
    return { code: "unreadable_structure", message: "The JPEG structure could not be read." };
  }
  if (type === "image/png" && !bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) {
    return { code: "unreadable_structure", message: "The PNG structure could not be read." };
  }
  return null;
}

async function validateUpload(upload: typeof onbCandidateUploads.$inferSelect, owner: string, provider?: AuthoritativeDocumentProvider): Promise<void> {
  if (!malwareUploadIsClean(upload)) return;
  const reasons: ValidationReason[] = [];
  let bytes: Buffer;
  try {
    [bytes] = await getPrivateFile(upload.objectPath).download({ start: 0, end: 10 * 1024 * 1024 });
  } catch {
    reasons.push({ code: "object_unavailable", message: "The uploaded object could not be read." });
    bytes = Buffer.alloc(0);
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const scanStillMatches = checksum === upload.malwareScanSha256 && bytes.length === upload.sizeBytes;
  const legacyChecksum = upload.checksumSha256 === null;
  if (legacyChecksum) {
    reasons.push({ code: "legacy_checksum_initialized", message: "Checksum initialized from the existing stored object.", evidence: "initialized" });
  } else if (!bytes.length || checksum !== upload.checksumSha256) {
    reasons.push({ code: "checksum_mismatch", message: "The uploaded bytes do not match their recorded checksum." });
  }
  const actual = bytes.length ? detectCandidateFile(bytes) : null;
  if (actual !== upload.contentType) {
    reasons.push({ code: "declared_type_mismatch", message: "The file contents do not match the declared type." });
  }
  const structure = actual ? structureReason(actual, bytes) : null;
  if (structure) reasons.push(structure);
  const [duplicate] = upload.checksumSha256 ? await db.select({ id: onbCandidateUploads.id })
    .from(onbCandidateUploads)
    .where(and(eq(onbCandidateUploads.organizationId, upload.organizationId), eq(onbCandidateUploads.checksumSha256, upload.checksumSha256), sql`${onbCandidateUploads.id} <> ${upload.id}`))
    .limit(1) : [];
  if (duplicate) reasons.push({ code: "duplicate_identity", message: "This file matches another upload in this workspace." });
  // Expiry, identity, tamper resistance, and document plausibility require
  // OCR/authoritative sources. They are explicitly unavailable, never passed.
  // Every check has a normalized outcome. Local-only checks stay explicitly
  // unavailable instead of silently looking like a pass.
  reasons.push(
    { code: "expiry_check_unavailable", message: "Expiry could not be established without document extraction.", evidence: "unavailable" },
    { code: "identity_consistency_unavailable", message: "Identity consistency requires manual review.", evidence: "manual_review" },
    { code: "tamper_indicator_unavailable", message: "Tamper indicators are not established by basic structural checks.", evidence: "unavailable" },
    { code: "active_content_check", message: bytes.includes(Buffer.from("<script", "ascii")) ? "Embedded active content was detected." : "No basic embedded active-content marker was detected.", evidence: bytes.includes(Buffer.from("<script", "ascii")) ? "indicator" : "clear" },
  );
  let providerStatus: "verified" | "rejected" | "manual_review" | "unavailable" | "error" = "unavailable";
  if (provider && scanStillMatches) {
    try {
      const authoritative = await provider.verify({ checksumSha256: checksum, documentType: upload.contentType, bytes });
      providerStatus = authoritative.status;
      if (authoritative.reasons) reasons.push(...authoritative.reasons);
      if (authoritative.status === "rejected") reasons.push({ code: "authoritative_rejection", message: "The authoritative source rejected this evidence." });
    } catch {
      providerStatus = "error";
      reasons.push({ code: "authoritative_provider_error", message: "Authoritative verification is temporarily unavailable; manual review is required." });
    }
  } else reasons.push(unavailable);
  const state = decideValidationOutcome(reasons, providerStatus);
  await db.transaction(async (tx) => {
    // Serialize checklist transitions with upload replacement and HR decisions.
    await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(eq(onbDocuments.id, upload.documentId), eq(onbDocuments.organizationId, upload.organizationId), eq(onbDocuments.caseId, upload.caseId))).for("update");
    const [updated] = await tx.update(onbCandidateUploads).set({
      validationState: scanStillMatches ? state : "manual_review",
      ...(!scanStillMatches ? { malwareScanState: "indeterminate" as const, malwareScanSha256: null } : {}),
      ...(legacyChecksum ? { checksumSha256: checksum } : {}),
      validationReasons: reasons,
      validatedAt: new Date(),
      validationClaimOwner: null,
      validationClaimUntil: null,
    }).where(and(eq(onbCandidateUploads.id, upload.id), eq(onbCandidateUploads.organizationId, upload.organizationId), eq(onbCandidateUploads.caseId, upload.caseId), eq(onbCandidateUploads.validationState, "processing"), eq(onbCandidateUploads.validationClaimOwner, owner), eq(onbCandidateUploads.malwareScanState, "clean"), sql`${onbCandidateUploads.malwareScanSha256} = ${onbCandidateUploads.checksumSha256}`)).returning();
    if (!updated) return;
    const [latest] = await tx.select({ id: onbCandidateUploads.id }).from(onbCandidateUploads).where(and(eq(onbCandidateUploads.organizationId, upload.organizationId), eq(onbCandidateUploads.caseId, upload.caseId), eq(onbCandidateUploads.documentId, upload.documentId))).orderBy(desc(onbCandidateUploads.id)).limit(1);
    if (latest?.id === upload.id) await tx.update(onbDocuments).set({
      status: state === "passed" && scanStillMatches ? "verified" : "received",
      note: !scanStillMatches ? "File quarantined; HR/security review is required." : state === "correction_requested" ? "Correction requested — please upload a clearer or matching file." : "Validation complete; manual review is required.",
      updatedAt: new Date(),
    }).where(and(eq(onbDocuments.id, upload.documentId), eq(onbDocuments.organizationId, upload.organizationId), eq(onbDocuments.caseId, upload.caseId)));
    await tx.insert(onbEvents).values({
      organizationId: upload.organizationId, caseId: upload.caseId, agent: "document-validator", engine: "rules",
      hitlPattern: "approve-before-act", ruleRef: "document-validation",
      title: !scanStillMatches ? "Document quarantined for HR/security review" : state === "passed" ? "Document verified" : state === "correction_requested" ? "Document correction requested" : "Document queued for manual review",
      detail: reasons.map((r) => r.code).join(", "),
      idempotencyKey: `document-validation:${upload.id}:${upload.validationAttempts}`,
    }).onConflictDoNothing();
  });
  await reconcileDocumentationReadiness(upload.organizationId, upload.caseId);
}

export async function runDocumentValidationTick(provider?: AuthoritativeDocumentProvider): Promise<void> {
  const owner = randomUUID();
  const now = new Date();
  const cleanGate = and(eq(onbCandidateUploads.malwareScanState, "clean"), sql`${onbCandidateUploads.malwareScanSha256} = ${onbCandidateUploads.checksumSha256}`);
  const uploads = await db.select().from(onbCandidateUploads).where(and(cleanGate, or(
    eq(onbCandidateUploads.validationState, "queued"),
    and(eq(onbCandidateUploads.validationState, "processing"), or(isNull(onbCandidateUploads.validationClaimUntil), lt(onbCandidateUploads.validationClaimUntil, now))),
  ))).limit(25);
  for (const upload of uploads) {
    const [claimed] = await db.update(onbCandidateUploads).set({
      validationState: "processing", validationClaimOwner: owner, validationClaimUntil: new Date(Date.now() + 120_000),
      validationStartedAt: new Date(), validationAttempts: sql`${onbCandidateUploads.validationAttempts} + 1`,
    }).where(and(cleanGate, eq(onbCandidateUploads.id, upload.id), or(eq(onbCandidateUploads.validationState, "queued"), and(eq(onbCandidateUploads.validationState, "processing"), or(isNull(onbCandidateUploads.validationClaimUntil), lt(onbCandidateUploads.validationClaimUntil, now)))))).returning();
    if (claimed) await validateUpload(claimed, owner, provider);
  }
}

/** Safe, idempotent candidate reminders; bodies contain no paths or portal secrets. */
export async function runDocumentReminderTick(): Promise<void> {
  const due = await db.select({ doc: onbDocuments, c: onbCases }).from(onbDocuments)
    .innerJoin(onbCases, eq(onbCases.id, onbDocuments.caseId))
    .where(and(eq(onbDocuments.required, true), inArray(onbDocuments.status, ["pending", "received"]), lt(onbDocuments.updatedAt, new Date(Date.now() - 24 * 3600_000)), or(isNull(onbDocuments.reminderNextAt), lt(onbDocuments.reminderNextAt, new Date())))).limit(25);
  for (const { doc, c } of due) {
    const authorization = candidateEmailAuthorization(c);
    if (!candidateEmailMaySend({ channelPreference: c.channelPreference, caseAuthorized: authorization.allowed, explicitlyAllowlisted: false, validEmail: true })) continue;
    const key = `document-reminder:${doc.id}:${doc.reminderCount + 1}`;
    const delivery = await sendOutbound({ caseId: c.id, channel: "email", toAddress: c.workerEmail, subject: "A gentle onboarding document reminder", body: `Hello ${c.workerName}, please review your onboarding checklist and submit or correct “${doc.label}”. Our team will review it; no employment decision is made automatically.`, persistedBody: `Gentle reminder sent for required document: ${doc.label}.`, idempotencyKey: key });
    if (!["sent", "delivered"].includes(delivery.status)) continue;
    await db.update(onbDocuments).set({ reminderCount: sql`${onbDocuments.reminderCount} + 1`, lastReminderAt: new Date(), reminderNextAt: new Date(Date.now() + 48 * 3600_000), updatedAt: new Date() }).where(and(eq(onbDocuments.id, doc.id), eq(onbDocuments.organizationId, c.organizationId), eq(onbDocuments.caseId, c.id), eq(onbDocuments.reminderCount, doc.reminderCount)));
  }
}