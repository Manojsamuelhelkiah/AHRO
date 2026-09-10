CREATE TABLE IF NOT EXISTS "onb_readiness_sla_policies" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "version" integer NOT NULL,
  "policy" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "version"),
  CONSTRAINT "onb_readiness_sla_policy_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_readiness_sla_snapshots" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "snapshot_version" integer NOT NULL,
  "policy_version" integer NOT NULL,
  "policy" jsonb NOT NULL,
  "applicability" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "case_id", "snapshot_version"),
  CONSTRAINT "onb_readiness_sla_snapshot_version_check" CHECK ("snapshot_version" > 0),
  CONSTRAINT "onb_readiness_sla_snapshots_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_readiness_sla_case_state" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "snapshot_version" integer NOT NULL,
  "payroll_cutoff" timestamp with time zone,
  "payroll_cutoff_reason" text,
  "payroll_cutoff_set_by" text,
  "payroll_cutoff_set_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "case_id"),
  CONSTRAINT "onb_readiness_sla_case_state_snapshot_version_check" CHECK ("snapshot_version" > 0),
  CONSTRAINT "onb_readiness_sla_case_state_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_readiness_sla_attestations" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "snapshot_version" integer NOT NULL,
  "stream_key" text NOT NULL,
  "complete" boolean NOT NULL,
  "reason" text NOT NULL,
  "attested_by" text NOT NULL,
  "attested_role" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_readiness_sla_attestations_stream_check" CHECK ("stream_key" in ('hris')),
  CONSTRAINT "onb_readiness_sla_attestations_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_readiness_sla_attestations_case_stream_idx"
  ON "onb_readiness_sla_attestations" ("organization_id", "case_id", "stream_key", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_readiness_sla_ledger" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "snapshot_version" integer NOT NULL,
  "action_key" text NOT NULL,
  "occurrence" integer NOT NULL DEFAULT 1,
  "state" text NOT NULL,
  "due_at" timestamp with time zone,
  "warning_at" timestamp with time zone,
  "breach_at" timestamp with time zone,
  "escalated_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "last_rationale" text,
  "history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_readiness_sla_ledger_state_check"
    CHECK ("state" in ('scheduled', 'warned', 'breached', 'escalated', 'resolved', 'not-applicable', 'needs-configuration')),
  CONSTRAINT "onb_readiness_sla_ledger_occurrence_check" CHECK ("occurrence" > 0),
  CONSTRAINT "onb_readiness_sla_ledger_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "onb_readiness_sla_ledger_occurrence_unique"
    UNIQUE ("organization_id", "case_id", "snapshot_version", "action_key", "occurrence")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_readiness_sla_ledger_due_idx"
  ON "onb_readiness_sla_ledger" ("state", "due_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_readiness_sla_outbox" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "ledger_id" integer,
  "event_key" text NOT NULL,
  "channel" text NOT NULL,
  "recipient" text,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "claim_owner" text,
  "claim_until" timestamp with time zone,
  "available_at" timestamp with time zone NOT NULL DEFAULT now(),
  "delivery_info" text,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_readiness_sla_outbox_channel_check" CHECK ("channel" in ('in-app', 'email')),
  CONSTRAINT "onb_readiness_sla_outbox_status_check" CHECK ("status" in ('pending', 'claimed', 'sent', 'failed', 'unknown')),
  CONSTRAINT "onb_readiness_sla_outbox_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "onb_readiness_sla_outbox_event_unique" UNIQUE ("organization_id", "event_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_readiness_sla_outbox_claim_idx"
  ON "onb_readiness_sla_outbox" ("status", "available_at");