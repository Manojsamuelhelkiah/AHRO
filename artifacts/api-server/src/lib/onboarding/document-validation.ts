import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  onbCandidateUploads,
  onbCases,
  onbCommunications,
  onbDocuments,
  onbEvents,
  onbSystemChecks,
} from "@workspace/db";
import { getPrivateFile } from "../objectStorage";
import { detectCandidateFile } from "./candidate-portal";
import {
  addCandidateReplyReference,
  candidateEmailAuthorization,
  maskEmail,
  sendOutbound,
} from "./channels";
import { candidateEmailMaySend } from "./channel-routing";
export { normalizeBgvStatus, reminderEligible } from "./document-validation-policy";
import { actionableCorrectionReason, decideValidationOutcome, reminderEligible } from "./document-validation-policy";
import { documentationGateReady } from "./document-validation-policy";
import { hasTrustedBgvClearanceEvidence } from "./connector-evidence-provenance";
import { hasCurrentVaultBgvReceipt } from "../employee-vault/reuse";
import { checklistStageBlockers, mandatoryChecklistReady } from "./settings";
import { documentMalwareGateSql } from "./document-malware-gate";
import { malwareUploadIsClean } from "./malware-policy";
import { runWithProviderDeny } from "./provider-policy";
import { DEMO_ORGANIZATION_ID } from "@workspace/db/schema";
import { formatEmailIdentityLines } from "./email-identity";
import {
  dispatchWithProviderGovernance,
  evaluateProviderGovernanceGate,
  PROVIDER_GOVERNANCE_WORKFLOW,
} from "./governance-provider-boundary";
import {
  sensitiveDataClassForDocument,
  withCaseDerivedLifecycleWrite,
} from "./sensitive-lifecycle";
import { getUatCaseIsolation, ordinaryCaseSql } from "./uat-isolation";

export type ValidationReason = { code: string; message: string; evidence?: string };


/** Provider-neutral contract. Providers must never be treated as local proof. */
export interface AuthoritativeDocumentProvider {
  /** Stable ID that must appear in the approved class/jurisdiction policy. */
  providerId?: string;
  verify(input: { checksumSha256: string; documentType: string; bytes: Buffer }): Promise<
    { status: "verified" | "rejected" | "manual_review"; reasons?: ValidationReason[] }
  >;
}

