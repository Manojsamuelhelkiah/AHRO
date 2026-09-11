import {
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { onbCases } from "./onboarding";

export type ActionCenterActionKind =
  | "manual-call-outcome"
  | "remind-document"
  | "assign"
  | "escalate"
  | "reassign"
  | "resolve";

export type ActionCenterActionStatus =
  | "open"
  | "completed"
  | "sent"
  | "logged-only"
  | "blocked"
  | "failed"
  | "sending";

/**
 * Durable, tenant-scoped Action Center mutations. This is an append-only
 * action ledger: assignments and escalations remain visible as work items,
 * while call outcomes and reminder receipts remain in completed history.
 */
export const onbActionCenterActions = pgTable(
  "onb_action_center_actions",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("open"),
    owner: text("owner"),
    assignee: text("assignee"),
    outcome: text("outcome"),
    notes: text("notes"),
    /** Demo-only persona metadata; never an authenticated actor identity. */
    persona: text("persona"),
    /** Structured calls are always self-reported and never verification evidence. */
    selfReported: boolean("self_reported").notNull().default(false),
    verified: boolean("verified").notNull().default(false),
    actorUserId: text("actor_user_id").notNull(),
    actorName: text("actor_name").notNull(),
    requestId: text("request_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("onb_action_center_actions_organization_request_unique").on(
      t.organizationId,
      t.requestId,
    ),
    index("onb_action_center_actions_organization_status_idx").on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
    index("onb_action_center_actions_organization_case_idx").on(
      t.organizationId,
      t.caseId,
      t.createdAt,
    ),
    check(
      "onb_action_center_actions_kind_check",
      sql`${t.kind} in ('manual-call-outcome', 'remind-document', 'assign', 'escalate', 'reassign', 'resolve')`,
    ),
    check(
      "onb_action_center_actions_status_check",
      sql`${t.status} in ('open', 'completed', 'sent', 'logged-only', 'blocked', 'failed', 'sending')`,
    ),
    check(
      "onb_action_center_actions_call_evidence_check",
      sql`(${t.kind} <> 'manual-call-outcome') or (${t.selfReported} = true and ${t.verified} = false)`,
    ),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_action_center_actions_organization_case_fk",
    }).onDelete("cascade"),
  ],
);
