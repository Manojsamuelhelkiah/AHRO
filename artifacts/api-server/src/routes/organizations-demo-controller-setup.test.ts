import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import cors from "cors";
import type { Server } from "node:http";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
// @ts-expect-error pg's package export map hides its installed @types/pg under bundler resolution.
import { Pool } from "pg";
import {
  db,
  DEMO_ORGANIZATION_ID,
  demoControllerSetupRequestsTable,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import * as schema from "@workspace/db/schema";
import {
  configureDemoControllerSetupDependencies,
  requireSameOriginDemoSetup,
} from "./organizations-demo-controller-setup";
import setupRouter from "./organizations-demo-controller-setup";
import { requireAuth } from "../middlewares/require-auth";
import {
  type MembershipLookup,
  type TenantMembership,
} from "../middlewares/tenant-context";

const userA = `demo-setup-a-${process.pid}-${Date.now()}`;
const userB = `demo-setup-b-${process.pid}-${Date.now()}`;
const sharedFlagUser = `demo-setup-shared-flag-${process.pid}-${Date.now()}`;
const sharedEmailUser = `demo-setup-shared-email-${process.pid}-${Date.now()}`;
const SHARED_REVIEWER_REASON =
  "Use your own authenticated account; shared reviewer accounts cannot become Demo administrators.";
const isolatedSchema = `demo_setup_test_${process.pid}_${Date.now()}`;
let rootPool: Pool | undefined;
let testPool: Pool | undefined;
let isolatedSchemaCreated = false;
let testDb: typeof db;
let server: Server | undefined;
let baseUrl: string;
let originalApproval: string | undefined;
let requestId: string;
let approvalValue: string;

async function call(
  path: string,
  options: {
    userId?: string;
    organizationId?: string;
    fetchSite?: string | null;
    method?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.userId) headers.set("x-test-user", options.userId);
  if (options.organizationId !== undefined) {
    headers.set("x-organization-id", options.organizationId);
  }
  if (options.fetchSite !== null) {
    headers.set("sec-fetch-site", options.fetchSite ?? "same-origin");
  }
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createIsolatedSchema(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required for the isolated setup route test",
    );
  }
  rootPool = new Pool({ connectionString });
  await rootPool.query(`CREATE SCHEMA ${quoteIdentifier(isolatedSchema)}`);
  isolatedSchemaCreated = true;
  await rootPool.end();
  rootPool = undefined;

  testPool = new Pool({
    connectionString,
    options: `-c search_path=${quoteIdentifier(isolatedSchema)},public`,
  });
  testDb = drizzle(testPool, { schema });
  await testPool.query(`
    CREATE TABLE organizations (
      id text PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      join_code_hash text NOT NULL UNIQUE,
      created_by_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE organization_memberships (
      id serial PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organizations(id),
      clerk_user_id text NOT NULL,
      role text NOT NULL DEFAULT 'member',
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      membership_revision integer NOT NULL DEFAULT 0,
      UNIQUE (organization_id, clerk_user_id)
    );
    CREATE TABLE demo_controller_setup_requests (
      request_id text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organizations(id),
      target_clerk_user_id text NOT NULL,
      approval_value text NOT NULL,
      approval_fingerprint text NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      approved_at timestamptz,
      approval_source text,
      completed_at timestamptz,
      membership_before text NOT NULL,
      membership_after text
    );
    CREATE INDEX demo_controller_setup_target_idx
      ON demo_controller_setup_requests (organization_id, target_clerk_user_id, requested_at);
    CREATE UNIQUE INDEX demo_controller_setup_one_grant_per_demo_idx
      ON demo_controller_setup_requests (organization_id)
      WHERE completed_at IS NOT NULL;
  `);
  await testDb.insert(organizationsTable).values({
    id: DEMO_ORGANIZATION_ID,
    name: "Isolated Demo Organization",
    slug: "isolated-demo",
    joinCodeHash: "isolated-demo-join-code",
    createdByUserId: "isolated-test",
  });
  await testDb.insert(organizationMembershipsTable).values([
    {
      organizationId: DEMO_ORGANIZATION_ID,
      clerkUserId: userA,
      role: "member",
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      clerkUserId: userB,
      role: "member",
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      clerkUserId: sharedFlagUser,
      role: "member",
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      clerkUserId: sharedEmailUser,
      role: "member",
    },
  ]);
}

