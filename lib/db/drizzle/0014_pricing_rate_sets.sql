CREATE TABLE IF NOT EXISTS "pricing_rate_sets" (
  "id" serial PRIMARY KEY NOT NULL,
  "effective_date" date NOT NULL,
  "rationale" text NOT NULL,
  "rates" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);