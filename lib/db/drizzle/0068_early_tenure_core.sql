CREATE TABLE IF NOT EXISTS "onb_early_tenure_policy_versions" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "version" integer NOT NULL,
  "policy" jsonb NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_early_tenure_policy_versions_pkey" PRIMARY KEY ("organization_id", "version"),
  CONSTRAINT "onb_early_tenure_policy_versions_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_early_tenure_case_snapshots" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "snapshot_version" integer NOT NULL,
  "policy_version" integer NOT NULL,
  "policy" jsonb NOT NULL,
  "planned_joining_date" text NOT NULL,
  "actual_joined_at" timestamp with time zone,
  "anchor_revision" integer NOT NULL DEFAULT 0,
  "enrolled_by_user_id" text NOT NULL,
  "enrolled_by" text NOT NULL,
  "enrolled_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_early_tenure_case_snapshots_pkey" PRIMARY KEY ("organization_id", "case_id", "snapshot_version"),
  CONSTRAINT "onb_early_tenure_case_current_snapshot_unique" UNIQUE ("organization_id", "case_id"),
  CONSTRAINT "onb_early_tenure_case_snapshot_version_check" CHECK ("snapshot_version" > 0),
  CONSTRAINT "onb_early_tenure_case_anchor_revision_check" CHECK ("anchor_revision" >= 0),
  CONSTRAINT "onb_early_tenure_case_snapshots_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_early_tenure_assignments" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "snapshot_version" integer NOT NULL,
  "obligation_key" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "owner_name" text NOT NULL,
  "owner_user_id" text,
  "due_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "source_confirmation_required" boolean NOT NULL DEFAULT false,
  "required_connector_key" text,
  "task_details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "completed_at" timestamp with time zone,
  "completed_by_user_id" text,
  "superseded_at" timestamp with time zone,
  "superseded_by_assignment_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_early_tenure_assignments_revision_unique"
    UNIQUE ("organization_id", "case_id", "snapshot_version", "obligation_key", "revision"),
  CONSTRAINT "onb_early_tenure_assignments_organization_id_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "onb_early_tenure_assignments_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "onb_early_tenure_assignments_status_check"
    CHECK ("status" IN ('pending', 'completed', 'superseded', 'cancelled')),
  CONSTRAINT "onb_early_tenure_assignments_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_early_tenure_assignments_due_idx"
  ON "onb_early_tenure_assignments" ("organization_id", "status", "due_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_early_tenure_evidence" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "assignment_id" integer NOT NULL,
  "evidence_reference" text NOT NULL,
  "provenance" text NOT NULL,
  "source_connector_key" text,
  "recorded_by_user_id" text NOT NULL,
  "recorded_by" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_early_tenure_evidence_provenance_check"
    CHECK ("provenance" IN ('human-authorized', 'trusted-provider')),
  CONSTRAINT "onb_early_tenure_evidence_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "onb_early_tenure_evidence_organization_assignment_fk"
    FOREIGN KEY ("organization_id", "assignment_id")
    REFERENCES "onb_early_tenure_assignments"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_early_tenure_evidence_assignment_idx"
  ON "onb_early_tenure_evidence" ("organization_id", "assignment_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_early_tenure_checkins" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "snapshot_version" integer NOT NULL,
  "checkin_key" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "label" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "required" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'scheduled',
  "completed_at" timestamp with time zone,
  "completed_by_user_id" text,
  "evidence_reference" text,
  "superseded_at" timestamp with time zone,
  "superseded_by_checkin_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_early_tenure_checkins_revision_unique"
    UNIQUE ("organization_id", "case_id", "snapshot_version", "checkin_key", "revision"),
  CONSTRAINT "onb_early_tenure_checkins_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "onb_early_tenure_checkins_status_check"
    CHECK ("status" IN ('scheduled', 'completed', 'superseded', 'cancelled')),
  CONSTRAINT "onb_early_tenure_checkins_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_early_tenure_checkins_due_idx"
  ON "onb_early_tenure_checkins" ("organization_id", "status", "due_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_early_tenure_reminders" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "target_type" text NOT NULL,
  "target_id" integer NOT NULL,
  "target_revision" integer NOT NULL,
  "event_key" text NOT NULL,
  "intended_recipient" text NOT NULL,
  "recipient_email" text,
  "due_at" timestamp with time zone NOT NULL,
  "available_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "claim_owner" text,
  "claim_until" timestamp with time zone,
  "attempts" integer NOT NULL DEFAULT 0,
  "delivery_info" text,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_early_tenure_reminders_event_unique" UNIQUE ("organization_id", "event_key"),
  CONSTRAINT "onb_early_tenure_reminders_target_check" CHECK ("target_type" IN ('assignment', 'checkin')),
  CONSTRAINT "onb_early_tenure_reminders_status_check"
    CHECK ("status" IN ('pending', 'claimed', 'sent', 'suppressed', 'failed', 'unknown')),
  CONSTRAINT "onb_early_tenure_reminders_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_early_tenure_reminders_claim_idx"
  ON "onb_early_tenure_reminders" ("organization_id", "status", "available_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_probation_decisions" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "snapshot_version" integer NOT NULL,
  "decision_version" integer NOT NULL,
  "disposition" text NOT NULL,
  "effective_at" timestamp with time zone NOT NULL,
  "extension_ends_at" timestamp with time zone,
  "rationale" text NOT NULL,
  "evidence_reference" text NOT NULL,
  "decided_by_user_id" text NOT NULL,
  "decided_by" text NOT NULL,
  "authority_id" text NOT NULL,
  "authority_revision" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_probation_decisions_version_unique" UNIQUE ("organization_id", "case_id", "decision_version"),
  CONSTRAINT "onb_probation_decisions_version_check" CHECK ("decision_version" > 0),
  CONSTRAINT "onb_probation_decisions_disposition_check"
    CHECK ("disposition" IN ('confirmed', 'extended', 'reviewed-other')),
  CONSTRAINT "onb_probation_decisions_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);