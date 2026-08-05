import { pgTable, serial, text, integer, real, timestamp } from "drizzle-orm/pg-core";

/**
 * Client-specific intents that extend the fixed 60-intent reference corpus.
 * Active custom intents participate in roll-ups (shares, cost, benefit) exactly
 * like reference intents. Retired intents are excluded from roll-ups but their
 * flow-override history is preserved.
 */
export const customIntentsTable = pgTable("custom_intents", {
  id: serial("id").primaryKey(),
  /** URL-safe slug, unique across both custom_intents and the reference corpus. */
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  flowClass: text("flow_class").notNull(),
  description: text("description").notNull(),
  asIsHandlingMin: real("as_is_handling_min").notNull(),
  toBeHumanMin: real("to_be_human_min").notNull(),
  baseWeight: real("base_weight").notNull(),
  actGetActions: integer("act_get_actions").notNull(),
  actPutActions: integer("act_put_actions").notNull(),
  systemsTouchedBase: integer("systems_touched_base").notNull().default(2),
  /** JSON-encoded string[]. Stored as text; always defaults to ["custom"]. */
  tags: text("tags").notNull().default('["custom"]'),
  /** Free-text rationale / provenance. */
  source: text("source").notNull(),
  author: text("author").notNull(),
  /** active | retired */
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CustomIntentRow = typeof customIntentsTable.$inferSelect;
