ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "offer_acceptance_complete" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "offer_acceptance_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "offer_acceptance_completed_by" text;