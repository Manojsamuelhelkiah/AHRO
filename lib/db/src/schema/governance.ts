import {
  boolean,
  check,
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

export type GovernanceDecisionStatus =
  | "draft"
  | "provisional"
  | "approved"
  | "rejected"
  | "superseded";

/**
 * Immutable decision revisions. `isCurrent` identifies the sole revision a
 * reviewer may act on; historical rows are never edited back into effect.
 */
export const onbGovernanceDecisions = pgTable("onb_governance_decisions", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  key: text("key").notNull(),
  revision: integer("revision").notNull(),
  title: text("title").notNull(),
  proposedValue: jsonb("proposed_value").$type<unknown>().notNull(),
  rationale: text("rationale").notNull(),
  risk: text("risk").notNull(),
  accountableRole: text("accountable_role").notNull(),
  status: text("status").$type<GovernanceDecisionStatus>().notNull().default("draft"),
  reviewDueAt: timestamp("review_due_at", { withTimezone: true }),
  impactedWorkflows: jsonb("impacted_workflows").$type<string[]>().notNull().default([]),
  sourceReference: text("source_reference"),
  isProvisional: boolean("is_provisional").notNull().default(true),
  isCurrent: boolean("is_current").notNull().default(true),
  createdByUserId: text("created_by_user_id").notNull(),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.key, t.revision] }),
  check("onb_governance_decision_revision_check", sql`${t.revision} > 0`),
  check(
    "onb_governance_decision_status_check",
    sql`${t.status} in ('draft', 'provisional', 'approved', 'rejected', 'superseded')`,
  ),
]);

/** Evidence of a specialist review of one exact immutable decision revision. */
export const onbGovernanceDecisionReviews = pgTable("onb_governance_decision_reviews", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  decisionKey: text("decision_key").notNull(),
  decisionRevision: integer("decision_revision").notNull(),
  outcome: text("outcome").$type<"approved" | "rejected">().notNull(),
  reason: text("reason").notNull(),
  authorityAssignmentId: integer("authority_assignment_id").notNull(),
  reviewedByUserId: text("reviewed_by_user_id").notNull(),
  verificationReference: text("verification_reference").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_governance_decision_review_unique").on(
    t.organizationId,
    t.decisionKey,
    t.decisionRevision,
    t.reviewedByUserId,
  ),
  check("onb_governance_decision_review_outcome_check", sql`${t.outcome} in ('approved', 'rejected')`),
]);

/**
 * These grants are intentionally separate from case-scoped policy authorities:
 * the latter are owner-maintained operational assignments and must never
 * implicitly confer governance specialist authority.
 */
export const onbGovernanceAuthorityAssignments = pgTable("onb_governance_authority_assignments", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  authorityRole: text("authority_role").notNull(),
  assigneeUserId: text("assignee_user_id").notNull(),
  /** Owner/admin nomination is not authority until an operator verifies it. */
  verificationStatus: text("verification_status").$type<"pending" | "verified">().notNull().default("verified"),
  verifiedByUserId: text("verified_by_user_id").notNull(),
  verificationReference: text("verification_reference").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: text("revoked_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("onb_governance_authority_verification_status_check", sql`${t.verificationStatus} in ('pending', 'verified')`),
]);

/** Requirement coverage records retain four independent, non-implying states. */
export const onbGovernanceRequirements = pgTable("onb_governance_requirements", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  key: text("key").notNull(),
  title: text("title").notNull(),
  sourceReference: text("source_reference").notNull(),
  reviewOwnerRole: text("review_owner_role").notNull(),
  relatedDecisionKeys: jsonb("related_decision_keys").$type<string[]>().notNull().default([]),
  /** Catalog/tenant coverage assessment; independent from the four delivery facts. */
  coverageState: text("coverage_state").$type<"gap" | "partial" | "covered">().notNull().default("gap"),
  implemented: boolean("implemented").notNull().default(false),
  tested: boolean("tested").notNull().default(false),
  configured: boolean("configured").notNull().default(false),
  approvedForLive: boolean("approved_for_live").notNull().default(false),
  relatedImplementation: text("related_implementation"),
  evidenceReference: text("evidence_reference"),
  version: integer("version").notNull().default(1),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.key] }),
  check("onb_governance_requirement_version_check", sql`${t.version} > 0`),
  check("onb_governance_requirement_coverage_state_check", sql`${t.coverageState} in ('gap', 'partial', 'covered')`),
]);

/** Append-only tenant audit trail for decisions, authority, coverage and reminders. */
export const onbGovernanceHistory = pgTable("onb_governance_history", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  entityType: text("entity_type").notNull(),
  entityKey: text("entity_key").notNull(),
  eventType: text("event_type").notNull(),
  actorUserId: text("actor_user_id"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A claimed reminder is persisted before it appears in the review history. */
export const onbGovernanceReminders = pgTable("onb_governance_reminders", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  decisionKey: text("decision_key").notNull(),
  decisionRevision: integer("decision_revision").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: text("status").$type<"pending" | "dispatched" | "cancelled">().notNull().default("pending"),
  dispatchCount: integer("dispatch_count").notNull().default(0),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.decisionKey, t.decisionRevision] }),
  check("onb_governance_reminder_status_check", sql`${t.status} in ('pending', 'dispatched', 'cancelled')`),
]);

/**
 * An organization-wide, no-lease provider fence. A crash deliberately leaves
 * dispatching/ambiguous durable so governance cannot be changed underneath an
 * externally indeterminate write.
 */
export const onbGovernanceDispatchMarkers = pgTable("onb_governance_dispatch_markers", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  dispatchId: text("dispatch_id").notNull().unique(),
  operation: text("operation").notNull(),
  status: text("status").$type<"dispatching" | "finalized" | "ambiguous">().notNull(),
  claimOwner: text("claim_owner").notNull(),
  fence: jsonb("fence").$type<Record<string, unknown>>().notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
}, (t) => [
  check("onb_governance_dispatch_marker_status_check", sql`${t.status} in ('dispatching', 'finalized', 'ambiguous')`),
]);