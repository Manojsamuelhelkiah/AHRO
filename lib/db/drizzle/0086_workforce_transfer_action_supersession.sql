ALTER TABLE "onb_transfer_integration_actions" DROP CONSTRAINT "onb_transfer_integration_kind_check";
--> statement-breakpoint
ALTER TABLE "onb_transfer_integration_actions" ADD CONSTRAINT "onb_transfer_integration_kind_check" CHECK ("kind" in ('induction', 'integration', 'harmonisation', 'contingency-parallel-run'));
--> statement-breakpoint
CREATE TABLE "onb_transfer_operational_supersessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" text NOT NULL,
  "record_kind" text NOT NULL,
  "record_id" text NOT NULL,
  "prior_status" text NOT NULL,
  "prior_evidence_reference" text,
  "superseded_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_operational_supersession_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "onb_transfer_programs"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_operational_supersession_kind_check" CHECK ("record_kind" in ('consultation-milestone', 'integration-action'))
);
--> statement-breakpoint
CREATE INDEX "onb_transfer_operational_supersessions_lookup_idx" ON "onb_transfer_operational_supersessions" ("organization_id","program_id","record_kind","record_id","created_at");