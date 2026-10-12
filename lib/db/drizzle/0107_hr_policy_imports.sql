CREATE TABLE onb_hr_policy_imports (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  uploaded_by_user_id text NOT NULL,
  filename text NOT NULL,
  media_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  sha256 text NOT NULL,
  object_path text NOT NULL,
  status text NOT NULL CONSTRAINT onb_hr_policy_import_status_check CHECK (status IN ('processing','quarantined','ready','consumed','discarded')),
  malware_verdict text NOT NULL DEFAULT 'pending',
  extraction jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX onb_hr_policy_import_tenant_idx ON onb_hr_policy_imports(organization_id, created_at);
--> statement-breakpoint
ALTER TABLE onb_hr_policy_versions ADD COLUMN import_provenance jsonb;
