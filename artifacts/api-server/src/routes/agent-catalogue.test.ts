import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import { test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  accessAgents, accessGovernanceHistory, agentCatalogueBindings, customIntentsTable, db, onbSettings,
  organizationMembershipsTable, organizationsTable,
} from "@workspace/db";
import { agentCatalogue, AGENT_CATALOGUE_VERSION } from "../lib/agent-catalogue";
import { buildIntentCatalog } from "../lib/intent-catalog";
import { enrichMemberIdentities } from "../lib/member-identities";
import { demoPrincipalSettingKey } from "../lib/demo-principal";
import { createAgentCatalogueRouter } from "./agent-catalogue";
import { createTenantContextMiddleware, lookupMembership } from "../middlewares/tenant-context";
import { errorHandler } from "../middlewares/error-handler";
import {
  ADMIN_APPROVAL_KEY, ADMIN_COOKIE, ADMIN_LIFETIME_MS, createPlatformAdminContext, signAdminGrant,
} from "../lib/private-platform-admin";
import { GetAgentCatalogueResponse, RegisterCatalogueAgentBody, RegisterCatalogueAgentResponse } from "@workspace/api-zod";
import { z } from "zod";
type AgentCatalogue = z.infer<typeof GetAgentCatalogueResponse>;
type CatalogueAgentRegistrationInput = z.infer<typeof RegisterCatalogueAgentBody>;
type CatalogueRegistrationResult = z.infer<typeof RegisterCatalogueAgentResponse>;

test("additive intake conversion role preserves existing catalogue versions and coordination coverage", () => {
  const before = buildIntentCatalog();
  const roles = agentCatalogue();
  assert.equal(roles.length, 16);
  assert.equal(roles.filter(row => row.kind === "domain").length, 12);
  assert.equal(roles.filter(row => row.kind === "supporting").length, 4);
  assert.equal(new Set(roles.map(row => row.key)).size, 16);
  assert.deepEqual(roles.map(row => row.name), [
    "Onboarding Agent", "Offboarding Agent", "Employee Changes Agent", "Payroll Agent", "Benefits Agent",
    "Leave Agent", "Compliance Agent", "IT Access Agent", "Learning Agent", "Mobility Agent",
    "Documents & Records Agent", "HR Helpdesk Agent", "Assets & Workplace Agent",
    "Document Verification Agent", "Systems Watcher Agent", "Intake Conversion Agent",
  ]);
  for (const role of roles) {
    assert.ok(role.responsibility && role.prerequisites.length);
    assert.ok(["systems-watcher", "intake-conversion"].includes(role.key) || role.mappings.length > 0, `${role.key} requires canonical associations`);
    assert.equal(role.version, AGENT_CATALOGUE_VERSION);
    assert.equal(role.operationalCapability === "unavailable", role.key !== "intake-conversion");
    assert.equal(new Set(role.mappings.map(row => row.intentKey)).size, role.mappings.length);
    for (const mapping of role.mappings) {
      const intent = before.definitions.find(row => row.key === mapping.intentKey);
      assert.ok(intent, mapping.intentKey);
      assert.equal(mapping.intentVersion, intent.version);
      assert.equal(mapping.sourceVersion, before.version);
      assert.deepEqual(mapping.provenance, intent.provenance);
      assert.equal(mapping.reviewStatus, "reviewed");
    }
  }
  assert.ok(roles.find(row => row.key === "learning")!.mappings.some(row => row.intentKey === "assign-learning"));
  assert.equal(roles.find(row => row.key === "systems-watcher")!.mappings.length, 0);
  assert.deepEqual(buildIntentCatalog(), before);
  const source = readFileSync("src/routes/agent-catalogue.ts", "utf8");
  for (const forbidden of ["invokeAgentTool(", "withHroContext(", "sendEmail(", "runWorkflow(", "accessNamedGrants).values", "accessUserGroupMembers).values"]) assert.ok(!source.includes(forbidden));
});

