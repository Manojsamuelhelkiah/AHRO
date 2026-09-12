-- New migration only: do not mutate the already-reviewed 0045 authority
-- history. Labels cannot establish medical verification. Every existing
-- mandatory control is instead held for explicit migration review, so a known
-- mandatory medical/safety control is never silently waived. Governance may
-- subsequently narrow the policy only through the authorized policy endpoint.
UPDATE "onb_cases"
SET "checklist_snapshot" = (
  SELECT COALESCE(jsonb_agg(item.value || jsonb_build_object(
    'nonWaivableSafety', COALESCE((item.value->>'mandatory')::boolean, false),
    'migrationReviewHold', COALESCE((item.value->>'mandatory')::boolean, false)
  )), '[]'::jsonb)
  FROM jsonb_array_elements("checklist_snapshot") AS item(value)
)
WHERE jsonb_typeof("checklist_snapshot") = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements("checklist_snapshot") AS item(value)
    WHERE item.value ? 'nonWaivableSafety'
  );
--> statement-breakpoint
UPDATE "onb_checklist_templates"
SET "items" = (
  SELECT COALESCE(jsonb_agg(item.value || jsonb_build_object(
    'nonWaivableSafety', COALESCE((item.value->>'mandatory')::boolean, false),
    'migrationReviewHold', COALESCE((item.value->>'mandatory')::boolean, false)
  )), '[]'::jsonb)
  FROM jsonb_array_elements("items") AS item(value)
)
WHERE jsonb_typeof("items") = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements("items") AS item(value)
    WHERE item.value ? 'nonWaivableSafety'
  );