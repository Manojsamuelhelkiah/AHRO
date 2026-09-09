-- The prior privacy backfill isolated owner-bound scenarios but also separated
-- them from the demo calculation dependencies they were created against.
-- Restore that context while retaining the original owner authorization.
INSERT INTO "organization_memberships"
  ("organization_id", "clerk_user_id", "role")
SELECT DISTINCT 'demo', "owner_user_id", 'member'
FROM "scenarios"
WHERE "organization_id" LIKE 'legacy-private-%'
  AND "owner_user_id" IS NOT NULL
ON CONFLICT ("organization_id", "clerk_user_id") DO NOTHING;
--> statement-breakpoint

ALTER TABLE "scenario_files"
  DROP CONSTRAINT IF EXISTS "scenario_files_organization_scenario_fk";
--> statement-breakpoint
-- Quarantine any attachment created during the short organization-only
-- authorization window if its uploader does not own the private scenario.
UPDATE "scenario_files" child
SET "scenario_id" = NULL, "organization_id" = 'demo'
FROM "scenarios" parent
WHERE child."scenario_id" = parent."id"
  AND parent."organization_id" LIKE 'legacy-private-%'
  AND parent."owner_user_id" IS NOT NULL
  AND parent."owner_user_id" <> child."owner_user_id";
--> statement-breakpoint
UPDATE "scenario_files"
SET "organization_id" = 'demo'
WHERE "organization_id" LIKE 'legacy-private-%';
--> statement-breakpoint
UPDATE "scenario_upload_intents"
SET "organization_id" = 'demo'
WHERE "organization_id" LIKE 'legacy-private-%';
--> statement-breakpoint
UPDATE "scenarios"
SET "organization_id" = 'demo'
WHERE "organization_id" LIKE 'legacy-private-%'
  AND "owner_user_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "scenario_files"
  ADD CONSTRAINT "scenario_files_organization_scenario_fk"
  FOREIGN KEY ("organization_id", "scenario_id")
  REFERENCES "scenarios" ("organization_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint

DELETE FROM "organization_memberships"
WHERE "organization_id" LIKE 'legacy-private-%';
--> statement-breakpoint
DELETE FROM "organizations"
WHERE "id" LIKE 'legacy-private-%';