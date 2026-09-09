ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "setup_data" jsonb;

CREATE TABLE IF NOT EXISTS "scenario_upload_intents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "object_path" text NOT NULL,
  "original_name" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "scenario_upload_intents_object_path_unique" UNIQUE("object_path"),
  CONSTRAINT "scenario_upload_intents_status_check"
    CHECK ("status" IN ('pending', 'uploading', 'uploaded', 'processing', 'finalized', 'cleaning'))
);
CREATE INDEX IF NOT EXISTS "scenario_upload_intents_owner_status_idx"
  ON "scenario_upload_intents" ("owner_user_id", "status");
CREATE INDEX IF NOT EXISTS "scenario_upload_intents_expiry_idx"
  ON "scenario_upload_intents" ("status", "expires_at");

CREATE TABLE IF NOT EXISTS "object_cleanup_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "object_path" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "object_cleanup_jobs_object_path_unique" UNIQUE("object_path")
);
CREATE INDEX IF NOT EXISTS "object_cleanup_jobs_created_idx"
  ON "object_cleanup_jobs" ("created_at");