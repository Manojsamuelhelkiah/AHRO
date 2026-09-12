CREATE TABLE IF NOT EXISTS "onb_standard_provider_configs" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "provider_key" text NOT NULL,
  "source_of_truth" text NOT NULL,
  "configuration_state" text NOT NULL DEFAULT 'not-configured',
  "field_mappings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sandbox_evidence_reference" text,
  "sandbox_validated_at" timestamp with time zone,
  "operator_approval_reference" text,
  "operator_approved_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_standard_provider_configs_pk" PRIMARY KEY ("organization_id","provider_key"),
  CONSTRAINT "onb_standard_provider_config_state_check" CHECK ("configuration_state" in ('not-configured','mapping-configured','sandbox-validated','operator-approved')),
  CONSTRAINT "onb_standard_provider_config_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_standard_provider_source_records" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer,
  "provider_key" text NOT NULL,
  "source_record_type" text NOT NULL,
  "source_record_id" text NOT NULL,
  "normalized_state" text NOT NULL,
  "source_observed_at" timestamp with time zone NOT NULL,
  "evidence_reference" text NOT NULL,
  "evidence_class" text NOT NULL DEFAULT 'operator-recorded-source-observation',
  "field_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "recorded_by" text NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_standard_provider_source_record_unique" UNIQUE ("organization_id","provider_key","source_record_type","source_record_id"),
  CONSTRAINT "onb_standard_provider_source_case_fk"
    FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_standard_provider_source_case_idx"
  ON "onb_standard_provider_source_records" ("organization_id","case_id","recorded_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_standard_provider_decisions" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "provider_key" text NOT NULL,
  "decision_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "accountable_role" text NOT NULL,
  "requirement" text NOT NULL,
  "detail" text NOT NULL,
  "documentation_urls" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  CONSTRAINT "onb_standard_provider_decision_unique" UNIQUE ("organization_id","provider_key","decision_key"),
  CONSTRAINT "onb_standard_provider_decision_status_check" CHECK ("status" in ('open','accepted','deferred'))
);