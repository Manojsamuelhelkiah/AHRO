-- Reviewed forward repair: a disposable scan checkpoint must never prevent
-- tenant cleanup. Workers recreate this cursor on the next bounded scan.
ALTER TABLE "onb_sensitive_lifecycle_scan_cursors"
  DROP CONSTRAINT IF EXISTS "onb_sensitive_lifecycle_scan_cursors_organization_id_fkey";