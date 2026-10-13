CREATE TABLE agent_catalogue_bindings (
 organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 catalogue_key text NOT NULL,
 catalogue_version text NOT NULL,
 agent_id text NOT NULL,
 principal_version integer NOT NULL,
 version integer NOT NULL DEFAULT 1,
 request_id text NOT NULL,
 request_digest text NOT NULL,
 actor_user_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, catalogue_key),
 CONSTRAINT agent_catalogue_bindings_principal_unique UNIQUE (organization_id, agent_id),
 CONSTRAINT agent_catalogue_bindings_request_unique UNIQUE (organization_id, request_id),
 FOREIGN KEY (organization_id, agent_id) REFERENCES access_agents(organization_id, id),
 CONSTRAINT agent_catalogue_bindings_versions_check CHECK (version > 0 AND principal_version > 0)
);
--> statement-breakpoint
CREATE TABLE agent_catalogue_setup_receipts (
 organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 request_id text NOT NULL,
 request_digest text NOT NULL,
 catalogue_key text NOT NULL,
 binding_version integer NOT NULL,
 PRIMARY KEY (organization_id, request_id)
);
