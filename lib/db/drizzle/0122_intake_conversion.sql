ALTER TABLE agent_catalogue_bindings ADD COLUMN intake_authorization jsonb;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN automation_generation integer;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN automation_state text;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN automation_reason text;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN automation_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN automation_retry_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN conversion_origin text;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN conversion_agent_id text;
--> statement-breakpoint
ALTER TABLE hro_email_requests ADD COLUMN conversion_owner_user_id text;
--> statement-breakpoint
CREATE INDEX hro_email_automation_pending ON hro_email_requests (automation_retry_at, created_at, id)
  WHERE automation_state = 'pending';
