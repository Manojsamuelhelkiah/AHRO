import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDrift,
  computeTrend,
  periodLabel,
  toQuality,
  requireSingleClient,
  MixedClientError,
  STABLE_TOLERANCE,
  type DriftOverlayInput,
  type DriftPoint,
} from "./drift";
import { DEFAULT_ROLE_PRICING, repriceRole, formatUsdPerCall, type RolePricingMap } from "./token-pricing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function overlay(
  id: number,
  periodStart: string | null,
  payload: DriftOverlayInput["payload"] = {},
  periodEnd: string | null = null,
): DriftOverlayInput {
  return { id, periodStart, periodEnd, clientLabel: "Test Client", payload };
}

function points(values: (number | null)[]): DriftPoint[] {
  return values.map((v, i) => ({
    overlayId: i + 1,
    periodLabel: `P${i + 1}`,
    measuredValue: v,
  }));
}

// ---------------------------------------------------------------------------
// periodLabel
// ---------------------------------------------------------------------------

test("periodLabel: full ISO start → year-month", () => {
  const ov = overlay(1, "2025-01-01");
  assert.equal(periodLabel(ov), "2025-01");
});

test("periodLabel: start + end with same month → single label", () => {
  const ov = overlay(1, "2025-01-01", {}, "2025-01-31");
  assert.equal(periodLabel(ov), "2025-01");
});

test("periodLabel: start + end with different months → range", () => {
  const ov = overlay(1, "2025-01-01", {}, "2025-03-31");
  assert.equal(periodLabel(ov), "2025-01–2025-03");
});

test("periodLabel: no periodStart → Overlay #id", () => {
  const ov = overlay(7, null);
  assert.equal(periodLabel(ov), "Overlay #7");
});

// ---------------------------------------------------------------------------
// toQuality
// ---------------------------------------------------------------------------

test("toQuality: higher-is-better returns measured unchanged", () => {
  assert.equal(toQuality(0.85, "higher-is-better"), 0.85);
});

test("toQuality: lower-is-better negates measured", () => {
  assert.equal(toQuality(3.5, "lower-is-better"), -3.5);
});

// ---------------------------------------------------------------------------
// computeTrend — stable
// ---------------------------------------------------------------------------

test("computeTrend: single non-null point → stable", () => {
  assert.equal(computeTrend(points([null, 0.8, null]), "higher-is-better", 0.95), "stable");
});

test("computeTrend: two non-null points within STABLE_TOLERANCE → stable", () => {
  // estimate=0.95, range = 0.04 < 0.05*0.95 ≈ 0.0475 → just inside stable
  const pts = points([0.95, 0.91]);
  // range = 0.04, refScale = 0.95, 0.04/0.95 ≈ 0.042 < 0.05 → stable
  assert.equal(computeTrend(pts, "higher-is-better", 0.95), "stable");
});

test("computeTrend: all null → stable (fewer than 2 non-null)", () => {
  assert.equal(computeTrend(points([null, null, null]), "higher-is-better", 0.95), "stable");
});

// ---------------------------------------------------------------------------
// computeTrend — improving / degrading / mixed
// ---------------------------------------------------------------------------

test("computeTrend: higher-is-better, monotone increasing → improving", () => {
  // range = 0.15/0.75 = 0.2 > 0.05 → not stable; all positive deltas → improving
  const pts = points([0.60, 0.70, 0.75]);
  assert.equal(computeTrend(pts, "higher-is-better", 0.75), "improving");
});

test("computeTrend: higher-is-better, monotone decreasing → degrading", () => {
  const pts = points([0.90, 0.80, 0.70]);
  assert.equal(computeTrend(pts, "higher-is-better", 0.95), "degrading");
});

test("computeTrend: lower-is-better, monotone decreasing measured → improving (quality increases)", () => {
  // measured goes 5 → 4 → 3 (minutes), lower = better → quality = -5, -4, -3 → increasing → improving
  const pts = points([5.0, 4.0, 3.0]);
  assert.equal(computeTrend(pts, "lower-is-better", 5.0), "improving");
});

test("computeTrend: lower-is-better, monotone increasing measured → degrading", () => {
  // measured 3 → 4 → 5 → quality -3, -4, -5 → decreasing → degrading
  const pts = points([3.0, 4.0, 5.0]);
  assert.equal(computeTrend(pts, "lower-is-better", 5.0), "degrading");
});

test("computeTrend: direction reverses → mixed", () => {
  // 0.60 → 0.80 → 0.65 — goes up then down
  const pts = points([0.60, 0.80, 0.65]);
  assert.equal(computeTrend(pts, "higher-is-better", 0.75), "mixed");
});

