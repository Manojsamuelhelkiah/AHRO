ALTER TABLE hro_mailbox_ingress ADD COLUMN retired_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE hro_mailbox_ingress ADD COLUMN replacement_of_id text;
--> statement-breakpoint
ALTER TABLE hro_mailbox_ingress ADD COLUMN rotation_reference text;
--> statement-breakpoint
CREATE UNIQUE INDEX hro_mailbox_one_replacement ON hro_mailbox_ingress (replacement_of_id);
--> statement-breakpoint
ALTER TABLE hro_mailbox_ingress ADD CONSTRAINT hro_mailbox_replacement_tenant_fk FOREIGN KEY (organization_id, replacement_of_id) REFERENCES hro_mailbox_ingress (organization_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN original_ingress_id text;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN original_route_revision integer;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN routing_admissions jsonb NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD CONSTRAINT hro_email_original_route_tenant_fk FOREIGN KEY (organization_id, original_ingress_id) REFERENCES hro_mailbox_ingress (organization_id, id) ON DELETE RESTRICT;
