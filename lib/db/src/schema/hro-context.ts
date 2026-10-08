import { boolean, foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { organizationsTable } from "./organizations";

/** Continuity anchors contain opaque subject references, never business payloads. */
export const hroContextAnchors = pgTable("hro_context_anchors", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  subjectType: text("subject_type").notNull(),
  subjectHash: text("subject_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("hro_context_anchor_subject_unique").on(table.organizationId, table.subjectType, table.subjectHash),
  uniqueIndex("hro_context_anchor_org_id_unique").on(table.organizationId, table.id),
]);

/** One execution attempt, not a second workflow engine or an authority receipt. */
export const hroContextTransactions = pgTable("hro_context_transactions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  anchorId: text("anchor_id").notNull(),
  parentTransactionId: text("parent_transaction_id"),
  correlationId: text("correlation_id").notNull(),
  workflow: text("workflow").notNull(),
  initiatorType: text("initiator_type").notNull(),
  initiatingUserId: text("initiating_user_id"),
  executorType: text("executor_type").notNull(),
  agentId: text("agent_id"),
  agentVersion: integer("agent_version"),
  status: text("status").notNull().default("running"),
  version: integer("version").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [
  foreignKey({
    name: "hro_context_transaction_anchor_fk",
    columns: [table.organizationId, table.anchorId],
    foreignColumns: [hroContextAnchors.organizationId, hroContextAnchors.id],
  }),
  uniqueIndex("hro_context_transaction_org_id_unique").on(table.organizationId, table.id),
  index("hro_context_transactions_actor_idx").on(table.organizationId, table.initiatingUserId, table.startedAt),
  index("hro_context_transactions_anchor_idx").on(table.organizationId, table.anchorId, table.startedAt),
  index("hro_context_history_idx").on(table.organizationId, table.startedAt.desc(), table.id.desc()),
  index("hro_context_history_workflow_idx").on(table.organizationId, table.workflow, table.startedAt.desc(), table.id.desc()),
  index("hro_context_history_status_idx").on(table.organizationId, table.status, table.startedAt.desc(), table.id.desc()),
  index("hro_context_history_workflow_status_idx").on(table.organizationId, table.workflow, table.status, table.startedAt.desc(), table.id.desc()),
  index("hro_context_history_correlation_idx").on(table.organizationId, table.correlationId, table.startedAt.desc(), table.id.desc()),
  index("hro_context_transactions_correlation_idx").on(table.organizationId, table.correlationId),
  index("hro_context_transactions_parent_idx").on(table.organizationId, table.parentTransactionId),
]);

export const hroContextSteps = pgTable("hro_context_steps", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  transactionId: text("transaction_id").notNull(),
  code: text("code").notNull(),
  referenceHash: text("reference_hash"),
  metrics: jsonb("metrics").$type<{ inputBytes?: number; outputTokens?: number }>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "hro_context_step_transaction_fk",
    columns: [table.organizationId, table.transactionId],
    foreignColumns: [hroContextTransactions.organizationId, hroContextTransactions.id],
  }),
  index("hro_context_steps_transaction_idx").on(table.organizationId, table.transactionId, table.id),
]);

export const insertHroContextAnchorSchema = createInsertSchema(hroContextAnchors);
export const insertHroContextTransactionSchema = createInsertSchema(hroContextTransactions);
export const insertHroContextStepSchema = createInsertSchema(hroContextSteps);
export type HroContextAnchor = typeof hroContextAnchors.$inferSelect;
export type HroContextTransaction = typeof hroContextTransactions.$inferSelect;

/** Append-only reviewed rules, separate from disposable execution metadata. No seeded approval. */
export const hroContextRetentionPolicies = pgTable("hro_context_retention_policies", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  revision: integer("revision").notNull(),
  enabled: boolean("enabled").notNull(),
  retentionDays: integer("retention_days").notNull(),
  purpose: text("purpose").notNull(),
  lawfulBasis: text("lawful_basis").notNull(),
  policyReference: text("policy_reference").notNull(),
  approvalReference: text("approval_reference").notNull(),
  approvedByUserId: text("approved_by_user_id").notNull(),
  approvedAuthorityAssignmentId: integer("approved_authority_assignment_id").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("hro_context_retention_revision_unique").on(table.organizationId, table.revision),
]);

/** Durable bounded-sweep status; no subjects or principal IDs. */
export const hroContextRetentionState = pgTable("hro_context_retention_state", {
  organizationId: text("organization_id").primaryKey().references(() => organizationsTable.id),
  lastSweepAt: timestamp("last_sweep_at", { withTimezone: true }).notNull(),
  policyRevision: integer("policy_revision").notNull(),
  outcome: text("outcome").notNull(),
  transactionsPruned: integer("transactions_pruned").notNull().default(0),
  stepsPruned: integer("steps_pruned").notNull().default(0),
  anchorsPruned: integer("anchors_pruned").notNull().default(0),
});
