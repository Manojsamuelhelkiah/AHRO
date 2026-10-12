import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  calculateOutcomeKpis,
  type OutcomeCase,
  type OutcomeEmploymentEvidence,
  type OutcomeEvent,
  type OutcomeSurveyResponse,
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
  test("minimized historical provenance and retired controller records never enter live outcomes", () => {
    const response = calculateOutcomeKpis({
      asOf, period: "All",
      cases: [
        baseCase(1, "2025-01-01"),
        baseCase(2, "2025-01-01", { scenarioKey: null, syntheticProvenance: "onboarding-demo-fictional" }),
        baseCase(3, "2025-01-01", { scenarioKey: "standard-fte" }),
        baseCase(4, "2025-01-01", { controllerRetired: true }),
      ],
    });
    assert.equal(response.caseCount, 1);
  });
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
      surveyResponses: [{
        caseId: 1, surveyKind: "onboarding-30-day", voluntary: true, score: 10,
        submittedAt: date("2025-01-31"), actualJoinedAt: date("2025-01-01"), provenance: "human-authorized",
        humanAuthorityVerified: true,
      }],
      bgvChecks: [{
        id: 1, caseId: 1, system: "bgv", mode: "email", status: "done",
        requestedAt: date("2025-01-01"),
      }],
      bgvEmails: [{
        caseId: 1, checkId: 1, gmailMessageId: "provider-scenario",
        parsedStatus: "completed", receivedAt: date("2025-01-02"),
      }],
    });
    const result = metric(response, "cycle-time");
    assert.equal(response.caseCount, 0);
    assert.equal(result.eligibleCount, 0);
    assert.equal(result.sampleSize, 0);
    assert.equal(result.unknownCount, 0);
    assert.equal(result.value, null);
    assert.equal(metric(response, "enps").sampleSize, null);
    assert.equal(metric(response, "bgv-turnaround").eligibleCount, 0);
    assert.equal(metric(response, "bgv-turnaround").sampleSize, 0);
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
    assert.equal(metric(response, "enps").status, "insufficient-data");
    assert.equal(metric(response, "enps").sampleSize, null);
    assert.equal(metric(response, "attrition").status, "insufficient-data");
    assert.equal(metric(response, "attrition").sampleSize, null);
  });

  test("calculates eNPS only from qualifying voluntary 30-day evidence after its privacy threshold", () => {
    const cases = [1, 2, 3, 4, 5, 6].map((id) => baseCase(id, "2025-01-01"));
    const surveys: OutcomeSurveyResponse[] = [
      { caseId: 1, surveyKind: "onboarding-30-day", voluntary: true, score: 10, submittedAt: date("2025-01-31"), actualJoinedAt: date("2025-01-01"), provenance: "trusted-provider", sourceConnectorKey: "survey" },
      { caseId: 2, surveyKind: "onboarding-30-day", voluntary: true, score: 9, submittedAt: date("2025-01-31"), actualJoinedAt: date("2025-01-01"), provenance: "trusted-provider", sourceConnectorKey: "survey" },
      { caseId: 3, surveyKind: "onboarding-30-day", voluntary: true, score: 6, submittedAt: date("2025-01-31"), actualJoinedAt: date("2025-01-01"), provenance: "trusted-provider", sourceConnectorKey: "survey" },
      { caseId: 4, surveyKind: "onboarding-30-day", voluntary: true, score: 8, submittedAt: date("2025-01-31"), actualJoinedAt: date("2025-01-01"), provenance: "human-authorized", humanAuthorityVerified: true },
      { caseId: 5, surveyKind: "onboarding-30-day", voluntary: true, score: 0, submittedAt: date("2025-01-31"), actualJoinedAt: date("2025-01-01"), provenance: "human-authorized", humanAuthorityVerified: true },
      // Neither an involuntary row nor a simulated/demo-style source can
      // inflate a restricted voluntary survey metric.
      { caseId: 6, surveyKind: "onboarding-30-day", voluntary: false, score: 10, submittedAt: date("2025-01-31"), actualJoinedAt: date("2025-01-01"), provenance: "trusted-provider", sourceConnectorKey: "survey" },
      { caseId: 6, surveyKind: "onboarding-30-day", voluntary: true, score: 10, submittedAt: date("2025-01-30"), actualJoinedAt: date("2025-01-01"), provenance: "simulated", sourceConnectorKey: "survey" },
    ];
    const result = metric(calculateOutcomeKpis({
      asOf, period: "All", cases, surveyResponses: surveys,
    }), "enps");
    // 2 promoters, 2 detractors, 1 passive => 0; sample threshold is met.
    assert.equal(result.sampleSize, 5);
    assert.equal(result.unknownCount, 1);
    assert.equal(result.value, 0);
    assert.equal(result.status, "missed");
    assert.match(result.note, /minimum of 5 distinct usable responses/i);
  });

  test("does not publish eNPS when qualifying voluntary responses are below the aggregation floor", () => {
    const result = metric(calculateOutcomeKpis({
      asOf,
      period: "All",
      cases: [1, 2, 3, 4].map((id) => baseCase(id, "2025-01-01")),
      surveyResponses: [1, 2, 3, 4].map((caseId) => ({
        caseId,
        surveyKind: "onboarding-30-day",
        voluntary: true,
        score: 10,
        submittedAt: date("2025-01-31"),
        actualJoinedAt: date("2025-01-01"),
        provenance: "trusted-provider",
        sourceConnectorKey: "survey",
      })),
    }), "enps");
    assert.equal(result.sampleSize, null);
    assert.equal(result.eligibleCount, null);
    assert.equal(result.unknownCount, null);
    assert.equal(result.value, null);
    assert.equal(result.status, "insufficient-data");
  });

  test("rejects pre-join and pre-day-30 survey labels as outcome evidence", () => {
    const result = metric(calculateOutcomeKpis({
      asOf,
      period: "All",
      cases: [baseCase(1, "2025-01-01")],
      surveyResponses: [{
        caseId: 1,
        surveyKind: "onboarding-30-day",
        voluntary: true,
        score: 10,
        actualJoinedAt: date("2025-01-02"),
        submittedAt: date("2025-01-31"),
        provenance: "human-authorized",
        humanAuthorityVerified: true,
      }],
    }), "enps");
    assert.equal(result.value, null);
    assert.equal(result.sampleSize, null);
    assert.equal(result.status, "insufficient-data");
  });

  test("calculates attrition only from dated actual joining and authorized employment outcomes", () => {
    const cases = [1, 2, 3, 4, 5].map((id) => baseCase(id, "2024-10-01"));
    const employment: OutcomeEmploymentEvidence[] = [
      // Terminated in the 90-day window: attrition.
      { caseId: 1, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated", effectiveAt: date("2024-11-01"), observedAt: date("2024-11-02"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      // Active after the anniversary: retained through the measured window.
      { caseId: 2, actualJoinedAt: date("2024-10-01"), employmentStatus: "active", effectiveAt: null, observedAt: date("2025-01-01"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      // Human evidence is usable only when its authority was verified by the writer.
      { caseId: 3, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated", effectiveAt: date("2025-01-15"), observedAt: date("2025-01-16"), provenance: "human-authorized", humanAuthorityVerified: true },
      // Planned/current-looking data, early active status, and demo evidence
      // cannot become a retention assertion.
      { caseId: 4, actualJoinedAt: null, employmentStatus: "terminated", effectiveAt: date("2024-11-01"), observedAt: date("2024-11-02"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      { caseId: 5, actualJoinedAt: date("2024-10-01"), employmentStatus: "active", effectiveAt: null, observedAt: date("2024-11-01"), provenance: "simulated", sourceConnectorKey: "hris" },
    ];
    const result = metric(calculateOutcomeKpis({
      asOf, period: "All", cases, employmentEvidence: employment,
    }), "attrition");
    assert.equal(result.sampleSize, null);
    assert.equal(result.unknownCount, null);
    assert.equal(result.value, null);
    assert.equal(result.status, "insufficient-data");
  });

  test("keeps early active employment observations unknown rather than calling them retained", () => {
    const result = metric(calculateOutcomeKpis({
      asOf,
      period: "All",
      cases: [baseCase(1, "2025-01-01")],
      employmentEvidence: [{
        caseId: 1,
        actualJoinedAt: date("2025-01-01"),
        employmentStatus: "active",
        effectiveAt: null,
        observedAt: date("2025-01-30"),
        provenance: "trusted-provider",
        sourceConnectorKey: "hris",
      }],
    }), "attrition");
    assert.equal(result.sampleSize, null);
    assert.equal(result.unknownCount, null);
    assert.equal(result.value, null);
    assert.equal(result.status, "insufficient-data");
  });

  test("does not resolve conflicting actual joining anchors with a planned case date", () => {
    const result = metric(calculateOutcomeKpis({
      asOf,
      period: "All",
      cases: [baseCase(1, "2024-10-01")],
      employmentEvidence: [
        { id: 1, caseId: 1, actualJoinedAt: date("2024-10-01"), employmentStatus: "active", effectiveAt: null, observedAt: date("2025-01-01"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
        { id: 2, caseId: 1, actualJoinedAt: date("2024-10-02"), employmentStatus: "terminated", effectiveAt: date("2024-11-01"), observedAt: date("2024-11-02"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      ],
    }), "attrition");
    assert.equal(result.value, null);
    assert.equal(result.unknownCount, null);
  });

  test("treats a termination followed by unlinked active status as unknown", () => {
    const result = metric(calculateOutcomeKpis({
      asOf,
      period: "All",
      cases: [baseCase(1, "2024-10-01")],
      employmentEvidence: [
        { id: 10, caseId: 1, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated", effectiveAt: date("2024-11-01"), observedAt: date("2024-11-02"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
        { id: 11, caseId: 1, actualJoinedAt: date("2024-10-01"), employmentStatus: "active", effectiveAt: null, observedAt: date("2025-01-15"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      ],
    }), "attrition");
    assert.equal(result.value, null);
    assert.equal(result.sampleSize, null);
    assert.equal(result.status, "insufficient-data");
  });

  test("accepts an active correction only when it names the prior termination", () => {
    const cases = [1, 2, 3, 4, 5].map((id) => baseCase(id, "2024-10-01"));
    const employment = cases.flatMap((c) => [
      { id: c.id * 10, caseId: c.id, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated" as const, effectiveAt: date("2024-11-01"), observedAt: date("2024-11-02"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      { id: c.id * 10 + 1, caseId: c.id, actualJoinedAt: date("2024-10-01"), employmentStatus: "active" as const, effectiveAt: null, observedAt: date("2025-01-15"), provenance: "trusted-provider", sourceConnectorKey: "hris", correctsEvidenceId: c.id * 10 },
    ]);
    const result = metric(calculateOutcomeKpis({
      asOf, period: "All", cases, employmentEvidence: employment,
    }), "attrition");
    assert.equal(result.sampleSize, 5);
    assert.equal(result.value, 0);
    assert.equal(result.status, "met");
  });

  test("does not let an active correction of one termination hide another outstanding exit", () => {
    const cases = [1, 2, 3, 4, 5].map((id) => baseCase(id, "2024-10-01"));
    const employment = cases.flatMap((c) => [
      { id: c.id * 10, caseId: c.id, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated" as const, effectiveAt: date("2024-10-20"), observedAt: date("2024-10-21"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      { id: c.id * 10 + 1, caseId: c.id, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated" as const, effectiveAt: date("2024-11-01"), observedAt: date("2024-11-02"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      { id: c.id * 10 + 2, caseId: c.id, actualJoinedAt: date("2024-10-01"), employmentStatus: "active" as const, effectiveAt: null, observedAt: date("2025-01-15"), provenance: "trusted-provider", sourceConnectorKey: "hris", correctsEvidenceId: c.id * 10 },
    ]);
    const result = metric(calculateOutcomeKpis({
      asOf, period: "All", cases, employmentEvidence: employment,
    }), "attrition");
    assert.equal(result.value, null);
    assert.equal(result.sampleSize, null);
    assert.equal(result.status, "insufficient-data");
  });

  test("keeps early then post-90 uncorrected termination dates contradictory", () => {
    const cases = [1, 2, 3, 4, 5].map((id) => baseCase(id, "2024-10-01"));
    const employment = cases.flatMap((c) => [
      { id: c.id * 10, caseId: c.id, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated" as const, effectiveAt: date("2024-10-20"), observedAt: date("2024-10-21"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      { id: c.id * 10 + 1, caseId: c.id, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated" as const, effectiveAt: date("2025-01-15"), observedAt: date("2025-01-16"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
    ]);
    const result = metric(calculateOutcomeKpis({
      asOf, period: "All", cases, employmentEvidence: employment,
    }), "attrition");
    // Latest-row logic would falsely publish 0% here.
    assert.equal(result.value, null);
    assert.equal(result.sampleSize, null);
    assert.equal(result.status, "insufficient-data");
  });

  test("keeps post-90 then early uncorrected termination dates contradictory", () => {
    const cases = [1, 2, 3, 4, 5].map((id) => baseCase(id, "2024-10-01"));
    const employment = cases.flatMap((c) => [
      { id: c.id * 10, caseId: c.id, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated" as const, effectiveAt: date("2025-01-15"), observedAt: date("2025-01-16"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
      { id: c.id * 10 + 1, caseId: c.id, actualJoinedAt: date("2024-10-01"), employmentStatus: "terminated" as const, effectiveAt: date("2024-10-20"), observedAt: date("2024-10-21"), provenance: "trusted-provider", sourceConnectorKey: "hris" },
    ]);
    const result = metric(calculateOutcomeKpis({
      asOf, period: "All", cases, employmentEvidence: employment,
    }), "attrition");
    // Reversing row order must not turn the conflict into 100% attrition.
    assert.equal(result.value, null);
    assert.equal(result.sampleSize, null);
    assert.equal(result.status, "insufficient-data");
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
      if (item.id === "enps" || item.id === "attrition") {
        assert.equal(item.eligibleCount, null);
        assert.equal(item.unknownCount, null);
      } else {
        assert.equal(item.eligibleCount, 0);
        assert.equal(item.unknownCount, 0);
      }
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