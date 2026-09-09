import type { NextFunction, Request, Response } from "express";
import { eq, type AnyColumn, type SQL } from "drizzle-orm";

type OrganizationRequest = Request & { organizationId?: string };
type OrganizationTable = { organizationId: AnyColumn };

export function getOrganizationId(req: Request): string {
  const organizationId = (req as OrganizationRequest).organizationId;
  if (!organizationId) {
    throw new Error("Authenticated request is missing organization context");
  }
  return organizationId;
}

export function requireOrganizationScope(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!(req as OrganizationRequest).organizationId) {
    res.status(403).json({ message: "Organization membership required" });
    return;
  }
  next();
}

/**
 * Kept structural so route work can land independently of the schema migration
 * which adds organizationId to tenant-owned tables.
 */
export function organizationWhere(table: unknown, organizationId: string): SQL {
  const column = (table as OrganizationTable).organizationId;
  if (!column) {
    throw new Error("Tenant-owned table is missing organizationId");
  }
  return eq(column, organizationId);
}

export function organizationValues(
  organizationId: string,
): { organizationId: string } {
  return { organizationId };
}