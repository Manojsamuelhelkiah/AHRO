ALTER TABLE "hro_mailbox_ingress" ADD COLUMN IF NOT EXISTS "mailbox_address" text;
--> statement-breakpoint
ALTER TABLE "hro_mailbox_ingress" ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hro_mailbox_ingress" ADD COLUMN IF NOT EXISTS "backfill_from" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hro_mailbox_ingress" ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hro_email_requests" (
  "id" text PRIMARY KEY,
  "organization_id" text REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "ingress_id" text REFERENCES "hro_mailbox_ingress"("id") ON DELETE RESTRICT,
  "route_revision" integer, "mailbox_address" text NOT NULL, "provider_message_id" text NOT NULL,
  "template_id" text, "fields" jsonb NOT NULL DEFAULT '{}', "field_sources" jsonb NOT NULL DEFAULT '{}',
  "attachments" jsonb NOT NULL DEFAULT '[]', "status" text NOT NULL DEFAULT 'received', "reason" text,
  "version" integer NOT NULL DEFAULT 1, "case_id" integer REFERENCES "onb_cases"("id") ON DELETE RESTRICT,
  "case_kind" text, "reviewed_by" text, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "hro_email_route_tenant_fk" FOREIGN KEY ("organization_id","ingress_id") REFERENCES "hro_mailbox_ingress"("organization_id","id") ON DELETE RESTRICT,
  CONSTRAINT "hro_email_case_tenant_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE RESTRICT,
  CONSTRAINT "hro_email_attribution" CHECK (("organization_id" IS NULL AND "ingress_id" IS NULL AND "fields" = '{}'::jsonb) OR ("organization_id" IS NOT NULL AND "ingress_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hro_email_provider_once" ON "hro_email_requests" ("mailbox_address","provider_message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hro_email_case_once" ON "hro_email_requests" ("organization_id","case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hro_email_tenant_queue" ON "hro_email_requests" ("organization_id","created_at","id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hro_email_scan" (
  "mailbox_address" text PRIMARY KEY, "query" text NOT NULL, "page_token" text,
  "cycle_until" timestamptz NOT NULL, "last_success_at" timestamptz,
  "last_error" text, "processed" integer NOT NULL DEFAULT 0,
  "watermark_at" timestamptz, "routes_revision" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hro_email_sources" (
  "id" text PRIMARY KEY, "request_id" text NOT NULL REFERENCES "hro_email_requests"("id") ON DELETE RESTRICT,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL, "object_path" text NOT NULL, "state" text NOT NULL DEFAULT 'reserved',
  "checksum" text, "byte_size" integer, "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hro_email_source_path" ON "hro_email_sources" ("object_path");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hro_email_source_once" ON "hro_email_sources" ("request_id","kind");