export async function reconcileDocumentationReadiness(organizationId: string, caseId: number): Promise<void> {
  let checklistResumeReady = false;
  // `readiness` is an opaque persisted JSON envelope. Even though this
  // function changes only the documentation item, rewriting that envelope
  // must not restore text minimized by lifecycle deletion.
  await withCaseDerivedLifecycleWrite({ organizationId, caseId }, async (tx, c) => {
    const required = await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId), eq(onbDocuments.required, true)));
    const verified = await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId), eq(onbDocuments.required, true), eq(onbDocuments.status, "verified"), documentMalwareGateSql()));
    const bgvChecks = await tx.select().from(onbSystemChecks).where(and(
      eq(onbSystemChecks.organizationId, organizationId),
      eq(onbSystemChecks.caseId, caseId),
      eq(onbSystemChecks.system, "bgv"),
    ));
    const bgv = bgvChecks[0];
    const bgvClear = hasTrustedBgvClearanceEvidence(bgvChecks) || await hasCurrentVaultBgvReceipt(tx, organizationId, caseId);
    const bgvApplicable = c.hireType !== "internal-transfer";
    const ready = documentationGateReady({ bgvApplicable, bgvClear, requiredDocuments: required.length, verifiedDocuments: verified.length });
    const readiness = c.readiness.map((row) => ({ ...row }));
    const item = readiness.find((r) => r.key === "documentation");
    if (!item) return;
    item.status = ready ? "ready" : "in-progress";
    item.note = ready
      ? bgvApplicable
        ? "Trusted BGV clearance is present and every required document is verified."
        : "Every required document is verified; BGV is not applicable."
      : `${bgvApplicable && !bgvClear ? "Trusted BGV clearance is pending; simulated or unproven status is excluded. " : ""}Required document verification: ${verified.length}/${required.length}.`;
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
  // Test-run verdicts are run-scoped evidence. A global validator must not
  // read UAT bytes or turn its configured provider into a test side effect.
  if ((await getUatCaseIsolation({ organizationId: upload.organizationId, id: upload.caseId })).isolated) return;
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
    const [caseRow] = await db.select().from(onbCases).where(and(
      eq(onbCases.organizationId, upload.organizationId),
      eq(onbCases.id, upload.caseId),
    ));
    const [document] = await db.select({
      key: onbDocuments.key,
      label: onbDocuments.label,
      category: onbDocuments.category,
    }).from(onbDocuments).where(and(
      eq(onbDocuments.organizationId, upload.organizationId),
      eq(onbDocuments.caseId, upload.caseId),
      eq(onbDocuments.id, upload.documentId),
    ));
    const dataClass = document
      ? sensitiveDataClassForDocument(document)
      : null;
    const governance = caseRow
      ? await evaluateProviderGovernanceGate(
        caseRow,
        PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing,
      )
      : null;
    if (!dataClass) {
      reasons.push({
        code: "sensitive_data_class_unavailable",
        message: "Authoritative document verification is blocked because the document has no server-classified sensitive data class.",
      });
    } else if (!governance?.allowed) {
      reasons.push({
        code: "governance_provider_dispatch_blocked",
        message: governance?.reason ??
          "Authoritative document verification is blocked because the stored case is unavailable.",
      });
    } else {
      try {
        const providerDispatch = await dispatchWithProviderGovernance({
          caseRow,
          workflow: PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing,
          operation: `document-verification:${upload.id}:${upload.validationAttempts}`,
          providerId: provider.providerId ?? "unidentified-document-provider",
          dataClass,
          // The helper's callback is the final operation before the provider
          // receives candidate bytes. It re-evaluates under the durable
          // governance fence; simulated/source-mode evidence cannot stand in.
          dispatch: () => provider.verify({
            checksumSha256: checksum,
            documentType: upload.contentType,
            bytes,
          }),
          disposition: () => "sent",
        });
        if (!providerDispatch.dispatched) {
          reasons.push({
            code: "governance_provider_dispatch_blocked",
            message: providerDispatch.reason,
          });
        } else {
          const authoritative = providerDispatch.value;
          providerStatus = authoritative.status;
          if (authoritative.reasons) reasons.push(...authoritative.reasons);
          if (authoritative.status === "rejected") reasons.push({ code: "authoritative_rejection", message: "The authoritative source rejected this evidence." });
        }
      } catch {
        providerStatus = "error";
        reasons.push({ code: "authoritative_provider_error", message: "Authoritative verification is temporarily unavailable; manual review is required." });
      }
    }
  } else reasons.push(unavailable);
  const state = decideValidationOutcome(reasons, providerStatus);
  await withCaseDerivedLifecycleWrite({
    organizationId: upload.organizationId,
    caseId: upload.caseId,
  }, async (tx) => {
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
  ), ordinaryCaseSql(onbCandidateUploads.organizationId, onbCandidateUploads.caseId))).limit(25);
  for (const upload of uploads) {
    if ((await getUatCaseIsolation({ organizationId: upload.organizationId, id: upload.caseId })).isolated) continue;
    // This claim changes only lease/status/timestamps and never copies an
    // opaque payload. validateUpload owns the subsequent reason/note/event
    // persistence behind withCaseDerivedLifecycleWrite.
    const [claimed] = await db.update(onbCandidateUploads).set({
      validationState: "processing", validationClaimOwner: owner, validationClaimUntil: new Date(Date.now() + 120_000),
      validationStartedAt: new Date(), validationAttempts: sql`${onbCandidateUploads.validationAttempts} + 1`,
    }).where(and(
      cleanGate,
      eq(onbCandidateUploads.id, upload.id),
      // A run ledger can be persisted between bounded selection and claim.
      // Do not churn a UAT validation lease in that race.
      ordinaryCaseSql(onbCandidateUploads.organizationId, onbCandidateUploads.caseId),
      or(
        eq(onbCandidateUploads.validationState, "queued"),
        and(
          eq(onbCandidateUploads.validationState, "processing"),
          or(
            isNull(onbCandidateUploads.validationClaimUntil),
            lt(onbCandidateUploads.validationClaimUntil, now),
          ),
        ),
      ),
    )).returning();
    if (claimed) await validateUpload(claimed, owner, provider);
  }
}

/** Safe, idempotent candidate reminders; bodies contain no paths or portal secrets. */
export type DocumentReminderMode = "live" | "simulation";
export function documentNeedsCorrection(document: {
  status: string;
  validationState?: string | null;
  /** Retained for callers that carry the legacy document projection; never parsed. */
  note?: string | null;
}): boolean {
  return document.status === "received" &&
    document.validationState === "correction_requested";
}

export type DocumentReminderResult = {
  id: number;
  status: string;
  failureReason: string | null;
  idempotencyKey: string;
};

