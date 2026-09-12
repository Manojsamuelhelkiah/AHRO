-- Permit a client-operated provider to add its own independently verifiable
-- receipt after simulation delivery. Existing receipts remain append-only.

ALTER TABLE "onb_audit_anchor_receipts"
  DROP CONSTRAINT IF EXISTS "onb_audit_anchor_receipts_organization_idempotency_unique";
--> statement-breakpoint
ALTER TABLE "onb_audit_anchor_receipts"
  ADD CONSTRAINT "onb_audit_anchor_receipts_organization_idempotency_provider_unique"
  UNIQUE ("organization_id", "idempotency_key", "provider_id");