import {
  check,
  integer,
  index,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Application-level tenants. Replit-managed Clerk authenticates people but
 * does not provide Clerk Organizations, so tenancy is deliberately owned here.
 */
export const organizationsTable = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  primaryCountry: text("primary_country").notNull().default("IN"),
  joinCodeHash: text("join_code_hash").notNull().unique(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembershipsTable = pgTable(
  "organization_memberships",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    role: text("role").$type<"owner" | "admin" | "member">().notNull().default("member"),
    /**
     * Revocation is a tombstone rather than a delete so an old membership can
     * never be resurrected by a join-code retry.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * Monotonic lifecycle generation used as the durable compare-and-set
     * version for removal and reinstatement. Timestamp values are display
     * data only and are not unique enough to fence rapid lifecycle cycles.
     */
    membershipRevision: integer("membership_revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("organization_memberships_org_user_unique").on(
      table.organizationId,
      table.clerkUserId,
    ),
    index("organization_memberships_user_idx").on(table.clerkUserId),
    check(
      "organization_memberships_membership_revision_check",
      sql`${table.membershipRevision} >= 0`,
    ),
  ],
);

export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type OrganizationRow = typeof organizationsTable.$inferSelect;
export type OrganizationMembershipRow =
  typeof organizationMembershipsTable.$inferSelect;

/** Stable owner for historical/demo rows and intentionally shared demos. */
export const DEMO_ORGANIZATION_ID = "demo";