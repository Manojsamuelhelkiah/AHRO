import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  calculateOutcomeKpis,
  type OutcomeCase,
  type OutcomeEvent,
} from "./outcome-kpis";

const asOf = new Date("2025-01-31T00:00:00.000Z");
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

function metric(response: ReturnType<typeof calculateOutcomeKpis>, id: string) {
  const result = response.metrics.find((item) => item.id === id);
  assert.ok(result, `expected metric ${id}`);
  return result;
}

function baseCase(
  id: number,
  createdAt: string,
  overrides: Partial<OutcomeCase> = {},
): OutcomeCase {
  return {
    id,
    createdAt: date(createdAt),
    geography: "US",
    hireType: "external-fte",
    scenarioKey: null,
    lifecycleStage: "complete",
    gateCApprovalStatus: "approved",
    offerAcceptanceComplete: true,
    offerAcceptanceCompletedAt: date(createdAt),
    ...overrides,
  };
}

describe("onboarding outcome KPI calculations", () => {
  test("uses inclusive case-created boundaries, filters region and hire type, and excludes future cases", () => {
    const response = calculateOutcomeKpis({
      asOf,
      period: "30",
      region: "US",
      cases: [
        baseCase(1, "2025-01-01"),
        baseCase(2, "2024-12-31"),
        baseCase(3, "2025-01-15", { geography: "GB" }),
        baseCase(4, "2025-01-15", { hireType: "contractor" }),
        baseCase(5, "2025-02-01"),
      ],
    });
    assert.equal(response.caseCount, 2);
    assert.match(response.cohortLabel, /created in-period/);
    assert.match(response.cohortLabel, /not a joining-date cohort/);
    assert.equal(metric(response, "cycle-time").eligibleCount, 1);
  });

  test("preserves a valid zero-day result and reports missing evidence separately", () => {
    const cases = [
      baseCase(1, "2025-01-01"),
      baseCase(2, "2025-01-02", {
        offerAcceptanceCompletedAt: null,
      }),
    ];
    const events: OutcomeEvent[] = [
      {
        caseId: 1,
        agent: "day1-readiness-gate",
        title: "Gate C Day-1 readiness confirmed by HR",
        createdAt: date("2025-01-01"),
      },
    ];
    const result = metric(
      calculateOutcomeKpis({ asOf, period: "30", cases, events }),
      "cycle-time",
    );
    assert.equal(result.value, 0);
    assert.equal(result.status, "met");
    assert.equal(result.sampleSize, 1);
    assert.equal(result.eligibleCount, 2);
    assert.equal(result.unknownCount, 1);
  });

  test("evaluates target status from the raw mean before display rounding", () => {
    const response = calculateOutcomeKpis({
      asOf,
      period: "30",
      cases: [baseCase(1, "2025-01-01")],
      events: [
        {
          caseId: 1,
          agent: "day1-readiness-gate",
          title: "Gate C Day-1 readiness confirmed by HR",
          createdAt: new Date(date("2025-01-08").getTime() + 345_600),
        },
      ],
    });
    const result = metric(response, "cycle-time");
    assert.equal(result.value, 7);
    assert.equal(result.status, "missed");
  });

  test("uses elapsed date arithmetic, and excludes completion invalidated by a reopen", () => {
    const cases = [
      baseCase(1, "2025-01-01"),
      baseCase(2, "2025-01-02"),
    ];
    const events: OutcomeEvent[] = [
      {
        caseId: 1,
        agent: "day1-readiness-gate",
        title: "Gate C Day-1 readiness confirmed by HR",
        createdAt: date("2025-01-03"),
      },
      {
        caseId: 1,
        agent: "day1-readiness-gate",
        title: "Gate C approval invalidated by changed live readiness evidence",
        createdAt: date("2025-01-04"),
      },
      {
        caseId: 2,
        agent: "day1-readiness-gate",
        title: "Gate C Day-1 readiness confirmed by HR",
        createdAt: date("2025-01-05"),
      },
    ];
    const result = metric(
      calculateOutcomeKpis({ asOf, period: "30", cases, events }),
      "cycle-time",
    );
    assert.equal(result.value, 3);
    assert.equal(result.sampleSize, 1);
    assert.equal(result.unknownCount, 1);
  });

  test("excludes explicitly simulated scenario cases from measurement without hiding them from eligibility", () => {
    const response = calculateOutcomeKpis({
      asOf,
      period: "30",
      cases: [
        baseCase(1, "2025-01-01", { scenarioKey: "worked-example" }),
      ],
      events: [
        {
          caseId: 1,
          agent: "day1-readiness-gate",
          title: "Gate C Day-1 readiness confirmed by HR",
          createdAt: date("2025-01-02"),
        },
      ],
    });
    const result = metric(response, "cycle-time");
    assert.equal(response.caseCount, 1);
    assert.equal(result.eligibleCount, 1);
    assert.equal(result.sampleSize, 0);
    assert.equal(result.unknownCount, 1);
    assert.equal(result.value, null);
  });

  test("requires current final Gate C approval and complete lifecycle after evidence changes", () => {
    const response = calculateOutcomeKpis({
      asOf,
      period: "30",
      cases: [
        baseCase(1, "2025-01-01", {
          lifecycleStage: "preboarding",
          gateCApprovalStatus: "pending",
        }),
      ],
      events: [
        {
          caseId: 1,
          agent: "day1-readiness-gate",
          title: "Gate C Day-1 readiness confirmed by HR",
          createdAt: date("2025-01-02"),
        },
      ],
    });
    const result = metric(response, "cycle-time");
    assert.equal(result.sampleSize, 0);
    assert.equal(result.unknownCount, 1);
    assert.match(result.note, /current final approval/);
  });

  test("does not count current readiness, intake checkboxes, simulation, or unavailable sources", () => {
    const cases = [baseCase(1, "2025-01-01")];
    const response = calculateOutcomeKpis({
      asOf,
      period: "30",
      cases,
      bgvChecks: [
        {
          id: 10,
          caseId: 1,
          system: "bgv",
          mode: "email",
          status: "done",
          requestedAt: date("2025-01-01"),
          completedAt: date("2025-01-02"),
        },
      ],
      bgvEmails: [
        {
          caseId: 1,
          checkId: 10,
          gmailMessageId: "simulated-10-1",
          parsedStatus: "completed",
          receivedAt: date("2025-01-02"),
        },
      ],
    });
    assert.equal(metric(response, "bgv-turnaround").value, null);
    assert.equal(metric(response, "bgv-turnaround").status, "insufficient-data");
    assert.equal(metric(response, "day1-readiness").status, "not-collected");
    assert.equal(metric(response, "doc-completeness").status, "not-collected");
    assert.equal(metric(response, "provisioning-on-time").status, "not-collected");
    assert.equal(metric(response, "enps").status, "not-collected");
    assert.equal(metric(response, "attrition").status, "not-collected");
  });

  test("measures only a verifiable non-simulated email BGV result", () => {
    const response = calculateOutcomeKpis({
      asOf,
      period: "All",
      cases: [baseCase(1, "2025-01-01")],
      bgvChecks: [
        {
          id: 10,
          caseId: 1,
          system: "bgv",
          mode: "email",
          status: "done",
          requestedAt: date("2025-01-01"),
          completedAt: date("2025-01-05"),
        },
      ],
      bgvEmails: [
        {
          caseId: 1,
          checkId: 10,
          gmailMessageId: "provider-message-10",
          parsedStatus: "completed",
          receivedAt: date("2025-01-05"),
        },
      ],
    });
    const result = metric(response, "bgv-turnaround");
    assert.equal(result.value, 4);
    assert.equal(result.status, "met");
    assert.equal(result.sampleSize, 1);
    assert.equal(result.unknownCount, 0);
  });

  test("returns an empty eligible cohort for an unsupported domain", () => {
    const response = calculateOutcomeKpis({
      asOf,
      period: "30",
      domain: "Payroll",
      cases: [baseCase(1, "2025-01-01")],
    });
    assert.equal(response.caseCount, 0);
    assert.match(response.cohortLabel, /Unsupported domain/);
    for (const item of response.metrics) {
      assert.equal(item.eligibleCount, 0);
      assert.equal(item.unknownCount, 0);
    }
  });

  test("publishes the exact seven KPI targets and leaves baselines TBD", () => {
    const response = calculateOutcomeKpis({
      asOf,
      period: "30",
      cases: [],
    });
    assert.deepEqual(
      response.metrics.map((item) => [
        item.label,
        item.definition,
        item.targetLabel,
        item.targetValue,
        item.direction,
        item.unit,
        item.baseline,
      ]),
      [
        ["Onboarding Cycle Time", "Days from offer acceptance to Day-1 readiness", "≤ 7 days", 7, "at-most", "days", "TBD"],
        ["Day-1 Readiness Rate", "% of joiners fully ready on Day-1", "≥ 98%", 98, "at-least", "percent", "TBD"],
        ["Document Completeness at Intake", "% of packages complete at first submission", "≥ 90%", 90, "at-least", "percent", "TBD"],
        ["BGV Turnaround", "Days from initiation to result", "≤ 5 days", 5, "at-most", "days", "TBD"],
        ["Provisioning On-Time Rate", "% of IT/asset requests ready by J-2", "≥ 95%", 95, "at-least", "percent", "TBD"],
        ["New-Hire Experience (eNPS)", "30-day onboarding experience score", "≥ +40", 40, "at-least", "score", "TBD"],
        ["0–90 Day Attrition", "% of new hires exiting within 90 days", "≤ 3%", 3, "at-most", "percent", "TBD"],
      ],
    );
  });
});