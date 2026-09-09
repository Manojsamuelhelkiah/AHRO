CREATE TABLE IF NOT EXISTS "onb_candidate_exchange_failures" (
  "client_key" text PRIMARY KEY,
  "failures" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "onb_candidate_exchange_failures_count_check" CHECK ("failures" > 0)
);

CREATE INDEX IF NOT EXISTS "onb_candidate_exchange_failures_expires_at_idx"
  ON "onb_candidate_exchange_failures" ("expires_at");