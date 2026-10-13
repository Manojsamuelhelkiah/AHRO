import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbTransferConsultationMilestones,
  onbTransferCutoverPlans,
  onbTransferCutoverReconciliations,
  onbTransferCutoverSignoffs,
  onbTransferDataGovernance,
  onbTransferKpiDefinitions,
  onbTransferImportPreviews,
  onbTransferImports,
  onbTransferIntegrationActions,
  onbTransferKpiEvidence,
  onbTransferObjections,
  onbTransferOperationalSupersessions,
  onbTransferPathways,
  onbTransferPopulations,
  onbTransferReconciliationRepairs,
  onbTransferPrograms,
  onbTransferWorkers,
  organizationMembershipsTable,
  type OnbAuthorityScope,
  type TransferBasis,
} from "@workspace/db";
import { roleMayExerciseScope } from "./decision-authority";
import { hasHumanPermissions } from "../human-permissions";
import { appendProtectedAuditInTransaction } from "./protected-audit";
import { withSensitiveLifecycleFence } from "./sensitive-lifecycle";

const BASIS = ["automatic-transfer", "share-purchase", "asset-purchase", "cross-border"] as const;
const OFFER = ["not-required", "required", "legal-review-required"] as const;
const RECONCILIATION_STREAMS = ["migration", "payroll", "benefits", "access", "first-pay"] as const;
const RECONCILIATION_STATUSES = ["pending", "ready", "complete", "exception", "unknown-effect-manual-repair"] as const;
const KPI_METRICS = ["service-date-accurate", "consultation-timely", "access-timely", "first-pay-accurate", "actual-attrition", "harmonisation-complete"] as const;

export class TransferValidationError extends Error {
  constructor(message: string) { super(message); this.name = "TransferValidationError"; }
}
export class TransferConflictError extends Error {
  constructor(message: string) { super(message); this.name = "TransferConflictError"; }
}
const text = (value: unknown, field: string, max = 512): string => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new TransferValidationError(`${field} is required and must be at most ${max} characters.`);
  return value.trim();
};
const iso = (value: unknown, field: string, allowFuture = true): Date => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TransferValidationError(`${field} must be a valid ISO date/time.`);
  const result = new Date(value);
  if (!allowFuture && result.getTime() > Date.now() + 5 * 60_000) throw new TransferValidationError(`${field} cannot be in the future.`);
  return result;
};
const enumValue = <T extends readonly string[]>(value: unknown, values: T, field: string): T[number] => {
  if (typeof value === "string" && values.includes(value)) return value as T[number];
  throw new TransferValidationError(`${field} is invalid.`);
};
const version = (value: unknown, field = "expectedVersion") => {
  if (!Number.isInteger(value) || (value as number) < 1) throw new TransferValidationError(`${field} must be a positive integer.`);
  return value as number;
};
const stableHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function kpiMeasurement(metric: typeof KPI_METRICS[number], value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TransferValidationError("measurement is required and must contain attested source values.");
  const measurement = value as Record<string, unknown>;
  const date = (key: string) => iso(measurement[key], `measurement.${key}`, false).toISOString();
  const money = (key: string) => {
    const amount = measurement[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) throw new TransferValidationError(`measurement.${key} must be a non-negative finite number.`);
    return amount;
  };
  if (metric === "first-pay-accurate") return {
    expectedAmount: money("expectedAmount"), actualAmount: money("actualAmount"),
    expectedCurrency: text(measurement.expectedCurrency, "measurement.expectedCurrency", 8),
    actualCurrency: text(measurement.actualCurrency, "measurement.actualCurrency", 8), paidAt: date("paidAt"),
  };
  if (metric === "access-timely") return { accessGrantedAt: date("accessGrantedAt"), requiredBy: date("requiredBy") };
  if (metric === "actual-attrition") return { employmentStatusAt: date("employmentStatusAt"), employmentEndAt: measurement.employmentEndAt === undefined ? "" : date("employmentEndAt") };
  if (metric === "service-date-accurate") return {
    sourceFingerprint: text(measurement.sourceFingerprint, "measurement.sourceFingerprint", 128),
    sourceOriginalHireDate: date("sourceOriginalHireDate"), destinationOriginalHireDate: date("destinationOriginalHireDate"),
    sourceContinuousServiceDate: date("sourceContinuousServiceDate"), destinationContinuousServiceDate: date("destinationContinuousServiceDate"),
  };
  // Aggregate date facts are sourced from their persisted milestone/action.
  // Empty input is the normal API path; dated legacy callers are checked
  // against those facts before their values are retained.
  if (metric === "consultation-timely" && !Object.keys(measurement).length) return {};
  if (metric === "consultation-timely") return { completedAt: date("completedAt"), dueAt: date("dueAt") };
  if (metric === "harmonisation-complete" && !Object.keys(measurement).length) return {};
  return { actionCompletedAt: date("actionCompletedAt"), policyApprovedAt: date("policyApprovedAt") };
}
function deriveKpiOutcome(metric: typeof KPI_METRICS[number], measurement: Record<string, string | number | boolean>) {
  if (metric === "first-pay-accurate") return measurement.expectedAmount === measurement.actualAmount && measurement.expectedCurrency === measurement.actualCurrency;
  if (metric === "access-timely") return String(measurement.accessGrantedAt) <= String(measurement.requiredBy);
  if (metric === "actual-attrition") return Boolean(measurement.employmentEndAt);
  if (metric === "service-date-accurate") return measurement.sourceOriginalHireDate === measurement.destinationOriginalHireDate &&
    measurement.sourceContinuousServiceDate === measurement.destinationContinuousServiceDate;
  if (metric === "consultation-timely") return String(measurement.completedAt) <= String(measurement.dueAt);
  return String(measurement.actionCompletedAt) >= String(measurement.policyApprovedAt);
}

async function authority(tx: any, input: {
  organizationId: string; actorUserId: string; scope: OnbAuthorityScope;
  jurisdiction?: string; policyAction?: boolean;
}) {
  if (!await hasHumanPermissions(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId,
    requiredKeys: [input.policyAction ? "tool.policy.manage" : "tool.approval.decide", "flow.case.edit", "data.case.profile.edit"] }))
    throw new TransferValidationError("Current action, case-flow and profile edit permissions are required.");
  return { id: `${input.policyAction ? "human-permission/v1:policy:" : "human-permission/v1:"}${input.actorUserId}`, revision: 1, personUserId: input.actorUserId };
}
async function recordedAuthorityIsCurrent(tx: any, organizationId: string, assignmentId: string, assignmentRevision: number, scope: OnbAuthorityScope, jurisdiction?: string, policyRequired = false) {
  if (policyRequired && !assignmentId.startsWith("human-permission/v1:policy:")) return false;
  const policyAction = assignmentId.startsWith("human-permission/v1:policy:");
  const prefix = policyAction ? "human-permission/v1:policy:" : "human-permission/v1:";
  if (!assignmentId.startsWith(prefix) || assignmentRevision !== 1) return false;
  return hasHumanPermissions(tx, { organizationId, actorUserId: assignmentId.slice(prefix.length),
    requiredKeys: [policyAction ? "tool.policy.manage" : "tool.approval.decide", "flow.case.edit", "data.case.profile.edit"] });
}
async function programTx(tx: any, organizationId: string, programId: string) {
  const [program] = await tx.select().from(onbTransferPrograms).where(and(
    eq(onbTransferPrograms.organizationId, organizationId), eq(onbTransferPrograms.id, programId),
  )).for("update");
  if (!program) throw new TransferValidationError("Workforce transfer program not found.");
  return program;
}
async function assertPopulationLegalCollectionAllowed(tx: any, input: { organizationId: string; programId: string; jurisdiction: string }) {
  const [pathway, governance] = await Promise.all([
    tx.select().from(onbTransferPathways).where(and(eq(onbTransferPathways.organizationId, input.organizationId), eq(onbTransferPathways.programId, input.programId), eq(onbTransferPathways.jurisdiction, input.jurisdiction), eq(onbTransferPathways.decision, "approved"))),
    tx.select().from(onbTransferDataGovernance).where(and(eq(onbTransferDataGovernance.organizationId, input.organizationId), eq(onbTransferDataGovernance.programId, input.programId), eq(onbTransferDataGovernance.jurisdiction, input.jurisdiction), gt(onbTransferDataGovernance.retentionUntil, new Date()))),
  ]);
  if (!pathway[0] || !await recordedAuthorityIsCurrent(tx, input.organizationId, pathway[0].authorityAssignmentId, pathway[0].authorityAssignmentRevision, "legal-approve", input.jurisdiction, true)) {
    throw new TransferConflictError("A current approved Legal pathway for this population country is required before sensitive workforce data is accepted.");
  }
  if (!governance[0] || !await recordedAuthorityIsCurrent(tx, input.organizationId, governance[0].authorityAssignmentId, governance[0].authorityAssignmentRevision, "legal-approve", input.jurisdiction, true)) {
    throw new TransferConflictError("A current Legal-approved lawful basis and retention schedule is required before sensitive workforce data is accepted.");
  }
  return { pathway: pathway[0], governance: governance[0] };
}
async function bumpProgram(tx: any, program: typeof onbTransferPrograms.$inferSelect, status?: string) {
  const [updated] = await tx.update(onbTransferPrograms).set({
    version: program.version + 1, updatedAt: new Date(), ...(status ? { status } : {}),
  }).where(and(
    eq(onbTransferPrograms.organizationId, program.organizationId),
    eq(onbTransferPrograms.id, program.id),
    eq(onbTransferPrograms.version, program.version),
  )).returning();
  if (!updated) throw new TransferConflictError("Workforce transfer program changed since it was loaded.");
  return updated;
}
async function invalidateDraftCutoverReadiness(tx: any, organizationId: string, programId: string) {
  await tx.update(onbTransferCutoverPlans).set({
    readinessGeneration: sql`${onbTransferCutoverPlans.readinessGeneration} + 1`,
  }).where(and(
    eq(onbTransferCutoverPlans.organizationId, organizationId),
    eq(onbTransferCutoverPlans.programId, programId),
    eq(onbTransferCutoverPlans.status, "draft"),
  ));
}
async function audit(tx: any, organizationId: string, actor: string, action: string, objectId: string, revision?: number) {
  await appendProtectedAuditInTransaction(tx, {
    organizationId, actorId: actor, actorKind: "authenticated", actorAuthority: "verified-transfer-authority",
    action, outcome: "success", objectType: "workforce-transfer", objectId, source: "workforce-transfer",
    reviewedRevision: revision ?? null, correlationId: objectId, payload: { safeStatus: "recorded" },
  });
}
function dates(row: Record<string, string>) {
  const hire = iso(row.originalHireDate, "originalHireDate");
  const service = iso(row.continuousServiceDate, "continuousServiceDate");
  if (service < hire) throw new TransferValidationError("continuousServiceDate cannot precede originalHireDate.");
  return { hire, service };
}
function materialLegalSnapshot(
  reviewedBasis: TransferBasis,
  pathways: Array<typeof onbTransferPathways.$inferSelect>,
  governance: Array<typeof onbTransferDataGovernance.$inferSelect>,
) {
  return pathways.map((pathway) => {
    const dataGovernance = governance.find((item) => item.jurisdiction === pathway.jurisdiction);
    return {
      jurisdiction: pathway.jurisdiction, reviewedBasis, decision: pathway.decision,
      offerRequirement: pathway.offerRequirement, bgvApplicability: pathway.bgvApplicability,
      reviewReference: pathway.reviewReference, authorityAssignmentId: pathway.authorityAssignmentId,
      authorityAssignmentRevision: pathway.authorityAssignmentRevision, decidedAt: pathway.decidedAt.toISOString(),
      governance: dataGovernance ? {
        lawfulBasisReference: dataGovernance.lawfulBasisReference, retentionReference: dataGovernance.retentionReference,
        retentionUntil: dataGovernance.retentionUntil.toISOString(), authorityAssignmentId: dataGovernance.authorityAssignmentId,
        authorityAssignmentRevision: dataGovernance.authorityAssignmentRevision, approvedAt: dataGovernance.approvedAt.toISOString(),
        revision: dataGovernance.revision,
      } : null,
    };
  }).sort((left, right) => left.jurisdiction.localeCompare(right.jurisdiction));
}

