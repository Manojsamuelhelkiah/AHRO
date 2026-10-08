CREATE TABLE IF NOT EXISTS employee_vault_profiles (
 id text PRIMARY KEY, user_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_vault_policies (
 id text PRIMARY KEY, revision integer NOT NULL, approved boolean NOT NULL DEFAULT false,
 approval_reference text NOT NULL, privacy_notice text NOT NULL, storage_approved boolean NOT NULL DEFAULT false,
 scanner_approved boolean NOT NULL DEFAULT false, jurisdiction text NOT NULL, retention_days integer NOT NULL,
 receipt_retention_days integer NOT NULL, expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_vault_issuers (
 id text PRIMARY KEY, name text NOT NULL, public_key_pem text NOT NULL, allowed_kinds jsonb NOT NULL,
 jurisdictions jsonb NOT NULL, approval_reference text NOT NULL, approved boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_vault_documents (
 id text PRIMARY KEY, profile_id text NOT NULL REFERENCES employee_vault_profiles(id), name text NOT NULL,
 content_type text NOT NULL, size_bytes integer NOT NULL, revision integer NOT NULL, replaces_id text,
 object_path text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'reserved', sha256 text, scan_sha256 text,
 scan_id text, lease_until timestamptz, hold_until timestamptz, policy_revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT vault_document_profile_id_unique UNIQUE(profile_id, id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vault_document_queue_idx ON employee_vault_documents(state,lease_until);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_vault_checks (
 id text PRIMARY KEY, profile_id text NOT NULL REFERENCES employee_vault_profiles(id), kind text NOT NULL,
 jurisdiction text NOT NULL, bindings jsonb NOT NULL, state text NOT NULL DEFAULT 'unavailable',
 issuer_id text REFERENCES employee_vault_issuers(id), source_reference text, evidence_digest text,
 source_signature text, issuer_approval_reference text, verified_at timestamptz, expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT vault_check_profile_id_unique UNIQUE(profile_id,id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vault_check_profile_idx ON employee_vault_checks(profile_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_vault_audit (
 id text PRIMARY KEY, profile_id text NOT NULL REFERENCES employee_vault_profiles(id), actor_id text NOT NULL,
 action text NOT NULL, object_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_vault_products (
 organization_id text PRIMARY KEY REFERENCES organizations(id), enabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 0, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_vault_requests (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), case_id integer NOT NULL,
 employer_name text NOT NULL, purpose text NOT NULL, scope jsonb NOT NULL, jurisdiction text NOT NULL,
 requirements_digest text NOT NULL, profile_id text REFERENCES employee_vault_profiles(id),
 state text NOT NULL DEFAULT 'pending', version integer NOT NULL DEFAULT 1, document_ids jsonb NOT NULL DEFAULT '[]',
 check_ids jsonb NOT NULL DEFAULT '[]', binding_confirmed_by text, requested_by text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT vault_request_case_fk FOREIGN KEY(organization_id,case_id) REFERENCES onb_cases(organization_id,id),
 CONSTRAINT vault_request_tenant_id_unique UNIQUE(organization_id,id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vault_request_case_idx ON employee_vault_requests(organization_id,case_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_vault_receipts (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), case_id integer NOT NULL,
 request_id text NOT NULL, request_version integer NOT NULL, requirements_digest text NOT NULL,
 check_ids jsonb NOT NULL, satisfied jsonb NOT NULL, consumed_at timestamptz NOT NULL DEFAULT now(),
 retain_until timestamptz NOT NULL, invalidated_at timestamptz,
 CONSTRAINT vault_receipt_case_fk FOREIGN KEY(organization_id,case_id) REFERENCES onb_cases(organization_id,id),
 CONSTRAINT vault_receipt_request_fk FOREIGN KEY(organization_id,request_id) REFERENCES employee_vault_requests(organization_id,id),
 CONSTRAINT vault_receipt_generation_unique UNIQUE(request_id,request_version,requirements_digest)
);
