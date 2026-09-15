import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  organizationMembershipsTable,
  onbSettings,
  organizationsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/require-auth";
import {
  createTenantContextMiddleware,
  lookupMembership,
  ORGANIZATION_HEADER,
} from "../middlewares/tenant-context";
import demoControllerSetupRouter, {
  requireSameOriginDemoSetup,
} from "./organizations-demo-controller-setup";
import {
  changeOrganizationMemberRole,
  listOrganizationMembers,
  listRemovedOrganizationMembers,
  removeOrganizationMember,
  reinstateOrganizationMember,
} from "../lib/organization-memberships";
import {
  externalAnchoringStatus,
  runExternalAuditArchiveDrill,
} from "../lib/onboarding/external-audit-anchor";
import {
  EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY,
  EXTERNAL_AUDIT_ARCHIVE_GENERATION_KEY,
  parseExternalAuditArchiveConfig,
  saveExternalAuditArchiveConfig,
} from "../lib/onboarding/settings";
import { registeredDemoProfile } from "../lib/demo-principal";

const router: IRouter = Router();

// The setup value is returned only to the authenticated target, so establish
// no-store and browser resource isolation before authentication can reject an
// endpoint or any other organization route middleware can process it.
router.use("/organizations/demo-controller-setup", requireSameOriginDemoSetup);
router.use("/organizations", requireAuth);
router.use("/organizations", async (req, res, next): Promise<void> => {
  try {
    const profile = await registeredDemoProfile(req.authUserId!);
    const requested = req.header(ORGANIZATION_HEADER)?.trim();
    if (profile && requested && requested !== DEMO_ORGANIZATION_ID) {
      res.status(403).json({
        message: "Shared demo accounts are restricted to Demo Organization.",
        code: "DEMO_ACCOUNT_SCOPE_REQUIRED",
      });
      return;
    }
    const isDemoJoin =
      req.method === "POST" &&
      req.originalUrl.split("?")[0]?.endsWith("/organizations/join");
    if (
      profile &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !isDemoJoin
    ) {
      res.status(403).json({
        message: "Shared demo accounts cannot administer organization settings or membership.",
        code: "DEMO_ACCOUNT_PRIVILEGE_CEILING",
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});
router.use(demoControllerSetupRouter);
const requireTenantContext = createTenantContextMiddleware(lookupMembership);

function hashJoinCode(value: string): string {
  return createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
}

const DEMO_ORGANIZATION = {
  id: DEMO_ORGANIZATION_ID,
  name: "Demo Organization",
  slug: "demo",
  joinCodeHash:
    "4ff006ca6b88e752f08cb7881714505ceb3d2079eea432acfda8e158e0d1d82e",
  createdByUserId: "system",
} as const;

/**
 * Phase A deliberately publishes tenant columns before their organization
 * foreign keys. Create the well-known demo row only when a user explicitly
 * asks to join it; this is request data bootstrap, never startup/deploy DDL.
 */
export async function ensureDemoOrganization(): Promise<void> {
  await db
    .insert(organizationsTable)
    .values(DEMO_ORGANIZATION)
    .onConflictDoNothing({ target: organizationsTable.id });
}

function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "organization"
  );
}

router.get("/organizations/current", async (req, res, next): Promise<void> => {
  try {
    const userId = req.authUserId!;
    const requested = req.header(ORGANIZATION_HEADER)?.trim() || undefined;
    const profile = await registeredDemoProfile(userId);
    const allMemberships = await db
      .select({
        organizationId: organizationMembershipsTable.organizationId,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        role: organizationMembershipsTable.role,
      })
      .from(organizationMembershipsTable)
      .innerJoin(
        organizationsTable,
        eq(organizationsTable.id, organizationMembershipsTable.organizationId),
      )
       .where(and(
         eq(organizationMembershipsTable.clerkUserId, userId),
         isNull(organizationMembershipsTable.revokedAt),
       ))
      .orderBy(organizationMembershipsTable.createdAt);
    const memberships = profile
      ? allMemberships
          .filter(({ organizationId }) => organizationId === DEMO_ORGANIZATION_ID)
          .map((membership) => ({ ...membership, role: "member" as const }))
      : allMemberships;
    const activeOrganizationId = requested
      ? (memberships.find(({ organizationId }) => organizationId === requested)
          ?.organizationId ?? null)
      : memberships.length === 1
        ? memberships[0]!.organizationId
        : null;

    res.json({
      needsSetup: memberships.length === 0,
      activeOrganizationId,
      memberships,
      // This is a server-authenticated display capability only. All mutation
      // endpoints independently verify the profile and membership.
      demoProfile: profile,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/organizations/current/audit-archive", async (req, res, next): Promise<void> => {
  try {
    const organizationId = req.header(ORGANIZATION_HEADER)?.trim();
    if (!organizationId) {
      res.status(400).json({ message: "An active organization is required" });
      return;
    }
    const [membership] = await db
      .select({ role: organizationMembershipsTable.role })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, req.authUserId!),
        isNull(organizationMembershipsTable.revokedAt),
      ));
    if (!membership) {
      res.status(403).json({ message: "Organization membership required" });
      return;
    }
    res.json({ auditArchive: await externalAnchoringStatus(organizationId) });
  } catch (error) {
    next(error);
  }
});

router.put("/organizations/current/audit-archive", async (req, res, next): Promise<void> => {
  try {
    const organizationId = req.header(ORGANIZATION_HEADER)?.trim();
    if (!organizationId || req.body?.auditArchive === undefined) {
      res.status(400).json({ message: "An organization and auditArchive configuration are required" });
      return;
    }
    const [membership] = await db
      .select({ role: organizationMembershipsTable.role })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, req.authUserId!),
        isNull(organizationMembershipsTable.revokedAt),
      ));
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      res.status(403).json({ message: "Organization owner or admin role required" });
      return;
    }
    let auditArchive;
    try {
      auditArchive = parseExternalAuditArchiveConfig(req.body.auditArchive);
    } catch (error) {
      res.status(400).json({
        message: error instanceof Error ? error.message : "Invalid audit archive configuration",
      });
      return;
    }
    await saveExternalAuditArchiveConfig(organizationId, auditArchive);
    res.json({ auditArchive: await externalAnchoringStatus(organizationId) });
  } catch (error) {
    next(error);
  }
});

