ALTER TABLE "onb_transfer_cutover_plans" ADD COLUMN "readiness_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_transfer_cutover_signoffs" ADD COLUMN "readiness_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_transfer_kpi_evidence" ADD COLUMN "definition_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_transfer_kpi_definitions" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Drizzle named the original three-column primary-key index from the column
-- set (not the PostgreSQL default `_pkey` name). This migration is
-- transactional, so a prior reviewed attempt that failed here was rolled
-- back and remains unrecorded.
ALTER TABLE "onb_transfer_kpi_definitions" DROP CONSTRAINT "onb_transfer_kpi_definitions_organization_id_program_id_metric_pk";
--> statement-breakpoint
ALTER TABLE "onb_transfer_kpi_definitions" ADD CONSTRAINT "onb_transfer_kpi_definitions_pkey" PRIMARY KEY ("organization_id","program_id","metric","revision");
--> statement-breakpoint
ALTER TABLE "onb_transfer_kpi_definitions" ADD CONSTRAINT "onb_transfer_kpi_definition_revision_unique" UNIQUE ("organization_id","program_id","metric","revision");
--> statement-breakpoint
ALTER TABLE "onb_transfer_kpi_evidence" ADD CONSTRAINT "onb_transfer_kpi_evidence_definition_fk" FOREIGN KEY ("organization_id","program_id","metric","definition_revision") REFERENCES "onb_transfer_kpi_definitions"("organization_id","program_id","metric","revision") ON DELETE restrict NOT VALID;