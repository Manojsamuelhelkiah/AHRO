import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { type OnbAuthorityScope } from "./onboarding";

export type TransferBasis =
  | "automatic-transfer"
  | "share-purchase"
  | "asset-purchase"
  | "cross-border";

export const onbTransferPrograms = pgTable("onb_transfer_programs", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sourceLegalEntity: text("source_legal_entity").notNull(),
  destinationLegalEntity: text("destination_legal_entity").notNull(),
  countries: jsonb("countries").$type<string[]>().notNull(),
  proposedBasis: text("proposed_basis").$type<TransferBasis>().notNull(),
  legalDay1: timestamp("legal_day1", { withTimezone: true }).notNull(),
  owners: jsonb("owners").$type<{ hrIntegration: string; legal: string; payroll: string; it: string }>().notNull(),
  /** planning | legal-reviewed | blocked | cutover-approved | cutover-blocked */
  status: text("status").notNull().default("planning"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  check("onb_transfer_programs_basis_check", sql`${t.proposedBasis} in ('automatic-transfer', 'share-purchase', 'asset-purchase', 'cross-border')`),
  check("onb_transfer_programs_status_check", sql`${t.status} in ('planning', 'legal-reviewed', 'blocked', 'cutover-approved', 'cutover-blocked')`),
  check("onb_transfer_programs_version_check", sql`${t.version} > 0`),
]);

/** Legal decisions are jurisdiction-specific and preserve the decision authority generation. */
export const onbTransferPathways = pgTable("onb_transfer_pathways", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: text("program_id").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  decision: text("decision").$type<"approved" | "rejected">().notNull(),
  offerRequirement: text("offer_requirement").$type<"not-required" | "required" | "legal-review-required">().notNull(),
  bgvApplicability: text("bgv_applicability").$type<"not-required" | "required" | "legal-review-required">().notNull(),
  reviewReference: text("review_reference").notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  decidedByUserId: text("decided_by_user_id").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_transfer_pathways_program_jurisdiction_unique").on(t.organizationId, t.programId, t.jurisdiction),
  foreignKey({
    columns: [t.organizationId, t.programId],
    foreignColumns: [onbTransferPrograms.organizationId, onbTransferPrograms.id],
    name: "onb_transfer_pathways_program_fk",
  }).onDelete("cascade"),
  check("onb_transfer_pathways_decision_check", sql`${t.decision} in ('approved', 'rejected')`),
  check("onb_transfer_pathways_offer_check", sql`${t.offerRequirement} in ('not-required', 'required', 'legal-review-required')`),
  check("onb_transfer_pathways_bgv_check", sql`${t.bgvApplicability} in ('not-required', 'required', 'legal-review-required')`),
]);

/** Approved sharing basis and retention period; the source dataset is not accepted until this exists. */
export const onbTransferDataGovernance = pgTable("onb_transfer_data_governance", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: text("program_id").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  lawfulBasisReference: text("lawful_basis_reference").notNull(),
  retentionReference: text("retention_reference").notNull(),
  retentionUntil: timestamp("retention_until", { withTimezone: true }).notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  approvedByUserId: text("approved_by_user_id").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  /** Bumped at the database boundary whenever retention custody changes. */
  revision: integer("revision").notNull().default(1),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.programId, t.jurisdiction] }),
  foreignKey({
    columns: [t.organizationId, t.programId],
    foreignColumns: [onbTransferPrograms.organizationId, onbTransferPrograms.id],
    name: "onb_transfer_data_governance_program_fk",
  }).onDelete("cascade"),
]);

export const onbTransferPopulations = pgTable("onb_transfer_populations", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: text("program_id").notNull(),
  country: text("country").notNull(),
  sourceLegalEntity: text("source_legal_entity").notNull(),
  destinationLegalEntity: text("destination_legal_entity").notNull(),
  expectedHeadcount: integer("expected_headcount"),
  status: text("status").notNull().default("planning"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  index("onb_transfer_populations_program_idx").on(t.organizationId, t.programId),
  foreignKey({
    columns: [t.organizationId, t.programId],
    foreignColumns: [onbTransferPrograms.organizationId, onbTransferPrograms.id],
    name: "onb_transfer_populations_program_fk",
  }).onDelete("cascade"),
  check("onb_transfer_populations_headcount_check", sql`${t.expectedHeadcount} is null or ${t.expectedHeadcount} >= 0`),
  check("onb_transfer_populations_status_check", sql`${t.status} in ('planning', 'imported', 'reconciled', 'blocked')`),
]);

