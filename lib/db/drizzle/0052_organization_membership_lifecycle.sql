ALTER TABLE "organization_memberships"
  ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_memberships_active_user_idx"
  ON "organization_memberships" ("clerk_user_id")
  WHERE "revoked_at" IS NULL;