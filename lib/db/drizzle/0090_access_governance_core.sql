CREATE TABLE "access_agents" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "owner_user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "created_by_user_id" text NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "access_agents_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "access_agents_org_name_unique" UNIQUE ("organization_id", "name"),
  CONSTRAINT "access_agents_owner_membership_fk" FOREIGN KEY ("organization_id", "owner_user_id")
    REFERENCES "organization_memberships"("organization_id", "clerk_user_id"),
  CONSTRAINT "access_agents_status_check" CHECK ("status" in ('active', 'retired')),
  CONSTRAINT "access_agents_version_check" CHECK ("version" > 0)
);
CREATE INDEX "access_agents_org_active_idx" ON "access_agents" ("organization_id", "revoked_at");

CREATE TABLE "access_user_groups" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "access_user_groups_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "access_user_groups_org_name_unique" UNIQUE ("organization_id", "name"),
  CONSTRAINT "access_user_groups_owner_membership_fk" FOREIGN KEY ("organization_id", "owner_user_id")
    REFERENCES "organization_memberships"("organization_id", "clerk_user_id"),
  CONSTRAINT "access_user_groups_status_check" CHECK ("status" in ('active', 'retired')),
  CONSTRAINT "access_user_groups_version_check" CHECK ("version" > 0)
);
CREATE TABLE "access_user_group_members" (
  "organization_id" text NOT NULL,
  "group_id" text NOT NULL,
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "requires_approval" text NOT NULL DEFAULT 'no',
  "attached_by_user_id" text NOT NULL,
  "approved_by_user_id" text,
  "approved_at" timestamptz,
  "revoked_by_user_id" text,
  "revoked_at" timestamptz,
  "added_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "access_user_group_members_pkey" PRIMARY KEY ("organization_id", "group_id", "principal_type", "principal_id"),
  CONSTRAINT "access_user_group_members_group_fk" FOREIGN KEY ("organization_id", "group_id")
    REFERENCES "access_user_groups"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_user_group_members_principal_type_check" CHECK ("principal_type" in ('human', 'agent')),
  CONSTRAINT "access_user_group_members_status_check" CHECK ("status" in ('pending', 'active', 'revoked')),
  CONSTRAINT "access_user_group_members_version_check" CHECK ("version" > 0),
  CONSTRAINT "access_user_group_members_requires_approval_check" CHECK ("requires_approval" in ('yes', 'no')),
  CONSTRAINT "access_user_group_members_approval_pair_check" CHECK (
    ("approved_by_user_id" IS NULL AND "approved_at" IS NULL) OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL)
  ),
  CONSTRAINT "access_user_group_members_approval_required_check" CHECK (
    "status" <> 'active' OR "requires_approval" = 'no' OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by_user_id" <> "attached_by_user_id")
  )
);
CREATE INDEX "access_user_group_members_principal_idx" ON "access_user_group_members" ("organization_id", "principal_type", "principal_id");

CREATE TABLE "access_security_groups" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "access_security_groups_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "access_security_groups_org_name_unique" UNIQUE ("organization_id", "name"),
  CONSTRAINT "access_security_groups_owner_membership_fk" FOREIGN KEY ("organization_id", "owner_user_id")
    REFERENCES "organization_memberships"("organization_id", "clerk_user_id"),
  CONSTRAINT "access_security_groups_status_check" CHECK ("status" in ('active', 'retired')),
  CONSTRAINT "access_security_groups_version_check" CHECK ("version" > 0)
);
CREATE TABLE "access_security_group_policies" (
  "organization_id" text NOT NULL,
  "security_group_id" text NOT NULL,
  "version" integer NOT NULL,
  "policy" jsonb NOT NULL,
  "created_by_user_id" text NOT NULL,
  "approved_by_user_id" text,
  "approved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "access_security_group_policies_pkey" PRIMARY KEY ("organization_id", "security_group_id", "version"),
  CONSTRAINT "access_security_group_policies_group_fk" FOREIGN KEY ("organization_id", "security_group_id")
    REFERENCES "access_security_groups"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_security_group_policies_version_check" CHECK ("version" > 0),
  CONSTRAINT "access_security_group_policies_approval_pair_check" CHECK (
    ("approved_by_user_id" IS NULL AND "approved_at" IS NULL) OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL)
  )
);
CREATE INDEX "access_security_group_policies_current_idx" ON "access_security_group_policies" ("organization_id", "security_group_id", "version");