/** Restricted preview data is retained only for its authorized import commit. */
export const onbTransferImportPreviews = pgTable("onb_transfer_import_previews", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  populationId: text("population_id").notNull(),
  mapping: jsonb("mapping").$type<Record<string, string>>().notNull(),
  normalizedRows: jsonb("normalized_rows").$type<Array<Record<string, string>>>().notNull(),
  fingerprint: text("fingerprint").notNull(),
  validCount: integer("valid_count").notNull(),
  invalidCount: integer("invalid_count").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  index("onb_transfer_import_previews_population_idx").on(t.organizationId, t.populationId, t.createdAt),
  foreignKey({
    columns: [t.organizationId, t.populationId],
    foreignColumns: [onbTransferPopulations.organizationId, onbTransferPopulations.id],
    name: "onb_transfer_import_previews_population_fk",
  }).onDelete("cascade"),
]);

export const onbTransferImports = pgTable("onb_transfer_imports", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  populationId: text("population_id").notNull(),
  previewId: text("preview_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  importedCount: integer("imported_count").notNull().default(0),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  unique("onb_transfer_import_idempotency_unique").on(t.organizationId, t.idempotencyKey),
  foreignKey({
    columns: [t.organizationId, t.populationId],
    foreignColumns: [onbTransferPopulations.organizationId, onbTransferPopulations.id],
    name: "onb_transfer_import_population_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.previewId],
    foreignColumns: [onbTransferImportPreviews.organizationId, onbTransferImportPreviews.id],
    name: "onb_transfer_import_preview_fk",
  }),
]);

/** Restricted workforce payload; all broad projections deliberately omit sourcePayload. */
export const onbTransferWorkers = pgTable("onb_transfer_workers", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  populationId: text("population_id").notNull(),
  importId: text("import_id").notNull(),
  stableSourceId: text("stable_source_id").notNull(),
  sourcePayload: jsonb("source_payload").$type<Record<string, string>>().notNull(),
  /** Canonical database fingerprint, generated and protected by custody trigger. */
  sourceFingerprint: text("source_fingerprint").notNull().default(""),
  originalHireDate: timestamp("original_hire_date", { withTimezone: true }).notNull(),
  continuousServiceDate: timestamp("continuous_service_date", { withTimezone: true }).notNull(),
  /** pending | reconciled | exception | excluded */
  migrationStatus: text("migration_status").notNull().default("pending"),
  objectionStatus: text("objection_status").notNull().default("pending"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  unique("onb_transfer_workers_source_unique").on(t.organizationId, t.populationId, t.stableSourceId),
  index("onb_transfer_workers_population_idx").on(t.organizationId, t.populationId, t.migrationStatus),
  foreignKey({
    columns: [t.organizationId, t.populationId],
    foreignColumns: [onbTransferPopulations.organizationId, onbTransferPopulations.id],
    name: "onb_transfer_workers_population_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.importId],
    foreignColumns: [onbTransferImports.organizationId, onbTransferImports.id],
    name: "onb_transfer_workers_import_fk",
  }).onDelete("cascade"),
  check("onb_transfer_workers_dates_check", sql`${t.continuousServiceDate} >= ${t.originalHireDate}`),
  check("onb_transfer_workers_status_check", sql`${t.migrationStatus} in ('pending', 'reconciled', 'exception', 'excluded')`),
  check("onb_transfer_workers_objection_check", sql`${t.objectionStatus} in ('pending', 'objected', 'withdrawn', 'resolved')`),
]);

export const onbTransferConsultationMilestones = pgTable("onb_transfer_consultation_milestones", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: text("program_id").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  kind: text("kind").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  status: text("status").$type<"planned" | "communicated" | "completed" | "blocked">().notNull(),
  privateEvidenceReference: text("private_evidence_reference").notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  recordedByUserId: text("recorded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_transfer_consultation_program_idx").on(t.organizationId, t.programId, t.jurisdiction, t.dueAt),
  foreignKey({
    columns: [t.organizationId, t.programId],
    foreignColumns: [onbTransferPrograms.organizationId, onbTransferPrograms.id],
    name: "onb_transfer_consultation_program_fk",
  }).onDelete("cascade"),
  check("onb_transfer_consultation_status_check", sql`${t.status} in ('planned', 'communicated', 'completed', 'blocked')`),
]);

