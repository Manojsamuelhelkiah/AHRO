-- Additive operator-history seek indexes. No business records or permissions change.
CREATE INDEX IF NOT EXISTS "hro_context_history_idx" ON "hro_context_transactions" ("organization_id", "started_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hro_context_history_workflow_idx" ON "hro_context_transactions" ("organization_id", "workflow", "started_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hro_context_history_status_idx" ON "hro_context_transactions" ("organization_id", "status", "started_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hro_context_history_workflow_status_idx" ON "hro_context_transactions" ("organization_id", "workflow", "status", "started_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hro_context_history_correlation_idx" ON "hro_context_transactions" ("organization_id", "correlation_id", "started_at" DESC, "id" DESC);
