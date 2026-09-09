ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "owner_user_id" text;

CREATE TABLE IF NOT EXISTS "scenario_files" (
  "id" serial PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "scenario_id" integer,
  "object_path" text NOT NULL,
  "original_name" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scenario_files_object_path_unique" UNIQUE("object_path"),
  CONSTRAINT "scenario_files_scenario_id_scenarios_id_fk"
    FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id")
    ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS "scenario_files_owner_scenario_idx"
  ON "scenario_files" USING btree ("owner_user_id", "scenario_id");