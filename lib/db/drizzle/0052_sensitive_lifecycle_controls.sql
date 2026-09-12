CREATE TABLE IF NOT EXISTS "onb_sensitive_lifecycle_policies" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "data_class" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "revision" integer NOT NULL,
  "purpose" text NOT NULL,
  "lawful_basis" text NOT NULL,
  "retention_days" integer NOT NULL,
  "provider_sharing_approved" boolean NOT NULL,
  "permitted_providers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "policy_reference" text NOT NULL,
  "approval_reference" text NOT NULL,
  "approved_by_user_id" text NOT NULL,
  "approved_authority_assignment_id" integer NOT NULL,
  "approved_at" timestamp with time zone NOT NULL DEFAULT now(),
  "is_current" boolean NOT NULL DEFAULT true,
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_sensitive_lifecycle_policy_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "onb_sensitive_lifecycle_policy_retention_check" CHECK ("retention_days" >= 0),
  CONSTRAINT "onb_sensitive_lifecycle_policy_revision_unique"
    UNIQUE ("organization_id", "data_class", "jurisdiction", "revision")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_sensitive_lifecycle_policy_current_idx"
  ON "onb_sensitive_lifecycle_policies" ("organization_id", "data_class", "jurisdiction") WHERE "is_current" = true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_sensitive_lifecycle_holds" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "data_class" text,
  "case_id" integer,
  "object_path" text,
  "reason" text NOT NULL,
  "reference" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "set_by_user_id" text NOT NULL,
  "set_authority_assignment_id" integer NOT NULL,
  "set_at" timestamp with time zone NOT NULL DEFAULT now(),
  "released_by_user_id" text,
  "released_authority_assignment_id" integer,
  "released_at" timestamp with time zone,
  CONSTRAINT "onb_sensitive_lifecycle_hold_scope_check"
    CHECK ("data_class" is not null OR "case_id" is not null OR "object_path" is not null)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_sensitive_lifecycle_hold_active_idx"
  ON "onb_sensitive_lifecycle_holds" ("organization_id", "active", "case_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_sensitive_object_manifests" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "object_path" text NOT NULL,
  "data_class" text NOT NULL,
  "case_id" integer,
  "manifest_state" text NOT NULL,
  "reconciled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_sensitive_object_manifest_path_unique" UNIQUE ("organization_id", "object_path"),
  CONSTRAINT "onb_sensitive_object_manifest_state_check" CHECK ("manifest_state" in ('complete','reconciliation-required'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_sensitive_object_derivatives" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "manifest_id" integer NOT NULL REFERENCES "onb_sensitive_object_manifests"("id") ON DELETE CASCADE,
  "object_path" text NOT NULL,
  "derivative_path" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_sensitive_object_derivative_path_unique" UNIQUE ("organization_id", "derivative_path"),
  CONSTRAINT "onb_sensitive_object_derivative_unique" UNIQUE ("manifest_id", "derivative_path")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_sensitive_lifecycle_confirmations" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "actor_user_id" text NOT NULL,
  "policy_id" integer NOT NULL,
  "expected_revision" integer NOT NULL,
  "proposed_policy" jsonb NOT NULL,
  "affected_object_count" integer NOT NULL DEFAULT 0,
  "eligible_upload_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_sensitive_lifecycle_confirmation_count_check" CHECK ("affected_object_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_sensitive_lifecycle_deletion_jobs" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "data_class" text NOT NULL,
  "case_id" integer,
  "upload_id" integer NOT NULL,
  "policy_id" integer NOT NULL,
  "policy_revision" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "claim_owner" text,
  "claim_until" timestamp with time zone,
  "last_error" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_sensitive_lifecycle_deletion_job_unique"
    UNIQUE ("organization_id", "upload_id", "policy_id", "policy_revision"),
  CONSTRAINT "onb_sensitive_lifecycle_deletion_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "onb_sensitive_lifecycle_deletion_status_check" CHECK ("status" in ('queued','processing','completed','blocked','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_sensitive_lifecycle_deletion_queue_idx"
  ON "onb_sensitive_lifecycle_deletion_jobs" ("status", "claim_until", "created_at");