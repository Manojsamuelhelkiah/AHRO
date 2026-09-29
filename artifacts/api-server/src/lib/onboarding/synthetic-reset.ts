import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  onbApprovalNotifications,
  onbApprovals,
  onbCandidateUploads,
  onbCases,
  onbCaseLogistics,
  onbCommunications,
  onbEffectJournal,
  onbEvents,
  onbReadinessSlaOutbox,
  onbAuditLifecycles,
  onbSystemChecks,
  onbVoiceSessions,
  onbSettings,
} from "@workspace/db";
import { DEMO_ORGANIZATION_ID } from "@workspace/db/schema";
import { getScenario, type ScenarioDef } from "./scenarios";
import {
  getDay1LogisticsDefault,
  readinessFromChecklist,
} from "./settings";
import { logisticsForCase } from "./logistics-defaults";
import {
  checklistProfileMatchingAttributes,
  resolveChecklistProfileInTransaction,
} from "./checklist-profiles";
import {
  SYNTHETIC_OFFLINE_MARKER,
  SYNTHETIC_OFFLINE_WARNING,
} from "./synthetic-offline";
import { appendProtectedAuditInTransaction } from "./protected-audit";
import {
  sensitiveLifecycleCaseDeletionBlockedInTransaction,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

function defaultWorkstreams() {
  return [
    { key: "documentation", label: "Documentation & Compliance", agent: "documentation", status: "pending", owner: "HR Ops", blockers: [] },
    { key: "access", label: "Access & System Readiness", agent: "access", status: "pending", owner: "IT / Security", blockers: [] },
    { key: "assets", label: "Asset & Workplace Readiness", agent: "assets", status: "pending", owner: "IT / Facilities", blockers: [] },
    { key: "learning", label: "Learning, Engagement & Readiness", agent: "learning", status: "pending", owner: "L&D / Manager", blockers: [] },
    { key: "analytics", label: "Data & Analytics", agent: "analytics", status: "pending", owner: "People Analytics", blockers: [] },
  ];
}

export const HCLTECH_ORGANIZATION_ID =
  "org_654eb2bb-23cb-489a-9cc3-50faeddcfd3c";
export const SYNTHETIC_RESET_CONFIRMATION = "REPLACE SYNTHETIC CASES";
export const SYNTHETIC_RESET_RECEIPT_KEY =
  "onboarding.synthetic-reset.receipt.v1";
export const SYNTHETIC_REPLACEMENT_COUNT = 6;

type ProvenanceConfig = {
  hireType?: string;
  workerCategory?: string;
  role?: string;
  department?: string;
  geography?: string;
  legalEntity?: string;
  managerName?: string;
  recruiterName?: string;
};

export type SyntheticResetManifestEntry = {
  organizationId: string;
  id: number;
  expected: {
    workerName: string;
    scenarioKey: string | null;
    config?: ProvenanceConfig;
    workerEmail?: string;
    workerPhone?: string | null;
  };
};

export type SyntheticResetManifest = readonly SyntheticResetManifestEntry[];

const scenarioForKey = (key: string): ScenarioDef => {
  const scenario = getScenario(key);
  if (!scenario) throw new Error(`Synthetic reset manifest references unknown scenario "${key}".`);
  return scenario;
};

const manifestScenarioKeys: Array<[number, string]> = [
  [1, "standard-fte"],
  [2, "rehire"],
  [3, "bgv-exception"],
  [4, "contractor-client"],
  [5, "internal-transfer"],
  [6, "critical-skill"],
  [7, "standard-fte"],
  [8, "contractor-client"],
  [9, "contractor-client"],
  [153, "standard-fte"],
  [355, "standard-fte"],
  [534, "standard-fte"],
];

const hclManifestScenarioKeys: Array<[number, string]> = [
  [926, "standard-fte"],
  [927, "contractor-client"],
  [928, "rehire"],
  [929, "bgv-exception"],
  [930, "critical-skill"],
];

function scenarioManifestEntry(
  organizationId: string,
  id: number,
  scenario: ScenarioDef,
): SyntheticResetManifestEntry {
  return {
    organizationId,
    id,
    expected: {
      workerName: scenario.intake.workerName,
      scenarioKey: scenario.key,
      workerEmail: scenario.intake.workerEmail,
      workerPhone: scenario.intake.workerPhone,
      config: {
        hireType: scenario.intake.hireType,
        workerCategory: scenario.intake.workerCategory,
        role: scenario.intake.role,
        department: scenario.intake.department,
        geography: scenario.intake.geography,
        legalEntity: scenario.intake.legalEntity,
        managerName: scenario.intake.managerName,
        recruiterName: scenario.intake.recruiterName,
      },
    },
  };
}

/**
 * This is deliberately an explicit ID manifest, not a query such as
 * `scenario_key is not null`.  That protects manually-created and future
 * cases from a broad destructive predicate.
 */
export const DEFAULT_SYNTHETIC_RESET_MANIFEST: SyntheticResetManifest = [
  ...manifestScenarioKeys.map(([id, key]) =>
    scenarioManifestEntry(DEMO_ORGANIZATION_ID, id, scenarioForKey(key)),
  ),
  {
    organizationId: DEMO_ORGANIZATION_ID,
    id: 79,
    expected: {
      workerName: "Red Team Drill (simulated attacker)",
      scenarioKey: null,
      workerEmail: "red.team.drill@attacker.example",
      workerPhone: "+15550100999",
      config: {
        hireType: "external-fte",
        workerCategory: "white-collar",
        role: "Security Drill Target",
        department: "Security",
        geography: "United States",
        legalEntity: "Demo Corp",
        managerName: "Security Team",
        recruiterName: "Security Team",
      },
    },
  },
  ...([
    ...hclManifestScenarioKeys,
  ] as const).map(([id, key]) =>
    scenarioManifestEntry(HCLTECH_ORGANIZATION_ID, id, scenarioForKey(key)),
  ),
  {
    organizationId: HCLTECH_ORGANIZATION_ID,
    id: 1659,
    expected: {
      workerName: "Gateway Test pcep0-0q",
      scenarioKey: null,
      workerEmail: "gateway-pcep0-0q@example.com",
      workerPhone: "+15555550123",
      config: {
        hireType: "contractor",
        workerCategory: "contractor",
        role: "Test Contractor",
        department: "Engineering",
        geography: "United States",
        legalEntity: "Demo Test Entity",
        managerName: "Demo Manager",
        recruiterName: "Demo Recruiter",
      },
    },
  },
];

type CaseRow = typeof onbCases.$inferSelect;
type UploadRow = typeof onbCandidateUploads.$inferSelect;
type Receipt = {
  version: 1;
  organizationId: string;
  actorId: string;
  completedAt: string;
  deletedCaseIds: number[];
  createdCaseIds: number[];
  retainedUploadCount: number;
  /** Server-side only. Never expose these paths through the API receipt. */
  retainedUploads: Array<{
    caseId: number;
    uploadId: number;
    objectPath: string;
    originalName: string;
    contentType: string;
    sizeBytes: number;
  }>;
};

export type SyntheticResetReceipt = Pick<
  Receipt,
  "deletedCaseIds" | "createdCaseIds" | "completedAt"
> & {
  retainedUploadCount?: number;
};

export type SyntheticResetEnvelope = {
  organizationId: string;
  status: "ready" | "blocked" | "completed" | "unavailable";
  revision: string;
  candidates: Array<{
    id: number;
    workerName: string;
    scenarioKey: string | null;
  }>;
  preservedCount: number;
  replacementCount: 6;
  blockers: string[];
  warnings: string[];
  receipt: SyntheticResetReceipt | null;
};

type QueryClient = Pick<typeof db, "select">;

type Inspection = {
  organizationId: string;
  manifest: SyntheticResetManifestEntry[];
  targetRows: CaseRow[];
  blockers: string[];
  warnings: string[];
  receipt: Receipt | null;
  revision: string;
  preservedCount: number;
  retainedUploads: UploadRow[];
};

const CONFIG_FIELDS: Array<keyof ProvenanceConfig> = [
  "hireType",
  "workerCategory",
  "role",
  "department",
  "geography",
  "legalEntity",
  "managerName",
  "recruiterName",
];

function manifestFor(
  organizationId: string,
  manifest: SyntheticResetManifest,
): SyntheticResetManifestEntry[] {
  return manifest
    .filter((entry) => entry.organizationId === organizationId)
    .sort((a, b) => a.id - b.id);
}

function parseReceipt(value: string | null, organizationId: string): Receipt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<Receipt>;
    if (
      parsed.version !== 1 ||
      parsed.organizationId !== organizationId ||
      typeof parsed.actorId !== "string" ||
      typeof parsed.completedAt !== "string" ||
      !Array.isArray(parsed.deletedCaseIds) ||
      !Array.isArray(parsed.createdCaseIds) ||
      !Array.isArray(parsed.retainedUploads) ||
      typeof parsed.retainedUploadCount !== "number"
    ) {
      return null;
    }
    return parsed as Receipt;
  } catch {
    return null;
  }
}

