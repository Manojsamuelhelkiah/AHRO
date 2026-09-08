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
  /** Versioned routing-contract metadata; JSON fields are encoded as text. */
  registryVersion: text("registry_version").notNull().default("research-v1"),
  parentIntentKey: text("parent_intent_key"),
  exactAliases: text("exact_aliases").notNull().default("[]"),
  accountableSpecialist: text("accountable_specialist").notNull().default("HRO Service Owner"),
  riskClass: text("risk_class").notNull().default("medium"),
  actionSchema: text("action_schema").notNull().default('{"actions":[{"type":"intake","name":"capture-client-request","description":"Capture the approved client-specific request for specialist triage.","inputSchema":{"type":"object","required":["requestId","subjectId"]},"executorKey":null}]}'),
  evidenceContract: text("evidence_contract").notNull().default('{"required":["request","actor","recordedAt"]}'),
  /** catalogued | simulated | integrated | verified | unsupported */
  maturity: text("maturity").notNull().default("catalogued"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CustomIntentRow = typeof customIntentsTable.$inferSelect;

/**
 * Atomic reservation for custom canonical keys and exact aliases. Keeping labels
 * relational prevents concurrent custom-intent writes from creating ambiguous
 * aliases while the JSON field remains the versioned contract payload.
 */
export const customIntentRoutingLabelsTable = pgTable("custom_intent_routing_labels", {
  label: text("label").primaryKey(),
  customIntentId: integer("custom_intent_id")
    .notNull()
    .references(() => customIntentsTable.id, { onDelete: "cascade" }),
  registryVersion: text("registry_version").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
