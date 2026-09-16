import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { candidateReplyReferences, classifyMonitor, createOutageTracker, planMonitorEventWrite, processMessageRefs, resolveUniqueEmailCase, resolveHrAlertAddress, composeMonitorAlertEmail, persistThenNotify, MONITOR_DOWN_TITLE, MONITOR_RECOVERED_TITLE, type MonitorTelemetry, type InboundMessage } from "./inbound-email";
import type { SimulationEmailRoute } from "./case-simulation";

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

describe("HR alert email configuration & composition", () => {
  test("no address configured => null (no email sent)", () => {
    assert.equal(resolveHrAlertAddress(null, {}), null);
    assert.equal(resolveHrAlertAddress("   ", { HR_ALERT_EMAIL: "   " }), null);
  });

  test("HR_ALERT_EMAIL wins, ONBOARDING_HR_ALERT_EMAIL is the fallback", () => {
    assert.equal(resolveHrAlertAddress(null, { HR_ALERT_EMAIL: "hr@corp.com" }), "hr@corp.com");
    assert.equal(
      resolveHrAlertAddress(null, { ONBOARDING_HR_ALERT_EMAIL: "ops@corp.com" }),
      "ops@corp.com",
    );
    assert.equal(
      resolveHrAlertAddress(null, { HR_ALERT_EMAIL: "hr@corp.com", ONBOARDING_HR_ALERT_EMAIL: "ops@corp.com" }),
      "hr@corp.com",
    );
  });

  test("stored settings value beats both env vars", () => {
    assert.equal(
      resolveHrAlertAddress("settings@corp.com", {
        HR_ALERT_EMAIL: "hr@corp.com",
        ONBOARDING_HR_ALERT_EMAIL: "ops@corp.com",
      }),
      "settings@corp.com",
    );
    // Whitespace-only stored value is ignored (env fallback applies).
    assert.equal(
      resolveHrAlertAddress("  ", { HR_ALERT_EMAIL: "hr@corp.com" }),
      "hr@corp.com",
    );
  });

  test("down email carries the outage detail and a clear subject", () => {
    const { subject, body } = composeMonitorAlertEmail("down", "failed 3 polls in a row");
    assert.match(subject, /DOWN/);
    assert.match(body, /failed 3 polls in a row/);
    assert.match(body, /NOT being picked up/);
  });

  test("recovery email carries the recovery detail", () => {
    const { subject, body } = composeMonitorAlertEmail("recovered", "polling successfully again");
    assert.match(subject, /recovered/);
    assert.match(body, /polling successfully again/);
  });
});

describe("persistThenNotify (email only after a confirmed durable write)", () => {
  test("sends the alert email after the event write succeeds", async () => {
    const sent: string[] = [];
    const result = await persistThenNotify("down", MONITOR_DOWN_TITLE, "3 failed polls", {
      persistEvent: async () => true,
      sendAlert: async (kind) => void sent.push(kind),
    });
    assert.deepEqual(result, { persisted: true, emailed: true });
    assert.deepEqual(sent, ["down"]);
  });

  test("failed event write suppresses the email (prevents restart duplicates)", async () => {
    const sent: string[] = [];
    const result = await persistThenNotify("down", MONITOR_DOWN_TITLE, "3 failed polls", {
      persistEvent: async () => false,
      sendAlert: async (kind) => void sent.push(kind),
    });
    assert.deepEqual(result, { persisted: false, emailed: false });
    assert.deepEqual(sent, []);
  });

  test("restart mid-outage: persisted down event blocks a second down write, hence a second email", () => {
    // The email is only attempted when planMonitorEventWrite returns a write;
    // after a restart mid-outage the persisted down event yields null.
    assert.equal(planMonitorEventWrite("alert", MONITOR_DOWN_TITLE), null);
  });

  test("recovery email follows the recovery write", async () => {
    const sent: string[] = [];
    await persistThenNotify("recovered", MONITOR_RECOVERED_TITLE, "polling again", {
      persistEvent: async () => true,
      sendAlert: async (kind) => void sent.push(kind),
    });
    assert.deepEqual(sent, ["recovered"]);
  });
});

