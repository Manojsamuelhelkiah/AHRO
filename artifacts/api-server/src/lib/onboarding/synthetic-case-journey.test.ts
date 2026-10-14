import assert from "node:assert/strict";
import test from "node:test";
import type { onbCases } from "@workspace/db";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { DEMO_FULL_COVERAGE_SCENARIO_KEYS } from "./demo-full-coverage";
import { getScenario } from "./scenarios";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";
import { fixedSyntheticJourney, syntheticJourneyEligibility } from "./synthetic-case-journey";
import { JOURNEY_FAMILIES } from "./synthetic-journey-catalogue";
import { mandatoryChecklistReady } from "./settings";
import { sampleCandidateEmailEligible } from "./synthetic-offline";
import { agentCatalogue, AGENT_CATALOGUE_VERSION } from "../agent-catalogue";
import { calculateOutcomeKpis } from "./outcome-kpis";

type Row = typeof onbCases.$inferSelect;
const curatedRows = CURATED_OFFLINE_EXAMPLES.map(example => ({
  organizationId: "demo", ...example.values,
}) as unknown as Row);
const legacyRows = DEMO_FULL_COVERAGE_SCENARIO_KEYS.map(key => ({
  organizationId: "demo", scenarioKey: `UAT-DEMO-COVERAGE:${key}`,
  workerName: `Demo sample — ${getScenario(key)!.title}`, workerEmail: `demo-${key}@hro.invalid`,
  workerPhone: null, candidateEmailAuthorizedAt: null, candidateEmailAuthorizedBy: null,
  notes: SYNTHETIC_OFFLINE_MARKER, syntheticProvenance: null,
}) as Row);

test("all 120 curated and 12 canonical examples have deterministic, ordered, distinct, dependency-consistent journeys", t => {
  const matrix: Record<string, Record<string, number>> = {};
  const reasons = new Set<string>();
  const catalogue = agentCatalogue();
  const actors = new Set<string>();
  for (const row of [...curatedRows, ...legacyRows]) {
    const original = JSON.stringify(row);
    const journey = fixedSyntheticJourney(row)!;
    assert.ok(journey, row.scenarioKey!);
    assert.deepEqual(journey, fixedSyntheticJourney(row));
    assert.equal(JSON.stringify(row), original, "projection must never mutate stored objects");
    assert.ok(!reasons.has(journey.rationale), row.scenarioKey!);
    reasons.add(journey.rationale);
    const counts = matrix[journey.family] ??= { completed: 0, rejected: 0, blocked: 0 };
    counts[journey.outcome]!++;
    const seen = new Set<string>();
    let previous = "";
    for (const stage of journey.stages) {
      assert.ok(stage.date > previous);
      previous = stage.date;
      assert.ok(stage.dependencies.every(id => seen.has(id)));
      if (stage.status === "completed") assert.ok(stage.dependencies.every(id =>
        journey.stages.find(s => s.id === id)?.status === "completed"));
      seen.add(stage.id);
      assert.ok(stage.agent && stage.role && stage.evidence && stage.decision && stage.communication);
      assert.doesNotMatch(stage.agent, /^none$/i);
      assert.equal(stage.agent, catalogue.find(agent => agent.key === stage.agentKey)?.name);
      assert.equal(stage.agentVersion, AGENT_CATALOGUE_VERSION);
      actors.add(stage.agentKey);
    }
    if (journey.outcome === "blocked") {
      assert.equal(journey.stages.at(-1)!.status, "blocked");
      assert.equal(journey.nextActions.length, 1);
      assert.equal(journey.nextActions[0], journey.rationale);
      assert.ok(!seen.has("outcome"));
    } else {
      assert.deepEqual(journey.nextActions, []);
      assert.equal(journey.stages.find(stage => stage.id === "outcome")!.status, journey.outcome === "rejected" ? "cancelled" : "completed");
      assert.ok(journey.stages.find(stage => stage.id === "decision"));
    }
    if (journey.family === "Offboarding" && journey.outcome === "completed") {
      assert.match(journey.qualifier, /Preparation completed; final closure blocked/);
      assert.match(journey.stages.find(stage => stage.id === "outcome")!.decision, /section 4.6/);
      assert.match(journey.stages.find(stage => stage.id === "outcome")!.decision, /no closed archive or alumni/);
    }
    // A story must not satisfy the unchanged checklist or delivery gates.
    if (row.readiness) assert.equal(mandatoryChecklistReady(row), false);
    assert.equal(sampleCandidateEmailEligible(row), false);
    assert.doesNotMatch(JSON.stringify({ title: journey.title, qualifier: journey.qualifier,
      rationale: journey.rationale, stages: journey.stages, nextActions: journey.nextActions }), /fictional|illustrat|synthetic/i);
  }
  assert.equal(actors.size, 15, "all current catalogue domain and applicable supporting roles are represented");
  assert.equal(Object.keys(matrix).length, 12);
  for (const [family, counts] of Object.entries(matrix)) {
    assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), 11, family);
    assert.ok(counts.completed! > 0 && counts.rejected! > 0 && counts.blocked! > 0, family);
    assert.equal(JOURNEY_FAMILIES[family]!.branches.length, 10);
  }
  t.diagnostic(JSON.stringify(matrix));
});

