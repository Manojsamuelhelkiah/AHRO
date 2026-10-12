import type { NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { appendProtectedAudit } from "../lib/onboarding/protected-audit";
import { registeredDemoProfile } from "../lib/demo-principal";
import { bindPlatformSuperAdminTenant, isPlatformSuperAdmin } from "../lib/private-platform-admin";

export const ORGANIZATION_HEADER = "x-organization-id";

export type TenantMembership = {
  organizationId: string;
  organizationName: string;
  role: "owner" | "admin" | "member";
};

declare global {
  namespace Express {
    interface Request {
      organizationId?: string;
      organizationRole?: TenantMembership["role"];
    }
  }
}

export type MembershipLookup = (
  clerkUserId: string,
  requestedOrganizationId?: string,
) => Promise<TenantMembership | null | "ambiguous">;

export const lookupMembership: MembershipLookup = async (
  clerkUserId,
  requestedOrganizationId,
) => {
  if (isPlatformSuperAdmin(clerkUserId)) {
    const [organization] = await db.select({ organizationId: organizationsTable.id, organizationName: organizationsTable.name })
      .from(organizationsTable).where(eq(organizationsTable.id, requestedOrganizationId || DEMO_ORGANIZATION_ID)).limit(1);
    return organization ? { ...organization, role: "owner" } : null;
  }
  const demoProfile = await registeredDemoProfile(clerkUserId);
  if (demoProfile && requestedOrganizationId && requestedOrganizationId !== DEMO_ORGANIZATION_ID) {
    return null;
  }
  const effectiveOrganizationId = demoProfile
    ? DEMO_ORGANIZATION_ID
    : requestedOrganizationId;
  const where = effectiveOrganizationId
    ? and(
        eq(organizationMembershipsTable.clerkUserId, clerkUserId),
        eq(organizationMembershipsTable.organizationId, effectiveOrganizationId),
          isNull(organizationMembershipsTable.revokedAt),
      )
      : and(
          eq(organizationMembershipsTable.clerkUserId, clerkUserId),
          isNull(organizationMembershipsTable.revokedAt),
        );
  const memberships = await db
    .select({
      organizationId: organizationMembershipsTable.organizationId,
      organizationName: organizationsTable.name,
      role: organizationMembershipsTable.role,
    })
    .from(organizationMembershipsTable)
    .innerJoin(
      organizationsTable,
      eq(organizationsTable.id, organizationMembershipsTable.organizationId),
    )
    .where(where)
    .orderBy(organizationMembershipsTable.createdAt)
    .limit(effectiveOrganizationId ? 1 : 2);
  if (!effectiveOrganizationId && memberships.length !== 1) {
    return memberships.length > 1 ? "ambiguous" : null;
  }
  const membership = memberships[0];
  return membership
    ? { ...membership, role: demoProfile ? "member" : membership.role }
    : null;
};

/**
 * Resolves an authenticated Clerk user to an application organization. A
 * requested tenant is accepted only when an active membership exists.
 */
export function createTenantContextMiddleware(
  findMembership: MembershipLookup = lookupMembership,
) {
  return async function requireTenantContext(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!req.authUserId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    const header = req.header(ORGANIZATION_HEADER)?.trim();
    try {
      const membership = await findMembership(
        req.authUserId,
        header || undefined,
      );
      if (membership === "ambiguous") {
        await appendTenantSelectionDenial(req, Boolean(header), "selection-required");
        res.status(409).json({
          message: "Select an organization before accessing tenant data",
          code: "ORGANIZATION_SELECTION_REQUIRED",
        });
        return;
      }
      if (!membership) {
        await appendTenantSelectionDenial(req, Boolean(header), "membership-denied");
        res.status(header ? 403 : 409).json({
          message: header
            ? "You are not a member of the requested organization"
            : "Organization setup required",
          code: header ? "ORGANIZATION_ACCESS_DENIED" : "ORGANIZATION_SETUP_REQUIRED",
        });
        return;
      }
      req.organizationId = membership.organizationId;
      req.organizationRole = membership.role;
      if (req.developmentSuperAdmin || req.platformSuperAdmin) bindPlatformSuperAdminTenant(membership.organizationId);
      next();
    } catch (error) {
      req.log?.error({ err: error }, "Failed to resolve organization membership");
      next(error);
    }
  };
}

export const requireTenantContext = createTenantContextMiddleware();

/**
 * A requested tenant identifier is untrusted and must not become audit data.
 * Record only that a verified principal was denied tenant selection, under the
 * explicit platform audit scope, before returning the denial.
 */
async function appendTenantSelectionDenial(
  req: Request,
  requestedOrganizationSupplied: boolean,
  reason: "selection-required" | "membership-denied",
): Promise<void> {
  try {
    await appendProtectedAudit({
      organizationId: "platform-audit",
      actorId: req.authUserId ?? null,
      actorKind: req.authUserId ? "authenticated" : "system",
      actorAuthority: "tenant-selection:denied",
      action: "tenant-context.access-denied",
      outcome: "denied",
      objectType: "tenant-membership",
      source: "http",
      correlationId: req.header("x-request-id") ?? req.header("x-correlation-id"),
      payload: { requestedOrganizationSupplied, reason },
    });
  } catch (error) {
    // Selection was denied; never grant access because the accountability
    // writer is unavailable. The outer middleware turns this into a 500.
    throw error;
  }
}