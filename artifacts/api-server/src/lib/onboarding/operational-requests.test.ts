import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbApprovals,
  onbCases,
  onbCommunications,
  onbConnectors,
  onbDocuments,
  onbSettings,
  onbSystemChecks,
  organizationsTable,
} from "@workspace/db";
import onboardingRouter from "../../routes/onboarding";
import { OPERATIONAL_REQUEST_SETTING_PREFIX } from "./operational-requests";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `operational-a-${suffix}`;
const orgB = `operational-b-${suffix}`;
const user = `operational-user-${suffix}`;
let baseUrl: string;
let server: Server;
let caseA: number;
let caseB: number;
let offlineCase: number;

function caseValues(organizationId: string, name: string, notes: string | null = null) {
  return {
    organizationId,
    workerName: name,
    workerEmail: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "US",
    legalEntity: "Example",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    notes,
    readiness: [
      { key: "access", label: "Access", status: "pending" },
      { key: "assets", label: "Assets", status: "pending" },
    ],
    workstreams: [],
  };
}

async function call(
  path: string,
  organizationId: string,
  init?: RequestInit,
  role = "owner",
) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-organization-id": organizationId,
      "x-test-user": user,
      "x-test-role": role,
      ...(init?.headers ?? {}),
    },
  });
}

before(async () => {
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Operational A", slug: orgA, joinCodeHash: `hash-${orgA}`, createdByUserId: user },
    { id: orgB, name: "Operational B", slug: orgB, joinCodeHash: `hash-${orgB}`, createdByUserId: user },
  ]);
  [caseA, caseB, offlineCase] = (await db.insert(onbCases).values([
    caseValues(orgA, "Operational Alpha"),
    caseValues(orgB, "Operational Beta"),
    caseValues(orgA, "Offline Sample", SYNTHETIC_OFFLINE_MARKER),
  ]).returning({ id: onbCases.id })).map((row) => row.id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = String(req.header("x-organization-id") ?? orgA);
    req.organizationRole = req.header("x-test-role") === "member" ? "member" : "owner";
    req.authUserId = user;
    next();
  });
  app.use(onboardingRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof Error && error.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: String(error) });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test("lists every canonical internal operational simulation persona", async () => {
  const response = await call("/onboarding/agents", orgA);
  assert.equal(response.status, 200);
  const catalog = await response.json() as Array<{
    id: string;
    name: string;
    origin: string;
    description: string;
    owner: string;
    capabilities: string[];
    simulated: boolean;
  }>;
  assert.deepEqual(
    catalog.map((agent) => agent.id),
    ["documentation", "access", "assets", "payroll", "learning"],
  );
  assert.ok(catalog.every((agent) =>
    agent.name &&
    agent.description &&
    agent.owner &&
    agent.capabilities.length > 0 &&
    agent.origin === "internal" &&
    agent.simulated === true,
  ));
});