function safeReceiptResponse(receipt: Receipt | null): SyntheticResetReceipt | null {
  if (!receipt) return null;
  return {
    deletedCaseIds: [...receipt.deletedCaseIds],
    createdCaseIds: [...receipt.createdCaseIds],
    completedAt: receipt.completedAt,
    ...(receipt.retainedUploadCount
      ? { retainedUploadCount: receipt.retainedUploadCount }
      : {}),
  };
}

function revisionFor(
  organizationId: string,
  rows: CaseRow[],
  blockers: string[],
  receipt: Receipt | null,
  relatedSnapshot: unknown = null,
): string {
  const snapshot = receipt
    ? {
        organizationId,
        receipt: {
          deletedCaseIds: receipt.deletedCaseIds,
          createdCaseIds: receipt.createdCaseIds,
          completedAt: receipt.completedAt,
        },
      }
    : {
        organizationId,
        // updatedAt is deliberately excluded: several background workers
        // touch it while leaving the case's business state unchanged. Every
        // editable/provenance-bearing field remains here so a meaningful
        // mutation still invalidates the confirmation revision.
        rows: [...rows].sort((a, b) => a.id - b.id).map((row) => ({
          id: row.id,
          organizationId: row.organizationId,
          workerName: row.workerName,
          workerEmail: row.workerEmail,
          workerPhone: row.workerPhone,
          channelPreference: row.channelPreference,
          hireType: row.hireType,
          workerCategory: row.workerCategory,
          workerBand: row.workerBand,
          role: row.role,
          department: row.department,
          geography: row.geography,
          legalEntity: row.legalEntity,
          managerName: row.managerName,
          recruiterName: row.recruiterName,
          joiningDate: row.joiningDate,
          urgency: row.urgency,
          lifecycleStage: row.lifecycleStage,
          checklistTemplateVersion: row.checklistTemplateVersion,
          checklistSnapshot: row.checklistSnapshot,
          checklistProfileId: row.checklistProfileId,
          checklistProfileName: row.checklistProfileName,
          checklistProfileVersion: row.checklistProfileVersion,
          checklistMatchedCriteria: row.checklistMatchedCriteria,
          checklistMatchExplanation: row.checklistMatchExplanation,
          orchestrationStatus: row.orchestrationStatus,
          orchestrationCheckpoint: row.orchestrationCheckpoint,
          orchestrationClaimOwner: row.orchestrationClaimOwner,
          orchestrationClaimToken: row.orchestrationClaimToken,
          orchestrationClaimUntil: row.orchestrationClaimUntil?.toISOString() ?? null,
          readiness: row.readiness,
          workstreams: row.workstreams,
          primarySkill: row.primarySkill,
          skillCriticality: row.skillCriticality,
          scenarioKey: row.scenarioKey,
          planSummary: row.planSummary,
          notes: row.notes,
          candidateEmailAuthorizedAt: row.candidateEmailAuthorizedAt?.toISOString() ?? null,
          candidateEmailAuthorizedBy: row.candidateEmailAuthorizedBy,
          offerAcceptanceComplete: row.offerAcceptanceComplete,
          offerAcceptanceCompletedAt: row.offerAcceptanceCompletedAt?.toISOString() ?? null,
          offerAcceptanceCompletedBy: row.offerAcceptanceCompletedBy,
        })),
        blockers: [...blockers].sort(),
        related: relatedSnapshot,
      };
  return createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}

