CREATE TABLE IF NOT EXISTS "transaction_handoff_revisions" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL,
  "case_id" integer NOT NULL,
  "revision" integer NOT NULL,
  "kind" text NOT NULL,
  "body" text NOT NULL,
  "author_user_id" text NOT NULL,
  "source_revision" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "transaction_handoff_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transaction_handoff_revision_unique" ON "transaction_handoff_revisions" ("organization_id", "case_id", "kind", "revision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transaction_handoff_lifecycle_idx" ON "transaction_handoff_revisions" ("organization_id", "case_id", "created_at");
