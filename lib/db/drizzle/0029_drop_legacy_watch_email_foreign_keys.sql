-- Remove redundant pre-tenant relationships that can survive an interrupted
-- organization rollout. The composite tenant-scoped relationships remain.
ALTER TABLE "onb_watch_emails"
  DROP CONSTRAINT IF EXISTS "onb_watch_emails_case_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_watch_emails"
  DROP CONSTRAINT IF EXISTS "onb_watch_emails_check_id_fkey";