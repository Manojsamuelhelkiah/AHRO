-- Candidate portal tables are intentionally absent from supported historical
-- recovery schemas. Keep this forward migration conditional so those schemas
-- can reconcile safely while current databases receive the cleanup indexes.
DO $$
BEGIN
  IF to_regclass('onb_candidate_links') IS NULL
     OR to_regclass('onb_candidate_sessions') IS NULL THEN
    RETURN;
  END IF;

  CREATE INDEX IF NOT EXISTS "onb_candidate_links_unrevoked_expires_idx"
    ON "onb_candidate_links" ("expires_at")
    WHERE "revoked_at" IS NULL;
  CREATE INDEX IF NOT EXISTS "onb_candidate_links_revoked_at_idx"
    ON "onb_candidate_links" ("revoked_at")
    WHERE "revoked_at" IS NOT NULL;
  CREATE INDEX IF NOT EXISTS "onb_candidate_sessions_expires_at_idx"
    ON "onb_candidate_sessions" ("expires_at");
END $$;