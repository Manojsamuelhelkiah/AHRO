import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import { randomUUID } from "node:crypto";
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import {
  classifySystem,
  completeCheck,
  disconnectedCheckIsOverdue,
  escalateCheck,
  handleSystemWebhook,
  recoverOverdueSystemApprovalQueues,
  recoverChecklistRows,
  simulatedProviderCompletionsAllowed,
} from "./system-watcher";
import { setSetting, AUTO_ESCALATION_CALLS_KEY } from "./settings";
import {
  onbCommunications,
  onbConnectors,
  onbEffectJournal,
  onbGovernanceAuthorityAssignments,
  onbSensitiveLifecyclePolicies,
  onbSettings,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db/schema";
import {
  ACTIVATION_PENDING_CONNECTOR_REQUIREMENTS,
  CONNECTOR_DEFAULTS,
} from "./connectors";
import { db } from "@workspace/db";
import { onbApprovals, onbCases, onbEvents, onbSystemChecks } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import {
  applicableSystems,
  completionAt,
  isNonEmployee,
  makeExternalRef,
  simulateVendorStatus,
  systemDef,
  WATCHED_SYSTEMS,
} from "./external-systems";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";
import { MISSING_JURISDICTION_QUARANTINE_RULE } from "./sensitive-lifecycle";
import { SensitiveLifecycleConflictError } from "./sensitive-lifecycle";

const T0 = Date.parse("2026-08-13T10:00:00Z");
const INTERVAL = 20_000;
const systemWatcherOrganizationId = `system-watcher-${process.pid}-${randomUUID()}`;
const systemWatcherOwnerId = `${systemWatcherOrganizationId}-owner`;

before(async () => {
  await db.insert(organizationsTable).values({
    id: systemWatcherOrganizationId,
    name: "System watcher lifecycle fixture",
    slug: systemWatcherOrganizationId,
    joinCodeHash: `${systemWatcherOrganizationId}-join`,
    createdByUserId: systemWatcherOwnerId,
  });
  await db.insert(organizationMembershipsTable).values({
    organizationId: systemWatcherOrganizationId,
    clerkUserId: systemWatcherOwnerId,
    role: "owner",
  });
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: systemWatcherOrganizationId,
    authorityRole: "privacy",
    assigneeUserId: systemWatcherOwnerId,
    verificationStatus: "verified",
    verifiedByUserId: "test-verifier",
    verificationReference: "test-sensitive-lifecycle-fixture",
  });
  await seedApprovedSensitiveLifecyclePolicies(systemWatcherOrganizationId);
});

test("checklist recovery isolates one failed case and continues", async () => {
  const attempted: number[] = [];
  const suspended: number[] = [];
  await recoverChecklistRows(
    [{ id: 101 }, { id: 202 }, { id: 303 }],
    async (id) => {
      attempted.push(id);
      if (id === 202) throw new Error("ambiguous delivery");
    },
    async (id) => {
      suspended.push(id);
    },
  );
  assert.deepEqual(attempted, [101, 202, 303]);
  assert.deepEqual(suspended, [202]);
});

test("checklist recovery quietly quarantines a countryless lifecycle conflict", async () => {
  const [legacyCase] = await db.insert(onbCases).values({
    organizationId: systemWatcherOrganizationId,
    workerName: `Watcher Checklist Legacy ${Date.now()}`,
    workerEmail: `watcher-checklist-legacy-${Date.now()}@example.invalid`,
    hireType: "new-hire",
    workerCategory: "employee",
    role: "Engineer",
    department: "R&D",
    geography: "Unknown",
    workforceContext: {},
    legalEntity: "Test Co",
    managerName: "M",
    recruiterName: "R",
    joiningDate: "2026-09-01",
    lifecycleStage: "preboarding",
    readiness: [],
    workstreams: [],
  }).returning({ id: onbCases.id });
  try {
    let suspended = false;
    await recoverChecklistRows(
      [{ id: legacyCase!.id }],
      async () => {
        throw new SensitiveLifecycleConflictError(
          "SENSITIVE_LIFECYCLE_BLOCKED:Case-derived sensitive collection is blocked because the case jurisdiction is missing.",
        );
      },
      async () => { suspended = true; },
    );
    assert.equal(suspended, false);
    const events = await db.select({ id: onbEvents.id }).from(onbEvents).where(and(
      eq(onbEvents.organizationId, systemWatcherOrganizationId),
      eq(onbEvents.caseId, legacyCase!.id),
      eq(onbEvents.ruleRef, MISSING_JURISDICTION_QUARANTINE_RULE),
    ));
    assert.equal(events.length, 1);
  } finally {
    await db.delete(onbCases).where(eq(onbCases.id, legacyCase!.id));
  }
});

