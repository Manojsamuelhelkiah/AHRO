-- 0055 intentionally retained only the server-owned BGV idempotency
-- namespace. SQL three-valued logic meant NULL keys were not covered there;
-- correct those ambiguous legacy rows conservatively as well.
UPDATE "onb_communications"
SET "sensitive_data_class" = 'unclassified-legacy'
WHERE "sensitive_data_class" = 'bgv'
  AND ("idempotency_key" IS NULL OR "idempotency_key" !~ '^bgv:');