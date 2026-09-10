import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";

export type OnbReadinessItemRow = {
  key: string;
  /** Stable template item id. `key` is retained for legacy connector code. */
  id?: string;
  label: string;
  status: string;
  note?: string;
  order?: number;
  mandatory?: boolean;
  enforcementStage?: OnbChecklistEnforcementStage;
};

export type OnbChecklistEnforcementStage =
  | "before-workstreams"
  | "before-employee-communications"
  | "before-day1-review";

export type OnbChecklistTemplateItem = {
  id: string;
  label: string;
  order: number;
  enabled: boolean;
  mandatory: boolean;
  enforcementStage: OnbChecklistEnforcementStage;
};

export type OnbChecklistProfileCriteria = {
  band?: string;
  role?: string;
  employmentType?: string;
  location?: string;
};

export type OnbChecklistItemOverride = {
  id: string;
  label?: string;
  order?: number;
  enabled?: boolean;
  mandatory?: boolean;
  enforcementStage?: OnbChecklistEnforcementStage;
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
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  workerName: text("worker_name").notNull(),
  workerEmail: text("worker_email").notNull(),
  workerPhone: text("worker_phone"),
  channelPreference: text("channel_preference").notNull().default("both"),
  hireType: text("hire_type").notNull(),
  workerCategory: text("worker_category").notNull(),
  workerBand: text("worker_band"),
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
  /** Immutable effective checklist copied at case creation. */
  checklistTemplateVersion: integer("checklist_template_version").notNull().default(1),
  checklistSnapshot: jsonb("checklist_snapshot").$type<OnbChecklistTemplateItem[]>().notNull().default([]),
  checklistProfileId: text("checklist_profile_id").notNull().default("default"),
  checklistProfileName: text("checklist_profile_name").notNull().default("Organization default"),
  checklistProfileVersion: integer("checklist_profile_version"),
  checklistMatchedCriteria: jsonb("checklist_matched_criteria").$type<OnbChecklistProfileCriteria>().notNull().default({}),
  checklistMatchExplanation: text("checklist_match_explanation").notNull().default("No targeted profile matched; organization default selected."),
  /** Last safely completed orchestration boundary; also identifies a checklist pause. */
  orchestrationCheckpoint: text("orchestration_checkpoint"),
  orchestrationClaimOwner: text("orchestration_claim_owner"),
  orchestrationClaimToken: integer("orchestration_claim_token").notNull().default(0),
  orchestrationClaimUntil: timestamp("orchestration_claim_until", { withTimezone: true }),
  readiness: jsonb("readiness").$type<OnbReadinessItemRow[]>().notNull().default([]),
  workstreams: jsonb("workstreams").$type<OnbWorkstreamRow[]>().notNull().default([]),
  primarySkill: text("primary_skill"),
  skillCriticality: text("skill_criticality"),
  scenarioKey: text("scenario_key"),
  planSummary: text("plan_summary"),
  notes: text("notes"),
  /**
   * Case-scoped consent for live candidate email. Set only by the
   * authenticated manual-intake route; scenario/demo seed paths leave it null.
   */
  candidateEmailAuthorizedAt: timestamp("candidate_email_authorized_at", { withTimezone: true }),
  candidateEmailAuthorizedBy: text("candidate_email_authorized_by"),
  /**
   * Gate A is an explicit HR attestation, never inferred from a historical
   * case row or a generic approval. The nullable audit fields distinguish an
   * unconfirmed legacy/active case from a completed package.
   */
  offerAcceptanceComplete: boolean("offer_acceptance_complete").notNull().default(false),
  offerAcceptanceCompletedAt: timestamp("offer_acceptance_completed_at", { withTimezone: true }),
  offerAcceptanceCompletedBy: text("offer_acceptance_completed_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("onb_cases_organization_id_id_unique").on(t.organizationId, t.id)]);

export const onbEvents = pgTable("onb_events", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  // Nullable: system-level events (e.g. inbox-monitor outages) are not tied to a case.
  caseId: integer("case_id"),
  agent: text("agent").notNull(),
  engine: text("engine").notNull(),
  hitlPattern: text("hitl_pattern"),
  ruleRef: text("rule_ref"),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  /** Optional dedupe key: a crash-resumed writer inserting the same key is a no-op. */
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_events_organization_idempotency_key_unique").on(t.organizationId, t.idempotencyKey),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_events_organization_case_fk" }).onDelete("cascade"),
]);

export const onbApprovals = pgTable("onb_approvals", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  caseId: integer("case_id")
    .notNull()
    ,
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
  idempotencyKey: text("idempotency_key"),
  /** Monotonic human-decision cycle. Legacy approvals are version 1. */
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [
  unique("onb_approvals_organization_idempotency_key_unique").on(t.organizationId, t.idempotencyKey),
  unique("onb_approvals_organization_id_id_unique").on(t.organizationId, t.id),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_approvals_organization_case_fk" }).onDelete("cascade"),
]);

