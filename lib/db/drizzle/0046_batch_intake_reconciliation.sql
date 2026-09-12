CREATE TABLE IF NOT EXISTS "onb_intake_batches" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "batch_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload_fingerprint" text NOT NULL,
  "name" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "batch_id"),
  CONSTRAINT "onb_intake_batches_organization_idempotency_key_unique"
    UNIQUE ("organization_id", "idempotency_key")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_intake_batch_people" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "batch_id" text NOT NULL,
  "person_key" text NOT NULL,
  "case_id" integer NOT NULL,
  "workforce_context_snapshot" jsonb NOT NULL,
  "process_policy_snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "batch_id", "person_key"),
  CONSTRAINT "onb_intake_batch_people_batch_fk"
    FOREIGN KEY ("organization_id", "batch_id")
    REFERENCES "onb_intake_batches"("organization_id", "batch_id") ON DELETE CASCADE,
  CONSTRAINT "onb_intake_batch_people_case_fk"
    FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE
);