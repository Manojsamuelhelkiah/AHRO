import test from "node:test";
import assert from "node:assert/strict";
import {
  calcDelta,
  serializeCompareUrl,
  deserializeCompareUrl,
  buildIntentDeltas,
  hydrateSlots,
  MIN_SCENARIOS,
  MAX_SCENARIOS,
  type RollupRowSlice,
} from "./compare";

// ─── calcDelta ────────────────────────────────────────────────────────────────

test("calcDelta: positive delta is favorable for higher-is-better", () => {
  const d = calcDelta(120, 100, "higher-is-better");
  assert.equal(d.delta, 20);
  assert.ok(Math.abs(d.pct - 0.2) < 1e-12);
  assert.equal(d.favorable, true);
  assert.equal(d.significant, true);
});

test("calcDelta: positive delta is unfavorable for lower-is-better", () => {
  const d = calcDelta(120, 100, "lower-is-better");
  assert.equal(d.delta, 20);
  assert.equal(d.favorable, false);
  assert.equal(d.significant, true);
});

test("calcDelta: negative delta is favorable for lower-is-better", () => {
  const d = calcDelta(80, 100, "lower-is-better");
  assert.equal(d.delta, -20);
  assert.equal(d.favorable, true);
  assert.equal(d.significant, true);
});

test("calcDelta: near-zero delta is neutral (favorable = null)", () => {
  const d = calcDelta(100.001, 100, "higher-is-better");
  assert.equal(d.favorable, null);
});

test("calcDelta: |pct| < 0.1 is not significant", () => {
  // 5% difference
  const d = calcDelta(105, 100, "higher-is-better");
  assert.equal(d.significant, false);
  assert.equal(d.favorable, true);
});

test("calcDelta: zero baseline yields pct = 0", () => {
  const d = calcDelta(50, 0, "higher-is-better");
  assert.equal(d.pct, 0);
  assert.equal(d.delta, 50);
});

// ─── URL serialization ────────────────────────────────────────────────────────

test("serializeCompareUrl: empty ids returns bare /compare", () => {
  assert.equal(serializeCompareUrl([], null), "/compare");
});

test("serializeCompareUrl: single id with baseline", () => {
  const url = serializeCompareUrl([1], 1);
  assert.ok(url.includes("ids=1"));
  assert.ok(url.includes("baseline=1"));
});

test("serializeCompareUrl: multiple ids", () => {
  const url = serializeCompareUrl([3, 7, 12], 7);
  assert.ok(url.includes("ids=3%2C7%2C12") || url.includes("ids=3,7,12"), `unexpected url: ${url}`);
  assert.ok(url.includes("baseline=7"));
});

test("serializeCompareUrl: null baseline omitted", () => {
  const url = serializeCompareUrl([1, 2], null);
  assert.ok(!url.includes("baseline"), `url should not contain baseline: ${url}`);
});

// ─── URL deserialization ──────────────────────────────────────────────────────

test("deserializeCompareUrl: new scheme round-trips", () => {
  const url = serializeCompareUrl([1, 2, 3], 2);
  const qs = url.replace("/compare", "");
  const parsed = deserializeCompareUrl(qs);
  assert.deepEqual(parsed.ids, [1, 2, 3]);
  assert.equal(parsed.baselineId, 2);
});

test("deserializeCompareUrl: legacy ?a=&b= migrates to ids with a as baseline", () => {
  const parsed = deserializeCompareUrl("?a=5&b=9");
  assert.deepEqual(parsed.ids, [5, 9]);
  assert.equal(parsed.baselineId, 5);
});

test("deserializeCompareUrl: legacy ?a= only", () => {
  const parsed = deserializeCompareUrl("?a=3");
  assert.deepEqual(parsed.ids, [3]);
  assert.equal(parsed.baselineId, 3);
});

test("deserializeCompareUrl: empty string returns empty state", () => {
  const parsed = deserializeCompareUrl("");
  assert.deepEqual(parsed.ids, []);
  assert.equal(parsed.baselineId, null);
});

test("deserializeCompareUrl: invalid ids are filtered out", () => {
  const parsed = deserializeCompareUrl("?ids=1,abc,3&baseline=1");
  assert.deepEqual(parsed.ids, [1, 3]);
  assert.equal(parsed.baselineId, 1);
});

test("deserializeCompareUrl: new scheme takes precedence over legacy params", () => {
  // Both present — new scheme wins
  const parsed = deserializeCompareUrl("?ids=10,20&baseline=10&a=99&b=88");
  assert.deepEqual(parsed.ids, [10, 20]);
  assert.equal(parsed.baselineId, 10);
});

// ─── buildIntentDeltas ────────────────────────────────────────────────────────

const row = (intentKey: string, netUsd: number): RollupRowSlice => ({
  intentKey,
  intentName: intentKey,
  domain: "test",
  netUsd,
});

test("buildIntentDeltas: returns empty when baseline has no rollup", () => {
  const result = buildIntentDeltas([null, [row("a", 100)]], 2, 0);
  assert.equal(result.length, 0);
});

test("buildIntentDeltas: computes netBySlot correctly", () => {
  const rows0 = [row("a", 200), row("b", 100)];
  const rows1 = [row("a", 150), row("b", 120)];
  const result = buildIntentDeltas([rows0, rows1], 2, 0);
  assert.equal(result.length, 2);
  const a = result.find((r) => r.intentKey === "a")!;
  assert.deepEqual(a.netBySlot, [200, 150]);
  const b = result.find((r) => r.intentKey === "b")!;
  assert.deepEqual(b.netBySlot, [100, 120]);
});