export async function createTransferProgram(input: {
  organizationId: string; actorUserId: string; name: unknown; sourceLegalEntity: unknown; destinationLegalEntity: unknown;
  countries: unknown; proposedBasis: unknown; legalDay1: unknown; owners: unknown;
}) {
  const name = text(input.name, "name", 160);
  const sourceLegalEntity = text(input.sourceLegalEntity, "sourceLegalEntity", 160);
  const destinationLegalEntity = text(input.destinationLegalEntity, "destinationLegalEntity", 160);
  const countries = Array.isArray(input.countries) ? [...new Set(input.countries.map((x) => text(x, "countries[]", 120)))] : [];
  if (!countries.length) throw new TransferValidationError("At least one country is required.");
  const owners = input.owners && typeof input.owners === "object" && !Array.isArray(input.owners) ? input.owners as Record<string, unknown> : null;
  if (!owners) throw new TransferValidationError("owners is required.");
  const parsedOwners = {
    hrIntegration: text(owners.hrIntegration, "owners.hrIntegration", 200),
    legal: text(owners.legal, "owners.legal", 200),
    payroll: text(owners.payroll, "owners.payroll", 200),
    it: text(owners.it, "owners.it", 200),
  };
  const proposedBasis = enumValue(input.proposedBasis, BASIS, "proposedBasis") as TransferBasis;
  const legalDay1 = iso(input.legalDay1, "legalDay1");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "hr-compliance-approve", policyAction: true });
    const id = randomUUID();
    const [program] = await tx.insert(onbTransferPrograms).values({
      id, organizationId: input.organizationId, name, sourceLegalEntity, destinationLegalEntity, countries,
      proposedBasis, legalDay1, owners: parsedOwners, createdByUserId: input.actorUserId,
    }).returning();
    await audit(tx, input.organizationId, input.actorUserId, "onboarding.transfer-program.created", id, program!.version);
    return program!;
  }));
}

export async function createTransferPopulation(input: {
  organizationId: string; actorUserId: string; programId: string; country: unknown; sourceLegalEntity?: unknown;
  destinationLegalEntity?: unknown; expectedHeadcount?: unknown;
}) {
  const country = text(input.country, "country", 120);
  const expectedHeadcount = input.expectedHeadcount;
  if (!Number.isInteger(expectedHeadcount) || (expectedHeadcount as number) < 0) throw new TransferValidationError("expectedHeadcount is required and must be a non-negative integer.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const program = await programTx(tx, input.organizationId, input.programId);
    if (!program.countries.includes(country)) throw new TransferValidationError("Population country must be one of the program countries.");
    await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "hr-compliance-approve", jurisdiction: country });
    const [population] = await tx.insert(onbTransferPopulations).values({
      id: randomUUID(), organizationId: input.organizationId, programId: program.id, country,
      sourceLegalEntity: input.sourceLegalEntity === undefined ? program.sourceLegalEntity : text(input.sourceLegalEntity, "sourceLegalEntity", 160),
      destinationLegalEntity: input.destinationLegalEntity === undefined ? program.destinationLegalEntity : text(input.destinationLegalEntity, "destinationLegalEntity", 160),
      expectedHeadcount: expectedHeadcount as number,
    }).returning();
    const updated = await bumpProgram(tx, program);
    await audit(tx, input.organizationId, input.actorUserId, "onboarding.transfer-population.created", population!.id, updated.version);
    return population!;
  }));
}

export async function recordTransferPathway(input: {
  organizationId: string; actorUserId: string; programId: string; expectedVersion: unknown; jurisdiction: unknown;
  decision: unknown; offerRequirement: unknown; bgvApplicability: unknown; reviewReference: unknown;
}) {
  const expectedVersion = version(input.expectedVersion);
  const jurisdiction = text(input.jurisdiction, "jurisdiction", 120);
  const decision = enumValue(input.decision, ["approved", "rejected"] as const, "decision");
  const offerRequirement = enumValue(input.offerRequirement, OFFER, "offerRequirement");
  const bgvApplicability = enumValue(input.bgvApplicability, OFFER, "bgvApplicability");
  const reviewReference = text(input.reviewReference, "reviewReference");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const program = await programTx(tx, input.organizationId, input.programId);
    if (program.version !== expectedVersion) throw new TransferConflictError(`Program changed since it was loaded (current version ${program.version}).`);
    if (!program.countries.includes(jurisdiction)) throw new TransferValidationError("Pathway jurisdiction must be one of the program countries.");
    const assignment = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "legal-approve", jurisdiction, policyAction: true });
    await tx.insert(onbTransferPathways).values({
      organizationId: input.organizationId, programId: program.id, jurisdiction, decision, offerRequirement, bgvApplicability,
      reviewReference, authorityAssignmentId: assignment.id, authorityAssignmentRevision: assignment.revision, decidedByUserId: input.actorUserId,
    }).onConflictDoUpdate({
      target: [onbTransferPathways.organizationId, onbTransferPathways.programId, onbTransferPathways.jurisdiction],
      set: { decision, offerRequirement, bgvApplicability, reviewReference, authorityAssignmentId: assignment.id, authorityAssignmentRevision: assignment.revision, decidedByUserId: input.actorUserId, decidedAt: new Date() },
    });
    const pathways = await tx.select({ decision: onbTransferPathways.decision }).from(onbTransferPathways).where(and(eq(onbTransferPathways.organizationId, input.organizationId), eq(onbTransferPathways.programId, program.id)));
    const status = pathways.some((p) => p.decision === "rejected") ? "blocked" : pathways.length === program.countries.length && pathways.every((p) => p.decision === "approved") ? "legal-reviewed" : "planning";
    const updated = await bumpProgram(tx, program, status);
    await invalidateDraftCutoverReadiness(tx, input.organizationId, program.id);
    await audit(tx, input.organizationId, input.actorUserId, "onboarding.transfer-pathway.reviewed", `${program.id}:${jurisdiction}`, updated.version);
    return { version: updated.version, status: updated.status };
  }));
}

export async function recordTransferDataGovernance(input: {
  organizationId: string; actorUserId: string; programId: string; expectedVersion: unknown;
  jurisdiction: unknown; lawfulBasisReference: unknown; retentionReference: unknown; retentionUntil: unknown;
}) {
  const expectedVersion = version(input.expectedVersion);
  const jurisdiction = text(input.jurisdiction, "jurisdiction", 120);
  const retentionUntil = iso(input.retentionUntil, "retentionUntil");
  if (retentionUntil <= new Date()) throw new TransferValidationError("retentionUntil must be in the future.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const program = await programTx(tx, input.organizationId, input.programId);
    if (program.version !== expectedVersion) throw new TransferConflictError(`Program changed since it was loaded (current version ${program.version}).`);
    if (!program.countries.includes(jurisdiction)) throw new TransferValidationError("Data-governance jurisdiction must be one of the program countries.");
    const assignment = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "legal-approve", jurisdiction, policyAction: true });
    await tx.insert(onbTransferDataGovernance).values({
      organizationId: input.organizationId, programId: program.id, jurisdiction, lawfulBasisReference: text(input.lawfulBasisReference, "lawfulBasisReference"),
      retentionReference: text(input.retentionReference, "retentionReference"), retentionUntil,
      authorityAssignmentId: assignment.id, authorityAssignmentRevision: assignment.revision, approvedByUserId: input.actorUserId,
    }).onConflictDoUpdate({ target: [onbTransferDataGovernance.organizationId, onbTransferDataGovernance.programId, onbTransferDataGovernance.jurisdiction],
      set: { lawfulBasisReference: text(input.lawfulBasisReference, "lawfulBasisReference"), retentionReference: text(input.retentionReference, "retentionReference"), retentionUntil, authorityAssignmentId: assignment.id, authorityAssignmentRevision: assignment.revision, approvedByUserId: input.actorUserId, approvedAt: new Date() } });
    const updated = await bumpProgram(tx, program);
    await invalidateDraftCutoverReadiness(tx, input.organizationId, program.id);
    await audit(tx, input.organizationId, input.actorUserId, "onboarding.transfer-data-governance.approved", program.id, updated.version);
    return { version: updated.version };
  }));
}

type Normalized = Record<string, string>;
const REQUIRED_COLUMNS = ["sourceWorkerId", "workerName", "workEmail", "originalHireDate", "continuousServiceDate", "termsReference", "compensationReference", "benefitsReference"] as const;
export function previewTransferRows(mappingInput: unknown, rowsInput: unknown) {
  const mapping = mappingInput && typeof mappingInput === "object" && !Array.isArray(mappingInput) ? mappingInput as Record<string, unknown> : null;
  if (!mapping || !Array.isArray(rowsInput) || rowsInput.length === 0 || rowsInput.length > 5_000) throw new TransferValidationError("mapping and 1–5000 rows are required.");
  const map: Record<string, string> = {};
  for (const field of [...REQUIRED_COLUMNS, "permittedLiabilityReference"] as const) {
    const column = mapping[field];
    if (field !== "permittedLiabilityReference" && typeof column !== "string") throw new TransferValidationError(`mapping.${field} is required.`);
    if (typeof column === "string" && column.trim()) map[field] = column.trim();
  }
  if (new Set(Object.values(map)).size !== Object.values(map).length) throw new TransferValidationError("Each source column may map to only one transfer field.");
  const sourceIds = new Set<string>();
  const normalizedRows: Normalized[] = [];
  const errors: Array<{ row: number; field: string; message: string }> = [];
  rowsInput.forEach((candidate, index) => {
    const raw = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : null;
    const output: Normalized = {};
    if (!raw) { errors.push({ row: index + 1, field: "row", message: "Row must be an object." }); return; }
    for (const field of REQUIRED_COLUMNS) {
      const rawValue = raw[map[field]!];
      if (typeof rawValue !== "string" || !rawValue.trim() || rawValue.trim().length > 512) errors.push({ row: index + 1, field, message: `${field} is required.` });
      else output[field] = rawValue.trim();
    }
    if (map.permittedLiabilityReference) {
      const value = raw[map.permittedLiabilityReference];
      if (value !== undefined && (typeof value !== "string" || value.trim().length > 512)) errors.push({ row: index + 1, field: "permittedLiabilityReference", message: "Liability data must be an opaque permitted reference, not a payload." });
      else if (typeof value === "string" && value.trim()) output.permittedLiabilityReference = value.trim();
    }
    if (output.workEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(output.workEmail)) errors.push({ row: index + 1, field: "workEmail", message: "workEmail is invalid." });
    try { if (output.originalHireDate && output.continuousServiceDate) dates(output); } catch (e) { errors.push({ row: index + 1, field: "continuousServiceDate", message: e instanceof Error ? e.message : "Invalid service dates." }); }
    if (output.sourceWorkerId) {
      if (sourceIds.has(output.sourceWorkerId)) errors.push({ row: index + 1, field: "sourceWorkerId", message: "Duplicate stable sourceWorkerId in preview." });
      sourceIds.add(output.sourceWorkerId);
    }
    normalizedRows.push(output);
  });
  const fingerprintRows = [...normalizedRows].sort((left, right) =>
    (left.sourceWorkerId ?? "").localeCompare(right.sourceWorkerId ?? ""),
  );
  return { mapping: map, normalizedRows, errors, fingerprint: stableHash({ map, normalizedRows: fingerprintRows }) };
}

