ALTER TABLE onb_approvals ADD COLUMN permission_decision jsonb;
--> statement-breakpoint
ALTER TABLE onb_outcome_evidence_authority_receipts ADD COLUMN permission_decision jsonb;
--> statement-breakpoint
CREATE TABLE human_permission_decisions (
  id serial PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL,
  reviewed_revision integer NOT NULL CONSTRAINT human_permission_decisions_revision_check CHECK (reviewed_revision >= 0),
  "authorization" jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX human_permission_decisions_org_id_idx ON human_permission_decisions (organization_id, id);
