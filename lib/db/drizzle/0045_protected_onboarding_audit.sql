-- Protected onboarding audit evidence. This migration intentionally does not
-- backfill invented actor identity into older events/approval snapshots.

-- Approval history was originally a cascade child of the mutable live
-- approval/case records. Preserve snapshots when those live rows are removed.
ALTER TABLE "onb_approval_history"
  DROP CONSTRAINT IF EXISTS "onb_approval_history_organization_case_fk";
--> statement-breakpoint
ALTER TABLE "onb_approval_history"
  DROP CONSTRAINT IF EXISTS "onb_approval_history_organization_approval_fk";
--> statement-breakpoint
ALTER TABLE "onb_approval_history"
  DROP CONSTRAINT IF EXISTS "onb_approval_history_organization_fk";
--> statement-breakpoint
ALTER TABLE "onb_approval_history"
  DROP CONSTRAINT IF EXISTS "onb_approval_history_organization_id_organizations_id_fk";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "onb_audit_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_id" text,
  "actor_kind" text NOT NULL,
  "actor_authority" text NOT NULL,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "object_type" text NOT NULL,
  "object_id" text,
  "case_reference" text,
  "reviewed_revision" integer,
  "source" text NOT NULL,
  "correlation_id" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "correction_of_id" integer,
  "previous_hash" text NOT NULL,
  "entry_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_audit_entries_organization_sequence_unique"
    UNIQUE ("organization_id", "sequence"),
  CONSTRAINT "onb_audit_entries_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "onb_audit_entries_actor_kind_check"
    CHECK ("actor_kind" in ('authenticated', 'system', 'historical')),
  CONSTRAINT "onb_audit_entries_outcome_check"
    CHECK ("outcome" in ('attempted', 'success', 'denied', 'failure'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_audit_entries_organization_occurred_idx"
  ON "onb_audit_entries" ("organization_id", "occurred_at", "sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onb_audit_entries_organization_action_idx"
  ON "onb_audit_entries" ("organization_id", "action", "sequence");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "onb_audit_heads" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "last_sequence" integer DEFAULT 0 NOT NULL,
  "last_hash" text DEFAULT '' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onb_audit_heads_last_sequence_check" CHECK ("last_sequence" >= 0)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "onb_audit_lifecycles" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "retention_statement" text,
  "reviewed_by" text,
  "reviewed_at" timestamp with time zone,
  "legal_hold_active" boolean DEFAULT false NOT NULL,
  "legal_hold_reason" text,
  "legal_hold_set_by" text,
  "legal_hold_set_at" timestamp with time zone,
  "legal_hold_released_by" text,
  "legal_hold_released_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- This prevents accidental or compromised application-path mutation. A
-- database owner can alter/drop this trigger or rewrite history, so this is
-- tamper-evident application protection, not DBA-proof immutable storage.
CREATE OR REPLACE FUNCTION "onb_reject_audit_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'onb_audit_entries are append-only; record a linked correction instead';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_audit_entries_no_update" ON "onb_audit_entries";
--> statement-breakpoint
CREATE TRIGGER "onb_audit_entries_no_update"
BEFORE UPDATE ON "onb_audit_entries"
FOR EACH ROW EXECUTE FUNCTION "onb_reject_audit_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_audit_entries_no_delete" ON "onb_audit_entries";
--> statement-breakpoint
CREATE TRIGGER "onb_audit_entries_no_delete"
BEFORE DELETE ON "onb_audit_entries"
FOR EACH ROW EXECUTE FUNCTION "onb_reject_audit_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_audit_entries_no_truncate" ON "onb_audit_entries";
--> statement-breakpoint
CREATE TRIGGER "onb_audit_entries_no_truncate"
BEFORE TRUNCATE ON "onb_audit_entries"
FOR EACH STATEMENT EXECUTE FUNCTION "onb_reject_audit_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "onb_reject_approval_history_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'onb_approval_history is append-only and retained independently of a live case';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_approval_history_no_update" ON "onb_approval_history";
--> statement-breakpoint
CREATE TRIGGER "onb_approval_history_no_update"
BEFORE UPDATE ON "onb_approval_history"
FOR EACH ROW EXECUTE FUNCTION "onb_reject_approval_history_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_approval_history_no_delete" ON "onb_approval_history";
--> statement-breakpoint
CREATE TRIGGER "onb_approval_history_no_delete"
BEFORE DELETE ON "onb_approval_history"
FOR EACH ROW EXECUTE FUNCTION "onb_reject_approval_history_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_approval_history_no_truncate" ON "onb_approval_history";
--> statement-breakpoint
CREATE TRIGGER "onb_approval_history_no_truncate"
BEFORE TRUNCATE ON "onb_approval_history"
FOR EACH STATEMENT EXECUTE FUNCTION "onb_reject_approval_history_mutation"();