CREATE TABLE "access_security_group_user_groups" (
  "organization_id" text NOT NULL,
  "security_group_id" text NOT NULL,
  "user_group_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "requires_approval" text NOT NULL DEFAULT 'no',
  "approved_by_user_id" text,
  "approved_at" timestamptz,
  "approved_policy_version" integer,
  "attached_by_user_id" text NOT NULL,
  "attached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "access_security_group_user_groups_pkey" PRIMARY KEY ("organization_id", "security_group_id", "user_group_id"),
  CONSTRAINT "access_security_group_user_groups_security_group_fk" FOREIGN KEY ("organization_id", "security_group_id")
    REFERENCES "access_security_groups"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_security_group_user_groups_user_group_fk" FOREIGN KEY ("organization_id", "user_group_id")
    REFERENCES "access_user_groups"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_security_group_user_groups_status_check" CHECK ("status" in ('active', 'revoked')),
  CONSTRAINT "access_security_group_user_groups_version_check" CHECK ("version" > 0),
  CONSTRAINT "access_security_group_user_groups_requires_approval_check" CHECK ("requires_approval" in ('yes', 'no')),
  CONSTRAINT "access_security_group_user_groups_approval_pair_check" CHECK (
    ("approved_by_user_id" IS NULL AND "approved_at" IS NULL AND "approved_policy_version" IS NULL) OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_policy_version" IS NOT NULL)
  ),
  CONSTRAINT "access_security_group_user_groups_approval_required_check" CHECK (
    "status" <> 'active' OR "requires_approval" = 'no' OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by_user_id" <> "attached_by_user_id")
  )
);

CREATE TABLE "access_security_group_attachments" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "security_group_id" text NOT NULL,
  "scope" text NOT NULL,
  "case_id" integer,
  "status" text NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "requires_approval" text NOT NULL DEFAULT 'no',
  "attached_by_user_id" text NOT NULL,
  "approved_by_user_id" text,
  "approved_at" timestamptz,
  "approved_policy_version" integer,
  "attached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "access_security_group_attachments_security_group_fk" FOREIGN KEY ("organization_id", "security_group_id")
    REFERENCES "access_security_groups"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_security_group_attachments_organization_case_fk" FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_security_group_attachments_scope_check" CHECK (
    ("scope" = 'tenant' AND "case_id" IS NULL) OR ("scope" = 'case' AND "case_id" IS NOT NULL)
  ),
  CONSTRAINT "access_security_group_attachments_status_check" CHECK ("status" in ('active', 'pending', 'rejected', 'revoked')),
  CONSTRAINT "access_security_group_attachments_version_check" CHECK ("version" > 0),
  CONSTRAINT "access_security_group_attachments_requires_approval_check" CHECK ("requires_approval" in ('yes', 'no')),
  CONSTRAINT "access_security_group_attachments_approval_pair_check" CHECK (
    ("approved_by_user_id" IS NULL AND "approved_at" IS NULL AND "approved_policy_version" IS NULL) OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_policy_version" IS NOT NULL)
  ),
  CONSTRAINT "access_security_group_attachments_approval_required_check" CHECK (
    "status" <> 'active' OR "requires_approval" = 'no' OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by_user_id" <> "attached_by_user_id")
  )
);
CREATE UNIQUE INDEX "access_security_group_attachments_tenant_unique"
  ON "access_security_group_attachments" ("organization_id", "security_group_id") WHERE "scope" = 'tenant';
CREATE UNIQUE INDEX "access_security_group_attachments_case_unique"
  ON "access_security_group_attachments" ("organization_id", "security_group_id", "case_id") WHERE "scope" = 'case';
CREATE INDEX "access_security_group_attachments_case_idx" ON "access_security_group_attachments" ("organization_id", "case_id");

