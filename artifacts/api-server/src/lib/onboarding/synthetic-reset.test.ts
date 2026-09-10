import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import {
  and,
  eq,
  inArray,
} from "drizzle-orm";
import {
  db,
  onbCandidateUploads,
  onbCases,
  onbCommunications,
  onbEffectJournal,
  onbEvents,
  onbSettings,
  organizationsTable,
} from "@workspace/db";
import {
  DEFAULT_SYNTHETIC_RESET_MANIFEST,
  executeSyntheticReset,
  inspectSyntheticReset,
  type SyntheticResetManifest,
} from "./synthetic-reset";
import { DEMO_EMAIL, getScenario } from "./scenarios";
import { sendOutbound } from "./channels";
import { sendAdministrativeEmail } from "./channels";
import { startVoiceCall } from "./voice";
import { withCaseDispatchGuard } from "./dispatch-guard";
import { retryCandidateEmail } from "./channels";
import onboardingRouter from "../../routes/onboarding";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `synthetic-reset-${process.pid}-${randomUUID()}`;
const organizationIds: string[] = [];
let routeBaseUrl: string;
let routeServer: ReturnType<typeof express> extends never ? never : any;

const standardScenario = getScenario("standard-fte")!;
const fixtureConfig = {
  workerName: "Temporary legacy synthetic",
  workerEmail: DEMO_EMAIL,
  workerPhone: null,
  scenarioKey: "standard-fte",
  config: {
    hireType: standardScenario.intake.hireType,
    workerCategory: standardScenario.intake.workerCategory,
    role: standardScenario.intake.role,
    department: standardScenario.intake.department,
    geography: standardScenario.intake.geography,
    legalEntity: standardScenario.intake.legalEntity,
    managerName: standardScenario.intake.managerName,
    recruiterName: standardScenario.intake.recruiterName,
  },
};

function manifestFor(
  organizationId: string,
  id: number,
): SyntheticResetManifest {
  return [{
    organizationId,
    id,
    expected: fixtureConfig,
  }];
}

async function seedOrganization(label = suffix): Promise<string> {
  const id = `${label}-${randomUUID()}`;
  organizationIds.push(id);
  await db.insert(organizationsTable).values({
    id,
    name: `Synthetic reset ${id}`,
    slug: id,
    joinCodeHash: `hash-${id}`,
    createdByUserId: "synthetic-reset-test",
  });
  return id;
}

async function seedCase(
  organizationId: string,
  overrides: Partial<typeof fixtureConfig & {
    orchestrationStatus: string;
    orchestrationClaimOwner: string | null;
    notes: string | null;
  }> = {},
) {
  const [row] = await db.insert(onbCases).values({
    organizationId,
    workerName: overrides.workerName ?? fixtureConfig.workerName,
    workerEmail: overrides.workerEmail ?? fixtureConfig.workerEmail,
    workerPhone: overrides.workerPhone ?? null,
    hireType: fixtureConfig.config.hireType,
    workerCategory: fixtureConfig.config.workerCategory,
    role: fixtureConfig.config.role,
    department: fixtureConfig.config.department,
    geography: fixtureConfig.config.geography,
    legalEntity: fixtureConfig.config.legalEntity,
    managerName: fixtureConfig.config.managerName,
    recruiterName: fixtureConfig.config.recruiterName,
    joiningDate: "2030-01-01",
    lifecycleStage: "trigger-received",
    orchestrationStatus: overrides.orchestrationStatus ?? "blocked",
    orchestrationClaimOwner: overrides.orchestrationClaimOwner ?? null,
    orchestrationClaimUntil: null,
    notes: overrides.notes ?? null,
    scenarioKey: fixtureConfig.scenarioKey,
    readiness: [],
    checklistSnapshot: [],
  }).returning();
  assert.ok(row);
  return row;
}

async function cleanupOrganizations() {
  if (!organizationIds.length) return;
  const ids = [...organizationIds];
  await db.delete(onbEffectJournal).where(inArray(onbEffectJournal.organizationId, ids));
  await db.delete(onbSettings).where(inArray(onbSettings.organizationId, ids));
  await db.delete(onbEvents).where(inArray(onbEvents.organizationId, ids));
  await db.delete(onbCases).where(inArray(onbCases.organizationId, ids));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, ids));
}

