CREATE TABLE IF NOT EXISTS "onb_early_tenure_survey_responses" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "survey_kind" text NOT NULL,
  "voluntary" boolean NOT NULL,
  "score" integer NOT NULL,
  "submitted_at" timestamp with time zone NOT NULL,
  "provenance" text NOT NULL,
  "source_connector_key" text,
  "authority_assignment_id" text,
  "authority_assignment_revision" integer,
  "evidence_reference" text NOT NULL,
  "recorded_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_early_tenure_survey_kind_check" CHECK ("survey_kind" = 'onboarding-30-day'),
  CONSTRAINT "onb_early_tenure_survey_voluntary_check" CHECK ("voluntary" = true),
  CONSTRAINT "onb_early_tenure_survey_score_check" CHECK ("score" BETWEEN 0 AND 10),
  CONSTRAINT "onb_early_tenure_survey_provenance_check" CHECK (
    ("provenance" = 'trusted-provider' AND "source_connector_key" IS NOT NULL AND "authority_assignment_id" IS NULL AND "authority_assignment_revision" IS NULL)
    OR
    ("provenance" = 'human-authorized' AND "source_connector_key" IS NULL AND "authority_assignment_id" IS NOT NULL AND "authority_assignment_revision" IS NOT NULL)
  ),
  CONSTRAINT "onb_early_tenure_survey_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_early_tenure_survey_reporting_idx"
  ON "onb_early_tenure_survey_responses" ("organization_id", "case_id", "submitted_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_employment_outcome_evidence" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "actual_joined_at" timestamp with time zone NOT NULL,
  "employment_status" text NOT NULL,
  "effective_at" timestamp with time zone,
  "observed_at" timestamp with time zone NOT NULL,
  "provenance" text NOT NULL,
  "source_connector_key" text,
  "authority_assignment_id" text,
  "authority_assignment_revision" integer,
  "evidence_reference" text NOT NULL,
  "recorded_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_employment_outcome_status_check"
    CHECK ("employment_status" IN ('active', 'terminated', 'unknown')),
  CONSTRAINT "onb_employment_outcome_effective_check" CHECK (
    ("employment_status" = 'terminated' AND "effective_at" IS NOT NULL)
    OR
    ("employment_status" IN ('active', 'unknown') AND "effective_at" IS NULL)
  ),
  CONSTRAINT "onb_employment_outcome_provenance_check" CHECK (
    ("provenance" = 'trusted-provider' AND "source_connector_key" = 'hris' AND "authority_assignment_id" IS NULL AND "authority_assignment_revision" IS NULL)
    OR
    ("provenance" = 'human-authorized' AND "source_connector_key" IS NULL AND "authority_assignment_id" IS NOT NULL AND "authority_assignment_revision" IS NOT NULL)
  ),
  CONSTRAINT "onb_employment_outcome_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_employment_outcome_reporting_idx"
  ON "onb_employment_outcome_evidence" ("organization_id", "case_id", "observed_at");