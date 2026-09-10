import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  onbCases,
  onbDocuments,
  onbEvents,
  onbSettings,
  organizationMembershipsTable,
} from "@workspace/db";
import {
  ApplyOnboardingDemoRunActionBody,
  ApplyOnboardingDemoRunActionResponse,
  CreateOnboardingDemoRunBody,
  CreateOnboardingDemoRunResponse,
  GetOnboardingDemoControllerResponse,
  GetOnboardingDemoRunResponse,
} from "@workspace/api-zod";
import onboardingDemoControllerRouter from "../../routes/onboarding-demo-controller";
import { DEMO_RUN_KEY_PREFIX } from "./demo-controller";

/**
 * These are intentionally development-only database tests. The normal
 * post-merge test runner sets NODE_ENV=production; that process must not be
 * allowed to point this suite at a production database.
 */
const hasDevelopmentDb =
  Boolean(process.env.DATABASE_URL) && process.env.NODE_ENV === "development";

type RunActivity = {
  kind: string;
  provenance: "simulated" | "live";
  message: string;
  transcript: string | null;
  providerStatus: string | null;
};

type PublicRun = {
  runId: string;
  caseId: number;
  status: "active" | "completed" | "blocked" | "restarted";
  version: number;
  checkpoints: Array<{
    key: string;
    status: "pending" | "completed" | "overridden" | "blocked";
    reason: string | null;
  }>;
  systems: Array<{
    system: string;
    status: "pending" | "complete" | "exception" | "overdue";
    outcome: "pending" | "complete" | "exception" | "overdue" | null;
    simulated: boolean;
  }>;
  clock: { now: string; offsetHours: number };
  activity: RunActivity[];
  [key: string]: unknown;
};

type ActionBody = {
  expectedVersion: number;
  requestId: string;
  kind:
    | "load-documents"
    | "system-outcome"
    | "advance-time"
    | "advance"
    | "override-step"
    | "communication"
    | "restart";
  system?: "bgv" | "hris" | "access" | "assets" | "payroll" | "learning" | null;
  outcome?: "pending" | "complete" | "exception" | "overdue" | null;
  step?: "offer" | "documents" | "bgv" | "systems" | "hr-approval" | "day1" | null;
  reason?: string | null;
  hours?: number | null;
  channel?: "email" | "call" | null;
  mode?: "live" | "simulated" | null;
  liveConfirmation?: "I_UNDERSTAND_LIVE_DEMO" | null;
};

type RequestResult = {
  response: Response;
  body: unknown;
};

const ownedRunIds = new Set<string>();
const ownedCaseIds = new Set<number>();
let routeBaseUrl = "";
let routeServer: ReturnType<typeof express> extends never ? never : any;
let preservedSettings: Array<typeof onbSettings.$inferSelect> = [];
let preservedMemberships: Array<typeof organizationMembershipsTable.$inferSelect> = [];

function roleFromHeader(value: string | null | undefined): "owner" | "admin" | "member" {
  return value === "admin" || value === "owner" ? value : "member";
}

function rememberOwnedRun(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (typeof record.runId === "string") ownedRunIds.add(record.runId);
  if (typeof record.caseId === "number") ownedCaseIds.add(record.caseId);
}