export async function createTransferImportPreview(input: { organizationId: string; actorUserId: string; populationId: string; mapping: unknown; rows: unknown }) {
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [population] = await tx.select().from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, input.organizationId), eq(onbTransferPopulations.id, input.populationId)));
    if (!population) throw new TransferValidationError("Transfer population not found.");
    const program = await programTx(tx, input.organizationId, population.programId);
    await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "hr-compliance-approve", jurisdiction: population.country });
    await assertPopulationLegalCollectionAllowed(tx, { organizationId: input.organizationId, programId: program.id, jurisdiction: population.country });
    const preview = previewTransferRows(input.mapping, input.rows);
    const id = randomUUID();
    await tx.insert(onbTransferImportPreviews).values({ id, organizationId: input.organizationId, populationId: population.id, mapping: preview.mapping, normalizedRows: preview.normalizedRows, fingerprint: preview.fingerprint, validCount: preview.normalizedRows.length - new Set(preview.errors.map((error) => error.row)).size, invalidCount: new Set(preview.errors.map((error) => error.row)).size, createdByUserId: input.actorUserId });
    await audit(tx, input.organizationId, input.actorUserId, "onboarding.transfer-import.previewed", id);
    return { previewId: id, validCount: preview.normalizedRows.length - new Set(preview.errors.map((error) => error.row)).size, invalidCount: new Set(preview.errors.map((error) => error.row)).size, errors: preview.errors, mapping: preview.mapping };
  }));
}

export async function commitTransferImport(input: {
  organizationId: string; actorUserId: string; populationId: string; previewId: string;
  idempotencyKey: unknown; expectedPopulationVersion: unknown;
}) {
  const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 160);
  const expectedPopulationVersion = version(input.expectedPopulationVersion, "expectedPopulationVersion");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [population] = await tx.select().from(onbTransferPopulations).where(and(
      eq(onbTransferPopulations.organizationId, input.organizationId), eq(onbTransferPopulations.id, input.populationId),
    )).for("update");
    if (!population) throw new TransferValidationError("Transfer population not found.");
    const program = await programTx(tx, input.organizationId, population.programId);
    const actor = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "hr-compliance-approve", jurisdiction: population.country });
    await assertPopulationLegalCollectionAllowed(tx, { organizationId: input.organizationId, programId: program.id, jurisdiction: population.country });
    const [preview] = await tx.select().from(onbTransferImportPreviews).where(and(
      eq(onbTransferImportPreviews.organizationId, input.organizationId), eq(onbTransferImportPreviews.id, input.previewId),
      eq(onbTransferImportPreviews.populationId, population.id),
    )).for("update");
    if (!preview) throw new TransferValidationError("Transfer import preview not found.");
    if (preview.invalidCount) throw new TransferConflictError("The preview has row-level validation errors and cannot be imported.");
    const [existing] = await tx.select().from(onbTransferImports).where(and(
      eq(onbTransferImports.organizationId, input.organizationId), eq(onbTransferImports.idempotencyKey, idempotencyKey),
    )).for("update");
    if (existing) {
      if (existing.populationId !== population.id || existing.previewId !== preview.id || existing.fingerprint !== preview.fingerprint) {
        throw new TransferConflictError("This idempotency key was already used with a different import preview.");
      }
      const workers = await tx.select({ stableSourceId: onbTransferWorkers.stableSourceId, id: onbTransferWorkers.id })
        .from(onbTransferWorkers).where(and(
          eq(onbTransferWorkers.organizationId, input.organizationId),
          eq(onbTransferWorkers.populationId, population.id),
          inArray(onbTransferWorkers.stableSourceId, preview.normalizedRows.map((row) => row.sourceWorkerId!)),
        ));
      return { importId: existing.id, retry: true, importedCount: existing.importedCount, workers };
    }
    if (population.version !== expectedPopulationVersion) throw new TransferConflictError(`Population changed since it was loaded (current version ${population.version}).`);
    const id = randomUUID();
    await tx.insert(onbTransferImports).values({
      id, organizationId: input.organizationId, populationId: population.id, previewId: preview.id, idempotencyKey,
      fingerprint: preview.fingerprint, createdByUserId: input.actorUserId,
    });
    const workers: Array<{ stableSourceId: string; id: string }> = [];
    for (const payload of preview.normalizedRows) {
      const sourceId = payload.sourceWorkerId;
      if (!sourceId) throw new Error("Validated preview contains no source worker id.");
      // Match the custody trigger's PostgreSQL jsonb canonical representation.
      // JSON.stringify has different spacing/key ordering and is not its hash.
      const [{ fingerprint }] = await tx.select({
        fingerprint: sql<string>`encode(digest(${JSON.stringify(payload)}::jsonb::text, 'sha256'), 'hex')`,
      }).from(onbTransferPrograms).where(and(
        eq(onbTransferPrograms.organizationId, input.organizationId),
        eq(onbTransferPrograms.id, population.programId),
      )).limit(1);
      const [prior] = await tx.select({ id: onbTransferWorkers.id, sourcePayload: onbTransferWorkers.sourcePayload, sourceFingerprint: onbTransferWorkers.sourceFingerprint, originalHireDate: onbTransferWorkers.originalHireDate, continuousServiceDate: onbTransferWorkers.continuousServiceDate }).from(onbTransferWorkers).where(and(
        eq(onbTransferWorkers.organizationId, input.organizationId), eq(onbTransferWorkers.populationId, population.id),
        eq(onbTransferWorkers.stableSourceId, sourceId),
      )).for("update");
      if (prior) {
        const current = dates(payload);
        if (prior.sourceFingerprint !== fingerprint ||
          prior.originalHireDate.getTime() !== current.hire.getTime() ||
          prior.continuousServiceDate.getTime() !== current.service.getTime()) {
          throw new TransferConflictError(`Stable source worker ${sourceId} conflicts with already imported continuity data.`);
        }
        workers.push({ stableSourceId: sourceId, id: prior.id }); continue;
      }
      const workerId = randomUUID();
      const parsedDates = dates(payload);
      await tx.insert(onbTransferWorkers).values({
        id: workerId, organizationId: input.organizationId, populationId: population.id, importId: id,
        stableSourceId: sourceId, sourcePayload: payload, sourceFingerprint: fingerprint, originalHireDate: parsedDates.hire, continuousServiceDate: parsedDates.service,
      });
      workers.push({ stableSourceId: sourceId, id: workerId });
    }
    await tx.update(onbTransferImports).set({ importedCount: workers.length }).where(and(eq(onbTransferImports.organizationId, input.organizationId), eq(onbTransferImports.id, id)));
    await tx.update(onbTransferPopulations).set({ status: "imported", version: population.version + 1 }).where(and(
      eq(onbTransferPopulations.organizationId, input.organizationId), eq(onbTransferPopulations.id, population.id), eq(onbTransferPopulations.version, population.version),
    ));
    await audit(tx, input.organizationId, actor.personUserId, "onboarding.transfer-import.committed", id);
    return { importId: id, retry: false, importedCount: workers.length, workers };
  }));
}

export async function recordConsultationMilestone(input: {
  organizationId: string; actorUserId: string; programId: string; expectedVersion: unknown; jurisdiction: unknown;
  milestoneId?: unknown; kind: unknown; dueAt: unknown; completedAt?: unknown; status: unknown; evidenceReference: unknown;
}) {
  const expectedVersion = version(input.expectedVersion);
  const jurisdiction = text(input.jurisdiction, "jurisdiction", 120);
  const status = enumValue(input.status, ["planned", "communicated", "completed", "blocked"] as const, "status");
  const dueAt = iso(input.dueAt, "dueAt");
  const completedAt = input.completedAt === undefined ? null : iso(input.completedAt, "completedAt");
  if (status === "completed" && !completedAt) throw new TransferValidationError("completedAt is required when a consultation milestone is completed.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const program = await programTx(tx, input.organizationId, input.programId);
    if (program.version !== expectedVersion) throw new TransferConflictError(`Program changed since it was loaded (current version ${program.version}).`);
    if (!program.countries.includes(jurisdiction)) throw new TransferValidationError("Milestone jurisdiction must be one of the program countries.");
    const legal = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "legal-approve", jurisdiction });
    const kind = text(input.kind, "kind", 120);
    const evidenceReference = text(input.evidenceReference, "evidenceReference");
    const milestoneId = input.milestoneId === undefined ? null : Number(input.milestoneId);
    if (milestoneId !== null && (!Number.isInteger(milestoneId) || milestoneId < 1)) throw new TransferValidationError("milestoneId must be a positive integer.");
    let stableMilestoneId: number;
    if (milestoneId === null) {
      const [created] = await tx.insert(onbTransferConsultationMilestones).values({
        organizationId: input.organizationId, programId: program.id, jurisdiction, kind, dueAt, completedAt, status,
        privateEvidenceReference: evidenceReference, authorityAssignmentId: legal.id, authorityAssignmentRevision: legal.revision, recordedByUserId: legal.personUserId,
      }).returning({ id: onbTransferConsultationMilestones.id });
      stableMilestoneId = created!.id;
    } else {
      const [existingMilestone] = await tx.select({
        status: onbTransferConsultationMilestones.status, privateEvidenceReference: onbTransferConsultationMilestones.privateEvidenceReference,
      }).from(onbTransferConsultationMilestones).where(and(eq(onbTransferConsultationMilestones.organizationId, input.organizationId), eq(onbTransferConsultationMilestones.programId, program.id), eq(onbTransferConsultationMilestones.id, milestoneId))).for("update");
      if (!existingMilestone) throw new TransferValidationError("Consultation milestone not found in this transfer program.");
      await tx.insert(onbTransferOperationalSupersessions).values({
        organizationId: input.organizationId, programId: program.id, recordKind: "consultation-milestone", recordId: String(milestoneId),
        priorStatus: existingMilestone.status, priorEvidenceReference: existingMilestone.privateEvidenceReference, supersededByUserId: legal.personUserId,
      });
      const [updatedMilestone] = await tx.update(onbTransferConsultationMilestones).set({
        jurisdiction, kind, dueAt, completedAt, status, privateEvidenceReference: evidenceReference,
        authorityAssignmentId: legal.id, authorityAssignmentRevision: legal.revision, recordedByUserId: legal.personUserId,
      }).where(and(eq(onbTransferConsultationMilestones.organizationId, input.organizationId), eq(onbTransferConsultationMilestones.programId, program.id), eq(onbTransferConsultationMilestones.id, milestoneId))).returning({ id: onbTransferConsultationMilestones.id });
      if (!updatedMilestone) throw new TransferConflictError("Consultation milestone changed while it was superseded.");
      stableMilestoneId = updatedMilestone.id;
    }
    const updated = await bumpProgram(tx, program, status === "blocked" ? "blocked" : undefined);
    await invalidateDraftCutoverReadiness(tx, input.organizationId, program.id);
    await audit(tx, input.organizationId, legal.personUserId, milestoneId === null ? "onboarding.transfer-consultation.recorded" : "onboarding.transfer-consultation.superseded", `${program.id}:${stableMilestoneId}`, updated.version);
    return { milestoneId: stableMilestoneId, version: updated.version };
  }));
}

export async function recordTransferObjection(input: {
  organizationId: string; actorUserId: string; workerId: string; expectedWorkerVersion: unknown;
  outcome: unknown; receivedAt: unknown; evidenceReference: unknown;
}) {
  const expectedWorkerVersion = version(input.expectedWorkerVersion, "expectedWorkerVersion");
  const outcome = enumValue(input.outcome, ["pending", "objected", "withdrawn", "resolved"] as const, "outcome");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [worker] = await tx.select().from(onbTransferWorkers).where(and(eq(onbTransferWorkers.organizationId, input.organizationId), eq(onbTransferWorkers.id, input.workerId))).for("update");
    if (!worker) throw new TransferValidationError("Transfer worker not found.");
    if (worker.version !== expectedWorkerVersion) throw new TransferConflictError(`Transfer worker changed since it was loaded (current version ${worker.version}).`);
    const [population] = await tx.select().from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, input.organizationId), eq(onbTransferPopulations.id, worker.populationId)));
    const program = population ? await programTx(tx, input.organizationId, population.programId) : null;
    if (!program) throw new TransferValidationError("Transfer worker population not found.");
    const hr = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "hr-compliance-approve" });
    await tx.insert(onbTransferObjections).values({ organizationId: input.organizationId, workerId: worker.id, outcome, receivedAt: iso(input.receivedAt, "receivedAt", false), privateEvidenceReference: text(input.evidenceReference, "evidenceReference"), recordedByUserId: hr.personUserId });
    const [updated] = await tx.update(onbTransferWorkers).set({ objectionStatus: outcome, version: worker.version + 1 }).where(and(eq(onbTransferWorkers.organizationId, input.organizationId), eq(onbTransferWorkers.id, worker.id), eq(onbTransferWorkers.version, worker.version))).returning();
    if (!updated) throw new TransferConflictError("Transfer worker changed while objection was recorded.");
    await audit(tx, input.organizationId, hr.personUserId, "onboarding.transfer-objection.recorded", worker.id, updated.version);
    return { workerId: worker.id, version: updated.version, objectionStatus: updated.objectionStatus };
  }));
}

