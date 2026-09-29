-- The legacy migration named this actor added_by_user_id. Rename that real
-- evidence field when present so fresh and upgraded schemas converge.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'access_user_group_members'
      AND column_name = 'added_by_user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'access_user_group_members'
      AND column_name = 'attached_by_user_id'
  ) THEN
    ALTER TABLE "access_user_group_members"
      RENAME COLUMN "added_by_user_id" TO "attached_by_user_id";
  END IF;
END;
$migration$;


ALTER TABLE "access_user_group_members"
  ADD COLUMN IF NOT EXISTS "requires_approval" text NOT NULL DEFAULT 'no';
ALTER TABLE "access_user_group_members"
  ADD COLUMN IF NOT EXISTS "attached_by_user_id" text;
ALTER TABLE "access_user_group_members"
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" text;
ALTER TABLE "access_user_group_members"
  ADD COLUMN IF NOT EXISTS "approved_at" timestamptz;
ALTER TABLE "access_user_group_members"
  ADD COLUMN IF NOT EXISTS "revoked_by_user_id" text;

ALTER TABLE "access_user_group_members"
  ALTER COLUMN "attached_by_user_id" SET NOT NULL;

-- Replace only the legacy active/revoked check; fresh 0090 already allows
-- pending and is left intact.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"access_user_group_members"'::regclass
      AND conname = 'access_user_group_members_status_check'
      AND pg_get_constraintdef(oid) LIKE '%pending%'
  ) THEN
    ALTER TABLE "access_user_group_members"
      DROP CONSTRAINT IF EXISTS "access_user_group_members_status_check";
    ALTER TABLE "access_user_group_members"
      ADD CONSTRAINT "access_user_group_members_status_check"
      CHECK ("status" IN ('pending', 'active', 'revoked'));
  END IF;
END;
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"access_user_group_members"'::regclass AND conname = 'access_user_group_members_requires_approval_check') THEN
    ALTER TABLE "access_user_group_members" ADD CONSTRAINT "access_user_group_members_requires_approval_check" CHECK ("requires_approval" IN ('yes', 'no'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"access_user_group_members"'::regclass AND conname = 'access_user_group_members_approval_pair_check') THEN
    ALTER TABLE "access_user_group_members" ADD CONSTRAINT "access_user_group_members_approval_pair_check" CHECK (("approved_by_user_id" IS NULL AND "approved_at" IS NULL) OR ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"access_user_group_members"'::regclass AND conname = 'access_user_group_members_approval_required_check') THEN
    ALTER TABLE "access_user_group_members" ADD CONSTRAINT "access_user_group_members_approval_required_check" CHECK ("status" <> 'active' OR "requires_approval" = 'no' OR ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by_user_id" <> "attached_by_user_id"));
  END IF;
END;
$migration$;

ALTER TABLE "access_security_group_user_groups"
  ADD COLUMN IF NOT EXISTS "approved_policy_version" integer;
ALTER TABLE "access_security_group_attachments"
  ADD COLUMN IF NOT EXISTS "approved_policy_version" integer;
ALTER TABLE "access_principal_security_group_attachments"
  ADD COLUMN IF NOT EXISTS "approved_policy_version" integer;

-- Keep legacy approvals present for audit, but make them stale to the
-- evaluator until a reviewer reapproves them against the current policy.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"access_security_group_user_groups"'::regclass
      AND conname = 'access_security_group_user_groups_policy_version_pair_check'
  ) THEN
    ALTER TABLE "access_security_group_user_groups"
      ADD CONSTRAINT "access_security_group_user_groups_policy_version_pair_check"
      CHECK (
        ("approved_by_user_id" IS NULL AND "approved_at" IS NULL AND "approved_policy_version" IS NULL) OR
        ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_policy_version" > 0)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"access_security_group_user_groups"'::regclass
      AND conname = 'access_security_group_user_groups_current_policy_approval_check'
  ) THEN
    ALTER TABLE "access_security_group_user_groups"
      ADD CONSTRAINT "access_security_group_user_groups_current_policy_approval_check"
      CHECK ("status" <> 'active' OR "requires_approval" = 'no' OR
        ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND
         "approved_by_user_id" <> "attached_by_user_id" AND "approved_policy_version" > 0)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"access_security_group_attachments"'::regclass
      AND conname = 'access_security_group_attachments_policy_version_pair_check'
  ) THEN
    ALTER TABLE "access_security_group_attachments"
      ADD CONSTRAINT "access_security_group_attachments_policy_version_pair_check"
      CHECK (
        ("approved_by_user_id" IS NULL AND "approved_at" IS NULL AND "approved_policy_version" IS NULL) OR
        ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_policy_version" > 0)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"access_security_group_attachments"'::regclass
      AND conname = 'access_security_group_attachments_current_policy_approval_check'
  ) THEN
    ALTER TABLE "access_security_group_attachments"
      ADD CONSTRAINT "access_security_group_attachments_current_policy_approval_check"
      CHECK ("status" <> 'active' OR "requires_approval" = 'no' OR
        ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND
         "approved_by_user_id" <> "attached_by_user_id" AND "approved_policy_version" > 0)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"access_principal_security_group_attachments"'::regclass
      AND conname = 'access_principal_security_group_attachments_policy_version_pair_check'
  ) THEN
    ALTER TABLE "access_principal_security_group_attachments"
      ADD CONSTRAINT "access_principal_security_group_attachments_policy_version_pair_check"
      CHECK (
        ("approved_by_user_id" IS NULL AND "approved_at" IS NULL AND "approved_policy_version" IS NULL) OR
        ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_policy_version" > 0)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"access_principal_security_group_attachments"'::regclass
      AND conname = 'access_principal_security_group_attachments_current_policy_approval_check'
  ) THEN
    ALTER TABLE "access_principal_security_group_attachments"
      ADD CONSTRAINT "access_principal_security_group_attachments_current_policy_approval_check"
      CHECK ("status" <> 'active' OR "requires_approval" = 'no' OR
        ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND
         "approved_by_user_id" <> "attached_by_user_id" AND "approved_policy_version" > 0)
      ) NOT VALID;
  END IF;
END;
$migration$;