// ---------------------------------------------------------------------------
// computeTrend — null gaps in points
// ---------------------------------------------------------------------------

test("computeTrend: ignores null gaps, evaluates non-null monotonicity", () => {
  // P1=null, P2=0.65, P3=null, P4=0.80 → non-null: 0.65, 0.80 → improving
  const pts = points([null, 0.65, null, 0.80]);
  assert.equal(computeTrend(pts, "higher-is-better", 0.85), "improving");
});

test("computeTrend: single non-null across gaps → stable", () => {
  const pts = points([null, 0.75, null]);
  assert.equal(computeTrend(pts, "higher-is-better", 0.85), "stable");
});

// ---------------------------------------------------------------------------
// computeDrift — sorting unsorted input
// ---------------------------------------------------------------------------

test("computeDrift: sorts overlays by periodStart regardless of input order", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(3, "2025-03-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.90 } }),
    overlay(1, "2025-01-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.75 } }),
    overlay(2, "2025-02-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.82 } }),
  ];
  const series = computeDrift(ovs);
  const fc1 = series.find((s) => s.assumptionKey === "containment-fc1");
  assert.ok(fc1, "should have containment-fc1 series");
  assert.deepEqual(
    fc1!.points.map((p) => p.measuredValue),
    [0.75, 0.82, 0.90],
    "points should be sorted by periodStart",
  );
});

// ---------------------------------------------------------------------------
// computeDrift — missing measurements (gaps)
// ---------------------------------------------------------------------------

test("computeDrift: overlays with missing measurements produce null gaps, not crashes", () => {
  const ovs: DriftOverlayInput[] = [
    // overlay 1: measures fc1 only
    overlay(1, "2025-01-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.80 } }),
    // overlay 2: measures fc2 only — fc1 gap
    overlay(2, "2025-02-01", { measuredContainmentByFlowClass: { "fc2-policy": 0.78 } }),
    // overlay 3: measures both
    overlay(3, "2025-03-01", {
      measuredContainmentByFlowClass: { "fc1-deterministic": 0.87, "fc2-policy": 0.82 },
    }),
  ];
  const series = computeDrift(ovs);

  const fc1 = series.find((s) => s.assumptionKey === "containment-fc1");
  assert.ok(fc1, "fc1 series present");
  assert.deepEqual(
    fc1!.points.map((p) => p.measuredValue),
    [0.80, null, 0.87],
    "fc1 has null gap at period 2",
  );

  const fc2 = series.find((s) => s.assumptionKey === "containment-fc2");
  assert.ok(fc2, "fc2 series present");
  assert.deepEqual(
    fc2!.points.map((p) => p.measuredValue),
    [null, 0.78, 0.82],
    "fc2 has null gap at period 1",
  );
});

test("computeDrift: assumption not measured in any overlay is excluded from results", () => {
  // Only fc1 is measured — fc2/3/4 and hitl-sampling-rate should be absent
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.80 } }),
    overlay(2, "2025-02-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.85 } }),
  ];
  const series = computeDrift(ovs);
  const keys = series.map((s) => s.assumptionKey);
  assert.ok(keys.includes("containment-fc1"), "fc1 included");
  assert.ok(!keys.includes("containment-fc2"), "fc2 excluded");
  assert.ok(!keys.includes("hitl-sampling-rate"), "hitl excluded");
});

// ---------------------------------------------------------------------------
// computeDrift — polarity (improving / degrading direction correctness)
// ---------------------------------------------------------------------------

test("computeDrift: containment increasing → improving (higher-is-better)", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { measuredContainmentByFlowClass: { "fc2-policy": 0.70 } }),
    overlay(2, "2025-02-01", { measuredContainmentByFlowClass: { "fc2-policy": 0.80 } }),
    overlay(3, "2025-03-01", { measuredContainmentByFlowClass: { "fc2-policy": 0.88 } }),
  ];
  const series = computeDrift(ovs);
  const fc2 = series.find((s) => s.assumptionKey === "containment-fc2")!;
  assert.equal(fc2.trend, "improving");
  assert.ok((fc2.trendDelta ?? 0) > 0, "trendDelta should be positive when improving");
});

test("computeDrift: containment decreasing → degrading (higher-is-better)", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { measuredContainmentByFlowClass: { "fc3-multiagent": 0.80 } }),
    overlay(2, "2025-02-01", { measuredContainmentByFlowClass: { "fc3-multiagent": 0.70 } }),
    overlay(3, "2025-03-01", { measuredContainmentByFlowClass: { "fc3-multiagent": 0.58 } }),
  ];
  const series = computeDrift(ovs);
  const fc3 = series.find((s) => s.assumptionKey === "containment-fc3")!;
  assert.equal(fc3.trend, "degrading");
  assert.ok((fc3.trendDelta ?? 0) < 0, "trendDelta negative when degrading");
});

