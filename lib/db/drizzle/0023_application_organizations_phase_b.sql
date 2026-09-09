-- Phase B restores fail-closed tenant enforcement after Phase A has been
-- published and production has been verified to contain the demo organization
-- with no orphan organization, watch-case, or watch-check references.
ALTER TABLE "scenarios" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "custom_intents" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "actuals_overlays" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "flow_overrides" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_cases" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_events" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_approvals" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_communications" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_system_checks" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_settings" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_connectors" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_documents" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_call_slots" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_employee_records" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "pricing_rate_sets" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "pricing_sheets" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "ea_assessments" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "custom_intents" ADD CONSTRAINT "custom_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "actuals_overlays" ADD CONSTRAINT "actuals_overlays_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "flow_overrides" ADD CONSTRAINT "flow_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD CONSTRAINT "onb_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_events" ADD CONSTRAINT "onb_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD CONSTRAINT "onb_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_communications" ADD CONSTRAINT "onb_communications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_system_checks" ADD CONSTRAINT "onb_system_checks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_settings" ADD CONSTRAINT "onb_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_connectors" ADD CONSTRAINT "onb_connectors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" ADD CONSTRAINT "onb_effect_journal_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_documents" ADD CONSTRAINT "onb_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_call_slots" ADD CONSTRAINT "onb_call_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" ADD CONSTRAINT "onb_voice_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ADD CONSTRAINT "onb_watch_emails_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_employee_records" ADD CONSTRAINT "onb_employee_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" ADD CONSTRAINT "onb_guardrail_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" ADD CONSTRAINT "custom_intent_routing_labels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "pricing_rate_sets" ADD CONSTRAINT "pricing_rate_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "pricing_sheets" ADD CONSTRAINT "pricing_sheets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "ea_assessments" ADD CONSTRAINT "ea_assessments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ADD CONSTRAINT "onb_watch_emails_organization_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ADD CONSTRAINT "onb_watch_emails_organization_check_fk" FOREIGN KEY ("organization_id", "check_id") REFERENCES "onb_system_checks"("organization_id", "id") ON DELETE CASCADE;