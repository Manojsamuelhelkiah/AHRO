CREATE TABLE IF NOT EXISTS "offb_checkpoints" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "case_id" integer NOT NULL, "version" integer NOT NULL, "generation" integer NOT NULL,
  "status" text NOT NULL, "facts" jsonb NOT NULL, "state" jsonb NOT NULL,
  "actor" text NOT NULL, "action" text NOT NULL, "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "offb_checkpoint_tenant_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "offb_cases"("organization_id","id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "offb_checkpoint_once" ON "offb_checkpoints" ("organization_id","case_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hro_mailbox_ingress_tenant_unique" ON "hro_mailbox_ingress" ("organization_id","id");
--> statement-breakpoint
ALTER TABLE "hro_mailbox_requests" ADD CONSTRAINT "hro_mailbox_ingress_tenant_fk" FOREIGN KEY ("organization_id","ingress_id") REFERENCES "hro_mailbox_ingress"("organization_id","id") ON DELETE RESTRICT;
