import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Opaque browser capabilities; raw cookie values are never persisted. */
export const uatAdmissionsTable = pgTable("uat_admissions", {
  tokenHash: text("token_hash").primaryKey(),
  kind: text("kind").notNull(),
  userId: text("user_id"),
  sessionId: text("session_id"),
  organizationId: text("organization_id"),
  requestKey: text("request_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [index("uat_admission_attempt_idx").on(table.requestKey, table.createdAt)]);
