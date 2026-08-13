import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyMonitor, type MonitorTelemetry } from "./inbound-email";

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
