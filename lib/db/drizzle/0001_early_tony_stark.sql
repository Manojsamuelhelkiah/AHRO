CREATE TABLE "actuals_overlays" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_label" text,
	"period_start" text,
	"period_end" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onb_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"agent" text NOT NULL,
	"rule_ref" text,
	"hitl_pattern" text DEFAULT 'approve-before-act' NOT NULL,
	"recommendation" text NOT NULL,
	"rationale" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"comment" text,
	"resume_action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "onb_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker_name" text NOT NULL,
	"worker_email" text NOT NULL,
	"worker_phone" text,
	"hire_type" text NOT NULL,
	"worker_category" text NOT NULL,
	"role" text NOT NULL,
	"department" text NOT NULL,
	"geography" text NOT NULL,
	"legal_entity" text NOT NULL,
	"manager_name" text NOT NULL,
	"recruiter_name" text NOT NULL,
	"joining_date" text NOT NULL,
	"urgency" text DEFAULT 'standard' NOT NULL,
	"lifecycle_stage" text DEFAULT 'trigger-received' NOT NULL,
	"orchestration_status" text DEFAULT 'idle' NOT NULL,
	"readiness" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workstreams" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_skill" text,
	"skill_criticality" text,
	"scenario_key" text,
	"plan_summary" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onb_communications" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"sensitive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onb_connectors" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"vendor" text NOT NULL,
	"available_vendors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"description" text NOT NULL,
	"authoritative_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "onb_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"agent" text NOT NULL,
	"engine" text NOT NULL,
	"hitl_pattern" text,
	"rule_ref" text,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onb_approvals" ADD CONSTRAINT "onb_approvals_case_id_onb_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."onb_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onb_communications" ADD CONSTRAINT "onb_communications_case_id_onb_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."onb_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onb_events" ADD CONSTRAINT "onb_events_case_id_onb_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."onb_cases"("id") ON DELETE cascade ON UPDATE no action;