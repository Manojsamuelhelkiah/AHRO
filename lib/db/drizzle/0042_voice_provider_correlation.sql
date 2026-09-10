ALTER TABLE "onb_voice_sessions"
  ADD COLUMN IF NOT EXISTS "local_call_id" text;
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions"
  ADD COLUMN IF NOT EXISTS "run_id" text;
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions"
  ADD COLUMN IF NOT EXISTS "request_id" text;
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions"
  ADD COLUMN IF NOT EXISTS "provider_status" text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions"
  ADD COLUMN IF NOT EXISTS "provider_failure_reason" text;