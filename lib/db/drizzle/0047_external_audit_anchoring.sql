-- Provider-neutral protected-audit anchoring delivery. The simulation provider
-- deliberately remains non-independent and can never satisfy launch readiness.

CREATE TABLE IF NOT EXISTS "onb_audit_anchor_outbox" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "checkpoint_sequence" integer,
  "checkpoint_hash" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "receipt_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone,
  CONSTRAINT "onb_audit_anchor_outbox_organization_idempotency_unique"
    UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "onb_audit_anchor_outbox_kind_check"
    CHECK ("kind" in ('checkpoint', 'legal_hold')),
  CONSTRAINT "onb_audit_anchor_outbox_status_check"
    CHECK ("status" in ('pending', 'sending', 'delivered', 'failed')),
  CONSTRAINT "onb_audit_anchor_outbox_checkpoint_shape_check"
    CHECK (
      ("kind" = 'checkpoint' AND "checkpoint_sequence" IS NOT NULL AND "checkpoint_hash" IS NOT NULL)
      OR ("kind" = 'legal_hold' AND "checkpoint_sequence" IS NULL AND "checkpoint_hash" IS NULL)
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_audit_anchor_outbox_due_idx"
  ON "onb_audit_anchor_outbox" ("status", "next_attempt_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_audit_anchor_outbox_organization_idx"
  ON "onb_audit_anchor_outbox" ("organization_id", "created_at", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_audit_anchor_receipts" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "outbox_id" integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "provider_id" text NOT NULL,
  "provider_kind" text NOT NULL,
  "receipt_version" integer NOT NULL,
  "checkpoint_sequence" integer,
  "checkpoint_hash" text,
  "receipt" jsonb NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "verified_at" timestamp with time zone,
  CONSTRAINT "onb_audit_anchor_receipts_organization_idempotency_unique"
    UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "onb_audit_anchor_receipts_provider_kind_check"
    CHECK ("provider_kind" in ('simulated', 'external')),
  CONSTRAINT "onb_audit_anchor_receipts_version_check"
    CHECK ("receipt_version" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_audit_anchor_receipts_organization_checkpoint_idx"
  ON "onb_audit_anchor_receipts" ("organization_id", "checkpoint_sequence", "received_at");
--> statement-breakpoint
-- Receipts are evidence, not delivery state. Corrections are represented by a
-- later receipt from the provider; ordinary application SQL cannot rewrite one.
CREATE OR REPLACE FUNCTION "onb_reject_audit_anchor_receipt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'onb_audit_anchor_receipts are append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_audit_anchor_receipts_no_update" ON "onb_audit_anchor_receipts";
--> statement-breakpoint
CREATE TRIGGER "onb_audit_anchor_receipts_no_update"
BEFORE UPDATE ON "onb_audit_anchor_receipts"
FOR EACH ROW EXECUTE FUNCTION "onb_reject_audit_anchor_receipt_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_audit_anchor_receipts_no_delete" ON "onb_audit_anchor_receipts";
--> statement-breakpoint
CREATE TRIGGER "onb_audit_anchor_receipts_no_delete"
BEFORE DELETE ON "onb_audit_anchor_receipts"
FOR EACH ROW EXECUTE FUNCTION "onb_reject_audit_anchor_receipt_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "onb_reject_audit_anchor_receipt_truncate"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'onb_audit_anchor_receipts are append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_audit_anchor_receipts_no_truncate" ON "onb_audit_anchor_receipts";
--> statement-breakpoint
CREATE TRIGGER "onb_audit_anchor_receipts_no_truncate"
BEFORE TRUNCATE ON "onb_audit_anchor_receipts"
FOR EACH STATEMENT EXECUTE FUNCTION "onb_reject_audit_anchor_receipt_truncate"();