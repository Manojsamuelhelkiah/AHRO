ALTER TABLE "onb_connectors" ADD COLUMN IF NOT EXISTS "tracking_mode" text DEFAULT 'api' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onb_watch_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"gmail_message_id" text NOT NULL,
	"check_id" integer,
	"case_id" integer,
	"system" text,
	"from_address" text NOT NULL,
	"subject" text,
	"snippet" text,
	"parsed_status" text NOT NULL,
	"action" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "onb_watch_emails_gmail_message_id_unique" UNIQUE("gmail_message_id")
);