test("only exact fixed identities qualify; preparations, activations, controller/UAT ownership and real/hybrid contacts fail closed", () => {
  for (const row of [...curatedRows, ...legacyRows]) {
    const alterations = [
      { organizationId: "other" }, { scenarioKey: "UAT-custom" }, { workerName: "Custom identity" },
      { workerEmail: "real@example.com" }, { workerPhone: "+1000000" },
      { candidateEmailAuthorizedAt: new Date() }, { candidateEmailAuthorizedBy: "volunteer" },
      { operationalPreparation: {} }, { operationalActivation: {} },
      { syntheticProvenance: "demo-controller-fictional" },
      { checklistProfileId: "demo-controller" }, { orchestrationCheckpoint: "demo-controller:retired" },
      { notes: `${SYNTHETIC_OFFLINE_MARKER} [demo-controller-run:old]` },
    ];
    for (const alteration of alterations) {
      assert.ok(syntheticJourneyEligibility({ ...row, ...alteration } as Row));
      assert.equal(fixedSyntheticJourney({ ...row, ...alteration } as Row), null);
    }
    assert.equal(fixedSyntheticJourney(row, true), null, "run-ledger ownership excludes even exact identities");
    const journey = fixedSyntheticJourney({ ...row,
      planSummary: "<script>PRIVATE</script>", managerName: "PRIVATE", notes: "PRIVATE",
      workstreams: [{ key: "custom", label: "PRIVATE", agent: "PRIVATE", owner: "PRIVATE", status: "ready" }],
      readiness: [{ key: "private", label: "PRIVATE", status: "done" }],
      processPolicySnapshot: { custom: "PRIVATE" },
    } as unknown as Row)!;
    assert.ok(journey);
    assert.doesNotMatch(JSON.stringify(journey), /PRIVATE|<script>/);
  }
});

test("journey outcomes never supply measured operational success, readiness or SLA evidence", () => {
  const asOf = new Date("2030-12-01T00:00:00Z");
  const rows = curatedRows.map((row, index) => ({ ...row, id: index + 1, createdAt: new Date("2030-10-01") }));
  const baseline = calculateOutcomeKpis({ cases: rows, asOf, period: "All", domain: "All domains" });
  const projected = calculateOutcomeKpis({
    cases: rows.map(row => ({ ...row, syntheticJourney: fixedSyntheticJourney(row) })),
    asOf, period: "All", domain: "All domains",
  });
  assert.deepEqual(projected, baseline);
  assert.deepEqual(calculateOutcomeKpis({
    cases: rows.map(row => ({ ...row, offlineExampleReportable: true, syntheticJourney: fixedSyntheticJourney(row) })),
    asOf, period: "All", domain: "All domains",
  }), calculateOutcomeKpis({
    cases: rows.map(row => ({ ...row, offlineExampleReportable: true })),
    asOf, period: "All", domain: "All domains",
  }), "authorized offline volume inclusion does not turn journey stages into operational outcome evidence");
});