describe("processMessageRefs (detail-fetch failures fail the poll)", () => {
  const caseByEmail = new Map([
    ["hire@example.com", [{ caseId: 7, organizationId: "org-a" }]],
  ]);
  const replyRef = "CR-0123456789abcdef0123456789abcdef";
  const caseByReplyReference = new Map([
    [replyRef, [{ caseId: 7, organizationId: "org-a" }]],
  ]);
  const detailOf = (id: string) => ({
    id,
    payload: {
      headers: [
        { name: "From", value: "Hire <hire@example.com>" },
        { name: "Subject", value: "Re: welcome" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from(`thanks!\n\n> [Reply reference: ${replyRef}]`).toString("base64url") },
    },
  });

  test("counts every failed detail fetch instead of silently skipping", async () => {
    const recorded: InboundMessage[] = [];
    const failures = await processMessageRefs(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      caseByEmail,
      caseByReplyReference,
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
      caseByReplyReference,
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

  test("already-recorded messages are skipped after deriving the matching organization", async () => {
    let fetched = 0;
    const failures = await processMessageRefs([{ id: "dup" }], caseByEmail, caseByReplyReference, {
      fetchDetail: async () => (fetched++, { ok: true, json: async () => detailOf("dup") }),
      alreadyRecorded: async (_id, organizationId) => organizationId === "org-a",
      recordInbound: async () => true,
    });
    assert.equal(failures, 0);
    // Message detail must be fetched first to derive the sender's tenant.
    assert.equal(fetched, 1);
  });
});

describe("tenant-safe candidate resolution", () => {
  test("quarantines an email identity shared by two organizations", () => {
    assert.equal(resolveUniqueEmailCase([
      { caseId: 7, organizationId: "org-a" },
      { caseId: 8, organizationId: "org-b" },
    ]), undefined);
  });

  test("approval mail cannot route to another tenant where the approver is a candidate", async () => {
    const ref = "CR-fedcba9876543210fedcba9876543210";
    const recorded: InboundMessage[] = [];
    const detail = {
      id: "shared-gmail-id",
      payload: {
        headers: [
          { name: "From", value: "Approver <shared@example.com>" },
          { name: "Subject", value: "Re: [AP-42] Approval needed" },
        ],
        mimeType: "text/plain",
        body: {
          data: Buffer.from(`Approve\n> [Reply reference: ${ref}]`).toString("base64url"),
        },
      },
    };
    await processMessageRefs(
      [{ id: detail.id }],
      new Map([["shared@example.com", [{ caseId: 1, organizationId: "org-a" }]]]),
      new Map([[ref, [{ caseId: 1, organizationId: "org-a" }]]]),
      {
        fetchDetail: async () => ({ ok: true, json: async () => detail }),
        alreadyRecorded: async () => false,
        recordInbound: async (message) => (recorded.push(message), true),
      },
    );
    assert.deepEqual(recorded, []);
  });

  test("requires an exact case-bound reply reference, not sender identity alone", async () => {
    assert.deepEqual(
      candidateReplyReferences("CR-0123456789abcdef0123456789abcdef0"),
      [],
    );
  });

  test("rejects a fabricated well-formed reference even from the expected sender", async () => {
    const fabricatedReference = "CR-11111111111111111111111111111111";
    const persistedReference = "CR-22222222222222222222222222222222";
    const recorded: InboundMessage[] = [];
    const detail = {
      id: "fabricated-reference",
      payload: {
        headers: [
          { name: "From", value: "Candidate <candidate@example.com>" },
          { name: "Subject", value: "Re: Welcome" },
        ],
        mimeType: "text/plain",
        body: {
          data: Buffer.from(`Here are my details.\n> [Reply reference: ${fabricatedReference}]`).toString("base64url"),
        },
      },
    };
    await processMessageRefs(
      [{ id: detail.id }],
      new Map([["candidate@example.com", [{ caseId: 7, organizationId: "org-a" }]]]),
      new Map([[persistedReference, [{ caseId: 7, organizationId: "org-a" }]]]),
      {
        fetchDetail: async () => ({ ok: true, json: async () => detail }),
        alreadyRecorded: async () => false,
        recordInbound: async (message) => (recorded.push(message), true),
      },
    );
    assert.deepEqual(recorded, []);
  });
});

describe("controlled simulation email correlation", () => {
  const route: SimulationEmailRoute = {
    caseId: 77,
    organizationId: "demo-org",
    requestId: "simulation-request",
    generationId: "generation-1",
    version: 0,
    token: "a".repeat(48),
    threadMarker: "thread-1",
    subject: "[DEMO SIMULATION][SIM-THREAD:thread-1] offer package",
    body: "[SIMULATED EMPLOYEE PROMPT] Please confirm.\n[SIM-THREAD:thread-1] [SIM-REPLY-TOKEN:" + "a".repeat(48) + "]",
    recipient: "volunteer@example.com",
    status: "sent",
    providerMessageId: "outbound-gmail-id",
  };

  function detail(
    id: string,
    overrides: { from?: string; token?: string; threadMarker?: string; subject?: string } = {},
  ) {
    const token = overrides.token ?? route.token;
    const threadMarker = overrides.threadMarker ?? route.threadMarker;
    return {
      id,
      payload: {
        headers: [
          { name: "From", value: `Volunteer <${overrides.from ?? route.recipient}>` },
          { name: "Subject", value: overrides.subject ?? `[DEMO SIMULATION][SIM-THREAD:${threadMarker}] Re: offer package` },
        ],
        mimeType: "text/plain",
        body: {
          data: Buffer.from(
            `I completed it.\n\n[SIM-THREAD:${threadMarker}] [SIM-REPLY-TOKEN:${token}]`,
          ).toString("base64url"),
        },
      },
    };
  }

  function run(
    refs: Array<{ id: string }>,
    details: Record<string, ReturnType<typeof detail>>,
    opts: {
      recorded?: Set<string>;
      outboundProviderIds?: ReadonlySet<string>;
    } = {},
  ) {
    const recorded = opts.recorded ?? new Set<string>();
    const accepted: Array<Record<string, unknown>> = [];
    return processMessageRefs(
      refs,
      new Map(),
      new Map(),
      {
        fetchDetail: async (id) => ({ ok: true, json: async () => details[id] }),
        alreadyRecorded: async (id) => recorded.has(id),
        recordInbound: async () => false,
        recordSimulationInbound: async (message) => {
          accepted.push(message);
          recorded.add(message.externalMessageId);
          return "recorded";
        },
        outboundProviderIds: opts.outboundProviderIds,
      },
      new Map([[route.token, [route]]]),
    ).then((failures) => ({ failures, accepted, recorded }));
  }

  test("accepts only the exact pinned sender with both token and thread markers", async () => {
    const result = await run([{ id: "accepted" }], { accepted: detail("accepted") });
    assert.equal(result.failures, 0);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0]?.caseId, route.caseId);
    assert.equal(result.accepted[0]?.fromAddress, route.recipient);
  });

  test("ignores wrong sender, token, and thread marker", async () => {
    const result = await run(
      [{ id: "wrong-sender" }, { id: "wrong-token" }, { id: "wrong-thread" }],
      {
        "wrong-sender": detail("wrong-sender", { from: "spoof@example.com" }),
        "wrong-token": detail("wrong-token", { token: "b".repeat(48) }),
        "wrong-thread": detail("wrong-thread", { threadMarker: "thread-2" }),
      },
    );
    assert.equal(result.accepted.length, 0);
  });

  test("skips an outbound provider message id echo", async () => {
    const result = await run(
      [{ id: route.providerMessageId! }],
      { [route.providerMessageId!]: detail(route.providerMessageId!) },
      { outboundProviderIds: new Set([route.providerMessageId!]) },
    );
    assert.equal(result.accepted.length, 0);
  });

  test("provider message id dedup makes duplicate delivery idempotent", async () => {
    const recorded = new Set<string>();
    const first = await run([{ id: "reply-1" }], { "reply-1": detail("reply-1") }, { recorded });
    const second = await run([{ id: "reply-1" }], { "reply-1": detail("reply-1") }, { recorded });
    assert.equal(first.accepted.length, 1);
    assert.equal(second.accepted.length, 0);
  });
});
