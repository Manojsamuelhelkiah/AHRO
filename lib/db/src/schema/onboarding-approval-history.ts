import { check, foreignKey, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { onbApprovals, onbCases } from "./onboarding";

/**
 * Append-only snapshots of approval cycles.  A decision is recorded before
 * the live approval changes, and a reopen records the decision being revoked
 * before the live row is moved to its next version.
 */
export const onbApprovalHistory = pgTable("onb_approval_history", {
  id: serial("id").primaryKey(),
  // No cascading business-record relation: decisions remain as historical
  // evidence if the live case or approval is removed.
  organizationId: text("organization_id").notNull(),
  approvalId: integer("approval_id").notNull(),
  caseId: integer("case_id").notNull(),
  /** The cycle represented by this snapshot (the old cycle for a reopen). */
  version: integer("version").notNull(),
  /** decision | reopened */
  eventType: text("event_type").notNull(),
  /** pending | approved | rejected at the time of the snapshot. */
  status: text("status").notNull(),
  decidedBy: text("decided_by"),
  comment: text("comment"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** Human/system reason for a reopen, or a decision receipt description. */
  reason: text("reason"),
  /** Exact approval content reviewed in this cycle. */
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_approval_history_organization_approval_version_event_unique")
    .on(t.organizationId, t.approvalId, t.version, t.eventType),
  check("onb_approval_history_version_check", sql`${t.version} > 0`),
  check("onb_approval_history_event_type_check", sql`${t.eventType} in ('decision', 'reopened')`),
]);

/**
 * Durable, tenant-scoped approval notification outbox.  This is deliberately
 * separate from the communication timeline: queue rows exist before provider
 * dispatch and retain an ambiguous outcome for manual reconciliation.
 */
export const onbApprovalNotifications = pgTable("onb_approval_notifications", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  approvalId: integer("approval_id").notNull(),
  caseId: integer("case_id").notNull(),
  version: integer("version").notNull(),
  /** request | decision | stale | outstanding | hr-alert */
  kind: text("kind").notNull(),
  recipient: text("recipient").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  /** queued | sending | sent | failed | blocked | unknown_effect_manual_repair */
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  failureReason: text("failure_reason"),
  providerMessageId: text("provider_message_id"),
  sourceMessageId: text("source_message_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  unique("onb_approval_notifications_organization_idempotency_key_unique")
    .on(t.organizationId, t.idempotencyKey),
  check("onb_approval_notifications_version_check", sql`${t.version} > 0`),
  check(
    "onb_approval_notifications_kind_check",
    sql`${t.kind} in ('request', 'decision', 'stale', 'outstanding', 'hr-alert')`,
  ),
  check(
    "onb_approval_notifications_status_check",
    sql`${t.status} in ('queued', 'sending', 'sent', 'failed', 'blocked', 'unknown_effect_manual_repair')`,
  ),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_approval_notifications_organization_case_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.approvalId],
    foreignColumns: [onbApprovals.organizationId, onbApprovals.id],
    name: "onb_approval_notifications_organization_approval_fk",
  }).onDelete("cascade"),
]);