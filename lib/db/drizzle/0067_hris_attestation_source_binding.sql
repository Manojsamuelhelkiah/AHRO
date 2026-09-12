ALTER TABLE "onb_readiness_sla_attestations"
  ADD COLUMN IF NOT EXISTS "source_start_date" text,
  ADD COLUMN IF NOT EXISTS "source_evidence_revision" text;