CREATE TABLE "access_principal_security_group_attachments" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "security_group_id" text NOT NULL,
  "scope" text NOT NULL,
  "case_id" integer,
  "status" text NOT NULL DEFAULT 'pending',
  "version" integer NOT NULL DEFAULT 1,
  "requires_approval" text NOT NULL DEFAULT 'yes',
  "attached_by_user_id" text NOT NULL,
  "approved_by_user_id" text,
  "approved_at" timestamptz,
  "approved_policy_version" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  CONSTRAINT "access_principal_security_group_attachments_security_group_fk" FOREIGN KEY ("organization_id", "security_group_id")
    REFERENCES "access_security_groups"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_principal_security_group_attachments_organization_case_fk" FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_principal_security_group_attachments_principal_type_check" CHECK ("principal_type" in ('human', 'agent')),
  CONSTRAINT "access_principal_security_group_attachments_scope_check" CHECK (
    ("scope" = 'tenant' AND "case_id" IS NULL) OR ("scope" = 'case' AND "case_id" IS NOT NULL)
  ),
  CONSTRAINT "access_principal_security_group_attachments_status_check" CHECK ("status" in ('active', 'pending', 'rejected', 'revoked')),
  CONSTRAINT "access_principal_security_group_attachments_version_check" CHECK ("version" > 0),
  CONSTRAINT "access_principal_security_group_attachments_requires_approval_check" CHECK ("requires_approval" in ('yes', 'no')),
  CONSTRAINT "access_principal_security_group_attachments_approval_pair_check" CHECK (
    ("approved_by_user_id" IS NULL AND "approved_at" IS NULL AND "approved_policy_version" IS NULL) OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_policy_version" IS NOT NULL)
  ),
  CONSTRAINT "access_principal_security_group_attachments_approval_required_check" CHECK (
    "status" <> 'active' OR "requires_approval" = 'no' OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by_user_id" <> "attached_by_user_id")
  )
);
CREATE INDEX "access_principal_security_group_attachments_lookup_idx"
  ON "access_principal_security_group_attachments" ("organization_id", "principal_type", "principal_id", "status", "revoked_at");
CREATE UNIQUE INDEX "access_principal_security_group_attachments_tenant_unique"
  ON "access_principal_security_group_attachments" ("organization_id", "principal_type", "principal_id", "security_group_id")
  WHERE "scope" = 'tenant';
CREATE UNIQUE INDEX "access_principal_security_group_attachments_case_unique"
  ON "access_principal_security_group_attachments" ("organization_id", "principal_type", "principal_id", "security_group_id", "case_id")
  WHERE "scope" = 'case';

CREATE TABLE "access_named_grants" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "scope" text NOT NULL,
  "case_id" integer,
  "resource_type" text NOT NULL,
  "resource_key" text NOT NULL,
  "source" text NOT NULL DEFAULT 'security-group',
  "security_group_id" text,
  "effect" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "requires_approval" text NOT NULL DEFAULT 'no',
  "created_by_user_id" text NOT NULL,
  "approved_by_user_id" text,
  "approved_at" timestamptz,
  "revoked_by_user_id" text,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "access_named_grants_organization_case_fk" FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "onb_cases"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_named_grants_security_group_fk" FOREIGN KEY ("organization_id", "security_group_id")
    REFERENCES "access_security_groups"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "access_named_grants_principal_type_check" CHECK ("principal_type" in ('human', 'agent')),
  CONSTRAINT "access_named_grants_scope_check" CHECK (
    ("scope" = 'tenant' AND "case_id" IS NULL) OR ("scope" = 'case' AND "case_id" IS NOT NULL)
  ),
  CONSTRAINT "access_named_grants_resource_type_check" CHECK ("resource_type" in ('field', 'flow', 'tool')),
  CONSTRAINT "access_named_grants_source_check" CHECK ("source" in ('named', 'security-group')),
  CONSTRAINT "access_named_grants_effect_check" CHECK ("effect" in ('allow', 'deny')),
  CONSTRAINT "access_named_grants_status_check" CHECK ("status" in ('pending', 'active', 'rejected')),
  CONSTRAINT "access_named_grants_approval_human_only_check" CHECK (
    ("approved_by_user_id" IS NULL AND "approved_at" IS NULL) OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL)
  ),
  CONSTRAINT "access_named_grants_requires_approval_check" CHECK ("requires_approval" in ('yes', 'no')),
  CONSTRAINT "access_named_grants_approval_required_check" CHECK (
    "status" <> 'active' OR "requires_approval" = 'no' OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL)
  )
);
CREATE INDEX "access_named_grants_lookup_idx" ON "access_named_grants"
  ("organization_id", "principal_type", "principal_id", "scope", "case_id", "status", "revoked_at");

CREATE TABLE "access_governance_history" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "actor_user_id" text,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "access_governance_history_org_created_idx" ON "access_governance_history" ("organization_id", "created_at");
CREATE INDEX "access_governance_history_entity_idx" ON "access_governance_history" ("organization_id", "entity_type", "entity_id");