export const onbTransferObjections = pgTable("onb_transfer_objections", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  workerId: text("worker_id").notNull(),
  outcome: text("outcome").$type<"pending" | "objected" | "withdrawn" | "resolved">().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  privateEvidenceReference: text("private_evidence_reference").notNull(),
  recordedByUserId: text("recorded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_transfer_objections_worker_idx").on(t.organizationId, t.workerId, t.createdAt),
  foreignKey({
    columns: [t.organizationId, t.workerId],
    foreignColumns: [onbTransferWorkers.organizationId, onbTransferWorkers.id],
    name: "onb_transfer_objections_worker_fk",
  }).onDelete("cascade"),
]);

export const onbTransferIntegrationActions = pgTable("onb_transfer_integration_actions", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: text("program_id").notNull(),
  kind: text("kind").$type<"induction" | "integration" | "harmonisation" | "contingency-parallel-run">().notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: text("status").$type<"planned" | "in-progress" | "completed" | "blocked">().notNull().default("planned"),
  /** Human-recorded completion fact; never inferred from row creation time. */
  completedAt: timestamp("completed_at", { withTimezone: true }),
  evidenceReference: text("evidence_reference"),
  /** Legal policy receipt and its recorded authority, required for harmonisation. */
  legalApprovalReference: text("legal_approval_reference"),
  legalApprovalAssignmentId: text("legal_approval_assignment_id"),
  legalApprovalAssignmentRevision: integer("legal_approval_assignment_revision"),
  policyApprovedAt: timestamp("policy_approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_transfer_integration_program_idx").on(t.organizationId, t.programId, t.dueAt),
  foreignKey({
    columns: [t.organizationId, t.programId],
    foreignColumns: [onbTransferPrograms.organizationId, onbTransferPrograms.id],
    name: "onb_transfer_integration_program_fk",
  }).onDelete("cascade"),
  check("onb_transfer_integration_kind_check", sql`${t.kind} in ('induction', 'integration', 'harmonisation', 'contingency-parallel-run')`),
  check("onb_transfer_integration_status_check", sql`${t.status} in ('planned', 'in-progress', 'completed', 'blocked')`),
  check("onb_transfer_integration_completed_at_check", sql`${t.status} <> 'completed' or ${t.completedAt} is not null`),
  check("onb_transfer_harmonisation_approval_check", sql`${t.kind} <> 'harmonisation' or (${t.legalApprovalReference} is not null and ${t.legalApprovalAssignmentId} is not null and ${t.legalApprovalAssignmentRevision} is not null and ${t.policyApprovedAt} is not null)`),
]);

/** Restricted append-only prior-evidence custody for stable operational updates. */
export const onbTransferOperationalSupersessions = pgTable("onb_transfer_operational_supersessions", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: text("program_id").notNull(),
  recordKind: text("record_kind").$type<"consultation-milestone" | "integration-action">().notNull(),
  recordId: text("record_id").notNull(),
  priorStatus: text("prior_status").notNull(),
  priorEvidenceReference: text("prior_evidence_reference"),
  supersededByUserId: text("superseded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_transfer_operational_supersessions_lookup_idx").on(t.organizationId, t.programId, t.recordKind, t.recordId, t.createdAt),
  foreignKey({
    columns: [t.organizationId, t.programId],
    foreignColumns: [onbTransferPrograms.organizationId, onbTransferPrograms.id],
    name: "onb_transfer_operational_supersession_program_fk",
  }).onDelete("cascade"),
  check("onb_transfer_operational_supersession_kind_check", sql`${t.recordKind} in ('consultation-milestone', 'integration-action')`),
]);

