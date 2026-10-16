import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type AgentInvocationOutcome = "success" | "denied" | "failure";

/**
 * Payload-free, append-only registered-agent attribution. initiatingUserId is
 * the actual initiating human for interactive tools; for intake-conversion/v1
 * it identifies the accountable owner under the recorded standing instruction,
 * not a human review or an impersonated session.
 */
export const agentInvocationAudit = pgTable("agent_invocation_audit", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  agentId: text("agent_id"),
  agentVersion: integer("agent_version"),
  initiatingUserId: text("initiating_user_id").notNull(),
  runId: text("run_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  delegatedScope: jsonb("delegated_scope").$type<string[]>().notNull().default([]),
  caseId: integer("case_id"),
  purpose: text("purpose").notNull(),
  toolKey: text("tool_key").notNull(),
  action: text("action").notNull(),
  outcome: text("outcome").$type<AgentInvocationOutcome>().notNull(),
  reasonCode: text("reason_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("agent_invocation_audit_outcome_check", sql`${t.outcome} in ('success', 'denied', 'failure')`),
  check("agent_invocation_audit_version_check", sql`${t.agentVersion} is null or ${t.agentVersion} > 0`),
  index("agent_invocation_audit_tenant_created_idx").on(t.organizationId, t.createdAt),
  index("agent_invocation_audit_agent_run_idx").on(t.organizationId, t.agentId, t.runId),
  uniqueIndex("agent_invocation_audit_success_replay_uq")
    .on(t.organizationId, t.runId, t.toolKey, t.caseId)
    .where(sql`${t.outcome} = 'success'`),
]);

export type AgentInvocationAuditRow = typeof agentInvocationAudit.$inferSelect;