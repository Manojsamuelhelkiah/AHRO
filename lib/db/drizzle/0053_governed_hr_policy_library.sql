CREATE TABLE IF NOT EXISTS "onb_hr_policy_sources" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "policy_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "policy_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_hr_policy_versions" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "policy_id" text NOT NULL,
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "source_reference" text NOT NULL,
  "text" text NOT NULL,
  "audience" jsonb NOT NULL,
  "applicability" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "effective_from" date NOT NULL,
  "effective_until" date,
  "review_by" date,
  "status" text NOT NULL DEFAULT 'draft',
  "review_outcome" text,
  "created_by_user_id" text NOT NULL,
  "reviewed_by_user_id" text,
  "reviewer_authority_assignment_id" integer,
  "reviewer_verification_reference" text,
  "published_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "policy_id", "version"),
  CONSTRAINT "onb_hr_policy_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "onb_hr_policy_versions_status_check"
    CHECK ("status" IN ('draft', 'in_review', 'published', 'superseded', 'retired')),
  CONSTRAINT "onb_hr_policy_versions_source_fk"
    FOREIGN KEY ("organization_id", "policy_id")
    REFERENCES "onb_hr_policy_sources" ("organization_id", "policy_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_hr_policy_versions_lookup_idx"
  ON "onb_hr_policy_versions" ("organization_id", "status", "effective_from");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_hr_policy_handoffs" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "requester_user_id" text NOT NULL,
  "fingerprint" text NOT NULL,
  "question" text NOT NULL,
  "applies_on" date,
  "applicability" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'open',
  "resolved_by_user_id" text,
  "resolver_authority_assignment_id" integer,
  "resolution" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_hr_policy_handoffs_status_check" CHECK ("status" IN ('open', 'resolved')),
  CONSTRAINT "onb_hr_policy_handoffs_organization_requester_fingerprint_unique"
    UNIQUE ("organization_id", "requester_user_id", "fingerprint")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_hr_policy_handoffs_open_idx"
  ON "onb_hr_policy_handoffs" ("organization_id", "status", "created_at");