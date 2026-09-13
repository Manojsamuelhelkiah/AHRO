ALTER TABLE "onb_sensitive_lifecycle_deletion_jobs"
  DROP CONSTRAINT IF EXISTS "onb_sensitive_lifecycle_deletion_record_kind_check";
--> statement-breakpoint
ALTER TABLE "onb_sensitive_lifecycle_deletion_jobs"
  ADD CONSTRAINT "onb_sensitive_lifecycle_deletion_record_kind_check"
  CHECK ("record_kind" IN (
    'candidate-upload',
    'communication',
    'voice-session',
    'candidate-link',
    'candidate-session',
    'transfer-program'
  ));