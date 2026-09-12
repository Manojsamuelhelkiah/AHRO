-- Normalize receipt uniqueness after the additive generation migration.
-- Historical databases may have a constraint-backed provider index, may have
-- lost the original organization/key uniqueness during 0048, and may have a
-- NULL config_generation default after the earlier 0053 shape. This reviewed
-- forward repair preserves all receipt rows and append-only triggers while
-- converging those schemas on the canonical index representation.

ALTER TABLE "onb_audit_anchor_receipts"
  DROP CONSTRAINT IF EXISTS "onb_audit_anchor_receipts_organization_idempotency_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "onb_audit_anchor_receipts_organization_idempotency_unique";
--> statement-breakpoint
ALTER TABLE "onb_audit_anchor_receipts"
  DROP CONSTRAINT IF EXISTS "onb_audit_anchor_receipts_organization_idempotency_provider_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "onb_audit_anchor_receipts_organization_idempotency_provider_unique";
--> statement-breakpoint
ALTER TABLE "onb_audit_anchor_receipts"
  DROP CONSTRAINT IF EXISTS "onb_audit_anchor_receipts_organization_idempotency_provider_generation_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "onb_audit_anchor_receipts_organization_idempotency_provider_generation_unique";
--> statement-breakpoint
ALTER TABLE "onb_audit_anchor_receipts"
  ALTER COLUMN "config_generation" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "onb_audit_anchor_receipts"
  DROP CONSTRAINT IF EXISTS "onb_audit_anchor_receipts_generation_check";
--> statement-breakpoint
ALTER TABLE "onb_audit_anchor_receipts"
  ADD CONSTRAINT "onb_audit_anchor_receipts_generation_check"
  CHECK ("config_generation" >= 0);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_audit_anchor_receipts_organization_idempotency_provider_generation_unique"
  ON "onb_audit_anchor_receipts"
    ("organization_id", "idempotency_key", "provider_id", "config_generation");
