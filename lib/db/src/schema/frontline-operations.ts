import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { onbCases, type OnbAuthorityScope } from "./onboarding";

export const onbFrontlineEvidence = pgTable("onb_frontline_evidence", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  kind: text("kind").$type<
    "age-proof" | "skill-certificate" | "medical-fitness" | "safety-competency" |
    "wage-setup" | "timesheet-setup" | "statutory-registration"
  >().notNull(),
  statutoryKey: text("statutory_key"),
  skillRequirementKey: text("skill_requirement_key"),
  subjectAgeYears: integer("subject_age_years"),
  evidenceReference: text("evidence_reference").notNull(),
  issuerTimestamp: timestamp("issuer_timestamp", { withTimezone: true }).notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** verified | rejected | revoked; revocation is an authenticated authority decision. */
  status: text("status").$type<"verified" | "rejected" | "revoked">().notNull(),
  authorityScope: text("authority_scope").$type<OnbAuthorityScope>().notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  recordedByUserId: text("recorded_by_user_id").notNull(),
  revocationReference: text("revocation_reference"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_frontline_evidence_case_kind_idx").on(t.organizationId, t.caseId, t.kind, t.createdAt),
  check("onb_frontline_evidence_kind_check", sql`${t.kind} in ('age-proof', 'skill-certificate', 'medical-fitness', 'safety-competency', 'wage-setup', 'timesheet-setup', 'statutory-registration')`),
  check("onb_frontline_evidence_status_check", sql`${t.status} in ('verified', 'rejected', 'revoked')`),
  check("onb_frontline_evidence_expiry_check", sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.effectiveAt}`),
  check("onb_frontline_evidence_statutory_key_check", sql`(${t.kind} = 'statutory-registration' and ${t.statutoryKey} is not null) or (${t.kind} <> 'statutory-registration' and ${t.statutoryKey} is null)`),
  check("onb_frontline_evidence_skill_key_check", sql`(${t.kind} = 'skill-certificate' and ${t.skillRequirementKey} is not null) or (${t.kind} <> 'skill-certificate' and ${t.skillRequirementKey} is null)`),
  check("onb_frontline_evidence_age_check", sql`(${t.kind} = 'age-proof' and ${t.subjectAgeYears} is not null and ${t.subjectAgeYears} between 0 and 120) or (${t.kind} <> 'age-proof' and ${t.subjectAgeYears} is null)`),
  check("onb_frontline_evidence_revocation_ref_check", sql`(${t.status} = 'revoked' and ${t.revocationReference} is not null) or (${t.status} <> 'revoked' and ${t.revocationReference} is null)`),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_frontline_evidence_organization_case_fk",
  }).onDelete("cascade"),
]);

/** Append-only physical issue receipts; no checklist label can substitute for one. */
export const onbFrontlineFulfillments = pgTable("onb_frontline_fulfillments", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  item: text("item").$type<"badge" | "ppe" | "uniform" | "tool" | "locker">().notNull(),
  revision: integer("revision").notNull(),
  assetReference: text("asset_reference").notNull(),
  size: text("size"),
  requestedQuantity: integer("requested_quantity").notNull(),
  issuedQuantity: integer("issued_quantity").notNull(),
  issuerTimestamp: timestamp("issuer_timestamp", { withTimezone: true }).notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgementRecipientReference: text("acknowledgement_recipient_reference"),
  acknowledgementMethod: text("acknowledgement_method").$type<"in-person" | "signed-receipt" | "verified-digital">(),
  policySnapshotReference: text("policy_snapshot_reference"),
  status: text("status").$type<"issued" | "shortage" | "substituted" | "deferred">().notNull(),
  exceptionId: integer("exception_id"),
  issuedByUserId: text("issued_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_frontline_fulfillment_revision_unique").on(t.organizationId, t.caseId, t.item, t.revision),
  index("onb_frontline_fulfillment_current_idx").on(t.organizationId, t.caseId, t.item, t.revision),
  check("onb_frontline_fulfillment_item_check", sql`${t.item} in ('badge', 'ppe', 'uniform', 'tool', 'locker')`),
  check("onb_frontline_fulfillment_quantity_check", sql`${t.requestedQuantity} > 0 and ${t.issuedQuantity} >= 0 and ${t.issuedQuantity} <= ${t.requestedQuantity}`),
  check("onb_frontline_fulfillment_status_check", sql`${t.status} in ('issued', 'shortage', 'substituted', 'deferred')`),
  check("onb_frontline_fulfillment_shortage_check", sql`(${t.status} = 'shortage' and ${t.issuedQuantity} < ${t.requestedQuantity}) or (${t.status} <> 'shortage' and ${t.issuedQuantity} = ${t.requestedQuantity})`),
  check("onb_frontline_fulfillment_ack_check", sql`(${t.acknowledgedAt} is null and ${t.acknowledgementRecipientReference} is null and ${t.acknowledgementMethod} is null) or (${t.acknowledgedAt} is not null and ${t.acknowledgementRecipientReference} is not null and ${t.acknowledgementMethod} is not null)`),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_frontline_fulfillment_organization_case_fk",
  }).onDelete("cascade"),
]);

/** An exception is a distinct current-authority policy review, never a stores assertion. */
export const onbFrontlinePolicyExceptions = pgTable("onb_frontline_policy_exceptions", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  item: text("item").$type<"badge" | "ppe" | "uniform" | "tool" | "locker">().notNull(),
  type: text("type").$type<"substitution" | "deferment">().notNull(),
  policyReference: text("policy_reference").notNull(),
  reviewReference: text("review_reference").notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  reviewedByUserId: text("reviewed_by_user_id").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revocationReference: text("revocation_reference"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_frontline_exception_current_idx").on(t.organizationId, t.caseId, t.item, t.type),
  check("onb_frontline_exception_item_check", sql`${t.item} in ('badge', 'ppe', 'uniform', 'tool', 'locker')`),
  check("onb_frontline_exception_type_check", sql`${t.type} in ('substitution', 'deferment')`),
  check("onb_frontline_exception_expiry_check", sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.effectiveAt}`),
  check("onb_frontline_exception_revoke_check", sql`(${t.revokedAt} is null and ${t.revocationReference} is null) or (${t.revokedAt} is not null and ${t.revocationReference} is not null)`),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_frontline_exception_organization_case_fk",
  }).onDelete("cascade"),
]);