function isProvablyStaleLegacyRunning(row: CaseRow, now = Date.now()): boolean {
  const staleBefore = now - 24 * 60 * 60 * 1000;
  return row.orchestrationStatus === "running" &&
    row.orchestrationClaimOwner === null &&
    row.orchestrationClaimUntil === null &&
    row.orchestrationClaimToken === 0 &&
    row.orchestrationCheckpoint === null &&
    row.createdAt.getTime() < staleBefore &&
    row.updatedAt.getTime() < staleBefore;
}

function compareProvenance(
  row: CaseRow | undefined,
  entry: SyntheticResetManifestEntry,
  blockers: string[],
): void {
  if (!row) {
    blockers.push(`Legacy case #${entry.id} is missing from the current organization.`);
    return;
  }
  if (row.organizationId !== entry.organizationId) {
    blockers.push(`Case #${entry.id} organization provenance does not match the manifest.`);
  }
  if (row.workerName !== entry.expected.workerName) {
    blockers.push(`Case #${entry.id} worker name does not match the trusted legacy manifest.`);
  }
  if (row.scenarioKey !== entry.expected.scenarioKey) {
    blockers.push(`Case #${entry.id} scenario provenance does not match the trusted legacy manifest.`);
  }
  for (const field of CONFIG_FIELDS) {
    const expected = entry.expected.config?.[field];
    if (expected !== undefined && row[field] !== expected) {
      blockers.push(`Case #${entry.id} ${field} does not match the trusted legacy configuration.`);
    }
  }
  if (
    entry.expected.workerEmail !== undefined &&
    row.workerEmail !== entry.expected.workerEmail
  ) {
    blockers.push(`Case #${entry.id} contact email differs from the manifest; needs review.`);
  }
  if (
    entry.expected.workerPhone !== undefined &&
    row.workerPhone !== entry.expected.workerPhone
  ) {
    blockers.push(`Case #${entry.id} contact phone differs from the manifest; needs review.`);
  }
}

