import { createHash, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { accessAgents, accessGovernanceHistory, agentCatalogueBindings, agentCatalogueSetupReceipts, customIntentsTable, db, DEMO_ORGANIZATION_ID, onbSettings, organizationMembershipsTable, organizationsTable } from "@workspace/db";
import { AGENT_CATALOGUE_VERSION, agentCatalogue } from "../lib/agent-catalogue";
import { getOrganizationId } from "../lib/organization-scope";
import { isPlatformSuperAdmin } from "../lib/private-platform-admin";
import { demoPrincipalSettingKey, parseRegisteredDemoProfile } from "../lib/demo-principal";
import { enrichMemberIdentities, isInternalAccount } from "../lib/member-identities";
import { EXECUTABLE_AGENT_TOOL_KEYS } from "../lib/agent-invocation";
import { INTAKE_CONVERSION_KEY, intakeOwnerEligible, intakeOwnerMembershipRevision, resolveIntakeConversion } from "../lib/intake-conversion-authorization";
import { GetAgentCatalogueResponse, RegisterCatalogueAgentBody, RegisterCatalogueAgentResponse } from "@workspace/api-zod";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
class CatalogueSetupError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const reject = (status: number, code: string, message: string): never => {
  throw new CatalogueSetupError(status, code, message);
};
async function registeredDemo(tx: Tx, userId: string) {
  // Reuse the transaction connection: concurrent advisory-lock waiters can
  // occupy every other pooled connection and starve a nested global-db read.
  const [row] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID), eq(onbSettings.key, demoPrincipalSettingKey(userId)),
  )).limit(1);
  return Boolean(parseRegisteredDemoProfile(row?.value));
}
async function administrator(tx: Tx, organizationId: string, userId: string) {
  if (isPlatformSuperAdmin(userId, organizationId)) return true;
  if (isInternalAccount(userId) || await registeredDemo(tx, userId)) return false;
  const [member] = await tx.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, userId), isNull(organizationMembershipsTable.revokedAt),
  ));
  return member?.role === "owner" || member?.role === "admin";
}
async function eligible(tx: Tx, organizationId: string, userId: string) {
  if (isInternalAccount(userId) || await registeredDemo(tx, userId)) return false;
  const [member] = await tx.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, userId), isNull(organizationMembershipsTable.revokedAt),
  ));
  return Boolean(member);
}

export function createAgentCatalogueRouter(enrichOwners: typeof enrichMemberIdentities = enrichMemberIdentities): IRouter {
const router: IRouter = Router();
router.get("/agent-catalogue", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const snapshot = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      const [client] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
      const canManage = await administrator(tx, organizationId, req.authUserId!);
      // A transaction uses one connection: do not schedule parallel pg queries.
      const bindings = canManage ? await tx.select().from(agentCatalogueBindings).where(eq(agentCatalogueBindings.organizationId, organizationId)) : [];
      const principals = canManage ? await tx.select().from(accessAgents).where(eq(accessAgents.organizationId, organizationId)) : [];
      const members = canManage ? await tx.select().from(organizationMembershipsTable).where(and(eq(organizationMembershipsTable.organizationId, organizationId), isNull(organizationMembershipsTable.revokedAt))) : [];
      const custom = await tx.select({ id: customIntentsTable.id, name: customIntentsTable.name, status: customIntentsTable.status, registryVersion: customIntentsTable.registryVersion }).from(customIntentsTable).where(eq(customIntentsTable.organizationId, organizationId));
      const owners = [];
      for (const member of members) if (await eligible(tx, organizationId, member.clerkUserId)) owners.push(member);
      const registrations = [];
      for (const binding of bindings) {
        const principal = principals.find(row => row.id === binding.agentId);
        registrations.push({
          ...binding,
          state: !principal || principal.status !== "active" || principal.revokedAt ? "principal-unavailable"
            : !await eligible(tx, organizationId, principal.ownerUserId) ? "owner-unavailable"
             : principal.version !== binding.principalVersion || binding.catalogueVersion !== AGENT_CATALOGUE_VERSION ||
               (binding.catalogueKey === INTAKE_CONVERSION_KEY && !await resolveIntakeConversion(tx, organizationId)) ? "review-required" : "registered",
        });
      }
      return {
        organizationId, clientName: client?.name ?? "Selected client", version: AGENT_CATALOGUE_VERSION,
        canManage, entries: agentCatalogue(), registrations, principals: principals.map(row => ({ id: row.id, name: row.name, ownerUserId: row.ownerUserId, status: row.revokedAt ? "revoked" : row.status, version: row.version })),
        owners: owners.map(row => ({ clerkUserId: row.clerkUserId, role: row.role })),
        customMappings: custom.map(row => ({ intentKey: `custom:${row.id}`, name: row.name, sourceVersion: row.registryVersion, status: row.status, reviewStatus: "review-required" })),
        runtimeCapabilities: [...EXECUTABLE_AGENT_TOOL_KEYS],
         runtimeNotice: "Intake Conversion registration is a standing instruction to convert new valid email templates into held cases only. Other roles retain separate permissions and owner-initiation requirements. No approval, contact, workstream release or closure is authorized.",
      };
    });
    const owners = await enrichOwners(snapshot.owners);
    // Directory enrichment can outlast a private verification lease. Never
    // return an administrative snapshot after its authority has ended.
    if (snapshot.canManage && !await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      return administrator(tx, organizationId, req.authUserId!);
    })) reject(403, "CATALOGUE_ADMIN_REQUIRED", "Administrator access changed while loading. Reload and verify your current access.");
    res.setHeader("Cache-Control", "no-store");
    res.json(GetAgentCatalogueResponse.parse({ ...snapshot, owners }));
  } catch (error) {
    if (error instanceof CatalogueSetupError) { res.status(error.status).json({ code: error.code, message: error.message }); return; }
    next(error);
  }
});

