ALTER TABLE "onb_communications"
  DROP CONSTRAINT "onb_communications_sensitive_data_class_check";
--> statement-breakpoint
-- Only BGV's server-owned notification idempotency namespace is authoritative
-- for rows written before 0054. Other old sensitive email is deliberately
-- unclassified and therefore ineligible for automatic deletion.
UPDATE "onb_communications"
SET "sensitive_data_class" = 'unclassified-legacy'
WHERE "sensitive_data_class" = 'bgv'
  AND "channel" <> 'voice'
  AND "idempotency_key" !~ '^bgv:';
--> statement-breakpoint
ALTER TABLE "onb_communications"
  ADD CONSTRAINT "onb_communications_sensitive_data_class_check"
  CHECK ("sensitive_data_class" IN ('candidate-contact', 'candidate-voice', 'bgv', 'unclassified-legacy'));