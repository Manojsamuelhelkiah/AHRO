ALTER TABLE "onb_transfer_integration_actions" ADD COLUMN "completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "onb_transfer_integration_actions" ADD COLUMN "legal_approval_assignment_id" text;
--> statement-breakpoint
ALTER TABLE "onb_transfer_integration_actions" ADD COLUMN "legal_approval_assignment_revision" integer;
--> statement-breakpoint
ALTER TABLE "onb_transfer_integration_actions" ADD COLUMN "policy_approved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "onb_transfer_integration_actions" ADD CONSTRAINT "onb_transfer_integration_completed_at_check" CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "onb_transfer_integration_actions" DROP CONSTRAINT "onb_transfer_harmonisation_approval_check";
--> statement-breakpoint
ALTER TABLE "onb_transfer_integration_actions" ADD CONSTRAINT "onb_transfer_harmonisation_approval_check" CHECK ("kind" <> 'harmonisation' OR ("legal_approval_reference" IS NOT NULL AND "legal_approval_assignment_id" IS NOT NULL AND "legal_approval_assignment_revision" IS NOT NULL AND "policy_approved_at" IS NOT NULL));