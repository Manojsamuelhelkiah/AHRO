import { pgTable, serial, text, integer, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Versioned SME adjustments to an intent's flow. Each save is a new version;
 * the latest APPROVED version per intent is applied to roll-ups. The reference
 * corpus is never mutated.
 */
export const flowOverridesTable = pgTable("flow_overrides", {
  id: serial("id").primaryKey(),
  intentKey: text("intent_key").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull().default("draft"), // draft | approved
  author: text("author").notNull(),
  rationale: text("rationale").notNull(),
  flowClass: text("flow_class"),
  toBeHumanMin: real("to_be_human_min"),
  actGetActions: integer("act_get_actions"),
  actPutActions: integer("act_put_actions"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertFlowOverrideSchema = createInsertSchema(flowOverridesTable).omit({
  id: true,
  version: true,
  status: true,
  createdAt: true,
});
export type InsertFlowOverride = z.infer<typeof insertFlowOverrideSchema>;
export type FlowOverrideRow = typeof flowOverridesTable.$inferSelect;
