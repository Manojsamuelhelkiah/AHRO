import test from "node:test";
import assert from "node:assert/strict";
import { aggregateCallLog, MIN_ROWS_PER_INTENT } from "./aggregate-log.js";

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

const HEADER =
  "call_id,timestamp,intent_key,contained,hitl_reviewed,hitl_minutes,flow_class,router_input_tokens,router_output_tokens,reasoning_input_tokens,reasoning_output_tokens,frontier_input_tokens,frontier_output_tokens,data_input_tokens,data_output_tokens";

function makeRow(overrides: {
  call_id?: string;
  timestamp?: string;
  intent_key?: string;
  contained?: string;
  hitl_reviewed?: string;
  hitl_minutes?: string;
  flow_class?: string;
  router_input_tokens?: string;
  router_output_tokens?: string;
  reasoning_input_tokens?: string;
  reasoning_output_tokens?: string;
  frontier_input_tokens?: string;
  frontier_output_tokens?: string;
  data_input_tokens?: string;
  data_output_tokens?: string;
}): string {
  const d = {
    call_id: "c1",
    timestamp: "2025-03-15T10:00:00Z",
    intent_key: "payslip-copy",
    contained: "true",
    hitl_reviewed: "false",
    hitl_minutes: "",
    flow_class: "",
    router_input_tokens: "",
    router_output_tokens: "",
    reasoning_input_tokens: "",
    reasoning_output_tokens: "",
    frontier_input_tokens: "",
    frontier_output_tokens: "",
    data_input_tokens: "",
    data_output_tokens: "",
    ...overrides,
  };
  return [
    d.call_id,
    d.timestamp,
    d.intent_key,
    d.contained,
    d.hitl_reviewed,
    d.hitl_minutes,
    d.flow_class,
    d.router_input_tokens,
    d.router_output_tokens,
    d.reasoning_input_tokens,
    d.reasoning_output_tokens,
    d.frontier_input_tokens,
    d.frontier_output_tokens,
    d.data_input_tokens,
    d.data_output_tokens,
  ].join(",");
}

