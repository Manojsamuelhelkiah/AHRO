ALTER TABLE access_user_groups ADD COLUMN IF NOT EXISTS starter_id text;
--> statement-breakpoint
ALTER TABLE access_user_groups ADD CONSTRAINT access_user_groups_org_starter_unique UNIQUE (organization_id, starter_id);
