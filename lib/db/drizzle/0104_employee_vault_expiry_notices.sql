ALTER TABLE employee_vault_profiles ADD COLUMN IF NOT EXISTS expiry_notices_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_vault_expiry_notices (
  id text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES employee_vault_profiles(id),
  target_type text NOT NULL,
  target_id text NOT NULL,
  target_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,
  CONSTRAINT vault_expiry_notice_generation_unique UNIQUE (profile_id, target_type, target_id, target_version, expires_at)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vault_expiry_notice_inbox_idx ON employee_vault_expiry_notices(profile_id, dismissed_at);
