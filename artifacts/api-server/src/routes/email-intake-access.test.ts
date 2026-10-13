import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import express from "express";
import { eq } from "drizzle-orm";
import { db, pool, organizationsTable, organizationMembershipsTable, DEMO_ORGANIZATION_ID,
  hroMailboxIngress, hroEmailRequests, onbCases, onbSettings } from "@workspace/db";
import { createDevelopmentAdminContext } from "../lib/development-super-admin";
import { createPlatformAdminContext, ADMIN_APPROVAL_KEY, ADMIN_COOKIE, ADMIN_LIFETIME_MS, signAdminGrant } from "../lib/private-platform-admin";
import { demoPrincipalSettingKey } from "../lib/demo-principal";
import { requireTenantContext } from "../middlewares/tenant-context";
import { withControlledEmailIntakeProvider } from "../lib/hro-email-ingestion";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import router from "./hro-email-intake";

test("live Email Intake HTTP access survives async navigation requests; expiry, revocation, Demo and tenant boundaries fail closed", { timeout: 120_000 }, async () => {
  const previous = { mode: process.env.NODE_ENV, password: process.env.DEV_SUPER_ADMIN_PASSWORD, secret: process.env.SESSION_SECRET, e2e: process.env.ONBOARDING_E2E_TEST };
  const secret = randomUUID() + randomUUID(), actor = `intake-access-${randomUUID()}`;
  const org = `intake-access-${randomUUID()}`, other = `${org}-other`;
  let providerReads = 0, providerActive = false, status = "active", generation = "reviewed";
  const issuedAt = Date.now() - 1000;
  let createdAt = issuedAt + 500;
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    for (const id of [org, other]) await db.insert(organizationsTable).values({
      id, name: "Isolated intake access", slug: id, joinCodeHash: randomUUID(), createdByUserId: actor,
    });
    await db.insert(organizationMembershipsTable).values({ organizationId: org, clerkUserId: actor, role: "member" });
    // Even a persisted Demo administrator marker is never a grant.
    await db.insert(onbSettings).values({ organizationId: DEMO_ORGANIZATION_ID, key: demoPrincipalSettingKey(actor), value: "administrator" });
    process.env.NODE_ENV = "test"; process.env.ONBOARDING_E2E_TEST = "true";
    const enterProvider = withControlledEmailIntakeProvider({ get: async path => {
      assert.equal(path, "/gmail/v1/users/me/profile");
      providerReads++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return { ok: providerActive, json: async () => ({ emailAddress: "isolated@example.invalid" }) };
    } }, () => AsyncLocalStorage.bind((next: () => void) => next()));
    process.env.NODE_ENV = "development";
    process.env.DEV_SUPER_ADMIN_PASSWORD = secret; process.env.SESSION_SECRET = secret;
    const development = createDevelopmentAdminContext({ getSession: async () => {
      await new Promise(resolve => setTimeout(resolve, 3));
      return { userId: actor, status, createdAt };
    } });
    const privateContext = createPlatformAdminContext({
      getSession: async () => ({ userId: actor, status }),
      getUser: async () => ({
        id: actor, primaryEmailAddressId: "verified-primary", twoFactorEnabled: true,
        emailAddresses: [{ id: "verified-primary", verification: { status: "verified" } }],
        privateMetadata: { [ADMIN_APPROVAL_KEY]: { userId: actor, primaryEmailId: "verified-primary",
          environment: "production", generation, decisionRef: "independently-approved-fixture" } },
      }),
      isDemo: async () => false, // private identity fixture, not a real shared Demo operator
    });
    const app = express();
    app.use((req, _res, next) => enterProvider(() => {
      req.authUserId = actor;
      Object.assign(req, { auth: Object.assign(() => ({
        userId: actor, sessionId: "fixture-session", sessionClaims: { fva: [0, 0] }, tokenType: "session_token",
      }), { [Symbol.for("@clerk/express.auth")]: true }) });
      next();
    }));
    app.use((req, res, next) => { void (process.env.NODE_ENV === "production" ? privateContext : development)(req, res, next); });
    app.use(requireTenantContext);
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const get = (path: string, cookie = "", tenant = org) => fetch(`http://127.0.0.1:${port}/api/onboarding/email-intake${path}`, {
      headers: { cookie, "x-organization-id": tenant, "sec-fetch-site": "same-origin" },
    });
    const bodyOf = async (response: globalThis.Response) => await response.json() as Record<string, unknown>;
    const devCookie = (options: { expired?: boolean; sessionId?: string; unbound?: boolean } = {}) => {
      const start = options.expired ? Date.now() - 4 * 60 * 60_000 - 1000 : issuedAt;
      const payload = Buffer.from(JSON.stringify({ userId: actor, issuedAt: start, expiresAt: start + 4 * 60 * 60_000,
        ...(options.unbound ? {} : { sessionId: options.sessionId ?? "fixture-session" }) })).toString("base64url");
      return `hro_dev_super_admin=${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
    };
    const assertReady = async (cookie: string, tenant = org) => {
      const response = await get("", cookie, tenant);
      assert.equal(response.status, 200, await response.clone().text());
      const body = await bodyOf(response);
      assert.equal(body.ready, false);
      assert.equal(body.mailboxAddress, null);
      assert.equal(body.canConfigure, true);
      assert.equal(body.canReview, true);
      assert.deepEqual(body.routes, []);
    };
    const cookie = devCookie();
    // The login proof initially precedes the provider session. Concurrent
    // first requests bind it to the same verified provider session.
    const initial = await Promise.all([get("", devCookie({ unbound: true })), get("/requests", devCookie({ unbound: true }))]);
    for (const response of initial) {
      assert.equal(response.status, 200);
      assert.match(response.headers.get("set-cookie") ?? "", /^hro_dev_super_admin=/);
    }
    // Each GET is a new request scope, just like navigation/reload/focus/polls.
    for (let navigation = 0; navigation < 4; navigation++) {
      await assertReady(cookie);
      await Promise.all([assertReady(cookie), get("/requests", cookie).then(async r => {
        assert.equal(r.status, 200); assert.deepEqual(await r.json(), []);
      })]);
    }
    await assertReady(cookie, other); // explicitly selected existing tenant, no permanent membership
    const wrongTenant = await get("", cookie, "missing-client");
    assert.equal(wrongTenant.status, 403);
    assert.equal((await bodyOf(wrongTenant)).code, "ORGANIZATION_ACCESS_DENIED");
    const beforeDenied = providerReads;
    // Shared Demo cannot select the fixture client once verification is gone.
    const ordinary = await get("");
    assert.equal(ordinary.status, 403);
    const restricted = await get("", "", DEMO_ORGANIZATION_ID);
    // Fixture has no Demo membership; install a capped one solely for this read.
    assert.ok([403, 409].includes(restricted.status));
    await db.insert(organizationMembershipsTable).values({ organizationId: DEMO_ORGANIZATION_ID, clerkUserId: actor, role: "member" });
    const demo = await get("", "", DEMO_ORGANIZATION_ID);
    assert.equal(demo.status, 403);
    assert.equal((await bodyOf(demo)).code, "EMAIL_INTAKE_DEMO_RESTRICTED");
    for (const proof of [devCookie({ expired: true }), devCookie({ sessionId: "another-session" })]) {
      const response = await get("", proof);
      assert.equal(response.status, 403); assert.equal((await bodyOf(response)).code, "ADMIN_GRANT_INVALID");
    }
    status = "revoked";
    const revoked = await get("", cookie);
    assert.equal(revoked.status, 403); assert.equal((await bodyOf(revoked)).code, "ADMIN_REVOKED");
    status = "active"; createdAt = issuedAt - 1;
    assert.equal((await get("", cookie)).status, 403);
    createdAt = issuedAt + 500;
    assert.equal(providerReads, beforeDenied, "Denied requests never consult a mailbox");
    process.env.NODE_ENV = "production";
    const privateCookie = (expired = false) => {
      const start = expired ? Date.now() - ADMIN_LIFETIME_MS - 1000 : Date.now() - 500;
      return `${ADMIN_COOKIE}=${signAdminGrant({ userId: actor, sessionId: "fixture-session", environment: "production",
        generation: "reviewed", issuedAt: start, expiresAt: start + ADMIN_LIFETIME_MS }, secret)}`;
    };
    const privateProof = privateCookie();
    await Promise.all([assertReady(privateProof), assertReady(privateProof, other)]);
    status = "revoked";
    assert.equal((await get("", privateProof)).status, 403);
    status = "active"; generation = "replaced";
    assert.equal((await get("", privateProof)).status, 403);
    generation = "reviewed";
    assert.equal((await get("", privateCookie(true))).status, 403);
    for (const table of [hroMailboxIngress, hroEmailRequests, onbCases]) {
      assert.deepEqual(await db.select().from(table).where(eq(table.organizationId, org)), [], "Opening readiness never creates routes, mail or cases");
    }
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await db.delete(onbSettings).where(eq(onbSettings.key, demoPrincipalSettingKey(actor)));
    await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.clerkUserId, actor));
    for (const id of [org, other]) await deleteTestOrganizations(eq(organizationsTable.id, id));
    for (const [key, value] of Object.entries({
      NODE_ENV: previous.mode, DEV_SUPER_ADMIN_PASSWORD: previous.password, SESSION_SECRET: previous.secret, ONBOARDING_E2E_TEST: previous.e2e,
    })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await pool.end();
  }
});
