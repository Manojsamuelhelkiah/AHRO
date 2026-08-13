/**
 * Pure channel-routing decisions for the onboarding orchestrator.
 * HR sets a per-case channel preference (email | whatsapp | both); these
 * helpers decide which channels are actually used given the contact details
 * on the case, falling back to email when WhatsApp is preferred but no phone
 * number is on file.
 */

export type ChannelPreference = "email" | "whatsapp" | "both";
export type Channel = "email" | "whatsapp";

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
