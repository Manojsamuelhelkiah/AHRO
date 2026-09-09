import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/require-auth";
import { ORGANIZATION_HEADER } from "../middlewares/tenant-context";

const router: IRouter = Router();
router.use("/organizations", requireAuth);

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
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "organization";
}

router.get("/organizations/current", async (req, res, next): Promise<void> => {
  try {
    const userId = req.authUserId!;
    const requested = req.header(ORGANIZATION_HEADER)?.trim() || undefined;
    const memberships = await db
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
      .where(eq(organizationMembershipsTable.clerkUserId, userId))
      .orderBy(organizationMembershipsTable.createdAt);
    const activeOrganizationId = requested
      ? memberships.find(({ organizationId }) => organizationId === requested)
          ?.organizationId ?? null
      : memberships.length === 1
        ? memberships[0]!.organizationId
        : null;
    res.json({
      needsSetup: memberships.length === 0,
      activeOrganizationId,
      memberships,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/organizations", async (req, res, next): Promise<void> => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 2 || name.length > 100) {
    res.status(400).json({ message: "Organization name must be 2–100 characters" });
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
      return created!;
    });
    res.status(201).json({ organization, role: "owner", joinCode });
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
        ),
      );
    res.json({ organization, role: membership!.role });
  } catch (error) {
    next(error);
  }
});

export default router;