export async function createTransferIntegrationAction(input: {
  organizationId: string; actorUserId: string; programId: string; expectedVersion: unknown; kind: unknown; ownerUserId: unknown;
  actionId?: unknown; dueAt: unknown; completedAt?: unknown; status?: unknown; evidenceReference?: unknown; legalApprovalReference?: unknown;
}) {
  const expectedVersion = version(input.expectedVersion);
  const kind = enumValue(input.kind, ["induction", "integration", "harmonisation", "contingency-parallel-run"] as const, "kind");
  const status = input.status === undefined ? "planned" : enumValue(input.status, ["planned", "in-progress", "completed", "blocked"] as const, "status");
  const completedAt = input.completedAt === undefined ? null : iso(input.completedAt, "completedAt", false);
  if (status === "completed" && !completedAt) throw new TransferValidationError("completedAt is required when an integration action is completed.");
  if (status !== "completed" && completedAt) throw new TransferValidationError("completedAt may only be recorded for a completed integration action.");
  const legalApprovalReference = input.legalApprovalReference === undefined ? null : text(input.legalApprovalReference, "legalApprovalReference");
  if (kind === "harmonisation" && !legalApprovalReference) throw new TransferValidationError("Harmonisation requires a Legal-approved policy reference; this action does not change terms.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const program = await programTx(tx, input.organizationId, input.programId);
    if (program.version !== expectedVersion) throw new TransferConflictError(`Program changed since it was loaded (current version ${program.version}).`);
    const hr = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "hr-compliance-approve" });
    const id = input.actionId === undefined ? randomUUID() : text(input.actionId, "actionId", 120);
    let legalApproval: { assignmentId: string; assignmentRevision: number; approvedAt: Date } | null = null;
    if (kind === "harmonisation") {
      const approvals = await tx.select({
        jurisdiction: onbTransferPathways.jurisdiction,
        authorityAssignmentId: onbTransferPathways.authorityAssignmentId,
        authorityAssignmentRevision: onbTransferPathways.authorityAssignmentRevision,
        decidedAt: onbTransferPathways.decidedAt,
      }).from(onbTransferPathways).where(and(
        eq(onbTransferPathways.organizationId, input.organizationId),
        eq(onbTransferPathways.programId, program.id),
        eq(onbTransferPathways.decision, "approved"),
        eq(onbTransferPathways.reviewReference, legalApprovalReference!),
      )).for("update");
      const approval = approvals.find((candidate: typeof approvals[number]) =>
        program.countries.includes(candidate.jurisdiction) &&
        candidate.authorityAssignmentId &&
        candidate.authorityAssignmentRevision &&
        candidate.decidedAt,
      );
      if (!approval || !await recordedAuthorityIsCurrent(
        tx, input.organizationId, approval.authorityAssignmentId,
        approval.authorityAssignmentRevision, "legal-approve", approval.jurisdiction,
      )) {
        throw new TransferConflictError("Harmonisation requires a current Legal-approved policy receipt for this transfer program.");
      }
      legalApproval = {
        assignmentId: approval.authorityAssignmentId,
        assignmentRevision: approval.authorityAssignmentRevision,
        // This timestamp was recorded by the server when Legal approved the
        // referenced pathway; caller input can never backdate this receipt.
        approvedAt: approval.decidedAt,
      };
    }
    const values = {
      kind, ownerUserId: text(input.ownerUserId, "ownerUserId", 200), dueAt: iso(input.dueAt, "dueAt"),
      status, completedAt, evidenceReference: input.evidenceReference === undefined ? null : text(input.evidenceReference, "evidenceReference"),
      legalApprovalReference,
      legalApprovalAssignmentId: legalApproval?.assignmentId ?? null,
      legalApprovalAssignmentRevision: legalApproval?.assignmentRevision ?? null,
      policyApprovedAt: legalApproval?.approvedAt ?? null,
    };
    if (input.actionId === undefined) await tx.insert(onbTransferIntegrationActions).values({ id, organizationId: input.organizationId, programId: program.id, ...values });
    else {
      const [existingAction] = await tx.select({
        status: onbTransferIntegrationActions.status, evidenceReference: onbTransferIntegrationActions.evidenceReference,
      }).from(onbTransferIntegrationActions).where(and(eq(onbTransferIntegrationActions.organizationId, input.organizationId), eq(onbTransferIntegrationActions.programId, program.id), eq(onbTransferIntegrationActions.id, id))).for("update");
      if (!existingAction) throw new TransferValidationError("Integration action not found in this transfer program.");
      await tx.insert(onbTransferOperationalSupersessions).values({
        organizationId: input.organizationId, programId: program.id, recordKind: "integration-action", recordId: id,
        priorStatus: existingAction.status, priorEvidenceReference: existingAction.evidenceReference, supersededByUserId: hr.personUserId,
      });
      const [updatedAction] = await tx.update(onbTransferIntegrationActions).set(values).where(and(eq(onbTransferIntegrationActions.organizationId, input.organizationId), eq(onbTransferIntegrationActions.programId, program.id), eq(onbTransferIntegrationActions.id, id))).returning({ id: onbTransferIntegrationActions.id });
      if (!updatedAction) throw new TransferConflictError("Integration action changed while it was superseded.");
    }
    const updated = await bumpProgram(tx, program, status === "blocked" ? "blocked" : undefined);
    await invalidateDraftCutoverReadiness(tx, input.organizationId, program.id);
    await audit(tx, input.organizationId, hr.personUserId, input.actionId === undefined ? "onboarding.transfer-integration-action.recorded" : "onboarding.transfer-integration-action.superseded", id, updated.version);
    return { actionId: id, version: updated.version };
  }));
}

export async function createTransferCutoverPlan(input: {
  organizationId: string; actorUserId: string; programId: string; expectedVersion: unknown; contingencyReference?: unknown;
}) {
  const expectedVersion = version(input.expectedVersion);
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const program = await programTx(tx, input.organizationId, input.programId);
    if (program.version !== expectedVersion) throw new TransferConflictError(`Program changed since it was loaded (current version ${program.version}).`);
    const hr = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "hr-compliance-approve" });
    const [last] = await tx.select({ version: onbTransferCutoverPlans.version }).from(onbTransferCutoverPlans).where(and(eq(onbTransferCutoverPlans.organizationId, input.organizationId), eq(onbTransferCutoverPlans.programId, program.id))).orderBy(desc(onbTransferCutoverPlans.version)).limit(1);
    const [pathways, governance] = await Promise.all([
      tx.select().from(onbTransferPathways).where(and(eq(onbTransferPathways.organizationId, input.organizationId), eq(onbTransferPathways.programId, program.id))),
      tx.select().from(onbTransferDataGovernance).where(and(eq(onbTransferDataGovernance.organizationId, input.organizationId), eq(onbTransferDataGovernance.programId, program.id))),
    ]);
    const populations = await tx.select({ id: onbTransferPopulations.id, expectedHeadcount: onbTransferPopulations.expectedHeadcount }).from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, input.organizationId), eq(onbTransferPopulations.programId, program.id)));
    const workers = populations.length ? await tx.select({ id: onbTransferWorkers.id, populationId: onbTransferWorkers.populationId, stableSourceId: onbTransferWorkers.stableSourceId, version: onbTransferWorkers.version }).from(onbTransferWorkers).where(and(
      eq(onbTransferWorkers.organizationId, input.organizationId),
      sql`${onbTransferWorkers.populationId} in (${sql.join(populations.map((p) => sql`${p.id}`), sql`, `)})`,
    )) : [];
    const id = randomUUID();
    const planVersion = (last?.version ?? 0) + 1;
    await tx.insert(onbTransferCutoverPlans).values({
      id, organizationId: input.organizationId, programId: program.id, version: planVersion, pathwaySnapshot: materialLegalSnapshot(program.proposedBasis, pathways, governance),
      workerCount: workers.length, workerSnapshot: workers.map((worker) => ({ workerId: worker.id, populationId: worker.populationId, stableSourceId: worker.stableSourceId, workerVersion: worker.version })), contingencyReference: input.contingencyReference === undefined ? null : text(input.contingencyReference, "contingencyReference"), createdByUserId: hr.personUserId,
    });
    const updated = await bumpProgram(tx, program);
    await audit(tx, input.organizationId, hr.personUserId, "onboarding.transfer-cutover-plan.created", id, updated.version);
    return { planId: id, version: planVersion, programVersion: updated.version, workerCount: workers.length };
  }));
}

const reconciliationScope = (stream: typeof RECONCILIATION_STREAMS[number]): OnbAuthorityScope =>
  stream === "access" ? "it-security-approve" : stream === "migration" ? "hr-compliance-approve" : "payroll-approve";

