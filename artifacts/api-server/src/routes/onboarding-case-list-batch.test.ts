import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import pg from "pg";
import express, { type Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, pool, onbCases, onbSettings, onbCommunications, onbSystemChecks,
  onbActionCenterActions,
  organizationMembershipsTable, organizationsTable, accessNamedGrants,
  accessUserGroups, accessUserGroupMembers, accessSecurityGroups, accessSecurityGroupPolicies,
  accessSecurityGroupUserGroups, accessSecurityGroupAttachments,
  accessPrincipalSecurityGroupAttachments, accessAgents,
} from "@workspace/db";
import onboardingRouter, { serializeCaseForRequest } from "./onboarding";
import { resolveEffectiveAccess, resolveEffectiveAccessForCases } from "../lib/access-governance";
import { CURATED_OFFLINE_EXAMPLES } from "../lib/onboarding/offline-example-extension";
import { demoPrincipalSettingKey } from "../lib/demo-principal";
import { SYNTHETIC_OFFLINE_MARKER } from "../lib/onboarding/synthetic-offline";

// Fixtures live outside public tables: neither background workers nor real
// Demo inventory can see them. No provisioning helper or execution is used.
const namespace = `case_list_${randomUUID().replaceAll("-", "")}`;
const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const user = "batch-reader";
const owner = "batch-policy-owner";
let cases: (typeof onbCases.$inferSelect)[];
let server: Server;
let baseUrl: string;
let queryCount = 0;

pool.on("connect", client => {
  const query = client.query;
  client.query = function (this: pg.PoolClient, ...args: unknown[]) {
    queryCount++;
    return Reflect.apply(query, this, args);
  } as typeof client.query;
});

const accessInput = { organizationId: "demo", principalType: "human" as const, principalId: user };
const request = { authUserId: user, organizationId: "demo", organizationRole: "member" } as Request;
const readKeys = ["flow.case.read", "data.case.profile.read", "data.case.notes.read", "data.case.readiness.read"];
const grant = (key: string, caseId: number | null, effect: "allow" | "deny" = "allow") => ({
  organizationId: "demo", principalType: "human" as const, principalId: user,
  scope: caseId === null ? "tenant" as const : "case" as const, caseId,
  resourceType: key.startsWith("flow.") ? "flow" as const : "field" as const,
  resourceKey: key, source: "named" as const, effect, createdByUserId: owner,
});

async function list() {
  const response = await fetch(`${baseUrl}/onboarding/cases`);
  assert.equal(response.status, 200);
  return response.json() as Promise<Awaited<ReturnType<typeof serializeCaseForRequest>>[]>;
}

async function measured<T>(fn: () => Promise<T>) {
  queryCount = 0;
  const started = performance.now();
  const value = await fn();
  return { value, queries: queryCount, ms: Math.round(performance.now() - started) };
}

