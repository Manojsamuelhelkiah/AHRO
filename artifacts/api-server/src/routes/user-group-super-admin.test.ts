import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, organizationMembershipsTable, organizationsTable } from "@workspace/db";
import accessGovernanceRouter from "./access-governance";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import {
  ADMIN_APPROVAL_KEY, ADMIN_COOKIE, ADMIN_LIFETIME_MS,
  createPlatformAdminContext, signAdminGrant,
} from "../lib/private-platform-admin";

test("preset group creation accepts active Super Admin without elevating its underlying membership", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousSecret = process.env.SESSION_SECRET;
  const secret = randomBytes(32).toString("hex");
  process.env.NODE_ENV = "development";
  process.env.SESSION_SECRET = secret;
  const organizationId = `group-admin-${randomUUID()}`;
  const actor = `group-admin-member-${randomUUID()}`;
  const owner = `group-admin-owner-${randomUUID()}`;
  const sessionId = "group-admin-fixture-session";
  const generation = "group-admin-fixture-generation";
  const issuedAt = Date.now();
  const grant = {
    userId: actor, sessionId, generation, environment: "development",
    issuedAt, expiresAt: issuedAt + ADMIN_LIFETIME_MS,
  };
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    await db.insert(organizationsTable).values({
      id: organizationId, name: "Isolated group creation fixture",
      slug: organizationId, joinCodeHash: organizationId, createdByUserId: owner,
    });
    await db.insert(organizationMembershipsTable).values([
      { organizationId, clerkUserId: actor, role: "member" },
      { organizationId, clerkUserId: owner, role: "owner" },
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.authUserId = req.header("x-fixture-user") || actor;
      // Test-only provider identity. No authentication shortcut is installed
      // in the running application.
      Object.defineProperty(req, "auth", { value: Object.assign(() => ({
        userId: req.authUserId, sessionId, sessionClaims: { fva: [0, 0] },
        tokenType: "session_token",
      }), { [Symbol.for("@clerk/express.auth")]: true }) });
      next();
    });
    app.use(createPlatformAdminContext({
      getUser: async () => ({
        id: actor, primaryEmailAddressId: "fixture-email", twoFactorEnabled: true,
        emailAddresses: [{ id: "fixture-email", verification: { status: "verified" } }],
        privateMetadata: { [ADMIN_APPROVAL_KEY]: {
          userId: actor, primaryEmailId: "fixture-email", environment: "development",
          generation, decisionRef: "fixture-private-approval",
        } },
      }),
      getSession: async () => ({ userId: actor, status: "active" }),
      isDemo: async () => false,
    }));
    app.use("/access", createTenantContextMiddleware(lookupMembership), accessGovernanceRouter);
    server = app.listen(0);
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    async function create(starterId: string, userId = actor, proof?: string) {
      const response = await fetch(`${base}/access/user-groups`, {
        method: "POST",
        headers: {
          "content-type": "application/json", "x-fixture-user": userId,
          "x-organization-id": organizationId, origin: base,
          ...(proof ? { cookie: `${ADMIN_COOKIE}=${proof}` } : {}),
        },
        body: JSON.stringify({ starterId }),
      });
      const body = await response.json() as {
        userGroup: { id: string; ownerUserId: string; members: unknown[]; securityGroups: unknown[] };
      };
      return { status: response.status, body };
    }
    assert.equal((await create("hr")).status, 403, "Ordinary member must remain restricted");
    const proof = signAdminGrant(grant, secret);
    const first = await create("hr", actor, proof);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.userGroup.ownerUserId, actor);
    assert.deepEqual(first.body.userGroup.members, []);
    assert.deepEqual(first.body.userGroup.securityGroups, []);
    const second = await create("hr", actor, proof);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.userGroup.id, first.body.userGroup.id);
    assert.equal((await create("hr")).status, 403, "Sign-out must not leave owner rights behind");
    const expired = signAdminGrant({ ...grant, issuedAt: issuedAt - ADMIN_LIFETIME_MS - 1,
      expiresAt: issuedAt - 1 }, secret);
    assert.equal((await create("hr", actor, expired)).status, 403);
    const membership = await db.select().from(organizationMembershipsTable)
      .where(eq(organizationMembershipsTable.clerkUserId, actor));
    assert.equal(membership[0].role, "member");
    const ownerResult = await create("payroll", owner);
    assert.equal(ownerResult.status, 201, JSON.stringify(ownerResult.body));
  } finally {
    if (server) await new Promise<void>((resolve, reject) =>
      server!.close(error => error ? reject(error) : resolve()));
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});
