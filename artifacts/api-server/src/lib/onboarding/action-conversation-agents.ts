import { accessAgents, agentCatalogueBindings, db, organizationMembershipsTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AGENT_CATALOGUE_VERSION, agentCatalogue } from "../agent-catalogue";
import { resolveEffectiveAccessInTransaction } from "../access-governance";
import { conversationDigest } from "./action-conversation-contract";
import { registeredDemoProfile } from "../demo-principal";
import { isInternalAccount } from "../member-identities";
import { isPlatformSuperAdmin } from "../private-platform-admin";

/** No invocation function is imported here. Selection is descriptive, never a
 * request to expand an agent's one implemented metadata-read tool. */
export async function conversationAgents(organizationId: string, actor: string, caseId: number) {
  const publicDemo = Boolean(await registeredDemoProfile(actor));
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
    const bindings = await tx.select().from(agentCatalogueBindings).where(eq(agentCatalogueBindings.organizationId, organizationId));
    const principals = await tx.select().from(accessAgents).where(eq(accessAgents.organizationId, organizationId));
    const [member] = await tx.select().from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId), eq(organizationMembershipsTable.clerkUserId, actor),
      isNull(organizationMembershipsTable.revokedAt),
    ));
    // Non-administrators only learn about their own eligible principal.
    const privateDetails = isPlatformSuperAdmin(actor, organizationId) || !publicDemo && !isInternalAccount(actor) && (member?.role === "owner" || member?.role === "admin");
    const result = [];
    for (const role of agentCatalogue()) {
      const binding = bindings.find(row => row.catalogueKey === role.key);
      const principal = principals.find(row => row.id === binding?.agentId);
      const owns = !publicDemo && principal?.ownerUserId === actor && Boolean(member) && !isInternalAccount(actor);
      const visible = privateDetails || owns;
      const current = Boolean(binding && principal && principal.status === "active" && !principal.revokedAt &&
        principal.version === binding.principalVersion && binding.catalogueVersion === AGENT_CATALOGUE_VERSION);
      const effective = owns && current ? await resolveEffectiveAccessInTransaction(tx, {
        organizationId, principalType: "agent", principalId: principal!.id, initiatorUserId: actor, caseId,
        purpose: "action-conversation-descriptive-selection",
      }) : { allows: [] as string[] };
      const eligible = current && owns && ["tool.case.read", "data.case.readiness.read"].every(key => effective.allows.includes(key));
      result.push({
        key: role.key, role: role.name,
        registration: !visible ? "Registration private" : !binding ? "Not registered" : !current ? "Registration requires review" : "Registered",
        capability: eligible ? "Runtime capability: case metadata read only. Selection is descriptive; AI triage remains separate human-authorized assistance. This does not invoke this principal or add tools."
          : "Unavailable for selection: a current registration, active accountable owner initiating this request and scoped metadata-read grants are required. No operational capability is available.",
        eligible, owner: visible ? principal?.ownerUserId ?? null : null,
        fingerprint: conversationDigest([binding ?? null, principal ?? null, member?.membershipRevision ?? null, effective.allows]),
      });
    }
    return result;
  });
}
