CREATE TABLE "onb_frontline_evidence" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "kind" text NOT NULL,
  "statutory_key" text,
  "evidence_reference" text NOT NULL,
  "issuer_timestamp" timestamp with time zone NOT NULL,
  "effective_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone,
  "status" text NOT NULL,
  "authority_scope" text NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "recorded_by_user_id" text NOT NULL,
  "revocation_reference" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_frontline_evidence_organization_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_frontline_evidence_kind_check" CHECK ("kind" in ('age-proof', 'skill-certificate', 'medical-fitness', 'safety-competency', 'wage-setup', 'timesheet-setup', 'statutory-registration')),
  CONSTRAINT "onb_frontline_evidence_status_check" CHECK ("status" in ('verified', 'rejected', 'revoked')),
  CONSTRAINT "onb_frontline_evidence_expiry_check" CHECK ("expires_at" is null or "expires_at" > "effective_at"),
  CONSTRAINT "onb_frontline_evidence_statutory_key_check" CHECK (("kind" = 'statutory-registration' and "statutory_key" is not null) or ("kind" <> 'statutory-registration' and "statutory_key" is null)),
  CONSTRAINT "onb_frontline_evidence_revocation_ref_check" CHECK (("status" = 'revoked' and "revocation_reference" is not null) or ("status" <> 'revoked' and "revocation_reference" is null))
);
--> statement-breakpoint
CREATE INDEX "onb_frontline_evidence_case_kind_idx" ON "onb_frontline_evidence" ("organization_id","case_id","kind","created_at");
--> statement-breakpoint
CREATE TABLE "onb_frontline_policy_exceptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "item" text NOT NULL,
  "type" text NOT NULL,
  "policy_reference" text NOT NULL,
  "review_reference" text NOT NULL,
  "effective_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "reviewed_by_user_id" text NOT NULL,
  "revoked_at" timestamp with time zone,
  "revocation_reference" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_frontline_exception_organization_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_frontline_exception_item_check" CHECK ("item" in ('badge', 'ppe', 'uniform', 'tool', 'locker')),
  CONSTRAINT "onb_frontline_exception_type_check" CHECK ("type" in ('substitution', 'deferment')),
  CONSTRAINT "onb_frontline_exception_expiry_check" CHECK ("expires_at" is null or "expires_at" > "effective_at"),
  CONSTRAINT "onb_frontline_exception_revoke_check" CHECK (("revoked_at" is null and "revocation_reference" is null) or ("revoked_at" is not null and "revocation_reference" is not null))
);
--> statement-breakpoint
CREATE INDEX "onb_frontline_exception_current_idx" ON "onb_frontline_policy_exceptions" ("organization_id","case_id","item","type");
--> statement-breakpoint
CREATE TABLE "onb_frontline_fulfillments" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "item" text NOT NULL,
  "revision" integer NOT NULL,
  "asset_reference" text NOT NULL,
  "size" text,
  "requested_quantity" integer NOT NULL,
  "issued_quantity" integer NOT NULL,
  "issuer_timestamp" timestamp with time zone NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "status" text NOT NULL,
  "exception_id" integer,
  "issued_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_frontline_fulfillment_organization_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_frontline_fulfillment_revision_unique" UNIQUE ("organization_id","case_id","item","revision"),
  CONSTRAINT "onb_frontline_fulfillment_item_check" CHECK ("item" in ('badge', 'ppe', 'uniform', 'tool', 'locker')),
  CONSTRAINT "onb_frontline_fulfillment_quantity_check" CHECK ("requested_quantity" > 0 and "issued_quantity" >= 0 and "issued_quantity" <= "requested_quantity"),
  CONSTRAINT "onb_frontline_fulfillment_status_check" CHECK ("status" in ('issued', 'shortage', 'substituted', 'deferred')),
  CONSTRAINT "onb_frontline_fulfillment_shortage_check" CHECK (("status" = 'shortage' and "issued_quantity" < "requested_quantity") or ("status" <> 'shortage' and "issued_quantity" = "requested_quantity"))
);
--> statement-breakpoint
CREATE INDEX "onb_frontline_fulfillment_current_idx" ON "onb_frontline_fulfillments" ("organization_id","case_id","item","revision");
--> statement-breakpoint
CREATE TABLE "onb_frontline_release_state" (
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'not-released' NOT NULL,
  "released_at" timestamp with time zone,
  "released_by_user_id" text,
  "reblocked_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_frontline_release_state_organization_case_pk" PRIMARY KEY ("organization_id","case_id"),
  CONSTRAINT "onb_frontline_release_state_organization_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_frontline_release_state_version_check" CHECK ("version" >= 0),
  CONSTRAINT "onb_frontline_release_state_status_check" CHECK ("status" in ('not-released', 'released', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "onb_frontline_kpi_inputs" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "case_id" integer NOT NULL,
  "kind" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "actual_exit_at" timestamp with time zone,
  "evidence_reference" text NOT NULL,
  "authority_assignment_id" text NOT NULL,
  "authority_assignment_revision" integer NOT NULL,
  "recorded_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_frontline_kpi_input_organization_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "onb_cases"("organization_id","id") ON DELETE cascade,
  CONSTRAINT "onb_frontline_kpi_input_kind_check" CHECK ("kind" in ('intake', 'medical-result', 'safety-completed', 'ppe-issued', 'statutory-registered', 'actual-exit')),
  CONSTRAINT "onb_frontline_kpi_actual_exit_check" CHECK (("kind" = 'actual-exit' and "actual_exit_at" is not null) or ("kind" <> 'actual-exit' and "actual_exit_at" is null))
);
--> statement-breakpoint
CREATE INDEX "onb_frontline_kpi_input_case_idx" ON "onb_frontline_kpi_inputs" ("organization_id","case_id","kind","occurred_at");