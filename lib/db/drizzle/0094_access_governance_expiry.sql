ALTER TABLE "access_user_group_members" ADD COLUMN "expires_at" timestamp with time zone;
ALTER TABLE "access_security_group_user_groups" ADD COLUMN "expires_at" timestamp with time zone;
ALTER TABLE "access_security_group_attachments" ADD COLUMN "expires_at" timestamp with time zone;
ALTER TABLE "access_principal_security_group_attachments" ADD COLUMN "expires_at" timestamp with time zone;