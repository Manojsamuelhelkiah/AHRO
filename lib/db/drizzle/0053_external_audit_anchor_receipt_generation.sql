-- Bind immutable provider receipts to the tenant archive configuration
-- generation. The provider-visible idempotency key includes the generation
-- and context, so the existing organization/key/provider uniqueness remains
-- sufficient without replacing or weakening any existing constraint.
--
-- This migration is intentionally additive: automatic reconciliation may
-- replay it on fresh, interrupted, or already-partially-created schemas.
ALTER TABLE "onb_audit_anchor_receipts"
  ADD COLUMN IF NOT EXISTS "config_generation" integer NOT NULL DEFAULT 0;
