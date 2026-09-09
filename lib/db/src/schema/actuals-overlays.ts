import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Persisted calibration actuals overlays. Each overlay contains measured
 * production data (token counts, containment rates, HITL minutes) that the
 * roll-up engine applies to replace corresponding assumption defaults.
 * Multiple overlays can coexist; individual roll-up requests reference one by id.
 */
export const actualsOverlaysTable = pgTable("actuals_overlays", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .default("demo"),
  /** Human-readable label, e.g. "Acme Q1 2025 production logs". */
  clientLabel: text("client_label"),
  /** ISO date string for the start of the observed period. */
  periodStart: text("period_start"),
  /** ISO date string for the end of the observed period. */
  periodEnd: text("period_end"),
  /**
   * Full overlay payload (intents[], measuredContainmentByFlowClass,
   * measuredHitlSamplingRate, tokenActualsByRole).
   */
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ActualsOverlayRow = typeof actualsOverlaysTable.$inferSelect;
