import {
  check,
  foreignKey,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
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
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("onb_candidate_upload_size_check", sql`${t.sizeBytes} > 0 and ${t.sizeBytes} <= 10485760`),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
]);