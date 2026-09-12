import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { onbCases, type OnbAuthorityScope } from "./onboarding";

/**
 * Restricted, voluntary survey evidence. This table intentionally has no
 * response narrative, survey token, recipient identity, or free-text comment:
 * reporting needs only a bounded eNPS score and source provenance.
 */
export const onbEarlyTenureSurveyResponses = pgTable(
  "onb_early_tenure_survey_responses",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    surveyKind: text("survey_kind").$type<"onboarding-30-day">().notNull(),
    voluntary: boolean("voluntary").notNull(),
    score: integer("score").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    provenance: text("provenance").$type<"human-authorized" | "trusted-provider">().notNull(),
    sourceConnectorKey: text("source_connector_key"),
    authorityAssignmentId: text("authority_assignment_id"),
    authorityAssignmentRevision: integer("authority_assignment_revision"),
    authorityReceiptId: integer("authority_receipt_id"),
    evidenceReference: text("evidence_reference").notNull(),
    recordedByUserId: text("recorded_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("onb_early_tenure_survey_reporting_idx").on(t.organizationId, t.caseId, t.submittedAt),
    check("onb_early_tenure_survey_kind_check", sql`${t.surveyKind} = 'onboarding-30-day'`),
    check("onb_early_tenure_survey_voluntary_check", sql`${t.voluntary} = true`),
    check("onb_early_tenure_survey_score_check", sql`${t.score} between 0 and 10`),
    check(
      "onb_early_tenure_survey_provenance_check",
      sql`(${t.provenance} = 'trusted-provider' and ${t.sourceConnectorKey} is not null and ${t.authorityAssignmentId} is null and ${t.authorityAssignmentRevision} is null)
        or (${t.provenance} = 'human-authorized' and ${t.sourceConnectorKey} is null and ${t.authorityAssignmentId} is not null and ${t.authorityAssignmentRevision} is not null)`,
    ),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_early_tenure_survey_organization_case_fk",
    }).onDelete("cascade"),
  ],
);

/**
 * Append-only server-authored authority receipt. It freezes the exact grant
 * revision, validity window, and case context that was verified at evidence
 * write time, so later grant edits/revocation cannot rewrite history.
 */
export const onbOutcomeEvidenceAuthorityReceipts = pgTable(
  "onb_outcome_evidence_authority_receipts",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    authorityAssignmentId: text("authority_assignment_id").notNull(),
    authorityAssignmentRevision: integer("authority_assignment_revision").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    authorityRole: text("authority_role").notNull(),
    scope: text("scope").$type<OnbAuthorityScope>().notNull(),
    caseId: integer("case_id").notNull(),
    siteScope: text("site_scope"),
    jurisdictionScope: text("jurisdiction_scope"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("onb_outcome_authority_receipt_lookup_idx").on(t.organizationId, t.id),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_outcome_authority_receipt_organization_case_fk",
    }).onDelete("cascade"),
  ],
);

/**
 * Append-only, dated evidence for actual employment outcomes. A planned case
 * joining date is deliberately absent; analytics only consumes actual_joined_at
 * carried by each authorized source record.
 */
export const onbEmploymentOutcomeEvidence = pgTable(
  "onb_employment_outcome_evidence",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
    caseId: integer("case_id").notNull(),
    actualJoinedAt: timestamp("actual_joined_at", { withTimezone: true }).notNull(),
    employmentStatus: text("employment_status").$type<"active" | "terminated" | "unknown">().notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    /** Active status after a termination is usable only with this explicit correction link. */
    correctsEvidenceId: integer("corrects_evidence_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    provenance: text("provenance").$type<"human-authorized" | "trusted-provider">().notNull(),
    sourceConnectorKey: text("source_connector_key"),
    authorityAssignmentId: text("authority_assignment_id"),
    authorityAssignmentRevision: integer("authority_assignment_revision"),
    authorityReceiptId: integer("authority_receipt_id"),
    evidenceReference: text("evidence_reference").notNull(),
    recordedByUserId: text("recorded_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("onb_employment_outcome_reporting_idx").on(t.organizationId, t.caseId, t.observedAt),
    check(
      "onb_employment_outcome_status_check",
      sql`${t.employmentStatus} in ('active', 'terminated', 'unknown')`,
    ),
    check(
      "onb_employment_outcome_effective_check",
      sql`(${t.employmentStatus} = 'terminated' and ${t.effectiveAt} is not null)
        or (${t.employmentStatus} in ('active', 'unknown') and ${t.effectiveAt} is null)`,
    ),
    check(
      "onb_employment_outcome_provenance_check",
      sql`(${t.provenance} = 'trusted-provider' and ${t.sourceConnectorKey} = 'hris' and ${t.authorityAssignmentId} is null and ${t.authorityAssignmentRevision} is null)
        or (${t.provenance} = 'human-authorized' and ${t.sourceConnectorKey} is null and ${t.authorityAssignmentId} is not null and ${t.authorityAssignmentRevision} is not null)`,
    ),
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [onbCases.organizationId, onbCases.id],
      name: "onb_employment_outcome_organization_case_fk",
    }).onDelete("cascade"),
  ],
);