test("isolated client catalogue setup: live administration, idempotency, conflicts and no operational effects", async () => {
  assert.ok(process.env.DATABASE_URL, "The isolated database harness is required.");
  const oldEnv = process.env.NODE_ENV, oldSecret = process.env.SESSION_SECRET;
  const secret = randomBytes(32).toString("hex");
  process.env.NODE_ENV = "development";
  process.env.SESSION_SECRET = secret;
  const organizationId = `catalogue-${randomUUID()}`, otherOrg = `catalogue-other-${randomUUID()}`;
  const owner = `catalogue-owner-${randomUUID()}`, admin = `catalogue-admin-${randomUUID()}`;
  const member = `catalogue-member-${randomUUID()}`, privateUser = `catalogue-private-${randomUUID()}`;
  const demo = `catalogue-demo-${randomUUID()}`;
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    await db.insert(organizationsTable).values([
      { id: organizationId, name: "Catalogue client", slug: organizationId, joinCodeHash: organizationId, createdByUserId: owner },
      { id: otherOrg, name: "Other catalogue client", slug: otherOrg, joinCodeHash: otherOrg, createdByUserId: owner },
    ]);
    await db.insert(organizationMembershipsTable).values([
      { organizationId, clerkUserId: owner, role: "owner" },
      { organizationId, clerkUserId: admin, role: "admin" },
      { organizationId, clerkUserId: member, role: "member" },
      { organizationId, clerkUserId: privateUser, role: "member" },
      { organizationId: otherOrg, clerkUserId: owner, role: "owner" },
      // Deliberately stale public Demo administrator membership cannot authorize setup.
      { organizationId: "demo", clerkUserId: demo, role: "admin" },
    ]);
    await db.insert(onbSettings).values({ organizationId: "demo", key: demoPrincipalSettingKey(demo), value: "administrator" });
    await db.insert(customIntentsTable).values([organizationId, otherOrg].map(org => ({
      organizationId: org, key: "onboarding-status", name: "Ambiguous client status",
      domain: "HR", flowClass: "fc1", description: "Unreviewed custom outcome",
      asIsHandlingMin: 1, toBeHumanMin: 1, baseWeight: 1, actGetActions: 1, actPutActions: 0,
      source: "fixture", author: owner, maturity: "unsupported",
    })));
    const existingId = randomUUID(), foreignId = randomUUID(), retiredId = randomUUID(), revokedId = randomUUID();
    await db.insert(accessAgents).values([
      { organizationId, id: existingId, name: "Exact pre-existing principal", ownerUserId: owner, createdByUserId: owner },
      { organizationId: otherOrg, id: foreignId, name: "Private other principal", ownerUserId: owner, createdByUserId: owner },
      { organizationId, id: retiredId, name: "Retired", status: "retired", ownerUserId: owner, createdByUserId: owner },
      { organizationId, id: revokedId, name: "Revoked", revokedAt: new Date(), ownerUserId: owner, createdByUserId: owner },
    ]);
    const sessionId = "catalogue-session", generation = "catalogue-generation", issuedAt = Date.now();
    const grant = { userId: privateUser, sessionId, generation, environment: "development", issuedAt, expiresAt: issuedAt + ADMIN_LIFETIME_MS };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.authUserId = req.header("x-fixture-user") || admin;
      Object.defineProperty(req, "auth", { value: Object.assign(() => ({
        userId: req.authUserId, sessionId, sessionClaims: { fva: [0, 0] }, tokenType: "session_token",
      }), { [Symbol.for("@clerk/express.auth")]: true }) });
      next();
    });
    app.use(createPlatformAdminContext({
      getUser: async () => ({
        id: privateUser, primaryEmailAddressId: "fixture-email", twoFactorEnabled: true,
        emailAddresses: [{ id: "fixture-email", verification: { status: "verified" } }],
        privateMetadata: { [ADMIN_APPROVAL_KEY]: {
          userId: privateUser, primaryEmailId: "fixture-email", environment: "development",
          generation, decisionRef: "fixture-approval",
        } },
      }),
      getSession: async () => ({ userId: privateUser, status: "active" }),
      isDemo: async id => id === demo,
    }));
    app.use(createTenantContextMiddleware(lookupMembership));
    let loseAccessDuringLookup = false;
    app.use(createAgentCatalogueRouter(async members => {
      const resolved = await enrichMemberIdentities(members, async ids => ids.map(id => ({ id, name: "Fixture human", email: null })));
      if (loseAccessDuringLookup) {
        await db.update(organizationMembershipsTable).set({ role: "member" }).where(and(
          eq(organizationMembershipsTable.organizationId, organizationId), eq(organizationMembershipsTable.clerkUserId, admin),
        ));
      }
      return resolved;
    }));
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const addr = server.address(); assert.ok(addr && typeof addr !== "string");
    const base = `http://127.0.0.1:${addr.port}`;
    async function request<T = Record<string, unknown>>(path: string, body?: CatalogueAgentRegistrationInput, user = admin, org = organizationId, proof?: string) {
      const response = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json", "x-fixture-user": user, "x-organization-id": org,
          origin: base, ...(proof ? { cookie: `${ADMIN_COOKIE}=${proof}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() as T };
    }
    const input = (key: string, extra: Partial<CatalogueAgentRegistrationInput> = {}): CatalogueAgentRegistrationInput => ({
      organizationId, catalogueKey: key, catalogueVersion: AGENT_CATALOGUE_VERSION, ownerUserId: owner,
      requestId: randomUUID(), expectedBindingVersion: 0, name: `Fixture ${key}`, ...extra,
    });
    // Hash all existing tables, not merely row counts. Setup must not change an
    // operational value, grant, membership, provider journal or invocation audit.
    async function unaffectedState() {
      const tables = await db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`);
      const exempt = new Set(["access_agents", "access_governance_history", "agent_catalogue_bindings", "agent_catalogue_setup_receipts", "onb_protected_audit"]);
      const names = tables.rows.map(row => String(row.tablename)).filter(name => !exempt.has(name));
      assert.ok(names.every(name => /^[a-z0-9_]+$/.test(name)));
      const query = names.map(name => `SELECT '${name}' AS name, md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'')) AS digest FROM "${name}" t`).join(" UNION ALL ");
      // UNION ALL can use parallel append and return tables in any order.
      return (await db.execute(sql.raw(query))).rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    const before = await unaffectedState();
    const read = await request<AgentCatalogue>("/agent-catalogue");
    assert.equal(read.status, 200);
    const catalogue = read.body as AgentCatalogue;
    assert.equal(catalogue.clientName, "Catalogue client");
    assert.equal(catalogue.canManage, true);
    assert.deepEqual(catalogue.runtimeCapabilities, ["tool.case.read", "tool.context.read"]);
    assert.ok(catalogue.principals.every(row => row.id !== foreignId));
    assert.equal(catalogue.customMappings.length, 1);
    assert.equal(catalogue.customMappings[0].reviewStatus, "review-required");
    assert.equal(catalogue.customMappings[0].status, "active");
    assert.ok(catalogue.entries.every(row => row.mappings.every(mapping => !mapping.intentKey.startsWith("custom:"))));
    const memberRead = await request("/agent-catalogue", undefined, member);
    assert.equal(memberRead.status, 200);
    assert.equal(memberRead.body.canManage, false);
    for (const key of ["principals", "owners", "registrations"]) assert.deepEqual(memberRead.body[key], []);
    assert.equal((await request("/agent-catalogue/registrations", input("onboarding"), member)).status, 403);
    const demoRead = await request("/agent-catalogue", undefined, demo, "demo");
    assert.equal(demoRead.body.canManage, false);
    assert.equal((await request("/agent-catalogue/registrations", input("onboarding", { organizationId: "demo" }), demo, "demo")).status, 403);
    assert.equal((await request("/agent-catalogue/registrations", input("onboarding", { organizationId: otherOrg }))).status, 403);
    assert.equal((await request("/agent-catalogue/registrations", input("onboarding", { ownerUserId: "absent-human" }))).status, 409);
    assert.equal((await request("/agent-catalogue/registrations", input("onboarding", { catalogueVersion: "stale" }))).status, 409);
    assert.equal((await request("/agent-catalogue/registrations", input("onboarding", { expectedBindingVersion: 0.5 }))).status, 400);
    assert.equal((await request("/agent-catalogue/registrations", input("onboarding", { name: "Retired" }))).status, 409);
    for (const agentId of [foreignId, retiredId, revokedId]) {
      assert.equal((await request("/agent-catalogue/registrations", input("onboarding", { name: undefined, agentId, expectedPrincipalVersion: 1 }))).status, 409);
    }
    const onboarding = input("onboarding");
    // More contenders than the default pool size proves that lock waiters
    // cannot starve the winning transaction's eligibility lookups.
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => request<CatalogueRegistrationResult>("/agent-catalogue/registrations", onboarding)));
    assert.deepEqual(concurrent.map(row => row.status).sort(), [...Array<number>(11).fill(200), 201]);
    const result = concurrent[0].body as CatalogueRegistrationResult;
    assert.ok(concurrent.every(row => row.body.binding.agentId === result.binding.agentId));
    const events = await db.select().from(accessGovernanceHistory).where(eq(accessGovernanceHistory.organizationId, organizationId));
    assert.equal(events.length, 1);
    assert.equal(events[0].actorUserId, admin);
    assert.equal((await request("/agent-catalogue/registrations", { ...onboarding, name: "Different payload" })).status, 409);
    assert.equal((await request("/agent-catalogue/registrations", input("onboarding"))).status, 409);
    assert.equal((await request("/agent-catalogue/registrations", input("onboarding", { expectedBindingVersion: 1 }))).body.code, "CATALOGUE_REPLACEMENT_REQUIRED");
    assert.equal((await request("/agent-catalogue/registrations", input("offboarding", { name: onboarding.name }))).status, 409);
    const payroll = input("payroll", { name: undefined, agentId: existingId, expectedPrincipalVersion: 1 });
    const bound = await request<CatalogueRegistrationResult>("/agent-catalogue/registrations", payroll, owner);
    assert.equal(bound.status, 201); assert.equal(bound.body.createdPrincipal, false);
    assert.equal((await request("/agent-catalogue/registrations", input("leave", { name: undefined, agentId: existingId, expectedPrincipalVersion: 1 }))).status, 409);
    assert.equal((await request("/agent-catalogue/registrations", input("it-access", { name: undefined, agentId: result.binding.agentId, expectedPrincipalVersion: 1, ownerUserId: member }))).status, 409);
    const replacements = await Promise.all([
      request("/agent-catalogue/registrations", input("onboarding", { name: "Replacement A", expectedBindingVersion: 1, replaceExisting: true })),
      request("/agent-catalogue/registrations", input("onboarding", { name: "Replacement B", expectedBindingVersion: 1, replaceExisting: true })),
    ]);
    assert.deepEqual(replacements.map(row => row.status).sort(), [200, 409]);
    assert.equal((await request("/agent-catalogue/registrations", onboarding)).status, 409, "superseded request cannot revive old binding");
    const unchanged = await db.select().from(accessAgents).where(and(eq(accessAgents.organizationId, organizationId), eq(accessAgents.id, existingId)));
    assert.equal(unchanged[0].version, 1);
    const proof = signAdminGrant(grant, secret);
    assert.equal((await request("/agent-catalogue/registrations", input("benefits"), privateUser)).status, 403);
    assert.equal((await request("/agent-catalogue/registrations", input("benefits"), privateUser, organizationId, proof)).status, 201);
    assert.equal((await request("/agent-catalogue/registrations", input("learning"), privateUser, organizationId,
      signAdminGrant({ ...grant, issuedAt: issuedAt - ADMIN_LIFETIME_MS - 1, expiresAt: issuedAt - 1 }, secret))).status, 403);
    assert.equal((await request("/agent-catalogue/registrations", input("learning"), privateUser)).status, 403);
    assert.deepEqual(await unaffectedState(), before, "browsing and setup cannot change any operational table or membership");
    const intakeSetup = input("intake-conversion");
    const intakeRegistration = await request<CatalogueRegistrationResult>("/agent-catalogue/registrations", intakeSetup);
    assert.equal(intakeRegistration.status, 201);
    assert.equal(intakeRegistration.body.binding.intakeAuthorization?.capability, "intake-conversion/v1");
    assert.equal(intakeRegistration.body.binding.intakeAuthorization?.ownerUserId, owner);
    const intakeRetry = await request<CatalogueRegistrationResult>("/agent-catalogue/registrations", intakeSetup);
    assert.deepEqual(intakeRetry.body.binding.intakeAuthorization, intakeRegistration.body.binding.intakeAuthorization,
      "An identical retry must not reset the new-intake eligibility boundary");
    assert.equal((await request("/agent-catalogue/registrations", input("intake-conversion", {
      ownerUserId: privateUser, expectedBindingVersion: 1, replaceExisting: true,
    }), privateUser, organizationId, proof)).status, 409, "Temporary platform elevation cannot supply the owner's standing permissions");
    assert.equal((await request("/agent-catalogue", undefined, member, otherOrg)).status, 403);
    const binding = (await db.select().from(agentCatalogueBindings).where(and(eq(agentCatalogueBindings.organizationId, organizationId), eq(agentCatalogueBindings.catalogueKey, "payroll"))))[0];
    await db.update(accessAgents).set({ version: 2 }).where(and(eq(accessAgents.organizationId, organizationId), eq(accessAgents.id, existingId)));
    assert.equal((await request("/agent-catalogue/registrations", payroll)).status, 409);
    const staleRead = (await request("/agent-catalogue")).body as AgentCatalogue;
    assert.equal(staleRead.registrations.find(row => row.catalogueKey === "payroll")?.state, "review-required");
    assert.equal((await request("/agent-catalogue/registrations", input("payroll", { name: undefined, agentId: existingId, expectedPrincipalVersion: 1, expectedBindingVersion: binding.version, replaceExisting: true }))).status, 409);
    assert.equal((await request("/agent-catalogue/registrations", input("payroll", { name: undefined, agentId: existingId, expectedPrincipalVersion: 2, expectedBindingVersion: binding.version, replaceExisting: true }))).status, 200);
    await db.update(accessAgents).set({ status: "retired", revokedAt: new Date() }).where(and(eq(accessAgents.organizationId, organizationId), eq(accessAgents.id, existingId)));
    assert.equal(((await request("/agent-catalogue")).body as AgentCatalogue).registrations.find(row => row.catalogueKey === "payroll")?.state, "principal-unavailable");
    await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(eq(organizationMembershipsTable.organizationId, organizationId), eq(organizationMembershipsTable.clerkUserId, owner)));
    assert.equal((await request("/agent-catalogue/registrations", input("leave"))).status, 409);
    assert.equal(((await request("/agent-catalogue")).body as AgentCatalogue).registrations.find(row => row.catalogueKey === "benefits")?.state, "owner-unavailable");
    loseAccessDuringLookup = true;
    const latePermissionLoss = await request("/agent-catalogue");
    assert.equal(latePermissionLoss.status, 403);
    assert.equal(latePermissionLoss.body.principals, undefined, "directory delays cannot disclose revoked administration snapshots");
    loseAccessDuringLookup = false;
    assert.equal((await request("/agent-catalogue/registrations", input("leave", { ownerUserId: member }))).status, 403);
    assert.equal((await request("/agent-catalogue")).body.canManage, false);
    // No eligible members in the other selected client: private administration
    // can inspect the blocker, but cannot manufacture ownership.
    await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(eq(organizationMembershipsTable.organizationId, otherOrg));
    const blocked = await request("/agent-catalogue", undefined, privateUser, otherOrg, proof);
    assert.equal(blocked.status, 200); assert.equal(blocked.body.canManage, true);
    assert.deepEqual(blocked.body.owners, []);
    assert.equal((await request("/agent-catalogue/registrations", input("leave", { organizationId: otherOrg }), privateUser, otherOrg, proof)).status, 409);
  } finally {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
  }
});
