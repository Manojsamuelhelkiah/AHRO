ALTER TABLE "onb_communications"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "onb_communications_organization_idempotency_key_idx"
  ON "onb_communications" ("organization_id", "idempotency_key");