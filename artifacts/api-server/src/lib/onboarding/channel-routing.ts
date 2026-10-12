/**
 * Pure channel-routing decisions for the onboarding orchestrator.
 * Candidate email is the default channel. Contact preference selects
 * additional WhatsApp delivery, never permission to suppress required email.
 */

export type ChannelPreference = "email" | "whatsapp" | "both";
export type Channel = "email" | "whatsapp";
export class CandidateEmailUnavailableError extends Error {}

export function shouldAuthorizeCandidateEmail(
  email: string,
  _preference: string | null | undefined,
): boolean {
  return candidateEmailDeliveryDecision({ workerEmail: email }).allowed;
}

export function candidateEmailDeliveryDecision(input: {
  workerEmail: string;
  channelPreference?: string;
  /** Legacy audit history, not a delivery prerequisite. */
  candidateEmailAuthorizedAt?: Date | null;
}): { allowed: boolean; address: string; reason: string | null } {
  const address = input.workerEmail.trim().toLowerCase();
  if (!address) {
    return { allowed: false, address, reason: "Candidate email is missing — message logged, not delivered." };
  }
  const [local, domain] = address.split("@");
  if (address.length > 254 || !local || local.length > 64 || local.startsWith(".") ||
    local.endsWith(".") || local.includes("..") ||
    !/^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(address)) {
    return { allowed: false, address, reason: "Candidate email on the onboarding record is invalid — message logged, not delivered." };
  }
  if (/^(?:.*\.)?(?:invalid|test|example|localhost)$/.test(domain) ||
    /^(?:.*\.)?example\.(?:com|net|org)$/.test(domain)) {
    return { allowed: false, address, reason: "Candidate email uses a reserved placeholder domain — message logged, not delivered." };
  }
  return { allowed: true, address, reason: null };
}

/** Legacy parameters are retained for callers; only validated address eligibility matters. */
export function candidateEmailMaySend(input: {
  channelPreference: string;
  caseAuthorized: boolean;
  explicitlyAllowlisted: boolean;
  validEmail: boolean;
}): boolean {
  return input.validEmail && input.caseAuthorized;
}

/** Explain an old definitive block without presenting retired rules as current. */
export function candidateEmailFailureFeedback(email: string, reason: string | null, status: string): string | null {
  if (["failed", "logged-only", "blocked"].includes(status) &&
    candidateEmailDeliveryDecision({ workerEmail: email }).allowed &&
    reason && /Candidate email (?:is not authorized|is not enabled)/i.test(reason)) {
    return "This email was previously withheld by legacy email settings. The provided address now enables candidate email; an authorized reviewer may use Retry email in Communications. It has not been resent automatically.";
  }
  return reason;
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
    && (input.status === "failed" || input.status === "logged-only" || input.status === "blocked");
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
  const channels: Channel[] = ["email"];
  if ((pref === "whatsapp" || pref === "both") && hasPhone) channels.push("whatsapp");
  const whatsappSkipped = (pref === "whatsapp" || pref === "both") && !hasPhone;
  const emailIsFallback = pref === "whatsapp" && !hasPhone;
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
  else if (pref === "whatsapp") channel = inboundChannel;
  else channel = inboundChannel;
  if (channel === "whatsapp" && !workerPhone) channel = "email";
  return {
    channel,
    to: channel === "whatsapp" && workerPhone ? workerPhone : workerEmail,
  };
}
