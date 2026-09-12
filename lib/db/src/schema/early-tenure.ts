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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { onbCases, type OnbAuthorityScope } from "./onboarding";

export const EARLY_TENURE_ASSIGNMENT_KINDS = [
  "induction",
  "compliance-training",
  "buddy-acknowledgement",
  "manager-connect",
  "learning-enrollment",
  "calendar-delivery",
] as const;
export type OnbEarlyTenureAssignmentKind = typeof EARLY_TENURE_ASSIGNMENT_KINDS[number];

export type OnbEarlyTenureApplicability = {
  hireTypes?: string[];
  workerCategories?: string[];
  legalEntities?: string[];
};

/**
 * An obligation is a work request, not a declaration that a provider did work.
 * Connector requirements stay pending until source-confirmed evidence arrives.
 */
export type OnbEarlyTenureObligationPolicy = {
  key: string;
  kind: OnbEarlyTenureAssignmentKind;
  label: string;
  offsetDays: number;
  required: boolean;
  ownerRole: string;
  requireEvidence: boolean;
  connectorKey?: string;
  sourceConfirmationRequired?: boolean;
  /** Required for manager-connect and persisted into every case assignment. */
  structuredAgenda?: string[];
};

export type OnbEarlyTenureCheckInPolicy = {
  key: string;
  label: string;
  offsetDays: number;
  required: boolean;
  reminderLeadDays: number;
};

export type OnbEarlyTenurePolicy = {
  applicability: OnbEarlyTenureApplicability;
  /** Explicit tenant policy, never inferred from a 30/60/90 cadence. */
  probationLengthDays: number;
  decisionAuthorityScope: OnbAuthorityScope;
  obligations: OnbEarlyTenureObligationPolicy[];
  checkIns: OnbEarlyTenureCheckInPolicy[];
};

export const onbEarlyTenurePolicyVersions = pgTable(
  "onb_early_tenure_policy_versions",
  {
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    version: integer("version").notNull(),
    policy: jsonb("policy").$type<OnbEarlyTenurePolicy>().notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.version] }),
    check("onb_early_tenure_policy_versions_version_check", sql`${t.version} > 0`),
  ],
);

/**
 * The policy body is immutable. Joining facts are deliberately separate
 * mutable fields so an actual-start correction cannot rewrite policy history.
 */
