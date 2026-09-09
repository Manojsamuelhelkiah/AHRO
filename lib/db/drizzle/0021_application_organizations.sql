CREATE TABLE IF NOT EXISTS "organizations" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "join_code_hash" text NOT NULL UNIQUE,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_memberships" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "clerk_user_id" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_memberships_org_user_unique"
    UNIQUE ("organization_id", "clerk_user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_memberships_user_idx"
  ON "organization_memberships" ("clerk_user_id");
--> statement-breakpoint

-- Explicit tenant for all historical data and public demo flows.
INSERT INTO "organizations"
  ("id", "name", "slug", "join_code_hash", "created_by_user_id")
VALUES
  ('demo', 'Demo Organization', 'demo',
   '4ff006ca6b88e752f08cb7881714505ceb3d2079eea432acfda8e158e0d1d82e',
   'system')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "custom_intents" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "actuals_overlays" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "flow_overrides" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_events" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_communications" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_system_checks" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_settings" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_connectors" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_documents" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_call_slots" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_employee_records" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "pricing_rate_sets" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "pricing_sheets" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "ea_assessments" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'demo' NOT NULL REFERENCES "organizations"("id");
--> statement-breakpoint

-- Child rows inherit the organization of their owning aggregate. Rows without
-- an owning client aggregate were global historical telemetry and stay demo.
UPDATE "onb_events" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "onb_approvals" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "onb_communications" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "onb_system_checks" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "onb_documents" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "onb_call_slots" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "onb_voice_sessions" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "onb_watch_emails" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "onb_watch_emails" child SET "organization_id" = parent."organization_id"
  FROM "onb_system_checks" check_row
  JOIN "onb_cases" parent ON parent."id" = check_row."case_id"
  WHERE child."case_id" IS NULL AND child."check_id" = check_row."id";
--> statement-breakpoint
UPDATE "onb_guardrail_events" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "onb_effect_journal" child SET "organization_id" = parent."organization_id"
  FROM "onb_cases" parent WHERE child."case_id" = parent."id";
--> statement-breakpoint
UPDATE "custom_intent_routing_labels" child SET "organization_id" = parent."organization_id"
  FROM "custom_intents" parent WHERE child."custom_intent_id" = parent."id";
--> statement-breakpoint

-- Defaults were only a transitional backfill mechanism. Tenant identity must
-- always be supplied by the authenticated caller or an explicit demo seed.
ALTER TABLE "scenarios" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "custom_intents" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "actuals_overlays" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "flow_overrides" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_cases" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_events" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_approvals" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_communications" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_system_checks" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_settings" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_connectors" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_documents" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_call_slots" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_employee_records" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "pricing_rate_sets" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "pricing_sheets" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "ea_assessments" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint

-- Natural keys are tenant-local. Leaving these global makes an unrelated
-- tenant's data observable through conflicts and prevents legitimate reuse.
ALTER TABLE "custom_intents" DROP CONSTRAINT IF EXISTS "custom_intents_key_unique";
--> statement-breakpoint
ALTER TABLE "custom_intents" ADD CONSTRAINT "custom_intents_organization_key_unique"
  UNIQUE ("organization_id", "key");
--> statement-breakpoint
ALTER TABLE "custom_intents" ADD CONSTRAINT "custom_intents_organization_id_id_unique"
  UNIQUE ("organization_id", "id");
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" DROP CONSTRAINT IF EXISTS "custom_intent_routing_labels_pkey";
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" ADD CONSTRAINT "custom_intent_routing_labels_pkey"
  PRIMARY KEY ("organization_id", "label");
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" DROP CONSTRAINT IF EXISTS "custom_intent_routing_labels_custom_intent_id_fkey";
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" DROP CONSTRAINT IF EXISTS "custom_intent_routing_labels_custom_intent_id_custom_intents_id_fk";
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" ADD CONSTRAINT "custom_intent_routing_labels_organization_custom_intent_fk"
  FOREIGN KEY ("organization_id", "custom_intent_id")
  REFERENCES "custom_intents" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "flow_overrides" ADD CONSTRAINT "flow_overrides_organization_intent_version_unique"
  UNIQUE ("organization_id", "intent_key", "version");
--> statement-breakpoint

ALTER TABLE "onb_settings" DROP CONSTRAINT IF EXISTS "onb_settings_pkey";
--> statement-breakpoint
ALTER TABLE "onb_settings" ADD CONSTRAINT "onb_settings_pkey"
  PRIMARY KEY ("organization_id", "key");
--> statement-breakpoint
ALTER TABLE "onb_connectors" DROP CONSTRAINT IF EXISTS "onb_connectors_pkey";
--> statement-breakpoint
ALTER TABLE "onb_connectors" ADD CONSTRAINT "onb_connectors_pkey"
  PRIMARY KEY ("organization_id", "key");
--> statement-breakpoint

ALTER TABLE "onb_events" DROP CONSTRAINT IF EXISTS "onb_events_idempotency_key_unique";
--> statement-breakpoint
ALTER TABLE "onb_events" ADD CONSTRAINT "onb_events_organization_idempotency_key_unique"
  UNIQUE ("organization_id", "idempotency_key");
--> statement-breakpoint
ALTER TABLE "onb_approvals" DROP CONSTRAINT IF EXISTS "onb_approvals_idempotency_key_unique";
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD CONSTRAINT "onb_approvals_organization_idempotency_key_unique"
  UNIQUE ("organization_id", "idempotency_key");
--> statement-breakpoint
ALTER TABLE "onb_communications" DROP CONSTRAINT IF EXISTS "onb_communications_external_message_id_unique";
--> statement-breakpoint
ALTER TABLE "onb_communications" ADD CONSTRAINT "onb_communications_organization_external_message_id_unique"
  UNIQUE ("organization_id", "external_message_id");
--> statement-breakpoint
ALTER TABLE "onb_system_checks" DROP CONSTRAINT IF EXISTS "onb_system_checks_case_system";
--> statement-breakpoint
ALTER TABLE "onb_system_checks" ADD CONSTRAINT "onb_system_checks_organization_case_system_unique"
  UNIQUE ("organization_id", "case_id", "system");
--> statement-breakpoint
ALTER TABLE "onb_documents" DROP CONSTRAINT IF EXISTS "onb_documents_case_id_key_unique";
--> statement-breakpoint
ALTER TABLE "onb_documents" ADD CONSTRAINT "onb_documents_organization_case_key_unique"
  UNIQUE ("organization_id", "case_id", "key");
--> statement-breakpoint
ALTER TABLE "onb_call_slots" DROP CONSTRAINT IF EXISTS "onb_call_slots_dedupe_key_unique";
--> statement-breakpoint
ALTER TABLE "onb_call_slots" ADD CONSTRAINT "onb_call_slots_organization_dedupe_key_unique"
  UNIQUE ("organization_id", "dedupe_key");
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" DROP CONSTRAINT IF EXISTS "onb_effect_journal_pkey";
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" ADD CONSTRAINT "onb_effect_journal_pkey"
  PRIMARY KEY ("organization_id", "logical_operation_key");
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" DROP CONSTRAINT IF EXISTS "onb_voice_sessions_pkey";
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" ADD CONSTRAINT "onb_voice_sessions_pkey"
  PRIMARY KEY ("organization_id", "token");
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" DROP CONSTRAINT IF EXISTS "onb_voice_sessions_call_sid_unique";
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" ADD CONSTRAINT "onb_voice_sessions_organization_call_sid_unique"
  UNIQUE ("organization_id", "call_sid");
--> statement-breakpoint
DROP INDEX IF EXISTS "onb_voice_sessions_live_case_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_voice_sessions_organization_live_case_idx"
  ON "onb_voice_sessions" ("organization_id", "case_id") WHERE "finalized" = false;
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" DROP CONSTRAINT IF EXISTS "onb_watch_emails_gmail_message_id_unique";
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ADD CONSTRAINT "onb_watch_emails_organization_gmail_message_id_unique"
  UNIQUE ("organization_id", "gmail_message_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "onb_employee_records_stint_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_employee_records_organization_stint_idx"
  ON "onb_employee_records" ("organization_id", "worker_email", "start_date");
--> statement-breakpoint

-- A child may only point to an aggregate in its own tenant. The old single
-- column FKs allowed a forged/mistaken organization_id to cross tenant data.
ALTER TABLE "onb_cases" ADD CONSTRAINT "onb_cases_organization_id_id_unique"
  UNIQUE ("organization_id", "id");
--> statement-breakpoint
ALTER TABLE "onb_system_checks" ADD CONSTRAINT "onb_system_checks_organization_id_id_unique"
  UNIQUE ("organization_id", "id");
--> statement-breakpoint

ALTER TABLE "onb_events" DROP CONSTRAINT IF EXISTS "onb_events_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_events" ADD CONSTRAINT "onb_events_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_approvals" DROP CONSTRAINT IF EXISTS "onb_approvals_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD CONSTRAINT "onb_approvals_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_communications" DROP CONSTRAINT IF EXISTS "onb_communications_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_communications" ADD CONSTRAINT "onb_communications_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_system_checks" DROP CONSTRAINT IF EXISTS "onb_system_checks_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_system_checks" ADD CONSTRAINT "onb_system_checks_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_documents" DROP CONSTRAINT IF EXISTS "onb_documents_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_documents" ADD CONSTRAINT "onb_documents_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_call_slots" DROP CONSTRAINT IF EXISTS "onb_call_slots_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_call_slots" ADD CONSTRAINT "onb_call_slots_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" DROP CONSTRAINT IF EXISTS "onb_voice_sessions_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" ADD CONSTRAINT "onb_voice_sessions_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" DROP CONSTRAINT IF EXISTS "onb_watch_emails_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" DROP CONSTRAINT IF EXISTS "onb_watch_emails_check_id_onb_system_checks_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ADD CONSTRAINT "onb_watch_emails_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ADD CONSTRAINT "onb_watch_emails_organization_check_fk"
  FOREIGN KEY ("organization_id", "check_id") REFERENCES "onb_system_checks" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" DROP CONSTRAINT IF EXISTS "onb_effect_journal_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" ADD CONSTRAINT "onb_effect_journal_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE SET NULL ("case_id");
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" DROP CONSTRAINT IF EXISTS "onb_guardrail_events_case_id_onb_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" ADD CONSTRAINT "onb_guardrail_events_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "scenarios_organization_idx" ON "scenarios" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_intents_organization_idx" ON "custom_intents" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actuals_overlays_organization_idx" ON "actuals_overlays" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flow_overrides_organization_idx" ON "flow_overrides" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_cases_organization_idx" ON "onb_cases" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_events_organization_idx" ON "onb_events" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_approvals_organization_idx" ON "onb_approvals" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_communications_organization_idx" ON "onb_communications" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_system_checks_organization_idx" ON "onb_system_checks" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_effect_journal_organization_idx" ON "onb_effect_journal" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_documents_organization_idx" ON "onb_documents" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_call_slots_organization_idx" ON "onb_call_slots" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_voice_sessions_organization_idx" ON "onb_voice_sessions" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_watch_emails_organization_idx" ON "onb_watch_emails" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_guardrail_events_organization_idx" ON "onb_guardrail_events" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_intent_routing_labels_organization_idx" ON "custom_intent_routing_labels" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_system_checks_case_id_idx" ON "onb_system_checks" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_events_case_id_idx" ON "onb_events" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_approvals_case_id_idx" ON "onb_approvals" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_communications_case_id_idx" ON "onb_communications" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_effect_journal_case_id_idx" ON "onb_effect_journal" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_documents_case_id_idx" ON "onb_documents" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_call_slots_case_id_idx" ON "onb_call_slots" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_voice_sessions_case_id_idx" ON "onb_voice_sessions" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_watch_emails_check_id_idx" ON "onb_watch_emails" ("check_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_watch_emails_case_id_idx" ON "onb_watch_emails" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_guardrail_events_case_id_idx" ON "onb_guardrail_events" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_intent_routing_labels_custom_intent_id_idx" ON "custom_intent_routing_labels" ("custom_intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_rate_sets_organization_idx" ON "pricing_rate_sets" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_sheets_organization_idx" ON "pricing_sheets" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ea_assessments_organization_idx" ON "ea_assessments" ("organization_id");