/**
 * Freeze the exact candidate reminder payload before entering the provider
 * boundary. The communication row is the durable replay source, while the
 * transaction advisory lock closes the first-write race where two workers
 * would otherwise generate different case-reply references for one
 * idempotency key.
 */
async function prepareStableReminderBody(input: {
  organizationId: string;
  caseId: number;
  toAddress: string;
  subject: string;
  body: string;
  idempotencyKey: string;
}): Promise<string> {
  return withCaseDerivedLifecycleWrite({
    organizationId: input.organizationId,
    caseId: input.caseId,
  }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`document-reminder:${input.organizationId}:${input.idempotencyKey}`}))`);
    const [existing] = await tx.select({ body: onbCommunications.body })
      .from(onbCommunications)
      .where(and(
        eq(onbCommunications.organizationId, input.organizationId),
        eq(onbCommunications.idempotencyKey, input.idempotencyKey),
      ));
    if (existing?.body) return existing.body;
    const stableBody = addCandidateReplyReference(input.body);
    await tx.insert(onbCommunications).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      channel: "email",
      direction: "outbound",
      audience: "candidate",
      toAddress: maskEmail(input.toAddress),
      subject: input.subject,
      body: stableBody,
      status: "sending",
      failureReason: null,
      sensitive: false,
      idempotencyKey: input.idempotencyKey,
    }).onConflictDoNothing({
      target: [onbCommunications.organizationId, onbCommunications.idempotencyKey],
    });
    const [persisted] = await tx.select({ body: onbCommunications.body })
      .from(onbCommunications)
      .where(and(
        eq(onbCommunications.organizationId, input.organizationId),
        eq(onbCommunications.idempotencyKey, input.idempotencyKey),
      ));
    if (!persisted?.body) throw new Error("Reminder payload could not be persisted.");
    return persisted.body;
  });
}

/**
 * Sends one reminder through the same boundary as the existing scheduled
 * queue. The explicit Action Center action is deliberately not a second
 * scheduler: it uses the same 24-hour eligibility check, case authorization,
 * provider guard, communication idempotency, and 48-hour next-due update.
 */
export async function sendDocumentReminder(input: {
  organizationId: string;
  caseId: number;
  documentId: number;
  mode: DocumentReminderMode;
  idempotencyKey: string;
}): Promise<DocumentReminderResult> {
  const [row] = await db
    .select({ doc: onbDocuments, c: onbCases })
    .from(onbDocuments)
    .innerJoin(
      onbCases,
      and(eq(onbCases.id, onbDocuments.caseId), eq(onbCases.organizationId, onbDocuments.organizationId)),
    )
    .where(and(
      eq(onbDocuments.id, input.documentId),
      eq(onbDocuments.caseId, input.caseId),
      eq(onbDocuments.organizationId, input.organizationId),
    ));
  if (!row) throw new Error("Case or document not found");
  const [latestUpload] = row?.doc
    ? await db.select({ validationState: onbCandidateUploads.validationState })
      .from(onbCandidateUploads)
      .where(and(
        eq(onbCandidateUploads.organizationId, input.organizationId),
        eq(onbCandidateUploads.caseId, input.caseId),
        eq(onbCandidateUploads.documentId, input.documentId),
      ))
      .orderBy(desc(onbCandidateUploads.id))
      .limit(1)
    : [];
  if (!row?.doc.required || !["pending", "received"].includes(row.doc.status) ||
    (row.doc.status === "received" && !documentNeedsCorrection({
      status: row.doc.status,
      validationState: latestUpload?.validationState,
    }))) {
    throw new Error("This document no longer needs a reminder.");
  }
  if (!reminderEligible({
    required: row.doc.required,
    status: row.doc.status,
    updatedAt: row.doc.updatedAt,
    reminderNextAt: row.doc.reminderNextAt,
  })) {
    throw new Error("This document is not due for a reminder yet.");
  }
  if (input.mode === "simulation" && input.organizationId !== DEMO_ORGANIZATION_ID) {
    throw new Error("Reminder simulation is only available in Demo Organization.");
  }
  if (input.mode === "live" && input.organizationId === DEMO_ORGANIZATION_ID) {
    throw new Error("Demo live reminders require an authorized existing run and are not available through this path.");
  }

  const authorization = candidateEmailAuthorization(row.c);
  if (!candidateEmailMaySend({
    channelPreference: row.c.channelPreference,
    caseAuthorized: authorization.allowed,
    explicitlyAllowlisted: false,
    validEmail: true,
  })) {
    throw new Error(authorization.reason ?? "Candidate email is not currently authorized.");
  }
  const subject = `${input.mode === "simulation" ? "[SIMULATED] " : ""}Document action required — ${row.c.workerName} (case #${row.c.id})`;
  const messageBody = [
    `Hello ${row.c.workerName}, please review your onboarding checklist and submit or correct “${row.doc.label}”. Our team will review it; no employment decision is made automatically.`,
    "",
    ...formatEmailIdentityLines({
      stakeholder: { name: row.c.workerName, role: "Candidate / employee" },
      deliveryAddress: row.c.workerEmail,
      requestedBy: "document-reminder",
      requestedByKind: "agent",
      deliveryMode: input.mode === "simulation" ? "simulated" : "real",
      actionRequired: `Submit or correct the required document: ${row.doc.label}.`,
      reference: `DOC-${row.c.id}-${row.doc.id}`,
      appPath: `/approvals?tab=approvals&caseId=${encodeURIComponent(String(row.c.id))}&documentId=${encodeURIComponent(String(row.doc.id))}`,
    }),
  ].join("\n");
  const stableBody = await prepareStableReminderBody({
    organizationId: input.organizationId,
    caseId: row.c.id,
    toAddress: row.c.workerEmail,
    subject,
    body: messageBody,
    idempotencyKey: input.idempotencyKey,
  });
  const send = () => sendOutbound({
    caseId: row.c.id,
    channel: "email",
    toAddress: row.c.workerEmail,
    subject,
    body: stableBody,
    persistedBody: stableBody,
    stableBody: true,
    skipCandidateReplyReference: true,
    idempotencyKey: input.idempotencyKey,
  });
  const delivery = input.mode === "simulation"
    ? await runWithProviderDeny(send)
    : await send();
  if (["sent", "delivered"].includes(delivery.status)) {
    // Reminder bookkeeping is intentionally limited to counters and
    // timestamps; it cannot recreate document text after minimisation.
    await db.update(onbDocuments).set({
      reminderCount: sql`${onbDocuments.reminderCount} + 1`,
      lastReminderAt: new Date(),
      reminderNextAt: new Date(Date.now() + 48 * 3600_000),
      updatedAt: new Date(),
    }).where(and(
      eq(onbDocuments.id, row.doc.id),
      eq(onbDocuments.organizationId, input.organizationId),
      eq(onbDocuments.caseId, input.caseId),
      eq(onbDocuments.reminderCount, row.doc.reminderCount),
    ));
  }
  return { ...delivery, idempotencyKey: input.idempotencyKey };
}

