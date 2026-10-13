import { pgTable, text, integer, jsonb, timestamp, uniqueIndex, index, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { hroMailboxIngress } from "./offboarding";
import { onbCases } from "./onboarding";

/** Provider references only for raw content; unknown attribution never retains employee facts. */
export const hroEmailRequests = pgTable("hro_email_requests", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizationsTable.id, { onDelete: "restrict" }),
  ingressId: text("ingress_id").references(() => hroMailboxIngress.id, { onDelete: "restrict" }),
  routeRevision: integer("route_revision"),
  originalIngressId: text("original_ingress_id"),
  originalRouteRevision: integer("original_route_revision"),
  routingAdmissions: jsonb("routing_admissions").$type<Array<{
    fromId: string; fromRevision: number; toId: string; toRevision: number;
    requestVersion: number; actor: string; reference: string; admittedAt: string;
  }>>().notNull().default([]),
  mailboxAddress: text("mailbox_address").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  templateId: text("template_id"),
  fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
  fieldSources: jsonb("field_sources").$type<Record<string, "email" | "reviewer">>().notNull().default({}),
  attachments: jsonb("attachments").$type<Array<{ name: string; status: string }>>().notNull().default([]),
  status: text("status").notNull().default("received"),
  reason: text("reason"),
  version: integer("version").notNull().default(1),
  caseId: integer("case_id").references(() => onbCases.id, { onDelete: "restrict" }),
  caseKind: text("case_kind"),
  reviewedBy: text("reviewed_by"),
  /** Recorded intake receipt, not the provider's mailbox receipt. Never reset on review or attribution. */
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("hro_email_provider_once").on(t.mailboxAddress, t.providerMessageId),
  uniqueIndex("hro_email_case_once").on(t.organizationId, t.caseId),
  index("hro_email_tenant_queue").on(t.organizationId, t.createdAt, t.id),
  foreignKey({ columns: [t.organizationId, t.ingressId], foreignColumns: [hroMailboxIngress.organizationId, hroMailboxIngress.id], name: "hro_email_route_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.originalIngressId], foreignColumns: [hroMailboxIngress.organizationId, hroMailboxIngress.id], name: "hro_email_original_route_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "hro_email_case_tenant_fk" }).onDelete("restrict"),
  check("hro_email_attribution", sql`(${t.organizationId} is null and ${t.ingressId} is null and ${t.fields} = '{}'::jsonb) or (${t.organizationId} is not null and ${t.ingressId} is not null)`),
]);
/** A page is advanced only after every message in it is durably owned or excluded. */
export const hroEmailScan = pgTable("hro_email_scan", {
  mailboxAddress: text("mailbox_address").primaryKey(),
  query: text("query").notNull(),
  pageToken: text("page_token"),
  cycleUntil: timestamp("cycle_until", { withTimezone: true }).notNull(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  processed: integer("processed").notNull().default(0),
  watermarkAt: timestamp("watermark_at", { withTimezone: true }),
  routesRevision: text("routes_revision"),
});
export const hroEmailSources = pgTable("hro_email_sources", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().references(() => hroEmailRequests.id, { onDelete: "restrict" }),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  objectPath: text("object_path").notNull(),
  state: text("state").notNull().default("reserved"),
  checksum: text("checksum"),
  byteSize: integer("byte_size"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("hro_email_source_path").on(t.objectPath), uniqueIndex("hro_email_source_once").on(t.requestId, t.kind)]);
