ALTER TABLE "employee_vault_receipts" ADD COLUMN IF NOT EXISTS "last_evaluated_at" timestamp with time zone NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS employee_vault_receipts_reconciliation_idx ON employee_vault_receipts (last_evaluated_at);
