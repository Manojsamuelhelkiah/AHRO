/**
 * Pure channel-routing decisions for the onboarding orchestrator.
 * HR sets a per-case channel preference (email | whatsapp | both); these
 * helpers decide which channels are actually used given the contact details
 * on the case, falling back to email when WhatsApp is preferred but no phone
 * number is on file.
 */

export type ChannelPreference = "email" | "whatsapp" | "both";
export type Channel = "email" | "whatsapp";

export function shouldAuthorizeCandidateEmail(
  email: string,
  preference: string | null | undefined,
): boolean {
  const normalized = email.trim().toLowerCase();
  const pref = normalizePreference(preference);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    && (pref === "email" || pref === "both");
}

export function candidateEmailDeliveryDecision(input: {
  workerEmail: string;
  channelPreference: string;
  candidateEmailAuthorizedAt: Date | null;
}): { allowed: boolean; address: string; reason: string | null } {
  const address = input.workerEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return { allowed: false, address, reason: "Candidate email on the onboarding record is invalid — message logged, not delivered." };
  }
  if (input.channelPreference !== "email" && input.channelPreference !== "both") {
    return { allowed: false, address, reason: `Candidate email is not enabled by this case's "${input.channelPreference}" contact preference — message logged, not delivered.` };
  }
  if (!input.candidateEmailAuthorizedAt) {
    return { allowed: false, address, reason: "Candidate email is not authorized for live delivery on this case — message logged, not delivered." };
  }
  return { allowed: true, address, reason: null };
}

/** Explicit pre-existing allowlist permission is valid only for an email-capable case. */
export function candidateEmailMaySend(input: {
  channelPreference: string;
  caseAuthorized: boolean;
  explicitlyAllowlisted: boolean;
  validEmail: boolean;
}): boolean {
  return input.validEmail
    && (input.channelPreference === "email" || input.channelPreference === "both")
    && (input.caseAuthorized || input.explicitlyAllowlisted);
}

export function isRetryableCandidateEmail(input: {
  channel: string;
  direction: string;
  status: string;
  audience?: string;
  subject?: string | null;
}): boolean {
  const subject = (input.subject ?? "").trim();
  const historicalAdminSubject = /^\[AP-\d+\](?:\s|$)/i.test(subject)
    || /^Onboarding channel test$/i.test(subject);
  return input.channel === "email"
    && input.direction === "outbound"
    && (input.audience === undefined || input.audience === "candidate")
    && !historicalAdminSubject
    && (input.status === "failed" || input.status === "logged-only");
}

export function normalizePreference(value: string | null | undefined): ChannelPreference {
  return value === "email" || value === "whatsapp" ? value : "both";
}

/**
 * Channels the welcome message should go out on, plus whether an email
 * fallback replaced an unreachable WhatsApp send.
 */
export function resolveWelcomeChannels(
  preference: string | null | undefined,
  workerPhone: string | null | undefined,
): { channels: Channel[]; whatsappSkipped: boolean; emailIsFallback: boolean } {
  const pref = normalizePreference(preference);
  const hasPhone = Boolean(workerPhone);
  const channels: Channel[] = [];
  if (pref === "email" || pref === "both") channels.push("email");
  if ((pref === "whatsapp" || pref === "both") && hasPhone) channels.push("whatsapp");
  const whatsappSkipped = (pref === "whatsapp" || pref === "both") && !hasPhone;
  const emailIsFallback = pref === "whatsapp" && !hasPhone;
  if (emailIsFallback) channels.push("email");
  return { channels, whatsappSkipped, emailIsFallback };
}

/**
 * Channel to use when replying to an inbound message: honour the preference,
 * fall back to the inbound channel when the preference is "both", and to
 * email when WhatsApp is preferred but no phone is on file.
 */
export function resolveReplyChannel(
  preference: string | null | undefined,
  workerPhone: string | null | undefined,
  workerEmail: string,
  inboundChannel: Channel,
): { channel: Channel; to: string } {
  const pref = normalizePreference(preference);
  let channel: Channel;
  if (pref === "email") channel = "email";
  else if (pref === "whatsapp") channel = "whatsapp";
  else channel = inboundChannel;
  if (channel === "whatsapp" && !workerPhone) channel = "email";
  return {
    channel,
    to: channel === "whatsapp" && workerPhone ? workerPhone : workerEmail,
  };
}