test("legacy stored requests remain readable with safe identity resolution", async () => {
  await db.insert(onbSettings).values({
    organizationId: orgB,
    key: `${OPERATIONAL_REQUEST_SETTING_PREFIX}${caseB}`,
    value: JSON.stringify({
      version: 1,
      requests: [
        {
          id: "access",
          label: "Legacy access request",
          owner: "IT / Security",
          agent: "access",
          teamRecipientLabel: "IT / Security team",
          method: "agent",
          status: "requested",
          reference: "SIMULATED-OPS-legacy-access",
          simulated: true,
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          blockedAt: null,
          lastRetryAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          failureReason: null,
          history: [{
            status: "requested",
            at: "2026-01-01T00:00:00.000Z",
            actor: "legacy-human",
            reason: null,
            requestId: null,
            communicationId: null,
          }],
        },
        {
          id: "retired",
          label: "Legacy unknown request",
          owner: "Unknown",
          agent: "retired-agent",
          teamRecipientLabel: "Unknown team",
          method: "agent",
          status: "requested",
          reference: "SIMULATED-OPS-legacy-retired",
          simulated: true,
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          blockedAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastRetryAt: null,
          failureReason: null,
          history: [{
            status: "requested",
            at: "2026-01-01T00:00:00.000Z",
            actor: "legacy-human",
            reason: null,
            requestId: null,
            communicationId: null,
          }],
        },
      ],
      initializationRequestIds: {},
    }),
  });
  const response = await call(
    `/onboarding/cases/${caseB}/operational-requests`,
    orgB,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    requests: Array<{
      id: string;
      agentIdentity?: { id: string; origin: string } | null;
      history: Array<{ actor: string; agentIdentity?: unknown }>;
    }>;
  };
  const known = body.requests.find((request) => request.id === "access")!;
  assert.deepEqual(known.agentIdentity, {
    id: "access",
    name: "IT Access & Identity Agent",
    origin: "internal",
    description:
      "Internal simulation persona for tracking access and identity setup work; it does not provision accounts or call an identity provider.",
    owner: "IT / Security",
    capabilities: [
      "Track access setup tasks",
      "Record identity dependencies",
      "Record simulated access blockers",
    ],
    simulated: true,
  });
  assert.equal(known.history[0]!.actor, "legacy-human");
  assert.equal(known.history[0]!.agentIdentity, null);
  assert.equal(
    body.requests.find((request) => request.id === "retired")!.agentIdentity,
    null,
  );
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await db.delete(onbSettings).where(inArray(onbSettings.organizationId, [orgA, orgB]));
  await db.delete(onbConnectors).where(inArray(onbConnectors.organizationId, [orgA, orgB]));
  await db.delete(onbCases).where(inArray(onbCases.id, [caseA, caseB, offlineCase]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgA, orgB]));
});

test("GET is read-only and initialization persists tenant-scoped simulated communications", async () => {
  const before = await call(`/onboarding/cases/${caseA}/operational-requests`, orgA);
  assert.equal(before.status, 200);
  assert.deepEqual((await before.json() as { requests: unknown[] }).requests, []);
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseA))).length,
    0,
  );

  const initialized = await call(`/onboarding/cases/${caseA}/operational-requests`, orgA, {
    method: "POST",
    body: JSON.stringify({ requestId: "initialize-1", method: "agent" }),
  });
  assert.equal(initialized.status, 200);
  const envelope = await initialized.json() as {
    version: number;
    simulated: boolean;
    requests: Array<{
      id: string;
      status: string;
      method: string;
      simulated: boolean;
      agentIdentity?: { id: string; name: string; origin: string; simulated: boolean } | null;
      history: Array<{ actor: string; agentIdentity?: { id: string; origin: string } | null }>;
    }>;
  };
  assert.equal(envelope.version, 1);
  assert.equal(envelope.simulated, true);
  assert.equal(envelope.requests.length, 5);
  assert.ok(envelope.requests.every((request) =>
    request.status === "requested" &&
    request.method === "agent" &&
    request.simulated === true &&
    request.agentIdentity?.id === request.id &&
    request.agentIdentity?.origin === "internal" &&
    request.agentIdentity?.simulated === true &&
    request.history.length === 1 &&
    request.history[0]?.actor === "system" &&
    request.history[0]?.agentIdentity?.id === request.id,
  ));
  const communications = await db.select().from(onbCommunications)
    .where(eq(onbCommunications.caseId, caseA));
  assert.equal(communications.length, 5);
  assert.ok(communications.every((row) =>
    row.status === "logged-only" &&
    row.channel === "agent" &&
    row.body.includes("[SIMULATED") &&
    row.body.includes("No email was sent") &&
    row.body.includes("AI agent identity:") &&
    row.body.includes("origin: internal"),
  ));
  assert.equal((await db.select().from(onbDocuments).where(eq(onbDocuments.caseId, caseA))).length, 0);
  assert.equal((await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.caseId, caseA))).length, 0);
  assert.equal((await db.select().from(onbApprovals).where(eq(onbApprovals.caseId, caseA))).length, 0);
  const repeatedInitialization = await call(
    `/onboarding/cases/${caseA}/operational-requests`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "initialize-1", method: "agent" }),
    },
  );
  assert.equal(repeatedInitialization.status, 200);
  assert.equal((await repeatedInitialization.json() as { idempotent: boolean }).idempotent, true);
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseA))).length,
    5,
  );
});

