import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { and, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  demoControllerSetupRequestsTable,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import {
  CompleteDemoControllerSetupBody,
  CompleteDemoControllerSetupResponse,
  GetDemoControllerSetupStatusResponse,
  RequestDemoControllerSetupResponse,
} from "@workspace/api-zod";
import {
  ORGANIZATION_HEADER,
  requireTenantContext,
} from "../middlewares/tenant-context";
import { clerkClient } from "@clerk/express";
import {
  DEMO_LOGIN_EMAIL,
  SHARED_DEMO_REVIEWER_DENIAL_REASON,
  SHARED_DEMO_REVIEWER_METADATA_KEY,
} from "../lib/demo-reviewer";

const router: IRouter = Router();
let setupDatabase: typeof db = db;
let setupTenantContext: typeof requireTenantContext = requireTenantContext;
export type DemoControllerPrincipal = {
  emailAddresses: string[];
  privateMetadata: Record<string, unknown> | null | undefined;
};
export type DemoControllerPrincipalLookup = (
  userId: string,
) => Promise<DemoControllerPrincipal>;
let setupPrincipalLookup: DemoControllerPrincipalLookup =
  defaultDemoControllerPrincipalLookup;

/**
 * Route tests can provide a Drizzle database and tenant lookup backed by a
 * temporary PostgreSQL schema. Production keeps the default application DB.
 */
export function configureDemoControllerSetupDependencies(
  database: typeof db,
  tenantContext: typeof requireTenantContext = requireTenantContext,
  principalLookup: DemoControllerPrincipalLookup = defaultDemoControllerPrincipalLookup,
): void {
  setupDatabase = database;
  setupTenantContext = tenantContext;
  setupPrincipalLookup = principalLookup;
}

async function defaultDemoControllerPrincipalLookup(
  userId: string,
): Promise<DemoControllerPrincipal> {
  const user = await clerkClient.users.getUser(userId);
  return {
    emailAddresses: user.emailAddresses.map(({ emailAddress }) =>
      emailAddress.trim().toLowerCase(),
    ),
    privateMetadata: user.privateMetadata as Record<string, unknown>,
  };
}

const DEMO_SETUP_APPROVAL_ENV = "DEMO_CONTROLLER_SETUP_APPROVAL";
const DEMO_SETUP_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const DEMO_SETUP_APPROVAL_SOURCE = "deployment-operator" as const;
const DEMO_SETUP_APPROVAL_PATTERN = /^[a-f0-9]{64}$/;

export function noStoreDemoSetupResponse(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
}

/**
 * Demo setup is a browser-only same-origin capability. Fetch Metadata is
 * browser-controlled and must be checked before CORS, authentication, or
 * parsers can process a credentialed cross-origin request.
 */
export function requireSameOriginDemoSetup(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  noStoreDemoSetupResponse(req, res, () => {
    if (req.header("Sec-Fetch-Site") !== "same-origin") {
      res.status(403).json({
        message: "Demo Controller setup requires a same-origin browser request",
      });
      return;
    }
    next();
  });
}

router.use("/organizations/demo-controller-setup", requireSameOriginDemoSetup);
router.use("/organizations/demo-controller-setup", (req, res, next) => {
  if (req.header(ORGANIZATION_HEADER)?.trim() !== DEMO_ORGANIZATION_ID) {
    res.status(403).json({
      message: "Demo Controller setup requires the Demo Organization scope",
    });
    return;
  }
  void setupTenantContext(req, res, next);
});

class DemoControllerSetupError extends Error {
  constructor(
    message: string,
    readonly statusCode: 403 | 409 = 403,
  ) {
    super(message);
    this.name = "DemoControllerSetupError";
  }
}

function approvalFingerprint(
  approvalValue: string,
  requestId: string,
  organizationId: string,
  targetUserId: string,
): string {
  return createHash("sha256")
    .update(
      [
        "demo-controller-setup:v1",
        requestId,
        organizationId,
        targetUserId,
        approvalValue,
      ].join("\n"),
    )
    .digest("hex");
}

function configuredApprovalValue(): string | null {
  const value = process.env[DEMO_SETUP_APPROVAL_ENV];
  if (
    typeof value !== "string" ||
    value.length !== 64 ||
    !DEMO_SETUP_APPROVAL_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function fingerprintsMatch(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) {
    return false;
  }
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function setupRequestResponse(
  row: typeof demoControllerSetupRequestsTable.$inferSelect,
  approved: boolean,
): {
  requestId: string;
  approvalValue: string;
  expiresAt: string;
  approved: boolean;
} {
  return {
    requestId: row.requestId,
    approvalValue: row.approvalValue,
    expiresAt: row.expiresAt.toISOString(),
    approved,
  };
}

function setupBodyIsEmpty(body: unknown): boolean {
  return (
    body === undefined ||
    (typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 0)
  );
}

function rejectUnknownSetupBody(
  body: unknown,
  allowed: readonly string[],
): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be an object.";
  }
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  return unknown.length > 0 ? `Unknown field(s): ${unknown.join(", ")}` : null;
}

function setupResponseFor(
  row: typeof demoControllerSetupRequestsTable.$inferSelect | null,
  role: "owner" | "admin" | "member",
  hasExistingAdmin: boolean,
  completed: boolean,
) {
  const eligible = role === "member" && !hasExistingAdmin && !completed;
  const reason = completed
    ? "Demo Controller setup was already completed for Demo Organization; the one-time bootstrap cannot be replayed. Contact the project operator if administrator access has been lost."
    : role !== "member"
      ? "Demo Controller is already available through an existing Demo Organization owner or admin."
      : hasExistingAdmin
        ? "Use the existing Demo Organization owner or admin; bootstrap is not needed."
        : null;
  const configured = configuredApprovalValue();
  const request =
    eligible && row && row.expiresAt.getTime() > Date.now()
      ? setupRequestResponse(
          row,
          configured !== null &&
            fingerprintsMatch(
              approvalFingerprint(
                configured,
                row.requestId,
                row.organizationId,
                row.targetClerkUserId,
              ),
              row.approvalFingerprint,
            ),
        )
      : null;
  return {
    eligible,
    reason,
    request,
    completed,
  };
}

async function loadDemoControllerSetupStatus(userId: string) {
  const [membership] = await setupDatabase
    .select({ role: organizationMembershipsTable.role })
    .from(organizationMembershipsTable)
    .where(
      and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  if (!membership) {
    throw new DemoControllerSetupError("Demo Organization membership required");
  }
  const [admin] = await setupDatabase
    .select({ id: organizationMembershipsTable.id })
    .from(organizationMembershipsTable)
    .where(
      and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        inArray(organizationMembershipsTable.role, ["owner", "admin"]),
      ),
    )
    .limit(1);
  const [completedGrant] = await setupDatabase
    .select({ requestId: demoControllerSetupRequestsTable.requestId })
    .from(demoControllerSetupRequestsTable)
    .where(
      and(
        eq(
          demoControllerSetupRequestsTable.organizationId,
          DEMO_ORGANIZATION_ID,
        ),
        isNotNull(demoControllerSetupRequestsTable.completedAt),
      ),
    )
    .limit(1);
  const [request] = await setupDatabase
    .select()
    .from(demoControllerSetupRequestsTable)
    .where(
      and(
        eq(
          demoControllerSetupRequestsTable.organizationId,
          DEMO_ORGANIZATION_ID,
        ),
        eq(demoControllerSetupRequestsTable.targetClerkUserId, userId),
        isNull(demoControllerSetupRequestsTable.completedAt),
        gt(demoControllerSetupRequestsTable.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(demoControllerSetupRequestsTable.requestedAt))
    .limit(1);
  return setupResponseFor(
    request ?? null,
    membership.role,
    Boolean(admin),
    Boolean(completedGrant),
  );
}

function requireDemoMember(req: Request): void {
  if (req.organizationRole !== "member") {
    throw new DemoControllerSetupError(
      "Demo Controller setup requires a Demo Organization member without owner/admin access",
    );
  }
}

async function requireEligiblePrincipal(userId: string): Promise<void> {
  let principal: DemoControllerPrincipal;
  try {
    principal = await setupPrincipalLookup(userId);
  } catch {
    throw new DemoControllerSetupError(
      "Unable to verify the authenticated account for Demo setup",
    );
  }
  const privateMetadata = principal.privateMetadata ?? {};
  const isSharedReviewer =
    privateMetadata[SHARED_DEMO_REVIEWER_METADATA_KEY] === true ||
    principal.emailAddresses.some(
      (email) => email.trim().toLowerCase() === DEMO_LOGIN_EMAIL,
    );
  if (isSharedReviewer) {
    throw new DemoControllerSetupError(SHARED_DEMO_REVIEWER_DENIAL_REASON);
  }
}

router.get(
  "/organizations/demo-controller-setup",
  async (req, res, next): Promise<void> => {
    try {
      await requireEligiblePrincipal(req.authUserId!);
      const response = await loadDemoControllerSetupStatus(req.authUserId!);
      res.json(GetDemoControllerSetupStatusResponse.parse(response));
    } catch (error) {
      if (error instanceof DemoControllerSetupError) {
        res.status(error.statusCode).json({ message: error.message });
        return;
      }
      next(error);
    }
  },
);

router.post(
  "/organizations/demo-controller-setup/request",
  async (req, res, next): Promise<void> => {
    try {
      if (!setupBodyIsEmpty(req.body)) {
        res.status(400).json({
          message: "Setup request body must be empty",
        });
        return;
      }
      await requireEligiblePrincipal(req.authUserId!);
      requireDemoMember(req);
      const userId = req.authUserId!;
      const row = await setupDatabase.transaction(async (tx) => {
        const [organization] = await tx
          .select({ id: organizationsTable.id })
          .from(organizationsTable)
          .where(eq(organizationsTable.id, DEMO_ORGANIZATION_ID))
          .for("update");
        if (!organization) {
          throw new DemoControllerSetupError(
            "Demo Organization is not available",
            409,
          );
        }
        const [membership] = await tx
          .select({
            role: organizationMembershipsTable.role,
          })
          .from(organizationMembershipsTable)
          .where(
            and(
              eq(
                organizationMembershipsTable.organizationId,
                DEMO_ORGANIZATION_ID,
              ),
              eq(organizationMembershipsTable.clerkUserId, userId),
            ),
          )
          .for("update");
        if (!membership || membership.role !== "member") {
          throw new DemoControllerSetupError(
            "Demo Controller setup requires a Demo Organization member without owner/admin access",
          );
        }
        const [existingAdmin] = await tx
          .select({ id: organizationMembershipsTable.id })
          .from(organizationMembershipsTable)
          .where(
            and(
              eq(
                organizationMembershipsTable.organizationId,
                DEMO_ORGANIZATION_ID,
              ),
              inArray(organizationMembershipsTable.role, ["owner", "admin"]),
            ),
          )
          .limit(1);
        if (existingAdmin) {
          throw new DemoControllerSetupError(
            "Use the existing Demo Organization owner or admin; bootstrap is not needed",
            409,
          );
        }
        const [completedGrant] = await tx
          .select({ requestId: demoControllerSetupRequestsTable.requestId })
          .from(demoControllerSetupRequestsTable)
          .where(
            and(
              eq(
                demoControllerSetupRequestsTable.organizationId,
                DEMO_ORGANIZATION_ID,
              ),
              isNotNull(demoControllerSetupRequestsTable.completedAt),
            ),
          )
          .limit(1);
        if (completedGrant) {
          throw new DemoControllerSetupError(
            "Demo Controller bootstrap has already been consumed",
            409,
          );
        }
        const now = new Date();
        const [existing] = await tx
          .select()
          .from(demoControllerSetupRequestsTable)
          .where(
            and(
              eq(
                demoControllerSetupRequestsTable.organizationId,
                DEMO_ORGANIZATION_ID,
              ),
              eq(demoControllerSetupRequestsTable.targetClerkUserId, userId),
              isNull(demoControllerSetupRequestsTable.completedAt),
              gt(demoControllerSetupRequestsTable.expiresAt, now),
            ),
          )
          .orderBy(desc(demoControllerSetupRequestsTable.requestedAt))
          .limit(1);
        if (existing) return existing;
        const requestId = randomUUID();
        const approvalValue = randomBytes(32).toString("hex");
        const expiresAt = new Date(now.getTime() + DEMO_SETUP_REQUEST_TTL_MS);
        const [created] = await tx
          .insert(demoControllerSetupRequestsTable)
          .values({
            requestId,
            organizationId: DEMO_ORGANIZATION_ID,
            targetClerkUserId: userId,
            approvalValue,
            approvalFingerprint: approvalFingerprint(
              approvalValue,
              requestId,
              DEMO_ORGANIZATION_ID,
              userId,
            ),
            requestedAt: now,
            expiresAt,
            membershipBefore: "member",
          })
          .returning();
        return created!;
      });
      const response = setupResponseFor(row, "member", false, false);
      res.json(RequestDemoControllerSetupResponse.parse(response));
    } catch (error) {
      if (error instanceof DemoControllerSetupError) {
        res.status(error.statusCode).json({ message: error.message });
        return;
      }
      next(error);
    }
  },
);

router.post(
  "/organizations/demo-controller-setup/complete",
  async (req, res, next): Promise<void> => {
    try {
      const unknown = rejectUnknownSetupBody(req.body, ["requestId"]);
      if (unknown) {
        res.status(400).json({ message: unknown });
        return;
      }
      const parsed = CompleteDemoControllerSetupBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: parsed.error.message });
        return;
      }
      await requireEligiblePrincipal(req.authUserId!);
      const configured = configuredApprovalValue();
      const userId = req.authUserId!;
      await setupDatabase.transaction(async (tx) => {
        const [organization] = await tx
          .select({ id: organizationsTable.id })
          .from(organizationsTable)
          .where(eq(organizationsTable.id, DEMO_ORGANIZATION_ID))
          .for("update");
        if (!organization) {
          throw new DemoControllerSetupError(
            "Demo Organization is not available",
            409,
          );
        }
        const [membership] = await tx
          .select({ role: organizationMembershipsTable.role })
          .from(organizationMembershipsTable)
          .where(
            and(
              eq(
                organizationMembershipsTable.organizationId,
                DEMO_ORGANIZATION_ID,
              ),
              eq(organizationMembershipsTable.clerkUserId, userId),
            ),
          )
          .for("update");
        const [request] = await tx
          .select()
          .from(demoControllerSetupRequestsTable)
          .where(
            and(
              eq(
                demoControllerSetupRequestsTable.requestId,
                parsed.data.requestId,
              ),
              eq(
                demoControllerSetupRequestsTable.organizationId,
                DEMO_ORGANIZATION_ID,
              ),
              eq(demoControllerSetupRequestsTable.targetClerkUserId, userId),
            ),
          )
          .for("update");
        if (!request) {
          throw new DemoControllerSetupError(
            "Setup request was not found for this account",
            409,
          );
        }
        if (request.completedAt) {
          throw new DemoControllerSetupError(
            "Setup request has already been consumed",
            409,
          );
        }
        if (!membership || membership.role !== "member") {
          throw new DemoControllerSetupError(
            "Demo Controller setup requires a Demo Organization member without owner/admin access",
          );
        }
        if (request.expiresAt.getTime() <= Date.now()) {
          throw new DemoControllerSetupError("Setup request has expired", 409);
        }
        if (!configured) {
          throw new DemoControllerSetupError(
            "Deployment operator approval is unavailable",
          );
        }
        const expectedFingerprint = approvalFingerprint(
          configured,
          request.requestId,
          request.organizationId,
          request.targetClerkUserId,
        );
        if (
          !fingerprintsMatch(expectedFingerprint, request.approvalFingerprint)
        ) {
          throw new DemoControllerSetupError(
            "Deployment operator approval does not match this request",
          );
        }
        const [existingAdmin] = await tx
          .select({ id: organizationMembershipsTable.id })
          .from(organizationMembershipsTable)
          .where(
            and(
              eq(
                organizationMembershipsTable.organizationId,
                DEMO_ORGANIZATION_ID,
              ),
              inArray(organizationMembershipsTable.role, ["owner", "admin"]),
            ),
          )
          .limit(1);
        if (existingAdmin) {
          throw new DemoControllerSetupError(
            "Use the existing Demo Organization owner or admin; bootstrap is not needed",
            409,
          );
        }
        const [completedGrant] = await tx
          .select({ requestId: demoControllerSetupRequestsTable.requestId })
          .from(demoControllerSetupRequestsTable)
          .where(
            and(
              eq(
                demoControllerSetupRequestsTable.organizationId,
                DEMO_ORGANIZATION_ID,
              ),
              isNotNull(demoControllerSetupRequestsTable.completedAt),
            ),
          )
          .limit(1);
        if (completedGrant) {
          throw new DemoControllerSetupError(
            "Demo Controller bootstrap has already been consumed",
            409,
          );
        }
        const now = new Date();
        const [promoted] = await tx
          .update(organizationMembershipsTable)
          .set({ role: "admin" })
          .where(
            and(
              eq(
                organizationMembershipsTable.organizationId,
                DEMO_ORGANIZATION_ID,
              ),
              eq(organizationMembershipsTable.clerkUserId, userId),
              eq(organizationMembershipsTable.role, "member"),
            ),
          )
          .returning({ id: organizationMembershipsTable.id });
        if (!promoted) {
          throw new DemoControllerSetupError(
            "Demo membership changed before setup completed",
            409,
          );
        }
        const [consumed] = await tx
          .update(demoControllerSetupRequestsTable)
          .set({
            approvedAt: now,
            approvalSource: DEMO_SETUP_APPROVAL_SOURCE,
            completedAt: now,
            membershipAfter: "admin",
          })
          .where(
            and(
              eq(demoControllerSetupRequestsTable.requestId, request.requestId),
              isNull(demoControllerSetupRequestsTable.completedAt),
            ),
          )
          .returning({ requestId: demoControllerSetupRequestsTable.requestId });
        if (!consumed) {
          throw new DemoControllerSetupError(
            "Setup request was consumed concurrently",
            409,
          );
        }
      });
      const response = {
        eligible: false,
        reason:
          "Demo Controller setup was already completed for this account; the one-time bootstrap cannot be replayed.",
        request: null,
        completed: true,
      };
      res.json(CompleteDemoControllerSetupResponse.parse(response));
    } catch (error) {
      if (error instanceof DemoControllerSetupError) {
        res.status(error.statusCode).json({ message: error.message });
        return;
      }
      next(error);
    }
  },
);

export default router;
