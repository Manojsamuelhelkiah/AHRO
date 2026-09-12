CREATE TABLE IF NOT EXISTS "onb_outcome_evidence_authority_receipts" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "actor_user_id" text NOT NULL,
  "authority_role" text NOT NULL,
  "scope" text NOT NULL,
  "case_id" integer NOT NULL,
  "site_scope" text,
  "jurisdiction_scope" text,
  "valid_from" timestamp with time zone NOT NULL,
  "valid_until" timestamp with time zone,
  "verified_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_outcome_authority_receipt_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_outcome_authority_receipt_lookup_idx"
  ON "onb_outcome_evidence_authority_receipts" ("organization_id", "id");
--> statement-breakpoint
ALTER TABLE "onb_early_tenure_survey_responses"
  ADD COLUMN IF NOT EXISTS "authority_receipt_id" integer;
--> statement-breakpoint
ALTER TABLE "onb_employment_outcome_evidence"
  ADD COLUMN IF NOT EXISTS "authority_receipt_id" integer;