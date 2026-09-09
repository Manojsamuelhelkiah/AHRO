-- Migration 0026 returned every owner-bound scenario to demo, but scenarios
-- created after 0025 belong to the private workspace and its tenant-local
-- calculation dependencies. The workspace creation timestamp distinguishes
-- those interval-created rows from scenarios that predated organization
-- isolation and were only moved there by 0025.
ALTER TABLE "scenario_files"
  DROP CONSTRAINT IF EXISTS "scenario_files_organization_scenario_fk";
--> statement-breakpoint
DO $migration$
BEGIN
  -- An existing but incomplete legacy schema is rejected by the migration
  -- runner's final compatibility check. Avoid masking that diagnostic with a
  -- missing-column error from this data repair.
  IF (
    SELECT count(*) = 3
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'scenarios'
      AND column_name IN ('organization_id', 'owner_user_id', 'created_at')
  ) THEN
    UPDATE "scenarios" scenario
    SET "organization_id" = private_org."id"
    FROM "organizations" private_org
    WHERE scenario."organization_id" = 'demo'
      AND scenario."owner_user_id" IS NOT NULL
      AND private_org."id" =
        'legacy-private-' || md5(scenario."owner_user_id")
      AND scenario."created_at" > private_org."created_at";

    UPDATE "scenario_files" file
    SET "organization_id" = scenario."organization_id"
    FROM "scenarios" scenario
    WHERE file."scenario_id" = scenario."id"
      AND file."organization_id" <> scenario."organization_id";

    UPDATE "scenario_files" file
    SET "organization_id" = private_org."id"
    FROM "organizations" private_org
    WHERE file."scenario_id" IS NULL
      AND file."organization_id" = 'demo'
      AND private_org."id" =
        'legacy-private-' || md5(file."owner_user_id")
      AND file."created_at" > private_org."created_at";

    UPDATE "scenario_upload_intents" upload_intent
    SET "organization_id" = private_org."id"
    FROM "organizations" private_org
    WHERE upload_intent."organization_id" = 'demo'
      AND private_org."id" =
        'legacy-private-' || md5(upload_intent."owner_user_id")
      AND upload_intent."created_at" > private_org."created_at";

    ALTER TABLE "scenario_files"
      ADD CONSTRAINT "scenario_files_organization_scenario_fk"
      FOREIGN KEY ("organization_id", "scenario_id")
      REFERENCES "scenarios" ("organization_id", "id")
      ON DELETE CASCADE;
  END IF;
END
$migration$;