import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, DEMO_ORGANIZATION_ID, onbSettings } from "@workspace/db";
import {
  CANDIDATE_CLEANUP_DELAY_MS,
  CANDIDATE_CLEANUP_TELEMETRY_KEY,
  candidateCleanupHealth,
  classifyCandidateCleanup,
  parseCandidateCleanupTelemetry,
  recordCandidateCleanupFailure,
  recordCandidateCleanupSuccess,
  runCandidateAccessCleanup,
  type CandidateCleanupTelemetry,
} from "./candidate-access-cleanup";

const NOW = Date.parse("2026-09-09T12:00:00.000Z");

function telemetry(overrides: Partial<CandidateCleanupTelemetry> = {}): CandidateCleanupTelemetry {
  return {
    lastAttemptAt: new Date(NOW).toISOString(),
    lastSuccessAt: new Date(NOW).toISOString(),
    expiredSessions: 2,
    retainedLinksDeleted: 3,
    consecutiveFailures: 0,
    lastError: null,
    lastErrorAt: null,
    outageStartedAt: null,
    alertEpisodes: {},
    alerted: false,
    ...overrides,
  };
}

describe("candidate-access cleanup health", () => {
  test("is healthy after a recent successful run and exposes counts only", () => {
    assert.equal(classifyCandidateCleanup(telemetry(), NOW), "healthy");
    assert.deepEqual(candidateCleanupHealth(telemetry(), NOW), {
      state: "healthy",
      healthy: true,
      lastAttemptAt: new Date(NOW).toISOString(),
      lastSuccessAt: new Date(NOW).toISOString(),
      expiredSessions: 2,
      retainedLinksDeleted: 3,
      consecutiveFailures: 0,
      lastErrorAt: null,
    });
  });

  test("is delayed before the first success or after the heartbeat window", () => {
    assert.equal(classifyCandidateCleanup(telemetry({ lastSuccessAt: null }), NOW), "delayed");
    assert.equal(
      classifyCandidateCleanup(telemetry({ lastSuccessAt: new Date(NOW - CANDIDATE_CLEANUP_DELAY_MS - 1).toISOString() }), NOW),
      "delayed",
    );
  });

  test("is failed whenever the latest attempts are failing", () => {
    assert.equal(classifyCandidateCleanup(telemetry({ consecutiveFailures: 1 }), NOW), "failed");
  });

  test("malformed durable telemetry fails safely to delayed defaults", () => {
    const parsed = parseCandidateCleanupTelemetry(JSON.stringify({
      lastSuccessAt: "not-a-date",
      expiredSessions: -10,
    }));
    assert.equal(classifyCandidateCleanup(parsed, NOW), "delayed");
    assert.equal(parsed.expiredSessions, 0);
  });

  test("keeps one stable outage identity until recovery", () => {
    const at = new Date(NOW).toISOString();
    const first = recordCandidateCleanupFailure(telemetry(), at, "delete failed");
    const second = recordCandidateCleanupFailure(first, at, "delete failed");
    const third = recordCandidateCleanupFailure(second, at, "delete failed");
    assert.equal(first.alerted, false);
    assert.equal(second.alerted, false);
    assert.equal(third.alerted, false);
    assert.equal(third.outageStartedAt, at);
    assert.ok(third.alertEpisodes[at]);
    const recovered = recordCandidateCleanupSuccess(third, at, {
      expiredSessions: 5,
      retainedLinksDeleted: 2,
    });
    assert.equal(recovered.consecutiveFailures, 0);
    assert.equal(recovered.expiredSessions, 5);
    assert.equal(recovered.outageStartedAt, null);
    assert.equal(recovered.alertEpisodes[at].recoveredAt, at);
  });
});

