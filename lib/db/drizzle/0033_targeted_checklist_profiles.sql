CREATE TABLE IF NOT EXISTS "onb_checklist_profiles" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "profile_id" text NOT NULL,
  "version" integer NOT NULL,
  "name" text NOT NULL,
  "criteria" jsonb NOT NULL,
  "overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "priority" integer NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_checklist_profiles_organization_id_profile_id_version_pk" PRIMARY KEY("organization_id","profile_id","version"),
  CONSTRAINT "onb_checklist_profiles_version_check" CHECK ("version" > 0),
  CONSTRAINT "onb_checklist_profiles_priority_check" CHECK ("priority" >= 0)
);
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "checklist_profile_id" text DEFAULT 'default' NOT NULL;
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "checklist_profile_name" text DEFAULT 'Organization default' NOT NULL;
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "checklist_profile_version" integer;
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "checklist_matched_criteria" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "checklist_match_explanation" text DEFAULT 'No targeted profile matched; organization default selected.' NOT NULL;
ALTER TABLE "onb_cases" ADD COLUMN IF NOT EXISTS "worker_band" text;