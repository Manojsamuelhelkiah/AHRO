CREATE TABLE IF NOT EXISTS "demo_controller_setup_requests" (
  "request_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "target_clerk_user_id" text NOT NULL,
  "approval_value" text NOT NULL,
  "approval_fingerprint" text NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "approved_at" timestamp with time zone,
  "approval_source" text,
  "completed_at" timestamp with time zone,
  "membership_before" text NOT NULL,
  "membership_after" text,
  CONSTRAINT "demo_controller_setup_requests_organization_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
    ON DELETE NO ACTION,
  CONSTRAINT "demo_controller_setup_requests_source_check"
    CHECK ("approval_source" IS NULL OR "approval_source" = 'deployment-operator'),
  CONSTRAINT "demo_controller_setup_requests_membership_before_check"
    CHECK ("membership_before" = 'member'),
  CONSTRAINT "demo_controller_setup_requests_membership_after_check"
    CHECK ("membership_after" IS NULL OR "membership_after" = 'admin'),
  CONSTRAINT "demo_controller_setup_requests_approval_fields_check"
    CHECK (
      ("approved_at" IS NULL AND "approval_source" IS NULL AND "completed_at" IS NULL AND "membership_after" IS NULL)
      OR
      ("approved_at" IS NOT NULL AND "approval_source" = 'deployment-operator' AND "completed_at" IS NOT NULL AND "membership_after" = 'admin')
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_controller_setup_target_idx"
  ON "demo_controller_setup_requests"
    ("organization_id", "target_clerk_user_id", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_controller_setup_org_completed_idx"
  ON "demo_controller_setup_requests" ("organization_id", "completed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "demo_controller_setup_one_grant_per_demo_idx"
  ON "demo_controller_setup_requests" ("organization_id")
  WHERE "completed_at" IS NOT NULL;