import {
  check,
  date,
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

export type PolicyImportProvenance = {
  importId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  uploadedAt: string;
  uploadedByUserId: string;
  extractor: string;
  extractedTextSha256: string;
  warnings: string[];
  malware: "clean";
  authenticity: "not_verified";
};

export const onbHrPolicyImports = pgTable("onb_hr_policy_imports", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  uploadedByUserId: text("uploaded_by_user_id").notNull(),
  filename: text("filename").notNull(),
  mediaType: text("media_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  objectPath: text("object_path").notNull(),
  status: text("status").$type<"processing" | "quarantined" | "ready" | "consumed" | "discarded">().notNull(),
  malwareVerdict: text("malware_verdict").notNull().default("pending"),
  extraction: jsonb("extraction").$type<{ text: string; extractor: string; warnings: string[] }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("onb_hr_policy_import_status_check", sql`${t.status} in ('processing','quarantined','ready','consumed','discarded')`),
  check("onb_hr_policy_imports_byte_size_check", sql`${t.byteSize} > 0 and ${t.byteSize} <= 10485760`),
  index("onb_hr_policy_import_tenant_idx").on(t.organizationId, t.createdAt),
]);

/**
 * This library is intentionally independent of onboarding checklist policies
 * and case explainability evidence. Curated policy text is immutable once a
 * version is written; lifecycle fields may change only through the governed
 * policy service.
 */
export const onbHrPolicySources = pgTable("onb_hr_policy_sources", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  policyId: text("policy_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.policyId] }),
]);

export const onbHrPolicyVersions = pgTable("onb_hr_policy_versions", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  policyId: text("policy_id").notNull(),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  sourceReference: text("source_reference").notNull(),
  importProvenance: jsonb("import_provenance").$type<PolicyImportProvenance>(),
  /** Curated text only: URL references are never fetched or interpreted. */
  text: text("text").notNull(),
  audience: jsonb("audience").$type<Array<"owner" | "admin" | "member">>().notNull(),
  applicability: jsonb("applicability").$type<Record<string, string>>().notNull().default({}),
  /** Existing verified specialist category required for review and publishing. */
  reviewAuthorityRole: text("review_authority_role").$type<"hr-compliance" | "legal" | "occupational-health" | "payroll">().notNull().default("hr-compliance"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveUntil: date("effective_until"),
  reviewBy: date("review_by"),
  status: text("status").$type<"draft" | "in_review" | "published" | "superseded" | "retired">().notNull().default("draft"),
  reviewOutcome: text("review_outcome").$type<"approved" | "rejected" | null>(),
  createdByUserId: text("created_by_user_id").notNull(),
  reviewedByUserId: text("reviewed_by_user_id"),
  reviewerAuthorityAssignmentId: integer("reviewer_authority_assignment_id"),
  reviewerVerificationReference: text("reviewer_verification_reference"),
  publisherUserId: text("publisher_user_id"),
  publisherAuthorityAssignmentId: integer("publisher_authority_assignment_id"),
  publicationVerificationReference: text("publication_verification_reference"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.policyId, t.version] }),
  check("onb_hr_policy_versions_version_check", sql`${t.version} > 0`),
  check(
    "onb_hr_policy_versions_status_check",
    sql`${t.status} in ('draft', 'in_review', 'published', 'superseded', 'retired')`,
  ),
  foreignKey({
    columns: [t.organizationId, t.policyId],
    foreignColumns: [onbHrPolicySources.organizationId, onbHrPolicySources.policyId],
    name: "onb_hr_policy_versions_source_fk",
  }).onDelete("restrict"),
  index("onb_hr_policy_versions_lookup_idx").on(t.organizationId, t.status, t.effectiveFrom),
]);

export const onbHrPolicyExcerpts = pgTable("onb_hr_policy_excerpts", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  policyId: text("policy_id").notNull(),
  version: integer("version").notNull(),
  excerptId: text("excerpt_id").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.policyId, t.version, t.excerptId] }),
  foreignKey({
    columns: [t.organizationId, t.policyId, t.version],
    foreignColumns: [onbHrPolicyVersions.organizationId, onbHrPolicyVersions.policyId, onbHrPolicyVersions.version],
    name: "onb_hr_policy_excerpts_version_fk",
  }),
]);

/** Internal work only. No channel, recipient, or external-dispatch field exists. */
export const onbHrPolicyHandoffs = pgTable("onb_hr_policy_handoffs", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  requesterUserId: text("requester_user_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  question: text("question").notNull(),
  appliesOn: date("applies_on"),
  applicability: jsonb("applicability").$type<Record<string, string>>().notNull().default({}),
  status: text("status").$type<"open" | "resolved">().notNull().default("open"),
  resolvedByUserId: text("resolved_by_user_id"),
  resolverAuthorityAssignmentId: integer("resolver_authority_assignment_id"),
  resolution: text("resolution"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_hr_policy_handoffs_organization_requester_fingerprint_unique").on(
    t.organizationId, t.requesterUserId, t.fingerprint,
  ),
  check("onb_hr_policy_handoffs_status_check", sql`${t.status} in ('open', 'resolved')`),
  index("onb_hr_policy_handoffs_open_idx").on(t.organizationId, t.status, t.createdAt),
]);

/**
 * A durable, internal-only reminder for a published policy version. Rows are
 * created lazily when an authorized maintainer reads the reminder list; the
 * unique key makes concurrent reads idempotent without any dispatch side
 * effect.
 */
export const onbHrPolicyReminders = pgTable("onb_hr_policy_reminders", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  policyId: text("policy_id").notNull(),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  kind: text("kind").$type<"review_due" | "effective_end">().notNull(),
  dueOn: date("due_on").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_hr_policy_reminders_org_policy_version_kind_due_unique").on(
    t.organizationId, t.policyId, t.version, t.kind, t.dueOn,
  ),
  check("onb_hr_policy_reminders_version_check", sql`${t.version} > 0`),
  check("onb_hr_policy_reminders_kind_check", sql`${t.kind} in ('review_due', 'effective_end')`),
  foreignKey({
    columns: [t.organizationId, t.policyId, t.version],
    foreignColumns: [onbHrPolicyVersions.organizationId, onbHrPolicyVersions.policyId, onbHrPolicyVersions.version],
    name: "onb_hr_policy_reminders_version_fk",
  }),
  index("onb_hr_policy_reminders_lookup_idx").on(t.organizationId, t.dueOn),
]);