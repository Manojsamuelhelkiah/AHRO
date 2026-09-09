import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";

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
  const where = requestedOrganizationId
    ? and(
        eq(organizationMembershipsTable.clerkUserId, clerkUserId),
        eq(organizationMembershipsTable.organizationId, requestedOrganizationId),
      )
    : eq(organizationMembershipsTable.clerkUserId, clerkUserId);
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
    .limit(requestedOrganizationId ? 1 : 2);
  if (!requestedOrganizationId && memberships.length !== 1) {
    return memberships.length > 1 ? "ambiguous" : null;
  }
  return memberships[0] ?? null;
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
        res.status(409).json({
          message: "Select an organization before accessing tenant data",
          code: "ORGANIZATION_SELECTION_REQUIRED",
        });
        return;
      }
      if (!membership) {
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
      next();
    } catch (error) {
      req.log?.error({ err: error }, "Failed to resolve organization membership");
      next(error);
    }
  };
}

export const requireTenantContext = createTenantContextMiddleware();