/** Case-local CAS revision and last boundary result. */
export const onbFrontlineReleaseState = pgTable("onb_frontline_release_state", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  version: integer("version").notNull().default(0),
  status: text("status").$type<"not-released" | "released" | "blocked">().notNull().default("not-released"),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  releasedByUserId: text("released_by_user_id"),
  reblockedAt: timestamp("reblocked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.caseId] }),
  check("onb_frontline_release_state_version_check", sql`${t.version} >= 0`),
  check("onb_frontline_release_state_status_check", sql`${t.status} in ('not-released', 'released', 'blocked')`),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_frontline_release_state_organization_case_fk",
  }).onDelete("cascade"),
]);

/** Private source inputs for Appendix-A KPIs; actual exits are explicitly dated. */
export const onbFrontlineKpiInputs = pgTable("onb_frontline_kpi_inputs", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  kind: text("kind").$type<"intake" | "medical-result" | "safety-completed" | "ppe-issued" | "statutory-registered" | "actual-exit">().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  actualExitAt: timestamp("actual_exit_at", { withTimezone: true }),
  evidenceReference: text("evidence_reference").notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
  recordedByUserId: text("recorded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_frontline_kpi_input_case_idx").on(t.organizationId, t.caseId, t.kind, t.occurredAt),
  check("onb_frontline_kpi_input_kind_check", sql`${t.kind} in ('intake', 'medical-result', 'safety-completed', 'ppe-issued', 'statutory-registered', 'actual-exit')`),
  check("onb_frontline_kpi_actual_exit_check", sql`(${t.kind} = 'actual-exit' and ${t.actualExitAt} is not null) or (${t.kind} <> 'actual-exit' and ${t.actualExitAt} is null)`),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_frontline_kpi_input_organization_case_fk",
  }).onDelete("cascade"),
]);