import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Durable delivery queue for protected-audit checkpoints and lifecycle
 * propagation. Queue state is mutable operational state; the checkpoint and
 * receipt evidence themselves are append-only.
 */
export const onbAuditAnchorOutbox = pgTable("onb_audit_anchor_outbox", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  kind: text("kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  checkpointSequence: integer("checkpoint_sequence"),
  checkpointHash: text("checkpoint_hash"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  /** pending | sending | delivered | failed */
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  receiptId: integer("receipt_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, (t) => [
  unique("onb_audit_anchor_outbox_organization_idempotency_unique")
    .on(t.organizationId, t.idempotencyKey),
  index("onb_audit_anchor_outbox_due_idx").on(t.status, t.nextAttemptAt, t.id),
  index("onb_audit_anchor_outbox_organization_idx").on(t.organizationId, t.createdAt, t.id),
  check("onb_audit_anchor_outbox_kind_check", sql`${t.kind} in ('checkpoint', 'legal_hold')`),
  check("onb_audit_anchor_outbox_status_check", sql`${t.status} in ('pending', 'sending', 'delivered', 'failed')`),
  check(
    "onb_audit_anchor_outbox_checkpoint_shape_check",
    sql`(${t.kind} = 'checkpoint' and ${t.checkpointSequence} is not null and ${t.checkpointHash} is not null)
      or (${t.kind} = 'legal_hold' and ${t.checkpointSequence} is null and ${t.checkpointHash} is null)`,
  ),
]);

/**
 * Provider receipts are retained as independent-verification evidence. The
 * service never treats a provider response as configured until verifyReceipt
 * validates this immutable receipt against the local checkpoint.
 */
export const onbAuditAnchorReceipts = pgTable("onb_audit_anchor_receipts", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  outboxId: integer("outbox_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  providerId: text("provider_id").notNull(),
  configGeneration: integer("config_generation").notNull().default(0),
  providerKind: text("provider_kind").notNull(),
  receiptVersion: integer("receipt_version").notNull(),
  checkpointSequence: integer("checkpoint_sequence"),
  checkpointHash: text("checkpoint_hash"),
  receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("onb_audit_anchor_receipts_organization_idempotency_provider_generation_unique")
    .on(t.organizationId, t.idempotencyKey, t.providerId, t.configGeneration),
  index("onb_audit_anchor_receipts_organization_checkpoint_idx")
    .on(t.organizationId, t.checkpointSequence, t.receivedAt),
  check("onb_audit_anchor_receipts_provider_kind_check", sql`${t.providerKind} in ('simulated', 'external')`),
  check("onb_audit_anchor_receipts_version_check", sql`${t.receiptVersion} > 0`),
  check("onb_audit_anchor_receipts_generation_check", sql`${t.configGeneration} >= 0`),
]);