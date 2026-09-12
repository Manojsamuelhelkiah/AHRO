ALTER TABLE "onb_authority_governance"
  DROP CONSTRAINT IF EXISTS "onb_authority_governance_status_check";
--> statement-breakpoint
ALTER TABLE "onb_authority_governance"
  ADD CONSTRAINT "onb_authority_governance_status_check"
  CHECK ("status" IN ('unconfigured', 'operator-attested', 'governance-approved', 'withdrawn'));