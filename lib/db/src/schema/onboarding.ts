import {
  boolean,
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

export type OnbReadinessItemRow = {
  key: string;
  label: string;
  status: string;
  note?: string;
};

/** One archive Q&A pair attached to an escalation, with the structured stint scope. */
export type OnbRecordsEvidenceItem = {
  question: string;
  answer: string;
  scope: { kind: "all" | "latest" | "earliest" | "yearRange"; from?: number; to?: number };
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
  // Nullable: system-level events (e.g. inbox-monitor outages) are not tied to a case.
  caseId: integer("case_id").references(() => onbCases.id, { onDelete: "cascade" }),
  agent: text("agent").notNull(),
  engine: text("engine").notNull(),
  hitlPattern: text("hitl_pattern"),
  ruleRef: text("rule_ref"),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  /** Optional dedupe key: a crash-resumed writer inserting the same key is a no-op. */
  idempotencyKey: text("idempotency_key").unique(),
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
  /** Structured archive Q&A evidence (rehire escalations); null for approvals without records evidence. */
  recordsEvidence: jsonb("records_evidence").$type<OnbRecordsEvidenceItem[]>(),
  status: text("status").notNull().default("pending"),
  decidedBy: text("decided_by"),
  comment: text("comment"),
  resumeAction: text("resume_action"),
  /** Optional dedupe key: a crash-resumed writer inserting the same key is a no-op. */
  idempotencyKey: text("idempotency_key").unique(),
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

/**
 * App-level key/value settings editable from the control tower UI
 * (e.g. the HR outage-alert email address). Values are plain text;
 * interpretation is up to the reader.
 */
export const onbSettings = pgTable("onb_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
/**
 * One tracked external-system checklist item per case (BGV clearance,
 * ITSM access provisioning, payroll setup). The System Watcher agent
 * creates these when workstreams start, closes them when the external
 * system reports done (webhook push or scheduled poll), and escalates
 * with a rules-tagged event when a check blows past its SLA.
 */
export const onbSystemChecks = pgTable(
  "onb_system_checks",
  {
    id: serial("id").primaryKey(),
    caseId: integer("case_id")
      .notNull()
      .references(() => onbCases.id, { onDelete: "cascade" }),
    /** bgv | itsm | payroll */
    system: text("system").notNull(),
    /** push (vendor webhook) | poll (scheduled API polling) | email (watch-mailbox) */
    mode: text("mode").notNull(),
    /** Vendor-side reference, e.g. "BGV-1042" */
    externalRef: text("external_ref").notNull(),
    /** pending | done | overdue */
    status: text("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    note: text("note"),
  },
  (t) => [unique("onb_system_checks_case_system").on(t.caseId, t.system)],
);
export const onbConnectors = pgTable("onb_connectors", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  vendor: text("vendor").notNull(),
  availableVendors: jsonb("available_vendors").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("connected"),
  /** api (deep integration: poll/webhook) | email (watch-mailbox tracking) */
  trackingMode: text("tracking_mode").notNull().default("api"),
  description: text("description").notNull(),
  authoritativeFor: jsonb("authoritative_for").$type<string[]>().notNull().default([]),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
});

/**
 * Status emails matched by the watch-mailbox tracker (email tracking
 * mode). One row per processed Gmail message (or simulated demo email);
 * the unique Gmail id makes processing idempotent across restarts.
 */
/**
 * Per-case document checklist — the "documentation pack" as real records
 * rather than just a narrative event. Seeded when a case starts (and
 * idempotently backfilled at startup for demo data); statuses advance as
 * the hire submits and HR verifies each item.
 */
export const onbDocuments = pgTable(
  "onb_documents",
  {
    id: serial("id").primaryKey(),
    caseId: integer("case_id")
      .notNull()
      .references(() => onbCases.id, { onDelete: "cascade" }),
    /** stable key within a case, e.g. id-proof, tax-form */
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** identity | statutory | contract | policy */
    category: text("category").notNull(),
    /** pending | received | verified */
    status: text("status").notNull().default("pending"),
    required: boolean("required").notNull().default(true),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.caseId, t.key)],
);

/**
 * Kick-off call slot proposals. When a hire asks for a call, the agent
 * offers concrete numbered slots by email; the hire books one by
 * replying with the slot number. One active proposal per case.
 */
export const onbCallSlots = pgTable("onb_call_slots", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id")
    .notNull()
    .references(() => onbCases.id, { onDelete: "cascade" }),
  /** [{ n: 1, startIso, label }] */
  slots: jsonb("slots").$type<Array<{ n: number; startIso: string; label: string }>>().notNull(),
  /** proposed | booked | superseded */
  status: text("status").notNull().default("proposed"),
  /** Optional dedupe key: a crash-resumed proposer re-inserting the same key is a no-op. */
  dedupeKey: text("dedupe_key").unique(),
  bookedSlotN: integer("booked_slot_n"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  bookedAt: timestamp("booked_at", { withTimezone: true }),
});

/**
 * Live AI voice-call sessions, keyed by our per-call token and bound to the
 * Twilio CallSid on the first webhook. Turns and decisions accumulate here
 * as the call progresses, so a server restart mid-call (or a late Twilio
 * callback) can still finalize the call: persist the transcript to the
 * communications timeline and execute/flag the decisions reached.
 * Simulated calls run in-process and are not stored here.
 */
export const onbVoiceSessions = pgTable("onb_voice_sessions", {
  token: text("token").primaryKey(),
  caseId: integer("case_id")
    .notNull()
    .references(() => onbCases.id, { onDelete: "cascade" }),
  /** day-before | sla-escalation */
  scenario: text("scenario").notNull(),
  reason: text("reason"),
  /** Twilio CallSid, bound on the first webhook; later callbacks must match. */
  callSid: text("call_sid").unique(),
  turns: jsonb("turns")
    .$type<Array<{ role: "agent" | "hire"; text: string }>>()
    .notNull()
    .default([]),
  decisions: jsonb("decisions")
    .$type<Array<{ decision: string; note: string }>>()
    .notNull()
    .default([]),
  /** Terminal: set only after the transcript + all decision side effects are durably persisted. */
  finalized: boolean("finalized").notNull().default(false),
  /**
   * Finalization lease: a finalizer stamps this before running outcome side
   * effects. If it crashes mid-way, the lease expires and startup recovery
   * (or a later callback) reclaims the row and resumes from outcomeProgress.
   */
  finalizeLeaseAt: timestamp("finalize_lease_at", { withTimezone: true }),
  /** Fencing token: identifies the finalizer holding the lease; every progress/terminal write is conditioned on it. */
  finalizeOwner: text("finalize_owner"),
  /** Idempotency markers for completed outcome steps (transcript, decision:*, summary). */
  outcomeProgress: jsonb("outcome_progress").$type<Record<string, boolean>>().notNull().default({}),
  /** Last hire utterance + the answer given — Twilio retries replay identically. */
  lastSpeech: text("last_speech"),
  lastResponse: jsonb("last_response").$type<{ say: string; done: boolean }>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
}, (t) => [
  /** At most one live (unfinalized) call session per case — the call-start claim is atomic at the DB. */
  uniqueIndex("onb_voice_sessions_live_case_idx").on(t.caseId).where(sql`${t.finalized} = false`),
]);
export const onbWatchEmails = pgTable("onb_watch_emails", {
  id: serial("id").primaryKey(),
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  checkId: integer("check_id").references(() => onbSystemChecks.id, {
    onDelete: "cascade",
  }),
  caseId: integer("case_id").references(() => onbCases.id, { onDelete: "cascade" }),
  system: text("system").notNull(),
  fromAddress: text("from_address").notNull(),
  subject: text("subject"),
  snippet: text("snippet"),
  /** completed | exception | update */
  parsedStatus: text("parsed_status").notNull(),
  /** What the watcher did about it, human-readable */
  action: text("action").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Archived employment history — the system-of-record the LDM (large
 * database model) agent queries when a rehire is detected. One row per
 * past stint, matched to a case by worker email (demo archive).
 */
export const onbEmployeeRecords = pgTable("onb_employee_records", {
  id: serial("id").primaryKey(),
  /** Archive match key: the (re)hire's email, lowercased. */
  workerEmail: text("worker_email").notNull(),
  workerName: text("worker_name").notNull(),
  role: text("role").notNull(),
  department: text("department").notNull(),
  startDate: text("start_date").notNull(), // YYYY-MM-DD
  endDate: text("end_date").notNull(), // YYYY-MM-DD
  exitReason: text("exit_reason").notNull(),
  noticeRequiredDays: integer("notice_required_days").notNull(),
  noticeServedDays: integer("notice_served_days").notNull(),
  /** Final performance rating for the stint, 1.0–5.0 scale. */
  performanceRating: text("performance_rating").notNull(),
  rehireEligible: boolean("rehire_eligible").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  /** One stint per worker+start date — makes demo seeding an idempotent upsert. */
  uniqueIndex("onb_employee_records_stint_idx").on(t.workerEmail, t.startDate),
]);

/**
 * Guardrail activation audit. One row each time a security/safety
 * guardrail actively intervened (blocked, sanitized, rate-limited or
 * escalated). Powers the Guardrails page drilldowns.
 */
export const onbGuardrailEvents = pgTable("onb_guardrail_events", {
  id: serial("id").primaryKey(),
  /** Nullable: some guardrails fire outside any case (e.g. forged webhooks). */
  caseId: integer("case_id").references(() => onbCases.id, { onDelete: "cascade" }),
  /** Key into the guardrails catalog (see api-server guardrails lib). */
  guardrailKey: text("guardrail_key").notNull(),
  /** blocked | sanitized | rate-limited | escalated | rejected */
  action: text("action").notNull(),
  detail: text("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
