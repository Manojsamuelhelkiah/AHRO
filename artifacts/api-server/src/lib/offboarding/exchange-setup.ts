import { clerkClient } from "@clerk/express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, onbSettings, accessAgents, offbExchangePilots, offbCases, organizationMembershipsTable } from "@workspace/db";
import { namedOperator, verifyDemo, loadPilot, PILOT_PROVENANCE, applyClientDefaultsToPilots } from "./exchange-service";
import { registeredDemoProfile } from "../demo-principal";
import { explicitlyConfiguredAddressAllowed } from "../onboarding/channels";
import { externalProviderDispatchDenied } from "../onboarding/provider-policy";
import { exchangeTestIdentity } from "./exchange-test-boundary";
import { SeparationError } from "./model";
import { ClientDefaults, DEFAULTS_KEY, readClientDefaults, publicClientDefaults, validateEscalation, normalizedRecipients } from "./exchange-client-settings";
import { connectedIntakeMailbox } from "../hro-email-ingestion";
import { isClientAdministratorInTransaction } from "../access-governance";
import { isPlatformSuperAdmin } from "../private-platform-admin";
export async function saveGmailDefaults(org: string, actor: string, raw: unknown) {
  const parsed = ClientDefaults.omit({ revision: true, operator: true, mailbox: true, clientControlConfigured: true })
    .extend({ expectedRevision: z.number().int().positive(), enabled: z.boolean().optional(), escalationEnabled: z.boolean().optional() }).safeParse(raw);
  if (!parsed.success) throw new SeparationError("Provide current client defaults and valid contacts.", 400);
  const b = parsed.data, choices = await exchangeSetupChoices(org, actor);
  const escalationEnabled = b.escalationEnabled ?? choices.defaults.escalationEnabled;
  if (b.agentId && !choices.agents.some(a => a.id === b.agentId)) throw new SeparationError("Choose your own active registered agent.", 403);
  if (b.enabled && (!b.agentId || !b.recipients.length)) throw new SeparationError("Choose a registered agent and at least one task owner before enabling email for this client.");
  if (new Set(b.recipients.map(r => r.taskId)).size !== b.recipients.length) throw new SeparationError("Choose one owner per task.");
  validateEscalation(b.recipients, escalationEnabled);
  for (const r of b.recipients) {
    const contacts = [[r.memberId, r.address], ...(escalationEnabled ? [[r.escalationMemberId!, r.escalationAddress!]] : [])];
    for (const [id, address] of contacts) {
      if (!choices.members.some(m => m.id === id && m.addresses.includes(address.toLowerCase()))) throw new SeparationError("Choose a current approved contact address.");
    }
  }
  const mailbox = b.enabled ? exchangeTestIdentity()?.mailbox ??
    (externalProviderDispatchDenied() || process.env.ONBOARDING_AUTOMATED_TEST === "true" ? null : await connectedIntakeMailbox()) : null;
  if (b.enabled && !mailbox) throw new SeparationError("Connected Gmail mailbox is unavailable. Restore mailbox health before enabling email.");
  return db.transaction(async tx => {
    await verifyDemo(tx, org); await namedOperator(tx, org, actor);
    if (!isPlatformSuperAdmin(actor, org) && !await isClientAdministratorInTransaction(tx, org, actor)) {
      throw new SeparationError("A current client administrator must manage client-wide email settings.", 403);
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`offboarding-gmail-defaults:${org}`}, 0))`);
    const current = await readClientDefaults(tx, org);
    if (current.revision !== b.expectedRevision) throw new SeparationError("Client Gmail defaults changed; reload before saving.");
    const result = { revision: current.revision + 1, agentId: b.agentId,
      enabled: b.enabled ?? current.enabled, escalationEnabled,
      clientControlConfigured: b.enabled !== undefined || current.clientControlConfigured,
      operator: actor, mailbox: mailbox ?? current.mailbox,
      recipients: normalizedRecipients(b.recipients, escalationEnabled) };
    await tx.insert(onbSettings).values({ organizationId: org, key: DEFAULTS_KEY, value: JSON.stringify(result) }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(result), updatedAt: new Date() },
    });
    if (result.clientControlConfigured) await applyClientDefaultsToPilots(tx, org, result);
    return publicClientDefaults(result);
  });
}

/** Read-only choices, never enrollment, consent, authority grants or dispatch. */
export async function exchangeSetupChoices(org: string, actor: string, caseId?: number) {
  const snapshot = await db.transaction(async tx => {
    await verifyDemo(tx, org);
    if (caseId) await loadPilot(tx, org, caseId);
    await namedOperator(tx, org, actor, caseId);
    const cases = await tx.select({ id: offbCases.id, facts: offbCases.facts })
      .from(offbExchangePilots).innerJoin(offbCases, and(eq(offbCases.organizationId, offbExchangePilots.organizationId), eq(offbCases.id, offbExchangePilots.caseId), eq(offbCases.generation, offbExchangePilots.generation)))
      .where(and(eq(offbExchangePilots.organizationId, org), eq(offbExchangePilots.provenance, PILOT_PROVENANCE), caseId ? eq(offbCases.id, caseId) : undefined));
    const agents = await tx.select({ id: accessAgents.id, name: accessAgents.name }).from(accessAgents)
      .where(and(eq(accessAgents.organizationId, org), eq(accessAgents.ownerUserId, actor), eq(accessAgents.status, "active"), isNull(accessAgents.revokedAt)));
    const members = await tx.select({ id: organizationMembershipsTable.clerkUserId }).from(organizationMembershipsTable)
      .where(and(eq(organizationMembershipsTable.organizationId, org), isNull(organizationMembershipsTable.revokedAt)));
    return { cases: cases.map(c => ({ id: c.id, name: c.facts.workerName })), agents, members, defaults: publicClientDefaults(await readClientDefaults(tx, org)) };
  });
  const members: Array<{ id: string; name: string; addresses: string[] }> = [];
  const fixture = exchangeTestIdentity();
  // Bound concurrent directory reads. An identity-provider failure is surfaced,
  // not substituted with fabricated verification or addresses.
  for (let i = 0; i < snapshot.members.length; i += 4) {
    const batch = await Promise.all(snapshot.members.slice(i, i + 4).map(async member => {
      if (await registeredDemoProfile(member.id)) return null;
      if (fixture) {
        const addresses = [...fixture.members].filter(([address, id]) => id === member.id && explicitlyConfiguredAddressAllowed(address)).map(([address]) => address);
        return addresses.length ? { id: member.id, name: addresses[0].split("@")[0], addresses } : null;
      }
      if (externalProviderDispatchDenied() || process.env.ONBOARDING_AUTOMATED_TEST === "true") return null;
      let user;
      try { user = await clerkClient.users.getUser(member.id); }
      catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
      const addresses = user.emailAddresses.filter(e => explicitlyConfiguredAddressAllowed(e.emailAddress)).map(e => e.emailAddress.toLowerCase());
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.username || "Member";
      return addresses.length ? { id: member.id, name, addresses } : null;
    }));
    members.push(...batch.filter((m): m is NonNullable<typeof m> => m !== null));
  }
  return db.transaction(async tx => {
    await namedOperator(tx, org, actor, caseId);
    const current = await tx.select({ id: organizationMembershipsTable.clerkUserId }).from(organizationMembershipsTable)
      .where(and(eq(organizationMembershipsTable.organizationId, org), isNull(organizationMembershipsTable.revokedAt)));
    return { cases: snapshot.cases, agents: snapshot.agents, members: members.filter(m => current.some(c => c.id === m.id)), defaults: snapshot.defaults };
  });
}
