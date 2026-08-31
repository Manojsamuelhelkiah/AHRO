CREATE TABLE IF NOT EXISTS "ea_assessments" (
  "id" serial PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "name" text NOT NULL,
  "client_name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "current_phase" text NOT NULL,
  "content" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "ea_assessments_status_check" CHECK ("status" in ('active', 'archived')),
  CONSTRAINT "ea_assessments_phase_check" CHECK ("current_phase" in ('preliminary', 'architecture-vision', 'business', 'data', 'application', 'technology', 'opportunities-solutions', 'migration-planning', 'implementation-governance', 'architecture-change-management'))
);
--> statement-breakpoint
ALTER TABLE "ea_assessments" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ea_assessments_owner_status_idx"
  ON "ea_assessments" USING btree ("owner_user_id", "status");