export const onbTransferCutoverPlans = pgTable("onb_transfer_cutover_plans", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: text("program_id").notNull(),
  version: integer("version").notNull(),
  /** Changes whenever readiness evidence changes; sign-offs bind this fence. */
  readinessGeneration: integer("readiness_generation").notNull().default(1),
  /** Immutable Legal pathway/data-governance material used by this plan. */
  pathwaySnapshot: jsonb("pathway_snapshot").$type<Array<{
    jurisdiction: string; reviewedBasis: TransferBasis; decision: string; offerRequirement: string; bgvApplicability: string;
    reviewReference: string; authorityAssignmentId: string; authorityAssignmentRevision: number; decidedAt: string;
    governance: null | { lawfulBasisReference: string; retentionReference: string; retentionUntil: string; authorityAssignmentId: string; authorityAssignmentRevision: number; approvedAt: string; revision: number };
  }>>().notNull(),
  workerSnapshot: jsonb("worker_snapshot").$type<Array<{ workerId: string; populationId: string; stableSourceId: string; workerVersion: number }>>().notNull().default([]),
  workerCount: integer("worker_count").notNull(),
  contingencyReference: text("contingency_reference"),
  status: text("status").$type<"draft" | "go" | "no-go" | "blocked">().notNull().default("draft"),
  decisionAt: timestamp("decision_at", { withTimezone: true }),
  decidedByUserId: text("decided_by_user_id"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  unique("onb_transfer_cutover_program_version_unique").on(t.organizationId, t.programId, t.version),
  foreignKey({
    columns: [t.organizationId, t.programId],
    foreignColumns: [onbTransferPrograms.organizationId, onbTransferPrograms.id],
    name: "onb_transfer_cutover_program_fk",
  }).onDelete("cascade"),
]);

export const onbTransferCutoverReconciliations = pgTable("onb_transfer_cutover_reconciliations", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull(),
  workerId: text("worker_id").notNull(),
  stream: text("stream").$type<"migration" | "payroll" | "benefits" | "access" | "first-pay">().notNull(),
  status: text("status").$type<"pending" | "ready" | "complete" | "exception" | "unknown-effect-manual-repair">().notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  sourceAttestationReference: text("source_attestation_reference"),
  /** Bound by the database to the immutable worker source payload on every write. */
  sourceFingerprint: text("source_fingerprint").notNull().default(""),
  destinationAttestationReference: text("destination_attestation_reference"),
  destinationOriginalHireDate: timestamp("destination_original_hire_date", { withTimezone: true }),
  destinationContinuousServiceDate: timestamp("destination_continuous_service_date", { withTimezone: true }),
  destinationTermsReference: text("destination_terms_reference"),
  destinationBenefitsReference: text("destination_benefits_reference"),
  repairReference: text("repair_reference"),
  repairedAt: timestamp("repaired_at", { withTimezone: true }),
  authorityScope: text("authority_scope").$type<OnbAuthorityScope>().notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  recordedByUserId: text("recorded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_transfer_reconciliation_current_unique").on(t.organizationId, t.planId, t.workerId, t.stream),
  foreignKey({
    columns: [t.organizationId, t.planId],
    foreignColumns: [onbTransferCutoverPlans.organizationId, onbTransferCutoverPlans.id],
    name: "onb_transfer_reconciliation_plan_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.workerId],
    foreignColumns: [onbTransferWorkers.organizationId, onbTransferWorkers.id],
    name: "onb_transfer_reconciliation_worker_fk",
  }).onDelete("cascade"),
  check("onb_transfer_reconciliation_stream_check", sql`${t.stream} in ('migration', 'payroll', 'benefits', 'access', 'first-pay')`),
  check("onb_transfer_reconciliation_status_check", sql`${t.status} in ('pending', 'ready', 'complete', 'exception', 'unknown-effect-manual-repair')`),
]);

/** A metric can be measured only after a Legal/HR-approved definition establishes its source and denominator. */
export const onbTransferKpiDefinitions = pgTable("onb_transfer_kpi_definitions", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: text("program_id").notNull(),
  metric: text("metric").notNull(),
  revision: integer("revision").notNull(),
  definitionReference: text("definition_reference").notNull(),
  denominatorReference: text("denominator_reference").notNull(),
  /** Immutable IDs eligible for this metric at definition approval. */
  cohortSnapshot: jsonb("cohort_snapshot").$type<string[]>().notNull().default([]),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  approvedByUserId: text("approved_by_user_id").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.programId, t.metric, t.revision] }),
  unique("onb_transfer_kpi_definition_revision_unique").on(t.organizationId, t.programId, t.metric, t.revision),
  foreignKey({
    columns: [t.organizationId, t.programId],
    foreignColumns: [onbTransferPrograms.organizationId, onbTransferPrograms.id],
    name: "onb_transfer_kpi_definition_program_fk",
  }).onDelete("cascade"),
  check("onb_transfer_kpi_definition_metric_check", sql`${t.metric} in ('service-date-accurate', 'consultation-timely', 'access-timely', 'first-pay-accurate', 'actual-attrition', 'harmonisation-complete')`),
]);

