-- Durable server-owned origin for fictional offline cases. Existing notes are
-- deliberately not backfilled: user-controlled marker text is not provenance.
ALTER TABLE "onb_cases"
  ADD COLUMN IF NOT EXISTS "synthetic_provenance" text;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"onb_cases"'::regclass
      AND conname = 'onb_cases_synthetic_provenance_check'
  ) THEN
    ALTER TABLE "onb_cases"
      ADD CONSTRAINT "onb_cases_synthetic_provenance_check"
      CHECK (
        "synthetic_provenance" IS NULL OR
        "synthetic_provenance" IN (
          'onboarding-demo-fictional',
          'synthetic-reset',
          'demo-full-coverage',
          'demo-controller-fictional'
        )
      );
  END IF;
END;
$migration$;

-- Revoke grants issued by the old notes-only Demo eligibility rule. This is
-- intentionally a revocation, never a provenance backfill. Volunteer-backed
-- Demo Controller cases and UAT-isolated cases remain on their separate paths.
DELETE FROM "access_named_grants" AS grants
USING "onb_cases" AS cases
WHERE grants."organization_id" = 'demo'
  AND cases."organization_id" = grants."organization_id"
  AND cases."id" = grants."case_id"
  AND grants."scope" = 'case'
  AND grants."source" = 'named'
  AND grants."effect" = 'allow'
  AND grants."status" = 'active'
  AND grants."revoked_at" IS NULL
  AND grants."resource_key" IN (
    'data.case.profile.read',
    'data.case.notes.read',
    'data.case.readiness.read',
    'data.documents.read',
    'flow.case.read'
  )
  AND cases."synthetic_provenance" IS NULL
  AND cases."candidate_email_authorized_at" IS NULL
  AND cases."candidate_email_authorized_by" IS NULL
  AND position('[synthetic-offline-reset:v1]' IN coalesce(cases."notes", '')) > 0
  AND (cases."scenario_key" IS NULL OR cases."scenario_key" NOT LIKE 'UAT-%');