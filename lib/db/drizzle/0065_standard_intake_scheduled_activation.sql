ALTER TABLE "onb_standard_intake_events"
  ADD COLUMN "activation_due_at" timestamp with time zone,
  ADD COLUMN "activation_status" text NOT NULL DEFAULT 'awaiting-review',
  ADD COLUMN "activation_review_requested_at" timestamp with time zone,
  ADD COLUMN "activation_released_at" timestamp with time zone,
  ADD COLUMN "activation_released_by" text;

CREATE INDEX "onb_standard_intake_events_activation_due_idx"
  ON "onb_standard_intake_events" ("activation_status", "activation_due_at")
  WHERE "activation_due_at" IS NOT NULL;