test("computeDrift: per-intent HITL minutes decreasing → improving (lower-is-better)", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { intents: [{ intentKey: "payslip-copy", avgHitlMinutes: 8 }] }),
    overlay(2, "2025-02-01", { intents: [{ intentKey: "payslip-copy", avgHitlMinutes: 5 }] }),
    overlay(3, "2025-03-01", { intents: [{ intentKey: "payslip-copy", avgHitlMinutes: 3 }] }),
  ];
  const series = computeDrift(ovs);
  const hitl = series.find((s) => s.assumptionKey === "intent-hitl-payslip-copy")!;
  assert.ok(hitl, "HITL minutes series present");
  assert.equal(hitl.polarity, "lower-is-better");
  assert.equal(hitl.trend, "improving");
  assert.ok((hitl.trendDelta ?? 0) > 0, "trendDelta positive (quality increasing) when improving lower-is-better");
});

test("computeDrift: per-intent HITL minutes increasing → degrading (lower-is-better)", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { intents: [{ intentKey: "leave-balance", avgHitlMinutes: 2 }] }),
    overlay(2, "2025-02-01", { intents: [{ intentKey: "leave-balance", avgHitlMinutes: 4 }] }),
    overlay(3, "2025-03-01", { intents: [{ intentKey: "leave-balance", avgHitlMinutes: 7 }] }),
  ];
  const series = computeDrift(ovs);
  const hitl = series.find((s) => s.assumptionKey === "intent-hitl-leave-balance")!;
  assert.equal(hitl.trend, "degrading");
});

// ---------------------------------------------------------------------------
// computeDrift — stable tolerance
// ---------------------------------------------------------------------------

test("computeDrift: tiny variation within stable tolerance → stable trend", () => {
  // estimate for fc1 = 0.95; STABLE_TOLERANCE = 5%
  // range = 0.96 - 0.94 = 0.02; 0.02/0.95 ≈ 0.021 < 0.05 → stable
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.94 } }),
    overlay(2, "2025-02-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.95 } }),
    overlay(3, "2025-03-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.96 } }),
  ];
  const series = computeDrift(ovs);
  const fc1 = series.find((s) => s.assumptionKey === "containment-fc1")!;
  assert.equal(fc1.trend, "stable");
});

test("computeDrift: variation just beyond stable tolerance → not stable", () => {
  // estimate = 0.95; STABLE_TOLERANCE = 5%; threshold = 0.0475
  // range = 0.95 - 0.85 = 0.10 > 0.0475 → not stable
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.85 } }),
    overlay(2, "2025-02-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.90 } }),
    overlay(3, "2025-03-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.95 } }),
  ];
  const series = computeDrift(ovs);
  const fc1 = series.find((s) => s.assumptionKey === "containment-fc1")!;
  assert.notEqual(fc1.trend, "stable");
});

// ---------------------------------------------------------------------------
// computeDrift — overlapping / identical periods get disambiguated labels
// ---------------------------------------------------------------------------

test("computeDrift: identical period labels get #id suffix", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(5, "2025-01-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.80 } }),
    overlay(9, "2025-01-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.85 } }),
  ];
  const series = computeDrift(ovs);
  const fc1 = series.find((s) => s.assumptionKey === "containment-fc1")!;
  const labels = fc1.points.map((p) => p.periodLabel);
  // Both are "2025-01" → should be disambiguated
  assert.ok(labels[0] !== labels[1], `labels must be unique: ${JSON.stringify(labels)}`);
  assert.ok(labels[0]!.includes("2025-01"), "first label contains base period");
  assert.ok(labels[1]!.includes("2025-01"), "second label contains base period");
});

// ---------------------------------------------------------------------------
// computeDrift — estimate map (caller-supplied override)
// ---------------------------------------------------------------------------

test("computeDrift: caller-supplied estimateMap overrides register default", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.92 } }),
    overlay(2, "2025-02-01", { measuredContainmentByFlowClass: { "fc1-deterministic": 0.94 } }),
  ];
  // Override with a scenario-specific estimate
  const series = computeDrift(ovs, { "containment-fc1": 0.88 });
  const fc1 = series.find((s) => s.assumptionKey === "containment-fc1")!;
  assert.equal(fc1.estimate, 0.88, "estimate should use caller-supplied value");
});

// ---------------------------------------------------------------------------
// computeDrift — per-intent containment series
// ---------------------------------------------------------------------------

