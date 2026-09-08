ALTER TABLE "onb_cases"
  ADD COLUMN IF NOT EXISTS "candidate_email_authorized_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "candidate_email_authorized_by" text;
--> statement-breakpoint
ALTER TABLE "onb_communications"
  ADD COLUMN IF NOT EXISTS "audience" text DEFAULT 'candidate' NOT NULL,
  ADD COLUMN IF NOT EXISTS "retried_by" text,
  ADD COLUMN IF NOT EXISTS "retried_at" timestamp with time zone;