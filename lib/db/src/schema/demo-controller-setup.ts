import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";

/**
 * Archival setup and membership-change evidence only. No runtime router
 * returns or accepts approval values, and these records grant no new authority.
 * Retain the schema under tenant retention/hold rules; do not auto-drop it.
 */
export const demoControllerSetupRequestsTable = pgTable(
  "demo_controller_setup_requests",
  {
    requestId: text("request_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, {
        onDelete: "no action",
      }),
    targetClerkUserId: text("target_clerk_user_id").notNull(),
    approvalValue: text("approval_value").notNull(),
    approvalFingerprint: text("approval_fingerprint").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalSource: text("approval_source"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    membershipBefore: text("membership_before").notNull(),
    membershipAfter: text("membership_after"),
  },
  (table) => [
    check(
      "demo_controller_setup_requests_source_check",
      sql`${table.approvalSource} IS NULL OR ${table.approvalSource} = 'deployment-operator'`,
    ),
    check(
      "demo_controller_setup_requests_membership_before_check",
      sql`${table.membershipBefore} = 'member'`,
    ),
    check(
      "demo_controller_setup_requests_membership_after_check",
      sql`${table.membershipAfter} IS NULL OR ${table.membershipAfter} = 'admin'`,
    ),
    check(
      "demo_controller_setup_requests_approval_fields_check",
      sql`(
        (${table.approvedAt} IS NULL AND ${table.approvalSource} IS NULL AND ${table.completedAt} IS NULL AND ${table.membershipAfter} IS NULL)
        OR
        (${table.approvedAt} IS NOT NULL AND ${table.approvalSource} = 'deployment-operator' AND ${table.completedAt} IS NOT NULL AND ${table.membershipAfter} = 'admin')
      )`,
    ),
    index("demo_controller_setup_target_idx").on(
      table.organizationId,
      table.targetClerkUserId,
      table.requestedAt,
    ),
    index("demo_controller_setup_org_completed_idx").on(
      table.organizationId,
      table.completedAt,
    ),
    uniqueIndex("demo_controller_setup_one_grant_per_demo_idx")
      .on(table.organizationId)
      .where(sql`${table.completedAt} IS NOT NULL`),
  ],
);

export type DemoControllerSetupRequestRow =
  typeof demoControllerSetupRequestsTable.$inferSelect;
