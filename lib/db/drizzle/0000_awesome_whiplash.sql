CREATE TABLE "scenarios" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"intent_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"author" text NOT NULL,
	"rationale" text NOT NULL,
	"flow_class" text,
	"to_be_human_min" real,
	"act_get_actions" integer,
	"act_put_actions" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"flow_class" text NOT NULL,
	"description" text NOT NULL,
	"as_is_handling_min" real NOT NULL,
	"to_be_human_min" real NOT NULL,
	"base_weight" real NOT NULL,
	"act_get_actions" integer NOT NULL,
	"act_put_actions" integer NOT NULL,
	"systems_touched_base" integer DEFAULT 2 NOT NULL,
	"tags" text DEFAULT '["custom"]' NOT NULL,
	"source" text NOT NULL,
	"author" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "custom_intents_key_unique" UNIQUE("key")
);
