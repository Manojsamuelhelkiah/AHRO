-- Reviewed extension of 0052: jobs may redact durable relational records as
-- well as deleting reconciled private files. Existing upload jobs retain their
-- original identity and are backfilled before the new fields become required.
ALTER TABLE "onb_sensitive_lifecycle_deletion_jobs"
  ALTER COLUMN "upload_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_sensitive_lifecycle_deletion_jobs"
  ADD COLUMN IF NOT EXISTS "record_kind" text NOT NULL DEFAULT 'candidate-upload';
--> statement-breakpoint
ALTER TABLE "onb_sensitive_lifecycle_deletion_jobs"
  ADD COLUMN IF NOT EXISTS "record_id" text;
--> statement-breakpoint
UPDATE "onb_sensitive_lifecycle_deletion_jobs"
  SET "record_id" = "upload_id"::text
  WHERE "record_id" IS NULL AND "upload_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_sensitive_lifecycle_deletion_jobs"
  ALTER COLUMN "record_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_sensitive_lifecycle_deletion_jobs"
  ADD CONSTRAINT "onb_sensitive_lifecycle_deletion_record_kind_check"
  CHECK ("record_kind" IN ('candidate-upload','communication','voice-session','candidate-link','candidate-session'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_sensitive_lifecycle_deletion_record_job_unique"
  ON "onb_sensitive_lifecycle_deletion_jobs"
  ("organization_id", "record_kind", "record_id", "policy_id", "policy_revision");