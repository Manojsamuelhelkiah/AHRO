CREATE TABLE IF NOT EXISTS "onb_standard_intake_events" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "source_id" text NOT NULL,
  "source_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "source_identity" text NOT NULL,
  "acceptance_evidence_reference" text NOT NULL,
  "payload_fingerprint" text NOT NULL,
  "intake_snapshot" jsonb NOT NULL,
  "workforce_context_snapshot" jsonb NOT NULL,
  "process_policy_snapshot" jsonb NOT NULL,
  "case_id" integer,
  "state" text NOT NULL,
  "failure_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "replayed_at" timestamp with time zone,
  PRIMARY KEY ("organization_id", "source_id", "source_event_id"),
  CONSTRAINT "onb_standard_intake_events_organization_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_standard_intake_events_case_idx"
  ON "onb_standard_intake_events" ("organization_id", "case_id");