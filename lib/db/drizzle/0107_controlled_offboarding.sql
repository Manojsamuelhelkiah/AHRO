CREATE TABLE IF NOT EXISTS "offb_cases" (
  "id" integer PRIMARY KEY REFERENCES "onb_cases"("id") ON DELETE RESTRICT,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "employee_id" text NOT NULL, "version" integer NOT NULL DEFAULT 1,
  "generation" integer NOT NULL DEFAULT 1, "status" text NOT NULL DEFAULT 'held',
  "active_key" text, "facts" jsonb NOT NULL, "state" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "offb_finalization_unavailable" CHECK ("status" IN ('held','restricted','active','paused','cancelled','transfer-review','closure-preparation') AND "state"->>'closureBlocker' = 'section-4.6-pending'),
  CONSTRAINT "offb_active_key_required" CHECK (("status" IN ('cancelled','transfer-review') AND "active_key" IS NULL) OR ("status" NOT IN ('cancelled','transfer-review') AND "active_key" = "employee_id")),
  CONSTRAINT "offb_case_tenant_fk" FOREIGN KEY ("organization_id","id") REFERENCES "onb_cases"("organization_id","id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "offb_one_active_employee" ON "offb_cases" ("organization_id","active_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "offb_case_tenant_unique" ON "offb_cases" ("organization_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offb_tenant_cases" ON "offb_cases" ("organization_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offb_sources" (
  "id" text PRIMARY KEY, "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "case_id" integer NOT NULL REFERENCES "offb_cases"("id") ON DELETE RESTRICT,
  "channel" text NOT NULL, "source_reference" text NOT NULL, "fingerprint" text NOT NULL,
  "facts" jsonb NOT NULL, "actor" text NOT NULL, "provenance" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "offb_source_tenant_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "offb_cases"("organization_id","id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "offb_source_retry" ON "offb_sources" ("organization_id","channel","source_reference");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offb_policies" (
  "id" text NOT NULL, "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL, "policy" jsonb NOT NULL, "status" text NOT NULL DEFAULT 'proposal',
  "approval" jsonb, "created_by" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "offb_policy_version" ON "offb_policies" ("organization_id","id","version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hro_mailbox_ingress" (
  "id" text PRIMARY KEY, "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "token" text NOT NULL, "allowed_senders" jsonb NOT NULL, "approval" jsonb NOT NULL,
  "created_by" text NOT NULL, "enabled" integer NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hro_mailbox_token" ON "hro_mailbox_ingress" ("token");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hro_mailbox_requests" (
  "id" text PRIMARY KEY, "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "ingress_id" text NOT NULL REFERENCES "hro_mailbox_ingress"("id") ON DELETE RESTRICT,
  "provider_message_id" text NOT NULL, "sender" text NOT NULL, "fields" jsonb NOT NULL,
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb, "status" text NOT NULL DEFAULT 'pending-review',
  "case_id" integer REFERENCES "offb_cases"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "hro_mailbox_case_tenant_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "offb_cases"("organization_id","id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hro_mailbox_message_once" ON "hro_mailbox_requests" ("provider_message_id");
--> statement-breakpoint
ALTER TABLE "onb_cases" ADD CONSTRAINT "onb_separation_envelope_no_completion" CHECK ("hire_type" <> 'separation' OR ("lifecycle_stage" LIKE 'separation-%' AND "orchestration_status" = 'separation-only' AND "offer_acceptance_complete" = false));
