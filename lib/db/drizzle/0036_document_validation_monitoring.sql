-- Candidate portal tables are intentionally absent from supported historical
-- recovery schemas. Current databases receive this forward repair, while the
-- self-sufficient 0030 birth migration supplies the same shape if the portal
-- tables are restored after this migration was recorded as a no-op.
DO $$
BEGIN
  IF to_regclass('onb_candidate_uploads') IS NOT NULL THEN
    ALTER TABLE "onb_candidate_uploads"
      ADD COLUMN IF NOT EXISTS "checksum_sha256" text,
      ADD COLUMN IF NOT EXISTS "validation_state" text NOT NULL DEFAULT 'queued',
      ADD COLUMN IF NOT EXISTS "validation_reasons" jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "validation_started_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "validated_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "validation_claim_owner" text,
      ADD COLUMN IF NOT EXISTS "validation_claim_until" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "validation_attempts" integer NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS "onb_candidate_uploads_validation_queue_idx"
      ON "onb_candidate_uploads" ("validation_state", "validation_claim_until");
  END IF;
END $$;
ALTER TABLE "onb_documents"
  ADD COLUMN IF NOT EXISTS "reminder_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_reminder_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reminder_next_at" timestamp with time zone;