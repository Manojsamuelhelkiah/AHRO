ALTER TABLE "onb_communications"
  ADD COLUMN "sensitive_data_class" text NOT NULL DEFAULT 'candidate-contact';
--> statement-breakpoint
UPDATE "onb_communications"
SET "sensitive_data_class" = CASE
  WHEN "channel" = 'voice' THEN 'candidate-voice'
  WHEN "sensitive" = true THEN 'bgv'
  ELSE 'candidate-contact'
END;
--> statement-breakpoint
ALTER TABLE "onb_communications"
  ADD CONSTRAINT "onb_communications_sensitive_data_class_check"
  CHECK ("sensitive_data_class" IN ('candidate-contact', 'candidate-voice', 'bgv'));
--> statement-breakpoint
CREATE INDEX "onb_communications_lifecycle_scan_idx"
  ON "onb_communications" ("organization_id", "sensitive_data_class", "created_at");
--> statement-breakpoint
ALTER TABLE "onb_sensitive_lifecycle_confirmations"
  ADD COLUMN "eligible_record_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "held_record_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "onb_sensitive_lifecycle_confirmations"
  ADD CONSTRAINT "onb_sensitive_lifecycle_confirmation_held_count_check"
  CHECK ("held_record_count" >= 0);