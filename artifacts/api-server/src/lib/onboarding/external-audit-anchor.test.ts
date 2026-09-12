import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { DEMO_ORGANIZATION_ID, onbAuditHeads, onbSettings } from "@workspace/db/schema";
import {
  compareLocalAndExternalCheckpoint,
  currentExternalAuditAnchorProvider,
  externalAuditAnchorReviewerFaults,
  externalAuditAnchorSafeStatus,
  registerExternalAuditAnchorProvider,
  resetExternalAuditAnchorProviderForTests,
} from "./external-audit-anchor";
import {
  getExternalAuditAnchorReviewerAmbiguousDeliveries,
  getExternalAuditAnchorReviewerAlertStatus,
  reconcileExternalAuditAnchorReviewerAlert,
  runExternalAuditAnchorReviewerAlertTickForOrganization,
} from "./external-audit-anchor-alerts";
import { regulatedProductionAuditLaunchBlocked } from "./protected-audit";

const reviewerStateKeys: string[] = [];
const anchorHealthOrganizations: string[] = [];
afterEach(async () => {
  resetExternalAuditAnchorProviderForTests();
  await Promise.all(reviewerStateKeys.splice(0).map((key) =>
    db.delete(onbSettings).where(and(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbSettings.key, key),
    )),
  ));
  await Promise.all(anchorHealthOrganizations.splice(0).map((organizationId) =>
    db.delete(onbAuditHeads).where(eq(onbAuditHeads.organizationId, organizationId)),
  ));
});

function reviewerTestDeps(
  stateKey: string,
  now: number,
  delivery: "clear" | "backlog",
  send: (subject: string, body: string) => Promise<{ status: string }>,
) {
  return {
    stateKey,
    now: () => new Date(now),
    sustainedFailureMs: 0,
    assess: async () => ({
      delivery,
      providerRead: "not-applicable" as const,
      receiptVerification: "not-applicable" as const,
    }),
    send: async (_organizationId: string, subject: string, body: string) => send(subject, body),
  };
}

test("the default simulation exercises receipt flow but is never independent", () => {
  resetExternalAuditAnchorProviderForTests();
  const provider = currentExternalAuditAnchorProvider();
  assert.equal(provider.kind, "simulated");
  assert.equal(provider.independent, false);
});

test("restore comparison distinguishes match, backlog, and divergence", () => {
  assert.equal(compareLocalAndExternalCheckpoint(null, null), "empty");
  assert.equal(compareLocalAndExternalCheckpoint({ sequence: 1, hash: "a" }, null), "missing");
  assert.equal(
    compareLocalAndExternalCheckpoint({ sequence: 2, hash: "b" }, { sequence: 2, hash: "b" }),
    "match",
  );
  assert.equal(
    compareLocalAndExternalCheckpoint({ sequence: 3, hash: "c" }, { sequence: 2, hash: "b" }),
    "external-behind",
  );
  assert.equal(
    compareLocalAndExternalCheckpoint({ sequence: 2, hash: "b" }, { sequence: 3, hash: "c" }),
    "external-ahead",
  );
  assert.equal(
    compareLocalAndExternalCheckpoint({ sequence: 2, hash: "b" }, { sequence: 2, hash: "c" }),
    "mismatch",
  );
});

test("a broken or empty local chain can never be launch-unblocked", () => {
  assert.equal(regulatedProductionAuditLaunchBlocked("broken", false), true);
  assert.equal(regulatedProductionAuditLaunchBlocked("empty", false), true);
  assert.equal(regulatedProductionAuditLaunchBlocked("verified", true), true);
  assert.equal(regulatedProductionAuditLaunchBlocked("verified", false), false);
});

test("safe health fails a clear outbox when the independent provider checkpoint is absent, stale, divergent, or malformed", async () => {
  const organizationId = randomUUID();
  anchorHealthOrganizations.push(organizationId);
  await db.insert(onbAuditHeads).values({ organizationId, lastSequence: 3, lastHash: "local-head" });
  let checkpoint: Record<string, unknown> | null = null;
  registerExternalAuditAnchorProvider({
    id: "health-test-provider", kind: "external", independent: true,
    async anchor() { throw new Error("not used"); },
    async verifyReceipt() { return true; },
    async fetchCurrentCheckpoint() { return checkpoint as never; },
  });
  const receipt = (sequence: number, hash: string) => ({
    receiptVersion: 1, providerId: "health-test-provider", providerKind: "external" as const,
    operationKind: "checkpoint" as const, organizationId, idempotencyKey: `health:${sequence}:${hash}`,
    checkpointSequence: sequence, checkpointHash: hash, retentionStatementPresent: false,
    legalHoldActive: false, proof: "opaque", issuedAt: new Date().toISOString(),
  });
  assert.equal((await externalAuditAnchorSafeStatus(organizationId)).receiptVerification, "failed"); // null remote, nonempty local
  checkpoint = receipt(2, "older");
  assert.equal((await externalAuditAnchorSafeStatus(organizationId)).receiptVerification, "failed"); // stale
  checkpoint = receipt(3, "different");
  assert.equal((await externalAuditAnchorSafeStatus(organizationId)).receiptVerification, "failed"); // internally valid but divergent
  checkpoint = { ...receipt(3, "local-head"), checkpointHash: "" };
  assert.equal((await externalAuditAnchorSafeStatus(organizationId)).receiptVerification, "failed"); // malformed
  checkpoint = receipt(3, "local-head");
  const recovered = await externalAuditAnchorSafeStatus(organizationId);
  assert.equal(recovered.delivery, "clear");
  assert.equal(recovered.providerRead, "ok");
  assert.equal(recovered.receiptVerification, "ok");
});

