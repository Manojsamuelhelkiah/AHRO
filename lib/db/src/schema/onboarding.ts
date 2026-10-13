import {
  boolean,
  check,
  foreignKey,
  index,
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
import type { HumanPermissionDecision } from "./human-permission";
import type { OfflineCasePreparation, OfflineCaseActivation } from "./offline-preparation";

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
  evidenceRequired?: boolean;
  responsibleRole?: string;
  completionAuthority?: "hr-admin" | "designated-human";
  executor?: "existing-workflow" | "human-task";
  prerequisites?: string[];
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
  /** Evidence is required before a designated human may complete this item. */
  evidenceRequired?: boolean;
  /** Accountable queue. Only supported human work is represented here. */
  responsibleRole?: string;
  /** Human completion authority; an agent assertion or a reminder is never evidence. */
  completionAuthority?: "hr-admin" | "designated-human";
  /** All non-existing integrations are explicit human tasks, never simulated effects. */
  executor?: "existing-workflow" | "human-task";
  prerequisites?: string[];
  /**
   * Typed policy bit copied into the immutable case snapshot. Labels are
   * presentation/configuration text and can never create or remove a
   * nonwaivable occupational-health/safety gate.
   */
  nonWaivableSafety?: boolean;
  /** Conservative hold attached by the legacy-policy migration pending review. */
  migrationReviewHold?: boolean;
};

export type OnbChecklistProfileCriteria = {
  band?: string;
  role?: string;
  employmentType?: string;
  location?: string;
  roleFamily?: string;
  department?: string;
  legalEntity?: string;
  businessUnit?: string;
  industry?: string;
  workCountry?: string;
  workState?: string;
  site?: string;
  employmentArrangement?: string;
  workerCategory?: string;
  payBasis?: string;
  shiftPattern?: string;
  workEnvironment?: string;
  hiringMode?: string;
  safetyCritical?: string;
};

/** Job context describes work and operating conditions, never personal traits. */
export type OnbWorkforceContext = {
  roleFamily?: string;
  band?: string;
  department?: string;
  legalEntity?: string;
  businessUnit?: string;
  industry?: string;
  workCountry?: string;
  workState?: string;
  site?: string;
  employmentArrangement?: string;
  workerCategory?: string;
  payBasis?: string;
  shiftPattern?: string;
  workEnvironment?: "office" | "remote" | "site" | "field" | "mixed";
  hazards?: string[];
  requiredLicenses?: string[];
  hiringMode?: "individual" | "batch" | "seasonal";
  batchId?: string;
  assistedIntake?: boolean;
  accessibilityNeeds?: string;
  languagePreference?: string;
  siteExposure?: boolean;
  safetyCritical?: boolean;
};

export type OnbWorkforceClassification = {
  label: "white-collar" | "blue-collar-frontline" | "mixed" | "needs-review";
  source: "deterministic-job-context" | "authorized-correction";
  rationale: string;
  confidence: "high" | "medium" | "uncertain";
  correction?: { label: "white-collar" | "blue-collar-frontline" | "mixed" | "needs-review"; by: string; reason: string; at: string };
};

