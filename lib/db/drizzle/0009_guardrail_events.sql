CREATE TABLE IF NOT EXISTS "onb_guardrail_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "case_id" integer REFERENCES "onb_cases"("id") ON DELETE cascade,
  "guardrail_key" text NOT NULL,
  "action" text NOT NULL,
  "detail" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "onb_guardrail_events_key_idx" ON "onb_guardrail_events" ("guardrail_key");