test("persistent anchor outage pages once across repeated heartbeats and recovery closes the episode", async () => {
  const stateKey = `external-audit-anchor-reviewer-alert:test:${randomUUID()}`;
  reviewerStateKeys.push(stateKey);
  const T0 = Date.parse("2026-08-13T10:00:00.000Z");
  const messages: Array<{ subject: string; body: string }> = [];
  const send = async (subject: string, body: string) => {
    messages.push({ subject, body });
    return { status: "sent" };
  };

  await runExternalAuditAnchorReviewerAlertTickForOrganization(
    DEMO_ORGANIZATION_ID,
    reviewerTestDeps(stateKey, T0, "backlog", send),
  );
  let status = await getExternalAuditAnchorReviewerAlertStatus(DEMO_ORGANIZATION_ID, { stateKey });
  assert.equal(status.active, true);
  assert.deepEqual(status.faults, ["delivery-backlog"]);
  assert.equal(status.notification.state, "sent");
  assert.equal(messages.length, 1);
  // The body may communicate only a safe class, never the test tenant,
  // receipt payload, idempotency material, provider identity, or credentials.
  assert.match(messages[0]!.body, /Safe status: delivery-backlog/);
  assert.doesNotMatch(messages[0]!.body, new RegExp(DEMO_ORGANIZATION_ID, "i"));
  assert.doesNotMatch(messages[0]!.body, /receipt|idempotency|credential|provider id/i);

  // A fresh invocation represents a restarted worker: durable state still
  // suppresses a duplicate alert.
  await runExternalAuditAnchorReviewerAlertTickForOrganization(
    DEMO_ORGANIZATION_ID,
    reviewerTestDeps(stateKey, T0 + 1, "backlog", send),
  );
  assert.equal(messages.length, 1);

  await runExternalAuditAnchorReviewerAlertTickForOrganization(
    DEMO_ORGANIZATION_ID,
    reviewerTestDeps(stateKey, T0 + 2, "clear", send),
  );
  status = await getExternalAuditAnchorReviewerAlertStatus(DEMO_ORGANIZATION_ID, { stateKey });
  assert.equal(status.active, false);
  assert.equal(status.lastRecovery.notification, "sent");
  assert.equal(messages.length, 2);
  assert.match(messages[1]!.subject, /recovered/i);
});

test("reviewer-notification failure remains durable and retries only after its throttle", async () => {
  const stateKey = `external-audit-anchor-reviewer-alert:test:${randomUUID()}`;
  reviewerStateKeys.push(stateKey);
  const T0 = Date.parse("2026-08-13T10:00:00.000Z");
  let sends = 0;
  const send = async () => {
    sends += 1;
    return { status: sends === 1 ? "failed" : "sent" };
  };
  const retryMs = 1_000;

  await runExternalAuditAnchorReviewerAlertTickForOrganization(
    DEMO_ORGANIZATION_ID,
    {
      ...reviewerTestDeps(stateKey, T0, "backlog", send),
      notificationRetryMs: retryMs,
    },
  );
  let status = await getExternalAuditAnchorReviewerAlertStatus(DEMO_ORGANIZATION_ID, { stateKey });
  assert.equal(sends, 1);
  assert.equal(status.notification.state, "failed");

  await runExternalAuditAnchorReviewerAlertTickForOrganization(
    DEMO_ORGANIZATION_ID,
    {
      ...reviewerTestDeps(stateKey, T0 + retryMs - 1, "backlog", send),
      notificationRetryMs: retryMs,
    },
  );
  assert.equal(sends, 1);

  await runExternalAuditAnchorReviewerAlertTickForOrganization(
    DEMO_ORGANIZATION_ID,
    {
      ...reviewerTestDeps(stateKey, T0 + retryMs, "backlog", send),
      notificationRetryMs: retryMs,
    },
  );
  status = await getExternalAuditAnchorReviewerAlertStatus(DEMO_ORGANIZATION_ID, { stateKey });
  assert.equal(sends, 2);
  assert.equal(status.notification.state, "sent");
});