const isolatedLookup: MembershipLookup = async (
  clerkUserId,
  requestedOrganizationId,
): Promise<TenantMembership | null | "ambiguous"> => {
  const rows = await testDb
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
    .where(
      requestedOrganizationId
        ? and(
            eq(organizationMembershipsTable.clerkUserId, clerkUserId),
            eq(
              organizationMembershipsTable.organizationId,
              requestedOrganizationId,
            ),
          )
        : eq(organizationMembershipsTable.clerkUserId, clerkUserId),
    )
    .limit(requestedOrganizationId ? 1 : 2);
  if (!requestedOrganizationId && rows.length !== 1) {
    return rows.length > 1 ? "ambiguous" : null;
  }
  return rows[0] ?? null;
};

before(async () => {
  originalApproval = process.env.DEMO_CONTROLLER_SETUP_APPROVAL;
  await createIsolatedSchema();
  configureDemoControllerSetupDependencies(
    testDb,
    async (req, res, next) => {
      const membership = await isolatedLookup(
        req.authUserId!,
        req.header("x-organization-id")?.trim() || undefined,
      );
      if (!membership || membership === "ambiguous") {
        res
          .status(403)
          .json({ message: "Isolated organization membership required" });
        return;
      }
      req.organizationId = membership.organizationId;
      req.organizationRole = membership.role;
      next();
    },
    async (userId) => {
      if (userId === sharedFlagUser) {
        return {
          emailAddresses: [],
          privateMetadata: { sharedDemoReviewer: true },
        };
      }
      if (userId === sharedEmailUser) {
        return {
          emailAddresses: ["demo.reviewer@example.com"],
          privateMetadata: {},
        };
      }
      return { emailAddresses: [], privateMetadata: {} };
    },
  );

  const app = express();
  app.use("/organizations/demo-controller-setup", requireSameOriginDemoSetup);
  app.use(cors({ credentials: true, origin: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user");
    Object.assign(req, {
      auth: Object.assign(
        () => ({
          userId: userId ?? null,
          sessionClaims: null,
          tokenType: "session_token" as const,
        }),
        { [Symbol.for("@clerk/express.auth")]: true },
      ),
    });
    next();
  });
  app.use(requireAuth);
  app.use(setupRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (originalApproval === undefined) {
    delete process.env.DEMO_CONTROLLER_SETUP_APPROVAL;
  } else {
    process.env.DEMO_CONTROLLER_SETUP_APPROVAL = originalApproval;
  }
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await testPool?.end();
  if (!isolatedSchemaCreated) return;
  rootPool = new Pool({ connectionString: process.env.DATABASE_URL });
  await rootPool.query(
    `DROP SCHEMA IF EXISTS ${quoteIdentifier(isolatedSchema)} CASCADE`,
  );
  await rootPool.end();
});

test("setup endpoints require same-origin Fetch Metadata before auth, CORS, or parsers", async () => {
  for (const fetchSite of [null, "cross-site", "same-site", "none"]) {
    const response = await call("/organizations/demo-controller-setup", {
      userId: userA,
      organizationId: DEMO_ORGANIZATION_ID,
      fetchSite,
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.headers.get("access-control-allow-credentials"),
      null,
    );
  }
  for (const fetchSite of [null, "cross-site", "same-site"]) {
    const response = await call(
      "/organizations/demo-controller-setup/request",
      {
        userId: userA,
        organizationId: DEMO_ORGANIZATION_ID,
        fetchSite,
        method: "OPTIONS",
      },
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.headers.get("access-control-allow-credentials"),
      null,
    );
  }
});

test("setup routes reject missing authentication, wrong tenant, and body target spoofing", async () => {
  const missingAuth = await call("/organizations/demo-controller-setup", {
    organizationId: DEMO_ORGANIZATION_ID,
  });
  assert.equal(missingAuth.status, 401);
  assert.equal(missingAuth.headers.get("cache-control"), "no-store");

  const wrongTenant = await call("/organizations/demo-controller-setup", {
    userId: userA,
    organizationId: "another-organization",
  });
  assert.equal(wrongTenant.status, 403);
  assert.equal(wrongTenant.headers.get("cache-control"), "no-store");

  const spoof = await call("/organizations/demo-controller-setup/request", {
    userId: userA,
    organizationId: DEMO_ORGANIZATION_ID,
    method: "POST",
    body: { targetUserId: userB },
  });
  assert.equal(spoof.status, 400);

  const selfPromotion = await call(
    "/organizations/demo-controller-setup/complete",
    {
      userId: userA,
      organizationId: DEMO_ORGANIZATION_ID,
      method: "POST",
      body: { requestId: randomUUID() },
    },
  );
  assert.equal(selfPromotion.status, 409);
});

test("shared reviewer marker and legacy email are denied on every setup operation", async () => {
  process.env.DEMO_CONTROLLER_SETUP_APPROVAL = randomBytes(32).toString("hex");
  for (const userId of [sharedFlagUser, sharedEmailUser]) {
    const status = await call("/organizations/demo-controller-setup", {
      userId,
      organizationId: DEMO_ORGANIZATION_ID,
    });
    assert.equal(status.status, 403);
    assert.equal((await json(status)).message, SHARED_REVIEWER_REASON);

    const request = await call("/organizations/demo-controller-setup/request", {
      userId,
      organizationId: DEMO_ORGANIZATION_ID,
      method: "POST",
    });
    assert.equal(request.status, 403);
    assert.equal((await json(request)).message, SHARED_REVIEWER_REASON);

    const complete = await call(
      "/organizations/demo-controller-setup/complete",
      {
        userId,
        organizationId: DEMO_ORGANIZATION_ID,
        method: "POST",
        body: { requestId: randomUUID() },
      },
    );
    assert.equal(complete.status, 403);
    assert.equal((await json(complete)).message, SHARED_REVIEWER_REASON);
  }

  const memberships = await testDb
    .select({
      clerkUserId: organizationMembershipsTable.clerkUserId,
      role: organizationMembershipsTable.role,
    })
    .from(organizationMembershipsTable)
    .where(
      eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
    );
  assert.equal(
    memberships.find(({ clerkUserId }) => clerkUserId === sharedFlagUser)?.role,
    "member",
  );
  assert.equal(
    memberships.find(({ clerkUserId }) => clerkUserId === sharedEmailUser)
      ?.role,
    "member",
  );
});

test("request is account-bound, reusable while active, and approval mismatch fails closed", async () => {
  const first = await call("/organizations/demo-controller-setup/request", {
    userId: userA,
    organizationId: DEMO_ORGANIZATION_ID,
    method: "POST",
  });
  assert.equal(first.status, 200);
  const firstBody = await json(first);
  requestId = firstBody.request.requestId;
  approvalValue = firstBody.request.approvalValue;
  assert.match(approvalValue, /^[a-f0-9]{64}$/);
  assert.equal(firstBody.request.approved, false);

  const second = await call("/organizations/demo-controller-setup/request", {
    userId: userA,
    organizationId: DEMO_ORGANIZATION_ID,
    method: "POST",
    body: {},
  });
  assert.equal(second.status, 200);
  const secondBody = await json(second);
  assert.equal(secondBody.request.requestId, requestId);
  assert.equal(secondBody.request.approvalValue, approvalValue);

  const wrongAccount = await call(
    "/organizations/demo-controller-setup/complete",
    {
      userId: userB,
      organizationId: DEMO_ORGANIZATION_ID,
      method: "POST",
      body: { requestId },
    },
  );
  assert.equal(wrongAccount.status, 409);

  process.env.DEMO_CONTROLLER_SETUP_APPROVAL = randomBytes(32).toString("hex");
  const mismatch = await call("/organizations/demo-controller-setup/complete", {
    userId: userA,
    organizationId: DEMO_ORGANIZATION_ID,
    method: "POST",
    body: { requestId },
  });
  assert.equal(mismatch.status, 403);
});

test("expired request cannot be completed and stale approval cannot approve replacement", async () => {
  await testDb
    .update(demoControllerSetupRequestsTable)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(demoControllerSetupRequestsTable.requestId, requestId));
  process.env.DEMO_CONTROLLER_SETUP_APPROVAL = approvalValue;

  const expired = await call("/organizations/demo-controller-setup/complete", {
    userId: userA,
    organizationId: DEMO_ORGANIZATION_ID,
    method: "POST",
    body: { requestId },
  });
  assert.equal(expired.status, 409);

  const replacement = await call(
    "/organizations/demo-controller-setup/request",
    {
      userId: userA,
      organizationId: DEMO_ORGANIZATION_ID,
      method: "POST",
    },
  );
  assert.equal(replacement.status, 200);
  const replacementBody = await json(replacement);
  assert.notEqual(replacementBody.request.requestId, requestId);
  requestId = replacementBody.request.requestId;
  approvalValue = replacementBody.request.approvalValue;

  const staleApproval = await call(
    "/organizations/demo-controller-setup/complete",
    {
      userId: userA,
      organizationId: DEMO_ORGANIZATION_ID,
      method: "POST",
      body: { requestId },
    },
  );
  assert.equal(staleApproval.status, 403);
});

test("concurrent completion has one winner, records the grant, and unlocks Demo Controller access", async () => {
  process.env.DEMO_CONTROLLER_SETUP_APPROVAL = approvalValue;
  const responses = await Promise.all([
    call("/organizations/demo-controller-setup/complete", {
      userId: userA,
      organizationId: DEMO_ORGANIZATION_ID,
      method: "POST",
      body: { requestId },
    }),
    call("/organizations/demo-controller-setup/complete", {
      userId: userA,
      organizationId: DEMO_ORGANIZATION_ID,
      method: "POST",
      body: { requestId },
    }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort((a, b) => a - b),
    [200, 409],
  );
  const completed = responses.find((response) => response.status === 200)!;
  const completedBody = await json(completed);
  assert.equal(completedBody.completed, true);
  assert.equal(completedBody.request, null);

  const [membership] = await testDb
    .select({ role: organizationMembershipsTable.role })
    .from(organizationMembershipsTable)
    .where(
      and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, userA),
      ),
    );
  assert.equal(membership?.role, "admin");

  const replay = await call("/organizations/demo-controller-setup/complete", {
    userId: userA,
    organizationId: DEMO_ORGANIZATION_ID,
    method: "POST",
    body: { requestId },
  });
  assert.equal(replay.status, 409);

  const status = await call("/organizations/demo-controller-setup", {
    userId: userA,
    organizationId: DEMO_ORGANIZATION_ID,
  });
  const statusBody = await json(status);
  assert.equal(status.status, 200);
  assert.equal(statusBody.completed, true);
  assert.equal(statusBody.request, null);

  await testDb
    .update(organizationMembershipsTable)
    .set({ role: "member" })
    .where(
      and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, userA),
      ),
    );
  const afterRemoval = await call("/organizations/demo-controller-setup", {
    userId: userA,
    organizationId: DEMO_ORGANIZATION_ID,
  });
  const afterRemovalBody = await json(afterRemoval);
  assert.equal(afterRemovalBody.completed, true);
  assert.match(afterRemovalBody.reason, /already completed/i);
  const otherMember = await call("/organizations/demo-controller-setup", {
    userId: userB,
    organizationId: DEMO_ORGANIZATION_ID,
  });
  const otherMemberBody = await json(otherMember);
  assert.equal(otherMember.status, 200);
  assert.equal(otherMemberBody.completed, true);
  assert.equal(otherMemberBody.eligible, false);
  assert.equal(otherMemberBody.request, null);
  assert.match(otherMemberBody.reason, /already completed for Demo Organization/i);

  await testDb
    .update(organizationMembershipsTable)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
      eq(organizationMembershipsTable.clerkUserId, userB),
    ));
  const revokedMember = await call("/organizations/demo-controller-setup", {
    userId: userB,
    organizationId: DEMO_ORGANIZATION_ID,
  });
  assert.equal(revokedMember.status, 403);
});
