ALTER TABLE "organization_memberships"
  ADD COLUMN IF NOT EXISTS "membership_revision" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "organization_memberships_membership_revision_check"
  CHECK ("membership_revision" >= 0);