test("recovery pruning never drops unresolved notification obligations during flapping", async () => {
  const stateKey = `external-audit-anchor-reviewer-alert:test:${randomUUID()}`;
  reviewerStateKeys.push(stateKey);
  const T0 = Date.parse("2026-08-13T10:00:00.000Z");
  const send = async (subject: string) => ({
    // Outage notices are acknowledged; every recovery delivery definitively
    // fails, so all recovery obligations must survive the terminal-history cap.
    status: /recovered/i.test(subject) ? "failed" : "sent",
  });

  for (let episode = 0; episode < 18; episode += 1) {
    await runExternalAuditAnchorReviewerAlertTickForOrganization(
      DEMO_ORGANIZATION_ID,
      reviewerTestDeps(stateKey, T0 + episode * 2, "backlog", send),
    );
    await runExternalAuditAnchorReviewerAlertTickForOrganization(
      DEMO_ORGANIZATION_ID,
      reviewerTestDeps(stateKey, T0 + episode * 2 + 1, "clear", send),
    );
  }
  const [row] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, stateKey),
  ));
  const persisted = JSON.parse(row!.value) as {
    recoveries: Array<{ outageNotification: { state: string }; notification: { state: string } }>;
  };
  assert.equal(persisted.recoveries.length, 18);
  assert.ok(persisted.recoveries.every((recovery) =>
    recovery.outageNotification.state === "sent" && recovery.notification.state === "failed",
  ));
});

test("an ambiguous email-provider result is retained and never blindly retried", async () => {
  const stateKey = `external-audit-anchor-reviewer-alert:test:${randomUUID()}`;
  reviewerStateKeys.push(stateKey);
  const T0 = Date.parse("2026-08-13T10:00:00.000Z");
  let sends = 0;
  const send = async () => {
    sends += 1;
    return {
      status: "sending",
      failureReason: "Delivery outcome unknown: Gmail request did not complete cleanly.",
    };
  };
  await runExternalAuditAnchorReviewerAlertTickForOrganization(
    DEMO_ORGANIZATION_ID,
    reviewerTestDeps(stateKey, T0, "backlog", send),
  );
  await runExternalAuditAnchorReviewerAlertTickForOrganization(
    DEMO_ORGANIZATION_ID,
    reviewerTestDeps(stateKey, T0 + 7_200_000, "backlog", send),
  );
  const status = await getExternalAuditAnchorReviewerAlertStatus(DEMO_ORGANIZATION_ID, { stateKey });
  assert.equal(sends, 1);
  assert.equal(status.notification.state, "ambiguous");
});

test("recovery retains a failed outage obligation, delivers it when retryable, then closes it", async () => {
  const stateKey = `external-audit-anchor-reviewer-alert:test:${randomUUID()}`;
  reviewerStateKeys.push(stateKey);
  const T0 = Date.parse("2026-08-13T10:00:00.000Z");
  const subjects: string[] = [];
  const send = async (subject: string) => {
    subjects.push(subject);
    return { status: subjects.length === 1 ? "failed" : "sent" };
  };
  const retryMs = 100;
  await runExternalAuditAnchorReviewerAlertTickForOrganization(DEMO_ORGANIZATION_ID, {
    ...reviewerTestDeps(stateKey, T0, "backlog", send), notificationRetryMs: retryMs,
  });
  // Recovery cannot discard the first alert merely because its retry window
  // has not opened yet.
  await runExternalAuditAnchorReviewerAlertTickForOrganization(DEMO_ORGANIZATION_ID, {
    ...reviewerTestDeps(stateKey, T0 + 1, "clear", send), notificationRetryMs: retryMs,
  });
  assert.equal(subjects.length, 1);
  await runExternalAuditAnchorReviewerAlertTickForOrganization(DEMO_ORGANIZATION_ID, {
    ...reviewerTestDeps(stateKey, T0 + retryMs, "clear", send), notificationRetryMs: retryMs,
  });
  await runExternalAuditAnchorReviewerAlertTickForOrganization(DEMO_ORGANIZATION_ID, {
    ...reviewerTestDeps(stateKey, T0 + retryMs + 1, "clear", send), notificationRetryMs: retryMs,
  });
  assert.equal(subjects.length, 3);
  assert.match(subjects[1]!, /review required/i);
  assert.match(subjects[2]!, /recovered/i);
});