test("durable cleanup alerts retry only failed recipients across runner restarts", async () => {
  const where = and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, CANDIDATE_CLEANUP_TELEMETRY_KEY),
  );
  const [before] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
  await db.delete(onbSettings).where(where);
  let clock = NOW;
  const outageAttempts = new Map<string, number>();
  const recoveryAttempts = new Map<string, number>();
  const organizations = ["cleanup-alert-a", "cleanup-alert-b"];
  const failingCleanup = async () => {
    throw new Error("cleanup unavailable");
  };
  let allowSecondRecipient = false;
  const sendAlert = async (organizationId: string, kind: "outage" | "recovery") => {
    const attempts = kind === "outage" ? outageAttempts : recoveryAttempts;
    attempts.set(organizationId, (attempts.get(organizationId) ?? 0) + 1);
    return organizationId === organizations[0] || allowSecondRecipient;
  };
  try {
    for (let index = 0; index < 3; index += 1) {
      await runCandidateAccessCleanup({
        cleanup: failingCleanup,
        now: () => new Date(clock++),
        alertOrganizations: async () => organizations,
        sendAlert,
      });
    }
    let [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
    let persisted = parseCandidateCleanupTelemetry(stored.value);
    const firstOutageId = persisted.outageStartedAt!;
    assert.deepEqual(Object.fromEntries(outageAttempts), {
      [organizations[0]]: 1,
      [organizations[1]]: 1,
    });
    assert.ok(persisted.alertEpisodes[firstOutageId].deliveries[organizations[0]].outageDeliveredAt);
    assert.equal(persisted.alertEpisodes[firstOutageId].deliveries[organizations[1]].outageDeliveredAt, null);
    assert.equal(persisted.alerted, false);

    allowSecondRecipient = true;
    await runCandidateAccessCleanup({
      cleanup: failingCleanup,
      now: () => new Date(clock++),
      alertOrganizations: async () => organizations,
      sendAlert,
    });
    [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
    persisted = parseCandidateCleanupTelemetry(stored.value);
    assert.deepEqual(Object.fromEntries(outageAttempts), {
      [organizations[0]]: 1,
      [organizations[1]]: 2,
    });
    assert.equal(persisted.alerted, true);

    allowSecondRecipient = false;
    await runCandidateAccessCleanup({
      cleanup: async () => ({ expiredSessions: 4, retainedLinksDeleted: 2 }),
      now: () => new Date(clock++),
      sendAlert,
    });
    [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
    persisted = parseCandidateCleanupTelemetry(stored.value);
    assert.ok(persisted.alertEpisodes[firstOutageId].deliveries[organizations[0]].recoveryDeliveredAt);
    assert.equal(persisted.alertEpisodes[firstOutageId].deliveries[organizations[1]].recoveryDeliveredAt, null);
    assert.equal(persisted.outageStartedAt, null);

    for (let index = 0; index < 3; index += 1) {
      await runCandidateAccessCleanup({
        cleanup: failingCleanup,
        now: () => new Date(clock++),
        alertOrganizations: async () => organizations,
        sendAlert,
      });
    }
    [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
    persisted = parseCandidateCleanupTelemetry(stored.value);
    const renewedOutageId = persisted.outageStartedAt!;
    assert.notEqual(renewedOutageId, firstOutageId);
    assert.ok(persisted.alertEpisodes[firstOutageId].deliveries[organizations[0]].recoveryDeliveredAt);
    assert.equal(persisted.alertEpisodes[firstOutageId].deliveries[organizations[1]].recoveryDeliveredAt, null);
    assert.ok(persisted.alertEpisodes[renewedOutageId].deliveries[organizations[0]].outageDeliveredAt);
    assert.deepEqual(Object.fromEntries(outageAttempts), {
      [organizations[0]]: 2,
      [organizations[1]]: 3,
    });

    allowSecondRecipient = true;
    await runCandidateAccessCleanup({
      cleanup: failingCleanup,
      now: () => new Date(clock++),
      alertOrganizations: async () => organizations,
      sendAlert,
    });
    await runCandidateAccessCleanup({
      cleanup: async () => ({ expiredSessions: 0, retainedLinksDeleted: 0 }),
      now: () => new Date(clock++),
      sendAlert,
    });
    [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
    const final = parseCandidateCleanupTelemetry(stored.value);
    assert.deepEqual(Object.fromEntries(recoveryAttempts), {
      [organizations[0]]: 2,
      [organizations[1]]: 3,
    });
    assert.deepEqual(Object.fromEntries(outageAttempts), {
      [organizations[0]]: 2,
      [organizations[1]]: 4,
    });
    assert.equal(final.alerted, false);
    assert.equal(final.consecutiveFailures, 0);
    assert.equal(final.outageStartedAt, null);
    assert.deepEqual(final.alertEpisodes, {});
    assert.equal(final.lastSuccessAt, new Date(clock - 1).toISOString());
  } finally {
    await db.delete(onbSettings).where(where);
    if (before) {
      await db.insert(onbSettings).values({
        organizationId: DEMO_ORGANIZATION_ID,
        key: CANDIDATE_CLEANUP_TELEMETRY_KEY,
        value: before.value,
      });
    }
  }
});

test("overlapping cleanup runners claim each recipient alert only once", async () => {
  const where = and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, CANDIDATE_CLEANUP_TELEMETRY_KEY),
  );
  const [before] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
  await db.delete(onbSettings).where(where);
  const failingCleanup = async () => {
    throw new Error("cleanup unavailable");
  };
  const organizationId = "cleanup-alert-overlap";
  let sends = 0;
  let releaseSend!: () => void;
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseSend = resolve; });
  const sendAlert = async () => {
    sends += 1;
    signalEntered();
    await release;
    return true;
  };
  try {
    for (let index = 0; index < 2; index += 1) {
      await runCandidateAccessCleanup({
        cleanup: failingCleanup,
        alertOrganizations: async () => [organizationId],
        sendAlert,
      });
    }
    const first = runCandidateAccessCleanup({
      cleanup: failingCleanup,
      alertOrganizations: async () => [organizationId],
      sendAlert,
    });
    await entered;
    await runCandidateAccessCleanup({
      cleanup: failingCleanup,
      alertOrganizations: async () => [organizationId],
      sendAlert,
    });
    assert.equal(sends, 1);
    releaseSend();
    await first;
    const [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
    const persisted = parseCandidateCleanupTelemetry(stored.value);
    assert.ok(persisted.alertEpisodes[persisted.outageStartedAt!].deliveries[organizationId].outageDeliveredAt);
  } finally {
    releaseSend?.();
    await db.delete(onbSettings).where(where);
    if (before) {
      await db.insert(onbSettings).values({
        organizationId: DEMO_ORGANIZATION_ID,
        key: CANDIDATE_CLEANUP_TELEMETRY_KEY,
        value: before.value,
      });
    }
  }
});

