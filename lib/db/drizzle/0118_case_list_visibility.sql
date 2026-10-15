CREATE TABLE IF NOT EXISTS case_list_visibility (
  organization_id text NOT NULL,
  case_id integer NOT NULL,
  hidden boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CONSTRAINT case_list_visibility_version_positive CHECK (version > 0),
  PRIMARY KEY (organization_id, case_id),
  FOREIGN KEY (organization_id, case_id) REFERENCES onb_cases(organization_id, id),
  CONSTRAINT case_list_visibility_demo_only CHECK (organization_id = 'demo')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS case_list_visibility_changes (
  id serial PRIMARY KEY,
  organization_id text NOT NULL,
  case_id integer NOT NULL,
  hidden boolean NOT NULL,
  version integer NOT NULL,
  actor_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, case_id) REFERENCES onb_cases(organization_id, id),
  CONSTRAINT case_list_visibility_changes_demo_only CHECK (organization_id = 'demo')
);
