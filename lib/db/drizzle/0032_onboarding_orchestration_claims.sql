ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "orchestration_claim_owner" text;
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "orchestration_claim_token" integer DEFAULT 0 NOT NULL;
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "orchestration_claim_until" timestamp with time zone;