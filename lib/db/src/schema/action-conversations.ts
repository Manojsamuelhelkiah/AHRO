import { foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { onbCases } from "./onboarding";

/** Annotations, never workflow evidence or execution-context metadata.
 * One durable submission owns one human annotation and at most one triage result. */
export const actionConversationMessages = pgTable("action_conversation_messages", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  caseId: integer("case_id").notNull(),
  workItemId: integer("work_item_id"),
  version: integer("version").notNull().default(1),
  submissionId: text("submission_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  author: text("author").notNull(),
  text: text("text").notNull(),
  mode: text("mode").$type<"note" | "triage">().notNull(),
  agentKey: text("agent_key"),
  agentFingerprint: text("agent_fingerprint"),
  state: text("state").$type<"recorded" | "pending" | "completed" | "failed" | "uncertain" | "withheld">().notNull(),
  outcome: text("outcome").$type<"answer" | "clarification" | "proposal" | "unavailable">(),
  reply: text("reply"),
  explanation: jsonb("explanation").$type<unknown>(),
  evidenceFingerprint: text("evidence_fingerprint"),
  reviewHref: text("review_href"),
  dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
  unique("action_conversation_submission_unique").on(t.organizationId, t.author, t.submissionId),
  index("action_conversation_history_idx").on(t.organizationId, t.caseId, t.id),
  check("action_conversation_mode_check", sql`${t.mode} in ('note','triage')`),
  check("action_conversation_state_check", sql`${t.state} in ('recorded','pending','completed','failed','uncertain','withheld')`),
]);