export async function recordTransferReconciliation(input: {
  organizationId: string; actorUserId: string; planId: string; workerId: string; expectedPlanVersion: unknown;
  stream: unknown; status: unknown; evidenceReference: unknown; sourceAttestationReference?: unknown; destinationAttestationReference?: unknown;
  destinationOriginalHireDate?: unknown; destinationContinuousServiceDate?: unknown; destinationTermsReference?: unknown; destinationBenefitsReference?: unknown; repairReference?: unknown;
}) {
  const expectedPlanVersion = version(input.expectedPlanVersion, "expectedPlanVersion");
  const stream = enumValue(input.stream, RECONCILIATION_STREAMS, "stream");
  const status = enumValue(input.status, RECONCILIATION_STATUSES, "status");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [plan] = await tx.select().from(onbTransferCutoverPlans).where(and(eq(onbTransferCutoverPlans.organizationId, input.organizationId), eq(onbTransferCutoverPlans.id, input.planId))).for("update");
    if (!plan) throw new TransferValidationError("Cutover plan not found.");
    if (plan.version !== expectedPlanVersion) throw new TransferConflictError(`Cutover plan changed since it was loaded (current version ${plan.version}).`);
    if (plan.status !== "draft") throw new TransferConflictError("A decided cutover plan cannot accept new reconciliation evidence.");
    const program = await programTx(tx, input.organizationId, plan.programId);
    const [worker] = await tx.select().from(onbTransferWorkers).where(and(eq(onbTransferWorkers.organizationId, input.organizationId), eq(onbTransferWorkers.id, input.workerId))).for("update");
    if (!worker) throw new TransferValidationError("Transfer worker not found.");
    const [population] = await tx.select().from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, input.organizationId), eq(onbTransferPopulations.id, worker.populationId)));
    if (!population || population.programId !== program.id) throw new TransferValidationError("Worker does not belong to this cutover plan program.");
    if (!(plan.workerSnapshot as Array<{ workerId: string; workerVersion: number }>).some((snapshot) => snapshot.workerId === worker.id && snapshot.workerVersion === worker.version)) throw new TransferConflictError("Worker membership or version changed after this cutover plan snapshot; create a new plan.");
    await assertPopulationLegalCollectionAllowed(tx, { organizationId: input.organizationId, programId: program.id, jurisdiction: population.country });
    const scope = reconciliationScope(stream);
    const actor = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope, jurisdiction: population.country });
    const evidenceReference = text(input.evidenceReference, "evidenceReference");
    const sourceAttestationReference = input.sourceAttestationReference === undefined ? null : text(input.sourceAttestationReference, "sourceAttestationReference");
    const destinationAttestationReference = input.destinationAttestationReference === undefined ? null : text(input.destinationAttestationReference, "destinationAttestationReference");
    const destinationOriginalHireDate = input.destinationOriginalHireDate === undefined ? null : iso(input.destinationOriginalHireDate, "destinationOriginalHireDate", false);
    const destinationContinuousServiceDate = input.destinationContinuousServiceDate === undefined ? null : iso(input.destinationContinuousServiceDate, "destinationContinuousServiceDate", false);
    const destinationTermsReference = input.destinationTermsReference === undefined ? null : text(input.destinationTermsReference, "destinationTermsReference");
    const destinationBenefitsReference = input.destinationBenefitsReference === undefined ? null : text(input.destinationBenefitsReference, "destinationBenefitsReference");
    if (stream === "migration" && status === "complete") {
      if (!sourceAttestationReference || !destinationAttestationReference || !destinationOriginalHireDate || !destinationContinuousServiceDate || !destinationTermsReference || !destinationBenefitsReference) throw new TransferValidationError("Completed migration requires source and destination attestations plus destination service dates, terms, and benefits references.");
      if (destinationOriginalHireDate.getTime() !== worker.originalHireDate.getTime() || destinationContinuousServiceDate.getTime() !== worker.continuousServiceDate.getTime()) throw new TransferConflictError("Destination service dates do not match the source-attested preserved dates.");
      if (destinationTermsReference !== worker.sourcePayload.termsReference || destinationBenefitsReference !== worker.sourcePayload.benefitsReference) throw new TransferConflictError("Destination terms or benefits reference does not match the retained source transfer record.");
    }
    const [existing] = await tx.select().from(onbTransferCutoverReconciliations).where(and(eq(onbTransferCutoverReconciliations.organizationId, input.organizationId), eq(onbTransferCutoverReconciliations.planId, plan.id), eq(onbTransferCutoverReconciliations.workerId, worker.id), eq(onbTransferCutoverReconciliations.stream, stream))).for("update");
    const repairReference = input.repairReference === undefined ? null : text(input.repairReference, "repairReference");
    if (existing?.status === "unknown-effect-manual-repair" && !repairReference) throw new TransferConflictError("Unknown external effect is immutable until an explicit human repair reference is recorded.");
    if (existing?.status === "unknown-effect-manual-repair") {
      await tx.insert(onbTransferReconciliationRepairs).values({
        organizationId: input.organizationId, planId: plan.id, workerId: worker.id, stream, priorStatus: existing.status,
        repairReference: repairReference!, authorityAssignmentId: actor.id, authorityAssignmentRevision: actor.revision, repairedByUserId: actor.personUserId,
      });
    }
    await tx.insert(onbTransferCutoverReconciliations).values({
      organizationId: input.organizationId, planId: plan.id, workerId: worker.id, stream, status, evidenceReference,
      sourceAttestationReference, sourceFingerprint: worker.sourceFingerprint, destinationAttestationReference, destinationOriginalHireDate, destinationContinuousServiceDate, destinationTermsReference, destinationBenefitsReference, repairReference, repairedAt: existing?.status === "unknown-effect-manual-repair" ? new Date() : null,
      authorityScope: scope, authorityAssignmentId: actor.id, authorityAssignmentRevision: actor.revision, recordedByUserId: actor.personUserId,
    }).onConflictDoUpdate({
      target: [onbTransferCutoverReconciliations.organizationId, onbTransferCutoverReconciliations.planId, onbTransferCutoverReconciliations.workerId, onbTransferCutoverReconciliations.stream],
      set: { status, evidenceReference, sourceAttestationReference, sourceFingerprint: worker.sourceFingerprint, destinationAttestationReference, destinationOriginalHireDate, destinationContinuousServiceDate, destinationTermsReference, destinationBenefitsReference, repairReference, repairedAt: existing?.status === "unknown-effect-manual-repair" ? new Date() : null, authorityScope: scope, authorityAssignmentId: actor.id, authorityAssignmentRevision: actor.revision, recordedByUserId: actor.personUserId, createdAt: new Date() },
    });
    const [revisedPlan] = await tx.update(onbTransferCutoverPlans).set({ version: plan.version + 1, readinessGeneration: plan.readinessGeneration + 1 }).where(and(eq(onbTransferCutoverPlans.organizationId, input.organizationId), eq(onbTransferCutoverPlans.id, plan.id), eq(onbTransferCutoverPlans.version, plan.version))).returning();
    if (!revisedPlan) throw new TransferConflictError("Cutover plan changed while reconciliation was recorded.");
    await tx.update(onbTransferWorkers).set({
      migrationStatus: stream === "migration" ? status === "complete" ? "reconciled" : status === "exception" || status === "unknown-effect-manual-repair" ? "exception" : "pending" : worker.migrationStatus,
    }).where(and(eq(onbTransferWorkers.organizationId, input.organizationId), eq(onbTransferWorkers.id, worker.id), eq(onbTransferWorkers.version, worker.version)));
    await audit(tx, input.organizationId, actor.personUserId, "onboarding.transfer-cutover-reconciliation.recorded", `${plan.id}:${worker.id}:${stream}`, plan.version);
    return { planId: plan.id, version: revisedPlan.version, stream, status };
  }));
}

const signoffScope = (role: "hr-integration" | "payroll" | "it"): OnbAuthorityScope =>
  role === "hr-integration" ? "hr-compliance-approve" : role === "payroll" ? "payroll-approve" : "it-security-approve";

export async function recordTransferCutoverSignoff(input: {
  organizationId: string; actorUserId: string; planId: string; expectedPlanVersion: unknown; role: unknown; decision: unknown; reasonReference: unknown;
}) {
  const expectedPlanVersion = version(input.expectedPlanVersion, "expectedPlanVersion");
  const role = enumValue(input.role, ["hr-integration", "payroll", "it"] as const, "role");
  const decision = enumValue(input.decision, ["approved", "blocked"] as const, "decision");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [plan] = await tx.select().from(onbTransferCutoverPlans).where(and(eq(onbTransferCutoverPlans.organizationId, input.organizationId), eq(onbTransferCutoverPlans.id, input.planId))).for("update");
    if (!plan) throw new TransferValidationError("Cutover plan not found.");
    if (plan.version !== expectedPlanVersion) throw new TransferConflictError(`Cutover plan changed since it was loaded (current version ${plan.version}).`);
    if (plan.status !== "draft") throw new TransferConflictError("A decided cutover plan cannot accept new sign-off.");
    const program = await programTx(tx, input.organizationId, plan.programId);
    const scope = signoffScope(role);
    const actor = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope });
    await tx.insert(onbTransferCutoverSignoffs).values({
      organizationId: input.organizationId, planId: plan.id, role, decision, reasonReference: text(input.reasonReference, "reasonReference"),
      readinessGeneration: plan.readinessGeneration, authorityScope: scope, authorityAssignmentId: actor.id, authorityAssignmentRevision: actor.revision, signedByUserId: actor.personUserId,
    }).onConflictDoUpdate({
      target: [onbTransferCutoverSignoffs.organizationId, onbTransferCutoverSignoffs.planId, onbTransferCutoverSignoffs.role],
      set: { decision, reasonReference: text(input.reasonReference, "reasonReference"), readinessGeneration: plan.readinessGeneration, authorityScope: scope, authorityAssignmentId: actor.id, authorityAssignmentRevision: actor.revision, signedByUserId: actor.personUserId, createdAt: new Date() },
    });
    const [revisedPlan] = await tx.update(onbTransferCutoverPlans).set({ version: plan.version + 1 }).where(and(eq(onbTransferCutoverPlans.organizationId, input.organizationId), eq(onbTransferCutoverPlans.id, plan.id), eq(onbTransferCutoverPlans.version, plan.version))).returning();
    if (!revisedPlan) throw new TransferConflictError("Cutover plan changed while sign-off was recorded.");
    await audit(tx, input.organizationId, actor.personUserId, "onboarding.transfer-cutover-signoff.recorded", `${plan.id}:${role}`, plan.version);
    return { planId: plan.id, version: revisedPlan.version, role, decision };
  }));
}

export async function decideTransferGoNoGo(input: { organizationId: string; actorUserId: string; planId: string; expectedPlanVersion: unknown; decision: unknown }) {
  const expectedPlanVersion = version(input.expectedPlanVersion, "expectedPlanVersion");
  const decision = enumValue(input.decision, ["go", "no-go"] as const, "decision");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [plan] = await tx.select().from(onbTransferCutoverPlans).where(and(eq(onbTransferCutoverPlans.organizationId, input.organizationId), eq(onbTransferCutoverPlans.id, input.planId))).for("update");
    if (!plan) throw new TransferValidationError("Cutover plan not found.");
    if (plan.version !== expectedPlanVersion) throw new TransferConflictError(`Cutover plan changed since it was loaded (current version ${plan.version}).`);
    if (plan.status !== "draft") throw new TransferConflictError("Cutover plan was already decided.");
    const program = await programTx(tx, input.organizationId, plan.programId);
    const hr = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "hr-compliance-approve" });
    const [pathways, governance, milestones, signoffs, populations, actions] = await Promise.all([
      tx.select().from(onbTransferPathways).where(and(eq(onbTransferPathways.organizationId, input.organizationId), eq(onbTransferPathways.programId, program.id))),
      tx.select().from(onbTransferDataGovernance).where(and(eq(onbTransferDataGovernance.organizationId, input.organizationId), eq(onbTransferDataGovernance.programId, program.id))),
      tx.select().from(onbTransferConsultationMilestones).where(and(eq(onbTransferConsultationMilestones.organizationId, input.organizationId), eq(onbTransferConsultationMilestones.programId, program.id))),
      tx.select().from(onbTransferCutoverSignoffs).where(and(eq(onbTransferCutoverSignoffs.organizationId, input.organizationId), eq(onbTransferCutoverSignoffs.planId, plan.id))),
      tx.select({ id: onbTransferPopulations.id, expectedHeadcount: onbTransferPopulations.expectedHeadcount }).from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, input.organizationId), eq(onbTransferPopulations.programId, program.id))),
      tx.select({ kind: onbTransferIntegrationActions.kind, status: onbTransferIntegrationActions.status, evidenceReference: onbTransferIntegrationActions.evidenceReference }).from(onbTransferIntegrationActions).where(and(eq(onbTransferIntegrationActions.organizationId, input.organizationId), eq(onbTransferIntegrationActions.programId, program.id))),
    ]);
    const workerRows = populations.length ? await tx.select({ id: onbTransferWorkers.id, populationId: onbTransferWorkers.populationId, objectionStatus: onbTransferWorkers.objectionStatus, version: onbTransferWorkers.version }).from(onbTransferWorkers).where(and(eq(onbTransferWorkers.organizationId, input.organizationId), sql`${onbTransferWorkers.populationId} in (${sql.join(populations.map((p) => sql`${p.id}`), sql`, `)})`)) : [];
    const reconciliations = workerRows.length ? await tx.select().from(onbTransferCutoverReconciliations).where(and(eq(onbTransferCutoverReconciliations.organizationId, input.organizationId), eq(onbTransferCutoverReconciliations.planId, plan.id))) : [];
    const blockers: string[] = [];
    if (decision === "go") {
      for (const jurisdiction of program.countries) {
        try {
          await assertPopulationLegalCollectionAllowed(tx, { organizationId: input.organizationId, programId: program.id, jurisdiction });
        } catch (error) {
          blockers.push(`Current lawful-basis and retention approval is required for ${jurisdiction}: ${error instanceof Error ? error.message : "approval unavailable"}`);
        }
      }
      const pathwayAuthorities = await Promise.all(pathways.map((item) => recordedAuthorityIsCurrent(tx, input.organizationId, item.authorityAssignmentId, item.authorityAssignmentRevision, "legal-approve", item.jurisdiction)));
      if (pathways.length !== program.countries.length || pathways.some((item, index) => item.decision !== "approved" || !pathwayAuthorities[index])) blockers.push("Every program country requires a current approved Legal pathway.");
       const currentLegalSnapshot = materialLegalSnapshot(program.proposedBasis, pathways, governance);
       if (stableHash(plan.pathwaySnapshot) !== stableHash(currentLegalSnapshot)) blockers.push("The Legal pathway, Legal requirements/review basis, data-governance approval, retention terms, or approving authority generation changed after the cutover snapshot; create a new cutover plan.");
       if ((program.countries as string[]).some((jurisdiction) => !milestones.some((item) => item.jurisdiction === jurisdiction && item.status === "completed"))) blockers.push("Each program jurisdiction requires at least one completed consultation milestone; absence is a blocker.");
      if (milestones.some((item) => item.status !== "completed")) blockers.push("All recorded consultation milestones must be completed.");
      if (milestones.length && !(await Promise.all(milestones.map((item) => recordedAuthorityIsCurrent(tx, input.organizationId, item.authorityAssignmentId, item.authorityAssignmentRevision, "legal-approve", item.jurisdiction)))).every(Boolean)) blockers.push("Consultation milestones must retain current Legal authority.");
      if (!actions.some((action) => action.kind === "contingency-parallel-run" && action.status === "completed" && action.evidenceReference)) blockers.push("A completed owned contingency/parallel-run action with evidence is required.");
      for (const role of ["hr-integration", "payroll", "it"] as const) {
        const signoff = signoffs.find((item) => item.role === role && item.decision === "approved");
        if (!signoff || signoff.readinessGeneration !== plan.readinessGeneration || !await recordedAuthorityIsCurrent(tx, input.organizationId, signoff.authorityAssignmentId, signoff.authorityAssignmentRevision, signoffScope(role))) blockers.push(`Current ${role} sign-off for the present readiness generation is required.`);
      }
      if (workerRows.some((worker) => worker.objectionStatus === "objected")) blockers.push("An unresolved objection/opt-out blocks a program-wide go decision.");
      const plannedWorkers = plan.workerSnapshot as Array<{ workerId: string; populationId: string; workerVersion: number }>;
      if (plannedWorkers.length !== workerRows.length || plannedWorkers.some((snapshot) => !workerRows.some((worker) => worker.id === snapshot.workerId && worker.version === snapshot.workerVersion))) blockers.push("The transfer population changed after the cutover snapshot; create a new cutover plan.");
      for (const population of populations) {
        const currentCount = workerRows.filter((worker) => worker.populationId === population.id).length;
        const snapshotCount = plannedWorkers.filter((worker) => worker.populationId === population.id).length;
        if (population.expectedHeadcount === null || currentCount !== population.expectedHeadcount || snapshotCount !== population.expectedHeadcount) blockers.push(`Population ${population.id} does not match its approved headcount of ${population.expectedHeadcount ?? "missing"}.`);
      }
      for (const worker of workerRows) for (const stream of ["migration", "payroll", "benefits", "access"] as const) {
        if (!reconciliations.some((item) => item.workerId === worker.id && item.stream === stream && item.status === "complete")) blockers.push(`Worker reconciliation is incomplete for ${stream}.`);
      }
    }
    if (blockers.length) throw new TransferConflictError(blockers.join(" "));
    const [updatedPlan] = await tx.update(onbTransferCutoverPlans).set({ status: decision, decisionAt: new Date(), decidedByUserId: hr.personUserId }).where(and(eq(onbTransferCutoverPlans.organizationId, input.organizationId), eq(onbTransferCutoverPlans.id, plan.id), eq(onbTransferCutoverPlans.status, "draft"))).returning();
    if (!updatedPlan) throw new TransferConflictError("Cutover plan was decided concurrently.");
    const updatedProgram = await bumpProgram(tx, program, decision === "go" ? "cutover-approved" : "cutover-blocked");
    await audit(tx, input.organizationId, hr.personUserId, "onboarding.transfer-cutover.go-no-go-recorded", plan.id, plan.version);
    return { planId: plan.id, status: decision, version: plan.version, programVersion: updatedProgram.version, note: "Human decision recorded. No payroll, benefits, access, or other remote action was dispatched." };
  }));
}

