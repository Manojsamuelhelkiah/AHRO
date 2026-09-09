import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import {
  classifySystem,
  completeCheck,
  disconnectedCheckIsOverdue,
  escalateCheck,
  handleSystemWebhook,
} from "./system-watcher";
import { setSetting, AUTO_ESCALATION_CALLS_KEY } from "./settings";
import { DEMO_ORGANIZATION_ID, onbCommunications } from "@workspace/db/schema";
import { CONNECTOR_DEFAULTS } from "./connectors";
import { db } from "@workspace/db";
import { onbCases, onbEvents, onbSystemChecks } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  applicableSystems,
  completionAt,
  isNonEmployee,
  makeExternalRef,
  simulateVendorStatus,
  systemDef,
  WATCHED_SYSTEMS,
} from "./external-systems";

const T0 = Date.parse("2026-08-13T10:00:00Z");
const INTERVAL = 20_000;

function telemetry(overrides: Partial<Parameters<typeof classifySystem>[1]> = {}) {
  return {
    running: true,
    startedAt: new Date(T0),
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    lastEventAt: null,
    eventsReceived: 0,
    ...overrides,
  };
}

describe("classifySystem", () => {
  test("push adapter is healthy once the listener is registered", () => {
    assert.equal(
      classifySystem({ mode: "push" }, telemetry({ lastSuccessAt: new Date(T0) }), T0 + 1_000),
      "healthy",
    );
  });

  test("push adapter is stopped before the watcher starts", () => {
    assert.equal(
      classifySystem({ mode: "push" }, telemetry({ running: false, startedAt: null }), T0),
      "stopped",
    );
  });

  test("push adapter is broken after a failed delivery with no success since", () => {
    const s = telemetry({
      lastSuccessAt: new Date(T0),
      lastError: "boom",
      lastErrorAt: new Date(T0 + 5_000),
    });
    assert.equal(classifySystem({ mode: "push" }, s, T0 + 6_000), "broken");
  });

  test("poll adapter is never healthy before its first successful poll", () => {
    assert.notEqual(classifySystem({ mode: "poll" }, telemetry(), T0 + 1_000, INTERVAL), "healthy");
  });

  test("poll adapter healthy after a recent successful poll", () => {
    const s = telemetry({ lastPollAt: new Date(T0), lastSuccessAt: new Date(T0) });
    assert.equal(classifySystem({ mode: "poll" }, s, T0 + INTERVAL, INTERVAL), "healthy");
  });

  test("poll adapter broken when polls stop arriving (stalled loop)", () => {
    const s = telemetry({ lastPollAt: new Date(T0), lastSuccessAt: new Date(T0) });
    assert.equal(
      classifySystem({ mode: "poll" }, s, T0 + INTERVAL * 3 + 1, INTERVAL),
      "broken",
    );
  });

  test("poll adapter broken when the last poll failed", () => {
    const s = telemetry({
      lastSuccessAt: new Date(T0),
      lastError: "connector disconnected",
      lastErrorAt: new Date(T0 + INTERVAL),
    });
    assert.equal(classifySystem({ mode: "poll" }, s, T0 + INTERVAL + 1_000, INTERVAL), "broken");
  });
});

describe("disconnected connector deadline", () => {
  const dueAt = new Date(T0);

  test("does not escalate a disconnected check before or at its deadline", () => {
    assert.equal(disconnectedCheckIsOverdue({ dueAt }, T0 - 1), false);
    assert.equal(disconnectedCheckIsOverdue({ dueAt }, T0), false);
  });

  test("escalates a disconnected check only after its deadline", () => {
    assert.equal(disconnectedCheckIsOverdue({ dueAt }, T0 + 1), true);
  });
});

