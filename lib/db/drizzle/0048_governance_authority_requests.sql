ALTER TABLE "onb_governance_authority_assignments"
  ADD COLUMN IF NOT EXISTS "verification_status" text NOT NULL DEFAULT 'verified';