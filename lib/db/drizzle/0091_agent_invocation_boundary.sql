CREATE TABLE "agent_invocation_audit" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "agent_id" text,
  "agent_version" integer,
  "initiating_user_id" text NOT NULL,
  "run_id" text NOT NULL,
  "correlation_id" text NOT NULL,
  "delegated_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "case_id" integer,
  "purpose" text NOT NULL,
  "tool_key" text NOT NULL,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "reason_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_invocation_audit_outcome_check"
    CHECK ("outcome" IN ('success', 'denied', 'failure')),
  CONSTRAINT "agent_invocation_audit_version_check"
    CHECK ("agent_version" IS NULL OR "agent_version" > 0)
);
CREATE INDEX "agent_invocation_audit_tenant_created_idx"
  ON "agent_invocation_audit" ("organization_id", "created_at");
CREATE INDEX "agent_invocation_audit_agent_run_idx"
  ON "agent_invocation_audit" ("organization_id", "agent_id", "run_id");
CREATE UNIQUE INDEX "agent_invocation_audit_success_replay_uq"
  ON "agent_invocation_audit" ("organization_id", "run_id", "tool_key", "case_id")
  WHERE "outcome" = 'success';