import { pgTable, text, integer, jsonb, timestamp, uniqueIndex, index, check, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { onbCases } from "./onboarding";
import { organizationsTable } from "./organizations";

export type SeparationFacts = {
  employeeId: string; workerName: string; exitType: string; exitReason: string;
  lastWorkingDay: string; terminationDate: string; timeZone: string; role: string;
  department: string; country: string; legalEntity: string; workerCategory: string; manager: string;
};
export type SeparationReceipt = {
  actor: string; authorityId: string; authorityRevision: number; scope: string;
  reference: string; generation: number; recordedAt: string; provenance: "human-source-attested";
};
export type SeparationTask = {
  id: string; activity: string; label: string; stream: string; scope: string; owner: string | null;
  prerequisites: string[]; dueAt: string | null; notBeforeAt: string | null;
  status: "pending" | "blocked" | "uncertain" | "verified";
  evidence: SeparationReceipt | null; details: Record<string, string | boolean | number>;
};
export type SeparationState = {
  gatewayA: "pending" | "clear" | "restricted"; classification: string | null;
  urgency: "Standard" | "Elevated" | "High" | null;
  flags: { privileged: boolean; highRisk: boolean; clientFacing: boolean; peopleManager: boolean; statutory: boolean } | null;
  sensitiveTriggers: string[]; conflict: boolean; hrBpDisposition: SeparationReceipt | null;
  screening: SeparationReceipt | null; policyId: string | null; policyVersion: number | null;
  classificationReceipt?: SeparationReceipt | null;
  restrictedManual?: boolean;
  policyReceipt: SeparationReceipt | null; tasks: SeparationTask[]; decisions: SeparationReceipt[];
  holds: string[]; settlementVersions: Array<{ revision: number; currency: string; items: Record<string, number>; calculationReference: string; rulesReference: string; receipt: SeparationReceipt }>;
  pauseReason: string | null; closureBlocker: "section-4.6-pending";
};
export type SeparationPolicy = {
  country: string; role: string; workerCategory: string; timeZone: string; endOfLwd: string;
  rulesReference: string; retentionReference: string;
  obligations: Array<{ id: string; label: string; stream: string; scope: string; prerequisites: string[]; dueOffsetDays: number }>;
  defaultAssets: string[];
};
export const offbCases = pgTable("offb_cases", {
  id: integer("id").primaryKey().references(() => onbCases.id, { onDelete: "restrict" }),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  employeeId: text("employee_id").notNull(), version: integer("version").notNull().default(1),
  generation: integer("generation").notNull().default(1),
  status: text("status").notNull().default("held"), activeKey: text("active_key"),
  facts: jsonb("facts").$type<SeparationFacts>().notNull(),
  state: jsonb("state").$type<SeparationState>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("offb_one_active_employee").on(t.organizationId, t.activeKey),
  uniqueIndex("offb_case_tenant_unique").on(t.organizationId, t.id),
  foreignKey({ columns: [t.organizationId, t.id], foreignColumns: [onbCases.organizationId, onbCases.id], name: "offb_case_tenant_fk" }).onDelete("restrict"),
  index("offb_tenant_cases").on(t.organizationId, t.status),
  check("offb_finalization_unavailable", sql`${t.status} IN ('held','restricted','active','paused','cancelled','transfer-review','closure-preparation') AND ${t.state}->>'closureBlocker' = 'section-4.6-pending'`),
  check("offb_active_key_required", sql`(${t.status} IN ('cancelled','transfer-review') AND ${t.activeKey} IS NULL) OR (${t.status} NOT IN ('cancelled','transfer-review') AND ${t.activeKey} = ${t.employeeId})`),
]);
export const offbSources = pgTable("offb_sources", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  caseId: integer("case_id").notNull().references(() => offbCases.id, { onDelete: "restrict" }),
  channel: text("channel").notNull(), sourceReference: text("source_reference").notNull(),
  fingerprint: text("fingerprint").notNull(), facts: jsonb("facts").$type<SeparationFacts>().notNull(),
  actor: text("actor").notNull(), provenance: text("provenance").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("offb_source_retry").on(t.organizationId, t.channel, t.sourceReference),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [offbCases.organizationId, offbCases.id], name: "offb_source_tenant_fk" }).onDelete("restrict")]);
export const offbPolicies = pgTable("offb_policies", {
  id: text("id").notNull(), organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  version: integer("version").notNull(), policy: jsonb("policy").$type<SeparationPolicy>().notNull(),
  status: text("status").notNull().default("proposal"), approval: jsonb("approval").$type<SeparationReceipt>(),
  createdBy: text("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("offb_policy_version").on(t.organizationId, t.id, t.version)]);
/** Common reviewed HRO mailbox boundary; no second provider poller. */
export const hroMailboxIngress = pgTable("hro_mailbox_ingress", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  token: text("token").notNull(), allowedSenders: jsonb("allowed_senders").$type<string[]>().notNull(),
  approval: jsonb("approval").$type<SeparationReceipt>().notNull(),
  createdBy: text("created_by").notNull(), enabled: integer("enabled").notNull().default(1),
  mailboxAddress: text("mailbox_address"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  backfillFrom: timestamp("backfill_from", { withTimezone: true }),
  revision: integer("revision").notNull().default(1),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  replacementOfId: text("replacement_of_id"),
  rotationReference: text("rotation_reference"),
}, t => [uniqueIndex("hro_mailbox_token").on(t.token), uniqueIndex("hro_mailbox_ingress_tenant_unique").on(t.organizationId, t.id),
  uniqueIndex("hro_mailbox_one_replacement").on(t.replacementOfId),
  foreignKey({ columns: [t.organizationId, t.replacementOfId], foreignColumns: [t.organizationId, t.id], name: "hro_mailbox_replacement_tenant_fk" }).onDelete("restrict"),
]);
export const hroMailboxRequests = pgTable("hro_mailbox_requests", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  ingressId: text("ingress_id").notNull().references(() => hroMailboxIngress.id, { onDelete: "restrict" }),
  providerMessageId: text("provider_message_id").notNull(), sender: text("sender").notNull(),
  fields: jsonb("fields").$type<Record<string, string>>().notNull(),
  attachments: jsonb("attachments").$type<Array<{ name: string; status: "quarantined-not-imported" }>>().notNull().default([]),
  status: text("status").notNull().default("pending-review"),
  caseId: integer("case_id").references(() => offbCases.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("hro_mailbox_message_once").on(t.providerMessageId),
  foreignKey({ columns: [t.organizationId, t.ingressId], foreignColumns: [hroMailboxIngress.organizationId, hroMailboxIngress.id], name: "hro_mailbox_ingress_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [offbCases.organizationId, offbCases.id], name: "hro_mailbox_case_tenant_fk" }).onDelete("restrict")]);
export const insertSeparationSchema = createInsertSchema(offbCases);
export type SeparationCase = typeof offbCases.$inferSelect;
/** Private immutable checkpoints; reviews never erase prior execution evidence. */
export const offbCheckpoints = pgTable("offb_checkpoints", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  caseId: integer("case_id").notNull(), version: integer("version").notNull(), generation: integer("generation").notNull(),
  status: text("status").notNull(), facts: jsonb("facts").$type<SeparationFacts>().notNull(),
  state: jsonb("state").$type<SeparationState>().notNull(), actor: text("actor").notNull(), action: text("action").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("offb_checkpoint_once").on(t.organizationId, t.caseId, t.version),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [offbCases.organizationId, offbCases.id], name: "offb_checkpoint_tenant_fk" }).onDelete("restrict")]);
