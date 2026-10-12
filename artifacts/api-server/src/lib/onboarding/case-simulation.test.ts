import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { after, before, describe, test } from "node:test";
import {
  db,
  DEMO_ORGANIZATION_ID,
  onbAuthorityAssignments,
  onbCases,
  onbCommunications,
  onbEvents,
  onbSettings,
  organizationMembershipsTable,
} from "@workspace/db";
import { demoPrincipalSettingKey } from "../demo-principal";
import {
  CaseSimulationConflictError,
  CaseSimulationDeniedError,
  getCaseSimulation,
  listSimulationEmailRoutes,
  recordSimulationEmailReply,
  restartCaseSimulation,
  setSimulationOutcomeSelectorForTests,
  simulateNextCaseExchange,
  sanitizeSimulationReply,
  type SimulationOutcome,
} from "./case-simulation";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `${process.pid}-${randomUUID()}`;
const administrator = `case-simulation-admin-${suffix}`;
const reviewer = `case-simulation-reviewer-${suffix}`;
const caseIds: number[] = [];

describe("historical email sanitation", () => {
  test("sanitizes HTML and control content before retention", () => {
    assert.equal(
      sanitizeSimulationReply("<b>yes</b><script>alert(1)</script>"),
      "yes",
    );
  });
});

async function next(
  caseId: number,
  requestId: string,
  expectedVersion: number,
  expectedGenerationId?: string,
) {
  return simulateNextCaseExchange({
    organizationId: DEMO_ORGANIZATION_ID,
    actor: administrator,
    caseId,
    requestId,
    expectedVersion,
    expectedGenerationId: expectedGenerationId ?? (
      await getCaseSimulation({
        organizationId: DEMO_ORGANIZATION_ID,
        actor: administrator,
        caseId,
      })
    ).generationId,
  });
}

