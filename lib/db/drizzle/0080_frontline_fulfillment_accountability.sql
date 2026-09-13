ALTER TABLE "onb_frontline_fulfillments" ADD COLUMN "acknowledgement_recipient_reference" text;
--> statement-breakpoint
ALTER TABLE "onb_frontline_fulfillments" ADD COLUMN "acknowledgement_method" text;
--> statement-breakpoint
ALTER TABLE "onb_frontline_fulfillments" ADD COLUMN "policy_snapshot_reference" text;