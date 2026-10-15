import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, jsonb, primaryKey, foreignKey, check, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { onbCases } from "./onboarding";

/** Registry metadata only. Domain records remain the only operational state. */
export const caseFlowDefinitions = pgTable("case_flow_definitions", {
  id: text("id").notNull(),
  version: integer("version").notNull(),
  family: text("family").notNull(),
  digest: text("digest").notNull(),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.id, t.version] }),
  check("case_flow_definition_version", sql`${t.version} > 0`),
  check("case_flow_definition_family", sql`${t.family} in ('onboarding', 'separation')`),
]);
export const caseFlowBindings = pgTable("case_flow_bindings", {
  organizationId: text("organization_id").notNull(),
  caseId: integer("case_id").notNull(),
  definitionId: text("definition_id"),
  definitionVersion: integer("definition_version"),
  compatibility: text("compatibility").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.organizationId, t.caseId] }),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.definitionId, t.definitionVersion], foreignColumns: [caseFlowDefinitions.id, caseFlowDefinitions.version] }),
  check("case_flow_binding_compatibility", sql`${t.compatibility} in ('bound', 'review-required', 'review-only')`),
  check("case_flow_binding_identity", sql`(${t.definitionId} is null) = (${t.definitionVersion} is null)`),
]);
export const caseFlowTransitions = pgTable("case_flow_transitions", {
  organizationId: text("organization_id").notNull(),
  caseId: integer("case_id").notNull(),
  operationKey: text("operation_key").notNull(),
  definitionId: text("definition_id").notNull(),
  definitionVersion: integer("definition_version").notNull(),
  actionId: text("action_id").notNull(),
  domainVersion: integer("domain_version").notNull(),
  generation: integer("generation").notNull(),
  outcome: text("outcome").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.organizationId, t.caseId, t.operationKey] }),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [caseFlowBindings.organizationId, caseFlowBindings.caseId] }).onDelete("cascade"),
  foreignKey({ columns: [t.definitionId, t.definitionVersion], foreignColumns: [caseFlowDefinitions.id, caseFlowDefinitions.version] }),
  index("case_flow_transition_history").on(t.organizationId, t.caseId, t.createdAt),
  check("case_flow_transition_outcome", sql`${t.outcome} in ('validated', 'recorded', 'held')`),
]);
export const insertCaseFlowDefinitionSchema = createInsertSchema(caseFlowDefinitions);
export const insertCaseFlowBindingSchema = createInsertSchema(caseFlowBindings);
export const insertCaseFlowTransitionSchema = createInsertSchema(caseFlowTransitions);
