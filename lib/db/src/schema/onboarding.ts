import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export type OnbReadinessItemRow = {
  key: string;
  label: string;
  status: string;
  note?: string;
};

export type OnbWorkstreamRow = {
  key: string;
  label: string;
  agent: string;
  status: string;
  owner: string;
  blockers: string[];
};

export const onbCases = pgTable("onb_cases", {
  id: serial("id").primaryKey(),
  workerName: text("worker_name").notNull(),
  workerEmail: text("worker_email").notNull(),
  workerPhone: text("worker_phone"),
  channelPreference: text("channel_preference").notNull().default("both"),
  hireType: text("hire_type").notNull(),
  workerCategory: text("worker_category").notNull(),
  role: text("role").notNull(),
  department: text("department").notNull(),
  geography: text("geography").notNull(),
  legalEntity: text("legal_entity").notNull(),
  managerName: text("manager_name").notNull(),
  recruiterName: text("recruiter_name").notNull(),
  joiningDate: text("joining_date").notNull(),
  urgency: text("urgency").notNull().default("standard"),
  lifecycleStage: text("lifecycle_stage").notNull().default("trigger-received"),
  orchestrationStatus: text("orchestration_status").notNull().default("idle"),
  readiness: jsonb("readiness").$type<OnbReadinessItemRow[]>().notNull().default([]),
  workstreams: jsonb("workstreams").$type<OnbWorkstreamRow[]>().notNull().default([]),
  primarySkill: text("primary_skill"),
  skillCriticality: text("skill_criticality"),
  scenarioKey: text("scenario_key"),
  planSummary: text("plan_summary"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const onbEvents = pgTable("onb_events", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id")
    .notNull()
    .references(() => onbCases.id, { onDelete: "cascade" }),
  agent: text("agent").notNull(),
  engine: text("engine").notNull(),
  hitlPattern: text("hitl_pattern"),
  ruleRef: text("rule_ref"),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const onbApprovals = pgTable("onb_approvals", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id")
    .notNull()
    .references(() => onbCases.id, { onDelete: "cascade" }),
  agent: text("agent").notNull(),
  ruleRef: text("rule_ref"),
  hitlPattern: text("hitl_pattern").notNull().default("approve-before-act"),
  recommendation: text("recommendation").notNull(),
  rationale: text("rationale").notNull(),
  status: text("status").notNull().default("pending"),
  decidedBy: text("decided_by"),
  comment: text("comment"),
  resumeAction: text("resume_action"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const onbCommunications = pgTable("onb_communications", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id")
    .notNull()
    .references(() => onbCases.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  direction: text("direction").notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  status: text("status").notNull(),
  failureReason: text("failure_reason"),
  sensitive: boolean("sensitive").notNull().default(false),
  /**
   * Provider-side id for inbound messages (Gmail message id, Twilio
   * MessageSid). Used to deduplicate polling / webhook retries.
   */
  externalMessageId: text("external_message_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const onbConnectors = pgTable("onb_connectors", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  vendor: text("vendor").notNull(),
  availableVendors: jsonb("available_vendors").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("connected"),
  description: text("description").notNull(),
  authoritativeFor: jsonb("authoritative_for").$type<string[]>().notNull().default([]),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
});
