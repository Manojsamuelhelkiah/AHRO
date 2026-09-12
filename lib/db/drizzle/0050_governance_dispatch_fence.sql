CREATE TABLE IF NOT EXISTS "onb_governance_dispatch_markers" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "dispatch_id" text NOT NULL UNIQUE,
  "operation" text NOT NULL,
  "status" text NOT NULL,
  "claim_owner" text NOT NULL,
  "fence" jsonb NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finalized_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onb_governance_dispatch_one_active_per_org"
  ON "onb_governance_dispatch_markers" ("organization_id")
  WHERE "status" IN ('dispatching', 'ambiguous');