ALTER TABLE "onb_early_tenure_checkins"
  ADD COLUMN IF NOT EXISTS "reminder_lead_days" integer NOT NULL DEFAULT 0;