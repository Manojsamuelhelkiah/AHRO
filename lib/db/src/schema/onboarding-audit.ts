import {
  boolean,
  check,
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

/**
 * Protected, minimized audit evidence. There are deliberately no foreign
 * keys to a case, approval, user, or organization: those business records can
 * be removed or pseudonymised without silently removing accountability
 * evidence. Database triggers installed by the reviewed migration reject
 * UPDATE and DELETE for this table.
 */
export const onbAuditEntries = pgTable("onb_audit_entries", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  sequence: integer("sequence").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  actorId: text("actor_id"),
  /** authenticated | system | historical */
  actorKind: text("actor_kind").notNull(),
  /** Membership/authority actually verified at the write boundary. */
  actorAuthority: text("actor_authority").notNull(),
  action: text("action").notNull(),
  /** attempted (unresolved) | success | denied | failure */
  outcome: text("outcome").notNull(),
  objectType: text("object_type").notNull(),
  objectId: text("object_id"),
  /** Stable pseudonymous business reference, never a foreign key. */
  caseReference: text("case_reference"),
  /** Optimistic/concurrency revision reviewed by the actor, when applicable. */
  reviewedRevision: integer("reviewed_revision"),
  source: text("source").notNull(),
  correlationId: text("correlation_id"),
  /** Safe, allow-listed metadata only; raw documents, credentials and PII are excluded. */
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  correctionOfId: integer("correction_of_id"),
  previousHash: text("previous_hash").notNull(),
  entryHash: text("entry_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_audit_entries_organization_sequence_unique").on(t.organizationId, t.sequence),
  index("onb_audit_entries_organization_occurred_idx").on(t.organizationId, t.occurredAt, t.sequence),
  index("onb_audit_entries_organization_action_idx").on(t.organizationId, t.action, t.sequence),
  check("onb_audit_entries_sequence_check", sql`${t.sequence} > 0`),
  check("onb_audit_entries_actor_kind_check", sql`${t.actorKind} in ('authenticated', 'system', 'historical')`),
  check("onb_audit_entries_outcome_check", sql`${t.outcome} in ('attempted', 'success', 'denied', 'failure')`),
]);

/** One serialized hash-chain head per tenant. It has no tenant FK by design. */
export const onbAuditHeads = pgTable("onb_audit_heads", {
  organizationId: text("organization_id").primaryKey(),
  lastSequence: integer("last_sequence").notNull().default(0),
  lastHash: text("last_hash").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("onb_audit_heads_last_sequence_check", sql`${t.lastSequence} >= 0`),
]);

/**
 * Reviewed lifecycle state. A null retention statement means no policy has
 * been approved. No retention deadline or automatic purge is represented.
 */
export const onbAuditLifecycles = pgTable("onb_audit_lifecycles", {
  organizationId: text("organization_id").primaryKey(),
  retentionStatement: text("retention_statement"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  legalHoldActive: boolean("legal_hold_active").notNull().default(false),
  legalHoldReason: text("legal_hold_reason"),
  legalHoldSetBy: text("legal_hold_set_by"),
  legalHoldSetAt: timestamp("legal_hold_set_at", { withTimezone: true }),
  legalHoldReleasedBy: text("legal_hold_released_by"),
  legalHoldReleasedAt: timestamp("legal_hold_released_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});