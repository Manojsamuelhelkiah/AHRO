CREATE TABLE "hro_context_anchors" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "subject_type" text NOT NULL,
  "subject_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "hro_context_anchor_subject_unique"
  ON "hro_context_anchors" ("organization_id", "subject_type", "subject_hash");
CREATE UNIQUE INDEX "hro_context_anchor_org_id_unique"
  ON "hro_context_anchors" ("organization_id", "id");

CREATE TABLE "hro_context_transactions" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "anchor_id" text NOT NULL,
  "parent_transaction_id" text,
  "correlation_id" text NOT NULL,
  "workflow" text NOT NULL,
  "initiator_type" text NOT NULL,
  "initiating_user_id" text,
  "executor_type" text NOT NULL,
  "agent_id" text,
  "agent_version" integer,
  "status" text NOT NULL DEFAULT 'running',
  "version" integer NOT NULL DEFAULT 1,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "hro_context_transaction_anchor_fk" FOREIGN KEY ("organization_id", "anchor_id")
    REFERENCES "hro_context_anchors"("organization_id", "id"),
  CONSTRAINT "hro_context_identity_check" CHECK (
    ("initiator_type" = 'human' AND "initiating_user_id" IS NOT NULL) OR
    ("initiator_type" = 'system' AND "initiating_user_id" IS NULL)
  ),
  CONSTRAINT "hro_context_executor_check" CHECK (
    ("executor_type" IN ('human', 'system') AND "agent_id" IS NULL AND "agent_version" IS NULL) OR
    ("executor_type" = 'agent' AND "agent_id" IS NOT NULL AND "agent_version" > 0)
  ),
  CONSTRAINT "hro_context_status_check" CHECK ("status" IN ('running', 'completed', 'failed')),
  CONSTRAINT "hro_context_version_check" CHECK ("version" > 0)
);
CREATE INDEX "hro_context_transactions_actor_idx"
  ON "hro_context_transactions" ("organization_id", "initiating_user_id", "started_at");
CREATE UNIQUE INDEX "hro_context_transaction_org_id_unique"
  ON "hro_context_transactions" ("organization_id", "id");
CREATE INDEX "hro_context_transactions_anchor_idx"
  ON "hro_context_transactions" ("organization_id", "anchor_id", "started_at");

CREATE TABLE "hro_context_steps" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "transaction_id" text NOT NULL,
  "code" text NOT NULL,
  "reference_hash" text,
  "metrics" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "hro_context_step_transaction_fk" FOREIGN KEY ("organization_id", "transaction_id")
    REFERENCES "hro_context_transactions"("organization_id", "id")
);
CREATE INDEX "hro_context_steps_transaction_idx"
  ON "hro_context_steps" ("organization_id", "transaction_id", "id");
