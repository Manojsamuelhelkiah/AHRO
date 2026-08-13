CREATE TABLE IF NOT EXISTS "onb_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL REFERENCES "onb_cases"("id") ON DELETE CASCADE,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onb_documents_case_id_key_unique" UNIQUE("case_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_call_slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL REFERENCES "onb_cases"("id") ON DELETE CASCADE,
	"slots" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"booked_slot_n" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"booked_at" timestamp with time zone
);