function addCaseSafetyBlockers(
  rows: CaseRow[],
  approvals: Array<typeof onbApprovals.$inferSelect>,
  communications: Array<typeof onbCommunications.$inferSelect>,
  effects: Array<typeof onbEffectJournal.$inferSelect>,
  systemChecks: Array<typeof onbSystemChecks.$inferSelect>,
  voices: Array<typeof onbVoiceSessions.$inferSelect>,
  approvalNotifications: Array<typeof onbApprovalNotifications.$inferSelect>,
  slaOutbox: Array<typeof onbReadinessSlaOutbox.$inferSelect>,
  blockers: string[],
  warnings: string[],
): void {
  const now = Date.now();
  for (const row of rows) {
    const staleLegacy = isProvablyStaleLegacyRunning(row, now);
    if (row.orchestrationClaimOwner !== null || row.orchestrationClaimUntil !== null) {
      blockers.push(`Case #${row.id} has an orchestration claim; reconcile active work first.`);
    }
    if (
      row.orchestrationStatus === "running" && !staleLegacy
    ) {
      blockers.push(`Case #${row.id} has active orchestration work; reset is fail-closed.`);
    }
    if (staleLegacy) {
      warnings.push(`Case #${row.id} was fenced as a provably stale, unleased legacy running row.`);
    }
  }

  const targetIds = new Set(rows.map((row) => row.id));
  for (const approval of approvals) {
    if (approval.status === "pending") {
      warnings.push(`Case #${approval.caseId} has a pending approval record; it is non-provider workflow state and will cascade with the legacy case.`);
    }
  }
  // A case DELETE cascades these records. They can contain sensitive bodies,
  // transcripts, BGV/system notes, notification payloads, or references to
  // derivatives which are not yet managed by the lifecycle deletion worker.
  // Do not relabel this one-off reset as retention processing: block it until
  // a class-specific lifecycle path reconciles the records.
  if (communications.length) {
    blockers.push("Reset would cascade communication content; sensitive lifecycle reconciliation is required.");
  }
  if (voices.length) {
    blockers.push("Reset would cascade voice/transcript metadata; sensitive lifecycle reconciliation is required.");
  }
  if (approvalNotifications.length) {
    blockers.push("Reset would cascade approval notification bodies; sensitive lifecycle reconciliation is required.");
  }
  if (slaOutbox.length) {
    blockers.push("Reset would cascade SLA payloads; sensitive lifecycle reconciliation is required.");
  }
  if (systemChecks.length) {
    blockers.push("Reset would cascade BGV/system notes; sensitive lifecycle reconciliation is required.");
  }
  for (const communication of communications) {
    if (communication.direction !== "outbound") continue;
    const reconciled =
      communication.status === "sent" &&
      ((communication.idempotencyKey !== null &&
        effects.some((effect) =>
          effect.caseId === communication.caseId &&
          effect.status === "confirmed" &&
          effect.logicalOperationKey.endsWith(communication.idempotencyKey!),
        )) ||
        (communication.idempotencyKey === null &&
          (communication.externalMessageId !== null ||
            communication.createdAt.getTime() < Date.now() - 24 * 60 * 60 * 1000)));
    if (
      !reconciled &&
      !["failed", "blocked", "logged-only", "simulated", "completed"].includes(communication.status)
    ) {
      blockers.push(`Case #${communication.caseId} has an unreconciled outbound communication.`);
    } else if (communication.status === "sent" && !reconciled) {
      blockers.push(`Case #${communication.caseId} has a sent contact without confirmed effect provenance.`);
    }
  }
  for (const effect of effects) {
    if (["dispatching", "unknown_effect_manual_repair"].includes(effect.status)) {
      blockers.push(`Case #${effect.caseId} has an in-flight or unknown provider effect.`);
    } else if (!["ready", "failed", "confirmed"].includes(effect.status)) {
      blockers.push(`Case #${effect.caseId} has an unrecognized provider-effect state.`);
    }
  }
  for (const check of systemChecks) {
    if (["pending", "running", "dispatching"].includes(check.status)) {
      blockers.push(`Case #${check.caseId} has an active external-system check.`);
    }
  }
  for (const voice of voices) {
    if (!voice.finalized) {
      blockers.push(`Case #${voice.caseId} has an active voice session.`);
    }
  }
  for (const notification of approvalNotifications) {
    if (["sending", "unknown_effect_manual_repair"].includes(notification.status)) {
      blockers.push(`Case #${notification.caseId} has an active approval notification.`);
    }
  }
  for (const outbox of slaOutbox) {
    if (["claimed", "unknown"].includes(outbox.status)) {
      blockers.push(`Case #${outbox.caseId} has an active or unknown SLA notification.`);
    }
  }
  // Keep this referenced in the safety helper so a future caller cannot
  // accidentally pass rows from another organization.
  if (communications.some((communication) => !targetIds.has(communication.caseId))) {
    blockers.push("Reset inventory crossed an organization boundary.");
  }
}

