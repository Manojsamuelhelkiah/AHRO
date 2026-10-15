import { boolean, check, foreignKey, integer, pgTable, primaryKey, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { onbCases } from "./onboarding";
import { organizationsTable } from "./organizations";

/** Cases-list presentation only. Never consulted by operational/reporting readers. */
export const caseListVisibility = pgTable("demo_case_list_visibility", {
  organizationId: text("organization_id").notNull(),
  caseId: integer("case_id").notNull(),
  hidden: boolean("hidden").notNull().default(false),
  version: integer("version").notNull().default(1),
}, t => [
  primaryKey({ columns: [t.organizationId, t.caseId] }),
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
  check("demo_case_list_visibility_demo_only", sql`${t.organizationId} = 'demo'`),
  check("demo_case_list_visibility_version_positive", sql`${t.version} > 0`),
]);

/** Metadata-only append trail; no worker names, addresses or case content. */
export const caseListVisibilityChanges = pgTable("demo_case_list_visibility_changes", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  hidden: boolean("hidden").notNull(),
  version: integer("version").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("demo_case_list_visibility_changes_demo_only", sql`${t.organizationId} = 'demo'`),
]);