describe("synthetic reset safety boundary", { skip: !hasDb }, () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.organizationId = String(req.header("x-organization-id") ?? "");
      req.organizationRole = req.header("x-test-role") === "admin"
        ? "admin"
        : req.header("x-test-role") === "owner"
          ? "owner"
          : "member";
      req.authUserId = "synthetic-reset-test-user";
      next();
    });
    app.use(onboardingRouter);
    routeServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => routeServer.once("listening", resolve));
    const address = routeServer.address();
    assert.ok(address && typeof address !== "string");
    routeBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (routeServer) {
      await new Promise<void>((resolve) => routeServer.close(() => resolve()));
    }
    await cleanupOrganizations();
  });

  test("preserves unrelated rows, fences tenant scope, and retains private upload metadata", async () => {
    const organizationId = await seedOrganization();
    const otherOrganizationId = await seedOrganization();
    const target = await seedCase(organizationId);
    const preserved = await seedCase(organizationId, {
      workerName: "Preserved real-looking case",
      workerEmail: "real@example.com",
      notes: "not in the injected manifest",
    });
    const otherTenantTarget = await seedCase(otherOrganizationId);
    await db.insert(onbCandidateUploads).values({
      organizationId,
      caseId: target.id,
      documentId: 1,
      objectPath: `private/${organizationId}/${target.id}/resume.pdf`,
      originalName: "resume.pdf",
      contentType: "application/pdf",
      sizeBytes: 123,
      malwareScanState: "unavailable",
      validationState: "manual_review",
    });
    await db.insert(onbEffectJournal).values({
      organizationId,
      tenantId: organizationId,
      caseId: target.id,
      logicalOperationKey: `synthetic-test:${target.id}`,
      toolName: "test.provider",
      argumentsHash: "hash",
      providerIdempotency: true,
      status: "confirmed",
      confirmedAt: new Date(),
    });

    const manifest = manifestFor(organizationId, target.id);
    const preview = await inspectSyntheticReset(organizationId, manifest);
    assert.equal(preview.status, "ready");
    assert.equal(preview.preservedCount, 1);
    assert.ok(preview.warnings.some((warning) => warning.includes("uploaded file")));

    const result = await executeSyntheticReset({
      organizationId,
      actorId: "owner-test",
      expectedRevision: preview.revision,
      manifest,
    });
    assert.equal(result.kind, "completed");
    assert.equal(result.envelope.receipt?.retainedUploadCount, 1);
    assert.equal(result.envelope.receipt?.deletedCaseIds.includes(target.id), true);

    const [preservedAfter] = await db.select().from(onbCases).where(eq(onbCases.id, preserved.id));
    const [otherAfter] = await db.select().from(onbCases).where(eq(onbCases.id, otherTenantTarget.id));
    assert.equal(preservedAfter?.workerName, "Preserved real-looking case");
    assert.equal(otherAfter?.workerName, fixtureConfig.workerName);
    const [journal] = await db.select().from(onbEffectJournal).where(
      eq(onbEffectJournal.logicalOperationKey, `synthetic-test:${target.id}`),
    );
    assert.equal(journal?.caseId, null);
    assert.equal(result.envelope.candidates.length, 6);
    assert.ok(result.envelope.candidates.every((candidate) => candidate.workerName.startsWith("Synthetic — ")));
    const events = await fetch(`${routeBaseUrl}/onboarding/cases/${result.envelope.candidates[0]!.id}/events`, {
      headers: { "x-organization-id": organizationId, "x-test-role": "owner" },
    });
    assert.equal(events.status, 200, "Offline samples must retain read-only activity access");
    assert.ok(Array.isArray(await events.json()));
  });

  test("denies organization members before any manifest read or mutation", async () => {
    const organizationId = await seedOrganization();
    const response = await fetch(`${routeBaseUrl}/onboarding/synthetic-reset`, {
      headers: {
        "x-organization-id": organizationId,
        "x-test-role": "member",
      },
    });
    assert.equal(response.status, 403);
    const body = await response.json() as { message: string };
    assert.match(body.message, /owner or admin/i);
  });

  test("rejects stale previews and makes concurrent confirmation idempotent", async () => {
    const organizationId = await seedOrganization();
    const target = await seedCase(organizationId);
    const manifest = manifestFor(organizationId, target.id);
    const preview = await inspectSyntheticReset(organizationId, manifest);
    await db.update(onbCases).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(onbCases.id, target.id));
    const timestampOnly = await inspectSyntheticReset(organizationId, manifest);
    assert.equal(timestampOnly.revision, preview.revision);
    await db.update(onbCases).set({ notes: "meaningful inventory mutation" }).where(eq(onbCases.id, target.id));
    const stale = await executeSyntheticReset({
      organizationId,
      actorId: "owner-test",
      expectedRevision: preview.revision,
      manifest,
    });
    assert.equal(stale.kind, "conflict");
    assert.equal(stale.envelope.status, "blocked");
    assert.ok(stale.envelope.blockers.some((blocker) => blocker.includes("Inventory changed")));

    const current = await inspectSyntheticReset(organizationId, manifest);
    const [first, second] = await Promise.all([
      executeSyntheticReset({ organizationId, actorId: "owner-a", expectedRevision: current.revision, manifest }),
      executeSyntheticReset({ organizationId, actorId: "owner-b", expectedRevision: current.revision, manifest }),
    ]);
    assert.equal([first, second].filter((result) => result.kind === "completed").length, 1);
    assert.equal([first, second].filter((result) => result.kind === "conflict").length, 1);
    const receipt = await inspectSyntheticReset(organizationId, manifest);
    assert.equal(receipt.status, "completed");
  });

  test("blocks active claims and unknown effects without deleting anything", async () => {
    const organizationId = await seedOrganization();
    const target = await seedCase(organizationId, {
      orchestrationStatus: "running",
      orchestrationClaimOwner: "active-worker",
    });
    const manifest = manifestFor(organizationId, target.id);
    await db.insert(onbEffectJournal).values({
      organizationId,
      tenantId: organizationId,
      caseId: target.id,
      logicalOperationKey: `unknown:${target.id}`,
      toolName: "test.provider",
      argumentsHash: "hash",
      providerIdempotency: true,
      status: "unknown_effect_manual_repair",
    });
    const preview = await inspectSyntheticReset(organizationId, manifest);
    assert.equal(preview.status, "blocked");
    assert.ok(preview.blockers.some((blocker) => blocker.includes("orchestration claim")));
    assert.ok(preview.blockers.some((blocker) => blocker.includes("unknown provider effect")));
    const result = await executeSyntheticReset({
      organizationId,
      actorId: "owner-test",
      expectedRevision: preview.revision,
      manifest,
    });
    assert.equal(result.kind, "conflict");
    const [stillThere] = await db.select().from(onbCases).where(eq(onbCases.id, target.id));
    assert.ok(stillThere);
  });

  test("offline replacement rejects outbound channels and records no provider effect", async () => {
    const organizationId = await seedOrganization();
    const target = await seedCase(organizationId);
    const manifest = manifestFor(organizationId, target.id);
    const preview = await inspectSyntheticReset(organizationId, manifest);
    const result = await executeSyntheticReset({
      organizationId,
      actorId: "owner-test",
      expectedRevision: preview.revision,
      manifest,
    });
    assert.equal(result.kind, "completed");
    const replacementId = result.envelope.receipt!.createdCaseIds[0]!;
    await db.update(onbCases).set({
      workerName: "Edited contact name",
      workerEmail: "edited-real-looking@example.com",
      workerPhone: "+15550000000",
    }).where(eq(onbCases.id, replacementId));
    let providerCalls = 0;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async (...args) => {
      providerCalls += 1;
      return priorFetch(...args);
    }) as typeof fetch;
    const outbound = await sendOutbound({
      caseId: replacementId,
      channel: "email",
      toAddress: "nobody@synthetic.invalid",
      subject: "must not send",
      body: "offline fixture",
      persistedBody: "offline fixture",
      idempotencyKey: `synthetic-test-outbound:${replacementId}`,
    });
    const admin = await sendAdministrativeEmail({
      caseId: replacementId,
      toAddress: "admin@example.com",
      subject: "must not send",
      body: "offline fixture",
      idempotencyKey: `synthetic-test-admin:${replacementId}`,
    });
    const voice = await startVoiceCall({ caseId: replacementId, scenario: "day-before" });
    globalThis.fetch = priorFetch;
    assert.equal(outbound.status, "blocked");
    assert.equal(admin.status, "blocked");
    assert.equal(voice.status, "failed");
    assert.equal(providerCalls, 0);
    const communications = await db.select().from(onbCommunications).where(and(
      eq(onbCommunications.caseId, replacementId),
      eq(onbCommunications.idempotencyKey, `synthetic-test-outbound:${replacementId}`),
    ));
    assert.equal(communications.length, 1);
    const effects = await db.select().from(onbEffectJournal).where(eq(
      onbEffectJournal.caseId,
      replacementId,
    ));
    assert.equal(effects.length, 0);
  });

  test("case dispatch guard makes reset conflict while provider work is in flight", async () => {
    const organizationId = await seedOrganization();
    const target = await seedCase(organizationId);
    const manifest = manifestFor(organizationId, target.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const dispatch = withCaseDispatchGuard(target.id, async () => {
      entered();
      await held;
      return "provider-finished";
    });
    await enteredPromise;
    const activePreview = await inspectSyntheticReset(organizationId, manifest);
    assert.equal(activePreview.status, "blocked");
    const reset = executeSyntheticReset({
      organizationId,
      actorId: "owner-test",
      expectedRevision: activePreview.revision,
      manifest,
    });
    const resetResult = await reset;
    assert.equal(resetResult.kind, "conflict");
    release();
    assert.equal(await dispatch, "provider-finished");
    const [guardBeforeReset] = await db.select().from(onbEffectJournal).where(and(
      eq(onbEffectJournal.organizationId, organizationId),
      eq(onbEffectJournal.caseId, target.id),
      eq(onbEffectJournal.toolName, "provider-dispatch-guard"),
    ));
    assert.equal(guardBeforeReset.status, "confirmed");
    const afterDispatch = await inspectSyntheticReset(organizationId, manifest);
    const completed = await executeSyntheticReset({
      organizationId,
      actorId: "owner-test",
      expectedRevision: afterDispatch.revision,
      manifest,
    });
    assert.equal(completed.kind, "completed");
    const [retainedGuard] = await db.select().from(onbEffectJournal).where(and(
      eq(onbEffectJournal.organizationId, organizationId),
      eq(onbEffectJournal.logicalOperationKey, guardBeforeReset.logicalOperationKey),
    ));
    assert.equal(retainedGuard.status, "confirmed");
    assert.equal(retainedGuard.caseId, null);
  });

  test("provider callback failure leaves a durable unknown guard that blocks reset", async () => {
    const organizationId = await seedOrganization();
    const target = await seedCase(organizationId);
    const manifest = manifestFor(organizationId, target.id);
    await assert.rejects(() => withCaseDispatchGuard(target.id, async () => {
      throw new Error("provider fixture failed");
    }));
    const preview = await inspectSyntheticReset(organizationId, manifest);
    assert.equal(preview.status, "blocked");
    assert.ok(preview.blockers.some((blocker) => blocker.includes("provider effect")));
    const [guard] = await db.select().from(onbEffectJournal).where(and(
      eq(onbEffectJournal.organizationId, organizationId),
      eq(onbEffectJournal.caseId, target.id),
      eq(onbEffectJournal.toolName, "provider-dispatch-guard"),
    ));
    assert.equal(guard.status, "unknown_effect_manual_repair");
  });

  test("retry provider boundary conflicts with reset while provider is in flight", async () => {
    const organizationId = await seedOrganization();
    const target = await seedCase(organizationId);
    await db.update(onbCases).set({
      candidateEmailAuthorizedAt: new Date(),
      candidateEmailAuthorizedBy: "synthetic-reset-test",
    }).where(eq(onbCases.id, target.id));
    const [message] = await db.insert(onbCommunications).values({
      organizationId,
      caseId: target.id,
      channel: "email",
      direction: "outbound",
      audience: "candidate",
      toAddress: "te***@example.invalid",
      subject: "Retry fixture",
      body: "Retry fixture body",
      status: "failed",
      failureReason: "fixture",
    }).returning();
    const manifest = manifestFor(organizationId, target.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    let providerCalls = 0;
    const retry = retryCandidateEmail(
      target.id,
      message.id,
      "synthetic-reset-test",
      async () => {
        providerCalls += 1;
        providerStarted();
        await held;
        return { status: "sent", failureReason: null, externalMessageId: "retry-fixture" };
      },
      () => true,
    );
    await started;
    const activePreview = await inspectSyntheticReset(organizationId, manifest);
    assert.equal(activePreview.status, "blocked");
    const resetResult = await executeSyntheticReset({
      organizationId,
      actorId: "owner-test",
      expectedRevision: activePreview.revision,
      manifest,
    });
    assert.equal(resetResult.kind, "conflict");
    assert.equal(providerCalls, 1);
    release();
    const retryResult = await retry;
    assert.equal(retryResult.ok, true);
    const [guard] = await db.select().from(onbEffectJournal).where(and(
      eq(onbEffectJournal.organizationId, organizationId),
      eq(onbEffectJournal.caseId, target.id),
      eq(onbEffectJournal.toolName, "provider-dispatch-guard"),
    ));
    assert.equal(guard.status, "confirmed");
  });

  test("twelve concurrent guarded callbacks can perform DB work without pool starvation", async () => {
    const organizationId = await seedOrganization();
    const targets = await Promise.all(
      Array.from({ length: 12 }, () => seedCase(organizationId)),
    );
    const results = await Promise.all(targets.map((target) =>
      withCaseDispatchGuard(target.id, async (caseRow) => {
        const [firstRead] = await db.select({ id: onbCases.id })
          .from(onbCases)
          .where(eq(onbCases.id, caseRow.id));
        await new Promise((resolve) => setTimeout(resolve, 25));
        const [secondRead] = await db.select({ id: onbCases.id })
          .from(onbCases)
          .where(eq(onbCases.id, caseRow.id));
        return firstRead?.id === secondRead?.id;
      }),
    ));
    assert.deepEqual(results, Array.from({ length: 12 }, () => true));
  });

  test("a stale unleased running legacy row is fenced before deletion", async () => {
    const organizationId = await seedOrganization();
    const target = await seedCase(organizationId, {
      orchestrationStatus: "running",
    });
    await db.update(onbCases).set({
      createdAt: new Date(Date.now() - 3 * 86_400_000),
      updatedAt: new Date(Date.now() - 3 * 86_400_000),
    }).where(eq(onbCases.id, target.id));
    const manifest = manifestFor(organizationId, target.id);
    const preview = await inspectSyntheticReset(organizationId, manifest);
    assert.equal(preview.status, "ready");
    assert.ok(preview.warnings.some((warning) => warning.includes("stale")));
    const result = await executeSyntheticReset({
      organizationId,
      actorId: "owner-test",
      expectedRevision: preview.revision,
      manifest,
    });
    assert.equal(result.kind, "completed");
    const [oldRow] = await db.select().from(onbCases).where(eq(onbCases.id, target.id));
    assert.equal(oldRow, undefined);
  });

  test("duplicate reset event rolls back deletion, replacements, and receipt atomically", async () => {
    const organizationId = await seedOrganization();
    const target = await seedCase(organizationId);
    const manifest = manifestFor(organizationId, target.id);
    await db.insert(onbEvents).values({
      organizationId,
      caseId: null,
      agent: "test",
      engine: "test",
      hitlPattern: "notify-only",
      ruleRef: "fault-injection",
      title: "duplicate event fixture",
      detail: "forces the reset transaction to roll back",
      idempotencyKey: `onboarding.synthetic-reset.receipt.v1:${organizationId}`,
    });
    const preview = await inspectSyntheticReset(organizationId, manifest);
    await assert.rejects(() => executeSyntheticReset({
      organizationId,
      actorId: "owner-test",
      expectedRevision: preview.revision,
      manifest,
    }));
    const [oldRow] = await db.select().from(onbCases).where(eq(onbCases.id, target.id));
    assert.ok(oldRow);
    const receipt = await db.select().from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      eq(onbSettings.key, "onboarding.synthetic-reset.receipt.v1"),
    ));
    assert.equal(receipt.length, 0);
  });
});

test("the shipped manifest is tenant-explicit and does not accept API overrides", () => {
  assert.equal(DEFAULT_SYNTHETIC_RESET_MANIFEST.length, 19);
  assert.equal(DEFAULT_SYNTHETIC_RESET_MANIFEST.filter((entry) => entry.organizationId === "demo").length, 13);
  assert.equal(DEFAULT_SYNTHETIC_RESET_MANIFEST.filter((entry) => entry.organizationId.startsWith("org_")).length, 6);
});