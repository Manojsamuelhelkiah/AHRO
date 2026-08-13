CREATE TABLE IF NOT EXISTS "onb_voice_sessions" (
"token" text PRIMARY KEY NOT NULL,
"case_id" integer NOT NULL,
"scenario" text NOT NULL,
"reason" text,
"call_sid" text,
"turns" jsonb DEFAULT '[]'::jsonb NOT NULL,
"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
"finalized" boolean DEFAULT false NOT NULL,
"finalize_lease_at" timestamp with time zone,
"finalize_owner" text,
"outcome_progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
"last_speech" text,
"last_response" jsonb,
"started_at" timestamp with time zone DEFAULT now() NOT NULL,
"finalized_at" timestamp with time zone,
CONSTRAINT "onb_voice_sessions_call_sid_unique" UNIQUE("call_sid")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onb_voice_sessions" ADD CONSTRAINT "onb_voice_sessions_case_id_onb_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."onb_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
