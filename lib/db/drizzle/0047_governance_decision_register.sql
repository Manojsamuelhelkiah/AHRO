CREATE TABLE IF NOT EXISTS "onb_governance_decisions" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "key" text NOT NULL,
  "revision" integer NOT NULL,
  "title" text NOT NULL,
  "proposed_value" jsonb NOT NULL,
  "rationale" text NOT NULL,
  "risk" text NOT NULL,
  "accountable_role" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'provisional', 'approved', 'rejected', 'superseded')),
  "review_due_at" timestamp with time zone,
  "impacted_workflows" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "source_reference" text,
  "is_provisional" boolean NOT NULL DEFAULT true,
  "is_current" boolean NOT NULL DEFAULT true,
  "created_by_user_id" text NOT NULL,
  "approved_by_user_id" text,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "key", "revision"),
  CONSTRAINT "onb_governance_decision_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_governance_decisions_current_idx"
  ON "onb_governance_decisions" ("organization_id", "key") WHERE "is_current" = true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_governance_decision_reviews" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "decision_key" text NOT NULL,
  "decision_revision" integer NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('approved', 'rejected')),
  "reason" text NOT NULL,
  "authority_assignment_id" integer NOT NULL,
  "reviewed_by_user_id" text NOT NULL,
  "verification_reference" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_governance_decision_review_unique"
    UNIQUE ("organization_id", "decision_key", "decision_revision", "reviewed_by_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_governance_authority_assignments" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "authority_role" text NOT NULL,
  "assignee_user_id" text NOT NULL,
  "verified_by_user_id" text NOT NULL,
  "verification_reference" text NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_governance_authority_active_idx"
  ON "onb_governance_authority_assignments" ("organization_id", "authority_role", "assignee_user_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_governance_requirements" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "key" text NOT NULL,
  "title" text NOT NULL,
  "source_reference" text NOT NULL,
  "review_owner_role" text NOT NULL,
  "related_decision_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "implemented" boolean NOT NULL DEFAULT false,
  "tested" boolean NOT NULL DEFAULT false,
  "configured" boolean NOT NULL DEFAULT false,
  "approved_for_live" boolean NOT NULL DEFAULT false,
  "related_implementation" text,
  "evidence_reference" text,
  "version" integer NOT NULL DEFAULT 1,
  "updated_by_user_id" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "key"),
  CONSTRAINT "onb_governance_requirement_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_governance_history" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "entity_type" text NOT NULL,
  "entity_key" text NOT NULL,
  "event_type" text NOT NULL,
  "actor_user_id" text,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_governance_history_tenant_created_idx"
  ON "onb_governance_history" ("organization_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_governance_reminders" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "decision_key" text NOT NULL,
  "decision_revision" integer NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'dispatched', 'cancelled')),
  "dispatch_count" integer NOT NULL DEFAULT 0,
  "dispatched_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "decision_key", "decision_revision")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_governance_reminders_due_idx"
  ON "onb_governance_reminders" ("due_at") WHERE "status" = 'pending';