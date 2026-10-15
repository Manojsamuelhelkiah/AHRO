-- Forward-only table correction: the initial restrictive tables were never
-- released for curation. Keep the prior migration bytes/ledger intact. These
-- new tables are the only tables used by the feature.
CREATE TABLE IF NOT EXISTS demo_case_list_visibility (
  organization_id text NOT NULL,
  case_id integer NOT NULL,
  hidden boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CONSTRAINT demo_case_list_visibility_version_positive CHECK (version > 0),
  PRIMARY KEY (organization_id, case_id),
  CONSTRAINT demo_case_list_visibility_organization_id_case_id_fkey
    FOREIGN KEY (organization_id, case_id) REFERENCES onb_cases(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT demo_case_list_visibility_demo_only CHECK (organization_id = 'demo')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS demo_case_list_visibility_changes (
  id serial PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  case_id integer NOT NULL,
  hidden boolean NOT NULL,
  version integer NOT NULL,
  actor_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demo_case_list_visibility_changes_demo_only CHECK (organization_id = 'demo')
);