describe("simulated external systems", () => {
  test("every watched system has a definition with SLA beyond its completion window", () => {
    for (const def of WATCHED_SYSTEMS) {
      assert.ok(
        def.slaSeconds > def.completionBaseSeconds + def.completionJitterSeconds,
        `${def.key}: SLA must exceed worst-case completion so healthy runs never escalate`,
      );
    }
  });

  test("BGV is push, ITSM and payroll are polled", () => {
    assert.equal(systemDef("bgv")?.mode, "push");
    assert.equal(systemDef("itsm")?.mode, "poll");
    assert.equal(systemDef("payroll")?.mode, "poll");
  });

  test("vendor status flips from in-progress to completed at the deterministic instant", () => {
    const def = systemDef("itsm")!;
    const requestedAt = new Date(T0);
    const done = completionAt(def, requestedAt, 42).getTime();
    assert.equal(simulateVendorStatus(def, requestedAt, 42, done - 1), "in-progress");
    assert.equal(simulateVendorStatus(def, requestedAt, 42, done), "completed");
    // Deterministic: same inputs, same instant.
    assert.equal(completionAt(def, requestedAt, 42).getTime(), done);
  });

  test("different cases complete at different times (jitter)", () => {
    const def = systemDef("payroll")!;
    const requestedAt = new Date(T0);
    const times = new Set(
      [1, 2, 3, 4, 5].map((id) => completionAt(def, requestedAt, id).getTime()),
    );
    assert.ok(times.size > 1);
  });

  test("external refs are stable per case", () => {
    const def = systemDef("bgv")!;
    assert.equal(makeExternalRef(def, 7), "BGV-1007");
  });
});

describe("handleSystemWebhook push-mode enforcement", () => {
  test("rejects poll-mode systems even with a valid token path", async () => {
    for (const system of ["itsm", "payroll"]) {
      const res = await handleSystemWebhook({ system, caseId: 1, status: "completed" });
      assert.equal(res.ok, false);
      assert.match(res.message, /scheduled polling/);
    }
  });

  test("rejects unknown systems", async () => {
    const res = await handleSystemWebhook({ system: "hris", caseId: 1, status: "completed" });
    assert.equal(res.ok, false);
    assert.match(res.message, /Unknown system/);
  });
});

describe("concurrent completions (real DB)", () => {
  const created: number[] = [];
  after(async () => {
    for (const id of created) await db.delete(onbCases).where(eq(onbCases.id, id));
  });

  test("simultaneous BGV + ITSM completions both land and promote the case", async () => {
    const readiness = [
      { key: "profile", label: "Profile", status: "ready" },
      { key: "documentation", label: "Docs", status: "in-progress" },
      { key: "payroll", label: "Payroll", status: "ready" },
      { key: "access", label: "Access", status: "in-progress" },
      { key: "assets", label: "Assets", status: "ready" },
      { key: "learning", label: "Learning", status: "ready" },
      { key: "checkpoints", label: "Checkpoints", status: "ready" },
    ];
    const [c] = await db
      .insert(onbCases)
      .values({
        organizationId: DEMO_ORGANIZATION_ID,
        workerName: `Watcher Race Test ${Date.now()}`,
        workerEmail: "watcher-race@example.com",
        hireType: "new-hire",
        workerCategory: "employee",
        role: "Engineer",
        department: "R&D",
        geography: "US",
        legalEntity: "Test Co",
        managerName: "M",
        recruiterName: "R",
        joiningDate: "2026-09-01",
        lifecycleStage: "preboarding",
        readiness,
        workstreams: [],
      })
      .returning();
    created.push(c.id);

    const now = new Date();
    const due = new Date(now.getTime() + 300_000);
    const checks = await db
      .insert(onbSystemChecks)
      .values([
        { organizationId: DEMO_ORGANIZATION_ID, caseId: c.id, system: "bgv", mode: "push", externalRef: `BGV-${c.id}`, requestedAt: now, dueAt: due },
        { organizationId: DEMO_ORGANIZATION_ID, caseId: c.id, system: "itsm", mode: "poll", externalRef: `RITM-${c.id}`, requestedAt: now, dueAt: due },
      ])
      .returning();

    // Fire both completions at the same instant — a lost update would leave
    // one readiness item stuck in-progress forever (both checks are done, so
    // nothing ever revisits them).
    await Promise.all([
      completeCheck(checks[0], "webhook push"),
      completeCheck(checks[1], "scheduled poll"),
    ]);

    const [after1] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
    const byKey = Object.fromEntries(after1.readiness.map((r) => [r.key, r.status]));
    assert.equal(byKey["documentation"], "ready");
    assert.equal(byKey["access"], "ready");
    assert.equal(after1.lifecycleStage, "day1-review");

    const closed = await db
      .select()
      .from(onbSystemChecks)
      .where(eq(onbSystemChecks.caseId, c.id));
    assert.ok(closed.every((chk) => chk.status === "done"));

    const events = await db
      .select()
      .from(onbEvents)
      .where(eq(onbEvents.caseId, c.id));
    assert.ok(events.some((e) => e.title.includes("All readiness checkpoints confirmed")));
  });

  test("completeCheck is idempotent — a second completion is a no-op", async () => {
    const [c] = await db
      .insert(onbCases)
      .values({
        organizationId: DEMO_ORGANIZATION_ID,
        workerName: `Watcher Idem Test ${Date.now()}`,
        workerEmail: "watcher-idem@example.com",
        hireType: "new-hire",
        workerCategory: "employee",
        role: "Engineer",
        department: "R&D",
        geography: "US",
        legalEntity: "Test Co",
        managerName: "M",
        recruiterName: "R",
        joiningDate: "2026-09-01",
        lifecycleStage: "preboarding",
        readiness: [{ key: "access", label: "Access", status: "in-progress" }],
        workstreams: [],
      })
      .returning();
    created.push(c.id);
    const [check] = await db
      .insert(onbSystemChecks)
      .values({
        organizationId: DEMO_ORGANIZATION_ID,
        caseId: c.id,
        system: "itsm",
        mode: "poll",
        externalRef: `RITM-${c.id}`,
        requestedAt: new Date(),
        dueAt: new Date(Date.now() + 300_000),
      })
      .returning();

    await completeCheck(check, "scheduled poll");
    await completeCheck(check, "scheduled poll");

    const events = await db
      .select()
      .from(onbEvents)
      .where(eq(onbEvents.caseId, c.id));
    const completions = events.filter((e) => e.title.includes("reported complete"));
    assert.equal(completions.length, 1);
  });
});

