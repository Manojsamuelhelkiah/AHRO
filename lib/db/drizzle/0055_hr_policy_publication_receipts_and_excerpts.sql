ALTER TABLE "onb_hr_policy_versions"
  ADD COLUMN IF NOT EXISTS "publisher_user_id" text;
--> statement-breakpoint
ALTER TABLE "onb_hr_policy_versions"
  ADD COLUMN IF NOT EXISTS "publisher_authority_assignment_id" integer;
--> statement-breakpoint
ALTER TABLE "onb_hr_policy_versions"
  ADD COLUMN IF NOT EXISTS "publication_verification_reference" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_hr_policy_excerpts" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "policy_id" text NOT NULL,
  "version" integer NOT NULL,
  "excerpt_id" text NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "policy_id", "version", "excerpt_id"),
  CONSTRAINT "onb_hr_policy_excerpts_version_fk"
    FOREIGN KEY ("organization_id", "policy_id", "version")
    REFERENCES "onb_hr_policy_versions" ("organization_id", "policy_id", "version")
);