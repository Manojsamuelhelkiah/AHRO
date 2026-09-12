-- Preserve tenant/source/event idempotency after a linked case is deleted,
-- while removing the only restricted source-evidence pointer and all intake
-- register snapshots that could otherwise outlive the case.
ALTER TABLE "onb_standard_intake_events"
  DROP CONSTRAINT IF EXISTS "onb_standard_intake_events_organization_case_fk";
--> statement-breakpoint
ALTER TABLE "onb_standard_intake_events"
  ADD CONSTRAINT "onb_standard_intake_events_organization_case_fk"
  FOREIGN KEY ("organization_id", "case_id")
  REFERENCES "onb_cases"("organization_id", "id")
  ON DELETE SET NULL ("case_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "onb_minimize_standard_intake_on_case_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "onb_standard_intake_events"
  SET
    "acceptance_evidence_reference" = '[minimized: linked case deleted]',
    "intake_snapshot" = '{}'::jsonb,
    "workforce_context_snapshot" = '{}'::jsonb,
    "process_policy_snapshot" = '{}'::jsonb,
    "state" = 'case-deleted',
    "failure_reason" = 'The linked onboarding case was deleted; this source-event fingerprint is retained only to prevent duplicate intake.'
  WHERE
    "organization_id" = OLD."organization_id"
    AND "case_id" = OLD."id";
  RETURN OLD;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "onb_minimize_standard_intake_on_case_delete" ON "onb_cases";
--> statement-breakpoint
CREATE TRIGGER "onb_minimize_standard_intake_on_case_delete"
BEFORE DELETE ON "onb_cases"
FOR EACH ROW
EXECUTE FUNCTION "onb_minimize_standard_intake_on_case_delete"();