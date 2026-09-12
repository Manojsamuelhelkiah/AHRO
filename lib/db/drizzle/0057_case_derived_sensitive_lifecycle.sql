-- Opaque case narratives can contain more than one sensitive class. Keep the
-- complete policy revision set on the durable job so a later policy change
-- cannot silently authorize minimisation under a stale envelope review.
-- The record kind remains the existing candidate-upload enum-compatible value;
-- its record ID is a server-only case-derived-envelope:<caseId> namespace.
ALTER TABLE "onb_sensitive_lifecycle_deletion_jobs"
  ADD COLUMN IF NOT EXISTS "policy_revisions" jsonb NOT NULL DEFAULT '{}';