CREATE TABLE IF NOT EXISTS "pricing_sheets" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"recommendation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);