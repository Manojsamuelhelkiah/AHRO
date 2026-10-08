CREATE TABLE "hro_context_retention_policies" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "enabled" boolean NOT NULL,
  "retention_days" integer NOT NULL CHECK ("retention_days" BETWEEN 0 AND 3650),
  "purpose" text NOT NULL,
  "lawful_basis" text NOT NULL,
  "policy_reference" text NOT NULL,
  "approval_reference" text NOT NULL,
  "approved_by_user_id" text NOT NULL,
  "approved_authority_assignment_id" integer NOT NULL,
  "approved_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "hro_context_retention_revision_unique"
  ON "hro_context_retention_policies" ("organization_id", "revision");
CREATE TABLE "hro_context_retention_state" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organizations"("id"),
  "last_sweep_at" timestamptz NOT NULL,
  "policy_revision" integer NOT NULL,
  "outcome" text NOT NULL,
  "transactions_pruned" integer NOT NULL DEFAULT 0,
  "steps_pruned" integer NOT NULL DEFAULT 0,
  "anchors_pruned" integer NOT NULL DEFAULT 0
);
CREATE INDEX "hro_context_transactions_correlation_idx"
  ON "hro_context_transactions" ("organization_id", "correlation_id");
CREATE INDEX "hro_context_transactions_parent_idx"
  ON "hro_context_transactions" ("organization_id", "parent_transaction_id");
