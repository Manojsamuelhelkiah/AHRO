export type BlockedPublishBackupEnvironment = {
  ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP?: string;
  TWILIO_WHATSAPP_FROM?: string;
};

export function invalidBlockedPublishBackupCategories(
  env?: BlockedPublishBackupEnvironment,
): string[];