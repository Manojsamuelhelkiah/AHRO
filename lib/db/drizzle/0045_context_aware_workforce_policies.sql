ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "workforce_context" jsonb NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "workforce_classification" jsonb;
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "workforce_context_version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "process_policy_snapshot" jsonb NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "job_profile_id" text;
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "job_profile_version" integer;
--> statement-breakpoint
ALTER TABLE "onb_checklist_profiles" ADD COLUMN IF NOT EXISTS "process_policy" jsonb NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_policy_evidence" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "item_id" text NOT NULL,
  "evidence_reference" text NOT NULL,
  "authority_role" text NOT NULL,
  "decision" text NOT NULL CHECK ("decision" IN ('verified', 'rejected')),
  "reason" text NOT NULL,
  "verified_by" text NOT NULL,
  "verified_by_user_id" text NOT NULL,
  "checklist_template_version" integer NOT NULL,
  "checklist_profile_id" text NOT NULL,
  "checklist_profile_version" integer NOT NULL,
  "workforce_context_version" integer NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
  ,CONSTRAINT "onb_policy_evidence_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_policy_evidence_case_item_idx"
  ON "onb_policy_evidence" ("organization_id", "case_id", "item_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_policy_authorities" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL,
  "authority_role" text NOT NULL,
  "case_id" integer NOT NULL,
  "item_id" text NOT NULL,
  "site" text NOT NULL,
  "assigned_by" text NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "user_id", "authority_role", "case_id", "item_id", "site"),
  CONSTRAINT "onb_policy_authorities_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_job_profiles" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "profile_id" text NOT NULL,
  "version" integer NOT NULL,
  "name" text NOT NULL,
  "context" jsonb NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "profile_id", "version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_policy_recommendations" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "status" text NOT NULL DEFAULT 'proposed' CHECK ("status" IN ('proposed', 'accepted', 'rejected')),
  "recommendation" jsonb NOT NULL,
  "evidence_snapshot" jsonb NOT NULL,
  "decision_note" text,
  "decided_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "decided_at" timestamp with time zone
);