describe("response-driven case simulation", { skip: !hasDb }, () => {
  before(async () => {
    await db.insert(onbSettings).values([
      {
        organizationId: DEMO_ORGANIZATION_ID,
        key: demoPrincipalSettingKey(administrator),
        value: "administrator",
      },
      {
        organizationId: DEMO_ORGANIZATION_ID,
        key: demoPrincipalSettingKey(reviewer),
        value: "reviewer",
      },
    ]);
    await db.insert(organizationMembershipsTable).values([
      { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: administrator, role: "member" },
      { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: reviewer, role: "member" },
    ]);
    setSimulationOutcomeSelectorForTests(() => "success");
  });

  after(async () => {
    setSimulationOutcomeSelectorForTests(undefined);
    if (caseIds.length) {
      await db.delete(onbCases).where(inArray(onbCases.id, caseIds));
    }
    await db.delete(onbSettings).where(and(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
      inArray(onbSettings.key, [
        demoPrincipalSettingKey(administrator),
        demoPrincipalSettingKey(reviewer),
        ...caseIds.map((id) => `onboarding:case-simulation:${id}`),
      ]),
    ));
    await db.delete(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
      inArray(organizationMembershipsTable.clerkUserId, [administrator, reviewer]),
    ));
  });

  async function createCase(
    scenarioKey: string | null = null,
    volunteered = false,
  ): Promise<number> {
    const [row] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: `Simulation Worker ${suffix}`,
      workerEmail: `simulation-${suffix}@example.invalid`,
      hireType: "external-fte",
      workerCategory: "employee",
      role: "Simulation Engineer",
      department: "Quality",
      geography: "US",
      legalEntity: "Demo Organization",
      managerName: "Simulation Manager",
      recruiterName: "Simulation Recruiter",
      joiningDate: "2035-01-01",
      scenarioKey,
      notes: volunteered
        ? `${SYNTHETIC_OFFLINE_MARKER}\n[demo-controller-run:${suffix}]`
        : SYNTHETIC_OFFLINE_MARKER,
      syntheticProvenance: !volunteered && !scenarioKey?.startsWith("UAT-")
        ? "synthetic-reset"
        : null,
      candidateEmailAuthorizedAt: volunteered ? new Date() : null,
      candidateEmailAuthorizedBy: volunteered ? administrator : null,
      readiness: [{ key: "payroll", label: "Payroll", status: "pending" }],
    }).returning({ id: onbCases.id });
    assert.ok(row);
    caseIds.push(row.id);
    return row.id;
  }

  test("covers outcome branches and records no authoritative readiness effect", async () => {
    const caseId = await createCase();
    const beforeCase = await db.select({ readiness: onbCases.readiness })
      .from(onbCases).where(eq(onbCases.id, caseId));
    const outcomes: SimulationOutcome[] = ["missing-info", "pending", "exception", "success"];
    setSimulationOutcomeSelectorForTests(() => outcomes.shift() ?? "success");

    let state = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    assert.equal(state.operationExchange, null);
    assert.equal(state.replayed, false);
    for (let index = 0; index < 4; index += 1) {
      state = await next(caseId, `branch-${index}`, state.version);
      const exchange = state.exchanges.at(-1)!;
      assert.equal(state.operationExchange?.sequence, exchange.sequence);
      assert.equal(state.replayed, false);
      assert.equal(exchange.outcome, index === 0 ? "missing-info" : index === 1 ? "pending" : index === 2 ? "exception" : "success");
      assert.match(exchange.requestText, /^\[SIMULATED\]/);
      assert.match(exchange.responseText, /^\[SIMULATED\]/);
      assert.match(exchange.decisionExplanation, /^\[SIMULATED\]/);
      assert.equal(exchange.stageBefore, "offer");
      assert.equal(exchange.stageAfter, index === 3 ? "documents" : "offer");
      assert.equal(exchange.responderLabel.startsWith("Simulated "), true);
      if (index === 1) assert.match(exchange.requestText, /Follow up/);
      if (index === 2) assert.match(exchange.requestText, /Poll/);
      if (index === 3) assert.match(exchange.requestText, /Human-review exchange/);
      if (exchange.outcome === "missing-info") {
        assert.equal(exchange.nextAction, "follow-up-missing-info");
        assert.equal(exchange.followUp, true);
        assert.equal(exchange.reviewRequired, false);
      } else if (exchange.outcome === "pending") {
        assert.equal(exchange.nextAction, "poll-status");
        assert.equal(exchange.followUp, false);
        assert.equal(exchange.reviewRequired, false);
        assert.match(exchange.responseText, /not human review/);
      } else if (exchange.outcome === "exception") {
        assert.equal(exchange.nextAction, "simulated-human-review");
        assert.equal(exchange.reviewRequired, true);
      } else {
        assert.equal(exchange.nextAction, "advance-stage");
        if (index === 3) {
          assert.match(exchange.responseText, /Human-review decision/);
          assert.match(exchange.decisionExplanation, /explicit simulated HR decision/);
        }
      }
    }
    assert.equal(state.exchanges.length, 4);
    assert.equal(state.stage, "documents");
    assert.deepEqual(
      (await db.select({ readiness: onbCases.readiness }).from(onbCases).where(eq(onbCases.id, caseId)))[0]?.readiness,
      beforeCase[0]?.readiness,
    );
    assert.equal((await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId))).length, 4);
    assert.equal((await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseId))).length, 4);
  });

  test("replays idempotently and rejects stale or concurrent writes", async () => {
    const caseId = await createCase();
    const first = await next(caseId, "replay", 0);
    assert.equal(first.replayed, false);
    assert.equal(first.operationExchange?.sequence, 1);
    await assert.rejects(() => next(caseId, "different", 0), CaseSimulationConflictError);
    const results = await Promise.allSettled([
      next(caseId, "concurrent-a", 1),
      next(caseId, "concurrent-b", 1),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const replay = await next(caseId, "replay", 0);
    assert.equal(replay.replayed, true);
    assert.equal(replay.version, 2);
    assert.equal(replay.operationExchange?.sequence, 1);
    assert.equal(replay.operationExchange?.outcome, first.operationExchange?.outcome);
    assert.equal((await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId))).length, 2);
    assert.equal((await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseId))).length, 2);
  });

  test("normal success path requires an explicit final simulated HR review", async () => {
    const caseId = await createCase();
    setSimulationOutcomeSelectorForTests(() => "success");
    let state = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    for (let index = 0; index < 6; index += 1) {
      state = await next(caseId, `success-${index}`, state.version);
      assert.equal(state.status, "active");
    }
    assert.equal(state.stage, "final-review");
    const finalReview = await next(caseId, "success-final-review", state.version);
    const exchange = finalReview.operationExchange!;
    assert.equal(exchange.stageBefore, "final-review");
    assert.equal(exchange.stageAfter, "complete");
    assert.equal(exchange.nextAction, "complete");
    assert.equal(exchange.responderLabel, "Simulated HR reviewer");
    assert.match(exchange.requestText, /Human-review exchange/);
    assert.match(exchange.responseText, /Human-review decision/);
    assert.match(exchange.decisionExplanation, /explicit simulated HR decision/);
    assert.equal(finalReview.status, "completed");
    assert.equal(finalReview.stage, "complete");
    const readBack = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    assert.equal(readBack.operationExchange, null);
    assert.equal(readBack.replayed, false);
  });

  test("exception recovery uses a simulated human decision before advancing", async () => {
    const caseId = await createCase();
    const outcomes: SimulationOutcome[] = ["exception", "success"];
    setSimulationOutcomeSelectorForTests(() => outcomes.shift() ?? "success");
    const first = await next(caseId, "exception", 0);
    assert.equal(first.stage, "offer");
    assert.equal(first.status, "review");
    assert.equal(first.operationExchange?.nextAction, "simulated-human-review");
    assert.equal(first.operationExchange?.reviewRequired, true);
    const recovered = await next(caseId, "exception-review", first.version);
    assert.equal(recovered.stage, "documents");
    assert.equal(recovered.status, "active");
    assert.equal(recovered.operationExchange?.responderLabel, "Simulated HR reviewer");
    assert.match(recovered.operationExchange?.responseText ?? "", /Human-review decision/);
    assert.match(recovered.operationExchange?.decisionExplanation ?? "", /explicit simulated HR decision/);
  });

  test("restarts into an independent generation and preserves the append-only audit history", async () => {
    const caseId = await createCase();
    setSimulationOutcomeSelectorForTests(() => "success");
    const initial = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    const advanced = await next(caseId, "restart-advance", initial.version, initial.generationId);
    const beforeCase = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
    const beforeEvents = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId));
    const beforeCommunications = await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseId));
    assert.equal((await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    })).generationId, advanced.generationId);

    const restarted = await restartCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
      expectedVersion: advanced.version,
      expectedGenerationId: advanced.generationId,
      requestId: "restart-once",
    });
    assert.notEqual(restarted.generationId, advanced.generationId);
    assert.equal(restarted.version, 0);
    assert.equal(restarted.stage, "offer");
    assert.equal(restarted.status, "ready");
    assert.deepEqual(restarted.exchanges, []);
    assert.equal(restarted.operationExchange, null);
    assert.equal(restarted.replayed, false);
    assert.equal((await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId))).length, beforeEvents.length + 1);
    assert.equal((await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseId))).length, beforeCommunications.length + 1);
    assert.deepEqual(
      (await db.select().from(onbCases).where(eq(onbCases.id, caseId)))[0],
      beforeCase[0],
    );

    const replay = await restartCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
      expectedVersion: advanced.version,
      expectedGenerationId: advanced.generationId,
      requestId: "restart-once",
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.generationId, restarted.generationId);
    assert.equal(replay.version, 0);
    assert.equal((await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId))).length, beforeEvents.length + 1);
    assert.equal((await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseId))).length, beforeCommunications.length + 1);

    await assert.rejects(
      () => next(caseId, "stale-after-restart", advanced.version, advanced.generationId),
      CaseSimulationConflictError,
    );
    await assert.rejects(
      () => restartCaseSimulation({
        organizationId: DEMO_ORGANIZATION_ID,
        actor: administrator,
        caseId,
        expectedVersion: advanced.version,
        expectedGenerationId: advanced.generationId,
        requestId: "stale-restart",
      }),
      CaseSimulationConflictError,
    );
  });

  test("denies reviewer and UAT-isolated cases", async () => {
    const uatCaseId = await createCase("UAT-SIM-01");
    await assert.rejects(
      () => getCaseSimulation({
        organizationId: DEMO_ORGANIZATION_ID,
        actor: reviewer,
        caseId: uatCaseId,
      }),
      CaseSimulationDeniedError,
    );
    await assert.rejects(
      () => getCaseSimulation({
        organizationId: DEMO_ORGANIZATION_ID,
        actor: administrator,
        caseId: uatCaseId,
      }),
      CaseSimulationConflictError,
    );
    assert.equal((await db.select().from(onbEvents).where(eq(onbEvents.caseId, uatCaseId))).length, 0);
    assert.equal((await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, uatCaseId))).length, 0);
  });

  test("marker-only hybrid-looking case is not eligible for synthetic response simulation", async () => {
    const caseId = await createCase("demo-controller", true);
    await assert.rejects(
      getCaseSimulation({
        organizationId: DEMO_ORGANIZATION_ID,
        actor: administrator,
        caseId,
      }),
      CaseSimulationDeniedError,
    );
    const authorityAssignments = await db.select().from(onbAuthorityAssignments).where(and(
      eq(onbAuthorityAssignments.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbAuthorityAssignments.personUserId, administrator),
      eq(onbAuthorityAssignments.caseId, caseId),
    ));
    assert.equal(authorityAssignments.length, 0);
  });

  async function installEmailDispatch(caseId: number, requestId: string, generationId: string, version: number) {
    const state = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    const token = `token-${randomUUID()}`;
    const threadMarker = `thread-${randomUUID()}`;
    await db.insert(onbSettings).values({
      organizationId: DEMO_ORGANIZATION_ID,
      key: `onboarding:case-simulation:${caseId}`,
      value: JSON.stringify({
        ...state,
        version: version + 1,
        requests: {},
        emailDispatches: {
          [requestId]: {
            requestId,
            generationId,
            version,
            token,
            threadMarker,
            subject: `[DEMO SIMULATION][SIM-THREAD:${threadMarker}] offer package`,
            body: `[SIMULATED EMPLOYEE PROMPT] Please confirm.\n[SIM-THREAD:${threadMarker}] [SIM-REPLY-TOKEN:${token}]`,
            recipient: "volunteer@example.com",
            status: "sent",
            providerMessageId: "outbound-provider-id",
          },
        },
      }),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });
    return { token, threadMarker };
  }

  test("records even a current-generation historical reply without advancing simulation or case state", async () => {
    const caseId = await createCase();
    const beforeCase = (await db.select({
      readiness: onbCases.readiness,
      lifecycleStage: onbCases.lifecycleStage,
      orchestrationStatus: onbCases.orchestrationStatus,
      orchestrationCheckpoint: onbCases.orchestrationCheckpoint,
    }).from(onbCases).where(eq(onbCases.id, caseId)))[0];
    const beforeCandidateComms = (await db.select().from(onbCommunications).where(and(
      eq(onbCommunications.caseId, caseId),
      eq(onbCommunications.audience, "candidate"),
    ))).length;
    const state = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    const { token, threadMarker } = await installEmailDispatch(caseId, "email-current", state.generationId, state.version);
    assert.equal(
      await recordSimulationEmailReply({
        caseId,
        organizationId: DEMO_ORGANIZATION_ID,
        fromAddress: "volunteer@example.com",
        subject: `[DEMO SIMULATION][SIM-THREAD:${threadMarker}] Re: offer package`,
        body: "I completed it.",
        externalMessageId: "simulation-provider-reply-current",
        token,
        threadMarker,
      }),
      "stale",
    );
    const after = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    assert.equal(after.exchanges.length, 0);
    assert.equal(after.emailDelivery?.recipient, "pinned Demo volunteer");
    assert.deepEqual((await db.select({
      readiness: onbCases.readiness,
      lifecycleStage: onbCases.lifecycleStage,
      orchestrationStatus: onbCases.orchestrationStatus,
      orchestrationCheckpoint: onbCases.orchestrationCheckpoint,
    }).from(onbCases).where(eq(onbCases.id, caseId)))[0], beforeCase);
    assert.equal((await db.select().from(onbCommunications).where(and(
      eq(onbCommunications.caseId, caseId),
      eq(onbCommunications.audience, "candidate"),
    ))).length, beforeCandidateComms);
  });

  test("dedups provider ids and ignores a delayed reply from a retired generation", async () => {
    const caseId = await createCase();
    const initial = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    const { token, threadMarker } = await installEmailDispatch(caseId, "email-stale", initial.generationId, initial.version);
    const restarted = await restartCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
      expectedVersion: initial.version + 1,
      expectedGenerationId: initial.generationId,
      requestId: "retire-email-generation",
    });
    assert.notEqual(restarted.generationId, initial.generationId);
    const result = await recordSimulationEmailReply({
      caseId,
      organizationId: DEMO_ORGANIZATION_ID,
      fromAddress: "volunteer@example.com",
      subject: `[DEMO SIMULATION][SIM-THREAD:${threadMarker}] Re: offer package`,
      body: "I completed it.",
      externalMessageId: "simulation-provider-reply-stale",
      token,
      threadMarker,
    });
    assert.equal(result, "stale");
    const duplicate = await recordSimulationEmailReply({
      caseId,
      organizationId: DEMO_ORGANIZATION_ID,
      fromAddress: "volunteer@example.com",
      subject: `[DEMO SIMULATION][SIM-THREAD:${threadMarker}] Re: offer package`,
      body: "I completed it.",
      externalMessageId: "simulation-provider-reply-stale",
      token,
      threadMarker,
    });
    assert.equal(duplicate, "duplicate");
    const current = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    assert.equal(current.generationId, restarted.generationId);
    assert.equal(current.version, restarted.version);
    assert.equal(current.exchanges.length, 0);
    assert.equal((await db.select().from(onbCommunications).where(and(
      eq(onbCommunications.caseId, caseId),
      eq(onbCommunications.externalMessageId, "simulation-provider-reply-stale"),
    ))).length, 1);
  });

  test("retained controller cases cannot fall back to ordinary offline simulation", async () => {
    const caseId = await createCase();
    const initial = await getCaseSimulation({
      organizationId: DEMO_ORGANIZATION_ID,
      actor: administrator,
      caseId,
    });
    await db.update(onbCases).set({ controllerRetired: true }).where(eq(onbCases.id, caseId));
    await assert.rejects(simulateNextCaseExchange({
      organizationId: DEMO_ORGANIZATION_ID, actor: administrator, caseId,
      expectedVersion: initial.version, expectedGenerationId: initial.generationId,
      requestId: "retired-case",
    }), CaseSimulationDeniedError);
  });
});