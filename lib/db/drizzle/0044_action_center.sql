CREATE TABLE IF NOT EXISTS "onb_action_center_actions" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "case_id" integer NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "owner" text,
  "assignee" text,
  "outcome" text,
  "notes" text,
  "persona" text,
  "self_reported" boolean DEFAULT false NOT NULL,
  "verified" boolean DEFAULT false NOT NULL,
  "actor_user_id" text NOT NULL,
  "actor_name" text NOT NULL,
  "request_id" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_action_center_actions_kind_check"
    CHECK ("kind" in ('manual-call-outcome', 'remind-document', 'assign', 'escalate', 'reassign', 'resolve')),
  CONSTRAINT "onb_action_center_actions_status_check"
    CHECK ("status" in ('open', 'completed', 'sent', 'logged-only', 'blocked', 'failed', 'sending')),
  CONSTRAINT "onb_action_center_actions_call_evidence_check"
    CHECK ("kind" <> 'manual-call-outcome' OR ("self_reported" = true AND "verified" = false)),
  CONSTRAINT "onb_action_center_actions_organization_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
    ON DELETE NO ACTION,
  CONSTRAINT "onb_action_center_actions_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases" ("organization_id", "id")
    ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_action_center_actions_organization_request_unique"
  ON "onb_action_center_actions" ("organization_id", "request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_action_center_actions_organization_status_idx"
  ON "onb_action_center_actions" ("organization_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_action_center_actions_organization_case_idx"
  ON "onb_action_center_actions" ("organization_id", "case_id", "created_at");