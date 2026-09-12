ALTER TABLE "onb_probation_decisions"
  ADD COLUMN IF NOT EXISTS "anchor_revision" integer NOT NULL DEFAULT 0;