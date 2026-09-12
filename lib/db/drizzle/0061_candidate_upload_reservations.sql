-- Reserve and inventory a candidate object before its first storage write.
-- No case/document FK is intentional: a cascade cannot erase interrupted
-- upload evidence before the fenced recovery worker has reconciled its bytes.
CREATE TABLE IF NOT EXISTS "onb_candidate_upload_reservations" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "document_id" integer NOT NULL,
  "object_path" text NOT NULL,
  "data_class" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "policy_id" integer NOT NULL,
  "policy_revision" integer NOT NULL,
  "owner_token" text,
  "state" text NOT NULL DEFAULT 'reserved',
  "lease_until" timestamp with time zone NOT NULL,
  "finalized_upload_id" integer,
  "last_error" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_candidate_upload_reservation_path_unique" UNIQUE ("organization_id", "object_path"),
  CONSTRAINT "onb_candidate_upload_reservation_owner_path_unique" UNIQUE ("owner_token", "object_path"),
  CONSTRAINT "onb_candidate_upload_reservation_policy_revision_check" CHECK ("policy_revision" > 0),
  CONSTRAINT "onb_candidate_upload_reservation_state_check"
    CHECK ("state" in ('reserved','cleanup-processing','finalized','cleanup-completed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_candidate_upload_reservation_recovery_idx"
  ON "onb_candidate_upload_reservations" ("state", "lease_until", "created_at");