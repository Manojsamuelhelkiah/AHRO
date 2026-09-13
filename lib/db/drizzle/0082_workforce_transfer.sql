CREATE TABLE "onb_transfer_programs" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "source_legal_entity" text NOT NULL,
  "destination_legal_entity" text NOT NULL,
  "countries" jsonb NOT NULL,
  "proposed_basis" text NOT NULL,
  "legal_day1" timestamp with time zone NOT NULL,
  "owners" jsonb NOT NULL,
  "status" text DEFAULT 'planning' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_programs_organization_id_id_pk" PRIMARY KEY ("organization_id","id"),
  CONSTRAINT "onb_transfer_programs_basis_check" CHECK ("proposed_basis" in ('automatic-transfer', 'share-purchase', 'asset-purchase', 'cross-border')),
  CONSTRAINT "onb_transfer_programs_status_check" CHECK ("status" in ('planning', 'legal-reviewed', 'blocked', 'cutover-approved', 'cutover-blocked')),
  CONSTRAINT "onb_transfer_programs_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE TABLE "onb_transfer_pathways" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "decision" text NOT NULL,
  "offer_requirement" text NOT NULL,
  "bgv_applicability" text NOT NULL,
  "review_reference" text NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "decided_by_user_id" text NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_pathways_program_jurisdiction_unique" UNIQUE("organization_id","program_id","jurisdiction"),
  CONSTRAINT "onb_transfer_pathways_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "onb_transfer_programs"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_pathways_decision_check" CHECK ("decision" in ('approved', 'rejected')),
  CONSTRAINT "onb_transfer_pathways_offer_check" CHECK ("offer_requirement" in ('not-required', 'required', 'legal-review-required')),
  CONSTRAINT "onb_transfer_pathways_bgv_check" CHECK ("bgv_applicability" in ('not-required', 'required', 'legal-review-required'))
);
--> statement-breakpoint
CREATE TABLE "onb_transfer_data_governance" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "lawful_basis_reference" text NOT NULL,
  "retention_reference" text NOT NULL,
  "retention_until" timestamp with time zone NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "approved_by_user_id" text NOT NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_data_governance_organization_id_program_id_jurisdiction_pk" PRIMARY KEY ("organization_id","program_id","jurisdiction"),
  CONSTRAINT "onb_transfer_data_governance_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "onb_transfer_programs"("organization_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "onb_transfer_populations" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" text NOT NULL,
  "country" text NOT NULL,
  "source_legal_entity" text NOT NULL,
  "destination_legal_entity" text NOT NULL,
  "expected_headcount" integer,
  "status" text DEFAULT 'planning' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_populations_organization_id_id_pk" PRIMARY KEY ("organization_id","id"),
  CONSTRAINT "onb_transfer_populations_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "onb_transfer_programs"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_populations_headcount_check" CHECK ("expected_headcount" is null or "expected_headcount" >= 0),
  CONSTRAINT "onb_transfer_populations_status_check" CHECK ("status" in ('planning', 'imported', 'reconciled', 'blocked'))
);
--> statement-breakpoint
CREATE INDEX "onb_transfer_populations_program_idx" ON "onb_transfer_populations" ("organization_id","program_id");
--> statement-breakpoint
CREATE TABLE "onb_transfer_import_previews" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "population_id" text NOT NULL,
  "mapping" jsonb NOT NULL,
  "normalized_rows" jsonb NOT NULL,
  "fingerprint" text NOT NULL,
  "valid_count" integer NOT NULL,
  "invalid_count" integer NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_import_previews_organization_id_id_pk" PRIMARY KEY ("organization_id","id"),
  CONSTRAINT "onb_transfer_import_previews_population_fk" FOREIGN KEY ("organization_id","population_id") REFERENCES "onb_transfer_populations"("organization_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "onb_transfer_import_previews_population_idx" ON "onb_transfer_import_previews" ("organization_id","population_id","created_at");
--> statement-breakpoint
CREATE TABLE "onb_transfer_imports" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "population_id" text NOT NULL,
  "preview_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "imported_count" integer DEFAULT 0 NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_imports_organization_id_id_pk" PRIMARY KEY ("organization_id","id"),
  CONSTRAINT "onb_transfer_import_idempotency_unique" UNIQUE("organization_id","idempotency_key"),
  CONSTRAINT "onb_transfer_import_population_fk" FOREIGN KEY ("organization_id","population_id") REFERENCES "onb_transfer_populations"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_import_preview_fk" FOREIGN KEY ("organization_id","preview_id") REFERENCES "onb_transfer_import_previews"("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "onb_transfer_workers" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "population_id" text NOT NULL,
  "import_id" text NOT NULL,
  "stable_source_id" text NOT NULL,
  "source_payload" jsonb NOT NULL,
  "original_hire_date" timestamp with time zone NOT NULL,
  "continuous_service_date" timestamp with time zone NOT NULL,
  "migration_status" text DEFAULT 'pending' NOT NULL,
  "objection_status" text DEFAULT 'pending' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_workers_organization_id_id_pk" PRIMARY KEY ("organization_id","id"),
  CONSTRAINT "onb_transfer_workers_source_unique" UNIQUE("organization_id","population_id","stable_source_id"),
  CONSTRAINT "onb_transfer_workers_population_fk" FOREIGN KEY ("organization_id","population_id") REFERENCES "onb_transfer_populations"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_workers_import_fk" FOREIGN KEY ("organization_id","import_id") REFERENCES "onb_transfer_imports"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_workers_dates_check" CHECK ("continuous_service_date" >= "original_hire_date"),
  CONSTRAINT "onb_transfer_workers_status_check" CHECK ("migration_status" in ('pending', 'reconciled', 'exception', 'excluded')),
  CONSTRAINT "onb_transfer_workers_objection_check" CHECK ("objection_status" in ('pending', 'objected', 'withdrawn', 'resolved'))
);
--> statement-breakpoint
CREATE INDEX "onb_transfer_workers_population_idx" ON "onb_transfer_workers" ("organization_id","population_id","migration_status");
--> statement-breakpoint
CREATE TABLE "onb_transfer_consultation_milestones" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "kind" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "status" text NOT NULL,
  "private_evidence_reference" text NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "recorded_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_consultation_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "onb_transfer_programs"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_consultation_status_check" CHECK ("status" in ('planned', 'communicated', 'completed', 'blocked'))
);
--> statement-breakpoint
CREATE INDEX "onb_transfer_consultation_program_idx" ON "onb_transfer_consultation_milestones" ("organization_id","program_id","jurisdiction","due_at");
--> statement-breakpoint
CREATE TABLE "onb_transfer_objections" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "worker_id" text NOT NULL,
  "outcome" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "private_evidence_reference" text NOT NULL,
  "recorded_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_objections_worker_fk" FOREIGN KEY ("organization_id","worker_id") REFERENCES "onb_transfer_workers"("organization_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "onb_transfer_objections_worker_idx" ON "onb_transfer_objections" ("organization_id","worker_id","created_at");
--> statement-breakpoint
CREATE TABLE "onb_transfer_integration_actions" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" text NOT NULL,
  "kind" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'planned' NOT NULL,
  "evidence_reference" text,
  "legal_approval_reference" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_integration_actions_organization_id_id_pk" PRIMARY KEY ("organization_id","id"),
  CONSTRAINT "onb_transfer_integration_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "onb_transfer_programs"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_integration_kind_check" CHECK ("kind" in ('induction', 'integration', 'harmonisation')),
  CONSTRAINT "onb_transfer_integration_status_check" CHECK ("status" in ('planned', 'in-progress', 'completed', 'blocked')),
  CONSTRAINT "onb_transfer_harmonisation_approval_check" CHECK ("kind" <> 'harmonisation' or "legal_approval_reference" is not null)
);
--> statement-breakpoint
CREATE INDEX "onb_transfer_integration_program_idx" ON "onb_transfer_integration_actions" ("organization_id","program_id","due_at");
--> statement-breakpoint
CREATE TABLE "onb_transfer_cutover_plans" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" text NOT NULL,
  "version" integer NOT NULL,
  "pathway_snapshot" jsonb NOT NULL,
  "worker_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "worker_count" integer NOT NULL,
  "contingency_reference" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "decision_at" timestamp with time zone,
  "decided_by_user_id" text,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_cutover_plans_organization_id_id_pk" PRIMARY KEY ("organization_id","id"),
  CONSTRAINT "onb_transfer_cutover_program_version_unique" UNIQUE("organization_id","program_id","version"),
  CONSTRAINT "onb_transfer_cutover_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "onb_transfer_programs"("organization_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "onb_transfer_cutover_reconciliations" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "plan_id" text NOT NULL,
  "worker_id" text NOT NULL,
  "stream" text NOT NULL,
  "status" text NOT NULL,
  "evidence_reference" text NOT NULL,
  "source_attestation_reference" text,
  "destination_attestation_reference" text,
  "destination_original_hire_date" timestamp with time zone,
  "destination_continuous_service_date" timestamp with time zone,
  "destination_terms_reference" text,
  "destination_benefits_reference" text,
  "repair_reference" text,
  "repaired_at" timestamp with time zone,
  "authority_scope" text NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "recorded_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_reconciliation_current_unique" UNIQUE("organization_id","plan_id","worker_id","stream"),
  CONSTRAINT "onb_transfer_reconciliation_plan_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "onb_transfer_cutover_plans"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_reconciliation_worker_fk" FOREIGN KEY ("organization_id","worker_id") REFERENCES "onb_transfer_workers"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_reconciliation_stream_check" CHECK ("stream" in ('migration', 'payroll', 'benefits', 'access', 'first-pay')),
  CONSTRAINT "onb_transfer_reconciliation_status_check" CHECK ("status" in ('pending', 'ready', 'complete', 'exception', 'unknown-effect-manual-repair'))
);
--> statement-breakpoint
CREATE TABLE "onb_transfer_cutover_signoffs" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "plan_id" text NOT NULL,
  "role" text NOT NULL,
  "decision" text NOT NULL,
  "reason_reference" text NOT NULL,
  "authority_scope" text NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "signed_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_cutover_signoff_unique" UNIQUE("organization_id","plan_id","role"),
  CONSTRAINT "onb_transfer_cutover_signoff_plan_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "onb_transfer_cutover_plans"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_cutover_signoff_role_check" CHECK ("role" in ('hr-integration', 'payroll', 'it')),
  CONSTRAINT "onb_transfer_cutover_signoff_decision_check" CHECK ("decision" in ('approved', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "onb_transfer_reconciliation_repairs" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "plan_id" text NOT NULL,
  "worker_id" text NOT NULL,
  "stream" text NOT NULL,
  "prior_status" text NOT NULL,
  "repair_reference" text NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "repaired_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_reconciliation_repair_plan_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "onb_transfer_cutover_plans"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_reconciliation_repair_worker_fk" FOREIGN KEY ("organization_id","worker_id") REFERENCES "onb_transfer_workers"("organization_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "onb_transfer_reconciliation_repairs_lookup_idx" ON "onb_transfer_reconciliation_repairs" ("organization_id","plan_id","worker_id","stream","created_at");
--> statement-breakpoint
CREATE TABLE "onb_transfer_kpi_evidence" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" text NOT NULL,
  "worker_id" text,
  "metric" text NOT NULL,
  "value" boolean NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "measurement" jsonb NOT NULL,
  "source_attestation_reference" text NOT NULL,
  "evidence_reference" text NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "recorded_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_kpi_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "onb_transfer_programs"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_kpi_worker_fk" FOREIGN KEY ("organization_id","worker_id") REFERENCES "onb_transfer_workers"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_kpi_metric_check" CHECK ("metric" in ('service-date-accurate', 'consultation-timely', 'access-timely', 'first-pay-accurate', 'actual-attrition', 'harmonisation-complete'))
);
--> statement-breakpoint
CREATE INDEX "onb_transfer_kpi_program_metric_idx" ON "onb_transfer_kpi_evidence" ("organization_id","program_id","metric","occurred_at");
--> statement-breakpoint
CREATE TABLE "onb_transfer_kpi_definitions" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" text NOT NULL,
  "metric" text NOT NULL,
  "definition_reference" text NOT NULL,
  "denominator_reference" text NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "approved_by_user_id" text NOT NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_transfer_kpi_definitions_organization_id_program_id_metric_pk" PRIMARY KEY ("organization_id","program_id","metric"),
  CONSTRAINT "onb_transfer_kpi_definition_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "onb_transfer_programs"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_transfer_kpi_definition_metric_check" CHECK ("metric" in ('service-date-accurate', 'consultation-timely', 'access-timely', 'first-pay-accurate', 'actual-attrition', 'harmonisation-complete'))
);