test("computeDrift: per-intent containment appears with correct key and label", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { intents: [{ intentKey: "payslip-copy", measuredContainmentRate: 0.82 }] }),
    overlay(2, "2025-02-01", { intents: [{ intentKey: "payslip-copy", measuredContainmentRate: 0.88 }] }),
  ];
  const series = computeDrift(ovs, {}, { "payslip-copy": "Payslip Copy" });
  const ps = series.find((s) => s.assumptionKey === "intent-cont-payslip-copy");
  assert.ok(ps, "per-intent containment series present");
  assert.equal(ps!.polarity, "higher-is-better");
  assert.ok(ps!.label.includes("Payslip Copy"), "label uses intentLabels mapping");
  assert.equal(ps!.trend, "improving");
});

test("computeDrift: per-intent containment with null estimate when not in estimateMap", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { intents: [{ intentKey: "leave-balance", measuredContainmentRate: 0.75 }] }),
    overlay(2, "2025-02-01", { intents: [{ intentKey: "leave-balance", measuredContainmentRate: 0.80 }] }),
  ];
  const series = computeDrift(ovs);
  const s = series.find((s) => s.assumptionKey === "intent-cont-leave-balance")!;
  assert.equal(s.estimate, null, "estimate is null when no register default exists");
});

// ---------------------------------------------------------------------------
// computeDrift — trendDelta undefined for single non-null point
// ---------------------------------------------------------------------------

test("computeDrift: trendDelta is undefined when only one non-null point", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { measuredContainmentByFlowClass: { "fc2-policy": 0.80 } }),
    overlay(2, "2025-02-01", {}), // fc2 not measured here
  ];
  const series = computeDrift(ovs);
  const fc2 = series.find((s) => s.assumptionKey === "containment-fc2")!;
  assert.equal(fc2.trendDelta, undefined, "trendDelta undefined when only 1 non-null point");
  assert.equal(fc2.trend, "stable");
});

// ---------------------------------------------------------------------------
// computeDrift — empty input
// ---------------------------------------------------------------------------

test("computeDrift: empty overlay list returns empty array", () => {
  assert.deepEqual(computeDrift([]), []);
});

// ---------------------------------------------------------------------------
// requireSingleClient — guard tests
// ---------------------------------------------------------------------------

test("requireSingleClient: all overlays same label → no throw", () => {
  const ovs = [
    overlay(1, "2025-01-01"),
    overlay(2, "2025-02-01"),
  ];
  assert.doesNotThrow(() => requireSingleClient(ovs));
});

test("requireSingleClient: single overlay → no throw", () => {
  assert.doesNotThrow(() => requireSingleClient([overlay(1, "2025-01-01")]));
});

test("requireSingleClient: empty array → no throw", () => {
  assert.doesNotThrow(() => requireSingleClient([]));
});

test("requireSingleClient: all unlabeled (null clientLabel) → no throw", () => {
  const ovs: DriftOverlayInput[] = [
    { id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: null, payload: {} },
    { id: 2, periodStart: "2025-02-01", periodEnd: null, clientLabel: null, payload: {} },
  ];
  assert.doesNotThrow(() => requireSingleClient(ovs));
});

test("requireSingleClient: all unlabeled (undefined clientLabel) → no throw", () => {
  const ovs: DriftOverlayInput[] = [
    { id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: undefined, payload: {} },
    { id: 2, periodStart: "2025-02-01", periodEnd: null, clientLabel: undefined, payload: {} },
  ];
  assert.doesNotThrow(() => requireSingleClient(ovs));
});

