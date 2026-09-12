import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  OUTCOME_ANALYTICS_INTEGRATION_STATE,
  privacyScopedOutcomeExport,
  privacyScopedOutcomeExportCsv,
} from "./outcome-reporting";
import type { OutcomeKpiResponse } from "./outcome-kpis";

const report: OutcomeKpiResponse = {
  asOf: "2025-01-31T00:00:00.000Z",
  cohortLabel: "A safe aggregate",
  caseCount: 6,
  metrics: [
    {
      id: "enps", label: "=eNPS", definition: "Experience", baseline: "TBD",
      targetLabel: ">= 40", targetValue: 40, direction: "at-least", unit: "score",
      value: 50, status: "met", sampleSize: 4, eligibleCount: 6, unknownCount: 2,
      note: "Never exported.",
    },
    {
      id: "attrition", label: "Attrition", definition: "Retention", baseline: "TBD",
      targetLabel: "<= 3%", targetValue: 3, direction: "at-most", unit: "percent",
      value: 2, status: "met", sampleSize: 5, eligibleCount: 6, unknownCount: 1,
      note: "Never exported.",
    },
  ],
};

describe("privacy-scoped outcome reporting export", () => {
  test("withholds every aggregate field below the minimum cohort", () => {
    const exported = privacyScopedOutcomeExport(report);
    assert.equal(exported.integrationState, OUTCOME_ANALYTICS_INTEGRATION_STATE);
    assert.equal(exported.individualLevelDataIncluded, false);
    assert.deepEqual(exported.rows[0], {
      metricId: "enps", label: "=eNPS", definition: "Experience", unit: "score",
      targetLabel: ">= 40", baseline: "TBD", publicationStatus: "suppressed",
      suppressionReason: "Fewer than 5 usable observations; aggregate withheld.",
      value: null, eligibleCount: null, sampleSize: null, unknownCount: null, status: "insufficient-data",
    });
    assert.equal(exported.rows[1]?.publicationStatus, "published");
    assert.equal(exported.rows[1]?.value, 2);
  });

  test("emits formula-safe aggregate-only CSV without notes or identifiers", () => {
    const csv = privacyScopedOutcomeExportCsv(privacyScopedOutcomeExport(report));
    assert.match(csv, /# integration_state=pending-powerbi/);
    assert.match(csv, /"'=eNPS"/);
    assert.doesNotMatch(csv, /Never exported/);
    assert.doesNotMatch(csv, /caseId|worker|survey|joined|authority/i);
  });
});