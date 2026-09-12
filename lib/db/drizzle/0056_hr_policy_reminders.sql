CREATE TABLE IF NOT EXISTS "onb_hr_policy_reminders" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "policy_id" text NOT NULL,
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "kind" text NOT NULL,
  "due_on" date NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "onb_hr_policy_reminders_org_policy_version_kind_due_unique"
    UNIQUE ("organization_id", "policy_id", "version", "kind", "due_on"),
  CONSTRAINT "onb_hr_policy_reminders_version_check" CHECK ("version" > 0),
  CONSTRAINT "onb_hr_policy_reminders_kind_check"
    CHECK ("kind" IN ('review_due', 'effective_end')),
  CONSTRAINT "onb_hr_policy_reminders_version_fk"
    FOREIGN KEY ("organization_id", "policy_id", "version")
    REFERENCES "onb_hr_policy_versions" ("organization_id", "policy_id", "version")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_hr_policy_reminders_lookup_idx"
  ON "onb_hr_policy_reminders" ("organization_id", "due_on");