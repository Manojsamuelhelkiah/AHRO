-- Workforce transfer payloads are opaque sensitive records.  Retention is
-- therefore reconciled through the shared lifecycle job worker, not an
-- expiry-time cascade.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
ALTER TABLE "onb_transfer_data_governance" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "onb_transfer_workers" ADD COLUMN "source_fingerprint" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "onb_transfer_workers"
SET "source_fingerprint" = encode(digest("source_payload"::text, 'sha256'), 'hex')
WHERE "source_fingerprint" = '';
--> statement-breakpoint
ALTER TABLE "onb_transfer_cutover_reconciliations" ADD COLUMN "source_fingerprint" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "onb_transfer_cutover_reconciliations" AS reconciliation
SET "source_fingerprint" = worker."source_fingerprint"
FROM "onb_transfer_workers" AS worker
WHERE worker."organization_id" = reconciliation."organization_id"
  AND worker."id" = reconciliation."worker_id"
  AND reconciliation."source_fingerprint" = '';
--> statement-breakpoint
ALTER TABLE "onb_sensitive_lifecycle_deletion_jobs"
  ADD COLUMN "transfer_retention_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "onb_transfer_worker_source_custody"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."source_fingerprint" := encode(digest(NEW."source_payload"::text, 'sha256'), 'hex');
    RETURN NEW;
  END IF;

  IF NEW."source_payload" IS DISTINCT FROM OLD."source_payload"
    OR NEW."original_hire_date" IS DISTINCT FROM OLD."original_hire_date"
    OR NEW."continuous_service_date" IS DISTINCT FROM OLD."continuous_service_date"
    OR NEW."source_fingerprint" IS DISTINCT FROM OLD."source_fingerprint" THEN
    RAISE EXCEPTION 'transfer worker source payload and preserved service dates are immutable custody evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "onb_transfer_workers_source_custody"
BEFORE INSERT OR UPDATE ON "onb_transfer_workers"
FOR EACH ROW EXECUTE FUNCTION "onb_transfer_worker_source_custody"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "onb_transfer_reconciliation_source_custody"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  worker_fingerprint text;
BEGIN
  SELECT "source_fingerprint" INTO worker_fingerprint
  FROM "onb_transfer_workers"
  WHERE "organization_id" = NEW."organization_id"
    AND "id" = NEW."worker_id"
  FOR KEY SHARE;

  IF worker_fingerprint IS NULL THEN
    RAISE EXCEPTION 'transfer reconciliation requires immutable source worker custody';
  END IF;
  NEW."source_fingerprint" := worker_fingerprint;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "onb_transfer_reconciliations_source_custody"
BEFORE INSERT OR UPDATE ON "onb_transfer_cutover_reconciliations"
FOR EACH ROW EXECUTE FUNCTION "onb_transfer_reconciliation_source_custody"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "onb_transfer_data_governance_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."lawful_basis_reference" IS DISTINCT FROM OLD."lawful_basis_reference"
    OR NEW."retention_reference" IS DISTINCT FROM OLD."retention_reference"
    OR NEW."retention_until" IS DISTINCT FROM OLD."retention_until"
    OR NEW."authority_assignment_id" IS DISTINCT FROM OLD."authority_assignment_id"
    OR NEW."authority_assignment_revision" IS DISTINCT FROM OLD."authority_assignment_revision" THEN
    NEW."revision" := OLD."revision" + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "onb_transfer_data_governance_revision"
BEFORE UPDATE ON "onb_transfer_data_governance"
FOR EACH ROW EXECUTE FUNCTION "onb_transfer_data_governance_revision"();