export const onbEarlyTenureCaseSnapshots = pgTable(
  "onb_early_tenure_case_snapshots",
  {
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    policyVersion: integer("policy_version").notNull(),
    policy: jsonb("policy").$type<OnbEarlyTenurePolicy>().notNull(),
    plannedJoiningDate: text("planned_joining_date").notNull(),
    actualJoinedAt: timestamp("actual_joined_at", { withTimezone: true }),
    anchorRevision: integer("anchor_revision").notNull().default(0),
    enrolledByUserId: text("enrolled_by_user_id").notNull(),
    enrolledBy: text("enrolled_by").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.caseId, t.snapshotVersion] }),
    unique("onb_early_tenure_case_current_snapshot_unique").on(t.organizationId, t.caseId),
    check("onb_early_tenure_case_snapshot_version_check", sql`${t.snapshotVersion} > 0`),
    check("onb_early_tenure_case_anchor_revision_check", sql`${t.anchorRevision} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_early_tenure_case_snapshots_organization_case_fk",
    }).onDelete("cascade"),
  ],
);

export const onbEarlyTenureAssignments = pgTable(
  "onb_early_tenure_assignments",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    obligationKey: text("obligation_key").notNull(),
    revision: integer("revision").notNull().default(1),
    /** Null means a human manually revised it; numeric values fence auto-anchor revisions. */
    anchorRevision: integer("anchor_revision"),
    kind: text("kind").$type<OnbEarlyTenureAssignmentKind>().notNull(),
    title: text("title").notNull(),
    ownerName: text("owner_name").notNull(),
    ownerUserId: text("owner_user_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    sourceConfirmationRequired: boolean("source_confirmation_required").notNull().default(false),
    requiredConnectorKey: text("required_connector_key"),
    taskDetails: jsonb("task_details").$type<Record<string, unknown>>().notNull().default({}),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByUserId: text("completed_by_user_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByAssignmentId: integer("superseded_by_assignment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("onb_early_tenure_assignments_revision_unique").on(
      t.organizationId, t.caseId, t.snapshotVersion, t.obligationKey, t.revision,
    ),
    unique("onb_early_tenure_assignments_organization_id_id_unique").on(t.organizationId, t.id),
    index("onb_early_tenure_assignments_due_idx").on(t.organizationId, t.status, t.dueAt),
    check("onb_early_tenure_assignments_revision_check", sql`${t.revision} > 0`),
    check("onb_early_tenure_assignments_status_check", sql`${t.status} in ('pending', 'completed', 'superseded', 'cancelled')`),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_early_tenure_assignments_organization_case_fk",
    }).onDelete("cascade"),
  ],
);

/** Append-only evidence; a reminder or agent output can never populate it. */
export const onbEarlyTenureEvidence = pgTable(
  "onb_early_tenure_evidence",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    assignmentId: integer("assignment_id").notNull(),
    evidenceReference: text("evidence_reference").notNull(),
    provenance: text("provenance").$type<"human-authorized" | "trusted-provider">().notNull(),
    sourceConnectorKey: text("source_connector_key"),
    recordedByUserId: text("recorded_by_user_id").notNull(),
    recordedBy: text("recorded_by").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("onb_early_tenure_evidence_assignment_idx").on(t.organizationId, t.assignmentId, t.createdAt),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_early_tenure_evidence_organization_case_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.assignmentId],
      foreignColumns: [onbEarlyTenureAssignments.organizationId, onbEarlyTenureAssignments.id],
      name: "onb_early_tenure_evidence_organization_assignment_fk",
    }).onDelete("cascade"),
  ],
);

export const onbEarlyTenureCheckins = pgTable(
  "onb_early_tenure_checkins",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    checkinKey: text("checkin_key").notNull(),
    revision: integer("revision").notNull().default(1),
    anchorRevision: integer("anchor_revision"),
    label: text("label").notNull(),
    ownerUserId: text("owner_user_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    reminderLeadDays: integer("reminder_lead_days").notNull().default(0),
    required: boolean("required").notNull().default(true),
    status: text("status").notNull().default("scheduled"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByUserId: text("completed_by_user_id"),
    evidenceReference: text("evidence_reference"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByCheckinId: integer("superseded_by_checkin_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("onb_early_tenure_checkins_revision_unique").on(
      t.organizationId, t.caseId, t.snapshotVersion, t.checkinKey, t.revision,
    ),
    index("onb_early_tenure_checkins_due_idx").on(t.organizationId, t.status, t.dueAt),
    check("onb_early_tenure_checkins_revision_check", sql`${t.revision} > 0`),
    check("onb_early_tenure_checkins_status_check", sql`${t.status} in ('scheduled', 'completed', 'superseded', 'cancelled')`),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_early_tenure_checkins_organization_case_fk",
    }).onDelete("cascade"),
  ],
);

/** Durable reminder rows are deduplicated before any communications dispatch. */
export const onbEarlyTenureReminders = pgTable(
  "onb_early_tenure_reminders",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    targetType: text("target_type").$type<"assignment" | "checkin">().notNull(),
    targetId: integer("target_id").notNull(),
    targetRevision: integer("target_revision").notNull(),
    eventKey: text("event_key").notNull(),
    intendedRecipient: text("intended_recipient").notNull(),
    recipientEmail: text("recipient_email"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    claimOwner: text("claim_owner"),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    deliveryInfo: text("delivery_info"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("onb_early_tenure_reminders_event_unique").on(t.organizationId, t.eventKey),
    index("onb_early_tenure_reminders_claim_idx").on(t.organizationId, t.status, t.availableAt),
    check("onb_early_tenure_reminders_target_check", sql`${t.targetType} in ('assignment', 'checkin')`),
    check("onb_early_tenure_reminders_status_check", sql`${t.status} in ('pending', 'claimed', 'sent', 'suppressed', 'failed', 'unknown')`),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_early_tenure_reminders_organization_case_fk",
    }).onDelete("cascade"),
  ],
);

/** No automated, adverse, or unreviewed probation outcome can be represented. */
export const onbProbationDecisions = pgTable(
  "onb_probation_decisions",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    anchorRevision: integer("anchor_revision").notNull(),
    decisionVersion: integer("decision_version").notNull(),
    disposition: text("disposition").$type<"confirmed" | "extended" | "reviewed-other">().notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    extensionEndsAt: timestamp("extension_ends_at", { withTimezone: true }),
    rationale: text("rationale").notNull(),
    evidenceReference: text("evidence_reference").notNull(),
    decidedByUserId: text("decided_by_user_id").notNull(),
    decidedBy: text("decided_by").notNull(),
    authorityId: text("authority_id").notNull(),
    authorityRevision: integer("authority_revision").notNull(),
    /** Server-recorded human decision time; effectiveAt may be a different employment date. */
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("onb_probation_decisions_version_unique").on(t.organizationId, t.caseId, t.decisionVersion),
    check("onb_probation_decisions_version_check", sql`${t.decisionVersion} > 0`),
    check("onb_probation_decisions_disposition_check", sql`${t.disposition} in ('confirmed', 'extended', 'reviewed-other')`),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_probation_decisions_organization_case_fk",
    }).onDelete("cascade"),
  ],
);