test("a recovered episode rejects late outage recipients while recovery is in flight", async () => {
  const where = and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, CANDIDATE_CLEANUP_TELEMETRY_KEY),
  );
  const [before] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
  await db.delete(onbSettings).where(where);
  const organizations = ["cleanup-alert-recovered-a", "cleanup-alert-recovered-b"];
  const sent: string[] = [];
  let releaseRecipientList!: () => void;
  let signalRecipientListStarted!: () => void;
  let releaseRecovery!: () => void;
  let signalRecoveryStarted!: () => void;
  const recipientListStarted = new Promise<void>((resolve) => { signalRecipientListStarted = resolve; });
  const recipientListRelease = new Promise<void>((resolve) => { releaseRecipientList = resolve; });
  const recoveryStarted = new Promise<void>((resolve) => { signalRecoveryStarted = resolve; });
  const recoveryRelease = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const failingCleanup = async () => {
    throw new Error("cleanup unavailable");
  };
  const sendAlert = async (organizationId: string, kind: "outage" | "recovery") => {
    sent.push(`${kind}:${organizationId}`);
    if (organizationId === organizations[0] && kind === "recovery") {
      signalRecoveryStarted();
      await recoveryRelease;
    }
    return true;
  };
  try {
    for (let index = 0; index < 3; index += 1) {
      await runCandidateAccessCleanup({
        cleanup: failingCleanup,
        alertOrganizations: async () => [organizations[0]],
        sendAlert,
      });
    }
    const lateOutageRun = runCandidateAccessCleanup({
      cleanup: failingCleanup,
      alertOrganizations: async () => {
        signalRecipientListStarted();
        await recipientListRelease;
        return organizations;
      },
      sendAlert,
    });
    await recipientListStarted;

    const successfulRun = runCandidateAccessCleanup({
      cleanup: async () => ({ expiredSessions: 0, retainedLinksDeleted: 0 }),
      sendAlert,
    });
    await recoveryStarted;

    releaseRecipientList();
    await lateOutageRun;
    assert.deepEqual(sent, [
      `outage:${organizations[0]}`,
      `recovery:${organizations[0]}`,
    ]);

    releaseRecovery();
    await successfulRun;
    const [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
    const final = parseCandidateCleanupTelemetry(stored.value);
    assert.equal(final.outageStartedAt, null);
    assert.deepEqual(final.alertEpisodes, {});
  } finally {
    releaseRecipientList?.();
    releaseRecovery?.();
    await db.delete(onbSettings).where(where);
    if (before) {
      await db.insert(onbSettings).values({
        organizationId: DEMO_ORGANIZATION_ID,
        key: CANDIDATE_CLEANUP_TELEMETRY_KEY,
        value: before.value,
      });
    }
  }
});

