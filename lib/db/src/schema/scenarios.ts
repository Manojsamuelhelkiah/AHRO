import { index, integer, pgTable, serial, text, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const scenariosTable = pgTable("scenarios", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  ownerUserId: text("owner_user_id"),
  name: text("name").notNull(),
  inputs: jsonb("inputs").notNull(),
  setupData: jsonb("setup_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const scenarioFilesTable = pgTable(
  "scenario_files",
  {
    id: serial("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    scenarioId: integer("scenario_id").references(() => scenariosTable.id, {
      onDelete: "cascade",
    }),
    objectPath: text("object_path").notNull().unique(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("scenario_files_owner_scenario_idx").on(table.ownerUserId, table.scenarioId),
  ],
);

export const scenarioUploadIntentsTable = pgTable(
  "scenario_upload_intents",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    objectPath: text("object_path").notNull().unique(),
    finalObjectPath: text("final_object_path").unique(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processingAt: timestamp("processing_at", { withTimezone: true }),
    cleaningAt: timestamp("cleaning_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => [
    index("scenario_upload_intents_owner_status_idx").on(table.ownerUserId, table.status),
    index("scenario_upload_intents_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const objectCleanupJobsTable = pgTable(
  "object_cleanup_jobs",
  {
    id: serial("id").primaryKey(),
    objectPath: text("object_path").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("object_cleanup_jobs_created_idx").on(table.createdAt)],
);

export const insertScenarioSchema = createInsertSchema(scenariosTable).omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertScenario = z.infer<typeof insertScenarioSchema>;
export type ScenarioRow = typeof scenariosTable.$inferSelect;
export type ScenarioFileRow = typeof scenarioFilesTable.$inferSelect;
