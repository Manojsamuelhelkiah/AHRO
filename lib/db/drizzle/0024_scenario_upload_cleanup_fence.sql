ALTER TABLE "scenario_upload_intents"
  ADD COLUMN IF NOT EXISTS "cleaning_at" timestamp with time zone;