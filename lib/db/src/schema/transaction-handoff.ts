import { foreignKey, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { onbCases } from "./onboarding";

/** Confidential, deletable business annotations. Never execution metadata or authority. */
export const transactionHandoffRevisions = pgTable("transaction_handoff_revisions", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  caseId: integer("case_id").notNull(),
  revision: integer("revision").notNull(),
  kind: text("kind").$type<"question" | "next-work" | "explanation">().notNull(),
  body: text("body").notNull(),
  authorUserId: text("author_user_id").notNull(),
  sourceRevision: text("source_revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id] }).onDelete("cascade"),
  uniqueIndex("transaction_handoff_revision_unique").on(t.organizationId, t.caseId, t.kind, t.revision),
  index("transaction_handoff_lifecycle_idx").on(t.organizationId, t.caseId, t.createdAt),
]);
