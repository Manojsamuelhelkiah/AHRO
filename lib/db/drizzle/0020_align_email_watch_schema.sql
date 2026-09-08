DO $$ BEGIN
  IF (
    SELECT data_type = 'timestamp without time zone'
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'onb_watch_emails'
      AND column_name = 'received_at'
  ) THEN
    ALTER TABLE "onb_watch_emails"
      ALTER COLUMN "received_at" TYPE timestamp with time zone
        USING "received_at" AT TIME ZONE 'UTC';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "onb_watch_emails"
  ALTER COLUMN "system" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'onb_watch_emails_gmail_message_id_unique'
      AND conrelid = 'onb_watch_emails'::regclass
  ) THEN
    ALTER TABLE "onb_watch_emails"
      ADD CONSTRAINT "onb_watch_emails_gmail_message_id_unique"
      UNIQUE ("gmail_message_id");
  END IF;
END $$;