async function loadInspection(
  organizationId: string,
  manifest: SyntheticResetManifest,
  client: QueryClient = db,
  lock = false,
): Promise<Inspection> {
  const entries = manifestFor(organizationId, manifest);
  const ids = entries.map((entry) => entry.id);
  let rowQuery = client
    .select()
    .from(onbCases)
    .where(
      ids.length
        ? and(eq(onbCases.organizationId, organizationId), inArray(onbCases.id, ids))
        : eq(onbCases.organizationId, organizationId),
    );
  if (lock && ids.length) rowQuery = rowQuery.for("update") as typeof rowQuery;
  const targetRows = await rowQuery;
  const allRows = await client
    .select()
    .from(onbCases)
    .where(eq(onbCases.organizationId, organizationId));
  const receiptRows = await client
    .select({ value: onbSettings.value })
    .from(onbSettings)
    .where(
      and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, SYNTHETIC_RESET_RECEIPT_KEY),
      ),
    );
  const storedValue = receiptRows[0]?.value ?? null;
  const parsedReceipt = parseReceipt(storedValue, organizationId);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (storedValue !== null && !parsedReceipt) {
    blockers.push("The reset receipt is invalid; manual reconciliation is required.");
  }
  const byId = new Map(targetRows.map((row) => [row.id, row]));
  for (const entry of entries) compareProvenance(byId.get(entry.id), entry, blockers);

  const relatedIds = targetRows.map((row) => row.id);
  if (relatedIds.length) {
    const [approvals, communications, effects, systemChecks, voices, approvalNotifications, slaOutbox, uploads] =
      await Promise.all([
        client.select().from(onbApprovals).where(
          and(eq(onbApprovals.organizationId, organizationId), inArray(onbApprovals.caseId, relatedIds)),
        ),
        client.select().from(onbCommunications).where(
          and(eq(onbCommunications.organizationId, organizationId), inArray(onbCommunications.caseId, relatedIds)),
        ),
        client.select().from(onbEffectJournal).where(
          and(eq(onbEffectJournal.organizationId, organizationId), inArray(onbEffectJournal.caseId, relatedIds)),
        ),
        client.select().from(onbSystemChecks).where(
          and(eq(onbSystemChecks.organizationId, organizationId), inArray(onbSystemChecks.caseId, relatedIds)),
        ),
        client.select().from(onbVoiceSessions).where(
          and(eq(onbVoiceSessions.organizationId, organizationId), inArray(onbVoiceSessions.caseId, relatedIds)),
        ),
        client.select().from(onbApprovalNotifications).where(
          and(eq(onbApprovalNotifications.organizationId, organizationId), inArray(onbApprovalNotifications.caseId, relatedIds)),
        ),
        client.select().from(onbReadinessSlaOutbox).where(
          and(eq(onbReadinessSlaOutbox.organizationId, organizationId), inArray(onbReadinessSlaOutbox.caseId, relatedIds)),
        ),
        client.select().from(onbCandidateUploads).where(
          and(eq(onbCandidateUploads.organizationId, organizationId), inArray(onbCandidateUploads.caseId, relatedIds)),
        ),
      ]);
    addCaseSafetyBlockers(
      targetRows,
      approvals,
      communications,
      effects,
      systemChecks,
      voices,
      approvalNotifications,
      slaOutbox,
      blockers,
      warnings,
    );
    if (uploads.length) {
      blockers.push("Reset would cascade candidate-upload metadata while retained objects or derivatives may remain; lifecycle deletion must reconcile it first.");
    }
    const relatedSnapshot = {
      approvals: approvals
        .map((row) => ({
          id: row.id,
          caseId: row.caseId,
          agent: row.agent,
          ruleRef: row.ruleRef,
          hitlPattern: row.hitlPattern,
          recommendation: row.recommendation,
          rationale: row.rationale,
          recordsEvidence: row.recordsEvidence,
          status: row.status,
          decidedBy: row.decidedBy,
          comment: row.comment,
          resumeAction: row.resumeAction,
          idempotencyKey: row.idempotencyKey,
          version: row.version,
        }))
        .sort((a, b) => a.id - b.id),
      communications: communications
        .map((row) => ({
          id: row.id,
          caseId: row.caseId,
          channel: row.channel,
          direction: row.direction,
          audience: row.audience,
          toAddress: row.toAddress,
          subject: row.subject,
          body: row.body,
          status: row.status,
          failureReason: row.failureReason,
          sensitive: row.sensitive,
          externalMessageId: row.externalMessageId,
          idempotencyKey: row.idempotencyKey,
          retriedBy: row.retriedBy,
          retriedAt: row.retriedAt?.toISOString() ?? null,
        }))
        .sort((a, b) => a.id - b.id),
      effects: effects
        .map((row) => ({
          logicalOperationKey: row.logicalOperationKey,
          caseId: row.caseId,
          tenantId: row.tenantId,
          toolName: row.toolName,
          argumentsHash: row.argumentsHash,
          providerIdempotency: row.providerIdempotency,
          status: row.status,
          fencingToken: row.fencingToken,
          claimOwner: row.claimOwner,
          claimUntil: row.claimUntil?.toISOString() ?? null,
          externalEffectId: row.externalEffectId,
          lastError: row.lastError,
          confirmedAt: row.confirmedAt?.toISOString() ?? null,
        }))
        .sort((a, b) => a.logicalOperationKey.localeCompare(b.logicalOperationKey)),
      systemChecks: systemChecks
        .map((row) => ({
          id: row.id,
          caseId: row.caseId,
          system: row.system,
          mode: row.mode,
          externalRef: row.externalRef,
          status: row.status,
          note: row.note,
          completedAt: row.completedAt?.toISOString() ?? null,
          lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
          escalatedAt: row.escalatedAt?.toISOString() ?? null,
        }))
        .sort((a, b) => a.id - b.id),
      voices: voices
        .map((row) => ({
          token: row.token,
          caseId: row.caseId,
          organizationId: row.organizationId,
          scenario: row.scenario,
          reason: row.reason,
          finalized: row.finalized,
          callSid: row.callSid,
          lastSpeech: row.lastSpeech,
          lastResponse: row.lastResponse,
        }))
        .sort((a, b) => a.token.localeCompare(b.token)),
      approvalNotifications: approvalNotifications
        .map((row) => ({
          id: row.id,
          approvalId: row.approvalId,
          caseId: row.caseId,
          version: row.version,
          kind: row.kind,
          recipient: row.recipient,
          subject: row.subject,
          body: row.body,
          status: row.status,
          attempts: row.attempts,
          failureReason: row.failureReason,
          providerMessageId: row.providerMessageId,
          sourceMessageId: row.sourceMessageId,
          idempotencyKey: row.idempotencyKey,
          sentAt: row.sentAt?.toISOString() ?? null,
        }))
        .sort((a, b) => a.id - b.id),
      slaOutbox: slaOutbox
        .map((row) => ({
          id: row.id,
          caseId: row.caseId,
          ledgerId: row.ledgerId,
          eventKey: row.eventKey,
          channel: row.channel,
          recipient: row.recipient,
          payload: row.payload,
          status: row.status,
          attempts: row.attempts,
          claimOwner: row.claimOwner,
          claimUntil: row.claimUntil?.toISOString() ?? null,
          deliveryInfo: row.deliveryInfo,
          lastError: row.lastError,
        }))
        .sort((a, b) => a.id - b.id),
      uploads: uploads
        .map((row) => ({
          id: row.id,
          caseId: row.caseId,
          documentId: row.documentId,
          objectPath: row.objectPath,
          originalName: row.originalName,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          checksumSha256: row.checksumSha256,
          malwareScanState: row.malwareScanState,
          malwareScanId: row.malwareScanId,
          malwareScanSha256: row.malwareScanSha256,
          validationState: row.validationState,
          validationReasons: row.validationReasons,
          validationClaimOwner: row.validationClaimOwner,
          validationClaimUntil: row.validationClaimUntil?.toISOString() ?? null,
          validationAttempts: row.validationAttempts,
        }))
        .sort((a, b) => a.id - b.id),
    };
    for (const upload of uploads) {
      const activeLease =
        upload.validationClaimOwner !== null ||
        (upload.validationClaimUntil !== null && upload.validationClaimUntil.getTime() > Date.now()) ||
        upload.malwareScanState === "scanning";
      if (activeLease) {
        blockers.push(`Case #${upload.caseId} has an active candidate-upload scan/validation lease.`);
      } else {
        warnings.push(`Case #${upload.caseId} has an inactive uploaded file whose private storage bytes will be retained.`);
      }
    }
    return {
      organizationId,
      manifest: entries,
      targetRows,
      blockers: [...new Set(blockers)],
      warnings: [...new Set(warnings)],
      receipt: parsedReceipt,
      revision: revisionFor(
        organizationId,
        targetRows,
        [...new Set(blockers)].sort(),
        parsedReceipt,
        relatedSnapshot,
      ),
      preservedCount: Math.max(0, allRows.length - targetRows.length),
      retainedUploads: uploads,
    };
  }
  return {
    organizationId,
    manifest: entries,
    targetRows,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    receipt: parsedReceipt,
    revision: revisionFor(
      organizationId,
      targetRows,
      [...new Set(blockers)].sort(),
      parsedReceipt,
      null,
    ),
    preservedCount: allRows.length,
    retainedUploads: [],
  };
}

