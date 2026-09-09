-- Phase A is intentionally a narrow reconciliation from final 0021:
-- preserve tenant-local identities and composite child FKs, while making
-- tenant columns publish-backfillable and avoiding direct organization FKs.
ALTER TABLE "scenarios" DROP CONSTRAINT IF EXISTS "scenarios_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "scenarios" DROP CONSTRAINT IF EXISTS "scenarios_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "custom_intents" DROP CONSTRAINT IF EXISTS "custom_intents_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "custom_intents" DROP CONSTRAINT IF EXISTS "custom_intents_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "actuals_overlays" DROP CONSTRAINT IF EXISTS "actuals_overlays_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "actuals_overlays" DROP CONSTRAINT IF EXISTS "actuals_overlays_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "flow_overrides" DROP CONSTRAINT IF EXISTS "flow_overrides_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "flow_overrides" DROP CONSTRAINT IF EXISTS "flow_overrides_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_cases" DROP CONSTRAINT IF EXISTS "onb_cases_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_cases" DROP CONSTRAINT IF EXISTS "onb_cases_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_events" DROP CONSTRAINT IF EXISTS "onb_events_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_events" DROP CONSTRAINT IF EXISTS "onb_events_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_approvals" DROP CONSTRAINT IF EXISTS "onb_approvals_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_approvals" DROP CONSTRAINT IF EXISTS "onb_approvals_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_communications" DROP CONSTRAINT IF EXISTS "onb_communications_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_communications" DROP CONSTRAINT IF EXISTS "onb_communications_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_system_checks" DROP CONSTRAINT IF EXISTS "onb_system_checks_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_system_checks" DROP CONSTRAINT IF EXISTS "onb_system_checks_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_settings" DROP CONSTRAINT IF EXISTS "onb_settings_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_settings" DROP CONSTRAINT IF EXISTS "onb_settings_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_connectors" DROP CONSTRAINT IF EXISTS "onb_connectors_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_connectors" DROP CONSTRAINT IF EXISTS "onb_connectors_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" DROP CONSTRAINT IF EXISTS "onb_effect_journal_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" DROP CONSTRAINT IF EXISTS "onb_effect_journal_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_documents" DROP CONSTRAINT IF EXISTS "onb_documents_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_documents" DROP CONSTRAINT IF EXISTS "onb_documents_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_call_slots" DROP CONSTRAINT IF EXISTS "onb_call_slots_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_call_slots" DROP CONSTRAINT IF EXISTS "onb_call_slots_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" DROP CONSTRAINT IF EXISTS "onb_voice_sessions_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" DROP CONSTRAINT IF EXISTS "onb_voice_sessions_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" DROP CONSTRAINT IF EXISTS "onb_watch_emails_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" DROP CONSTRAINT IF EXISTS "onb_watch_emails_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_employee_records" DROP CONSTRAINT IF EXISTS "onb_employee_records_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_employee_records" DROP CONSTRAINT IF EXISTS "onb_employee_records_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" DROP CONSTRAINT IF EXISTS "onb_guardrail_events_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" DROP CONSTRAINT IF EXISTS "onb_guardrail_events_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" DROP CONSTRAINT IF EXISTS "custom_intent_routing_labels_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" DROP CONSTRAINT IF EXISTS "custom_intent_routing_labels_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "pricing_rate_sets" DROP CONSTRAINT IF EXISTS "pricing_rate_sets_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "pricing_rate_sets" DROP CONSTRAINT IF EXISTS "pricing_rate_sets_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "pricing_sheets" DROP CONSTRAINT IF EXISTS "pricing_sheets_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "pricing_sheets" DROP CONSTRAINT IF EXISTS "pricing_sheets_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "ea_assessments" DROP CONSTRAINT IF EXISTS "ea_assessments_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "ea_assessments" DROP CONSTRAINT IF EXISTS "ea_assessments_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" DROP CONSTRAINT IF EXISTS "onb_watch_emails_organization_case_fk";
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" DROP CONSTRAINT IF EXISTS "onb_watch_emails_organization_check_fk";
--> statement-breakpoint
ALTER TABLE "onb_documents" DROP CONSTRAINT IF EXISTS "onb_documents_case_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_call_slots" DROP CONSTRAINT IF EXISTS "onb_call_slots_case_id_fkey";
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" DROP CONSTRAINT IF EXISTS "onb_guardrail_events_case_id_fkey";
--> statement-breakpoint
ALTER TABLE "scenarios" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "custom_intents" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "actuals_overlays" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "flow_overrides" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_cases" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_events" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_approvals" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_communications" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_system_checks" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_settings" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_connectors" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_effect_journal" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_documents" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_call_slots" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_voice_sessions" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_watch_emails" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_employee_records" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "onb_guardrail_events" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "custom_intent_routing_labels" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "pricing_rate_sets" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "pricing_sheets" ALTER COLUMN "organization_id" SET DEFAULT 'demo';
--> statement-breakpoint
ALTER TABLE "ea_assessments" ALTER COLUMN "organization_id" SET DEFAULT 'demo';