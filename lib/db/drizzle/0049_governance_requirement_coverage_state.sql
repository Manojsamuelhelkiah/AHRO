ALTER TABLE "onb_governance_requirements"
  ADD COLUMN IF NOT EXISTS "coverage_state" text NOT NULL DEFAULT 'gap';