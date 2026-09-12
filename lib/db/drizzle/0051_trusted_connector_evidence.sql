ALTER TABLE "onb_connectors"
  ADD COLUMN IF NOT EXISTS "configuration_provenance" text NOT NULL DEFAULT 'simulated';
--> statement-breakpoint
ALTER TABLE "onb_system_checks"
  ADD COLUMN IF NOT EXISTS "evidence_provenance" text;
--> statement-breakpoint
ALTER TABLE "onb_readiness_sla_attestations"
  ADD COLUMN IF NOT EXISTS "evidence_provenance" text;