CREATE TABLE IF NOT EXISTS "onb_effect_journal" (
  "logical_operation_key" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "case_id" integer,
  "tool_name" text NOT NULL,
  "arguments_hash" text NOT NULL,
  "provider_idempotency" boolean NOT NULL,
  "status" text DEFAULT 'ready' NOT NULL,
  "fencing_token" integer DEFAULT 0 NOT NULL,
  "claim_owner" text,
  "claim_until" timestamp with time zone,
  "dispatch_started_at" timestamp with time zone,
  "external_effect_id" text,
  "last_error" text,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_effect_journal_status_check"
    CHECK ("status" in ('ready', 'dispatching', 'confirmed', 'unknown_effect_manual_repair', 'failed')),
  CONSTRAINT "onb_effect_journal_fencing_token_check"
    CHECK ("fencing_token" >= 0),
  CONSTRAINT "onb_effect_journal_case_id_onb_cases_id_fk"
    FOREIGN KEY ("case_id") REFERENCES "public"."onb_cases"("id")
    ON DELETE set null ON UPDATE no action
);