export async function recordTransferKpiEvidence(input: {
  organizationId: string; actorUserId: string; programId: string; metric: unknown; value: unknown; occurredAt: unknown;
  measurement: unknown; evidenceReference: unknown; sourceAttestationReference: unknown; workerId?: unknown; sourceRecordId: unknown;
}) {
  const metric = enumValue(input.metric, KPI_METRICS, "metric");
  const workerId = input.workerId === undefined ? null : text(input.workerId, "workerId", 120);
  const sourceRecordId = text(input.sourceRecordId, "sourceRecordId", 120);
  let measurement = kpiMeasurement(metric, input.measurement);
  if (!workerId && !["consultation-timely", "harmonisation-complete"].includes(metric)) throw new TransferValidationError("This KPI metric requires a specific transfer worker; aggregate booleans are not evidence.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const program = await programTx(tx, input.organizationId, input.programId);
    const scope: OnbAuthorityScope = metric === "first-pay-accurate" ? "payroll-approve" :
      metric === "access-timely" ? "it-security-approve" :
        metric === "consultation-timely" || metric === "harmonisation-complete" ? "legal-approve" : "hr-compliance-approve";
    let jurisdiction: string | undefined;
    let worker: { id: string; populationId: string; originalHireDate: Date; continuousServiceDate: Date; sourceFingerprint: string } | undefined;
    if (workerId) {
      [worker] = await tx.select({ id: onbTransferWorkers.id, populationId: onbTransferWorkers.populationId, originalHireDate: onbTransferWorkers.originalHireDate, continuousServiceDate: onbTransferWorkers.continuousServiceDate, sourceFingerprint: onbTransferWorkers.sourceFingerprint }).from(onbTransferWorkers).where(and(eq(onbTransferWorkers.organizationId, input.organizationId), eq(onbTransferWorkers.id, workerId)));
      const [population] = worker ? await tx.select({ programId: onbTransferPopulations.programId, country: onbTransferPopulations.country }).from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, input.organizationId), eq(onbTransferPopulations.id, worker.populationId))) : [];
      if (!population || population.programId !== program.id) throw new TransferValidationError("KPI worker does not belong to this transfer program.");
      jurisdiction = population.country;
      if (sourceRecordId !== worker.id) throw new TransferValidationError("Worker KPI evidence must bind sourceRecordId to its workerId.");
      if (metric === "service-date-accurate") {
        if (measurement.sourceFingerprint !== worker.sourceFingerprint ||
          measurement.sourceOriginalHireDate !== worker.originalHireDate.toISOString() ||
          measurement.sourceContinuousServiceDate !== worker.continuousServiceDate.toISOString() ||
          measurement.destinationOriginalHireDate !== worker.originalHireDate.toISOString() ||
          measurement.destinationContinuousServiceDate !== worker.continuousServiceDate.toISOString()) {
          throw new TransferConflictError("Service-date KPI evidence does not match the immutable worker source fingerprint and preserved dates.");
        }
      }
    }
    const [definition] = await tx.select().from(onbTransferKpiDefinitions).where(and(eq(onbTransferKpiDefinitions.organizationId, input.organizationId), eq(onbTransferKpiDefinitions.programId, program.id), eq(onbTransferKpiDefinitions.metric, metric))).orderBy(desc(onbTransferKpiDefinitions.revision)).limit(1).for("update");
    if (!definition || !await recordedAuthorityIsCurrent(tx, input.organizationId, definition.authorityAssignmentId, definition.authorityAssignmentRevision, "hr-compliance-approve", undefined, true)) throw new TransferConflictError("A current approved KPI definition with a source and denominator is required before KPI evidence is recorded.");
    if (!definition.cohortSnapshot.includes(sourceRecordId)) throw new TransferConflictError("Evidence sourceRecordId is not a member of the definition's approved cohort.");
    if (metric === "consultation-timely") {
      const [milestone] = await tx.select({
        id: onbTransferConsultationMilestones.id, jurisdiction: onbTransferConsultationMilestones.jurisdiction,
        status: onbTransferConsultationMilestones.status, dueAt: onbTransferConsultationMilestones.dueAt,
        completedAt: onbTransferConsultationMilestones.completedAt,
      }).from(onbTransferConsultationMilestones).where(and(eq(onbTransferConsultationMilestones.organizationId, input.organizationId), eq(onbTransferConsultationMilestones.id, Number(sourceRecordId)), eq(onbTransferConsultationMilestones.programId, program.id)));
      if (!milestone || milestone.status !== "completed" || !milestone.completedAt) throw new TransferConflictError("Consultation KPI evidence must bind a completed eligible consultation milestone.");
      jurisdiction = milestone.jurisdiction;
      const persistedMeasurement = { completedAt: milestone.completedAt.toISOString(), dueAt: milestone.dueAt.toISOString() };
      if (Object.keys(measurement).length && (measurement.completedAt !== persistedMeasurement.completedAt || measurement.dueAt !== persistedMeasurement.dueAt)) {
        throw new TransferConflictError("Consultation KPI dates must exactly match the persisted milestone completion and due dates.");
      }
      measurement = persistedMeasurement;
    }
    if (metric === "harmonisation-complete") {
      const [action] = await tx.select({
        id: onbTransferIntegrationActions.id, kind: onbTransferIntegrationActions.kind,
        status: onbTransferIntegrationActions.status, evidenceReference: onbTransferIntegrationActions.evidenceReference,
        completedAt: onbTransferIntegrationActions.completedAt, policyApprovedAt: onbTransferIntegrationActions.policyApprovedAt,
        legalApprovalReference: onbTransferIntegrationActions.legalApprovalReference,
        legalApprovalAssignmentId: onbTransferIntegrationActions.legalApprovalAssignmentId,
        legalApprovalAssignmentRevision: onbTransferIntegrationActions.legalApprovalAssignmentRevision,
      }).from(onbTransferIntegrationActions).where(and(eq(onbTransferIntegrationActions.organizationId, input.organizationId), eq(onbTransferIntegrationActions.id, sourceRecordId), eq(onbTransferIntegrationActions.programId, program.id)));
      if (!action || action.kind !== "harmonisation" || action.status !== "completed" || !action.evidenceReference ||
        !action.completedAt || !action.policyApprovedAt || !action.legalApprovalAssignmentId ||
        action.legalApprovalAssignmentRevision === null) {
        throw new TransferConflictError("Harmonisation KPI evidence must bind a completed eligible action with a Legal approval receipt.");
      }
      const [approval] = await tx.select({
        jurisdiction: onbTransferPathways.jurisdiction,
      }).from(onbTransferPathways).where(and(
        eq(onbTransferPathways.organizationId, input.organizationId),
        eq(onbTransferPathways.programId, program.id),
        eq(onbTransferPathways.decision, "approved"),
        eq(onbTransferPathways.reviewReference, action.legalApprovalReference!),
        eq(onbTransferPathways.authorityAssignmentId, action.legalApprovalAssignmentId),
        eq(onbTransferPathways.authorityAssignmentRevision, action.legalApprovalAssignmentRevision),
      ));
      if (!approval || !await recordedAuthorityIsCurrent(
        tx, input.organizationId, action.legalApprovalAssignmentId,
        action.legalApprovalAssignmentRevision, "legal-approve", approval.jurisdiction,
      )) throw new TransferConflictError("Harmonisation KPI evidence requires a current Legal approval receipt.");
      const persistedMeasurement = {
        actionCompletedAt: action.completedAt.toISOString(),
        policyApprovedAt: action.policyApprovedAt.toISOString(),
      };
      if (Object.keys(measurement).length && (measurement.actionCompletedAt !== persistedMeasurement.actionCompletedAt ||
        measurement.policyApprovedAt !== persistedMeasurement.policyApprovedAt)) {
        throw new TransferConflictError("Harmonisation KPI dates must exactly match the persisted action completion and Legal approval receipt.");
      }
      measurement = persistedMeasurement;
    }
    const actor = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope, jurisdiction });
    // An asserted boolean cannot be evidence. The server derives the outcome
    // from typed measurements, bound to persisted facts where they exist.
    const evidenceValue = deriveKpiOutcome(metric, measurement);
    const [created] = await tx.insert(onbTransferKpiEvidence).values({
      organizationId: input.organizationId, programId: program.id, workerId, metric, definitionRevision: definition.revision, sourceRecordId, value: evidenceValue, occurredAt: iso(input.occurredAt, "occurredAt", false),
      measurement, evidenceReference: text(input.evidenceReference, "evidenceReference"), sourceAttestationReference: text(input.sourceAttestationReference, "sourceAttestationReference"), authorityAssignmentId: actor.id, authorityAssignmentRevision: actor.revision, recordedByUserId: actor.personUserId,
    }).returning({ id: onbTransferKpiEvidence.id });
    await audit(tx, input.organizationId, actor.personUserId, "onboarding.transfer-kpi-evidence.recorded", `${program.id}:${created!.id}`);
    return { evidenceId: created!.id };
  }));
}
export async function recordTransferKpiDefinition(input: {
  organizationId: string; actorUserId: string; programId: string; metric: unknown; definitionReference: unknown; denominatorReference: unknown;
}) {
  const metric = enumValue(input.metric, KPI_METRICS, "metric");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const program = await programTx(tx, input.organizationId, input.programId);
    const actor = await authority(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "hr-compliance-approve", policyAction: true });
    const [prior] = await tx.select({ revision: onbTransferKpiDefinitions.revision }).from(onbTransferKpiDefinitions).where(and(
      eq(onbTransferKpiDefinitions.organizationId, input.organizationId), eq(onbTransferKpiDefinitions.programId, program.id), eq(onbTransferKpiDefinitions.metric, metric),
    )).orderBy(desc(onbTransferKpiDefinitions.revision)).limit(1).for("update");
    const revision = (prior?.revision ?? 0) + 1;
    const workerMetric = metric !== "consultation-timely" && metric !== "harmonisation-complete";
    const populations = workerMetric ? await tx.select({ id: onbTransferPopulations.id }).from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, input.organizationId), eq(onbTransferPopulations.programId, program.id))) : [];
    const cohortSnapshot = workerMetric
      ? populations.length ? (await tx.select({ id: onbTransferWorkers.id }).from(onbTransferWorkers).where(and(eq(onbTransferWorkers.organizationId, input.organizationId), sql`${onbTransferWorkers.populationId} in (${sql.join(populations.map((p) => sql`${p.id}`), sql`, `)})`))).map((row) => row.id) : []
      : metric === "consultation-timely"
        ? (await tx.select({ id: onbTransferConsultationMilestones.id }).from(onbTransferConsultationMilestones).where(and(eq(onbTransferConsultationMilestones.organizationId, input.organizationId), eq(onbTransferConsultationMilestones.programId, program.id)))).map((row) => String(row.id))
        : (await tx.select({ id: onbTransferIntegrationActions.id }).from(onbTransferIntegrationActions).where(and(eq(onbTransferIntegrationActions.organizationId, input.organizationId), eq(onbTransferIntegrationActions.programId, program.id), eq(onbTransferIntegrationActions.kind, "harmonisation")))).map((row) => row.id);
    if (!cohortSnapshot.length) throw new TransferConflictError("An approved KPI definition requires a nonempty immutable eligible cohort.");
    await tx.insert(onbTransferKpiDefinitions).values({
      organizationId: input.organizationId, programId: program.id, metric, definitionReference: text(input.definitionReference, "definitionReference"),
      revision, denominatorReference: text(input.denominatorReference, "denominatorReference"), cohortSnapshot, authorityAssignmentId: actor.id, authorityAssignmentRevision: actor.revision, approvedByUserId: actor.personUserId,
    });
    await audit(tx, input.organizationId, actor.personUserId, "onboarding.transfer-kpi-definition.approved", `${program.id}:${metric}:${revision}`, program.version);
    return { programId: program.id, metric, revision, eligibleCount: cohortSnapshot.length };
  }));
}

