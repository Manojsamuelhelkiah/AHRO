import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyMonitor, createOutageTracker, planMonitorEventWrite, processMessageRefs, MONITOR_DOWN_TITLE, MONITOR_RECOVERED_TITLE, type MonitorTelemetry, type InboundMessage } from "./inbound-email";

const INTERVAL = 60_000;
const T0 = Date.parse("2026-08-13T10:00:00Z");

function telemetry(overrides: Partial<MonitorTelemetry> = {}): MonitorTelemetry {
  return {
    running: true,
    startedAt: new Date(T0),
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    ...overrides,
  };
}

describe("classifyMonitor", () => {
  test("stopped when the loop was never started", () => {
    assert.equal(
      classifyMonitor(telemetry({ running: false, startedAt: null }), T0, INTERVAL),
      "stopped",
    );
  });

  test("initializing right after start, before any poll completes", () => {
    assert.equal(classifyMonitor(telemetry(), T0 + 5_000, INTERVAL), "initializing");
  });

  test("never healthy without a successful poll", () => {
    // Even well within the staleness window, no success => not healthy.
    const state = classifyMonitor(telemetry(), T0 + 1_000, INTERVAL);
    assert.notEqual(state, "healthy");
  });

  test("broken when the first poll hangs past the staleness window", () => {
    const s = telemetry({ lastPollAt: new Date(T0) });
    assert.equal(classifyMonitor(s, T0 + INTERVAL * 3 + 1, INTERVAL), "broken");
  });

  test("healthy after a recent successful poll", () => {
    const s = telemetry({
      lastPollAt: new Date(T0 + 60_000),
      lastSuccessAt: new Date(T0 + 60_000),
    });
    assert.equal(classifyMonitor(s, T0 + 90_000, INTERVAL), "healthy");
  });

  test("broken when the most recent completed poll failed", () => {
    const s = telemetry({
      lastSuccessAt: new Date(T0 + 60_000),
      lastError: "Gmail search failed: 401",
      lastErrorAt: new Date(T0 + 120_000),
    });
    assert.equal(classifyMonitor(s, T0 + 125_000, INTERVAL), "broken");
  });

  test("recovers to healthy when a success follows an error", () => {
    const s = telemetry({
      lastError: null,
      lastErrorAt: new Date(T0 + 60_000),
      lastSuccessAt: new Date(T0 + 120_000),
    });
    assert.equal(classifyMonitor(s, T0 + 125_000, INTERVAL), "healthy");
  });

  test("broken when successes stop arriving (stalled loop)", () => {
    const s = telemetry({ lastSuccessAt: new Date(T0 + 60_000) });
    assert.equal(
      classifyMonitor(s, T0 + 60_000 + INTERVAL * 3 + 1, INTERVAL),
      "broken",
    );
  });
});

describe("createOutageTracker", () => {

  test("no alert before the failure threshold", () => {
    const t = createOutageTracker(3);
    assert.equal(t.recordFailure().decision, "none");
    assert.equal(t.recordFailure().decision, "none");
  });

  test("exactly one alert per outage, at the threshold", () => {
    const t = createOutageTracker(3);
    t.recordFailure();
    t.recordFailure();
    const third = t.recordFailure();
    assert.equal(third.decision, "alert");
    assert.equal(third.consecutiveFailures, 3);
    // Outage continues: no duplicate alerts.
    assert.equal(t.recordFailure().decision, "none");
    assert.equal(t.recordFailure().decision, "none");
  });

  test("recovery emits exactly one recover event, only after an alert", () => {
    const t = createOutageTracker(3);
    // Success without prior alert: nothing.
    assert.equal(t.recordSuccess(), "none");
    t.recordFailure();
    t.recordFailure();
    t.recordFailure();
    assert.equal(t.recordSuccess(), "recover");
    assert.equal(t.recordSuccess(), "none");
  });

  test("success resets the failure count before the threshold", () => {
    const t = createOutageTracker(3);
    t.recordFailure();
    t.recordFailure();
    t.recordSuccess();
    assert.equal(t.recordFailure().decision, "none");
    assert.equal(t.recordFailure().decision, "none");
    assert.equal(t.recordFailure().decision, "alert");
  });

  test("a new outage after recovery alerts again", () => {
    const t = createOutageTracker(2);
    t.recordFailure();
    assert.equal(t.recordFailure().decision, "alert");
    assert.equal(t.recordSuccess(), "recover");
    t.recordFailure();
    assert.equal(t.recordFailure().decision, "alert");
  });
});

