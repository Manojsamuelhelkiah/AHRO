import { pgTable, text, integer, jsonb, timestamp, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offbCases } from "./offboarding";

/** Server-issued registry is eligibility; display names and S prefixes are not. */
export const offbExchangePilots = pgTable("offb_exchange_pilots", {
  caseId: integer("case_id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  provenance: text("provenance").notNull(),
  scenario: text("scenario").notNull(),
  version: integer("version").notNull().default(1),
  generation: integer("generation").notNull().default(1),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [offbCases.organizationId, offbCases.id], name: "offb_exchange_pilot_tenant_fk" }).onDelete("restrict"),
  uniqueIndex("offb_exchange_pilot_tenant_case").on(t.organizationId, t.caseId),
  uniqueIndex("offb_exchange_pilot_scenario").on(t.organizationId, t.scenario),
  check("offb_exchange_pilot_demo_only", sql`${t.organizationId} = 'demo' AND ${t.provenance} = 'offboarding-contextual/v1' AND ${t.scenario} IN ('success','delayed','exception')`),
]);
export const offbExchanges = pgTable("offb_exchanges", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull(), caseId: integer("case_id").notNull(),
  taskId: text("task_id").notNull(), generation: integer("generation").notNull(), taskRevision: integer("task_revision").notNull(),
  enrollmentRevision: integer("enrollment_revision").notNull(), reference: text("reference").notNull(),
  direction: text("direction").notNull(), kind: text("kind").notNull(), status: text("status").notNull(),
  recipient: text("recipient").notNull(), memberId: text("member_id").notNull(), operator: text("operator").notNull(),
  agentId: text("agent_id").notNull(), persona: text("persona").notNull(),
  mailbox: text("mailbox").notNull(), subject: text("subject").notNull(), body: text("body").notNull(),
  providerMessageId: text("provider_message_id"), providerThreadId: text("provider_thread_id"),
  replyToId: text("reply_to_id"), observation: jsonb("observation").$type<Record<string, unknown>>(),
  sourceTransportVerified: integer("source_transport_verified").notNull().default(0),
  applied: integer("applied").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
}, t => [
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [offbExchangePilots.organizationId, offbExchangePilots.caseId], name: "offb_exchange_tenant_fk" }).onDelete("restrict"),
  uniqueIndex("offb_exchange_reference").on(t.reference, t.direction, t.id),
  uniqueIndex("offb_exchange_provider_message").on(t.providerMessageId),
  uniqueIndex("offb_exchange_outbound_reference").on(t.reference).where(sql`${t.direction} = 'outbound'`),
]);

/** Unattributed mail has no inferred tenant/case and no stored content or PII. */
export const offbExchangeQuarantine = pgTable("offb_exchange_quarantine", {
  providerMessageId: text("provider_message_id").primaryKey(),
  reason: text("reason").notNull(),
  referenceHashes: jsonb("reference_hashes").$type<string[]>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
/** An opaque provider cursor is ingestion progress, never recipient authority. */
export const offbExchangeMailboxState = pgTable("offb_exchange_mailbox_state", {
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  pageToken: text("page_token"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