test("overdue approval recovery quarantines a countryless case once, reaches the next case, and resumes after repair", async () => {
  const now = new Date();
  const [blocked, eligible] = await db.insert(onbCases).values([
    {
      organizationId: systemWatcherOrganizationId,
      workerName: `Watcher Legacy Blocked ${Date.now()}`,
      workerEmail: `watcher-legacy-${Date.now()}@example.invalid`,
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
      readiness: [],
      workstreams: [],
    },
    {
      organizationId: systemWatcherOrganizationId,
      workerName: `Watcher Eligible ${Date.now()}`,
      workerEmail: `watcher-eligible-${Date.now()}@example.invalid`,
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Engineer",
      department: "R&D",
      geography: "US",
      workforceContext: { workCountry: "US" },
      legalEntity: "Test Co",
      managerName: "M",
      recruiterName: "R",
      joiningDate: "2026-09-01",
      lifecycleStage: "preboarding",
      readiness: [],
      workstreams: [],
    },
  ]).returning({ id: onbCases.id });
  try {
    await db.insert(onbSystemChecks).values([
      {
        organizationId: systemWatcherOrganizationId,
        caseId: blocked!.id,
        system: "itsm",
        mode: "poll",
        externalRef: `RITM-${blocked!.id}`,
        status: "overdue",
        requestedAt: now,
        dueAt: now,
      },
      {
        organizationId: systemWatcherOrganizationId,
        caseId: eligible!.id,
        system: "itsm",
        mode: "poll",
        externalRef: `RITM-${eligible!.id}`,
        status: "overdue",
        requestedAt: now,
        dueAt: now,
      },
    ]);
    await recoverOverdueSystemApprovalQueues([blocked!.id, eligible!.id]);
    await recoverOverdueSystemApprovalQueues([blocked!.id, eligible!.id]);
    const [blockedApproval] = await db.select({ id: onbApprovals.id })
      .from(onbApprovals)
      .where(eq(onbApprovals.caseId, blocked!.id));
    const [eligibleApproval] = await db.select({ id: onbApprovals.id })
      .from(onbApprovals)
      .where(eq(onbApprovals.caseId, eligible!.id));
    assert.equal(blockedApproval, undefined);
    assert.ok(eligibleApproval);
    const quarantineEvents = await db.select({ id: onbEvents.id }).from(onbEvents).where(and(
      eq(onbEvents.organizationId, systemWatcherOrganizationId),
      eq(onbEvents.caseId, blocked!.id),
      eq(onbEvents.ruleRef, MISSING_JURISDICTION_QUARANTINE_RULE),
    ));
    assert.equal(quarantineEvents.length, 1);

    await db.update(onbCases).set({
      workforceContext: { workCountry: "US" },
    }).where(eq(onbCases.id, blocked!.id));
    await recoverOverdueSystemApprovalQueues([blocked!.id]);
    const [repairedApproval] = await db.select({ id: onbApprovals.id })
      .from(onbApprovals)
      .where(eq(onbApprovals.caseId, blocked!.id));
    assert.ok(repairedApproval);
  } finally {
    await db.delete(onbCases).where(eq(onbCases.id, blocked!.id));
    await db.delete(onbCases).where(eq(onbCases.id, eligible!.id));
  }
});

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
  test("production never enables synthetic provider completions by default", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.equal(simulatedProviderCompletionsAllowed(), false);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

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
      const res = await handleSystemWebhook({ system, caseId: 1, externalRef: "test-ref", status: "completed" });
      assert.equal(res.ok, false);
      assert.match(res.message, /scheduled polling/);
    }
  });

  test("rejects unknown systems", async () => {
    const res = await handleSystemWebhook({ system: "hris", caseId: 1, externalRef: "test-ref", status: "completed" });
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
        organizationId: systemWatcherOrganizationId,
        workerName: `Watcher Race Test ${Date.now()}`,
        workerEmail: "watcher-race@example.com",
        hireType: "new-hire",
        workerCategory: "employee",
        role: "Engineer",
        department: "R&D",
        geography: "US",
        workforceContext: { workCountry: "US" },
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
        { organizationId: systemWatcherOrganizationId, caseId: c.id, system: "bgv", mode: "push", externalRef: `BGV-${c.id}`, requestedAt: now, dueAt: due },
        { organizationId: systemWatcherOrganizationId, caseId: c.id, system: "itsm", mode: "poll", externalRef: `RITM-${c.id}`, requestedAt: now, dueAt: due },
      ])
      .returning();

    // Fire both completions at the same instant — a lost update would leave
    // one readiness item stuck in-progress forever (both checks are done, so
    // nothing ever revisits them).
    await Promise.all([
      completeCheck(checks[0], "webhook push", "trusted-provider"),
      completeCheck(checks[1], "scheduled poll", "trusted-provider"),
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
        organizationId: systemWatcherOrganizationId,
        workerName: `Watcher Idem Test ${Date.now()}`,
        workerEmail: "watcher-idem@example.com",
        hireType: "new-hire",
        workerCategory: "employee",
        role: "Engineer",
        department: "R&D",
        geography: "US",
        workforceContext: { workCountry: "US" },
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
        organizationId: systemWatcherOrganizationId,
        caseId: c.id,
        system: "itsm",
        mode: "poll",
        externalRef: `RITM-${c.id}`,
        requestedAt: new Date(),
        dueAt: new Date(Date.now() + 300_000),
      })
      .returning();

    await completeCheck(check, "scheduled poll", "trusted-provider");
    await completeCheck(check, "scheduled poll", "trusted-provider");

    const events = await db
      .select()
      .from(onbEvents)
      .where(eq(onbEvents.caseId, c.id));
    const completions = events.filter((e) => e.title.includes("reported complete"));
    assert.equal(completions.length, 1);
  });

  test("simulated completion remains status telemetry and cannot promote readiness", async () => {
    const [c] = await db.insert(onbCases).values({
      organizationId: systemWatcherOrganizationId,
      workerName: `Watcher Simulated Proof Test ${Date.now()}`,
      workerEmail: `watcher-simulated-${Date.now()}@example.com`,
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Engineer",
      department: "R&D",
      geography: "US",
      workforceContext: { workCountry: "US" },
      legalEntity: "Test Co",
      managerName: "M",
      recruiterName: "R",
      joiningDate: "2026-09-01",
      lifecycleStage: "preboarding",
      readiness: [{ key: "access", label: "Access", status: "in-progress" }],
      workstreams: [],
    }).returning();
    created.push(c.id);
    const [check] = await db.insert(onbSystemChecks).values({
      organizationId: systemWatcherOrganizationId,
      caseId: c.id,
      system: "itsm",
      mode: "poll",
      externalRef: `RITM-SIM-${c.id}`,
      requestedAt: new Date(),
      dueAt: new Date(Date.now() + 300_000),
    }).returning();

    await completeCheck(check, "scheduled poll", "simulated");
    const [after] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
    assert.equal(after.readiness.find((item) => item.key === "access")?.status, "in-progress");
    assert.equal(after.lifecycleStage, "preboarding");
  });

  test("a trusted completion atomically upgrades simulated done telemetry exactly once", async () => {
    const [c] = await db.insert(onbCases).values({
      organizationId: systemWatcherOrganizationId,
      workerName: `Watcher Trusted Upgrade Test ${Date.now()}`,
      workerEmail: `watcher-trusted-upgrade-${Date.now()}@example.com`,
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Engineer",
      department: "R&D",
      geography: "US",
      workforceContext: { workCountry: "US" },
      legalEntity: "Test Co",
      managerName: "M",
      recruiterName: "R",
      joiningDate: "2026-09-01",
      lifecycleStage: "preboarding",
      readiness: [{ key: "access", label: "Access", status: "in-progress" }],
      workstreams: [],
    }).returning();
    created.push(c.id);
    const [check] = await db.insert(onbSystemChecks).values({
      organizationId: systemWatcherOrganizationId,
      caseId: c.id,
      system: "itsm",
      mode: "poll",
      externalRef: `RITM-UPGRADE-${c.id}`,
      requestedAt: new Date(),
      dueAt: new Date(Date.now() + 300_000),
    }).returning();

    await completeCheck(check, "scheduled poll", "simulated");
    await Promise.all([
      completeCheck(check, "scheduled poll", "trusted-provider"),
      completeCheck(check, "scheduled poll", "trusted-provider"),
    ]);

    const [upgraded] = await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.id, check.id));
    const [after] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
    const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, c.id));
    assert.equal(upgraded.status, "done");
    assert.equal(upgraded.evidenceProvenance, "trusted-provider");
    assert.equal(after.readiness.find((item) => item.key === "access")?.status, "ready");
    assert.equal(events.filter((event) => event.title === "ITSM Access Provisioning reported complete").length, 1);
  });
});

