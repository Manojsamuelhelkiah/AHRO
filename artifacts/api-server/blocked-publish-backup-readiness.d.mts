export type BlockedPublishBackupEnvironment = {
  ONBOARDING_BLOCKED_PUBLISH_BACKUP_REQUIRED?: string;
  ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_FROM?: string;
};

export const BLOCKED_PUBLISH_BACKUP_REQUIRED_ENV:
  "ONBOARDING_BLOCKED_PUBLISH_BACKUP_REQUIRED";
export function blockedPublishBackupRequired(
  env?: BlockedPublishBackupEnvironment,
): boolean;
export function missingBlockedPublishBackupCategories(
  env?: BlockedPublishBackupEnvironment,
): string[];
export function invalidBlockedPublishBackupCategories(
  env?: BlockedPublishBackupEnvironment,
): string[];
export function blockedPublishBackupBlockingCategories(
  env?: BlockedPublishBackupEnvironment,
): string[];