test("successful cleanup overlapping an outage send preserves eventual recovery delivery", async () => {
  const where = and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, CANDIDATE_CLEANUP_TELEMETRY_KEY),
  );
  const [before] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
  await db.delete(onbSettings).where(where);
  const failingCleanup = async () => {
    throw new Error("cleanup unavailable");
  };
  const organizationId = "cleanup-alert-recovery-overlap";
  const sent: string[] = [];
  let releaseOutage!: () => void;
  let signalOutageStarted!: () => void;
  const outageStarted = new Promise<void>((resolve) => { signalOutageStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseOutage = resolve; });
  const sendAlert = async (_organizationId: string, kind: "outage" | "recovery") => {
    sent.push(kind);
    if (kind === "outage") {
      signalOutageStarted();
      await release;
    }
    return true;
  };
  try {
    for (let index = 0; index < 2; index += 1) {
      await runCandidateAccessCleanup({
        cleanup: failingCleanup,
        alertOrganizations: async () => [organizationId],
        sendAlert,
      });
    }
    const failingRun = runCandidateAccessCleanup({
      cleanup: failingCleanup,
      alertOrganizations: async () => [organizationId],
      sendAlert,
    });
    await outageStarted;

    await runCandidateAccessCleanup({
      cleanup: async () => ({ expiredSessions: 1, retainedLinksDeleted: 1 }),
      sendAlert,
    });
    let [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
    assert.ok(Object.keys(parseCandidateCleanupTelemetry(stored.value).alertEpisodes).length > 0);
    assert.deepEqual(sent, ["outage"]);

    releaseOutage();
    await failingRun;
    await runCandidateAccessCleanup({
      cleanup: async () => ({ expiredSessions: 0, retainedLinksDeleted: 0 }),
      sendAlert,
    });
    [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(where);
    const final = parseCandidateCleanupTelemetry(stored.value);
    assert.deepEqual(sent, ["outage", "recovery"]);
    assert.equal(final.outageStartedAt, null);
    assert.deepEqual(final.alertEpisodes, {});
  } finally {
    releaseOutage?.();
    await db.delete(onbSettings).where(where);
    if (before) {
      await db.insert(onbSettings).values({
        organizationId: DEMO_ORGANIZATION_ID,
        key: CANDIDATE_CLEANUP_TELEMETRY_KEY,
        value: before.value,
      });
    }
  }
});