function completedEnvelope(
  organizationId: string,
  inspection: Inspection,
): SyntheticResetEnvelope {
  const receipt = inspection.receipt!;
  const freshRows = inspection.targetRows;
  const revision = revisionFor(organizationId, freshRows, [], receipt);
  return {
    organizationId,
    status: "completed",
    revision,
    candidates: freshRows.map((row) => ({
      id: row.id,
      workerName: row.workerName,
      scenarioKey: row.scenarioKey,
    })),
    preservedCount: inspection.preservedCount,
    replacementCount: SYNTHETIC_REPLACEMENT_COUNT,
    blockers: [],
    warnings: [
      SYNTHETIC_OFFLINE_WARNING,
      ...(receipt.retainedUploadCount > 0
        ? [`${receipt.retainedUploadCount} private uploaded file descriptor(s) retained; storage bytes were not deleted.`]
        : []),
    ],
    receipt: safeReceiptResponse(receipt),
  };
}

export async function inspectSyntheticReset(
  organizationId: string,
  manifest: SyntheticResetManifest = DEFAULT_SYNTHETIC_RESET_MANIFEST,
): Promise<SyntheticResetEnvelope> {
  const entries = manifestFor(organizationId, manifest);
  if (entries.length === 0) {
    return {
      organizationId,
      status: "unavailable",
      revision: createHash("sha256").update(`unavailable:${organizationId}`).digest("hex"),
      candidates: [],
      preservedCount: 0,
      replacementCount: SYNTHETIC_REPLACEMENT_COUNT,
      blockers: ["Synthetic reset is unavailable for this organization."],
      warnings: [],
      receipt: null,
    };
  }
  const inspection = await loadInspection(organizationId, manifest);
  if (inspection.receipt) {
    const freshRows = await db
      .select()
      .from(onbCases)
      .where(
        and(
          eq(onbCases.organizationId, organizationId),
          inArray(onbCases.id, inspection.receipt.createdCaseIds),
        ),
      );
    if (freshRows.length !== inspection.receipt.createdCaseIds.length) {
      inspection.blockers.push("The receipt references missing replacement cases; manual reconciliation is required.");
      return {
        ...completedEnvelope(organizationId, {
          ...inspection,
          targetRows: freshRows,
          blockers: inspection.blockers,
        }),
        status: "blocked",
        blockers: inspection.blockers,
      };
    }
    return completedEnvelope(organizationId, {
      ...inspection,
      targetRows: freshRows,
      preservedCount: Math.max(0, (await db.select().from(onbCases).where(eq(onbCases.organizationId, organizationId))).length - freshRows.length),
    });
  }
  return {
    organizationId,
    status: inspection.blockers.length ? "blocked" : "ready",
    revision: inspection.revision,
    candidates: inspection.targetRows.map((row) => ({
      id: row.id,
      workerName: row.workerName,
      scenarioKey: row.scenarioKey,
    })),
    preservedCount: inspection.preservedCount,
    replacementCount: SYNTHETIC_REPLACEMENT_COUNT,
    blockers: inspection.blockers,
    warnings: inspection.warnings,
    receipt: null,
  };
}

function syntheticName(scenario: ScenarioDef): string {
  return `Synthetic — ${scenario.title}`;
}

function syntheticEmail(scenario: ScenarioDef): string {
  return `synthetic-${scenario.key}@synthetic.invalid`;
}

