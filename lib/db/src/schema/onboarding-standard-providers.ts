import {
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

/**
 * These tables deliberately hold metadata, mappings, and source observations.
 * They never hold an API credential or a vendor payload containing candidate
 * data. Provider secrets stay in the server-side secret store.
 */
export const onbStandardProviderConfigs = pgTable("onb_standard_provider_configs", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  providerKey: text("provider_key").notNull(),
  sourceOfTruth: text("source_of_truth").notNull(),
  configurationState: text("configuration_state").notNull().default("not-configured"),
  fieldMappings: jsonb("field_mappings").$type<Record<string, string>>().notNull().default({}),
  sandboxEvidenceReference: text("sandbox_evidence_reference"),
  sandboxValidatedAt: timestamp("sandbox_validated_at", { withTimezone: true }),
  operatorApprovalReference: text("operator_approval_reference"),
  operatorApprovedAt: timestamp("operator_approved_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.providerKey] }),
  check(
    "onb_standard_provider_config_state_check",
    sql`${t.configurationState} in ('not-configured', 'mapping-configured', 'sandbox-validated', 'operator-approved')`,
  ),
  check("onb_standard_provider_config_version_check", sql`${t.version} > 0`),
]);

/**
 * Normalized identifiers and status observations from the documented provider
 * contracts. An observation is not automatically trusted provider evidence:
 * `evidenceClass` tells the readiness UI and runtime exactly what it can prove.
 */
export const onbStandardProviderSourceRecords = pgTable("onb_standard_provider_source_records", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id"),
  providerKey: text("provider_key").notNull(),
  sourceRecordType: text("source_record_type").notNull(),
  sourceRecordId: text("source_record_id").notNull(),
  normalizedState: text("normalized_state").notNull(),
  sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }).notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  evidenceClass: text("evidence_class").notNull().default("operator-recorded-source-observation"),
  fieldSnapshot: jsonb("field_snapshot").$type<Record<string, string>>().notNull().default({}),
  recordedBy: text("recorded_by").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("onb_standard_provider_source_record_unique").on(
    t.organizationId, t.providerKey, t.sourceRecordType, t.sourceRecordId,
  ),
  index("onb_standard_provider_source_case_idx").on(t.organizationId, t.caseId, t.recordedAt),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "onb_standard_provider_source_case_fk",
  }).onDelete("cascade"),
]);

/** Open provider choices and vendor follow-ups are visible, durable decisions. */
export const onbStandardProviderDecisions = pgTable("onb_standard_provider_decisions", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  providerKey: text("provider_key").notNull(),
  decisionKey: text("decision_key").notNull(),
  status: text("status").notNull().default("open"),
  accountableRole: text("accountable_role").notNull(),
  requirement: text("requirement").notNull(),
  detail: text("detail").notNull(),
  documentationUrls: jsonb("documentation_urls").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  unique("onb_standard_provider_decision_unique").on(t.organizationId, t.providerKey, t.decisionKey),
  check("onb_standard_provider_decision_status_check", sql`${t.status} in ('open', 'accepted', 'deferred')`),
]);