import { and, eq } from "drizzle-orm";
import { onbSettings } from "@workspace/db";
import { z } from "zod";
import { EnrollmentInput } from "./exchange-contract";
import { SeparationError } from "./model";
import type { Tx } from "./authority";

export const DEFAULTS_KEY = "offboarding-gmail-defaults";
export const ClientDefaults = z.object({
  revision: z.number().int().positive(), agentId: z.string().max(160),
  recipients: EnrollmentInput.shape.recipients,
  enabled: z.boolean().default(false), escalationEnabled: z.boolean().default(true),
  clientControlConfigured: z.boolean().default(false),
  operator: z.string().nullable().default(null), mailbox: z.string().nullable().default(null),
}).strict();
export type ClientDefaults = z.infer<typeof ClientDefaults>;
export async function readClientDefaults(tx: Tx, org: string): Promise<ClientDefaults> {
  const [row] = await tx.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, org), eq(onbSettings.key, DEFAULTS_KEY),
  ));
  return row ? ClientDefaults.parse(JSON.parse(row.value)) : {
    revision: 1, agentId: "", recipients: [], enabled: false, escalationEnabled: false,
    clientControlConfigured: false, operator: null, mailbox: null,
  };
}
export function publicClientDefaults(c: ClientDefaults) {
  return { revision: c.revision, agentId: c.agentId, recipients: c.recipients,
    enabled: c.enabled, escalationEnabled: c.escalationEnabled };
}
export async function requireClientEmailEnabled(tx: Tx, org: string) {
  const c = await readClientDefaults(tx, org);
  if (c.clientControlConfigured && !c.enabled) throw new SeparationError("Email is paused for this client. An administrator must enable email in Client defaults.");
  return c;
}
export function validateEscalation(recipients: ClientDefaults["recipients"], enabled: boolean) {
  if (!enabled) return;
  for (const r of recipients) {
    if (!r.escalationMemberId || !r.escalationAddress) throw new SeparationError("Choose an escalation contact and email only when escalation is enabled.");
    if (r.memberId === r.escalationMemberId || r.address.toLowerCase() === r.escalationAddress.toLowerCase()) {
      throw new SeparationError("Escalation requires a distinct accountable person and mailbox.");
    }
  }
}
export function normalizedRecipients(recipients: ClientDefaults["recipients"], escalationEnabled: boolean) {
  return recipients.map(({ consentReference: _c, escalationConsentReference: _e, escalationMemberId, escalationAddress, ...r }) => ({
    ...r, address: r.address.toLowerCase(),
    ...(escalationEnabled ? { escalationMemberId, escalationAddress: escalationAddress?.toLowerCase() } : {}),
  }));
}