router.post("/agent-catalogue/registrations", async (req, res, next) => {
  try {
    const parsed = RegisterCatalogueAgentBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: "CATALOGUE_INVALID", message: "A valid explicit registration request is required." }); return; }
    const body = parsed.data;
    if ((body.agentId && (body.name !== undefined || body.expectedPrincipalVersion === undefined)) ||
      (!body.agentId && body.expectedPrincipalVersion !== undefined))
      reject(400, "CATALOGUE_INVALID", "Choose either a new named principal or an exact existing principal ID and version.");
    const organizationId = getOrganizationId(req);
    if (body.organizationId !== organizationId) reject(403, "CATALOGUE_TENANT_MISMATCH", "Selected client changed. Reload before registering.");
    if (!Number.isSafeInteger(body.expectedBindingVersion) || !Number.isSafeInteger(body.expectedPrincipalVersion ?? 0))
      reject(400, "CATALOGUE_INVALID", "Versions must be whole numbers.");
    const actor = req.authUserId!;
    const digest = createHash("sha256").update(JSON.stringify([actor, body])).digest("hex");
    const result = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      if (!await administrator(tx, organizationId, actor)) reject(403, "CATALOGUE_ADMIN_REQUIRED", "Current client administrator access is required.");
      const definition = agentCatalogue().find(row => row.key === body.catalogueKey);
      if (!definition || body.catalogueVersion !== AGENT_CATALOGUE_VERSION) reject(409, "CATALOGUE_VERSION_CONFLICT", "Catalogue changed. Reload and review the current definition.");
      if (!await eligible(tx, organizationId, body.ownerUserId)) reject(409, "CATALOGUE_OWNER_REQUIRED", "Choose an active eligible human member of this client. No membership or owner promotion will be created.");
       if (body.catalogueKey === INTAKE_CONVERSION_KEY && !await intakeOwnerEligible(tx, organizationId, body.ownerUserId))
         reject(409, "CATALOGUE_OWNER_REQUIRED", "Automatic intake conversion requires an active named owner with current intake read/edit and confidential-field permissions. Temporary Super Admin access is not background authority.");
      const [priorRequest] = await tx.select().from(agentCatalogueSetupReceipts).where(and(eq(agentCatalogueSetupReceipts.organizationId, organizationId), eq(agentCatalogueSetupReceipts.requestId, body.requestId)));
      const [existing] = await tx.select().from(agentCatalogueBindings).where(and(eq(agentCatalogueBindings.organizationId, organizationId), eq(agentCatalogueBindings.catalogueKey, body.catalogueKey)));
      if (priorRequest && priorRequest.requestDigest !== digest) reject(409, "CATALOGUE_REQUEST_CONFLICT", "This request identifier already belongs to a different setup action.");
      if (priorRequest) {
        if (!existing || existing.version !== priorRequest.bindingVersion || existing.requestId !== body.requestId)
          reject(409, "CATALOGUE_BINDING_CONFLICT", "This setup request was superseded by an explicit replacement. Reload; an old retry cannot restore it.");
        const [principal] = await tx.select().from(accessAgents).where(and(eq(accessAgents.organizationId, organizationId), eq(accessAgents.id, existing!.agentId)));
        if (!principal || principal.status !== "active" || principal.revokedAt || principal.version !== existing!.principalVersion ||
          principal.ownerUserId !== body.ownerUserId) reject(409, "CATALOGUE_PRINCIPAL_UNAVAILABLE", "Prior registration is no longer current. Review it explicitly; no principal was restored.");
        return { created: false, createdPrincipal: false, binding: existing };
      }
      if ((existing?.version ?? 0) !== body.expectedBindingVersion) reject(409, "CATALOGUE_BINDING_CONFLICT", "Registration changed in another session. Reload before choosing a resolution.");
      if (existing && !body.replaceExisting) reject(409, "CATALOGUE_REPLACEMENT_REQUIRED", "This role already has a binding. Explicitly acknowledge replacement; existing principals and grants remain unchanged.");
      let principal;
      if (body.agentId) {
        [principal] = await tx.select().from(accessAgents).where(and(eq(accessAgents.organizationId, organizationId), eq(accessAgents.id, body.agentId)));
        if (!principal || principal.status !== "active" || principal.revokedAt) reject(409, "CATALOGUE_PRINCIPAL_UNAVAILABLE", "Select an active principal from this client. Retired or revoked principals cannot be revived.");
        if (principal.version !== body.expectedPrincipalVersion) reject(409, "CATALOGUE_PRINCIPAL_CONFLICT", "Principal changed. Reload and review its current owner and version.");
        if (principal.ownerUserId !== body.ownerUserId) reject(409, "CATALOGUE_OWNER_CONFLICT", "Binding must retain the principal's existing accountable owner.");
      } else {
        const name = body.name?.trim() ?? "";
        if (!name || name.length > 120) reject(400, "CATALOGUE_NAME_REQUIRED", "Enter a principal name of 1–120 characters.");
        const [named] = await tx.select().from(accessAgents).where(and(eq(accessAgents.organizationId, organizationId), eq(accessAgents.name, name)));
        if (named) reject(409, "CATALOGUE_NAME_CONFLICT", "This name already identifies another principal, possibly retired. Select its exact ID to bind, or choose a different name.");
        [principal] = await tx.insert(accessAgents).values({ organizationId, id: randomUUID(), name, description: definition!.responsibility, ownerUserId: body.ownerUserId, createdByUserId: actor }).returning();
      }
      const [other] = await tx.select().from(agentCatalogueBindings).where(and(eq(agentCatalogueBindings.organizationId, organizationId), eq(agentCatalogueBindings.agentId, principal!.id)));
      if (other && other.catalogueKey !== body.catalogueKey) reject(409, "CATALOGUE_PRINCIPAL_BOUND", "This exact principal is already bound to another role. Choose another principal; bindings will not be silently moved.");
      const values = {
        organizationId, catalogueKey: body.catalogueKey, catalogueVersion: body.catalogueVersion,
        agentId: principal!.id, principalVersion: principal!.version, version: (existing?.version ?? 0) + 1,
        requestId: body.requestId, requestDigest: digest, actorUserId: actor,
         intakeAuthorization: body.catalogueKey === INTAKE_CONVERSION_KEY
           ? { capability: "intake-conversion/v1" as const, ownerUserId: body.ownerUserId,
             ownerMembershipRevision: (await intakeOwnerMembershipRevision(tx, organizationId, body.ownerUserId))!,
             activatedAt: new Date().toISOString() } : null,
      };
      if (!await administrator(tx, organizationId, actor)) reject(403, "CATALOGUE_ADMIN_REQUIRED", "Administrator access ended. Reload and verify again.");
      const [binding] = await tx.insert(agentCatalogueBindings).values(values).onConflictDoUpdate({
        target: [agentCatalogueBindings.organizationId, agentCatalogueBindings.catalogueKey], set: values,
      }).returning();
      await tx.insert(agentCatalogueSetupReceipts).values({
        organizationId, requestId: body.requestId, requestDigest: digest,
        catalogueKey: body.catalogueKey, bindingVersion: binding!.version,
      });
      await tx.insert(accessGovernanceHistory).values({
        organizationId, actorUserId: actor, eventType: existing ? "agent.catalogue.rebound" : "agent.catalogue.registered",
        entityType: "agent", entityId: principal!.id,
         detail: { catalogueKey: body.catalogueKey, catalogueVersion: body.catalogueVersion, bindingVersion: binding!.version, principalVersion: principal!.version, ownerUserId: body.ownerUserId, previousAgentId: existing?.agentId ?? null, createdPrincipal: !body.agentId, intakeAuthorization: values.intakeAuthorization },
      });
      return { created: !existing, createdPrincipal: !body.agentId, binding };
    });
    res.status(result.created ? 201 : 200).json(RegisterCatalogueAgentResponse.parse(result));
  } catch (error) {
    if (error instanceof CatalogueSetupError) { res.status(error.status).json({ code: error.code, message: error.message }); return; }
    next(error);
  }
});
return router;
}
export default createAgentCatalogueRouter();
