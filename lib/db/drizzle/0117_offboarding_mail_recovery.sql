CREATE TABLE "offb_exchange_quarantine" (
  "provider_message_id" text PRIMARY KEY NOT NULL,
  "reason" text NOT NULL,
  "reference_hashes" jsonb NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offb_exchange_mailbox_state" (
  "id" text PRIMARY KEY NOT NULL,
  "query" text NOT NULL,
  "page_token" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