router.post("/organizations/current/audit-archive/drills", async (req, res, next): Promise<void> => {
  try {
    const organizationId = req.header(ORGANIZATION_HEADER)?.trim();
    const kind = req.body?.kind;
    if (!organizationId || (kind !== "restore" && kind !== "legal_hold")) {
      res.status(400).json({ message: "organization and a restore or legal_hold drill kind are required" });
      return;
    }
    const [membership] = await db
      .select({ role: organizationMembershipsTable.role })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, req.authUserId!),
        isNull(organizationMembershipsTable.revokedAt),
      ));
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      res.status(403).json({ message: "Organization owner or admin role required" });
      return;
    }
    res.json({
      drill: await runExternalAuditArchiveDrill(organizationId, kind),
      auditArchive: await externalAnchoringStatus(organizationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  "/organizations/current/removed-members",
  requireTenantContext,
  async (req, res, next): Promise<void> => {
    try {
      const result = await listRemovedOrganizationMembers(
        req.organizationId!,
        req.authUserId!,
      );
      if (result.kind !== "ok") {
        res.status(result.status).json({ message: result.message, code: result.code });
        return;
      }
      res.json(result.members);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/organizations/current/members/:userId/reinstate",
  requireTenantContext,
  async (req, res, next): Promise<void> => {
    try {
      const targetUserId = String(req.params.userId ?? "").trim();
      const expectedRevokedAt =
        typeof req.body?.expectedRevokedAt === "string"
          ? req.body.expectedRevokedAt
          : "";
      const expectedRevision =
        typeof req.body?.expectedRevision === "number"
          ? req.body.expectedRevision
          : Number.NaN;
      const reason =
        typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      const parsedExpectedRevokedAt = new Date(expectedRevokedAt);
      const validExpectedRevokedAt =
        Number.isFinite(parsedExpectedRevokedAt.getTime()) &&
        parsedExpectedRevokedAt.toISOString() === expectedRevokedAt;
      if (
        !targetUserId ||
        targetUserId.length > 200 ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        !expectedRevokedAt ||
        !validExpectedRevokedAt ||
        !reason ||
        reason.length > 1_000
      ) {
        res.status(400).json({
          message: "A valid expected removal timestamp, revision, and a 1–1000 character reason are required.",
          code: "INVALID_ORGANIZATION_MEMBERSHIP_REINSTATEMENT",
        });
        return;
      }
      const result = await reinstateOrganizationMember({
        organizationId: req.organizationId!,
        actorUserId: req.authUserId!,
        targetUserId,
        expectedRevokedAt: parsedExpectedRevokedAt,
        expectedRevision,
        reason,
      });
      if (result.kind !== "ok") {
        res.status(result.status).json({ message: result.message, code: result.code });
        return;
      }
      res.json(result.member);
    } catch (error) {
      next(error);
    }
  },
);

router.post("/organizations", async (req, res, next): Promise<void> => {
  if (await registeredDemoProfile(req.authUserId!)) {
    res.status(403).json({
      message: "Shared demo accounts cannot create organizations.",
      code: "DEMO_ACCOUNT_SCOPE_REQUIRED",
    });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 2 || name.length > 100) {
    res
      .status(400)
      .json({ message: "Organization name must be 2–100 characters" });
    return;
  }
  let auditArchive = null;
  try {
    auditArchive = parseExternalAuditArchiveConfig(req.body?.auditArchive);
  } catch (error) {
    res.status(400).json({
      message: error instanceof Error ? error.message : "Invalid audit archive configuration",
    });
    return;
  }
  try {
    const id = `org_${randomUUID()}`;
    const joinCode = randomBytes(6).toString("hex").toUpperCase();
    const slug = `${slugify(name)}-${id.slice(-8)}`;
    const organization = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(organizationsTable)
        .values({
          id,
          name,
          slug,
          joinCodeHash: hashJoinCode(joinCode),
          createdByUserId: req.authUserId!,
        })
        .returning({
          id: organizationsTable.id,
          name: organizationsTable.name,
          slug: organizationsTable.slug,
        });
      await tx.insert(organizationMembershipsTable).values({
        organizationId: id,
        clerkUserId: req.authUserId!,
        role: "owner",
      });
      if (auditArchive) {
        await tx.insert(onbSettings).values({
          organizationId: id,
          key: EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY,
          value: JSON.stringify(auditArchive),
        });
        await tx.insert(onbSettings).values({
          organizationId: id,
          key: EXTERNAL_AUDIT_ARCHIVE_GENERATION_KEY,
          value: "1",
        });
      }
      return created!;
    });
    res.status(201).json({
      organization,
      role: "owner",
      joinCode,
      auditArchive: await externalAnchoringStatus(id),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/organizations/join", async (req, res, next): Promise<void> => {
  const demo = req.body?.demo === true;
  const joinCode =
    typeof req.body?.joinCode === "string" ? req.body.joinCode.trim() : "";
  if (!demo && !joinCode) {
    res.status(400).json({ message: "A join code is required" });
    return;
  }
  try {
    if (await registeredDemoProfile(req.authUserId!) && !demo) {
      res.status(403).json({
        message: "Shared demo accounts may only join Demo Organization.",
        code: "DEMO_ACCOUNT_SCOPE_REQUIRED",
      });
      return;
    }
    if (demo) await ensureDemoOrganization();
    const [organization] = await db
      .select({
        id: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
      })
      .from(organizationsTable)
      .where(
        demo
          ? eq(organizationsTable.id, DEMO_ORGANIZATION_ID)
          : eq(organizationsTable.joinCodeHash, hashJoinCode(joinCode)),
      )
      .limit(1);
    if (!organization) {
      res.status(404).json({ message: "Organization join code was not found" });
      return;
    }
    const [existingMembership] = await db
      .select({
        role: organizationMembershipsTable.role,
        revokedAt: organizationMembershipsTable.revokedAt,
      })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organization.id),
        eq(organizationMembershipsTable.clerkUserId, req.authUserId!),
      ));
    if (existingMembership?.revokedAt) {
      res.status(403).json({
        message: "This membership was revoked and cannot be restored with a join code.",
        code: "ORGANIZATION_MEMBERSHIP_REVOKED",
      });
      return;
    }
    await db
      .insert(organizationMembershipsTable)
      .values({
        organizationId: organization.id,
        clerkUserId: req.authUserId!,
        role: "member",
      })
      .onConflictDoNothing({
        target: [
          organizationMembershipsTable.organizationId,
          organizationMembershipsTable.clerkUserId,
        ],
      });
    const [membership] = await db
      .select({ role: organizationMembershipsTable.role })
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.organizationId, organization.id),
          eq(organizationMembershipsTable.clerkUserId, req.authUserId!),
          isNull(organizationMembershipsTable.revokedAt),
        ),
      );
    if (!membership) {
      res.status(409).json({
        message: "Membership changed before the join completed.",
        code: "ORGANIZATION_MEMBERSHIP_CONFLICT",
      });
      return;
    }
    res.json({ organization, role: membership.role });
  } catch (error) {
    next(error);
  }
});

