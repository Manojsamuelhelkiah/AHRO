-- Bind an interrupted upload reservation to the exact server-recorded
-- workforce context that authorized its object-storage disclosure.
ALTER TABLE "onb_candidate_upload_reservations"
  ADD COLUMN IF NOT EXISTS "workforce_context_version" integer NOT NULL DEFAULT 1;