function buildCsv(rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

// Build N rows for an intent, all contained, to clear the threshold
function nContainedRows(
  intentKey: string,
  n: number,
  extras: Record<string, string> = {},
): string[] {
  return Array.from({ length: n }, (_, i) =>
    makeRow({ call_id: `c-${intentKey}-${i}`, intent_key: intentKey, contained: "true", ...extras }),
  );
}

// ---------------------------------------------------------------------------
// Normal case
// ---------------------------------------------------------------------------

test("normal case: per-intent containment, avgHitlMinutes, FC rollup, tokens", () => {
  const rows: string[] = [];

  // payslip-copy — fc1-deterministic — 40 rows: 30 contained, 10 not; 5 with HITL minutes
  for (let i = 0; i < 30; i++) {
    rows.push(makeRow({
      call_id: `ps-cont-${i}`,
      intent_key: "payslip-copy",
      contained: "true",
      hitl_reviewed: i < 5 ? "false" : "false",
      hitl_minutes: i < 5 ? "3.0" : "",
      router_input_tokens: "900",
      router_output_tokens: "120",
    }));
  }
  for (let i = 0; i < 10; i++) {
    rows.push(makeRow({
      call_id: `ps-notcont-${i}`,
      intent_key: "payslip-copy",
      contained: "false",
      hitl_reviewed: i < 3 ? "true" : "false",
    }));
  }

  const csv = buildCsv(rows);
  const result = aggregateCallLog(csv);

  assert.equal(result.totalRows, 40);
  assert.equal(result.deduplicatedRows, 40);

  const intentRow = result.proposedOverlay.intents?.find((i) => i.intentKey === "payslip-copy");
  assert.ok(intentRow, "payslip-copy intent row should be present");
  assert.ok(Math.abs((intentRow.measuredContainmentRate ?? -1) - 0.75) < 1e-9, `expected 0.75 got ${intentRow.measuredContainmentRate}`);
  // avgHitlMinutes: 5 contained rows have 3.0 minutes each
  assert.ok(Math.abs((intentRow.avgHitlMinutes ?? -1) - 3.0) < 1e-9, `expected 3.0 got ${intentRow.avgHitlMinutes}`);

  // FC rollup for fc1-deterministic: 30 contained / 40 total = 0.75
  const fcRate = result.proposedOverlay.measuredContainmentByFlowClass?.["fc1-deterministic"];
  assert.ok(fcRate !== undefined, "fc1-deterministic should be present");
  assert.ok(Math.abs(fcRate - 0.75) < 1e-9, `FC rate expected 0.75 got ${fcRate}`);

  // HITL sampling: 3 uncontained reviewed / 10 uncontained = 0.3
  assert.ok(Math.abs((result.proposedOverlay.measuredHitlSamplingRate ?? -1) - 0.3) < 1e-9);

  // Token averages: only router cols present, 30 rows with values
  const routerTokens = result.proposedOverlay.tokenActualsByRole?.["router"];
  assert.ok(routerTokens, "router token actuals should be present");
  assert.ok(Math.abs(routerTokens.avgInputTokens - 900) < 1e-9);
  assert.ok(Math.abs(routerTokens.avgOutputTokens - 120) < 1e-9);

  // No unknown intents
  assert.equal(result.unknownIntents.length, 0);
});

// ---------------------------------------------------------------------------
// Unknown intents
// ---------------------------------------------------------------------------

test("unknown intents are collected and excluded from intent/FC aggregates", () => {
  const rows: string[] = [
    // 5 rows for a real intent
    ...nContainedRows("payslip-copy", 5),
    // 3 rows for a totally unknown intent
    ...Array.from({ length: 3 }, (_, i) =>
      makeRow({ call_id: `unk-${i}`, intent_key: "unicorn-onboarding", contained: "true" }),
    ),
  ];

  const result = aggregateCallLog(buildCsv(rows));

  assert.equal(result.unknownIntents.length, 1);
  assert.equal(result.unknownIntents[0]!.intentKey, "unicorn-onboarding");
  assert.equal(result.unknownIntents[0]!.rowCount, 3);

  const intentKeys = result.proposedOverlay.intents?.map((r) => r.intentKey) ?? [];
  assert.ok(!intentKeys.includes("unicorn-onboarding"), "unknown intent must not appear in overlay");

  // The unknown intent has no corpus FC so must not appear in FC map
  assert.ok(
    !result.proposedOverlay.measuredContainmentByFlowClass?.["fc1-deterministic"] ||
      result.proposedOverlay.measuredContainmentByFlowClass["fc1-deterministic"] !== undefined,
  );

  // Warning about unknown intents
  assert.ok(result.parseWarnings.some((w) => w.includes("unknown intent")));
});

// ---------------------------------------------------------------------------
// Duplicate call_id
// ---------------------------------------------------------------------------

test("duplicate call_id rows are skipped and counted separately from invalid skips", () => {
  const rows = [
    makeRow({ call_id: "dup-1", intent_key: "payslip-copy", contained: "true" }),
    makeRow({ call_id: "dup-1", intent_key: "payslip-copy", contained: "false" }), // duplicate
    makeRow({ call_id: "dup-2", intent_key: "payslip-copy", contained: "true" }),
  ];
  const result = aggregateCallLog(buildCsv(rows));

  assert.equal(result.totalRows, 3);
  // deduplicatedRows = totalRows - duplicateCount = 3 - 1 = 2
  assert.equal(result.deduplicatedRows, 2, "deduplicatedRows = totalRows - duplicateCount");
  assert.equal(result.duplicateCount, 1, "one call_id seen twice");
  assert.equal(result.invalidRowSkips, 0, "no field-level invalids");

  // Only 2 rows contribute to aggregates: both contained -> 2/2 = 1.0
  const intentRow = result.proposedOverlay.intents?.find((i) => i.intentKey === "payslip-copy");
  assert.ok(intentRow);
  assert.ok(Math.abs((intentRow.measuredContainmentRate ?? -1) - 1.0) < 1e-9);

  assert.ok(result.parseWarnings.some((w) => w.includes("duplicate")));
});

// ---------------------------------------------------------------------------
// Below-threshold intent
// ---------------------------------------------------------------------------

test("below-threshold intent emits measurement but sets belowMinThreshold=true", () => {
  const n = MIN_ROWS_PER_INTENT - 1; // 29 rows — below threshold
  const rows = nContainedRows("payslip-copy", n);
  const result = aggregateCallLog(buildCsv(rows));

  const stat = result.intentStats.find((s) => s.intentKey === "payslip-copy");
  assert.ok(stat, "intentStat should exist");
  assert.equal(stat.belowMinThreshold, true);
  assert.equal(stat.rowCount, n);

  // Measurement is still emitted
  const intentRow = result.proposedOverlay.intents?.find((i) => i.intentKey === "payslip-copy");
  assert.ok(intentRow, "measurement should still be present despite thin sample");
  assert.ok(intentRow.measuredContainmentRate !== undefined);

  // Warning about thin sample
  assert.ok(result.parseWarnings.some((w) => w.includes("payslip-copy") && w.includes("row")));
});

test("at-threshold intent does NOT set belowMinThreshold", () => {
  const rows = nContainedRows("payslip-copy", MIN_ROWS_PER_INTENT);
  const result = aggregateCallLog(buildCsv(rows));
  const stat = result.intentStats.find((s) => s.intentKey === "payslip-copy");
  assert.ok(stat);
  assert.equal(stat.belowMinThreshold, false);
});

// ---------------------------------------------------------------------------
// Blank token columns (role not invoked)
// ---------------------------------------------------------------------------

test("blank token columns are excluded from averages", () => {
  const rows = [
    // Row A: router tokens present
    makeRow({ call_id: "tok-1", intent_key: "payslip-copy", contained: "true", router_input_tokens: "1000", router_output_tokens: "200" }),
    // Row B: router tokens blank — role not invoked
    makeRow({ call_id: "tok-2", intent_key: "payslip-copy", contained: "true", router_input_tokens: "", router_output_tokens: "" }),
    // Row C: reasoning tokens present
    makeRow({ call_id: "tok-3", intent_key: "payslip-copy", contained: "true", reasoning_input_tokens: "4000", reasoning_output_tokens: "600" }),
  ];
  const result = aggregateCallLog(buildCsv(rows));

  // Router: only 1 row with values -> avg = that row's values
  const router = result.proposedOverlay.tokenActualsByRole?.["router"];
  assert.ok(router, "router token actuals should be present");
  assert.ok(Math.abs(router.avgInputTokens - 1000) < 1e-9, `expected 1000 got ${router.avgInputTokens}`);
  assert.ok(Math.abs(router.avgOutputTokens - 200) < 1e-9);

  // Reasoning: 1 row
  const reasoning = result.proposedOverlay.tokenActualsByRole?.["reasoning"];
  assert.ok(reasoning);
  assert.ok(Math.abs(reasoning.avgInputTokens - 4000) < 1e-9);

  // Frontier and data: no rows -> absent from map
  assert.equal(result.proposedOverlay.tokenActualsByRole?.["frontier"], undefined);
  assert.equal(result.proposedOverlay.tokenActualsByRole?.["data"], undefined);
});

// ---------------------------------------------------------------------------
// HITL sampling math
// ---------------------------------------------------------------------------

test("HITL sampling rate = reviewed-and-uncontained / uncontained", () => {
  const rows = [
    // 6 contained rows (do not count for HITL sampling)
    ...nContainedRows("payslip-copy", 6),
    // 4 uncontained rows; 2 of them hitl_reviewed=true
    makeRow({ call_id: "nc-1", intent_key: "payslip-copy", contained: "false", hitl_reviewed: "true" }),
    makeRow({ call_id: "nc-2", intent_key: "payslip-copy", contained: "false", hitl_reviewed: "true" }),
    makeRow({ call_id: "nc-3", intent_key: "payslip-copy", contained: "false", hitl_reviewed: "false" }),
    makeRow({ call_id: "nc-4", intent_key: "payslip-copy", contained: "false", hitl_reviewed: "false" }),
  ];
  const result = aggregateCallLog(buildCsv(rows));

  // 2 reviewed / 4 uncontained = 0.5
  assert.ok(Math.abs((result.proposedOverlay.measuredHitlSamplingRate ?? -1) - 0.5) < 1e-9);
});

test("HITL sampling rate omitted when all calls contained", () => {
  const rows = nContainedRows("payslip-copy", 10);
  const result = aggregateCallLog(buildCsv(rows));
  assert.equal(result.proposedOverlay.measuredHitlSamplingRate, undefined);
});

// ---------------------------------------------------------------------------
// FC rollup
// ---------------------------------------------------------------------------

test("FC rollup aggregates across multiple intents in same flow class", () => {
  // payslip-copy and leave-balance are both fc1-deterministic
  const rows = [
    ...Array.from({ length: 20 }, (_, i) =>
      makeRow({ call_id: `ps-${i}`, intent_key: "payslip-copy", contained: i < 15 ? "true" : "false" })
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      makeRow({ call_id: `lb-${i}`, intent_key: "leave-balance", contained: i < 10 ? "true" : "false" })
    ),
  ];
  const result = aggregateCallLog(buildCsv(rows));

  // fc1: 25 contained / 40 total = 0.625
  const fc1 = result.proposedOverlay.measuredContainmentByFlowClass?.["fc1-deterministic"];
  assert.ok(fc1 !== undefined);
  assert.ok(Math.abs(fc1 - 0.625) < 1e-9, `expected 0.625 got ${fc1}`);
});

test("flow_class column present: uses it instead of corpus lookup", () => {
  const rows = [
    // An intent that IS in corpus (payslip-copy = fc1) but log says fc2
    ...Array.from({ length: 10 }, (_, i) =>
      makeRow({ call_id: `ov-${i}`, intent_key: "payslip-copy", contained: "true", flow_class: "fc2-policy" })
    ),
  ];
  const result = aggregateCallLog(buildCsv(rows));

  // fc2 should be populated from the log column override
  const fc2 = result.proposedOverlay.measuredContainmentByFlowClass?.["fc2-policy"];
  assert.ok(fc2 !== undefined, "fc2-policy should be populated from explicit column");

  // fc1 should be absent (no rows used corpus fc1)
  const fc1 = result.proposedOverlay.measuredContainmentByFlowClass?.["fc1-deterministic"];
  assert.equal(fc1, undefined);
});

// ---------------------------------------------------------------------------
// Period date derivation
// ---------------------------------------------------------------------------

test("periodStart and periodEnd derived from min/max timestamp", () => {
  const rows = [
    makeRow({ call_id: "p1", intent_key: "payslip-copy", contained: "true", timestamp: "2025-01-15T08:00:00Z" }),
    makeRow({ call_id: "p2", intent_key: "payslip-copy", contained: "true", timestamp: "2025-03-28T22:59:00Z" }),
    makeRow({ call_id: "p3", intent_key: "payslip-copy", contained: "true", timestamp: "2025-02-10T12:00:00Z" }),
  ];
  const result = aggregateCallLog(buildCsv(rows));
  assert.equal(result.periodStart, "2025-01-15");
  assert.equal(result.periodEnd, "2025-03-28");
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

test("missing required column returns fatal error in parseWarnings, empty result", () => {
  // Header missing 'contained'
  const badHeader = "call_id,timestamp,intent_key,hitl_reviewed";
  const csv = [badHeader, "c1,2025-01-01T00:00:00Z,payslip-copy,false"].join("\n");
  const result = aggregateCallLog(csv);
  assert.equal(result.totalRows, 0);
  assert.ok(result.parseWarnings.some((w) => w.includes("contained")));
});

test("empty file returns graceful empty result", () => {
  const result = aggregateCallLog("");
  assert.equal(result.totalRows, 0);
  assert.ok(result.parseWarnings.length > 0);
});

test("rows with unparseable contained value counted as invalidRowSkips, not duplicates", () => {
  const rows = [
    makeRow({ call_id: "bad1", intent_key: "payslip-copy", contained: "maybe" }),
    makeRow({ call_id: "bad2", intent_key: "payslip-copy", contained: "yes" }), // "yes" IS accepted
    makeRow({ call_id: "bad3", intent_key: "payslip-copy", contained: "dunno" }),
  ];
  const result = aggregateCallLog(buildCsv(rows));
  // All 3 call_ids are unique → duplicateCount = 0, deduplicatedRows = 3
  assert.equal(result.totalRows, 3);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.deduplicatedRows, 3);
  // 2 rows had bad "contained" (maybe, dunno) → counted as invalidRowSkips
  assert.equal(result.invalidRowSkips, 2);
  assert.ok(result.parseWarnings.some((w) => w.includes("contained")));
});

test("blank call_id rows counted as invalidRowSkips, not duplicates", () => {
  const rows = [
    makeRow({ call_id: "", intent_key: "payslip-copy", contained: "true" }),
    makeRow({ call_id: "ok-1", intent_key: "payslip-copy", contained: "true" }),
  ];
  const result = aggregateCallLog(buildCsv(rows));
  assert.equal(result.totalRows, 2);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.deduplicatedRows, 2);
  assert.equal(result.invalidRowSkips, 1);
  assert.ok(result.parseWarnings.some((w) => w.includes("blank call_id")));
});