export type OnbChecklistItemOverride = {
  id: string;
  label?: string;
  order?: number;
  enabled?: boolean;
  mandatory?: boolean;
  enforcementStage?: OnbChecklistEnforcementStage;
  evidenceRequired?: boolean;
  responsibleRole?: string;
  completionAuthority?: "hr-admin" | "designated-human";
  executor?: "existing-workflow" | "human-task";
  prerequisites?: string[];
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

/**
 * A specialist authority is deliberately separate from organization
 * membership.  Membership answers "may this person enter this tenant?"; this
 * record answers the narrower question "may this verified person make this
 * particular consequential decision?".
 */
export type OnbAuthorityScope =
  | "hr-compliance-approve"
  | "legal-approve"
  | "occupational-health-approve"
  | "safety-approve"
  | "site-fulfillment-approve"
  | "payroll-approve"
  | "fraud-control-approve"
  | "manager-approve"
  | "application-owner-approve"
  | "security-approve"
  | "it-security-approve"
  | "hrbp-approve"
  | "hr-ethics-approve"
  | "delivery-head-approve"
  | "finance-approve"
  | "authority-administration";

export type OffboardingAuthorityScope = "hrbp-approve" | "hr-ethics-approve" | "delivery-head-approve" | "finance-approve";
export type OnbSyntheticProvenance =
  | "onboarding-demo-fictional"
  | "synthetic-reset"
  | "demo-full-coverage"
  | "demo-controller-fictional";
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
  /** Immutable job-context input and classification captured at enrolment. */
  workforceContext: jsonb("workforce_context").$type<OnbWorkforceContext>().notNull().default({}),
  workforceClassification: jsonb("workforce_classification").$type<OnbWorkforceClassification>(),
  workforceContextVersion: integer("workforce_context_version").notNull().default(1),
  /** Effective policy provenance. Kept independently from legacy checklist fields. */
  processPolicySnapshot: jsonb("process_policy_snapshot").$type<Record<string, unknown>>().notNull().default({}),
  jobProfileId: text("job_profile_id"),
  jobProfileVersion: integer("job_profile_version"),
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
  /** Set only by server-owned fictional offline case creators; never inferred from notes. */
  syntheticProvenance: text("synthetic_provenance").$type<OnbSyntheticProvenance>(),
  /** Preparation only: no approval, runtime checkpoint or effect eligibility. */
  operationalPreparation: jsonb("operational_preparation").$type<OfflineCasePreparation>(),
  operationalActivation: jsonb("operational_activation").$type<OfflineCaseActivation>(),
  /** Permanent operational deny fence; never implies fictional identity. */
  controllerRetired: boolean("controller_retired").notNull().default(false),
  /**
   * Legacy case-email authorization audit history. Candidate delivery now
   * depends on the current deliverable address, not these historical fields.
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
  /** Immutable authenticated principal that created/requested the case. */
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_cases_organization_id_id_unique").on(t.organizationId, t.id),
  check("onb_separation_envelope_no_completion", sql`${t.hireType} <> 'separation' OR (${t.lifecycleStage} LIKE 'separation-%' AND ${t.orchestrationStatus} = 'separation-only' AND ${t.offerAcceptanceComplete} = false)`),
  check("onb_cases_synthetic_provenance_check", sql`
    ${t.syntheticProvenance} is null or ${t.syntheticProvenance} in (
      'onboarding-demo-fictional',
      'synthetic-reset',
      'demo-full-coverage',
      'demo-controller-fictional'
    )
  `),
]);

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
  /**
   * Required specialist scope for new approvals. Null is intentional for
   * historical rows: those rows remain visible but are unresolved evidence,
   * not a basis for a new consequential effect.
   */
  authorityScope: text("authority_scope").$type<OnbAuthorityScope>(),
  requestedByUserId: text("requested_by_user_id"),
  decidedAuthorityId: text("decided_authority_id"),
  permissionDecision: jsonb("permission_decision").$type<HumanPermissionDecision>(),
  decidedAuthorityRevision: integer("decided_authority_revision"),
  authorityReviewStatus: text("authority_review_status").notNull().default("not-required"),
  authorityReviewedByUserId: text("authority_reviewed_by_user_id"),
  authorityReviewedAt: timestamp("authority_reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [
  unique("onb_approvals_organization_idempotency_key_unique").on(t.organizationId, t.idempotencyKey),
  unique("onb_approvals_organization_id_id_unique").on(t.organizationId, t.id),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "onb_approvals_organization_case_fk" }).onDelete("cascade"),
]);