type TransferReadAccess = {
  hr: boolean;
  legalCountries: Set<string>;
  payrollCountries: Set<string>;
  itCountries: Set<string>;
};
async function readProgramAccess(tx: any, organizationId: string, actorUserId: string, program: Pick<typeof onbTransferPrograms.$inferSelect, "countries">): Promise<TransferReadAccess> {
  const access: TransferReadAccess = { hr: false, legalCountries: new Set(), payrollCountries: new Set(), itCountries: new Set() };
  const base = ["flow.case.read", "data.case.profile.read"] as const;
  if (!await hasHumanPermissions(tx, { organizationId, actorUserId, requiredKeys: base }))
    throw new TransferValidationError("Current client-scoped case read permissions are required.");
  const [legal, payroll, security, confidential] = await Promise.all([
    hasHumanPermissions(tx, { organizationId, actorUserId, requiredKeys: ["data.case.notes.read", "data.identity.read"] }),
    hasHumanPermissions(tx, { organizationId, actorUserId, requiredKeys: ["data.payroll.read"] }),
    hasHumanPermissions(tx, { organizationId, actorUserId, requiredKeys: ["data.case.notes.read", "data.identity.read"] }),
    hasHumanPermissions(tx, { organizationId, actorUserId, requiredKeys: ["data.case.notes.read", "data.bgv.read", "data.medical.read"] }),
  ]);
  // The full HR projection contains several private classes. A reviewer
  // routing label must never substitute for any of their read permissions.
  access.hr = legal && payroll && security && confidential;
  for (const country of program.countries) {
    if (legal) access.legalCountries.add(country);
    if (payroll) access.payrollCountries.add(country);
    if (security) access.itCountries.add(country);
  }
  if (!access.hr && !access.legalCountries.size && !access.payrollCountries.size && !access.itCountries.size) {
    throw new TransferValidationError("Current permission to read the relevant legal, payroll, or access data is required.");
  }
  return access;
}
export async function listTransferPrograms(organizationId: string, actorUserId: string) {
  const rows = await db.select({
    id: onbTransferPrograms.id, name: onbTransferPrograms.name, sourceLegalEntity: onbTransferPrograms.sourceLegalEntity,
    destinationLegalEntity: onbTransferPrograms.destinationLegalEntity, countries: onbTransferPrograms.countries, proposedBasis: onbTransferPrograms.proposedBasis,
    legalDay1: onbTransferPrograms.legalDay1, status: onbTransferPrograms.status, version: onbTransferPrograms.version, createdAt: onbTransferPrograms.createdAt,
    hrIntegrationOwner: sql<string | null>`${onbTransferPrograms.owners}->>'hrIntegration'`,
  }).from(onbTransferPrograms).where(eq(onbTransferPrograms.organizationId, organizationId)).orderBy(desc(onbTransferPrograms.createdAt));
  const visible = await Promise.all(rows.map(async (row) => {
    try {
      const access = await db.transaction((tx) => readProgramAccess(tx, organizationId, actorUserId, row));
      const countries = access.hr ? row.countries : row.countries.filter((country) =>
        access.legalCountries.has(country) || access.payrollCountries.has(country) || access.itCountries.has(country));
      return { ...row, countries, partialCountryScope: countries.length !== row.countries.length, legalDay1: row.legalDay1.toISOString(), createdAt: row.createdAt.toISOString() };
    } catch (error) {
      if (error instanceof TransferValidationError) return null;
      throw error;
    }
  }));
  if (rows.length && !visible.some(Boolean)) throw new TransferValidationError("A current authority assignment for a transfer program country is required.");
  const authorized = visible.filter((row): row is NonNullable<typeof row> => row !== null);
  if (!authorized.length) return [];
  // Aggregate only; never materialize worker records or fetch program details.
  const populations = await db.select({
    programId: onbTransferPopulations.programId,
    country: onbTransferPopulations.country,
    expectedHeadcount: onbTransferPopulations.expectedHeadcount,
    importedHeadcount: sql<number>`count(${onbTransferWorkers.id})::integer`,
  }).from(onbTransferPopulations).leftJoin(onbTransferWorkers, and(
    eq(onbTransferWorkers.organizationId, onbTransferPopulations.organizationId),
    eq(onbTransferWorkers.populationId, onbTransferPopulations.id),
  )).where(and(
    eq(onbTransferPopulations.organizationId, organizationId),
    or(...authorized.map((row) => and(
      eq(onbTransferPopulations.programId, row.id),
      inArray(onbTransferPopulations.country, row.countries),
    ))),
  )).groupBy(onbTransferPopulations.organizationId, onbTransferPopulations.id,
    onbTransferPopulations.programId, onbTransferPopulations.country, onbTransferPopulations.expectedHeadcount);
  return authorized.map((row) => ({
    ...row,
    populationSummary: summarizeTransferPopulations(row.countries, populations.filter((p) => p.programId === row.id)),
  }));
}