async function request(
  path: string,
  options: RequestInit = {},
  organizationId = DEMO_ORGANIZATION_ID,
  role = "owner",
): Promise<RequestResult> {
  const response = await fetch(`${routeBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-organization-id": organizationId,
      "x-test-role": role,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // The document endpoint deliberately returns text/plain.
    }
  }
  rememberOwnedRun(body);
  return { response, body };
}

function bodyRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function createRun(scenario = "standard-fte"): Promise<PublicRun> {
  const input = { scenario, mode: "hybrid" };
  assert.doesNotThrow(() => CreateOnboardingDemoRunBody.parse(input));
  const result = await request("/onboarding/demo-runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
  assert.equal(result.response.status, 201);
  const run = CreateOnboardingDemoRunResponse.parse(result.body) as unknown as PublicRun;
  rememberOwnedRun(run);
  return run;
}

async function getRun(runId: string): Promise<PublicRun> {
  const result = await request(`/onboarding/demo-runs/${runId}`);
  assert.equal(result.response.status, 200);
  return GetOnboardingDemoRunResponse.parse(result.body) as unknown as PublicRun;
}

type DemoLedger = PublicRun & {
  renewedHRReviewRequired?: boolean;
};

async function readDemoLedger(runId: string): Promise<DemoLedger> {
  const [row] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, `${DEMO_RUN_KEY_PREFIX}${runId}`),
  ));
  assert.ok(row, `Demo ledger row is missing for run ${runId}`);
  const value: unknown = JSON.parse(row.value);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as DemoLedger;
}

async function applyBody(runId: string, body: ActionBody): Promise<RequestResult> {
  assert.doesNotThrow(() => ApplyOnboardingDemoRunActionBody.parse(body));
  const result = await request(`/onboarding/demo-runs/${runId}/actions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (result.response.status === 200) {
    ApplyOnboardingDemoRunActionResponse.parse(result.body);
    rememberOwnedRun(result.body);
  }
  return result;
}

async function apply(
  run: PublicRun,
  patch: Omit<Partial<ActionBody>, "expectedVersion" | "requestId"> & Pick<ActionBody, "kind">,
): Promise<PublicRun> {
  const body: ActionBody = {
    expectedVersion: run.version,
    requestId: randomUUID(),
    ...patch,
  };
  const result = await applyBody(run.runId, body);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return ApplyOnboardingDemoRunActionResponse.parse(result.body) as unknown as PublicRun;
}

async function completeDemoRun(initial: PublicRun): Promise<PublicRun> {
  let run = initial;
  run = await apply(run, { kind: "load-documents" });
  run = await apply(run, {
    kind: "system-outcome",
    system: "bgv",
    outcome: "complete",
    reason: "Synthetic BGV clearance for the initial demo review.",
  });
  run = await apply(run, {
    kind: "system-outcome",
    system: "hris",
    outcome: "complete",
    reason: "Synthetic HRIS completion for the initial demo review.",
  });
  run = await apply(run, {
    kind: "override-step",
    step: "offer",
    reason: "Offer acceptance is explicitly represented for the demo review.",
  });
  run = await apply(run, {
    kind: "override-step",
    step: "hr-approval",
    reason: "HR approval is explicitly represented for the initial demo review.",
  });
  run = await apply(run, {
    kind: "override-step",
    step: "day1",
    reason: "Day one is explicitly represented for the initial demo review.",
  });
  assert.equal(run.status, "completed");
  return run;
}

function assertRenewedHrReview(run: PublicRun, ledger: DemoLedger): void {
  assert.equal(run.checkpoints.find((step) => step.key === "hr-approval")?.status, "pending");
  assert.equal(run.checkpoints.find((step) => step.key === "day1")?.status, "pending");
  assert.equal(ledger.renewedHRReviewRequired, true);
}

async function cleanupOwnedRows(): Promise<void> {
  const caseIds = [...ownedCaseIds];
  const runKeys = [...ownedRunIds].map((runId) => `${DEMO_RUN_KEY_PREFIX}${runId}`);

  // The controller currently creates only cases, documents, events, and run
  // settings. Delete only those exact test-owned identities; never sweep the
  // Demo Organization's settings or cases.
  if (caseIds.length > 0) {
    await db.delete(onbCases).where(and(
      eq(onbCases.organizationId, DEMO_ORGANIZATION_ID),
      inArray(onbCases.id, caseIds),
    ));
  }
  if (runKeys.length > 0) {
    await db.delete(onbSettings).where(and(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
      inArray(onbSettings.key, runKeys),
    ));
  }
}

describe("demo-controller durable regression flow", { skip: !hasDevelopmentDb }, () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    // This is the same ephemeral auth harness used by synthetic-reset.test.ts.
    // It deliberately bypasses Clerk while retaining the route's organization
    // and role boundaries.
    app.use((req, _res, next) => {
      req.organizationId = String(req.header("x-organization-id") ?? "");
      req.organizationRole = roleFromHeader(req.header("x-test-role"));
      req.authUserId = "demo-controller-regression-test";
      next();
    });
    app.use(onboardingDemoControllerRouter);
    routeServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => routeServer.once("listening", resolve));
    const address = routeServer.address();
    assert.ok(address && typeof address !== "string");
    routeBaseUrl = `http://127.0.0.1:${address.port}`;
    preservedSettings = await db.select().from(onbSettings).where(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    );
    preservedMemberships = await db.select().from(organizationMembershipsTable).where(
      eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
    );
  });

  after(async () => {
    if (routeServer) {
      await new Promise<void>((resolve) => routeServer.close(() => resolve()));
    }
    await cleanupOwnedRows();
    const settingsAfter = await db.select().from(onbSettings).where(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    );
    const membershipsAfter = await db.select().from(organizationMembershipsTable).where(
      eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
    );
    assert.deepEqual(settingsAfter, preservedSettings);
    assert.deepEqual(membershipsAfter, preservedMemberships);
  });

  test("routes satisfy generated contracts and persist a synthetic case/document pack", async () => {
    const capabilities = await request("/onboarding/demo-controller");
    assert.equal(capabilities.response.status, 200);
    const capabilityBody = GetOnboardingDemoControllerResponse.parse(capabilities.body);
    assert.equal(capabilityBody.organizationId, DEMO_ORGANIZATION_ID);
    assert.equal(capabilityBody.available, true);
    assert.equal(capabilityBody.canCreateRuns, true);
    assert.ok(capabilityBody.allowedSystems.includes("bgv"));

    const input = { scenario: "standard-fte", mode: "hybrid" };
    assert.deepEqual(CreateOnboardingDemoRunBody.parse(input), input);
    const run = await createRun();
    assert.equal(run.version, 0);
    assert.equal(run.mode, "hybrid");
    assert.equal(run.status, "active");
    assert.equal(run.metadata && typeof run.metadata === "object", true);

    const [caseRow] = await db.select().from(onbCases).where(and(
      eq(onbCases.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbCases.id, run.caseId),
    ));
    assert.ok(caseRow);
    assert.match(caseRow.notes ?? "", /SYNTHETIC|synthetic/i);
    assert.match(caseRow.notes ?? "", new RegExp(`demo-controller-run:${run.runId}`));

    const documents = await db.select().from(onbDocuments).where(and(
      eq(onbDocuments.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbDocuments.caseId, run.caseId),
    ));
    assert.ok(documents.length > 0);
    assert.ok(documents.every((document) => document.status === "pending"));

    const downloaded = await request(`/onboarding/demo-runs/${run.runId}/documents`);
    assert.equal(downloaded.response.status, 200);
    assert.match(downloaded.response.headers.get("content-type") ?? "", /text\/plain/);
    assert.equal(typeof downloaded.body, "string");
    assert.match(downloaded.body as string, /NOT A GENUINE HR RECORD/);
    assert.match(downloaded.body as string, new RegExp(run.runId));
  });

  test("runs documents, BGV exception and clear, systems, approvals, time, and completion durably", async () => {
    let run = await createRun("bgv-exception");

    run = await apply(run, { kind: "load-documents" });
    assert.equal(run.checkpoints.find((step) => step.key === "documents")?.status, "completed");

    run = await apply(run, {
      kind: "system-outcome",
      system: "bgv",
      outcome: "exception",
      reason: "Previous employer evidence needs an HR review.",
    });
    assert.equal(run.status, "blocked");
    assert.equal(run.checkpoints.find((step) => step.key === "bgv")?.status, "blocked");
    assert.equal(run.checkpoints.find((step) => step.key === "bgv")?.reason, "Previous employer evidence needs an HR review.");
    assert.equal(run.systems.find((system) => system.system === "bgv")?.outcome, "exception");

    // Explicitly clear the simulated BGV exception after the human review.
    run = await apply(run, {
      kind: "system-outcome",
      system: "bgv",
      outcome: "complete",
      reason: "HR reviewed and cleared the simulated exception.",
    });
    assert.equal(run.checkpoints.find((step) => step.key === "bgv")?.status, "completed");
    assert.equal(run.systems.find((system) => system.system === "bgv")?.status, "complete");

    run = await apply(run, { kind: "advance-time", hours: 12 });
    assert.equal(run.clock.offsetHours, 12);
    assert.match(run.activity.at(-1)?.message ?? "", /advanced 12 hour/);

    run = await apply(run, {
      kind: "system-outcome",
      system: "hris",
      outcome: "complete",
      reason: "Simulated systems review complete.",
    });
    assert.equal(run.checkpoints.find((step) => step.key === "systems")?.status, "completed");
    assert.equal(run.systems.find((system) => system.system === "hris")?.simulated, true);

    run = await apply(run, {
      kind: "override-step",
      step: "offer",
      reason: "Offer acceptance is represented by the approved demo fixture.",
    });
    run = await apply(run, {
      kind: "override-step",
      step: "hr-approval",
      reason: "HR approval is explicitly represented for the demonstration.",
    });
    assert.equal(run.checkpoints.find((step) => step.key === "hr-approval")?.status, "overridden");
    assert.equal(run.checkpoints.find((step) => step.key === "hr-approval")?.reason, "HR approval is explicitly represented for the demonstration.");

    run = await apply(run, {
      kind: "override-step",
      step: "day1",
      reason: "Day one is completed in the controlled simulation.",
    });
    assert.equal(run.status, "completed");
    assert.ok(run.checkpoints.every((step) => step.status === "completed" || step.status === "overridden"));

    const reloaded = await getRun(run.runId);
    assert.equal(reloaded.status, "completed");
    assert.equal(reloaded.version, run.version);
    const persistedDocuments = await db.select().from(onbDocuments).where(and(
      eq(onbDocuments.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbDocuments.caseId, run.caseId),
    ));
    assert.ok(persistedDocuments.length > 0);
    assert.ok(persistedDocuments.every((document) => document.status === "verified"));
    const events = await db.select().from(onbEvents).where(and(
      eq(onbEvents.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbEvents.caseId, run.caseId),
    ));
    assert.ok(events.some((event) => event.title === "load-documents"));
    assert.ok(events.some((event) => event.title === "system-outcome"));
  });

  test("reopens HR approval and Day 1 after post-completion evidence changes", async () => {
    let run = await completeDemoRun(await createRun("bgv-exception"));

    // A BGV regression must not leave a completed HR decision or Day-1 gate
    // silently green. The synthetic ledger records that a fresh HR review is
    // required; it does not make an employment decision.
    run = await apply(run, {
      kind: "system-outcome",
      system: "bgv",
      outcome: "exception",
      reason: "Synthetic post-completion BGV evidence regressed and requires review.",
    });
    assert.equal(run.status, "blocked");
    assert.equal(run.checkpoints.find((step) => step.key === "bgv")?.status, "blocked");
    assertRenewedHrReview(run, await readDemoLedger(run.runId));

    // Clearing the exception restores BGV only. The previously completed
    // review gates stay reopened until an explicit renewed review occurs.
    run = await apply(run, {
      kind: "system-outcome",
      system: "bgv",
      outcome: "complete",
      reason: "Synthetic BGV evidence was reviewed and cleared.",
    });
    assert.equal(run.checkpoints.find((step) => step.key === "bgv")?.status, "completed");
    assert.equal(run.status, "active");
    assertRenewedHrReview(run, await readDemoLedger(run.runId));

    // Re-approve the gates, then change the document evidence. Loading a new
    // synthetic document pack is an evidence change, not a reason to preserve
    // the stale completed HR/day-1 decision.
    run = await apply(run, {
      kind: "override-step",
      step: "hr-approval",
      reason: "Renewed HR review completed after the BGV correction.",
    });
    run = await apply(run, {
      kind: "override-step",
      step: "day1",
      reason: "Renewed Day-1 review completed after the BGV correction.",
    });
    assert.equal(run.status, "completed");
    run = await apply(run, { kind: "load-documents" });
    assert.equal(run.status, "active");
    assertRenewedHrReview(run, await readDemoLedger(run.runId));

    // A direct BGV system override is another source-evidence change and must
    // use the same durable reopen path rather than mutating global validation.
    run = await apply(run, {
      kind: "override-step",
      step: "hr-approval",
      reason: "Renewed HR review completed after document evidence refresh.",
    });
    run = await apply(run, {
      kind: "override-step",
      step: "day1",
      reason: "Renewed Day-1 review completed after document evidence refresh.",
    });
    assert.equal(run.status, "completed");
    run = await apply(run, {
      kind: "override-step",
      step: "bgv",
      reason: "Synthetic BGV system override requires another HR review.",
    });
    assert.equal(run.checkpoints.find((step) => step.key === "bgv")?.status, "overridden");
    assertRenewedHrReview(run, await readDemoLedger(run.runId));
  });

  test("rejects stale versions, replays requestId exactly, and conflicts on changed payload", async () => {
    const run = await createRun();
    const firstBody: ActionBody = {
      expectedVersion: run.version,
      requestId: randomUUID(),
      kind: "load-documents",
    };
    const first = await applyBody(run.runId, firstBody);
    assert.equal(first.response.status, 200);
    const firstRun = ApplyOnboardingDemoRunActionResponse.parse(first.body) as unknown as PublicRun;
    const duplicate = await applyBody(run.runId, firstBody);
    assert.equal(duplicate.response.status, 200);
    assert.deepEqual(duplicate.body, first.body);

    const stale = await applyBody(run.runId, {
      expectedVersion: run.version,
      requestId: randomUUID(),
      kind: "advance",
    });
    assert.equal(stale.response.status, 409);
    assert.match(bodyRecord(stale.body).error as string, /current version/i);
    assert.equal((await getRun(run.runId)).version, firstRun.version);

    const conflict = await applyBody(run.runId, {
      ...firstBody,
      kind: "advance",
    });
    assert.equal(conflict.response.status, 409);
    assert.match(bodyRecord(conflict.body).error as string, /different action/i);
    assert.equal((await getRun(run.runId)).version, firstRun.version);
  });

  test("serializes concurrent actions with the durable version fence", async () => {
    const run = await createRun();
    const firstBody: ActionBody = {
      expectedVersion: run.version,
      requestId: randomUUID(),
      kind: "advance",
    };
    const secondBody: ActionBody = {
      expectedVersion: run.version,
      requestId: randomUUID(),
      kind: "advance-time",
      hours: 2,
    };
    const [first, second] = await Promise.all([
      applyBody(run.runId, firstBody),
      applyBody(run.runId, secondBody),
    ]);
    assert.deepEqual(
      [first.response.status, second.response.status].sort((a, b) => a - b),
      [200, 409],
    );
    const current = await getRun(run.runId);
    assert.equal(current.version, 1);
    assert.equal(current.activity.length, 2);
  });

  test("restarts into a new case while preserving immutable old history", async () => {
    const oldRun = await createRun();
    const advanced = await apply(oldRun, { kind: "advance-time", hours: 4 });
    const restartBody: ActionBody = {
      expectedVersion: advanced.version,
      requestId: randomUUID(),
      kind: "restart",
    };
    const restarted = await applyBody(oldRun.runId, restartBody);
    assert.equal(restarted.response.status, 200);
    const freshRun = ApplyOnboardingDemoRunActionResponse.parse(restarted.body) as unknown as PublicRun;
    rememberOwnedRun(freshRun);
    assert.notEqual(freshRun.runId, oldRun.runId);
    assert.notEqual(freshRun.caseId, oldRun.caseId);
    assert.equal((await getRun(oldRun.runId)).status, "restarted");
    assert.ok((await getRun(oldRun.runId)).activity.some((activity) => activity.kind === "restart"));

    const replay = await applyBody(oldRun.runId, restartBody);
    assert.equal(replay.response.status, 200);
    assert.equal((replay.body as PublicRun).runId, freshRun.runId);

    const retiredMutation = await applyBody(oldRun.runId, {
      expectedVersion: (await getRun(oldRun.runId)).version,
      requestId: randomUUID(),
      kind: "advance",
    });
    assert.equal(retiredMutation.response.status, 409);
    assert.match(bodyRecord(retiredMutation.body).error as string, /restarted/i);

    const capabilities = await request("/onboarding/demo-controller");
    const capabilityBody = GetOnboardingDemoControllerResponse.parse(capabilities.body);
    assert.ok(capabilityBody.existingSessions.some((session) => session.runId === oldRun.runId));
    assert.ok(capabilityBody.existingSessions.some((session) => session.runId === freshRun.runId));
  });

  test("simulated email and call remain synthetic with no provider calls", async () => {
    const run = await createRun();
    const priorFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (!url.startsWith(routeBaseUrl) && /^https?:\/\//i.test(url)) providerCalls += 1;
      return priorFetch(input, init);
    }) as typeof fetch;

    try {
      const email = await apply(run, {
        kind: "communication",
        channel: "email",
        mode: "simulated",
      });
      assert.equal(email.activity.at(-1)?.kind, "communication");
      assert.equal(email.activity.at(-1)?.provenance, "simulated");
      assert.equal(email.activity.at(-1)?.providerStatus, "simulated");

      const call = await apply(email, {
        kind: "communication",
        channel: "call",
        mode: "simulated",
      });
      assert.equal(call.activity.at(-1)?.kind, "communication");
      assert.equal(call.activity.at(-1)?.provenance, "simulated");
      assert.equal(call.activity.at(-1)?.providerStatus, "simulated");
      assert.match(call.activity.at(-1)?.transcript ?? "", /SIMULATED TRANSCRIPT|agent:/i);

      // No selected volunteer exists in this test-owned run, so even an
      // explicitly requested live action must fail before a provider boundary.
      const live = await applyBody(call.runId, {
        expectedVersion: call.version,
        requestId: randomUUID(),
        kind: "communication",
        channel: "email",
        mode: "live",
        liveConfirmation: "I_UNDERSTAND_LIVE_DEMO",
      });
      assert.equal(live.response.status, 409);
      assert.match(bodyRecord(live.body).error as string, /selected approved volunteer/i);
      assert.equal(providerCalls, 0);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  test("forbids non-admin roles and non-Demo organizations without reading tenant data", async () => {
    const memberCapabilities = await request(
      "/onboarding/demo-controller",
      {},
      DEMO_ORGANIZATION_ID,
      "member",
    );
    assert.equal(memberCapabilities.response.status, 200);
    const memberBody = GetOnboardingDemoControllerResponse.parse(memberCapabilities.body);
    assert.equal(memberBody.available, false);
    assert.equal(memberBody.canCreateRuns, false);
    assert.deepEqual(memberBody.approvedVolunteers, []);
    assert.deepEqual(memberBody.existingSessions, []);

    const memberCreate = await request(
      "/onboarding/demo-runs",
      {
        method: "POST",
        body: JSON.stringify({ scenario: "standard-fte", mode: "hybrid" }),
      },
      DEMO_ORGANIZATION_ID,
      "member",
    );
    assert.equal(memberCreate.response.status, 403);

    const otherOrganizationId = `demo-controller-other-${randomUUID()}`;
    const otherCapabilities = await request(
      "/onboarding/demo-controller",
      {},
      otherOrganizationId,
      "owner",
    );
    assert.equal(otherCapabilities.response.status, 200);
    const otherBody = GetOnboardingDemoControllerResponse.parse(otherCapabilities.body);
    assert.equal(otherBody.available, false);
    assert.equal(otherBody.canCreateRuns, false);
    assert.match(otherBody.reason ?? "", /Demo Organization/i);

    const otherCreate = await request(
      "/onboarding/demo-runs",
      {
        method: "POST",
        body: JSON.stringify({ scenario: "standard-fte", mode: "hybrid" }),
      },
      otherOrganizationId,
      "owner",
    );
    assert.equal(otherCreate.response.status, 403);
    assert.match(bodyRecord(otherCreate.body).error as string, /Demo Organization/i);
  });
});