test("requireSingleClient: two different named clients → throws MixedClientError", () => {
  const ovs: DriftOverlayInput[] = [
    { id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Acme", payload: {} },
    { id: 2, periodStart: "2025-02-01", periodEnd: null, clientLabel: "Beta Corp", payload: {} },
  ];
  assert.throws(() => requireSingleClient(ovs), MixedClientError);
});

test("requireSingleClient: labeled + unlabeled → throws MixedClientError", () => {
  const ovs: DriftOverlayInput[] = [
    { id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Acme", payload: {} },
    { id: 2, periodStart: "2025-02-01", periodEnd: null, clientLabel: null, payload: {} },
  ];
  assert.throws(() => requireSingleClient(ovs), MixedClientError);
});

test("requireSingleClient: MixedClientError message contains both labels", () => {
  const ovs: DriftOverlayInput[] = [
    { id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Acme", payload: {} },
    { id: 2, periodStart: "2025-02-01", periodEnd: null, clientLabel: "Beta Corp", payload: {} },
  ];
  let caught: unknown;
  try { requireSingleClient(ovs); } catch (e) { caught = e; }
  assert.ok(caught instanceof MixedClientError, "should throw MixedClientError");
  assert.ok((caught as MixedClientError).message.includes("Acme"), "error mentions first client");
  assert.ok((caught as MixedClientError).message.includes("Beta Corp"), "error mentions second client");
});

// ---------------------------------------------------------------------------
// computeDrift — mixed-client rejection at computation boundary
// ---------------------------------------------------------------------------

test("computeDrift: throws MixedClientError when overlays span two named clients", () => {
  const ovs: DriftOverlayInput[] = [
    {
      id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Acme",
      payload: { measuredContainmentByFlowClass: { "fc1-deterministic": 0.80 } },
    },
    {
      id: 2, periodStart: "2025-02-01", periodEnd: null, clientLabel: "Beta Corp",
      payload: { measuredContainmentByFlowClass: { "fc1-deterministic": 0.85 } },
    },
  ];
  assert.throws(() => computeDrift(ovs), MixedClientError);
});

test("computeDrift: throws MixedClientError when labeled and unlabeled overlays are mixed", () => {
  const ovs: DriftOverlayInput[] = [
    {
      id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Acme",
      payload: { measuredContainmentByFlowClass: { "fc1-deterministic": 0.80 } },
    },
    {
      id: 2, periodStart: "2025-02-01", periodEnd: null, clientLabel: undefined,
      payload: { measuredContainmentByFlowClass: { "fc1-deterministic": 0.85 } },
    },
  ];
  assert.throws(() => computeDrift(ovs), MixedClientError);
});

// ---------------------------------------------------------------------------
// Interaction regression — UI filtering logic never produces mixed-client input
// ---------------------------------------------------------------------------

/**
 * Simulates the UI's "select client → filter overlays" step.
 * If this function is used correctly, computeDrift should never see mixed clients.
 */
function uiFilterForClient(
  allOverlays: DriftOverlayInput[],
  selectedClient: string | null,
): DriftOverlayInput[] {
  return allOverlays.filter((o) =>
    selectedClient === null
      ? (o.clientLabel ?? null) === null
      : o.clientLabel === selectedClient,
  );
}

test("regression: uiFilterForClient always produces single-client output (labeled)", () => {
  const allOverlays: DriftOverlayInput[] = [
    { id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Acme", payload: {} },
    { id: 2, periodStart: "2025-02-01", periodEnd: null, clientLabel: "Acme", payload: {} },
    { id: 3, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Beta Corp", payload: {} },
    { id: 4, periodStart: "2025-02-01", periodEnd: null, clientLabel: null, payload: {} },
  ];
  // Selecting "Acme" should yield only Acme overlays
  const filtered = uiFilterForClient(allOverlays, "Acme");
  assert.doesNotThrow(() => requireSingleClient(filtered));
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((o) => o.clientLabel === "Acme"));
});

test("regression: uiFilterForClient always produces single-client output (unlabeled)", () => {
  const allOverlays: DriftOverlayInput[] = [
    { id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Acme", payload: {} },
    { id: 2, periodStart: "2025-01-01", periodEnd: null, clientLabel: null, payload: {} },
    { id: 3, periodStart: "2025-02-01", periodEnd: null, clientLabel: undefined, payload: {} },
  ];
  // Selecting null (unlabeled group) should yield only unlabeled overlays
  const filtered = uiFilterForClient(allOverlays, null);
  assert.doesNotThrow(() => requireSingleClient(filtered));
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((o) => (o.clientLabel ?? null) === null));
});

test("regression: no valid client selection can produce cross-client series", () => {
  const allOverlays: DriftOverlayInput[] = [
    { id: 1, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Acme", payload: {} },
    { id: 2, periodStart: "2025-02-01", periodEnd: null, clientLabel: "Acme", payload: {} },
    { id: 3, periodStart: "2025-01-01", periodEnd: null, clientLabel: "Beta Corp", payload: {} },
    { id: 4, periodStart: "2025-01-01", periodEnd: null, clientLabel: null, payload: {} },
  ];
  // Extract the set of distinct clients as the UI would
  const distinctClients = [
    ...new Set(allOverlays.map((o) => o.clientLabel ?? null)),
  ];
  // For each selectable client, verify the filtered result is single-client
  for (const client of distinctClients) {
    const filtered = uiFilterForClient(allOverlays, client);
    assert.doesNotThrow(
      () => requireSingleClient(filtered),
      `filtering for client "${client}" should produce single-client output`,
    );
  }
});

// ---------------------------------------------------------------------------
// computeDrift — HITL sampling rate
// ---------------------------------------------------------------------------

test("computeDrift: HITL sampling rate uses register default 1.0 as estimate", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { measuredHitlSamplingRate: 0.5 }),
    overlay(2, "2025-02-01", { measuredHitlSamplingRate: 0.7 }),
  ];
  const series = computeDrift(ovs);
  const hitl = series.find((s) => s.assumptionKey === "hitl-sampling-rate")!;
  assert.ok(hitl, "hitl-sampling-rate series present");
  assert.equal(hitl.estimate, 1.0);
  assert.equal(hitl.polarity, "higher-is-better");
  assert.equal(hitl.trend, "improving");
});

// ---------------------------------------------------------------------------
// Token cost per role — new tests (8 total)
// ---------------------------------------------------------------------------

// A minimal pricing map used across these tests — keeps values simple.
const TEST_PRICING: RolePricingMap = {
  router: {
    label: "Test Router",
    inputPricePerMillionTokens: 1.0,
    outputPricePerMillionTokens: 2.0,
    defaultPricePerCallUsd: 0.005,
  },
  reasoning: {
    label: "Test Reasoning",
    inputPricePerMillionTokens: 4.0,
    outputPricePerMillionTokens: 12.0,
    defaultPricePerCallUsd: 0.02,
  },
};

// 1. Basic: token actuals repriced → correct unit, polarity, and estimate
test("computeDrift with rolePricingMap: emits USD/call series with lower-is-better polarity", () => {
  // router: 1000 input × 1.0/M + 200 output × 2.0/M = 0.001 + 0.0004 = 0.0014 USD/call
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { tokenActualsByRole: { router: { avgInputTokens: 1000, avgOutputTokens: 200 } } }),
    overlay(2, "2025-02-01", { tokenActualsByRole: { router: { avgInputTokens: 900, avgOutputTokens: 180 } } }),
  ];
  const series = computeDrift(ovs, {}, {}, TEST_PRICING);
  const s = series.find((x) => x.assumptionKey === "token-cost-router");
  assert.ok(s, "token-cost-router series present");
  assert.equal(s!.unit, "USD");
  assert.equal(s!.polarity, "lower-is-better");
  assert.equal(s!.estimate, 0.005, "estimate = defaultPricePerCallUsd from pricing map");
  // P1 cost: (1000 × 1 + 200 × 2) / 1e6 = 0.0014
  assert.ok(Math.abs(s!.points[0]!.measuredValue! - 0.0014) < 1e-10, "P1 repriced correctly");
});

