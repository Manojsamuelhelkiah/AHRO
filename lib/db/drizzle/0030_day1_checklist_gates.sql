CREATE TABLE IF NOT EXISTS "onb_checklist_templates" (
  "organization_id" text NOT NULL,
  "version" integer NOT NULL,
  "items" jsonb NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_checklist_templates_organization_id_version_pk" PRIMARY KEY("organization_id","version"),
  CONSTRAINT "onb_checklist_templates_version_check" CHECK ("version" > 0),
  CONSTRAINT "onb_checklist_templates_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
);

ALTER TABLE "onb_cases"
  ADD COLUMN IF NOT EXISTS "checklist_template_version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "onb_cases"
  ADD COLUMN IF NOT EXISTS "checklist_snapshot" jsonb DEFAULT '[]' NOT NULL;
ALTER TABLE "onb_cases"
  ADD COLUMN IF NOT EXISTS "orchestration_checkpoint" text;

-- Existing rows intentionally retain []: application compatibility resolves
-- that sentinel to the immutable legacy seven-item v1 template without
-- rewriting in-flight readiness statuses.