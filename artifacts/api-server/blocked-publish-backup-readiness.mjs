function whatsappPhone(value) {
  return value.replace(/^whatsapp:/, "").trim();
}

function isE164Phone(value) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

export function invalidBlockedPublishBackupCategories(env = process.env) {
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