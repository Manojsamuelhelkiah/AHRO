ALTER TABLE "onb_events" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onb_events" ADD CONSTRAINT "onb_events_idempotency_key_unique" UNIQUE("idempotency_key");
EXCEPTION
 WHEN duplicate_table THEN null;
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onb_approvals" ADD CONSTRAINT "onb_approvals_idempotency_key_unique" UNIQUE("idempotency_key");
EXCEPTION
 WHEN duplicate_table THEN null;
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "onb_call_slots" ADD COLUMN IF NOT EXISTS "dedupe_key" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onb_call_slots" ADD CONSTRAINT "onb_call_slots_dedupe_key_unique" UNIQUE("dedupe_key");
EXCEPTION
 WHEN duplicate_table THEN null;
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_voice_sessions_live_case_idx" ON "onb_voice_sessions" ("case_id") WHERE "finalized" = false;