/** Tenant governance state. An operator attestation is not directory proof. */
export const onbAuthorityGovernance = pgTable("onb_authority_governance", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  /** unconfigured | operator-attested | governance-approved | withdrawn */
  status: text("status").notNull().default("unconfigured"),
  operatorUserId: text("operator_user_id"),
  attestedAt: timestamp("attested_at", { withTimezone: true }),
  attestationNote: text("attestation_note"),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  governanceSource: text("governance_source"),
  revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check(
    "onb_authority_governance_status_check",
    sql`${t.status} in ('unconfigured', 'operator-attested', 'governance-approved', 'withdrawn')`,
  ),
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
   * Server-owned lifecycle class for the durable payload. Never infer this
   * from delivery channel: BGV notices can be email too.
   */
  sensitiveDataClass: text("sensitive_data_class").$type<
    "candidate-contact" | "candidate-voice" | "bgv" | "unclassified-legacy"
  >().notNull().default("candidate-contact"),
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
  index("onb_communications_lifecycle_scan_idx").on(t.organizationId, t.sensitiveDataClass, t.createdAt),
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
  /** Typed policy metadata layered onto the legacy checklist profile. */
  processPolicy: jsonb("process_policy").$type<Record<string, unknown>>().notNull().default({}),
  priority: integer("priority").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.profileId, t.version] }),
  check("onb_checklist_profiles_version_check", sql`${t.version} > 0`),
  check("onb_checklist_profiles_priority_check", sql`${t.priority} >= 0`),
]);

/** Metadata-only decision trail for independently verified policy gates. */
export const onbPolicyEvidence = pgTable("onb_policy_evidence", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  itemId: text("item_id").notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  authorityRole: text("authority_role").notNull(),
  decision: text("decision").$type<"verified" | "rejected">().notNull(),
  reason: text("reason").notNull(),
  verifiedBy: text("verified_by").notNull(),
  verifiedByUserId: text("verified_by_user_id").notNull(),
  checklistTemplateVersion: integer("checklist_template_version").notNull(),
  checklistProfileId: text("checklist_profile_id").notNull(),
  checklistProfileVersion: integer("checklist_profile_version").notNull(),
  workforceContextVersion: integer("workforce_context_version").notNull(),
  authorityAssignmentId: text("authority_assignment_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_policy_evidence_organization_case_fk",
  }).onDelete("cascade"),
]);

/** Tenant owner-maintained server-side authority binding for policy evidence. */
export const onbPolicyAuthorities = pgTable("onb_policy_authorities", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  userId: text("user_id").notNull(),
  authorityRole: text("authority_role").notNull(),
  caseId: integer("case_id").notNull(),
  itemId: text("item_id").notNull(),
  site: text("site").notNull(),
  assignedBy: text("assigned_by").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.userId, t.authorityRole, t.caseId, t.itemId, t.site] }),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_policy_authorities_organization_case_fk",
  }).onDelete("cascade"),
]);

/** Immutable, organization-scoped job-profile versions reusable at intake. */
export const onbJobProfiles = pgTable("onb_job_profiles", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  profileId: text("profile_id").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  context: jsonb("context").$type<OnbWorkforceContext>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.profileId, t.version] })]);

/**
 * A batch is an intake envelope, not a policy. It holds the client retry key
 * so a retry can reconcile the original people rather than creating a second
 * cohort. Each person retains their own resolved context and policy snapshot.
 */
export const onbIntakeBatches = pgTable("onb_intake_batches", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  batchId: text("batch_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadFingerprint: text("payload_fingerprint").notNull(),
  name: text("name").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.batchId] }),
  unique("onb_intake_batches_organization_idempotency_key_unique").on(t.organizationId, t.idempotencyKey),
]);

/** Reconciliation rows deliberately preserve a person-level immutable intake snapshot. */
export const onbIntakeBatchPeople = pgTable("onb_intake_batch_people", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  batchId: text("batch_id").notNull(),
  personKey: text("person_key").notNull(),
  caseId: integer("case_id").notNull(),
  workforceContextSnapshot: jsonb("workforce_context_snapshot").$type<OnbWorkforceContext>().notNull(),
  processPolicySnapshot: jsonb("process_policy_snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.batchId, t.personKey] }),
  foreignKey({
    columns: [t.organizationId, t.batchId],
    foreignColumns: [onbIntakeBatches.organizationId, onbIntakeBatches.batchId],
    name: "onb_intake_batch_people_batch_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_intake_batch_people_case_fk",
  }).onDelete("cascade"),
]);