// 2. Decreasing cost → trend "improving"
test("computeDrift with rolePricingMap: decreasing token cost → trend improving", () => {
  // P1: router 2000in/400out → (2000×1 + 400×2)/1e6 = 0.0028
  // P2: router 1500in/300out → (1500×1 + 300×2)/1e6 = 0.0021
  // P3: router 1000in/200out → (1000×1 + 200×2)/1e6 = 0.0014
  // All decreasing → lower-is-better → improving
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { tokenActualsByRole: { router: { avgInputTokens: 2000, avgOutputTokens: 400 } } }),
    overlay(2, "2025-02-01", { tokenActualsByRole: { router: { avgInputTokens: 1500, avgOutputTokens: 300 } } }),
    overlay(3, "2025-03-01", { tokenActualsByRole: { router: { avgInputTokens: 1000, avgOutputTokens: 200 } } }),
  ];
  const series = computeDrift(ovs, {}, {}, TEST_PRICING);
  const s = series.find((x) => x.assumptionKey === "token-cost-router")!;
  assert.equal(s.trend, "improving");
  assert.ok((s.trendDelta ?? 0) > 0, "trendDelta positive (quality improving) for lower-is-better decreasing cost");
});

// 3. Increasing cost → trend "degrading"
test("computeDrift with rolePricingMap: increasing token cost → trend degrading", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { tokenActualsByRole: { router: { avgInputTokens: 1000, avgOutputTokens: 200 } } }),
    overlay(2, "2025-02-01", { tokenActualsByRole: { router: { avgInputTokens: 1500, avgOutputTokens: 300 } } }),
    overlay(3, "2025-03-01", { tokenActualsByRole: { router: { avgInputTokens: 2000, avgOutputTokens: 400 } } }),
  ];
  const series = computeDrift(ovs, {}, {}, TEST_PRICING);
  const s = series.find((x) => x.assumptionKey === "token-cost-router")!;
  assert.equal(s.trend, "degrading");
  assert.ok((s.trendDelta ?? 0) < 0, "trendDelta negative when cost increases (degrading lower-is-better)");
});

