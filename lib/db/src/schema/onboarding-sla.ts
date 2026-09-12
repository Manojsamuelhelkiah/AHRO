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
import { onbCases } from "./onboarding";

export const READINESS_SLA_STREAM_KEYS = [
  "documentation",
  "bgv",
  "hris",
  "it-assets",
  "payroll",
] as const;
export type OnbReadinessSlaStreamKey = typeof READINESS_SLA_STREAM_KEYS[number];

export type OnbReadinessSlaStreamPolicy = {
  key: OnbReadinessSlaStreamKey;
  label: string;
  weight: number;
};

export type OnbReadinessSlaActionPolicy = {
  key: string;
  streamKey: OnbReadinessSlaStreamKey;
  label: string;
  owner: string;
  backupEmail: string | null;
  enabled: boolean;
  mandatory: boolean;
  anchor: "joining" | "action-start" | "payroll-cutoff";
  offsetDays: number;
  deadlineLocalTime: string;
  timezone: string;
  calendar: "days" | "businessDays";
  holidayDates: string[];
  warnHours: number;
  escalationAfterHours: number;
  notifyInApp: boolean;
  notifyEmail: boolean;
};

export type OnbReadinessSlaPolicy = {
  streams: OnbReadinessSlaStreamPolicy[];
  actions: OnbReadinessSlaActionPolicy[];
};

export type OnbReadinessSlaApplicability = {
  key: OnbReadinessSlaStreamKey;
  applicable: boolean;
  reason: string;
};

export type OnbReadinessSlaHistoryEntry = {
  state: "warned" | "breached" | "escalated" | "resolved";
  at: string;
  rationale: string;
};

export const onbReadinessSlaPolicies = pgTable(
  "onb_readiness_sla_policies",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    version: integer("version").notNull(),
    policy: jsonb("policy").$type<OnbReadinessSlaPolicy>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.version] }),
    check("onb_readiness_sla_policy_version_check", sql`${t.version} > 0`),
  ],
);

/** Immutable policy/applicability snapshot copied to a case. */
export const onbReadinessSlaSnapshots = pgTable(
  "onb_readiness_sla_snapshots",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    policyVersion: integer("policy_version").notNull(),
    // Nullable for snapshots created before the additive 0041 migration.
    // Such snapshots must be explicitly rebased before joining-date actions
    // can be scheduled; never fall back to the live case date.
    joiningDate: text("joining_date"),
    policy: jsonb("policy").$type<OnbReadinessSlaPolicy>().notNull(),
    applicability: jsonb("applicability").$type<OnbReadinessSlaApplicability[]>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.caseId, t.snapshotVersion] }),
    check("onb_readiness_sla_snapshot_version_check", sql`${t.snapshotVersion} > 0`),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_readiness_sla_snapshots_organization_case_fk",
    }).onDelete("cascade"),
  ],
);

/** Mutable case pointer and case-specific payroll cutoff. */
export const onbReadinessSlaCaseState = pgTable(
  "onb_readiness_sla_case_state",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    payrollCutoff: timestamp("payroll_cutoff", { withTimezone: true }),
    payrollCutoffReason: text("payroll_cutoff_reason"),
    payrollCutoffSetBy: text("payroll_cutoff_set_by"),
    payrollCutoffSetAt: timestamp("payroll_cutoff_set_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.caseId] }),
    check("onb_readiness_sla_case_state_snapshot_version_check", sql`${t.snapshotVersion} > 0`),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_readiness_sla_case_state_organization_case_fk",
    }).onDelete("cascade"),
  ],
);

/** Append-only human attestation history; latest row is the current state. */
export const onbReadinessSlaAttestations = pgTable(
  "onb_readiness_sla_attestations",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    streamKey: text("stream_key").notNull(),
    complete: boolean("complete").notNull(),
    /**
     * Server-classified origin of the asserted stream state. Ordinary
     * workflow/user attestations remain auditable but cannot impersonate a
     * trusted external activation signal.
     */
    evidenceProvenance: text("evidence_provenance").$type<
      "trusted-provider" | "human-authorized" | "simulated" | "offline" | "unknown"
    >(),
    reason: text("reason").notNull(),
    attestedBy: text("attested_by").notNull(),
    attestedRole: text("attested_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("onb_readiness_sla_attestations_case_stream_idx").on(
      t.organizationId,
      t.caseId,
      t.streamKey,
      t.createdAt,
    ),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_readiness_sla_attestations_organization_case_fk",
    }).onDelete("cascade"),
    check(
      "onb_readiness_sla_attestations_stream_check",
      sql`${t.streamKey} in ('hris')`,
    ),
  ],
);

/** Durable occurrence ledger; rows are never removed after a breach. */
export const onbReadinessSlaLedger = pgTable(
  "onb_readiness_sla_ledger",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    actionKey: text("action_key").notNull(),
    occurrence: integer("occurrence").notNull().default(1),
    state: text("state").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    warningAt: timestamp("warning_at", { withTimezone: true }),
    breachAt: timestamp("breach_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    lastRationale: text("last_rationale"),
    history: jsonb("history").$type<OnbReadinessSlaHistoryEntry[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("onb_readiness_sla_ledger_occurrence_unique").on(
      t.organizationId,
      t.caseId,
      t.snapshotVersion,
      t.actionKey,
      t.occurrence,
    ),
    index("onb_readiness_sla_ledger_due_idx").on(t.state, t.dueAt),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_readiness_sla_ledger_organization_case_fk",
    }).onDelete("cascade"),
    check(
      "onb_readiness_sla_ledger_state_check",
      sql`${t.state} in ('scheduled', 'warned', 'breached', 'escalated', 'resolved', 'not-applicable', 'needs-configuration')`,
    ),
    check("onb_readiness_sla_ledger_occurrence_check", sql`${t.occurrence} > 0`),
  ],
);

/** Durable, claimable in-app/email notification outbox. */
export const onbReadinessSlaOutbox = pgTable(
  "onb_readiness_sla_outbox",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    ledgerId: integer("ledger_id"),
    eventKey: text("event_key").notNull(),
    channel: text("channel").notNull(),
    recipient: text("recipient"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimOwner: text("claim_owner"),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    deliveryInfo: text("delivery_info"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("onb_readiness_sla_outbox_event_unique").on(t.organizationId, t.eventKey),
    index("onb_readiness_sla_outbox_claim_idx").on(t.status, t.availableAt),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_readiness_sla_outbox_organization_case_fk",
    }).onDelete("cascade"),
    check(
      "onb_readiness_sla_outbox_channel_check",
      sql`${t.channel} in ('in-app', 'email')`,
    ),
    check(
      "onb_readiness_sla_outbox_status_check",
      sql`${t.status} in ('pending', 'claimed', 'sent', 'failed', 'unknown')`,
    ),
  ],
);

export type OnbReadinessSlaPolicyRow = typeof onbReadinessSlaPolicies.$inferSelect;
export type OnbReadinessSlaSnapshotRow = typeof onbReadinessSlaSnapshots.$inferSelect;
export type OnbReadinessSlaCaseStateRow = typeof onbReadinessSlaCaseState.$inferSelect;
export type OnbReadinessSlaAttestationRow = typeof onbReadinessSlaAttestations.$inferSelect;
export type OnbReadinessSlaLedgerRow = typeof onbReadinessSlaLedger.$inferSelect;
export type OnbReadinessSlaOutboxRow = typeof onbReadinessSlaOutbox.$inferSelect;