/** Human-reviewed, evidence-scoped recommendation lifecycle; no auto-adoption. */
export const onbPolicyRecommendations = pgTable("onb_policy_recommendations", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  status: text("status").$type<"proposed" | "accepted" | "rejected">().notNull().default("proposed"),
  recommendation: jsonb("recommendation").$type<Record<string, unknown>>().notNull(),
  evidenceSnapshot: jsonb("evidence_snapshot").$type<Record<string, unknown>>().notNull(),
  decisionNote: text("decision_note"),
  decidedBy: text("decided_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
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
    /** Runtime boundary, not reconstructed historical outcome evidence. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * Immutable classification of the source that produced the terminal
     * status. A simulated watcher completion must never be interpreted as
     * external BGV/HRIS evidence by a live governance gate.
     */
    evidenceProvenance: text("evidence_provenance").$type<
      "trusted-provider" | "human-authorized" | "simulated" | "offline" | "unknown"
    >(),
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
  /**
   * `connected` is a UI/tracking state only. This records whether a server
   * verified a live provider configuration rather than the seeded simulator.
   */
  configurationProvenance: text("configuration_provenance")
    .$type<"trusted-provider" | "simulated">()
    .notNull()
    .default("simulated"),
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
    /** Runtime boundary; legacy rows predate any subsequently activated generation. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

/**
 * Governance-approved, person-bound delegated authority. `personEmail` is
 * optional and is used only for an explicitly enabled, exact sender-bound
 * remote response; it is never inferred from a display persona.
 */
export const onbAuthorityAssignments = pgTable("onb_authority_assignments", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  personUserId: text("person_user_id").notNull(),
  personEmail: text("person_email"),
  emailResponderAuthorized: boolean("email_responder_authorized").notNull().default(false),
  authorityRole: text("authority_role").$type<OnbAuthorityRole>().notNull(),
  scopes: jsonb("scopes").$type<OnbAuthorityScope[]>().notNull(),
  caseId: integer("case_id"),
  siteScope: text("site_scope"),
  jurisdictionScope: text("jurisdiction_scope"),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  /** active | revoked */
  status: text("status").notNull().default("active"),
  revision: integer("revision").notNull().default(1),
  grantorUserId: text("grantor_user_id").notNull(),
  /** Governance evidence source; email grants are marked governance-decision:clerk-verified-email. */
  source: text("source").notNull(),
  governanceDecisionRef: text("governance_decision_ref").notNull(),
  revokedByUserId: text("revoked_by_user_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokeReason: text("revoke_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_authority_assignments_organization_id_id_unique").on(t.organizationId, t.id),
  index("onb_authority_assignments_person_lookup_idx").on(t.organizationId, t.personUserId, t.status),
  index("onb_authority_assignments_remote_lookup_idx").on(t.organizationId, t.personEmail, t.status),
  check("onb_authority_assignments_status_check", sql`${t.status} in ('active', 'revoked')`),
  check("onb_authority_assignments_revision_check", sql`${t.revision} > 0`),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_authority_assignments_organization_case_fk",
  }).onDelete("cascade"),
]);

export type OnbAuthorityRole =
  | "hrbp"
  | "hr-ethics"
  | "delivery-head"
  | "finance"
  | "hr-compliance"
  | "legal"
  | "occupational-health"
  | "safety"
  | "site-operations"
  | "payroll"
  | "fraud-control"
  | "manager"
  | "application-owner"
  | "security"
  | "it-security"
  | "governance";

/** Append-only authority and governance administration audit. */
export const onbAuthorityAudit = pgTable("onb_authority_audit", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  authorityId: text("authority_id"),
  action: text("action").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("onb_authority_audit_organization_created_idx").on(t.organizationId, t.createdAt),
]);
