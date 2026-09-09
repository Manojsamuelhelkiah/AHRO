-- Historical owner-bound scenarios were private before organizations existed.
-- Move them out of the publicly joinable demo organization into deterministic
-- private workspaces owned only by the original scenario owner.
WITH legacy_owners AS (
  SELECT DISTINCT "owner_user_id"
  FROM "scenarios"
  WHERE "organization_id" = 'demo' AND "owner_user_id" IS NOT NULL
  UNION
  SELECT DISTINCT "owner_user_id" FROM "scenario_files"
  UNION
  SELECT DISTINCT "owner_user_id" FROM "scenario_upload_intents"
)
INSERT INTO "organizations"
  ("id", "name", "slug", "join_code_hash", "created_by_user_id")
SELECT
  'legacy-private-' || md5("owner_user_id"),
  'Private migrated workspace',
  'legacy-private-' || md5("owner_user_id"),
  md5('legacy-private-join:' || "owner_user_id") ||
    md5("owner_user_id" || ':legacy-private-join'),
  "owner_user_id"
FROM legacy_owners
WHERE "owner_user_id" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
WITH legacy_owners AS (
  SELECT DISTINCT "owner_user_id"
  FROM "scenarios"
  WHERE "organization_id" = 'demo' AND "owner_user_id" IS NOT NULL
  UNION
  SELECT DISTINCT "owner_user_id" FROM "scenario_files"
  UNION
  SELECT DISTINCT "owner_user_id" FROM "scenario_upload_intents"
)
INSERT INTO "organization_memberships"
  ("organization_id", "clerk_user_id", "role")
SELECT
  'legacy-private-' || md5("owner_user_id"),
  "owner_user_id",
  'owner'
FROM legacy_owners
WHERE "owner_user_id" IS NOT NULL
ON CONFLICT ("organization_id", "clerk_user_id") DO NOTHING;
--> statement-breakpoint
UPDATE "scenarios"
SET "organization_id" = 'legacy-private-' || md5("owner_user_id")
WHERE "organization_id" = 'demo' AND "owner_user_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "scenarios"
  ADD CONSTRAINT "scenarios_organization_id_id_unique"
  UNIQUE ("organization_id", "id");
--> statement-breakpoint

ALTER TABLE "scenario_files"
  ADD COLUMN IF NOT EXISTS "organization_id" text
  REFERENCES "organizations"("id");
--> statement-breakpoint
UPDATE "scenario_files" child
SET "organization_id" = parent."organization_id"
FROM "scenarios" parent
WHERE child."scenario_id" = parent."id";
--> statement-breakpoint
UPDATE "scenario_files"
SET "organization_id" = 'legacy-private-' || md5("owner_user_id")
WHERE "organization_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "scenario_files"
  ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "scenario_files"
  DROP CONSTRAINT IF EXISTS "scenario_files_scenario_id_scenarios_id_fk";
--> statement-breakpoint
ALTER TABLE "scenario_files"
  ADD CONSTRAINT "scenario_files_organization_scenario_fk"
  FOREIGN KEY ("organization_id", "scenario_id")
  REFERENCES "scenarios" ("organization_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scenario_files_organization_owner_scenario_idx"
  ON "scenario_files" ("organization_id", "owner_user_id", "scenario_id");
--> statement-breakpoint

ALTER TABLE "scenario_upload_intents"
  ADD COLUMN IF NOT EXISTS "organization_id" text
  REFERENCES "organizations"("id");
--> statement-breakpoint
UPDATE "scenario_upload_intents"
SET "organization_id" = 'legacy-private-' || md5("owner_user_id")
WHERE "organization_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "scenario_upload_intents"
  ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scenario_upload_intents_organization_owner_status_idx"
  ON "scenario_upload_intents" ("organization_id", "owner_user_id", "status");