export const onbTransferCutoverSignoffs = pgTable("onb_transfer_cutover_signoffs", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull(),
  role: text("role").$type<"hr-integration" | "payroll" | "it">().notNull(),
  decision: text("decision").$type<"approved" | "blocked">().notNull(),
  readinessGeneration: integer("readiness_generation").notNull(),
  reasonReference: text("reason_reference").notNull(),
  authorityScope: text("authority_scope").$type<OnbAuthorityScope>().notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  signedByUserId: text("signed_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_transfer_cutover_signoff_unique").on(t.organizationId, t.planId, t.role),
  foreignKey({
    columns: [t.organizationId, t.planId],
    foreignColumns: [onbTransferCutoverPlans.organizationId, onbTransferCutoverPlans.id],
    name: "onb_transfer_cutover_signoff_plan_fk",
  }).onDelete("cascade"),
  check("onb_transfer_cutover_signoff_role_check", sql`${t.role} in ('hr-integration', 'payroll', 'it')`),
  check("onb_transfer_cutover_signoff_decision_check", sql`${t.decision} in ('approved', 'blocked')`),
]);

/** Append-only custody record for resolving an unknown external effect. */
export const onbTransferReconciliationRepairs = pgTable("onb_transfer_reconciliation_repairs", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull(),
  workerId: text("worker_id").notNull(),
  stream: text("stream").notNull(),
  priorStatus: text("prior_status").notNull(),
  repairReference: text("repair_reference").notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  repairedByUserId: text("repaired_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_transfer_reconciliation_repairs_lookup_idx").on(t.organizationId, t.planId, t.workerId, t.stream, t.createdAt),
  foreignKey({
    columns: [t.organizationId, t.planId],
    foreignColumns: [onbTransferCutoverPlans.organizationId, onbTransferCutoverPlans.id],
    name: "onb_transfer_reconciliation_repair_plan_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.workerId],
    foreignColumns: [onbTransferWorkers.organizationId, onbTransferWorkers.id],
    name: "onb_transfer_reconciliation_repair_worker_fk",
  }).onDelete("cascade"),
]);

/** Evidence-only KPI observations. The aggregate never treats intended actions as outcomes. */
export const onbTransferKpiEvidence = pgTable("onb_transfer_kpi_evidence", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: text("program_id").notNull(),
  workerId: text("worker_id"),
  metric: text("metric").$type<"service-date-accurate" | "consultation-timely" | "access-timely" | "first-pay-accurate" | "actual-attrition" | "harmonisation-complete">().notNull(),
  definitionRevision: integer("definition_revision").notNull(),
  /** ID from the definition's approved cohort (worker, milestone, or action). */
  sourceRecordId: text("source_record_id").notNull().default(""),
  value: boolean("value").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  measurement: jsonb("measurement").$type<Record<string, string | number | boolean>>().notNull(),
  sourceAttestationReference: text("source_attestation_reference").notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  recordedByUserId: text("recorded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_transfer_kpi_program_metric_idx").on(t.organizationId, t.programId, t.metric, t.occurredAt),
  foreignKey({
    columns: [t.organizationId, t.programId],
    foreignColumns: [onbTransferPrograms.organizationId, onbTransferPrograms.id],
    name: "onb_transfer_kpi_program_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.programId, t.metric, t.definitionRevision],
    foreignColumns: [onbTransferKpiDefinitions.organizationId, onbTransferKpiDefinitions.programId, onbTransferKpiDefinitions.metric, onbTransferKpiDefinitions.revision],
    name: "onb_transfer_kpi_evidence_definition_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.organizationId, t.workerId],
    foreignColumns: [onbTransferWorkers.organizationId, onbTransferWorkers.id],
    name: "onb_transfer_kpi_worker_fk",
  }).onDelete("cascade"),
  check("onb_transfer_kpi_metric_check", sql`${t.metric} in ('service-date-accurate', 'consultation-timely', 'access-timely', 'first-pay-accurate', 'actual-attrition', 'harmonisation-complete')`),
]);