export async function runDocumentReminderTick(): Promise<void> {
  const due = await db.select({ doc: onbDocuments, c: onbCases }).from(onbDocuments)
    .innerJoin(onbCases, eq(onbCases.id, onbDocuments.caseId))
    .where(and(
      eq(onbDocuments.required, true),
      inArray(onbDocuments.status, ["pending", "received"]),
      lt(onbDocuments.updatedAt, new Date(Date.now() - 24 * 3600_000)),
      or(isNull(onbDocuments.reminderNextAt), lt(onbDocuments.reminderNextAt, new Date())),
      ordinaryCaseSql(onbCases.organizationId, onbCases.id),
    )).limit(25);
  for (const { doc, c } of due) {
    if (c.organizationId === DEMO_ORGANIZATION_ID) continue;
    // Keep the durable lookup as the final fence before reminder eligibility
    // checks and any candidate communication.
    if ((await getUatCaseIsolation(c)).isolated) continue;
    if (doc.status === "received") {
      const [latestUpload] = await db.select({ validationState: onbCandidateUploads.validationState })
        .from(onbCandidateUploads)
        .where(and(
          eq(onbCandidateUploads.organizationId, c.organizationId),
          eq(onbCandidateUploads.caseId, c.id),
          eq(onbCandidateUploads.documentId, doc.id),
        ))
        .orderBy(desc(onbCandidateUploads.id))
        .limit(1);
      if (!documentNeedsCorrection({
        status: doc.status,
        validationState: latestUpload?.validationState,
      })) continue;
    }
    const authorization = candidateEmailAuthorization(c);
    if (!candidateEmailMaySend({
      channelPreference: c.channelPreference,
      caseAuthorized: authorization.allowed,
      explicitlyAllowlisted: false,
      validEmail: true,
    })) continue;
    const key = `document-reminder:${doc.id}:${doc.reminderCount + 1}`;
    await sendDocumentReminder({
      organizationId: c.organizationId,
      caseId: c.id,
      documentId: doc.id,
      mode: "live",
      idempotencyKey: key,
    });
  }
}