before(async () => {
  await adminPool.query(`CREATE SCHEMA "${namespace}"`);
  const tables = [
    "organizations", "organization_memberships", "onb_cases", "onb_settings",
    "access_agents", "access_user_groups", "access_user_group_members",
    "access_security_groups", "access_security_group_policies", "access_security_group_user_groups",
    "access_security_group_attachments", "access_principal_security_group_attachments", "access_named_grants",
    "onb_communications", "onb_system_checks", "onb_approvals", "onb_candidate_uploads", "onb_documents",
    "onb_authority_governance", "onb_authority_assignments", "employee_vault_receipts", "onb_action_center_actions",
  ];
  for (const table of tables) {
    await adminPool.query(`CREATE TABLE "${namespace}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    // Private serial sequences; never consume live IDs.
    const serials = await adminPool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and column_default like 'nextval%'",
      [namespace, table],
    );
    for (const { column_name } of serials.rows) {
      const sequence = `${table}_${column_name}_seq`;
      await adminPool.query(`CREATE SEQUENCE "${namespace}"."${sequence}"`);
      await adminPool.query(`ALTER TABLE "${namespace}"."${table}" ALTER COLUMN "${column_name}" SET DEFAULT nextval('"${namespace}"."${sequence}"')`);
    }
  }
  // This test process has not used the shared pool yet.
  pool.options.options = `-c search_path=${namespace},public`;
  await db.insert(organizationsTable).values(["demo", "other"].map(id => ({
    id, slug: id, name: id, joinCodeHash: id, createdByUserId: owner,
  })));
  await db.insert(organizationMembershipsTable).values([user, owner].map(clerkUserId => ({
    organizationId: "demo", clerkUserId, role: "member" as const,
  })));
  await db.insert(onbSettings).values({
    organizationId: "demo", key: demoPrincipalSettingKey(user), value: "reviewer",
  });
  cases = await db.insert(onbCases).values(Array.from({ length: 120 }, (_, index) => ({
    organizationId: "demo", ...CURATED_OFFLINE_EXAMPLES[index]!.values,
  }))).returning();
  await db.insert(accessNamedGrants).values(cases.flatMap(row => readKeys.map(key => grant(key, row.id))));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = user;
    req.organizationId = "demo";
    req.organizationRole = "member";
    next();
  });
  app.use(onboardingRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await adminPool.end();
});

test("120 retained examples: batch list matches ordinary projection with bounded queries", async t => {
  const rows = [...cases].sort((a, b) => b.id - a.id);
  const baseline = await measured(() => Promise.all(rows.map(row => serializeCaseForRequest(request, row))));
  const batched = await measured(list);
  assert.deepEqual(batched.value, JSON.parse(JSON.stringify(baseline.value)));
  assert.ok(baseline.queries > 120 * 8);
  assert.ok(batched.queries < 35, `list used ${batched.queries} queries`);
  assert.ok(batched.queries < baseline.queries / 20);
  t.diagnostic(`120 retained rows: per-row baseline ${baseline.queries} queries / ${baseline.ms}ms; batched endpoint ${batched.queries} queries / ${batched.ms}ms`);
  for (const row of batched.value) {
    assert.equal(row.controllerRetired, true);
    assert.equal(row.offlineSample, true);
    assert.equal(row.fictionalOfflineIdentity, true);
    const example = CURATED_OFFLINE_EXAMPLES.find(item => item.key === row.scenarioKey)!;
    assert.deepEqual(row.batchIntake, example.values.processPolicySnapshot.batchIntake);
    assert.equal(row.planSummary, example.values.planSummary);
    assert.equal(row.workerPhone, null);
    assert.deepEqual(row.processPolicySnapshot, {});
  }
  const smaller = await measured(() => resolveEffectiveAccessForCases(accessInput, rows.slice(0, 10).map(row => row.id)));
  const larger = await measured(() => resolveEffectiveAccessForCases(accessInput, rows.map(row => row.id)));
  assert.equal(larger.queries, smaller.queries);
});

test("offline request projection uses fixed fictional definitions, not mutable private data; notes denial hides it", async () => {
  const row = cases[60]!;
  const example = CURATED_OFFLINE_EXAMPLES[60]!;
  await db.update(onbCases).set({
    planSummary: "PRIVATE mutable narrative",
    processPolicySnapshot: { ...row.processPolicySnapshot, batchIntake: {
      ...example.values.processPolicySnapshot.batchIntake,
      data: { ...example.values.processPolicySnapshot.batchIntake.data, engagement_reference: "PRIVATE mutable evidence" },
    } },
  }).where(eq(onbCases.id, row.id));
  const result = (await list()).find(item => item.id === row.id)!;
  assert.equal(result.planSummary, example.values.planSummary);
  assert.deepEqual(result.batchIntake, example.values.processPolicySnapshot.batchIntake);
  assert.equal(JSON.stringify(result).includes("PRIVATE mutable"), false);
  await db.insert(accessNamedGrants).values(grant("data.case.notes.read", row.id, "deny"));
  const denied = (await list()).find(item => item.id === row.id)!;
  assert.equal(denied.batchIntake, null);
  assert.equal(denied.planSummary, null);
  await db.update(onbCases).set({ planSummary: row.planSummary, processPolicySnapshot: row.processPolicySnapshot }).where(eq(onbCases.id, row.id));
});

test("case-scoped denies and redaction are fresh on every list, without broadening offline authority", async () => {
  const hidden = cases[0]!;
  const restricted = cases[1]!;
  await db.insert(accessNamedGrants).values([
    grant("flow.case.read", hidden.id, "deny"),
    grant("data.case.profile.read", restricted.id, "deny"),
    grant("data.case.readiness.read", restricted.id, "deny"),
  ]);
  const effective = await resolveEffectiveAccessForCases(accessInput, [hidden.id, restricted.id]);
  for (const row of [hidden, restricted]) {
    assert.deepEqual(effective.get(row.id), await resolveEffectiveAccess({ ...accessInput, caseId: row.id }));
  }
  const result = await list();
  assert.equal(result.length, 119);
  assert.equal(result.some(row => row.id === hidden.id), false);
  const redacted = result.find(row => row.id === restricted.id)!;
  assert.equal(redacted.workerName, "Restricted candidate");
  assert.equal(redacted.workerEmail, null);
  assert.equal(redacted.fictionalOfflineIdentity, false);
  assert.deepEqual(redacted.readiness, []);
  assert.equal(redacted.gateways?.a.status, "restricted");
  await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
    eq(organizationMembershipsTable.organizationId, "demo"), eq(organizationMembershipsTable.clerkUserId, user),
  ));
  assert.deepEqual(await list(), []);
  await db.update(organizationMembershipsTable).set({ revokedAt: null }).where(and(
    eq(organizationMembershipsTable.organizationId, "demo"), eq(organizationMembershipsTable.clerkUserId, user),
  ));
  assert.equal((await list()).length, 119);
});

test("batch shares group-policy evaluator: owner revocation, latest policy, expiry and agents", async () => {
  const id = cases[2]!.id;
  await db.delete(accessNamedGrants).where(and(eq(accessNamedGrants.caseId, id), eq(accessNamedGrants.organizationId, "demo")));
  await db.insert(accessUserGroups).values({ id: "ug", organizationId: "demo", name: "UG", ownerUserId: owner, createdByUserId: owner });
  await db.insert(accessUserGroupMembers).values({
    organizationId: "demo", groupId: "ug", principalType: "human", principalId: user, attachedByUserId: owner,
  });
  await db.insert(accessSecurityGroups).values({ id: "sg", organizationId: "demo", name: "SG", ownerUserId: owner, createdByUserId: owner });
  await db.insert(accessSecurityGroupPolicies).values({
    organizationId: "demo", securityGroupId: "sg", version: 1,
    policy: { fields: ["data.case.profile.read"], flows: ["flow.case.read"], tools: [] }, createdByUserId: owner,
  });
  await db.insert(accessSecurityGroupUserGroups).values({
    organizationId: "demo", securityGroupId: "sg", userGroupId: "ug", attachedByUserId: owner,
  });
  await db.insert(accessSecurityGroupAttachments).values({
    organizationId: "demo", securityGroupId: "sg", scope: "case", caseId: id, attachedByUserId: owner,
  });
  const compare = async (expected: boolean) => {
    const batch = (await resolveEffectiveAccessForCases(accessInput, [id])).get(id)!;
    assert.deepEqual(batch, await resolveEffectiveAccess({ ...accessInput, caseId: id }));
    assert.equal(batch.allows.includes("flow.case.read"), expected);
  };
  await compare(true);
  await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(eq(organizationMembershipsTable.clerkUserId, owner));
  await compare(false);
  await db.update(organizationMembershipsTable).set({ revokedAt: null }).where(eq(organizationMembershipsTable.clerkUserId, owner));
  await db.insert(accessSecurityGroupPolicies).values({
    organizationId: "demo", securityGroupId: "sg", version: 2,
    policy: { fields: [], flows: [], tools: [] }, createdByUserId: owner,
  });
  await compare(false);
  await db.insert(accessPrincipalSecurityGroupAttachments).values({
    organizationId: "demo", securityGroupId: "sg", principalType: "human", principalId: user,
    scope: "case", caseId: id, attachedByUserId: owner, expiresAt: new Date(0),
  });
  await compare(false);
  await db.insert(accessAgents).values({ id: "agent", organizationId: "demo", name: "Agent", ownerUserId: owner, createdByUserId: owner });
  await db.insert(accessNamedGrants).values([
    grant("flow.case.read", id),
    { ...grant("flow.case.read", id), principalType: "agent", principalId: "agent" },
    { ...grant("tool.approval.decide", id), principalType: "agent", principalId: "agent", resourceType: "tool" },
  ]);
  const agentInput = { ...accessInput, principalType: "agent" as const, principalId: "agent", initiatorUserId: user };
  const agent = (await resolveEffectiveAccessForCases(agentInput, [id])).get(id)!;
  assert.deepEqual(agent, await resolveEffectiveAccess({ ...agentInput, caseId: id }));
  assert.equal(agent.allows.includes("flow.case.read"), true);
  assert.equal(agent.allows.includes("tool.approval.decide"), false);
  const noInitiator = (await resolveEffectiveAccessForCases({ ...agentInput, initiatorUserId: undefined }, [id])).get(id)!;
  assert.deepEqual(noInitiator.allows, []);
  const foreign = await db.insert(onbCases).values({ ...CURATED_OFFLINE_EXAMPLES[0]!.values, organizationId: "other" }).returning();
  assert.deepEqual((await resolveEffectiveAccessForCases(accessInput, [foreign[0]!.id])).get(foreign[0]!.id)?.allows, []);
  assert.deepEqual((await resolveEffectiveAccessForCases(accessInput, [-1])).get(-1)?.allows, []);
});

test("batched presentation keeps latest approval, delivery status and trusted BGV semantics", async () => {
  const row = cases[3]!;
  await db.insert(onbCommunications).values({
    organizationId: "demo", caseId: row.id, channel: "email", direction: "outbound", toAddress: row.workerEmail,
    body: "Private delivery details", status: "failed", idempotencyKey: `gateway-a:${row.id}:offer-package:email`,
  });
  await db.insert(onbSystemChecks).values({
    organizationId: "demo", caseId: row.id, system: "bgv", status: "done",
    mode: "poll", externalRef: "fixture-only", dueAt: new Date(), completedAt: new Date(), evidenceProvenance: "simulated",
  });
  const projection = await serializeCaseForRequest(request, row);
  assert.deepEqual((await list()).find(c => c.id === row.id), JSON.parse(JSON.stringify(projection)));
});

test("legacy voluntary offboarding detail uses fixed labels while preserving state, permissions and current ownership", async () => {
  const [row] = await db.insert(onbCases).values({
    ...CURATED_OFFLINE_EXAMPLES[0]!.values, organizationId: "demo",
    scenarioKey: "UAT-DEMO-COVERAGE:offboarding-voluntary", hireType: "offboarding",
    workerName: "Demo sample — Voluntary offboarding", workerEmail: "demo-offboarding-voluntary@hro.invalid",
    syntheticProvenance: null, role: "Finance Manager", geography: "USA",
    notes: SYNTHETIC_OFFLINE_MARKER, planSummary: "PRIVATE summary",
    checklistMatchExplanation: "PRIVATE policy explanation",
    readiness: [
      { key: "payroll", label: "Payroll, bank, tax, benefits & HRIS activation", status: "pending" },
      { key: "custom", label: "PRIVATE added task", status: "blocked" },
    ],
    workstreams: [{ key: "access", label: "Access & System Readiness", agent: "access",
      owner: "PRIVATE owner", status: "pending", blockers: ["PRIVATE finding"] }],
  }).returning();
  assert.ok(row);
  await db.insert(accessNamedGrants).values(readKeys.map(key => grant(key, row.id)));
  const detail = async () => {
    const response = await fetch(`${baseUrl}/onboarding/cases/${row.id}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<Awaited<ReturnType<typeof serializeCaseForRequest>>>;
  };
  const safe = await detail();
  assert.match(safe.planSummary!, /resignation/);
  assert.equal(safe.role, "Finance Manager");
  assert.equal(safe.readiness[0]!.label, row.readiness[0]!.label);
  assert.equal(safe.readiness[1]!.key, "restricted");
  assert.equal(safe.readiness[1]!.status, "blocked");
  assert.equal(safe.workstreams[0]!.owner, "IT / Security");
  assert.equal(safe.workstreams[0]!.status, "pending");
  assert.equal(safe.offlineSample, true);
  assert.equal(safe.candidateEmailAuthorized, false);
  assert.equal(safe.currentActionOwner, null);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE/);
  await db.insert(accessNamedGrants).values(grant("data.case.readiness.read", row.id, "deny"));
  assert.deepEqual((await detail()).readiness, []);
  await db.insert(accessNamedGrants).values(grant("data.case.notes.read", row.id, "deny"));
  assert.equal((await detail()).planSummary, null);

  // A named reader with exact current grants can read real operational wording.
  // Neither an offline status nor a shared Demo identity creates a handoff.
  await db.delete(onbSettings).where(eq(onbSettings.key, demoPrincipalSettingKey(user)));
  await db.delete(accessNamedGrants).where(and(eq(accessNamedGrants.caseId, row.id), eq(accessNamedGrants.effect, "deny")));
  await db.insert(accessNamedGrants).values(["data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"].map(key => ({
    ...grant(key, row.id), approvedByUserId: owner, approvedAt: new Date(),
  })));
  const [assignment] = await db.insert(onbActionCenterActions).values({
    organizationId: "demo", caseId: row.id, kind: "assign", status: "open",
    owner: "Payroll Operations", assignee: null, actorUserId: user, actorName: "Reader",
    requestId: randomUUID(),
  }).returning();
  assert.equal((await detail()).currentActionOwner, "Payroll Operations");
  assert.equal((await list()).find(item => item.id === row.id)!.currentActionOwner, "Payroll Operations");
  const [reassignment] = await db.insert(onbActionCenterActions).values({
    organizationId: "demo", caseId: row.id, kind: "reassign", status: "open",
    owner: "HR Operations", assignee: "Assigned reviewer", actorUserId: user, actorName: "Reader",
    requestId: randomUUID(), payload: { body: { workItemId: assignment!.id } },
  }).returning();
  assert.equal((await detail()).currentActionOwner, "Assigned reviewer");
  assert.equal((await list()).find(item => item.id === row.id)!.currentActionOwner, "Assigned reviewer");
  const [resolution] = await db.insert(onbActionCenterActions).values({
    organizationId: "demo", caseId: row.id, kind: "resolve", status: "completed",
    actorUserId: user, actorName: "Reader", requestId: randomUUID(),
    payload: { body: { workItemId: assignment!.id } },
  }).returning();
  assert.equal((await detail()).currentActionOwner, null);
  await db.delete(onbActionCenterActions).where(inArray(onbActionCenterActions.id, [resolution!.id, reassignment!.id]));
  await db.update(onbActionCenterActions).set({ status: "open", owner: null }).where(eq(onbActionCenterActions.id, assignment!.id));
  assert.equal((await detail()).currentActionOwner, "Unassigned human team");
  await db.update(onbCases).set({ operationalPreparation: {} as never, planSummary: "Current operational request" }).where(eq(onbCases.id, row.id));
  assert.equal((await detail()).planSummary, "Current operational request");
  await db.insert(accessNamedGrants).values(grant("data.case.notes.read", row.id, "deny"));
  assert.equal((await detail()).currentActionOwner, null);
  await db.insert(onbSettings).values({ organizationId: "demo", key: demoPrincipalSettingKey(user), value: "reviewer" });
});
