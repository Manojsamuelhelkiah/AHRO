-- 0047 intentionally put unknown historical mandatory controls on a
-- migration-review hold.  That conservative hold is not occupational-health
-- evidence: do not accidentally make payroll, access, learning, or ordinary
-- documents require an OH clearance.
UPDATE "onb_cases"
SET "checklist_snapshot" = (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN COALESCE((item.value->>'migrationReviewHold')::boolean, false)
      AND NOT EXISTS (
        SELECT 1 FROM "onb_settings" policy,
          jsonb_array_elements_text(policy."value"::jsonb) configured(id)
        WHERE policy."organization_id" = "onb_cases"."organization_id"
          AND policy."key" = 'nonwaivable_safety_checklist_ids'
          AND configured.id = item.value->>'id'
      )
      THEN item.value || jsonb_build_object('nonWaivableSafety', false)
      ELSE item.value
    END
  ), '[]'::jsonb)
  FROM jsonb_array_elements("checklist_snapshot") AS item(value)
)
WHERE jsonb_typeof("checklist_snapshot") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("checklist_snapshot") AS item(value)
    WHERE COALESCE((item.value->>'migrationReviewHold')::boolean, false)
  );
--> statement-breakpoint
UPDATE "onb_checklist_templates"
SET "items" = (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN COALESCE((item.value->>'migrationReviewHold')::boolean, false)
      AND NOT EXISTS (
        SELECT 1 FROM "onb_settings" policy,
          jsonb_array_elements_text(policy."value"::jsonb) configured(id)
        WHERE policy."organization_id" = "onb_checklist_templates"."organization_id"
          AND policy."key" = 'nonwaivable_safety_checklist_ids'
          AND configured.id = item.value->>'id'
      )
      THEN item.value || jsonb_build_object('nonWaivableSafety', false)
      ELSE item.value
    END
  ), '[]'::jsonb)
  FROM jsonb_array_elements("items") AS item(value)
)
WHERE jsonb_typeof("items") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("items") AS item(value)
    WHERE COALESCE((item.value->>'migrationReviewHold')::boolean, false)
  );