test("actions are fenced, idempotent, and do not mutate readiness", async () => {
  const beforeCase = (await db.select().from(onbCases).where(eq(onbCases.id, caseA)))[0]!;
  const emailMethod = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "access-method-1",
        action: "select-method",
        method: "email",
        expectedVersion: 1,
      }),
    },
  );
  assert.equal(emailMethod.status, 200);

  const start = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "access-start-1", action: "start", expectedVersion: 2 }),
    },
  );
  assert.equal(start.status, 200);
  const repeatedStart = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "access-start-1", action: "start", expectedVersion: 2 }),
    },
  );
  assert.equal(repeatedStart.status, 200);
  assert.equal((await repeatedStart.json() as { idempotent: boolean }).idempotent, true);

  const progress = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "access-progress-1", action: "progress", reason: "Simulation in progress.", expectedVersion: 3 }),
    },
  );
  assert.equal(progress.status, 200);
  const completed = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "access-complete-1", action: "complete", expectedVersion: 4 }),
    },
  );
  assert.equal(completed.status, 200);

  const afterCase = (await db.select().from(onbCases).where(eq(onbCases.id, caseA)))[0]!;
  assert.deepEqual(afterCase.readiness, beforeCase.readiness);
  assert.deepEqual(afterCase.workstreams, beforeCase.workstreams);
  const emailCommunication = (await db.select().from(onbCommunications)
    .where(and(eq(onbCommunications.caseId, caseA), eq(onbCommunications.channel, "email"))))[0];
  assert.ok(emailCommunication);
  assert.ok(emailCommunication.toAddress.includes("simulated recipient label"));
  assert.ok(emailCommunication.body.includes("No email was sent"));
  assert.ok(emailCommunication.body.includes("AI agent identity: none"));
  assert.ok(emailCommunication.body.includes("mail recipient label is not an AI agent"));
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseA))).length,
    9,
  );

  const stale = await call(
    `/onboarding/cases/${caseA}/operational-requests/assets/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "assets-stale-1",
        action: "start",
        expectedVersion: 0,
      }),
    },
  );
  assert.equal(stale.status, 409);
  const malformed = await call(
    `/onboarding/cases/${caseA}/operational-requests/assets/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "assets-malformed-1", action: "unknown", expectedVersion: 5 }),
    },
  );
  assert.equal(malformed.status, 400);
});

