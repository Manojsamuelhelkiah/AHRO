import { pgTable, serial, text, integer, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { createInsertSchema } from "drizzle-zod";
import type { HumanPermissionDecision } from "./human-permission";

/** Append-only decision evidence. Never an assignment, registry, or access grant. */
export const humanPermissionDecisions = pgTable("human_permission_decisions", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").notNull(),
  reviewedRevision: integer("reviewed_revision").notNull(),
  authorization: jsonb("authorization").$type<HumanPermissionDecision>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("human_permission_decisions_org_id_idx").on(t.organizationId, t.id),
  check("human_permission_decisions_revision_check", sql`${t.reviewedRevision} >= 0`),
]);
export const insertHumanPermissionDecisionSchema = createInsertSchema(humanPermissionDecisions).omit({ id: true, createdAt: true });
export type HumanPermissionDecisionRecord = typeof humanPermissionDecisions.$inferSelect;