/**
 * Member administration deliberately sits behind the regular tenant context:
 * a selector is not authority and a revoked account must fail closed before
 * any member data is read.
 */
router.get(
  "/organizations/members",
  requireTenantContext,
  async (req, res, next): Promise<void> => {
    try {
      const result = await listOrganizationMembers(
        req.organizationId!,
        req.authUserId!,
      );
      if (result.kind !== "ok") {
        res.status(result.status).json({ message: result.message, code: result.code });
        return;
      }
      res.json(result.members);
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/organizations/members/:userId",
  requireTenantContext,
  async (req, res, next): Promise<void> => {
    try {
      const targetUserId = String(req.params.userId ?? "").trim();
      const expectedRole = typeof req.body?.expectedRole === "string"
        ? req.body.expectedRole
        : "";
      const role = typeof req.body?.role === "string" ? req.body.role : "";
      if (!targetUserId || !["member", "admin"].includes(role) ||
          !["owner", "admin", "member"].includes(expectedRole)) {
        res.status(400).json({
          message: "A target role and expected current role are required.",
          code: "INVALID_ORGANIZATION_MEMBERSHIP_MUTATION",
        });
        return;
      }
      const result = await changeOrganizationMemberRole({
        organizationId: req.organizationId!,
        actorUserId: req.authUserId!,
        targetUserId,
        expectedRole: expectedRole as "owner" | "admin" | "member",
        role: role as "admin" | "member",
      });
      if (result.kind !== "ok") {
        res.status(result.status).json({ message: result.message, code: result.code });
        return;
      }
      res.json(result.member);
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/organizations/members/:userId",
  requireTenantContext,
  async (req, res, next): Promise<void> => {
    try {
      const targetUserId = String(req.params.userId ?? "").trim();
      const expectedRole = typeof req.body?.expectedRole === "string"
        ? req.body.expectedRole
        : "";
      if (!targetUserId || !["owner", "admin", "member"].includes(expectedRole)) {
        res.status(400).json({
          message: "The expected current role is required.",
          code: "INVALID_ORGANIZATION_MEMBERSHIP_MUTATION",
        });
        return;
      }
      const result = await removeOrganizationMember({
        organizationId: req.organizationId!,
        actorUserId: req.authUserId!,
        targetUserId,
        expectedRole: expectedRole as "owner" | "admin" | "member",
      });
      if (result.kind !== "ok") {
        res.status(result.status).json({ message: result.message, code: result.code });
        return;
      }
      res.json(result.member);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