test("stale worker claim fences an uncertain outage and recovery closes it without resend", async () => {
  const stateKey = `external-audit-anchor-reviewer-alert:test:${randomUUID()}`;
  reviewerStateKeys.push(stateKey);
  const T0 = Date.parse("2026-08-13T10:00:00.000Z");
  // Simulate termination after the durable claim and before email I/O.
  await db.insert(onbSettings).values({
    organizationId: DEMO_ORGANIZATION_ID,
    key: stateKey,
    value: JSON.stringify({
      version: 1,
      failureSince: new Date(T0).toISOString(),
      activeEpisode: {
        id: "terminated-worker-episode",
        startedAt: new Date(T0).toISOString(),
        faults: ["delivery-backlog"],
        notification: {
          state: "sending",
          claimId: "terminated-worker-claim",
          attemptedAt: new Date(T0).toISOString(),
          sentAt: null,
          retryAt: null,
        },
      },
      recoveries: [],
    }),
  });
  const subjects: string[] = [];
  const send = async (subject: string) => { subjects.push(subject); return { status: "sent" }; };
  await runExternalAuditAnchorReviewerAlertTickForOrganization(
    DEMO_ORGANIZATION_ID,
    reviewerTestDeps(stateKey, T0 + 600_001, "clear", send),
  );
  const status = await getExternalAuditAnchorReviewerAlertStatus(DEMO_ORGANIZATION_ID, { stateKey });
  assert.equal(subjects.length, 1);
  assert.match(subjects[0]!, /recovered/i);
  assert.equal(status.active, false);
  assert.equal(status.lastRecovery.notification, "sent");
});

test("operator reconciliation selects an exact opaque ambiguous attempt and fences stale or cross-tenant selections", async () => {
  const stateKey = `external-audit-anchor-reviewer-alert:test:${randomUUID()}`;
  reviewerStateKeys.push(stateKey);
  const now = new Date("2026-08-13T10:00:00.000Z").toISOString();
  const firstEpisode = randomUUID(), secondEpisode = randomUUID();
  const firstAttempt = randomUUID(), secondAttempt = randomUUID();
  const ambiguous = (attemptId: string) => ({
    state: "ambiguous", claimId: null, attemptId, attemptedAt: now, sentAt: null, retryAt: null,
  });
  const recovery = (episodeId: string, attemptId: string) => ({
    episodeId, incidentStartedAt: now, recoveredAt: now,
    outageNotification: ambiguous(attemptId),
    notification: { state: "pending", claimId: null, attemptId: null, attemptedAt: null, sentAt: null, retryAt: null },
  });
  await db.insert(onbSettings).values({
    organizationId: DEMO_ORGANIZATION_ID, key: stateKey,
    value: JSON.stringify({ version: 1, failureSince: null, activeEpisode: null, recoveries: [
      recovery(firstEpisode, firstAttempt), recovery(secondEpisode, secondAttempt),
    ] }),
  });
  const available = await getExternalAuditAnchorReviewerAmbiguousDeliveries(DEMO_ORGANIZATION_ID, { stateKey });
  assert.deepEqual(available.map(({ episodeId, attemptId }) => [episodeId, attemptId]), [
    [firstEpisode, firstAttempt], [secondEpisode, secondAttempt],
  ]);
  assert.equal(await reconcileExternalAuditAnchorReviewerAlert(DEMO_ORGANIZATION_ID, {
    episodeId: secondEpisode, attemptId: secondAttempt, kind: "outage", outcome: "delivered",
  }, { stateKey }), "applied");
  assert.equal(await reconcileExternalAuditAnchorReviewerAlert(DEMO_ORGANIZATION_ID, {
    episodeId: secondEpisode, attemptId: secondAttempt, kind: "outage", outcome: "delivered",
  }, { stateKey }), "not-found");
  assert.deepEqual(await getExternalAuditAnchorReviewerAmbiguousDeliveries(DEMO_ORGANIZATION_ID, { stateKey }), [{
    episodeId: firstEpisode, attemptId: firstAttempt, kind: "outage",
  }]);
  // The reconciliation function reads only the requested tenant's setting;
  // IDs that are not in this tenant cannot resolve even if syntactically valid.
  const otherEpisode = randomUUID(), otherAttempt = randomUUID();
  assert.equal(await reconcileExternalAuditAnchorReviewerAlert(DEMO_ORGANIZATION_ID, {
    episodeId: otherEpisode, attemptId: otherAttempt, kind: "outage", outcome: "delivered",
  }, { stateKey }), "not-found");
});

test("safe reviewer fault classification includes delivery, provider read, and receipt verification", () => {
  assert.deepEqual(externalAuditAnchorReviewerFaults({
    delivery: "backlog",
    providerRead: "failed",
    receiptVerification: "failed",
  }), [
    "delivery-backlog",
    "provider-read-failed",
    "receipt-verification-failed",
  ]);
});