test("buildIntentDeltas: maxAbsDelta is 0 for baseline slot itself", () => {
  const rows0 = [row("a", 100)];
  const rows1 = [row("a", 200)];
  const result = buildIntentDeltas([rows0, rows1], 2, 0);
  const a = result.find((r) => r.intentKey === "a")!;
  assert.equal(a.maxAbsDelta, 100);
});

test("buildIntentDeltas: sorts by maxAbsDelta descending", () => {
  // intent "x" differs by 500, intent "y" by 10
  const rows0 = [row("x", 1000), row("y", 50)];
  const rows1 = [row("x", 500), row("y", 60)];
  const result = buildIntentDeltas([rows0, rows1], 2, 0);
  assert.equal(result[0]!.intentKey, "x");
  assert.equal(result[1]!.intentKey, "y");
});

test("buildIntentDeltas: missing intent in a non-baseline slot gets netUsd 0", () => {
  const rows0 = [row("a", 300), row("b", 100)];
  const rows1 = [row("a", 250)]; // "b" absent
  const result = buildIntentDeltas([rows0, rows1], 2, 0);
  const b = result.find((r) => r.intentKey === "b")!;
  assert.deepEqual(b.netBySlot, [100, 0]);
  assert.equal(b.maxAbsDelta, 100);
});

// ─── hydrateSlots ─────────────────────────────────────────────────────────────

test("hydrateSlots: empty ids yields two null slots (minimum)", () => {
  assert.deepEqual(hydrateSlots([]), [null, null]);
});

test("hydrateSlots: single id yields [id, null] — the fix case", () => {
  assert.deepEqual(hydrateSlots([5]), [5, null]);
});

test("hydrateSlots: two ids returned as-is", () => {
  assert.deepEqual(hydrateSlots([1, 2]), [1, 2]);
});

test("hydrateSlots: three ids returned as-is (no padding needed)", () => {
  assert.deepEqual(hydrateSlots([1, 2, 3]), [1, 2, 3]);
});

test("hydrateSlots: more than MAX_SCENARIOS ids are clamped", () => {
  const ids = [1, 2, 3, 4, 5, 6, 7];
  const result = hydrateSlots(ids);
  assert.equal(result.length, MAX_SCENARIOS);
  assert.deepEqual(result, [1, 2, 3, 4, 5]);
});

test("hydrateSlots: exactly MAX_SCENARIOS ids — no truncation, no padding", () => {
  const ids = [1, 2, 3, 4, 5];
  assert.deepEqual(hydrateSlots(ids), [1, 2, 3, 4, 5]);
});

test("hydrateSlots: custom min/max bounds respected", () => {
  assert.deepEqual(hydrateSlots([], 3, 4), [null, null, null]);
  assert.deepEqual(hydrateSlots([1], 3, 4), [1, null, null]);
  assert.deepEqual(hydrateSlots([1, 2, 3, 4, 5], 2, 3), [1, 2, 3]);
});

// ─── Scenario-page URL round-trip ─────────────────────────────────────────────
// scenario.tsx links to /compare?ids=<id>&baseline=<id> for a single scenario.
// Verifies the full pipeline from link generation → parse → hydrate.

test("scenario page single-ID link round-trips into [id, null] slots", () => {
  const scenarioId = 42;

  // What scenario.tsx generates:
  const url = serializeCompareUrl([scenarioId], scenarioId);
  assert.ok(url.includes(`ids=${scenarioId}`), `url missing ids param: ${url}`);
  assert.ok(url.includes(`baseline=${scenarioId}`), `url missing baseline param: ${url}`);

  // What the compare page parses on mount:
  const qs = url.replace("/compare", "");
  const { ids, baselineId } = deserializeCompareUrl(qs);
  assert.deepEqual(ids, [scenarioId]);
  assert.equal(baselineId, scenarioId);

  // What hydrateSlots produces for the component:
  const slots = hydrateSlots(ids, MIN_SCENARIOS, MAX_SCENARIOS);
  assert.deepEqual(slots, [scenarioId, null]);
  assert.equal(slots.length, MIN_SCENARIOS);
});

test("legacy ?a=&b= link round-trips correctly through hydrateSlots", () => {
  const { ids, baselineId } = deserializeCompareUrl("?a=3&b=7");
  assert.deepEqual(ids, [3, 7]);
  assert.equal(baselineId, 3);
  const slots = hydrateSlots(ids, MIN_SCENARIOS, MAX_SCENARIOS);
  assert.deepEqual(slots, [3, 7]);
});

// ─── buildIntentDeltas (continued) ────────────────────────────────────────────

test("buildIntentDeltas: 3-slot scenario with baseline in middle", () => {
  const rows0 = [row("a", 50)];   // slot 0: 50
  const rows1 = [row("a", 100)];  // slot 1: 100 (baseline)
  const rows2 = [row("a", 130)];  // slot 2: 130
  const result = buildIntentDeltas([rows0, rows1, rows2], 3, 1);
  const a = result.find((r) => r.intentKey === "a")!;
  assert.deepEqual(a.netBySlot, [50, 100, 130]);
  // deltas vs baseline (100): |-50| = 50, |+30| = 30 → max = 50
  assert.equal(a.maxAbsDelta, 50);
});
