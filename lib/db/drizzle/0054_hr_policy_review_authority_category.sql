ALTER TABLE "onb_hr_policy_versions"
  ADD COLUMN IF NOT EXISTS "review_authority_role" text NOT NULL DEFAULT 'hr-compliance';