import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { after, before, describe, test } from "node:test";
import {
  db,
  DEMO_ORGANIZATION_ID,
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
  restartCaseSimulation,
  setSimulationOutcomeSelectorForTests,
  simulateNextCaseExchange,
  type SimulationOutcome,
} from "./case-simulation";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `${process.pid}-${randomUUID()}`;
const administrator = `case-simulation-admin-${suffix}`;
const reviewer = `case-simulation-reviewer-${suffix}`;
const caseIds: number[] = [];

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

  async function createCase(scenarioKey: string | null = null): Promise<number> {
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
      notes: SYNTHETIC_OFFLINE_MARKER,
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
});