test("blocked requests retry without duplicating an identical request id", async () => {
  const blocked = await call(
    `/onboarding/cases/${caseA}/operational-requests/assets/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "assets-block-1",
        action: "block",
        reason: "Simulation dependency unavailable.",
        expectedVersion: 5,
      }),
    },
  );
  assert.equal(blocked.status, 200);
  const beforeRetry = (await db.select().from(onbCommunications)
    .where(eq(onbCommunications.caseId, caseA))).length;
  const retry = await call(
    `/onboarding/cases/${caseA}/operational-requests/assets/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "assets-retry-1", action: "retry", expectedVersion: 6 }),
    },
  );
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as { idempotent: boolean }).idempotent, false);
  const repeatedRetry = await call(
    `/onboarding/cases/${caseA}/operational-requests/assets/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "assets-retry-1", action: "retry", expectedVersion: 6 }),
    },
  );
  assert.equal(repeatedRetry.status, 200);
  const repeatedRetryBody = await repeatedRetry.json() as {
    idempotent: boolean;
    requests: Array<{ id: string; status: string; failureReason: string | null }>;
  };
  assert.equal(repeatedRetryBody.idempotent, true);
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseA))).length,
    beforeRetry + 1,
  );
  const request = repeatedRetryBody.requests
    .find((candidate) => candidate.id === "assets");
  assert.equal(request?.status, "requested");
  assert.equal(request?.failureReason, null);
});

test("requires integer action versions and serializes same-version mutations", async () => {
  const missingVersion = await call(
    `/onboarding/cases/${caseA}/operational-requests/learning/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "learning-missing-version", action: "start" }),
    },
  );
  assert.equal(missingVersion.status, 400);

  const current = await call(`/onboarding/cases/${caseA}/operational-requests`, orgA);
  const currentVersion = (await current.json() as { version: number }).version;
  const fractionalVersion = await call(
    `/onboarding/cases/${caseA}/operational-requests/learning/actions`,
    orgA,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "learning-fractional-version",
        action: "start",
        expectedVersion: currentVersion + 0.5,
      }),
    },
  );
  assert.equal(fractionalVersion.status, 409);

  const before = (await db.select().from(onbCommunications)
    .where(eq(onbCommunications.caseId, caseA))).length;
  const [first, second] = await Promise.all([
    call(
      `/onboarding/cases/${caseA}/operational-requests/learning/actions`,
      orgA,
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "learning-concurrent-a",
          action: "start",
          expectedVersion: currentVersion,
        }),
      },
    ),
    call(
      `/onboarding/cases/${caseA}/operational-requests/learning/actions`,
      orgA,
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "learning-concurrent-b",
          action: "start",
          expectedVersion: currentVersion,
        }),
      },
    ),
  ]);
  assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [200, 409]);
  const after = await db.select().from(onbCommunications)
    .where(eq(onbCommunications.caseId, caseA));
  assert.equal(after.length, before + 1);
  assert.equal(
    after.filter((row) =>
      row.idempotencyKey === "operational:" + caseA + ":learning:action:learning-concurrent-a" ||
      row.idempotencyKey === "operational:" + caseA + ":learning:action:learning-concurrent-b",
    ).length,
    1,
  );
  const learningCommunication = after.find((row) =>
    row.idempotencyKey === "operational:" + caseA + ":learning:action:learning-concurrent-a" ||
    row.idempotencyKey === "operational:" + caseA + ":learning:action:learning-concurrent-b",
  )!;
  assert.match(learningCommunication.body, /AI agent identity: .*id: learning/);
  assert.match(learningCommunication.body, /origin: internal/);
  const learningRead = await call(
    `/onboarding/cases/${caseA}/operational-requests`,
    orgA,
  );
  const learningRequest = (await learningRead.json() as {
    requests: Array<{
      id: string;
      history: Array<{ actor: string; agentIdentity?: { id: string; origin: string } | null }>;
    }>;
  }).requests.find((request) => request.id === "learning")!;
  const latestLearningHistory = learningRequest.history.at(-1)!;
  assert.equal(latestLearningHistory.actor, user);
  assert.deepEqual(latestLearningHistory.agentIdentity, {
    id: "learning",
    name: "Learning & Manager Connect Agent",
    origin: "internal",
    description:
      "Internal simulation persona for tracking learning and manager-connect work; it does not enroll people or send invitations.",
    owner: "L&D / Manager",
    capabilities: [
      "Track learning setup tasks",
      "Track manager-connect dependencies",
      "Record simulated readiness blockers",
    ],
    simulated: true,
  });
});

test("tenant and offline fences apply to reads and mutations", async () => {
  const crossTenant = await call(`/onboarding/cases/${caseA}/operational-requests`, orgB);
  assert.equal(crossTenant.status, 404);
  const crossTenantAction = await call(
    `/onboarding/cases/${caseA}/operational-requests/access/actions`,
    orgB,
    {
      method: "POST",
      body: JSON.stringify({ requestId: "cross-tenant-1", action: "start", expectedVersion: 0 }),
    },
  );
  assert.equal(crossTenantAction.status, 404);

  const offlineRead = await call(`/onboarding/cases/${offlineCase}/operational-requests`, orgA);
  assert.equal(offlineRead.status, 200);
  assert.equal((await offlineRead.json() as { offlinePaused: boolean }).offlinePaused, true);
  const offlineMutation = await call(`/onboarding/cases/${offlineCase}/operational-requests`, orgA, {
    method: "POST",
    body: JSON.stringify({ requestId: "offline-1" }),
  });
  assert.equal(offlineMutation.status, 409);
  assert.equal(
    (await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, offlineCase))).length,
    0,
  );
});
