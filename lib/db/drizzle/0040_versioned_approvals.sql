ALTER TABLE "onb_approvals"
  ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_approvals_organization_id_id_unique"
  ON "onb_approvals" ("organization_id", "id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "onb_approval_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "approval_id" integer NOT NULL,
  "case_id" integer NOT NULL,
  "version" integer NOT NULL,
  "event_type" text NOT NULL,
  "status" text NOT NULL,
  "decided_by" text,
  "comment" text,
  "decided_at" timestamp with time zone,
  "reason" text,
  "snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_approval_history_version_check" CHECK ("version" > 0),
  CONSTRAINT "onb_approval_history_event_type_check" CHECK ("event_type" in ('decision', 'reopened')),
  CONSTRAINT "onb_approval_history_organization_approval_version_event_unique"
    UNIQUE ("organization_id", "approval_id", "version", "event_type"),
  CONSTRAINT "onb_approval_history_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "onb_approval_history_organization_approval_fk"
    FOREIGN KEY ("organization_id", "approval_id")
    REFERENCES "onb_approvals" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "onb_approval_history_organization_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
    ON DELETE NO ACTION
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_approval_history_case_idx"
  ON "onb_approval_history" ("organization_id", "case_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "onb_approval_notifications" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "approval_id" integer NOT NULL,
  "case_id" integer NOT NULL,
  "version" integer NOT NULL,
  "kind" text NOT NULL,
  "recipient" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "failure_reason" text,
  "provider_message_id" text,
  "source_message_id" text,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone,
  CONSTRAINT "onb_approval_notifications_version_check" CHECK ("version" > 0),
  CONSTRAINT "onb_approval_notifications_kind_check"
    CHECK ("kind" in ('request', 'decision', 'stale', 'outstanding', 'hr-alert')),
  CONSTRAINT "onb_approval_notifications_status_check"
    CHECK ("status" in ('queued', 'sending', 'sent', 'failed', 'blocked', 'unknown_effect_manual_repair')),
  CONSTRAINT "onb_approval_notifications_organization_idempotency_key_unique"
    UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "onb_approval_notifications_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "onb_approval_notifications_organization_approval_fk"
    FOREIGN KEY ("organization_id", "approval_id")
    REFERENCES "onb_approvals" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "onb_approval_notifications_organization_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
    ON DELETE NO ACTION
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_approval_notifications_queue_idx"
  ON "onb_approval_notifications" ("status", "next_attempt_at");
--> statement-breakpoint