async function createFreshCases(
  tx: any,
  organizationId: string,
  logisticsDefault: Awaited<ReturnType<typeof getDay1LogisticsDefault>>,
  now: Date,
): Promise<number[]> {
  const ids: number[] = [];
  for (const [, scenarioKey] of manifestScenarioKeys.slice(0, SYNTHETIC_REPLACEMENT_COUNT)) {
    const scenario = scenarioForKey(scenarioKey);
    const profile = await resolveChecklistProfileInTransaction(tx, organizationId, checklistProfileMatchingAttributes({}, {
      workerBand: null,
      role: scenario.intake.role,
      hireType: scenario.intake.hireType,
      workerCategory: scenario.intake.workerCategory,
      geography: scenario.intake.geography,
      department: scenario.intake.department,
      legalEntity: scenario.intake.legalEntity,
    }));
    const joiningDate = new Date(
      now.getTime() + scenario.intake.joiningDateOffsetDays * 86_400_000,
    ).toISOString().slice(0, 10);
    const [row] = await tx
      .insert(onbCases)
      .values({
        organizationId,
        workerName: syntheticName(scenario),
        workerEmail: syntheticEmail(scenario),
        workerPhone: null,
        channelPreference: "email",
        hireType: scenario.intake.hireType,
        workerCategory: scenario.intake.workerCategory,
        role: scenario.intake.role,
        department: scenario.intake.department,
        geography: scenario.intake.geography,
        legalEntity: scenario.intake.legalEntity,
        managerName: scenario.intake.managerName,
        recruiterName: scenario.intake.recruiterName,
        joiningDate,
        urgency: "standard",
        lifecycleStage: "trigger-received",
        orchestrationStatus: "blocked",
        orchestrationCheckpoint: "synthetic-offline",
        orchestrationClaimOwner: null,
        orchestrationClaimUntil: null,
        readiness: readinessFromChecklist(profile.items),
        workstreams: defaultWorkstreams(),
        primarySkill: scenario.intake.primarySkill,
        skillCriticality: scenario.intake.skillCriticality,
        scenarioKey: scenario.key,
        planSummary: null,
        notes: `${SYNTHETIC_OFFLINE_MARKER} Synthetic offline sample. No real outreach, orchestration, provider dispatch, or readiness completion.`,
        syntheticProvenance: "synthetic-reset",
        candidateEmailAuthorizedAt: null,
        candidateEmailAuthorizedBy: null,
        offerAcceptanceComplete: false,
        offerAcceptanceCompletedAt: null,
        offerAcceptanceCompletedBy: null,
        checklistTemplateVersion: profile.templateVersion,
        checklistSnapshot: profile.items,
        checklistProfileId: profile.profileId,
        checklistProfileName: profile.profileName,
        checklistProfileVersion: profile.profileVersion,
        checklistMatchedCriteria: profile.matchedCriteria,
        checklistMatchExplanation: profile.explanation,
        updatedAt: now,
      })
      .returning({ id: onbCases.id });
    if (!row) throw new Error("Synthetic replacement case was not created.");
    ids.push(row.id);
    await tx.insert(onbCaseLogistics).values({
      organizationId,
      caseId: row.id,
      ...logisticsForCase(logisticsDefault, joiningDate),
    });
  }
  return ids;
}

export async function executeSyntheticReset(input: {
  organizationId: string;
  actorId: string;
  expectedRevision: string;
  manifest?: SyntheticResetManifest;
}): Promise<
  | { kind: "completed"; envelope: SyntheticResetEnvelope }
  | { kind: "conflict"; envelope: SyntheticResetEnvelope }