// 4. Role with no actuals in any overlay → no series for that role
test("computeDrift with rolePricingMap: role absent from all overlays → no series", () => {
  // Only router actuals provided, reasoning absent
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { tokenActualsByRole: { router: { avgInputTokens: 1000, avgOutputTokens: 200 } } }),
    overlay(2, "2025-02-01", { tokenActualsByRole: { router: { avgInputTokens: 900, avgOutputTokens: 180 } } }),
  ];
  const series = computeDrift(ovs, {}, {}, TEST_PRICING);
  const keys = series.map((s) => s.assumptionKey);
  assert.ok(keys.includes("token-cost-router"), "router series present");
  assert.ok(!keys.includes("token-cost-reasoning"), "reasoning series absent — no actuals");
});

// 5. Some overlays missing a role → null gaps in the series
test("computeDrift with rolePricingMap: role missing from some overlays → null gaps", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { tokenActualsByRole: { router: { avgInputTokens: 1000, avgOutputTokens: 200 } } }),
    overlay(2, "2025-02-01", {}),  // no token actuals at all
    overlay(3, "2025-03-01", { tokenActualsByRole: { router: { avgInputTokens: 900, avgOutputTokens: 180 } } }),
  ];
  const series = computeDrift(ovs, {}, {}, TEST_PRICING);
  const s = series.find((x) => x.assumptionKey === "token-cost-router")!;
  assert.ok(s, "router series still present despite gap");
  assert.equal(s.points[1]!.measuredValue, null, "P2 is a null gap");
  assert.ok(s.points[0]!.measuredValue !== null, "P1 has a value");
  assert.ok(s.points[2]!.measuredValue !== null, "P3 has a value");
});

// 6. Estimate = defaultPricePerCallUsd from pricing map (no estimateMap override)
test("computeDrift with rolePricingMap: estimate comes from defaultPricePerCallUsd", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { tokenActualsByRole: { reasoning: { avgInputTokens: 5000, avgOutputTokens: 1000 } } }),
    overlay(2, "2025-02-01", { tokenActualsByRole: { reasoning: { avgInputTokens: 4500, avgOutputTokens: 900 } } }),
  ];
  const series = computeDrift(ovs, {}, {}, TEST_PRICING);
  const s = series.find((x) => x.assumptionKey === "token-cost-reasoning")!;
  assert.equal(s.estimate, TEST_PRICING.reasoning!.defaultPricePerCallUsd,
    "estimate matches defaultPricePerCallUsd from pricing entry");
});

// 7. estimateMap["token-cost-router"] overrides the defaultPricePerCallUsd baseline
test("computeDrift with rolePricingMap: estimateMap overrides defaultPricePerCallUsd", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", { tokenActualsByRole: { router: { avgInputTokens: 1000, avgOutputTokens: 200 } } }),
    overlay(2, "2025-02-01", { tokenActualsByRole: { router: { avgInputTokens: 900, avgOutputTokens: 180 } } }),
  ];
  const series = computeDrift(ovs, { "token-cost-router": 0.0025 }, {}, TEST_PRICING);
  const s = series.find((x) => x.assumptionKey === "token-cost-router")!;
  assert.equal(s.estimate, 0.0025, "estimate should use caller-supplied estimateMap value");
});

// 8. Omitting rolePricingMap emits no token-cost series (backward-compat)
test("computeDrift without rolePricingMap: no token-cost series emitted", () => {
  const ovs: DriftOverlayInput[] = [
    overlay(1, "2025-01-01", {
      measuredContainmentByFlowClass: { "fc1-deterministic": 0.90 },
      tokenActualsByRole: { router: { avgInputTokens: 1000, avgOutputTokens: 200 } },
    }),
    overlay(2, "2025-02-01", {
      measuredContainmentByFlowClass: { "fc1-deterministic": 0.92 },
      tokenActualsByRole: { router: { avgInputTokens: 900, avgOutputTokens: 180 } },
    }),
  ];
  // No rolePricingMap supplied
  const series = computeDrift(ovs);
  const tokenSeries = series.filter((s) => s.assumptionKey.startsWith("token-cost-"));
  assert.equal(tokenSeries.length, 0, "no token-cost series when rolePricingMap is omitted");
  // Other series still present
  assert.ok(series.some((s) => s.assumptionKey === "containment-fc1"), "fc1 series still present");
});

// ---------------------------------------------------------------------------
// repriceRole unit tests
// ---------------------------------------------------------------------------

test("repriceRole: computes correct USD/call from token counts and rates", () => {
  const pricing = DEFAULT_ROLE_PRICING.router!;
  // (1500 × 0.6 + 200 × 2.4) / 1_000_000 = (900 + 480) / 1_000_000 = 0.00138
  const result = repriceRole({ avgInputTokens: 1500, avgOutputTokens: 200 }, pricing);
  assert.ok(Math.abs(result - 0.00138) < 1e-10, `expected 0.00138, got ${result}`);
});

// ---------------------------------------------------------------------------
// formatUsdPerCall unit tests
// ---------------------------------------------------------------------------

