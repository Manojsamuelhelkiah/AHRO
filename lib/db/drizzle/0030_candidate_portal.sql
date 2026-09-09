-- Candidate portal is additive. Historical recovery databases used by the
-- migration harness may intentionally stop before tenant/onboarding tables;
-- in that case this migration is a safe no-op and current databases receive
-- the complete schema below.
DO $$
BEGIN
  IF to_regclass('organizations') IS NULL
     OR to_regclass('onb_cases') IS NULL THEN
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS "onb_case_logistics" (
    "organization_id" text NOT NULL REFERENCES "organizations"("id"),
    "case_id" integer NOT NULL,
    "orientation_date" text, "orientation_time" text, "timezone" text, "format" text,
    "venue_address" text, "google_maps_url" text, "meeting_url" text,
    "reporting_contact" text, "arrival_instructions" text,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "onb_case_logistics_org_case_unique" UNIQUE ("organization_id","case_id"),
    CONSTRAINT "onb_case_logistics_format_check" CHECK ("format" IS NULL OR "format" IN ('physical','remote','hybrid')),
    FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS "onb_candidate_links" (
    "id" serial PRIMARY KEY, "organization_id" text NOT NULL REFERENCES "organizations"("id"),
    "case_id" integer NOT NULL, "token_hash" text NOT NULL UNIQUE, "expires_at" timestamptz NOT NULL,
    "revoked_at" timestamptz, "issued_by" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS "onb_candidate_sessions" (
    "id_hash" text PRIMARY KEY, "organization_id" text NOT NULL REFERENCES "organizations"("id"),
    "case_id" integer NOT NULL, "link_id" integer NOT NULL REFERENCES "onb_candidate_links"("id") ON DELETE CASCADE,
    "expires_at" timestamptz NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS "onb_candidate_links_unrevoked_expires_idx"
    ON "onb_candidate_links" ("expires_at")
    WHERE "revoked_at" IS NULL;
  CREATE INDEX IF NOT EXISTS "onb_candidate_links_revoked_at_idx"
    ON "onb_candidate_links" ("revoked_at")
    WHERE "revoked_at" IS NOT NULL;
  CREATE INDEX IF NOT EXISTS "onb_candidate_sessions_expires_at_idx"
    ON "onb_candidate_sessions" ("expires_at");
  CREATE TABLE IF NOT EXISTS "onb_candidate_uploads" (
    "id" serial PRIMARY KEY, "organization_id" text NOT NULL REFERENCES "organizations"("id"),
    "case_id" integer NOT NULL, "document_id" integer NOT NULL, "object_path" text NOT NULL UNIQUE,
    "original_name" text NOT NULL, "content_type" text NOT NULL, "size_bytes" integer NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760),
    FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE CASCADE
  );
END $$;