describe("automatic escalation calls (real DB)", () => {
  const created: number[] = [];
  after(async () => {
    for (const id of created) await db.delete(onbCases).where(eq(onbCases.id, id));
    await setSetting(systemWatcherOrganizationId, AUTO_ESCALATION_CALLS_KEY, null);
  });

  async function makeCase(quietHire: boolean) {
    const [c] = await db
      .insert(onbCases)
      .values({
        organizationId: systemWatcherOrganizationId,
        workerName: `Auto Call Test ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        workerEmail: "auto-call@example.com",
        // No workerPhone: startVoiceCall bails out with "failed" before any
        // Twilio interaction, so the trigger path is exercised safely.
        hireType: "new-hire",
        workerCategory: "employee",
        role: "Engineer",
        department: "R&D",
        geography: "US",
        workforceContext: { workCountry: "US" },
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
        organizationId: systemWatcherOrganizationId,
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
          organizationId: systemWatcherOrganizationId,
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
    await setSetting(systemWatcherOrganizationId, AUTO_ESCALATION_CALLS_KEY, null);
    const { check } = await makeCase(true);
    await escalateCheck(check, "Vendor still in progress.");
    const titles = await eventTitles(check.caseId);
    assert.ok(titles.some((t) => t.includes("SLA breached")));
    assert.ok(!titles.some((t) => t.includes("Automatic escalation call")));
  });

  test("setting on + quiet hire: call is triggered and audit-trailed", async () => {
    await setSetting(systemWatcherOrganizationId, AUTO_ESCALATION_CALLS_KEY, "on");
    const { check } = await makeCase(true);
    await escalateCheck(check, "Vendor still in progress.");
    const titles = await eventTitles(check.caseId);
    assert.ok(titles.some((t) => t === "Automatic escalation call triggered"));
    // No phone number on the case → the attempt is recorded as not placed.
    assert.ok(titles.some((t) => t === "Automatic escalation call not placed"));
  });

  test("setting on but hire replied since tracking began: no call", async () => {
    await setSetting(systemWatcherOrganizationId, AUTO_ESCALATION_CALLS_KEY, "on");
    const { check } = await makeCase(false);
    await escalateCheck(check, "Vendor still in progress.");
    const titles = await eventTitles(check.caseId);
    assert.ok(titles.some((t) => t.includes("SLA breached")));
    assert.ok(!titles.some((t) => t.includes("Automatic escalation call")));
  });

  test("already-escalated check does not re-trigger a call", async () => {
    await setSetting(systemWatcherOrganizationId, AUTO_ESCALATION_CALLS_KEY, "on");
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

  test("registers LMS and calendar activation requirements without claiming a fake integration", () => {
    for (const key of ["lms", "calendar"] as const) {
      const connector = CONNECTOR_DEFAULTS.find((item) => item.key === key);
      assert.ok(connector);
      assert.equal(connector.status, "activation-pending");
      assert.equal(connector.vendor, "Not activated");
      assert.deepEqual(connector.availableVendors, []);
      assert.ok(ACTIVATION_PENDING_CONNECTOR_REQUIREMENTS[key].length >= 4);
      assert.match(connector.description, /No provider adapter.*simulated completion/i);
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

after(async () => {
  await db.delete(onbEffectJournal).where(
    eq(onbEffectJournal.organizationId, systemWatcherOrganizationId),
  );
  await db.delete(onbCases).where(eq(onbCases.organizationId, systemWatcherOrganizationId));
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, systemWatcherOrganizationId));
  await db.delete(onbSensitiveLifecyclePolicies).where(
    eq(onbSensitiveLifecyclePolicies.organizationId, systemWatcherOrganizationId),
  );
  await db.delete(onbGovernanceAuthorityAssignments).where(
    eq(onbGovernanceAuthorityAssignments.organizationId, systemWatcherOrganizationId),
  );
  await db.delete(onbConnectors).where(
    eq(onbConnectors.organizationId, systemWatcherOrganizationId),
  );
  await deleteTestOrganizations(eq(organizationsTable.id, systemWatcherOrganizationId));
});
