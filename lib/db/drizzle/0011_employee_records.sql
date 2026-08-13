CREATE TABLE IF NOT EXISTS "onb_employee_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker_email" text NOT NULL,
	"worker_name" text NOT NULL,
	"role" text NOT NULL,
	"department" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"exit_reason" text NOT NULL,
	"notice_required_days" integer NOT NULL,
	"notice_served_days" integer NOT NULL,
	"performance_rating" text NOT NULL,
	"rehire_eligible" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Engine tag split: deterministic rule-table actions are now tagged "rules";
-- "ldm" is reserved for the large-database-model records agent.
UPDATE "onb_events" SET "engine" = 'rules' WHERE "engine" = 'ldm';
