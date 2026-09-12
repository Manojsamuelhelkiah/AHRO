CREATE TABLE IF NOT EXISTS "onb_authority_governance" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "status" text DEFAULT 'unconfigured' NOT NULL,
  "operator_user_id" text,
  "attested_at" timestamp with time zone,
  "attestation_note" text,
  "approved_by_user_id" text,
  "approved_at" timestamp with time zone,
  "governance_source" text,
  "revision" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_authority_governance_status_check"
    CHECK ("status" in ('unconfigured', 'operator-attested', 'governance-approved', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_authority_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "person_user_id" text NOT NULL,
  "person_email" text,
  "email_responder_authorized" boolean DEFAULT false NOT NULL,
  "authority_role" text NOT NULL,
  "scopes" jsonb NOT NULL,
  "case_id" integer,
  "site_scope" text,
  "jurisdiction_scope" text,
  "valid_from" timestamp with time zone DEFAULT now() NOT NULL,
  "valid_until" timestamp with time zone,
  "status" text DEFAULT 'active' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "grantor_user_id" text NOT NULL,
  "source" text NOT NULL,
  "governance_decision_ref" text NOT NULL,
  "revoked_by_user_id" text,
  "revoked_at" timestamp with time zone,
  "revoke_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_authority_assignments_status_check" CHECK ("status" in ('active', 'revoked')),
  CONSTRAINT "onb_authority_assignments_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "onb_authority_assignments_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_authority_assignments_organization_id_id_unique"
  ON "onb_authority_assignments" ("organization_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_authority_assignments_person_lookup_idx"
  ON "onb_authority_assignments" ("organization_id", "person_user_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_authority_assignments_remote_lookup_idx"
  ON "onb_authority_assignments" ("organization_id", "person_email", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_authority_audit" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "authority_id" text,
  "action" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_authority_audit_organization_created_idx"
  ON "onb_authority_audit" ("organization_id", "created_at");
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD COLUMN IF NOT EXISTS "authority_scope" text;
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD COLUMN IF NOT EXISTS "requested_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD COLUMN IF NOT EXISTS "decided_authority_id" text;
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD COLUMN IF NOT EXISTS "decided_authority_revision" integer;
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD COLUMN IF NOT EXISTS "authority_review_status" text DEFAULT 'not-required' NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD COLUMN IF NOT EXISTS "authority_reviewed_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD COLUMN IF NOT EXISTS "authority_reviewed_at" timestamp with time zone;