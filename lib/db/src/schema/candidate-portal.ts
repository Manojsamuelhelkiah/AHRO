import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { onbCases } from "./onboarding";

export const onbCaseLogistics = pgTable("onb_case_logistics", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  orientationDate: text("orientation_date"),
  orientationTime: text("orientation_time"),
  timezone: text("timezone"),
  format: text("format"),
  venueAddress: text("venue_address"),
  googleMapsUrl: text("google_maps_url"),
  meetingUrl: text("meeting_url"),
  reportingContact: text("reporting_contact"),
  arrivalInstructions: text("arrival_instructions"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_case_logistics_org_case_unique").on(t.organizationId, t.caseId),
  check("onb_case_logistics_format_check", sql`${t.format} is null or ${t.format} in ('physical','remote','hybrid')`),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
]);

export const onbCandidateLinks = pgTable("onb_candidate_links", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  issuedBy: text("issued_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_candidate_links_unrevoked_expires_idx")
    .on(t.expiresAt)
    .where(sql`${t.revokedAt} is null`),
  index("onb_candidate_links_revoked_at_idx")
    .on(t.revokedAt)
    .where(sql`${t.revokedAt} is not null`),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
]);

export const onbCandidateSessions = pgTable("onb_candidate_sessions", {
  idHash: text("id_hash").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  linkId: integer("link_id").notNull().references(() => onbCandidateLinks.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_candidate_sessions_expires_at_idx").on(t.expiresAt),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
]);

export const onbCandidateExchangeFailures = pgTable("onb_candidate_exchange_failures", {
  clientKey: text("client_key").primaryKey(),
  failures: integer("failures").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  check("onb_candidate_exchange_failures_count_check", sql`${t.failures} > 0`),
  index("onb_candidate_exchange_failures_expires_at_idx").on(t.expiresAt),
]);
export const onbCandidateUploads = pgTable("onb_candidate_uploads", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  documentId: integer("document_id").notNull(),
  objectPath: text("object_path").notNull().unique(),
  originalName: text("original_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksumSha256: text("checksum_sha256"),
  malwareScanState: text("malware_scan_state").$type<"pending" | "scanning" | "clean" | "infected" | "unavailable" | "timeout" | "indeterminate">().notNull().default("pending"),
  malwareScanId: text("malware_scan_id"),
  malwareScanStartedAt: timestamp("malware_scan_started_at", { withTimezone: true }),
  malwareScanDeadlineAt: timestamp("malware_scan_deadline_at", { withTimezone: true }),
  malwareScannedAt: timestamp("malware_scanned_at", { withTimezone: true }),
  malwareScanSha256: text("malware_scan_sha256"),
  /** queued | processing | passed | manual_review | correction_requested | rejected */
  validationState: text("validation_state").notNull().default("queued"),
  validationReasons: jsonb("validation_reasons").$type<Array<{ code: string; message: string; evidence?: string }>>().notNull().default([]),
  validationStartedAt: timestamp("validation_started_at", { withTimezone: true }),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  validationClaimOwner: text("validation_claim_owner"),
  validationClaimUntil: timestamp("validation_claim_until", { withTimezone: true }),
  validationAttempts: integer("validation_attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("onb_candidate_upload_size_check", sql`${t.sizeBytes} > 0 and ${t.sizeBytes} <= 10485760`),
  check("onb_candidate_upload_validation_state_check", sql`${t.validationState} in ('queued','processing','passed','manual_review','correction_requested','rejected')`),
  check("onb_candidate_upload_validation_attempts_check", sql`${t.validationAttempts} >= 0`),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
  index("onb_candidate_uploads_validation_queue_idx").on(t.validationState, t.validationClaimUntil),
  index("onb_candidate_uploads_malware_queue_idx").on(t.malwareScanState, t.malwareScanDeadlineAt),
]);

/**
 * A private object is reserved and inventoried before its first byte is sent
 * to object storage.  This deliberately has no case/document FK: a cascade
 * must never erase the only durable record of an interrupted sensitive upload.
 */
export const onbCandidateUploadReservations = pgTable("onb_candidate_upload_reservations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  documentId: integer("document_id").notNull(),
  objectPath: text("object_path").notNull(),
  dataClass: text("data_class").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  /** Immutable case-context version captured with the normalized jurisdiction. */
  workforceContextVersion: integer("workforce_context_version").notNull(),
  policyId: integer("policy_id").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  /**
   * This token fences the request which reserved the object from a recovering
   * worker or a stale request completion.
   */
  ownerToken: text("owner_token"),
  state: text("state").$type<"reserved" | "cleanup-processing" | "finalized" | "cleanup-completed">().notNull().default("reserved"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  finalizedUploadId: integer("finalized_upload_id"),
  lastError: text("last_error"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_candidate_upload_reservation_path_unique").on(t.organizationId, t.objectPath),
  unique("onb_candidate_upload_reservation_owner_path_unique").on(t.ownerToken, t.objectPath),
  index("onb_candidate_upload_reservation_recovery_idx").on(t.state, t.leaseUntil, t.createdAt),
  check("onb_candidate_upload_reservation_policy_revision_check", sql`${t.policyRevision} > 0`),
  check("onb_candidate_upload_reservation_state_check", sql`${t.state} in ('reserved','cleanup-processing','finalized','cleanup-completed')`),
]);