export const onbCommunications = pgTable("onb_communications", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  caseId: integer("case_id")
    .notNull()
    ,
  channel: text("channel").notNull(),
  direction: text("direction").notNull(),
  /** candidate communications are case-routed; admin/HITL email is separate. */
  audience: text("audience").notNull().default("candidate"),
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
  externalMessageId: text("external_message_id"),
  /** Stable orchestration boundary key; retries reuse the same timeline row. */
  idempotencyKey: text("idempotency_key"),
  /** The authenticated reviewer who claimed the latest manual retry. */
  retriedBy: text("retried_by"),
  retriedAt: timestamp("retried_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_communications_organization_external_message_id_unique").on(t.organizationId, t.externalMessageId),
  unique("onb_communications_organization_idempotency_key_unique").on(t.organizationId, t.idempotencyKey),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_communications_organization_case_fk" }).onDelete("cascade"),
]);

/**
 * App-level key/value settings editable from the control tower UI
 * (e.g. the HR outage-alert email address). Values are plain text;
 * interpretation is up to the reader.
 */
export const onbSettings = pgTable("onb_settings", {
  key: text("key").notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.key] })]);

/** Immutable history of organization checklist configurations. Highest version is effective. */
export const onbChecklistTemplates = pgTable("onb_checklist_templates", {
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  version: integer("version").notNull(),
  items: jsonb("items").$type<OnbChecklistTemplateItem[]>().notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.version] }),
  check("onb_checklist_templates_version_check", sql`${t.version} > 0`),
]);

/** Immutable versions of named targeted profiles. The greatest version is current. */
export const onbChecklistProfiles = pgTable("onb_checklist_profiles", {
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  profileId: text("profile_id").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  criteria: jsonb("criteria").$type<OnbChecklistProfileCriteria>().notNull(),
  overrides: jsonb("overrides").$type<OnbChecklistItemOverride[]>().notNull().default([]),
  priority: integer("priority").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.profileId, t.version] }),
  check("onb_checklist_profiles_version_check", sql`${t.version} > 0`),
  check("onb_checklist_profiles_priority_check", sql`${t.priority} >= 0`),
]);
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
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: integer("case_id")
      .notNull()
      ,
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
  (t) => [
    unique("onb_system_checks_organization_id_id_unique").on(t.organizationId, t.id),
    unique("onb_system_checks_organization_case_system_unique").on(t.organizationId, t.caseId, t.system),
    foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_system_checks_organization_case_fk" }).onDelete("cascade"),
  ],
);
export const onbConnectors = pgTable("onb_connectors", {
  key: text("key").notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  label: text("label").notNull(),
  vendor: text("vendor").notNull(),
  availableVendors: jsonb("available_vendors").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("connected"),
  /** api (deep integration: poll/webhook) | email (watch-mailbox tracking) */
  trackingMode: text("tracking_mode").notNull().default("api"),
  description: text("description").notNull(),
  authoritativeFor: jsonb("authoritative_for").$type<string[]>().notNull().default([]),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.organizationId, t.key] })]);

/**
 * Durable boundary around connector writes. The logical operation key is the
 * identity of the remote effect, deliberately independent of plan version so
 * replanning can reuse an already-confirmed payroll or access change.
 */
export const onbEffectJournal = pgTable(
  "onb_effect_journal",
  {
    logicalOperationKey: text("logical_operation_key").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    tenantId: text("tenant_id").notNull(),
    caseId: integer("case_id"),
    toolName: text("tool_name").notNull(),
    argumentsHash: text("arguments_hash").notNull(),
    providerIdempotency: boolean("provider_idempotency").notNull(),
    /** ready | dispatching | confirmed | unknown_effect_manual_repair | failed */
    status: text("status").notNull().default("ready"),
    /** Monotonically increases on every successful dispatch claim. */
    fencingToken: integer("fencing_token").notNull().default(0),
    claimOwner: text("claim_owner"),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    externalEffectId: text("external_effect_id"),
    lastError: text("last_error"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.logicalOperationKey] }),
    check(
      "onb_effect_journal_status_check",
      sql`${t.status} in ('ready', 'dispatching', 'confirmed', 'unknown_effect_manual_repair', 'failed')`,
    ),
    check("onb_effect_journal_fencing_token_check", sql`${t.fencingToken} >= 0`),
    foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_effect_journal_organization_case_fk" }),
  ],
);

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
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: integer("case_id")
      .notNull()
      ,
    /** stable key within a case, e.g. id-proof, tax-form */
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** identity | statutory | contract | policy */
    category: text("category").notNull(),
    /** pending | received | verified */
    status: text("status").notNull().default("pending"),
    required: boolean("required").notNull().default(true),
    note: text("note"),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    reminderNextAt: timestamp("reminder_next_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("onb_documents_organization_case_key_unique").on(t.organizationId, t.caseId, t.key),
    foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_documents_organization_case_fk" }).onDelete("cascade"),
  ],
);

