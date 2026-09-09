ALTER TABLE "scenario_upload_intents"
  ADD COLUMN IF NOT EXISTS "final_object_path" text;
ALTER TABLE "scenario_upload_intents"
  ADD COLUMN IF NOT EXISTS "processing_at" timestamp with time zone;
CREATE UNIQUE INDEX IF NOT EXISTS "scenario_upload_intents_final_object_path_unique"
  ON "scenario_upload_intents" ("final_object_path");