> {
  const manifest = input.manifest ?? DEFAULT_SYNTHETIC_RESET_MANIFEST;
  const entries = manifestFor(input.organizationId, manifest);
  if (entries.length === 0) {
    return { kind: "conflict", envelope: await inspectSyntheticReset(input.organizationId, manifest) };
  }
  // Do not wait behind the lifecycle fence if a durable provider marker is
  // already active. Provider dispatch holds that fence through its external
  // call, whereas the marker was deliberately committed first so reset can
  // fail closed immediately rather than contend with in-flight I/O.
  const preflight = await inspectSyntheticReset(input.organizationId, manifest);
  if (preflight.status !== "ready") {
    return { kind: "conflict", envelope: preflight };
  }
  if (preflight.revision !== input.expectedRevision) {
    return {
      kind: "conflict",
      envelope: {
        ...preflight,
        status: "blocked",
        blockers: [
          ...preflight.blockers,
          "Inventory changed since the preview; refresh before confirming.",
        ],
      },
    };
  }
  return withSensitiveLifecycleFence(input.organizationId, async () => {
  const logisticsDefault = await getDay1LogisticsDefault(input.organizationId);
  const outcome = await db.transaction(async (tx) => {
    // A row lock alone cannot serialize two transactions when the receipt
    // setting does not exist yet.  The advisory lock is transaction-scoped
    // and requires no schema/migration.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`synthetic-reset:${input.organizationId}`}))`,
    );
    const [auditLifecycle] = await tx.select({
      legalHoldActive: onbAuditLifecycles.legalHoldActive,
    }).from(onbAuditLifecycles).where(
      eq(onbAuditLifecycles.organizationId, input.organizationId),
    ).for("update");
    // A legal hold applies to the case, its snapshots, documents and evidence;
    // synthetic-reset is the only production case deletion boundary and must
    // not bypass that preservation obligation.
    if (auditLifecycle?.legalHoldActive) {
      return { kind: "conflict" as const, inspection: await loadInspection(input.organizationId, manifest, tx, true) };
    }
    const inspection = await loadInspection(input.organizationId, manifest, tx, true);
    if (await sensitiveLifecycleCaseDeletionBlockedInTransaction(
      tx,
      input.organizationId,
      inspection.targetRows.map((row) => row.id),
    )) {
      return { kind: "conflict" as const, inspection: await loadInspection(input.organizationId, manifest, tx, true) };
    }
    if (inspection.receipt || inspection.revision !== input.expectedRevision || inspection.blockers.length) {
      return { kind: "conflict" as const, inspection };
    }
    const oldIds = inspection.targetRows.map((row) => row.id);
    const now = new Date();
    // Fences the one known ancient legacy row before deletion. Modern workers
    // retain their existing claim/status blockers above.
    for (const row of inspection.targetRows) {
      if (isProvablyStaleLegacyRunning(row, now.getTime())) {
        await tx.update(onbCases).set({
          orchestrationStatus: "blocked",
          orchestrationCheckpoint: "synthetic-reset-fence",
          orchestrationClaimToken: sql`${onbCases.orchestrationClaimToken} + 1`,
          updatedAt: now,
        }).where(and(eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, row.id)));
      }
    }
    const retainedUploads = inspection.retainedUploads.map((upload) => ({
      caseId: upload.caseId,
      uploadId: upload.id,
      objectPath: upload.objectPath,
      originalName: upload.originalName,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
    }));
    // The effect journal intentionally survives case cleanup.  Its FK is
    // SET NULL in the deployed database; doing this explicitly also keeps
    // this one-off safe if a legacy database still has a restrictive FK.
    if (oldIds.length) {
      await tx.update(onbEffectJournal).set({ caseId: null }).where(
        and(
          eq(onbEffectJournal.organizationId, input.organizationId),
          inArray(onbEffectJournal.caseId, oldIds),
        ),
      );
      const deleted = await tx.delete(onbCases).where(
        and(
          eq(onbCases.organizationId, input.organizationId),
          inArray(onbCases.id, oldIds),
        ),
      ).returning({ id: onbCases.id });
      if (deleted.length !== oldIds.length) {
        throw new Error("Synthetic reset case deletion was fenced by a concurrent writer.");
      }
      for (const deletedCase of deleted) {
        await appendProtectedAuditInTransaction(tx, {
          organizationId: input.organizationId,
          actorId: input.actorId,
          actorKind: "authenticated",
          actorAuthority: "tenant-membership:owner-or-admin",
          action: "onboarding.case.deleted",
          outcome: "success",
          objectType: "case",
          objectId: String(deletedCase.id),
          caseReference: `case:${deletedCase.id}`,
          source: "synthetic-reset",
          correlationId: input.expectedRevision,
          payload: { syntheticReset: true },
        });
      }
    }
    const createdCaseIds = await createFreshCases(tx, input.organizationId, logisticsDefault, now);
    const receipt: Receipt = {
      version: 1,
      organizationId: input.organizationId,
      actorId: input.actorId,
      completedAt: now.toISOString(),
      deletedCaseIds: [...oldIds],
      createdCaseIds,
      retainedUploadCount: retainedUploads.length,
      retainedUploads,
    };
    await tx.insert(onbSettings).values({
      organizationId: input.organizationId,
      key: SYNTHETIC_RESET_RECEIPT_KEY,
      value: JSON.stringify(receipt),
      updatedAt: now,
    });
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: null,
      agent: "human",
      engine: "human",
      hitlPattern: "approve-before-act",
      ruleRef: "USERCONFIRMED synthetic reset",
      title: "Synthetic onboarding cases replaced",
      detail: `Actor ${input.actorId} replaced ${oldIds.length} explicitly-manifested synthetic legacy case(s) with ${createdCaseIds.length} paused offline sample case(s). Retained upload descriptors: ${retainedUploads.length}. No provider effects were dispatched.`,
      idempotencyKey: `${SYNTHETIC_RESET_RECEIPT_KEY}:${input.organizationId}`,
      createdAt: now,
    });
    const committedInspection = await loadInspection(input.organizationId, manifest, tx);
    return { kind: "completed" as const, inspection: { ...committedInspection, receipt } };
  });
  if (outcome.kind === "conflict") {
    const envelope = outcome.inspection.receipt
      ? await inspectSyntheticReset(input.organizationId, manifest)
      : {
          organizationId: input.organizationId,
          status: outcome.inspection.blockers.length ? "blocked" as const : "blocked" as const,
          revision: outcome.inspection.revision,
          candidates: outcome.inspection.targetRows.map((row) => ({
            id: row.id,
            workerName: row.workerName,
            scenarioKey: row.scenarioKey,
          })),
          preservedCount: outcome.inspection.preservedCount,
          replacementCount: SYNTHETIC_REPLACEMENT_COUNT as 6,
          blockers: outcome.inspection.blockers.length
            ? outcome.inspection.blockers
            : ["Inventory changed since the preview; refresh before confirming."],
          warnings: outcome.inspection.warnings,
          receipt: null,
        };
    return { kind: "conflict", envelope };
  }
  const envelope = await inspectSyntheticReset(input.organizationId, manifest);
  return { kind: "completed", envelope };
  });
}