/**
 * Kick-off call slot proposals. When a hire asks for a call, the agent
 * offers concrete numbered slots by email; the hire books one by
 * replying with the slot number. One active proposal per case.
 */
export const onbCallSlots = pgTable("onb_call_slots", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  caseId: integer("case_id")
    .notNull()
    ,
  /** [{ n: 1, startIso, label }] */
  slots: jsonb("slots").$type<Array<{ n: number; startIso: string; label: string }>>().notNull(),
  /** proposed | booked | superseded */
  status: text("status").notNull().default("proposed"),
  /** Optional dedupe key: a crash-resumed proposer re-inserting the same key is a no-op. */
  dedupeKey: text("dedupe_key"),
  bookedSlotN: integer("booked_slot_n"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  bookedAt: timestamp("booked_at", { withTimezone: true }),
}, (t) => [
  unique("onb_call_slots_organization_dedupe_key_unique").on(t.organizationId, t.dedupeKey),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_call_slots_organization_case_fk" }).onDelete("cascade"),
]);

/**
 * Live AI voice-call sessions, keyed by our per-call token and bound to the
 * Twilio CallSid on the first webhook. Turns and decisions accumulate here
 * as the call progresses, so a server restart mid-call (or a late Twilio
 * callback) can still finalize the call: persist the transcript to the
 * communications timeline and execute/flag the decisions reached.
 * Simulated calls run in-process and are not stored here.
 */
export const onbVoiceSessions = pgTable("onb_voice_sessions", {
  token: text("token").notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  caseId: integer("case_id")
    .notNull()
    ,
  /**
   * Local call identity and controller correlation are written before any
   * provider request.  They remain nullable for rows created by the legacy
   * voice path and old migrations; new starts always populate them.
   */
  localCallId: text("local_call_id"),
  runId: text("run_id"),
  requestId: text("request_id"),
  /** pending | accepted | unknown_effect_manual_repair | terminal status */
  providerStatus: text("provider_status").notNull().default("pending"),
  providerFailureReason: text("provider_failure_reason"),
  /** day-before | sla-escalation */
  scenario: text("scenario").notNull(),
  reason: text("reason"),
  /** Twilio CallSid, bound on the first webhook; later callbacks must match. */
  callSid: text("call_sid"),
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
  primaryKey({ columns: [t.organizationId, t.token] }),
  unique("onb_voice_sessions_organization_call_sid_unique").on(t.organizationId, t.callSid),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_voice_sessions_organization_case_fk" }).onDelete("cascade"),
  /** At most one live (unfinalized) call session per case — the call-start claim is atomic at the DB. */
  uniqueIndex("onb_voice_sessions_organization_live_case_idx").on(t.organizationId, t.caseId).where(sql`${t.finalized} = false`),
]);
export const onbWatchEmails = pgTable("onb_watch_emails", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  gmailMessageId: text("gmail_message_id").notNull(),
  checkId: integer("check_id"),
  caseId: integer("case_id"),
  system: text("system").notNull(),
  fromAddress: text("from_address").notNull(),
  subject: text("subject"),
  snippet: text("snippet"),
  /** completed | exception | update */
  parsedStatus: text("parsed_status").notNull(),
  /** What the watcher did about it, human-readable */
  action: text("action").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_watch_emails_organization_gmail_message_id_unique").on(t.organizationId, t.gmailMessageId),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_watch_emails_organization_case_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.organizationId, t.checkId], foreignColumns: [onbSystemChecks.organizationId, onbSystemChecks.id], name: "onb_watch_emails_organization_check_fk" }).onDelete("cascade"),
]);

/**
 * Archived employment history — the system-of-record the LDM (large
 * database model) agent queries when a rehire is detected. One row per
 * past stint, matched to a case by worker email (demo archive).
 */
export const onbEmployeeRecords = pgTable("onb_employee_records", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
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
  uniqueIndex("onb_employee_records_organization_stint_idx").on(t.organizationId, t.workerEmail, t.startDate),
]);

/**
 * Guardrail activation audit. One row each time a security/safety
 * guardrail actively intervened (blocked, sanitized, rate-limited or
 * escalated). Powers the Guardrails page drilldowns.
 */
export const onbGuardrailEvents = pgTable("onb_guardrail_events", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  /** Nullable: some guardrails fire outside any case (e.g. forged webhooks). */
  caseId: integer("case_id"),
  /** Key into the guardrails catalog (see api-server guardrails lib). */
  guardrailKey: text("guardrail_key").notNull(),
  /** blocked | sanitized | rate-limited | escalated | rejected */
  action: text("action").notNull(),
  detail: text("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_guardrail_events_organization_case_fk" }).onDelete("cascade"),
]);