export function summarizeTransferPopulations(
  readableCountries: string[],
  populations: Array<{ country: string; expectedHeadcount: number | null; importedHeadcount: number }>,
) {
  const readable = populations.filter((p) => readableCountries.includes(p.country));
  // A missing population or unknown expectation cannot establish a total.
  const expectedKnown = readableCountries.every((country) => readable.some((p) => p.country === country)) &&
    readable.length > 0 && readable.every((p) => p.expectedHeadcount !== null);
  return {
    importedHeadcount: readable.reduce((sum, p) => sum + p.importedHeadcount, 0),
    expectedHeadcount: expectedKnown ? readable.reduce((sum, p) => sum + (p.expectedHeadcount ?? 0), 0) : null,
  };
}
export async function getTransferProgram(organizationId: string, actorUserId: string, programId: string) {
  const [program] = await db.select().from(onbTransferPrograms).where(and(eq(onbTransferPrograms.organizationId, organizationId), eq(onbTransferPrograms.id, programId)));
  if (!program) throw new TransferValidationError("Workforce transfer program not found.");
  const access = await db.transaction((tx) => readProgramAccess(tx, organizationId, actorUserId, program));
  const visibleCountries = new Set(access.hr ? program.countries : [
    ...access.legalCountries, ...access.payrollCountries, ...access.itCountries,
  ]);
  const mayReadLegalSummary = access.hr || access.legalCountries.size > 0;
  const [populations, pathways, milestones, actions, plans] = await Promise.all([
    db.select().from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, organizationId), eq(onbTransferPopulations.programId, programId))),
    db.select({ jurisdiction: onbTransferPathways.jurisdiction, decision: onbTransferPathways.decision, offerRequirement: onbTransferPathways.offerRequirement, bgvApplicability: onbTransferPathways.bgvApplicability, decidedAt: onbTransferPathways.decidedAt }).from(onbTransferPathways).where(and(eq(onbTransferPathways.organizationId, organizationId), eq(onbTransferPathways.programId, programId))),
    db.select({ id: onbTransferConsultationMilestones.id, jurisdiction: onbTransferConsultationMilestones.jurisdiction, kind: onbTransferConsultationMilestones.kind, dueAt: onbTransferConsultationMilestones.dueAt, completedAt: onbTransferConsultationMilestones.completedAt, status: onbTransferConsultationMilestones.status }).from(onbTransferConsultationMilestones).where(and(eq(onbTransferConsultationMilestones.organizationId, organizationId), eq(onbTransferConsultationMilestones.programId, programId))),
    db.select({ id: onbTransferIntegrationActions.id, kind: onbTransferIntegrationActions.kind, ownerUserId: onbTransferIntegrationActions.ownerUserId, dueAt: onbTransferIntegrationActions.dueAt, completedAt: onbTransferIntegrationActions.completedAt, policyApprovedAt: onbTransferIntegrationActions.policyApprovedAt, status: onbTransferIntegrationActions.status, evidenceRecorded: sql<boolean>`${onbTransferIntegrationActions.evidenceReference} is not null` }).from(onbTransferIntegrationActions).where(and(eq(onbTransferIntegrationActions.organizationId, organizationId), eq(onbTransferIntegrationActions.programId, programId))),
    db.select({ id: onbTransferCutoverPlans.id, version: onbTransferCutoverPlans.version, readinessGeneration: onbTransferCutoverPlans.readinessGeneration, workerCount: onbTransferCutoverPlans.workerCount, status: onbTransferCutoverPlans.status, createdAt: onbTransferCutoverPlans.createdAt, decisionAt: onbTransferCutoverPlans.decisionAt, contingencyRecorded: sql<boolean>`${onbTransferCutoverPlans.contingencyReference} is not null` }).from(onbTransferCutoverPlans).where(and(eq(onbTransferCutoverPlans.organizationId, organizationId), eq(onbTransferCutoverPlans.programId, programId))).orderBy(desc(onbTransferCutoverPlans.version)),
  ]);
  const planIds = plans.map((plan) => plan.id);
  const [signoffs, reconciliations] = planIds.length ? await Promise.all([
    db.select({
      planId: onbTransferCutoverSignoffs.planId, role: onbTransferCutoverSignoffs.role, decision: onbTransferCutoverSignoffs.decision,
      readinessGeneration: onbTransferCutoverSignoffs.readinessGeneration, authorityScope: onbTransferCutoverSignoffs.authorityScope,
      authorityAssignmentId: onbTransferCutoverSignoffs.authorityAssignmentId, authorityAssignmentRevision: onbTransferCutoverSignoffs.authorityAssignmentRevision,
    }).from(onbTransferCutoverSignoffs).where(and(eq(onbTransferCutoverSignoffs.organizationId, organizationId), inArray(onbTransferCutoverSignoffs.planId, planIds))),
    db.select({
      planId: onbTransferCutoverReconciliations.planId, workerId: onbTransferCutoverReconciliations.workerId, stream: onbTransferCutoverReconciliations.stream,
      status: onbTransferCutoverReconciliations.status, authorityScope: onbTransferCutoverReconciliations.authorityScope,
      authorityAssignmentId: onbTransferCutoverReconciliations.authorityAssignmentId, authorityAssignmentRevision: onbTransferCutoverReconciliations.authorityAssignmentRevision,
      sourceEvidenceRecorded: sql<boolean>`${onbTransferCutoverReconciliations.sourceAttestationReference} is not null`,
      destinationEvidenceRecorded: sql<boolean>`${onbTransferCutoverReconciliations.destinationAttestationReference} is not null`,
      evidenceRecorded: sql<boolean>`${onbTransferCutoverReconciliations.evidenceReference} is not null`,
    }).from(onbTransferCutoverReconciliations).where(and(eq(onbTransferCutoverReconciliations.organizationId, organizationId), inArray(onbTransferCutoverReconciliations.planId, planIds))),
  ]) : [[], []] as const;
  const reconciliationWorkerIds = reconciliations.map((reconciliation) => reconciliation.workerId);
  const reconciliationWorkers = reconciliationWorkerIds.length ? await db.select({
    id: onbTransferWorkers.id, populationId: onbTransferWorkers.populationId,
  }).from(onbTransferWorkers).where(and(eq(onbTransferWorkers.organizationId, organizationId), inArray(onbTransferWorkers.id, reconciliationWorkerIds))) : [];
  const reconciliationCountryByWorker = new Map(reconciliationWorkers.map((worker) => [
    worker.id, populations.find((population) => population.id === worker.populationId)?.country,
  ]));
  const authorityCurrent = async (assignmentId: string, assignmentRevision: number, scope: OnbAuthorityScope) =>
    db.transaction((tx) => recordedAuthorityIsCurrent(tx, organizationId, assignmentId, assignmentRevision, scope));
  const [safeSignoffs, safeReconciliations] = await Promise.all([
    Promise.all(signoffs.map(async (signoff) => ({
      planId: signoff.planId, role: signoff.role, decision: signoff.decision, readinessGeneration: signoff.readinessGeneration,
      authorityScope: signoff.authorityScope, authorityCurrent: await authorityCurrent(signoff.authorityAssignmentId, signoff.authorityAssignmentRevision, signoff.authorityScope),
    }))),
    Promise.all(reconciliations.map(async (reconciliation) => {
      const jurisdiction = reconciliationCountryByWorker.get(reconciliation.workerId);
      return {
      planId: reconciliation.planId, workerId: reconciliation.workerId, jurisdiction, stream: reconciliation.stream, status: reconciliation.status,
      evidenceRecorded: reconciliation.evidenceRecorded, sourceEvidenceRecorded: reconciliation.sourceEvidenceRecorded, destinationEvidenceRecorded: reconciliation.destinationEvidenceRecorded,
      authorityScope: reconciliation.authorityScope, authorityCurrent: await db.transaction((tx) => recordedAuthorityIsCurrent(tx, organizationId, reconciliation.authorityAssignmentId, reconciliation.authorityAssignmentRevision, reconciliation.authorityScope, jurisdiction)),
    };
    })),
  ]);
  const countByPopulation = new Map<string, number>();
  const workerRows = populations.length ? await db.select({ populationId: onbTransferWorkers.populationId }).from(onbTransferWorkers).where(and(eq(onbTransferWorkers.organizationId, organizationId), sql`${onbTransferWorkers.populationId} in (${sql.join(populations.map((p) => sql`${p.id}`), sql`, `)})`)) : [];
  for (const worker of workerRows) countByPopulation.set(worker.populationId, (countByPopulation.get(worker.populationId) ?? 0) + 1);
  return {
    id: program.id, name: program.name, sourceLegalEntity: program.sourceLegalEntity, destinationLegalEntity: program.destinationLegalEntity,
    countries: [...visibleCountries], proposedBasis: program.proposedBasis, legalDay1: program.legalDay1.toISOString(), owners: program.owners, status: program.status, version: program.version, createdAt: program.createdAt.toISOString(),
    readCapabilities: [
      ...(access.hr ? ["hr"] : []),
      ...(access.legalCountries.size ? ["legal"] : []),
      ...(access.payrollCountries.size ? ["payroll"] : []),
      ...(access.itCountries.size ? ["it"] : []),
    ],
    populations: populations.filter((p) => visibleCountries.has(p.country)).map((p) => ({ id: p.id, country: p.country, expectedHeadcount: p.expectedHeadcount, importedHeadcount: countByPopulation.get(p.id) ?? 0, status: p.status, version: p.version })),
    pathways: mayReadLegalSummary ? pathways.filter((item) => access.hr || access.legalCountries.has(item.jurisdiction)).map((item) => ({ ...item, decidedAt: item.decidedAt.toISOString() })) : [],
    consultation: mayReadLegalSummary ? milestones.filter((item) => access.hr || access.legalCountries.has(item.jurisdiction)).map((item) => ({ ...item, dueAt: item.dueAt.toISOString(), completedAt: item.completedAt?.toISOString() ?? null })) : [],
    integrationActions: access.hr ? actions.map((item) => ({
      ...item, dueAt: item.dueAt.toISOString(), completedAt: item.completedAt?.toISOString() ?? null,
      policyApprovedAt: item.policyApprovedAt?.toISOString() ?? null,
    })) : [],
    cutoverPlans: plans.map((item) => ({
      ...item, createdAt: item.createdAt.toISOString(), decisionAt: item.decisionAt?.toISOString() ?? null,
      signoffs: safeSignoffs.filter((signoff) => signoff.planId === item.id).map(({ planId: _planId, ...signoff }) => signoff),
       workerReconciliation: safeReconciliations.filter((reconciliation) => reconciliation.planId === item.id && reconciliation.jurisdiction && (access.hr || access.payrollCountries.has(reconciliation.jurisdiction) || access.itCountries.has(reconciliation.jurisdiction))).map(({ planId: _planId, jurisdiction: _jurisdiction, ...reconciliation }) => reconciliation),
    })),
  };
}

export async function getTransferReconciliation(organizationId: string, actorUserId: string, populationId: string) {
  return db.transaction(async (tx) => {
    const [population] = await tx.select().from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, organizationId), eq(onbTransferPopulations.id, populationId)));
    if (!population) throw new TransferValidationError("Transfer population not found.");
    const program = await programTx(tx, organizationId, population.programId);
    const access = await readProgramAccess(tx, organizationId, actorUserId, program);
    if (!access.hr && !access.payrollCountries.has(population.country) && !access.itCountries.has(population.country)) {
      throw new TransferValidationError("Current Payroll, IT, or HR authority for this population country is required to read worker reconciliation status.");
    }
    const workers = await tx.select({ id: onbTransferWorkers.id, migrationStatus: onbTransferWorkers.migrationStatus, objectionStatus: onbTransferWorkers.objectionStatus, version: onbTransferWorkers.version }).from(onbTransferWorkers).where(and(eq(onbTransferWorkers.organizationId, organizationId), eq(onbTransferWorkers.populationId, population.id)));
    const counts = workers.reduce((all, row) => ({ ...all, [row.migrationStatus]: (all[row.migrationStatus] ?? 0) + 1 }), {} as Record<string, number>);
    return { populationId, expectedHeadcount: population.expectedHeadcount, importedHeadcount: workers.length, migrationCounts: counts, workers };
  });
}

export async function getTransferKpis(organizationId: string, actorUserId: string, programId: string) {
  const [program] = await db.select().from(onbTransferPrograms).where(and(eq(onbTransferPrograms.organizationId, organizationId), eq(onbTransferPrograms.id, programId)));
  if (!program) throw new TransferValidationError("Workforce transfer program not found.");
  const access = await db.transaction((tx) => readProgramAccess(tx, organizationId, actorUserId, program));
  if (!access.hr && !program.countries.every((country) => access.legalCountries.has(country))) {
    throw new TransferValidationError("Current Legal authority for every transfer program country (or HR authority) is required to read program-wide KPI summaries.");
  }
  const [populations, evidence, definitions] = await Promise.all([
    db.select({ id: onbTransferPopulations.id }).from(onbTransferPopulations).where(and(eq(onbTransferPopulations.organizationId, organizationId), eq(onbTransferPopulations.programId, programId))),
    db.select({ id: onbTransferKpiEvidence.id, metric: onbTransferKpiEvidence.metric, definitionRevision: onbTransferKpiEvidence.definitionRevision, sourceRecordId: onbTransferKpiEvidence.sourceRecordId, value: onbTransferKpiEvidence.value, workerId: onbTransferKpiEvidence.workerId, occurredAt: onbTransferKpiEvidence.occurredAt }).from(onbTransferKpiEvidence).where(and(eq(onbTransferKpiEvidence.organizationId, organizationId), eq(onbTransferKpiEvidence.programId, programId))),
    db.select().from(onbTransferKpiDefinitions).where(and(eq(onbTransferKpiDefinitions.organizationId, organizationId), eq(onbTransferKpiDefinitions.programId, programId))),
  ]);
  const currentDefinitions = new Map<string, typeof definitions[number]>();
  for (const definition of definitions) {
    const current = currentDefinitions.get(definition.metric);
    if (!current || current.revision < definition.revision) currentDefinitions.set(definition.metric, definition);
  }
  const currentDefinitionMetrics = new Set((await Promise.all([...currentDefinitions.values()].map(async (definition) =>
    await db.transaction((tx) => recordedAuthorityIsCurrent(tx, organizationId, definition.authorityAssignmentId, definition.authorityAssignmentRevision, "hr-compliance-approve")) ? definition.metric : null,
  ))).filter((metric): metric is string => metric !== null));
  return {
    programId,
    metrics: KPI_METRICS.map((metric) => {
      const definition = currentDefinitions.get(metric);
      const workerScoped = metric !== "consultation-timely" && metric !== "harmonisation-complete";
      const denominator = definition?.cohortSnapshot.length ?? null;
      const candidates = evidence.filter((row) => row.metric === metric && row.definitionRevision === definition?.revision);
      const rows = [...candidates.reduce((latest, row) => {
        const prior = latest.get(row.sourceRecordId);
        if (!prior || prior.occurredAt < row.occurredAt || (prior.occurredAt.getTime() === row.occurredAt.getTime() && prior.id < row.id)) latest.set(row.sourceRecordId, row);
        return latest;
      }, new Map<string, typeof candidates[number]>()).values()];
      if (!definition || !currentDefinitionMetrics.has(metric) || !rows.length) return { id: metric, value: null, status: "not-collected", sampleSize: 0, eligibleCount: denominator, unknownCount: denominator, note: "No current approved definition and authorized dated source evidence are recorded; planned actions and current status are not treated as an outcome." };
      const trueCount = rows.filter((row) => row.value).length;
      const unknownCount = denominator === null ? null : Math.max(0, denominator - rows.length);
      const status = unknownCount && unknownCount > 0 ? "insufficient-data" : "measured";
      return { id: metric, value: Math.round((trueCount / rows.length) * 10_000) / 100, status, sampleSize: rows.length, eligibleCount: denominator, unknownCount, note: status === "measured" ? "Measured from authorized dated evidence only. Evidence references remain restricted." : "Some eligible workers have no authorized dated evidence; the displayed evidence rate is not a complete outcome." };
    }),
  };
}