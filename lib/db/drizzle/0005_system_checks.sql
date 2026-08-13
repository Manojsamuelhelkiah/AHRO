CREATE TABLE "onb_system_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"system" text NOT NULL,
	"mode" text NOT NULL,
	"external_ref" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "onb_system_checks_case_system" UNIQUE("case_id","system")
);
--> statement-breakpoint
ALTER TABLE "onb_system_checks" ADD CONSTRAINT "onb_system_checks_case_id_onb_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."onb_cases"("id") ON DELETE cascade ON UPDATE no action;