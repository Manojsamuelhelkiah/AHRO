ALTER TABLE "onb_cases" ADD COLUMN "controller_retired" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "onb_cases" AS c SET "controller_retired" = true
WHERE c."synthetic_provenance" = 'demo-controller-fictional'
   OR c."candidate_email_authorized_by" = 'demo-controller'
   OR c."checklist_profile_id" = 'demo-controller'
   OR c."orchestration_checkpoint" LIKE 'demo-controller%'
   OR c."notes" LIKE '%[demo-controller-run:%'
   OR EXISTS (
     SELECT 1 FROM "onb_settings" AS s
     WHERE s."organization_id" = c."organization_id"
       AND s."key" LIKE 'demo-controller.run.v1:%'
       AND substring(s."value" from '"caseId"[[:space:]]*:[[:space:]]*([0-9]{1,9})[[:space:]]*[,}]')::integer = c."id"
   );
