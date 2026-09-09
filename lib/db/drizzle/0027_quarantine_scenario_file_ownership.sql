-- During the short organization-only authorization window, an uploader could
-- attach their file to another member's owner-bound scenario. Detach every
-- such mismatch while retaining the file's existing organization and uploader
-- ownership, so deleting the parent scenario cannot delete another user's file.
UPDATE "scenario_files" child
SET "scenario_id" = NULL
FROM "scenarios" parent
WHERE child."scenario_id" = parent."id"
  AND child."organization_id" = parent."organization_id"
  AND parent."owner_user_id" IS NOT NULL
  AND parent."owner_user_id" <> child."owner_user_id";