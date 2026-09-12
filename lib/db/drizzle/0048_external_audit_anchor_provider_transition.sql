-- Permit a client-operated provider to add its own independently verifiable
-- receipt after simulation delivery. Provider-visible keys include the
-- provider, generation, and context, so the original organization/key
-- uniqueness remains safe and need not be dropped.
--
-- A unique index is intentionally additive and replay-safe. It also gives
-- receipt inserts a stable three-column conflict target on fresh schemas.
CREATE UNIQUE INDEX IF NOT EXISTS "onb_audit_anchor_receipts_organization_idempotency_provider_unique"
  ON "onb_audit_anchor_receipts" ("organization_id", "idempotency_key", "provider_id");
