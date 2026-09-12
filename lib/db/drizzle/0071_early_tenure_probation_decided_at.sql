ALTER TABLE "onb_probation_decisions"
  ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone NOT NULL DEFAULT now();