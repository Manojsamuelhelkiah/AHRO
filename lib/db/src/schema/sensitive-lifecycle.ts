import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";

/**
 * A policy row is an immutable, specialist-approved revision.  In particular,
 * this intentionally does not contain a jurisdictional default period: the
 * reviewer records the period and source applicable to this tenant/class.
 */
export const onbSensitiveLifecyclePolicies = pgTable("onb_sensitive_lifecycle_policies", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  dataClass: text("data_class").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  revision: integer("revision").notNull(),
  purpose: text("purpose").notNull(),
  lawfulBasis: text("lawful_basis").notNull(),
  retentionDays: integer("retention_days").notNull(),
  providerSharingApproved: boolean("provider_sharing_approved").notNull(),
  permittedProviders: jsonb("permitted_providers").$type<string[]>().notNull().default([]),
  policyReference: text("policy_reference").notNull(),
  approvalReference: text("approval_reference").notNull(),
  approvedByUserId: text("approved_by_user_id").notNull(),
  approvedAuthorityAssignmentId: integer("approved_authority_assignment_id").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  isCurrent: boolean("is_current").notNull().default(true),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_sensitive_lifecycle_policy_revision_unique").on(t.organizationId, t.dataClass, t.jurisdiction, t.revision),
  index("onb_sensitive_lifecycle_policy_current_idx").on(t.organizationId, t.dataClass, t.jurisdiction).where(sql`${t.isCurrent} = true`),
  check("onb_sensitive_lifecycle_policy_revision_check", sql`${t.revision} > 0`),
  check("onb_sensitive_lifecycle_policy_retention_check", sql`${t.retentionDays} >= 0`),
]);

/** Holds have no cascading FK: a future case cleanup must not erase a hold. */
export const onbSensitiveLifecycleHolds = pgTable("onb_sensitive_lifecycle_holds", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  dataClass: text("data_class"),
  caseId: integer("case_id"),
  objectPath: text("object_path"),
  reason: text("reason").notNull(),
  reference: text("reference").notNull(),
  active: boolean("active").notNull().default(true),
  setByUserId: text("set_by_user_id").notNull(),
  setAuthorityAssignmentId: integer("set_authority_assignment_id").notNull(),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  releasedByUserId: text("released_by_user_id"),
  releasedAuthorityAssignmentId: integer("released_authority_assignment_id"),
  releasedAt: timestamp("released_at", { withTimezone: true }),
}, (t) => [
  index("onb_sensitive_lifecycle_hold_active_idx").on(t.organizationId, t.active, t.caseId),
  check("onb_sensitive_lifecycle_hold_scope_check", sql`${t.dataClass} is not null or ${t.caseId} is not null or ${t.objectPath} is not null`),
]);

/**
 * Every primary object is declared with a complete derivative manifest.  A
 * missing/incomplete manifest is deliberately not treated as an empty list.
 */
export const onbSensitiveObjectManifests = pgTable("onb_sensitive_object_manifests", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  objectPath: text("object_path").notNull(),
  dataClass: text("data_class").notNull(),
  caseId: integer("case_id"),
  manifestState: text("manifest_state").$type<"complete" | "reconciliation-required">().notNull(),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_sensitive_object_manifest_path_unique").on(t.organizationId, t.objectPath),
  check("onb_sensitive_object_manifest_state_check", sql`${t.manifestState} in ('complete','reconciliation-required')`),
]);

export const onbSensitiveObjectDerivatives = pgTable("onb_sensitive_object_derivatives", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  manifestId: integer("manifest_id").notNull().references(() => onbSensitiveObjectManifests.id, { onDelete: "cascade" }),
  objectPath: text("object_path").notNull(),
  derivativePath: text("derivative_path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_sensitive_object_derivative_path_unique").on(t.organizationId, t.derivativePath),
  unique("onb_sensitive_object_derivative_unique").on(t.manifestId, t.derivativePath),
]);

export const onbSensitiveLifecycleConfirmations = pgTable("onb_sensitive_lifecycle_confirmations", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  actorUserId: text("actor_user_id").notNull(),
  policyId: integer("policy_id").notNull(),
  expectedRevision: integer("expected_revision").notNull(),
  proposedPolicy: jsonb("proposed_policy").$type<Record<string, unknown>>().notNull(),
  affectedObjectCount: integer("affected_object_count").notNull().default(0),
  eligibleUploadIds: jsonb("eligible_upload_ids").$type<number[]>().notNull().default([]),
  /** Stable kind:id inventory, including relational records, reviewed at preview time. */
  eligibleRecordKeys: jsonb("eligible_record_keys").$type<string[]>().notNull().default([]),
  heldRecordCount: integer("held_record_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_sensitive_lifecycle_confirmation_expiry_idx").on(t.organizationId, t.expiresAt),
  check("onb_sensitive_lifecycle_confirmation_count_check", sql`${t.affectedObjectCount} >= 0`),
]);

export const onbSensitiveLifecycleDeletionJobs = pgTable("onb_sensitive_lifecycle_deletion_jobs", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  dataClass: text("data_class").notNull(),
  caseId: integer("case_id"),
  /**
   * Legacy candidate-upload identifier. New handlers use recordKind/recordId
   * so relational records can be redacted without pretending they are files.
   */
  uploadId: integer("upload_id"),
  recordKind: text("record_kind").$type<
    "candidate-upload" | "communication" | "voice-session" | "candidate-link" | "candidate-session" | "transfer-program"
  >().notNull().default("candidate-upload"),
  recordId: text("record_id").notNull(),
  policyId: integer("policy_id").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  /** Immutable all-class policy id/revision set reviewed when an opaque envelope was queued. */
  policyRevisions: jsonb("policy_revisions").$type<Record<string, { id: number; revision: number }>>().notNull().default({}),
  /** Immutable all-jurisdiction transfer retention and policy revision evidence. */
  transferRetentionSnapshot: jsonb("transfer_retention_snapshot").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").$type<"queued" | "processing" | "completed" | "blocked" | "failed">().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  claimOwner: text("claim_owner"),
  claimUntil: timestamp("claim_until", { withTimezone: true }),
  lastError: text("last_error"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_sensitive_lifecycle_deletion_job_unique").on(t.organizationId, t.uploadId, t.policyId, t.policyRevision),
  unique("onb_sensitive_lifecycle_deletion_record_job_unique").on(
    t.organizationId, t.recordKind, t.recordId, t.policyId, t.policyRevision,
  ),
  index("onb_sensitive_lifecycle_deletion_queue_idx").on(t.status, t.claimUntil, t.createdAt),
  check("onb_sensitive_lifecycle_deletion_attempts_check", sql`${t.attempts} >= 0`),
  check("onb_sensitive_lifecycle_deletion_status_check", sql`${t.status} in ('queued','processing','completed','blocked','failed')`),
]);

/** Durable per-tenant keyset checkpoint for bounded opaque-envelope scans. */
export const onbSensitiveLifecycleScanCursors = pgTable("onb_sensitive_lifecycle_scan_cursors", {
  // Deliberately no FK: a case/tenant cleanup must not be blocked by a
  // disposable scan checkpoint. Workers recreate it on demand.
  organizationId: text("organization_id").primaryKey(),
  cursorCaseId: integer("cursor_case_id").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("onb_sensitive_lifecycle_scan_cursor_case_check", sql`${t.cursorCaseId} >= 0`),
]);