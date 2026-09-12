import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbAuthorityAssignments,
  onbCases,
  onbConnectors,
  onbEarlyTenureSurveyResponses,
  onbEmploymentOutcomeEvidence,
  onbOutcomeEvidenceAuthorityReceipts,
  type OnbAuthorityRole,
  type OnbAuthorityScope,
} from "@workspace/db/schema";
import type {
  OutcomeEmploymentEvidence,
  OutcomeKpiResponse,
  OutcomeSurveyResponse,
} from "./outcome-kpis";
import { hasCurrentAuthorityScope, roleMayExerciseScope } from "./decision-authority";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import type { OnboardingDbTransaction } from "./settings";
import {
  assertCaseDerivedLifecycleWriteAllowedInTransaction,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

/**
 * Analytics exports deliberately operate on KPI aggregates, never source
 * evidence. This keeps raw voluntary-survey and employment evidence inside the
 * reporting boundary while Power BI activation is still pending.
 */
export const OUTCOME_EXPORT_MINIMUM_COHORT = 5;
export const OUTCOME_ANALYTICS_INTEGRATION_STATE = "pending-powerbi" as const;
const REPORTING_HUMAN_AUTHORITY_SCOPE: OnbAuthorityScope = "hr-compliance-approve";
const VOLUNTARY_SURVEY_OUTCOME_CAPABILITY = "voluntary onboarding survey/eNPS";

function invalid(message: string): never {
  const error = new Error(message);
  error.name = "OutcomeReportingValidationError";
  throw error;
}

function requiredText(value: unknown, field: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    invalid(`${field} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}

function requiredDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    invalid(`${field} must be a valid ISO date/time.`);
  }
  const result = new Date(value);
  if (result.getTime() > Date.now() + 5 * 60_000) invalid(`${field} cannot be in the future.`);
  return result;
}

async function reportingCase(
  tx: OnboardingDbTransaction,
  organizationId: string,
  caseId: number,
) {
  const [c] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, organizationId),
    eq(onbCases.id, caseId),
  )).for("update");
  if (!c) invalid("Case not found.");
  if (isSyntheticOfflineCase(c) || c.scenarioKey) {
    invalid("Synthetic, demo, and offline cases cannot produce outcome evidence.");
  }
  await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, { organizationId, caseId });
  return c;
}

async function humanAuthorityBinding(
  tx: OnboardingDbTransaction,
  c: typeof onbCases.$inferSelect,
  actorUserId: string,
): Promise<typeof onbAuthorityAssignments.$inferSelect> {
  if (!(await hasCurrentAuthorityScope(tx, {
    organizationId: c.organizationId,
    actorUserId,
    scope: REPORTING_HUMAN_AUTHORITY_SCOPE,
    caseId: c.id,
  }))) {
    invalid("Current governance-approved HR compliance authority is required to record human outcome evidence.");
  }
  const now = new Date();
  const rows = await tx.select().from(onbAuthorityAssignments).where(and(
    eq(onbAuthorityAssignments.organizationId, c.organizationId),
    eq(onbAuthorityAssignments.personUserId, actorUserId),
    eq(onbAuthorityAssignments.status, "active"),
    lte(onbAuthorityAssignments.validFrom, now),
    sql`(${onbAuthorityAssignments.validUntil} is null or ${onbAuthorityAssignments.validUntil} > ${now})`,
  )).for("update");
  const authority = rows.find((item) =>
    item.scopes.includes(REPORTING_HUMAN_AUTHORITY_SCOPE) &&
    roleMayExerciseScope(item.authorityRole, REPORTING_HUMAN_AUTHORITY_SCOPE) &&
    (item.caseId === null || item.caseId === c.id) &&
    (!item.siteScope || item.siteScope === c.geography) &&
    (!item.jurisdictionScope || item.jurisdictionScope === c.legalEntity)
  );
  if (!authority) invalid("A live HR compliance authority assignment binding is required.");
  return authority;
}

function persistedHumanAuthorityIsValid(
  evidence: {
    provenance: string;
    authorityAssignmentId: string | null;
    authorityAssignmentRevision: number | null;
    authorityReceiptId: number | null;
    recordedByUserId: string;
  },
  receipt: typeof onbOutcomeEvidenceAuthorityReceipts.$inferSelect | undefined,
  c: typeof onbCases.$inferSelect | undefined,
): boolean {
  if (evidence.provenance !== "human-authorized" || !receipt || !c ||
    evidence.authorityReceiptId !== receipt.id ||
    evidence.authorityAssignmentId !== receipt.authorityAssignmentId ||
    evidence.authorityAssignmentRevision !== receipt.authorityAssignmentRevision ||
    receipt.organizationId !== c.organizationId ||
    receipt.actorUserId !== evidence.recordedByUserId ||
    receipt.scope !== REPORTING_HUMAN_AUTHORITY_SCOPE ||
    !roleMayExerciseScope(receipt.authorityRole as OnbAuthorityRole, REPORTING_HUMAN_AUTHORITY_SCOPE) ||
    receipt.caseId !== c.id ||
    (receipt.siteScope !== null && receipt.siteScope !== c.geography) ||
    (receipt.jurisdictionScope !== null && receipt.jurisdictionScope !== c.legalEntity)
  ) {
    return false;
  }
  return receipt.validFrom <= receipt.verifiedAt &&
    (receipt.validUntil === null || receipt.validUntil > receipt.verifiedAt);
}

async function createHumanAuthorityReceipt(
  tx: OnboardingDbTransaction,
  c: typeof onbCases.$inferSelect,
  authority: typeof onbAuthorityAssignments.$inferSelect,
): Promise<number> {
  const [receipt] = await tx.insert(onbOutcomeEvidenceAuthorityReceipts).values({
    organizationId: c.organizationId,
    authorityAssignmentId: authority.id,
    authorityAssignmentRevision: authority.revision,
    actorUserId: authority.personUserId,
    authorityRole: authority.authorityRole,
    scope: REPORTING_HUMAN_AUTHORITY_SCOPE,
    caseId: c.id,
    siteScope: authority.siteScope,
    jurisdictionScope: authority.jurisdictionScope,
    validFrom: authority.validFrom,
    validUntil: authority.validUntil,
  }).returning({ id: onbOutcomeEvidenceAuthorityReceipts.id });
  return receipt!.id;
}

async function assertTrustedConnector(
  tx: OnboardingDbTransaction,
  organizationId: string,
  sourceConnectorKey: string,
  requirement?: { key?: string; capability?: string },
): Promise<void> {
  if (requirement?.key && sourceConnectorKey !== requirement.key) {
    invalid(`Trusted employment evidence must originate from ${requirement.key}.`);
  }
  const [connector] = await tx.select().from(onbConnectors).where(and(
    eq(onbConnectors.organizationId, organizationId),
    eq(onbConnectors.key, sourceConnectorKey),
  )).for("update");
  if (!connector || connector.status !== "connected" ||
    connector.configurationProvenance !== "trusted-provider") {
    invalid("The source connector is not an active trusted provider.");
  }
  if (requirement?.capability && !connector.authoritativeFor.includes(requirement.capability)) {
    invalid("The source connector is not explicitly authorized for voluntary onboarding survey outcomes.");
  }
}

async function verifiedActualJoiningAnchor(
  tx: OnboardingDbTransaction,
  c: typeof onbCases.$inferSelect,
): Promise<Date> {
  const evidence = await tx.select().from(onbEmploymentOutcomeEvidence).where(and(
    eq(onbEmploymentOutcomeEvidence.organizationId, c.organizationId),
    eq(onbEmploymentOutcomeEvidence.caseId, c.id),
  )).for("update");
  const receiptIds = [...new Set(evidence
    .filter((row) => row.provenance === "human-authorized")
    .map((row) => row.authorityReceiptId)
    .filter((id): id is number => id !== null))];
  const receipts = receiptIds.length === 0 ? [] : await tx.select().from(onbOutcomeEvidenceAuthorityReceipts)
    .where(and(
      eq(onbOutcomeEvidenceAuthorityReceipts.organizationId, c.organizationId),
      inArray(onbOutcomeEvidenceAuthorityReceipts.id, receiptIds),
    )).for("update");
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const anchors = new Set<number>();
  for (const row of evidence) {
    const humanValid = persistedHumanAuthorityIsValid(
      row,
      row.authorityReceiptId ? byId.get(row.authorityReceiptId) : undefined,
      c,
    );
    if ((row.provenance === "trusted-provider" && row.sourceConnectorKey === "hris") || humanValid) {
      anchors.add(row.actualJoinedAt.getTime());
    }
  }
  if (anchors.size !== 1) {
    invalid("A single trustworthy actual joining record is required before recording a 30-day survey outcome.");
  }
  return new Date([...anchors][0]!);
}

type SurveyEvidenceInput = {
  organizationId: string;
  caseId: number;
  actorUserId: string;
  score: number;
  submittedAt: string;
  evidenceReference: string;
  provenance: "human-authorized" | "trusted-provider";
  sourceConnectorKey?: string;
};

export async function recordOutcomeSurveyEvidence(input: SurveyEvidenceInput): Promise<void> {
  if (!Number.isInteger(input.caseId) || input.caseId < 1) invalid("caseId must be a positive integer.");
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 10) invalid("score must be an integer from 0 to 10.");
  const submittedAt = requiredDate(input.submittedAt, "submittedAt");
  const evidenceReference = requiredText(input.evidenceReference, "evidenceReference");
  const sourceConnectorKey = input.sourceConnectorKey?.trim();
  return await withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await reportingCase(tx, input.organizationId, input.caseId);
    // Authenticate the caller/source before reading an employment anchor or
    // testing its date. Otherwise validation errors disclose case state.
    const authority = input.provenance === "human-authorized"
      ? await humanAuthorityBinding(tx, c, input.actorUserId)
      : null;
    if (input.provenance === "trusted-provider") {
      if (!sourceConnectorKey) invalid("Trusted survey evidence requires sourceConnectorKey.");
      await assertTrustedConnector(tx, input.organizationId, sourceConnectorKey, {
        capability: VOLUNTARY_SURVEY_OUTCOME_CAPABILITY,
      });
    }
    const actualJoinedAt = await verifiedActualJoiningAnchor(tx, c);
    if (submittedAt < new Date(actualJoinedAt.getTime() + 30 * 86_400_000)) {
      invalid("submittedAt must be at least 30 days after the trustworthy actual joining record.");
    }
    if (input.provenance === "trusted-provider") {
      await tx.insert(onbEarlyTenureSurveyResponses).values({
        organizationId: input.organizationId, caseId: input.caseId, surveyKind: "onboarding-30-day",
        voluntary: true, score: input.score, submittedAt, provenance: input.provenance,
        sourceConnectorKey, evidenceReference, recordedByUserId: input.actorUserId,
      });
      return;
    }
    const authorityReceiptId = await createHumanAuthorityReceipt(tx, c, authority!);
    await tx.insert(onbEarlyTenureSurveyResponses).values({
      organizationId: input.organizationId, caseId: input.caseId, surveyKind: "onboarding-30-day",
      voluntary: true, score: input.score, submittedAt, provenance: input.provenance,
      authorityAssignmentId: authority!.id, authorityAssignmentRevision: authority!.revision, authorityReceiptId,
      evidenceReference, recordedByUserId: input.actorUserId,
    });
  }));
}

type EmploymentEvidenceInput = {
  organizationId: string;
  caseId: number;
  actorUserId: string;
  actualJoinedAt: string;
  employmentStatus: "active" | "terminated" | "unknown";
  effectiveAt?: string;
  correctsEvidenceId?: number;
  observedAt: string;
  evidenceReference: string;
  provenance: "human-authorized" | "trusted-provider";
  sourceConnectorKey?: string;
};

export async function recordEmploymentOutcomeEvidence(input: EmploymentEvidenceInput): Promise<number> {
  if (!Number.isInteger(input.caseId) || input.caseId < 1) invalid("caseId must be a positive integer.");
  const actualJoinedAt = requiredDate(input.actualJoinedAt, "actualJoinedAt");
  const observedAt = requiredDate(input.observedAt, "observedAt");
  const effectiveAt = input.effectiveAt ? requiredDate(input.effectiveAt, "effectiveAt") : null;
  if (!["active", "terminated", "unknown"].includes(input.employmentStatus)) invalid("employmentStatus must be active, terminated, or unknown.");
  if (actualJoinedAt > observedAt) invalid("actualJoinedAt cannot be after observedAt.");
  if (input.employmentStatus === "terminated" && !effectiveAt) invalid("Terminated employment evidence requires effectiveAt.");
  if (input.employmentStatus !== "terminated" && effectiveAt) invalid("Only terminated employment evidence may include effectiveAt.");
  if (effectiveAt && (effectiveAt < actualJoinedAt || effectiveAt > observedAt)) invalid("effectiveAt must be between actualJoinedAt and observedAt.");
  if (input.correctsEvidenceId !== undefined && (!Number.isInteger(input.correctsEvidenceId) || input.correctsEvidenceId < 1)) {
    invalid("correctsEvidenceId must be a positive integer when provided.");
  }
  if (input.correctsEvidenceId !== undefined && input.employmentStatus !== "active") {
    invalid("correctsEvidenceId may be supplied only for an active correction.");
  }
  const evidenceReference = requiredText(input.evidenceReference, "evidenceReference");
  const sourceConnectorKey = input.sourceConnectorKey?.trim();
  return await withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await reportingCase(tx, input.organizationId, input.caseId);
    // Verify authority/source before probing a referenced evidence record.
    const authority = input.provenance === "human-authorized"
      ? await humanAuthorityBinding(tx, c, input.actorUserId)
      : null;
    if (input.provenance === "trusted-provider") {
      if (!sourceConnectorKey) invalid("Trusted employment evidence requires sourceConnectorKey.");
      await assertTrustedConnector(tx, input.organizationId, sourceConnectorKey, { key: "hris" });
    }
    if (input.correctsEvidenceId !== undefined) {
      const [corrected] = await tx.select().from(onbEmploymentOutcomeEvidence).where(and(
        eq(onbEmploymentOutcomeEvidence.organizationId, input.organizationId),
        eq(onbEmploymentOutcomeEvidence.caseId, input.caseId),
        eq(onbEmploymentOutcomeEvidence.id, input.correctsEvidenceId),
      )).for("update");
      if (!corrected || corrected.employmentStatus !== "terminated" ||
        corrected.actualJoinedAt.getTime() !== actualJoinedAt.getTime() ||
        observedAt <= corrected.observedAt) {
        invalid("correctsEvidenceId must identify an earlier terminated record for this case and actual joining anchor.");
      }
    }
    if (input.provenance === "trusted-provider") {
      const [created] = await tx.insert(onbEmploymentOutcomeEvidence).values({
        organizationId: input.organizationId, caseId: input.caseId, actualJoinedAt,
        employmentStatus: input.employmentStatus, effectiveAt, correctsEvidenceId: input.correctsEvidenceId ?? null, observedAt,
        provenance: input.provenance, sourceConnectorKey, evidenceReference,
        recordedByUserId: input.actorUserId,
      }).returning({ id: onbEmploymentOutcomeEvidence.id });
      return created!.id;
    }
    const authorityReceiptId = await createHumanAuthorityReceipt(tx, c, authority!);
    const [created] = await tx.insert(onbEmploymentOutcomeEvidence).values({
      organizationId: input.organizationId, caseId: input.caseId, actualJoinedAt,
      employmentStatus: input.employmentStatus, effectiveAt, correctsEvidenceId: input.correctsEvidenceId ?? null, observedAt,
      provenance: input.provenance, authorityAssignmentId: authority!.id,
      authorityAssignmentRevision: authority!.revision, authorityReceiptId, evidenceReference,
      recordedByUserId: input.actorUserId,
    }).returning({ id: onbEmploymentOutcomeEvidence.id });
    return created!.id;
  }));
}

/**
 * Source evidence is projected only into KPI calculation types. No caller is
 * given raw row access, references, authority IDs, or employee identifiers.
 */
export async function loadOutcomeReportingEvidence(
  organizationId: string,
  caseIds: readonly number[],
): Promise<{ surveyResponses: OutcomeSurveyResponse[]; employmentEvidence: OutcomeEmploymentEvidence[] }> {
  if (caseIds.length === 0) return { surveyResponses: [], employmentEvidence: [] };
  const [surveys, employment, cases] = await Promise.all([
    db.select().from(onbEarlyTenureSurveyResponses).where(and(
      eq(onbEarlyTenureSurveyResponses.organizationId, organizationId),
      inArray(onbEarlyTenureSurveyResponses.caseId, [...caseIds]),
    )).orderBy(desc(onbEarlyTenureSurveyResponses.submittedAt), desc(onbEarlyTenureSurveyResponses.id)),
    db.select().from(onbEmploymentOutcomeEvidence).where(and(
      eq(onbEmploymentOutcomeEvidence.organizationId, organizationId),
      inArray(onbEmploymentOutcomeEvidence.caseId, [...caseIds]),
    )).orderBy(desc(onbEmploymentOutcomeEvidence.observedAt), desc(onbEmploymentOutcomeEvidence.id)),
    db.select().from(onbCases).where(and(
      eq(onbCases.organizationId, organizationId),
      inArray(onbCases.id, [...caseIds]),
    )),
  ]);
  const receiptIds = [...new Set([...surveys, ...employment]
    .filter((row) => row.provenance === "human-authorized")
    .map((row) => row.authorityReceiptId)
    .filter((id): id is number => id !== null))];
  const receipts = receiptIds.length === 0 ? [] : await db.select().from(onbOutcomeEvidenceAuthorityReceipts)
    .where(and(
      eq(onbOutcomeEvidenceAuthorityReceipts.organizationId, organizationId),
      inArray(onbOutcomeEvidenceAuthorityReceipts.id, receiptIds),
    ));
  const casesById = new Map(cases.map((c) => [c.id, c]));
  const receiptsById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const humanVerified = (row: typeof surveys[number] | typeof employment[number]) =>
    persistedHumanAuthorityIsValid(
      row,
      row.authorityReceiptId ? receiptsById.get(row.authorityReceiptId) : undefined,
      casesById.get(row.caseId),
    );
  const employmentProjection = employment.map((row) => ({
    id: row.id, caseId: row.caseId, actualJoinedAt: row.actualJoinedAt,
    employmentStatus: row.employmentStatus, effectiveAt: row.effectiveAt,
    correctsEvidenceId: row.correctsEvidenceId, observedAt: row.observedAt,
    provenance: row.provenance, sourceConnectorKey: row.sourceConnectorKey,
    humanAuthorityVerified: humanVerified(row),
  }));
  const actualJoinsByCase = new Map<number, Date | null>();
  for (const row of employmentProjection) {
    const authoritative = row.provenance === "trusted-provider" && row.sourceConnectorKey === "hris" ||
      row.provenance === "human-authorized" && row.humanAuthorityVerified;
    if (!authoritative) continue;
    const current = actualJoinsByCase.get(row.caseId);
    if (current === undefined) actualJoinsByCase.set(row.caseId, row.actualJoinedAt);
    else if (current === null || current.getTime() !== row.actualJoinedAt.getTime()) actualJoinsByCase.set(row.caseId, null);
  }
  return {
    surveyResponses: surveys.map((row) => ({
      id: row.id, caseId: row.caseId, surveyKind: row.surveyKind,
      voluntary: row.voluntary, score: row.score, submittedAt: row.submittedAt,
      actualJoinedAt: actualJoinsByCase.get(row.caseId) ?? null,
      provenance: row.provenance, sourceConnectorKey: row.sourceConnectorKey,
      humanAuthorityVerified: humanVerified(row),
    })),
    employmentEvidence: employmentProjection,
  };
}

export type PrivacyScopedOutcomeExportRow = {
  metricId: string;
  label: string;
  definition: string;
  unit: string;
  targetLabel: string;
  baseline: string;
  publicationStatus: "published" | "suppressed";
  suppressionReason: string | null;
  value: number | null;
  eligibleCount: number | null;
  sampleSize: number | null;
  unknownCount: number | null;
  status: string;
};

export type PrivacyScopedOutcomeExport = {
  schemaVersion: "task254-outcome-aggregates-v1";
  integrationState: typeof OUTCOME_ANALYTICS_INTEGRATION_STATE;
  asOf: string;
  cohortLabel: string;
  minimumCohort: number;
  individualLevelDataIncluded: false;
  rows: PrivacyScopedOutcomeExportRow[];
};

export function privacyScopedOutcomeExport(
  report: OutcomeKpiResponse,
  minimumCohort = OUTCOME_EXPORT_MINIMUM_COHORT,
): PrivacyScopedOutcomeExport {
  if (!Number.isSafeInteger(minimumCohort) || minimumCohort < 1) {
    throw new Error("Outcome export minimum cohort must be a positive integer");
  }
  return {
    schemaVersion: "task254-outcome-aggregates-v1",
    integrationState: OUTCOME_ANALYTICS_INTEGRATION_STATE,
    asOf: report.asOf,
    cohortLabel: report.cohortLabel,
    minimumCohort,
    individualLevelDataIncluded: false,
    rows: report.metrics.map((metric) => {
      const suppressed = metric.sampleSize === null || metric.sampleSize < minimumCohort;
      return {
        metricId: metric.id,
        label: metric.label,
        definition: metric.definition,
        unit: metric.unit,
        targetLabel: metric.targetLabel,
        baseline: metric.baseline,
        publicationStatus: suppressed ? "suppressed" : "published",
        suppressionReason: suppressed
          ? `Fewer than ${minimumCohort} usable observations; aggregate withheld.`
          : null,
        value: suppressed ? null : metric.value,
        eligibleCount: suppressed ? null : metric.eligibleCount,
        sampleSize: suppressed ? null : metric.sampleSize,
        unknownCount: suppressed ? null : metric.unknownCount,
        // `met`/`missed` would disclose the suppressed aggregate just as a
        // numeric value would, so the exported status must be non-inferential.
        status: suppressed ? "insufficient-data" : metric.status,
      };
    }),
  };
}

/** CSV cells are formula-safe when a privacy-scoped export is opened in Excel. */
export function outcomeExportCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

export function privacyScopedOutcomeExportCsv(exported: PrivacyScopedOutcomeExport): string {
  const header = [
    "metricId", "label", "definition", "unit", "targetLabel", "baseline",
    "publicationStatus", "suppressionReason", "value", "eligibleCount",
    "sampleSize", "unknownCount", "status",
  ];
  const rows = exported.rows.map((row) => [
    row.metricId, row.label, row.definition, row.unit, row.targetLabel,
    row.baseline, row.publicationStatus, row.suppressionReason, row.value,
    row.eligibleCount, row.sampleSize, row.unknownCount, row.status,
  ].map(outcomeExportCsvCell).join(","));
  return [
    `# schema_version=${exported.schemaVersion}`,
    `# integration_state=${exported.integrationState}`,
    `# as_of=${exported.asOf}`,
    `# minimum_cohort=${exported.minimumCohort}`,
    "# individual_level_data_included=false",
    header.join(","),
    ...rows,
  ].join("\n");
}