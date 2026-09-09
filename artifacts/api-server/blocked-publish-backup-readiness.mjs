function whatsappPhone(value) {
  return value.replace(/^whatsapp:/, "").trim();
}

function isE164Phone(value) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

export const BLOCKED_PUBLISH_BACKUP_REQUIRED_ENV =
  "ONBOARDING_BLOCKED_PUBLISH_BACKUP_REQUIRED";

export function blockedPublishBackupRequired(env = process.env) {
  // Production defaults to fail-closed. Set the switch explicitly to "false"
  // only where the backup channel is intentionally not part of the alert policy.
  return env[BLOCKED_PUBLISH_BACKUP_REQUIRED_ENV]?.trim().toLowerCase() !== "false";
}

export function missingBlockedPublishBackupCategories(env = process.env) {
  if (!blockedPublishBackupRequired(env)) return [];

  const destination = whatsappPhone(
    env.ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP ?? "",
  );
  const sender = whatsappPhone(env.TWILIO_WHATSAPP_FROM ?? "");
  const accountSid = (env.TWILIO_ACCOUNT_SID ?? "").trim();
  const authToken = (env.TWILIO_AUTH_TOKEN ?? "").trim();
  const missing = [];

  if (!destination) missing.push("Backup WhatsApp destination");
  if (!accountSid || !authToken) missing.push("Twilio account configuration");
  if (!sender) missing.push("Twilio WhatsApp sender");

  return missing;
}

export function invalidBlockedPublishBackupCategories(env = process.env) {
  if (!blockedPublishBackupRequired(env)) return [];

  const destination = whatsappPhone(
    env.ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP ?? "",
  );
  const sender = whatsappPhone(env.TWILIO_WHATSAPP_FROM ?? "");
  const invalid = [];

  if (destination && !isE164Phone(destination)) {
    invalid.push("Backup WhatsApp destination");
  }
  if (sender && !isE164Phone(sender)) {
    invalid.push("Twilio WhatsApp sender");
  }

  return invalid;
}

export function blockedPublishBackupBlockingCategories(env = process.env) {
  return [
    ...missingBlockedPublishBackupCategories(env),
    ...invalidBlockedPublishBackupCategories(env),
  ];
}