describe("planMonitorEventWrite (durable dedup across restarts)", () => {
  test("first alert of an outage writes a down event", () => {
    assert.equal(planMonitorEventWrite("alert", null), "down");
    assert.equal(planMonitorEventWrite("alert", MONITOR_RECOVERED_TITLE), "down");
  });

  test("restart mid-outage: alert decision is deduplicated against the persisted down event", () => {
    assert.equal(planMonitorEventWrite("alert", MONITOR_DOWN_TITLE), null);
  });

  test("recovery writes exactly when a down event is the latest persisted state", () => {
    assert.equal(planMonitorEventWrite("recover", MONITOR_DOWN_TITLE), "recovered");
    assert.equal(planMonitorEventWrite("recover", MONITOR_RECOVERED_TITLE), null);
    assert.equal(planMonitorEventWrite("recover", null), null);
  });

  test("restart during outage + first success records the pending recovery", () => {
    assert.equal(planMonitorEventWrite("startup-success", MONITOR_DOWN_TITLE), "recovered");
    assert.equal(planMonitorEventWrite("startup-success", MONITOR_RECOVERED_TITLE), null);
  });

  test("no writes when nothing happened", () => {
    assert.equal(planMonitorEventWrite("none", null), null);
    assert.equal(planMonitorEventWrite("none", MONITOR_DOWN_TITLE), null);
  });
});

describe("processMessageRefs (detail-fetch failures fail the poll)", () => {
  const caseByEmail = new Map([["hire@example.com", 7]]);
  const detailOf = (id: string) => ({
    id,
    payload: {
      headers: [
        { name: "From", value: "Hire <hire@example.com>" },
        { name: "Subject", value: "Re: welcome" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from("thanks!").toString("base64url") },
    },
  });

  test("counts every failed detail fetch instead of silently skipping", async () => {
    const recorded: InboundMessage[] = [];
    const failures = await processMessageRefs(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      caseByEmail,
      {
        fetchDetail: async () => ({ ok: false, json: async () => ({}) }),
        alreadyRecorded: async () => false,
        recordInbound: async (m) => (recorded.push(m), true),
      },
    );
    assert.equal(failures, 3);
    assert.equal(recorded.length, 0);
  });

  test("mixed page: successes are recorded, failures still counted", async () => {
    const recorded: InboundMessage[] = [];
    const failures = await processMessageRefs(
      [{ id: "ok1" }, { id: "bad" }, { id: "ok2" }],
      caseByEmail,
      {
        fetchDetail: async (id) =>
          id === "bad"
            ? { ok: false, json: async () => ({}) }
            : { ok: true, json: async () => detailOf(id) },
        alreadyRecorded: async () => false,
        recordInbound: async (m) => (recorded.push(m), true),
      },
    );
    assert.equal(failures, 1);
    assert.deepEqual(recorded.map((m) => m.externalMessageId), ["ok1", "ok2"]);
    assert.equal(recorded[0].caseId, 7);
  });

  test("already-recorded messages are skipped without fetching", async () => {
    let fetched = 0;
    const failures = await processMessageRefs([{ id: "dup" }], caseByEmail, {
      fetchDetail: async () => (fetched++, { ok: true, json: async () => detailOf("dup") }),
      alreadyRecorded: async () => true,
      recordInbound: async () => true,
    });
    assert.equal(failures, 0);
    assert.equal(fetched, 0);
  });
});
