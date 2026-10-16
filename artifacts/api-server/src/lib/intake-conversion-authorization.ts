import { and, eq, isNull } from "drizzle-orm";
import { accessAgents, agentCatalogueBindings, organizationMembershipsTable } from "@workspace/db";
import { AGENT_CATALOGUE_VERSION } from "./agent-catalogue";
import { resolveEffectiveAccessInTransaction } from "./access-governance";
import { isSharedDemoPrincipalInTransaction } from "./human-permissions";
import { isInternalAccount } from "./member-identities";
import { withoutPlatformAdminContext } from "./private-platform-admin";
import type { Tx } from "./offboarding/authority";
import { SeparationError } from "./offboarding/model";

export const INTAKE_CONVERSION_KEY = "intake-conversion";
export async function intakeOwnerMembershipRevision(tx: Tx, org: string, owner: string) {
  const [member] = await tx.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, org),
    eq(organizationMembershipsTable.clerkUserId, owner), isNull(organizationMembershipsTable.revokedAt),
  )).limit(1);
  return member?.membershipRevision ?? null;
}
export type IntakeConversionContext = {
  organizationId: string; agentId: string; agentVersion: number; ownerUserId: string;
  generation: number; activatedAt: Date;
};
const required = ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit",
  "data.case.notes.edit", "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"] as const;

/** Registration grants this capability only. The live owner's permissions bound
 * its access; no human session, temporary platform grant or other tool is used.
 * All reads reuse the caller's tenant-locked transaction connection. */
export async function intakeOwnerEligible(tx: Tx, org: string, owner: string, caseId?: number) {
  return withoutPlatformAdminContext(async () => {
    if (isInternalAccount(owner) || await isSharedDemoPrincipalInTransaction(tx, owner)) return false;
    const [member] = await tx.select().from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, org),
      eq(organizationMembershipsTable.clerkUserId, owner), isNull(organizationMembershipsTable.revokedAt),
    )).limit(1);
    if (!member) return false;
    const access = await resolveEffectiveAccessInTransaction(tx, {
      organizationId: org, principalType: "human", principalId: owner, caseId, purpose: "standing-intake-conversion",
    });
    return required.every(key => access.allows.includes(key));
  });
}
export async function resolveIntakeConversion(tx: Tx, org: string, generation?: number): Promise<IntakeConversionContext | null> {
  const [binding] = await tx.select().from(agentCatalogueBindings).where(and(
    eq(agentCatalogueBindings.organizationId, org), eq(agentCatalogueBindings.catalogueKey, INTAKE_CONVERSION_KEY),
  )).limit(1);
  const authorization = binding?.intakeAuthorization;
  if (!binding || binding.catalogueVersion !== AGENT_CATALOGUE_VERSION ||
      (generation !== undefined && binding.version !== generation) ||
      authorization?.capability !== "intake-conversion/v1" ||
      !Number.isFinite(Date.parse(authorization.activatedAt))) return null;
  const [agent] = await tx.select().from(accessAgents).where(and(
    eq(accessAgents.organizationId, org), eq(accessAgents.id, binding.agentId),
  )).limit(1);
  if (!agent || agent.status !== "active" || agent.revokedAt || agent.version !== binding.principalVersion ||
      agent.ownerUserId !== authorization.ownerUserId ||
      await intakeOwnerMembershipRevision(tx, org, agent.ownerUserId) !== authorization.ownerMembershipRevision ||
      !await intakeOwnerEligible(tx, org, agent.ownerUserId)) return null;
  return { organizationId: org, agentId: agent.id, agentVersion: agent.version, ownerUserId: agent.ownerUserId,
    generation: binding.version, activatedAt: new Date(authorization.activatedAt) };
}
export async function requireIntakeConversion(tx: Tx, context: IntakeConversionContext, caseId?: number) {
  const current = await resolveIntakeConversion(tx, context.organizationId, context.generation);
  if (!current || current.agentId !== context.agentId || current.agentVersion !== context.agentVersion ||
      current.ownerUserId !== context.ownerUserId ||
      !await intakeOwnerEligible(tx, context.organizationId, current.ownerUserId, caseId))
    throw new SeparationError("Automatic conversion paused: registration or accountable owner access changed. Manual review remains available.", 409);
}