describe("automatic escalation calls (real DB)", () => {
  const created: number[] = [];
  after(async () => {
    for (const id of created) await db.delete(onbCases).where(eq(onbCases.id, id));
    await setSetting(DEMO_ORGANIZATION_ID, AUTO_ESCALATION_CALLS_KEY, null);
  });

  async function makeCase(quietHire: boolean) {
    const [c] = await db
      .insert(onbCases)
      .values({
        organizationId: DEMO_ORGANIZATION_ID,
        workerName: `Auto Call Test ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        workerEmail: "auto-call@example.com",
        // No workerPhone: startVoiceCall bails out with "failed" before any
        // Twilio interaction, so the trigger path is exercised safely.
        hireType: "new-hire",
        workerCategory: "employee",
        role: "Engineer",
        department: "R&D",
        geography: "US",
        legalEntity: "Test Co",
        managerName: "M",
        recruiterName: "R",
        joiningDate: "2026-09-01",
        lifecycleStage: "preboarding",
        readiness: [{ key: "access", label: "Access", status: "in-progress" }],
        workstreams: [],
      })
      .returning();
    created.push(c.id);
    const requestedAt = new Date(Date.now() - 60_000);
    const [check] = await db
      .insert(onbSystemChecks)
      .values({
        organizationId: DEMO_ORGANIZATION_ID,
        caseId: c.id,
        system: "itsm",
        mode: "poll",
        externalRef: `RITM-${c.id}`,
        requestedAt,
        dueAt: new Date(Date.now() - 1_000),
      })
      .returning();
    if (!quietHire) {
      await db.insert(onbCommunications).values({
        caseId: c.id,
        organizationId: DEMO_ORGANIZATION_ID,
        channel: "email",
        direction: "inbound",
        toAddress: "onboarding@example.com",
        subject: "Re: onboarding",
        body: "On it, sorry for the delay!",
        status: "received",
      });
    }
    return { c, check };
  }

  async function eventTitles(caseId: number) {
    const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId));
    return events.map((e) => e.title);
  }

  test("setting off: escalation never triggers a call", async () => {
    await setSetting(DEMO_ORGANIZATION_ID, AUTO_ESCALATION_CALLS_KEY, null);
    const { check } = await makeCase(true);
    await escalateCheck(check, "Vendor still in progress.");
    const titles = await eventTitles(check.caseId);
    assert.ok(titles.some((t) => t.includes("SLA breached")));
    assert.ok(!titles.some((t) => t.includes("Automatic escalation call")));
  });

  test("setting on + quiet hire: call is triggered and audit-trailed", async () => {
    await setSetting(DEMO_ORGANIZATION_ID, AUTO_ESCALATION_CALLS_KEY, "on");
    const { check } = await makeCase(true);
    await escalateCheck(check, "Vendor still in progress.");
    const titles = await eventTitles(check.caseId);
    assert.ok(titles.some((t) => t === "Automatic escalation call triggered"));
    // No phone number on the case → the attempt is recorded as not placed.
    assert.ok(titles.some((t) => t === "Automatic escalation call not placed"));
  });

  test("setting on but hire replied since tracking began: no call", async () => {
    await setSetting(DEMO_ORGANIZATION_ID, AUTO_ESCALATION_CALLS_KEY, "on");
    const { check } = await makeCase(false);
    await escalateCheck(check, "Vendor still in progress.");
    const titles = await eventTitles(check.caseId);
    assert.ok(titles.some((t) => t.includes("SLA breached")));
    assert.ok(!titles.some((t) => t.includes("Automatic escalation call")));
  });

  test("already-escalated check does not re-trigger a call", async () => {
    await setSetting(DEMO_ORGANIZATION_ID, AUTO_ESCALATION_CALLS_KEY, "on");
    const { check } = await makeCase(true);
    await escalateCheck(check, "Vendor still in progress.");
    const [escalated] = await db
      .select()
      .from(onbSystemChecks)
      .where(eq(onbSystemChecks.id, check.id));
    await escalateCheck(escalated, "Vendor still in progress.");
    const titles = await eventTitles(check.caseId);
    assert.equal(titles.filter((t) => t === "Automatic escalation call triggered").length, 1);
  });
});

describe("connector seed defaults", () => {
  test("no duplicate connector keys — a dupe would abort the whole batch insert on a fresh DB", () => {
    const keys = CONNECTOR_DEFAULTS.map((d) => d.key);
    assert.equal(new Set(keys).size, keys.length, `duplicate keys in: ${keys.join(", ")}`);
  });

  test("every watched system has a seeded connector", () => {
    const keys = new Set(CONNECTOR_DEFAULTS.map((d) => d.key));
    for (const def of WATCHED_SYSTEMS) {
      assert.ok(keys.has(def.connectorKey), `missing connector for ${def.key}`);
    }
  });
});

describe("applicableSystems", () => {
  test("external employee hire gets all three systems", () => {
    const keys = applicableSystems({ hireType: "new-hire", workerCategory: "employee" }).map((d) => d.key);
    assert.deepEqual(keys.sort(), ["bgv", "itsm", "payroll"]);
  });

  test("internal transfer skips BGV", () => {
    const keys = applicableSystems({ hireType: "internal-transfer", workerCategory: "employee" }).map((d) => d.key);
    assert.deepEqual(keys.sort(), ["itsm", "payroll"]);
  });

  test("contractor skips payroll", () => {
    const keys = applicableSystems({ hireType: "new-hire", workerCategory: "contractor" }).map((d) => d.key);
    assert.deepEqual(keys.sort(), ["bgv", "itsm"]);
  });

  test("vendor skips payroll too (non-employee pathway)", () => {
    const keys = applicableSystems({ hireType: "new-hire", workerCategory: "vendor" }).map((d) => d.key);
    assert.deepEqual(keys.sort(), ["bgv", "itsm"]);
  });

  test("isNonEmployee matches the payroll exclusion for every worker category", () => {
    for (const workerCategory of ["employee", "contractor", "vendor", "intern"]) {
      const tracksPayroll = applicableSystems({ hireType: "new-hire", workerCategory })
        .some((d) => d.key === "payroll");
      assert.equal(
        tracksPayroll,
        !isNonEmployee(workerCategory),
        `${workerCategory}: payroll tracking must mirror the engine's non-employee rule`,
      );
    }
  });

  test("every readiness item the engine leaves awaiting an external system has a tracker", () => {
    // The engine leaves these readiness items in-progress at the workstream
    // stage, to be closed by the System Watcher. If any of them has no
    // corresponding tracked system, the case can never reach day-1 review.
    const profiles = [
      { hireType: "new-hire", workerCategory: "employee" },
      { hireType: "new-hire", workerCategory: "contractor" },
      { hireType: "new-hire", workerCategory: "vendor" },
      { hireType: "rehire", workerCategory: "employee" },
      { hireType: "internal-transfer", workerCategory: "employee" },
    ];
    for (const c of profiles) {
      const awaiting = new Set<string>(["access"]); // ITSM always confirms access
      if (c.hireType !== "internal-transfer") awaiting.add("documentation"); // BGV
      if (!isNonEmployee(c.workerCategory)) awaiting.add("payroll");
      const tracked = new Set(applicableSystems(c).map((d) => d.readinessKey));
      for (const key of awaiting) {
        assert.ok(
          tracked.has(key),
          `${c.hireType}/${c.workerCategory}: readiness "${key}" is left in-progress but has no tracker`,
        );
      }
    }
  });
});
