import {
  check,
  integer,
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type EaAssessmentStatus = "active" | "archived";
export type EaPhase =
  | "preliminary"
  | "architecture-vision"
  | "business"
  | "data"
  | "application"
  | "technology"
  | "opportunities-solutions"
  | "migration-planning"
  | "implementation-governance"
  | "architecture-change-management";

export type EaAssessmentContent = Record<string, unknown>;

export const eaAssessmentsTable = pgTable(
  "ea_assessments",
  {
    id: serial("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    clientName: text("client_name").notNull(),
    status: text("status").$type<EaAssessmentStatus>().notNull().default("active"),
    version: integer("version").notNull().default(1),
    currentPhase: text("current_phase").$type<EaPhase>().notNull(),
    content: jsonb("content").$type<EaAssessmentContent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("ea_assessments_owner_status_idx").on(table.ownerUserId, table.status),
    check("ea_assessments_status_check", sql`${table.status} in ('active', 'archived')`),
    check(
      "ea_assessments_phase_check",
      sql`${table.currentPhase} in ('preliminary', 'architecture-vision', 'business', 'data', 'application', 'technology', 'opportunities-solutions', 'migration-planning', 'implementation-governance', 'architecture-change-management')`,
    ),
  ],
);

export const insertEaAssessmentSchema = createInsertSchema(eaAssessmentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEaAssessment = z.infer<typeof insertEaAssessmentSchema>;
export type EaAssessmentRow = typeof eaAssessmentsTable.$inferSelect;