test("formatUsdPerCall: sub-cent value shows enough decimals", () => {
  // 0.0014 → 4 decimal places → "$0.0014"
  assert.equal(formatUsdPerCall(0.0014), "$0.0014");
});

test("formatUsdPerCall: larger value like 0.12 shows 2 decimal places", () => {
  assert.equal(formatUsdPerCall(0.12), "$0.12");
});

test("formatUsdPerCall: zero returns $0.00", () => {
  assert.equal(formatUsdPerCall(0), "$0.00");
});

// ---------------------------------------------------------------------------
// DEFAULT_ROLE_PRICING regression — pins every value against the model-catalog
// and assumption-register source of truth.
//
// Source:  artifacts/api-server/src/data/model-catalog.ts  (per-token rates)
//          artifacts/api-server/src/data/assumptions.ts     (defaultPricePerCallUsd)
//
// Default models per role:
//   router    → gpt-5-mini         (slm-call-cost)
//   reasoning → gpt-5              (llm-call-cost)
//   frontier  → claude-opus        (frontier-call-cost)
//   data      → ldm-schema-grounded (data-call-cost)
//
// If any of these assertions fail, update token-pricing.ts to match the
// upstream source file that changed — do NOT just adjust the expected value
// here without also updating the comment pointing at the upstream source.
// ---------------------------------------------------------------------------

test("regression: DEFAULT_ROLE_PRICING.router matches model-catalog gpt-5-mini and slm-call-cost assumption", () => {
  const r = DEFAULT_ROLE_PRICING.router!;
  // assumptions.ts: slm-call-cost.value = 0.002
  assert.equal(r.defaultPricePerCallUsd, 0.002,
    "router defaultPricePerCallUsd must equal assumptions slm-call-cost.value (0.002)");
  // model-catalog.ts: gpt-5-mini rates
  assert.equal(r.inputPricePerMillionTokens, 0.6,
    "router inputPricePerMillionTokens must equal gpt-5-mini catalog rate (0.6)");
  assert.equal(r.outputPricePerMillionTokens, 2.4,
    "router outputPricePerMillionTokens must equal gpt-5-mini catalog rate (2.4)");
});

test("regression: DEFAULT_ROLE_PRICING.reasoning matches model-catalog gpt-5 and llm-call-cost assumption", () => {
  const r = DEFAULT_ROLE_PRICING.reasoning!;
  // assumptions.ts: llm-call-cost.value = 0.02
  assert.equal(r.defaultPricePerCallUsd, 0.02,
    "reasoning defaultPricePerCallUsd must equal assumptions llm-call-cost.value (0.02)");
  // model-catalog.ts: gpt-5 rates
  assert.equal(r.inputPricePerMillionTokens, 2.5,
    "reasoning inputPricePerMillionTokens must equal gpt-5 catalog rate (2.5)");
  assert.equal(r.outputPricePerMillionTokens, 10.0,
    "reasoning outputPricePerMillionTokens must equal gpt-5 catalog rate (10.0)");
});

test("regression: DEFAULT_ROLE_PRICING.frontier matches model-catalog claude-opus and frontier-call-cost assumption", () => {
  const r = DEFAULT_ROLE_PRICING.frontier!;
  // assumptions.ts: frontier-call-cost.value = 0.12
  assert.equal(r.defaultPricePerCallUsd, 0.12,
    "frontier defaultPricePerCallUsd must equal assumptions frontier-call-cost.value (0.12)");
  // model-catalog.ts: claude-opus rates
  assert.equal(r.inputPricePerMillionTokens, 15.0,
    "frontier inputPricePerMillionTokens must equal claude-opus catalog rate (15.0)");
  assert.equal(r.outputPricePerMillionTokens, 75.0,
    "frontier outputPricePerMillionTokens must equal claude-opus catalog rate (75.0)");
});

test("regression: DEFAULT_ROLE_PRICING.data matches model-catalog ldm-schema-grounded and data-call-cost assumption", () => {
  const r = DEFAULT_ROLE_PRICING.data!;
  // assumptions.ts: data-call-cost.value = 0.02
  assert.equal(r.defaultPricePerCallUsd, 0.02,
    "data defaultPricePerCallUsd must equal assumptions data-call-cost.value (0.02)");
  // model-catalog.ts: ldm-schema-grounded rates
  assert.equal(r.inputPricePerMillionTokens, 2.5,
    "data inputPricePerMillionTokens must equal ldm-schema-grounded catalog rate (2.5)");
  assert.equal(r.outputPricePerMillionTokens, 10.0,
    "data outputPricePerMillionTokens must equal ldm-schema-grounded catalog rate (10.0)");
});
