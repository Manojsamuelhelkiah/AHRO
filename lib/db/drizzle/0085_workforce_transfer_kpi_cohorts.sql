ALTER TABLE "onb_transfer_kpi_definitions" ADD COLUMN "cohort_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_transfer_kpi_evidence" ADD COLUMN "source_record_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX "onb_transfer_kpi_evidence_definition_cohort_idx" ON "onb_transfer_kpi_evidence" ("organization_id","program_id","metric","definition_revision","source_record_id","occurred_at");