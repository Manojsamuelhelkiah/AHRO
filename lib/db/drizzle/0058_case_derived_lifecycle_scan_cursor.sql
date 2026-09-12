-- Bounded, durable keyset scan checkpoint for opaque case-derived envelopes.
CREATE TABLE IF NOT EXISTS "onb_sensitive_lifecycle_scan_cursors" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organizations"("id"),
  "cursor_case_id" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_sensitive_lifecycle_scan_cursor_case_check" CHECK ("cursor_case_id" >= 0)
);