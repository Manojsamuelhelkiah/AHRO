import { jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export type PricingSheetInputs = {
  clientsInCohort: number;
  annualTransactions: number;
  channels: number;
  integrations: number;
  agents: number;
  workflows: number;
  tenantTier: "pooled" | "siloed" | "dedicated";
  securityTier: "standard" | "regulated" | "enterprise";
  tokenProfile: "light" | "balanced" | "rich";
  infrastructureTier: "starter" | "production" | "critical";
  supportTier: "essential" | "premium" | "managed";
  grossMarginPct: number;
  buildAmortizationYears: number;
};

export type PricingRecommendation = {
  recommendedMonthlySubscription: number;
  recommendedAnnualCommitment: number;
  recommendedTransactionPrice: number;
  recommendedOveragePrice: number;
  recommendedImplementationFee: number;
  includedAnnualTransactions: number;
};

export const pricingSheetsTable = pgTable("pricing_sheets", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: text("name").notNull(),
  inputs: jsonb("inputs").$type<PricingSheetInputs>().notNull(),
  recommendation: jsonb("recommendation")
    .$type<PricingRecommendation>()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPricingSheetSchema = createInsertSchema(pricingSheetsTable).omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPricingSheet = z.infer<typeof insertPricingSheetSchema>;
export type PricingSheetRow = typeof pricingSheetsTable.$inferSelect;