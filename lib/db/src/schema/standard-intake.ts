import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { onbCases, type OnbWorkforceContext } from "./onboarding";

/**
 * Source-event register for the standard onboarding intake boundary. It
 * deliberately holds references and normalized snapshots, not offer files or
 * other acceptance artifacts themselves. Case deletion leaves an event
 * fingerprint tombstone after its evidence has been minimized.
 */
export const onbStandardIntakeEvents = pgTable("onb_standard_intake_events", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  sourceId: text("source_id").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  eventType: text("event_type").notNull().$type<"accepted-offer" | "scheduled-preboarding">(),
  sourceIdentity: text("source_identity").notNull(),
  acceptanceEvidenceReference: text("acceptance_evidence_reference").notNull(),
  payloadFingerprint: text("payload_fingerprint").notNull(),
  intakeSnapshot: jsonb("intake_snapshot").$type<Record<string, unknown>>().notNull(),
  workforceContextSnapshot: jsonb("workforce_context_snapshot").$type<OnbWorkforceContext>().notNull(),
  processPolicySnapshot: jsonb("process_policy_snapshot").$type<Record<string, unknown>>().notNull(),
  caseId: integer("case_id"),
  state: text("state").notNull().$type<"created" | "duplicate-active" | "case-deleted">(),
  failureReason: text("failure_reason"),
  // Scheduling state is separate from immutable source-event state. It is
  // durable so a heartbeat can request an HR release after a crash/redeploy.
  activationDueAt: timestamp("activation_due_at", { withTimezone: true }),
  activationStatus: text("activation_status").notNull().default("awaiting-review")
    .$type<"awaiting-review" | "scheduled" | "due-review" | "released">(),
  activationReviewRequestedAt: timestamp("activation_review_requested_at", { withTimezone: true }),
  activationReleasedAt: timestamp("activation_released_at", { withTimezone: true }),
  activationReleasedBy: text("activation_released_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  replayedAt: timestamp("replayed_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.sourceId, t.sourceEventId] }),
  index("onb_standard_intake_events_case_idx").on(t.organizationId, t.caseId),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_standard_intake_events_organization_case_fk",
    // PostgreSQL must null only case_id (organization_id is non-null). Drizzle
    // cannot represent a column-list SET NULL action, so migration 0066 owns
    // that exact database action.
  }).onDelete("no action"),
]);