CREATE TABLE IF NOT EXISTS uat_admissions (
  token_hash text PRIMARY KEY,
  kind text NOT NULL,
  user_id text,
  session_id text,
  organization_id text,
  request_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS uat_admission_attempt_idx ON uat_admissions(request_key, created_at);
