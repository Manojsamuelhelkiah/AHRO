ALTER TABLE "onb_early_tenure_assignments"
  ADD COLUMN IF NOT EXISTS "anchor_revision" integer;
--> statement-breakpoint
ALTER TABLE "onb_early_tenure_checkins"
  ADD COLUMN IF NOT EXISTS "anchor_revision" integer;