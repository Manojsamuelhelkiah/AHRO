import { date, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Immutable versioned pricing rate register. Each row is a snapshot of all
 * quote-critical rates. New versions are appended only; rows are never mutated.
 * The "current" version is the latest effectiveDate <= today, then highest id.
 * Future-dated rows are scheduled (not yet current).
 */
export const pricingRateSetsTable = pgTable("pricing_rate_sets", {
  /** Version sequence — highest id among effectiveDate <= today is current. */
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .default("demo"),
  /** Calendar date string YYYY-MM-DD: the date from which this rate set is in effect. */
  effectiveDate: date("effective_date", { mode: "string" }).notNull(),
  /** Mandatory human-readable rationale for this version. */
  rationale: text("rationale").notNull(),
  /** Full rate snapshot as JSONB. */
  rates: jsonb("rates").notNull(),
  /** Clerk display name of the author resolved at write time. */
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPricingRateSetSchema = createInsertSchema(pricingRateSetsTable).omit({
  id: true,
  organizationId: true,
  createdAt: true,
});
export type InsertPricingRateSet = z.infer<typeof insertPricingRateSetSchema>;
export type PricingRateSetRow = typeof pricingRateSetsTable.$inferSelect;
