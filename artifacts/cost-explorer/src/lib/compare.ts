/**
 * Pure helpers for the N-scenario compare page.
 * No React, no browser-only globals — safe to test in Node.
 */

// ─── Delta types + core calc ──────────────────────────────────────────────────

export type Favorability = "higher-is-better" | "lower-is-better";

export interface DeltaInfo {
  delta: number;
  pct: number;        // relative to baseline (signed)
  favorable: boolean | null; // null = neutral (zero diff)
  significant: boolean;      // |pct| >= 10 %
}

/**
 * Compute a signed delta of `value` versus `baseline`.
 * @param value     the non-baseline scenario's value
 * @param baseline  the baseline scenario's value
 */
export function calcDelta(
  value: number,
  baseline: number,
  fav: Favorability,
): DeltaInfo {
  const delta = value - baseline;
  const pct = baseline !== 0 ? delta / Math.abs(baseline) : 0;
  const significant = Math.abs(pct) >= 0.1;
  let favorable: boolean | null = null;
  if (Math.abs(delta) > 0.005) {
    favorable = fav === "higher-is-better" ? delta > 0 : delta < 0;
  }
  return { delta, pct, favorable, significant };
}

// ─── Slot-count bounds (exported so component + tests share the same values) ──

export const MIN_SCENARIOS = 2;
export const MAX_SCENARIOS = 5;

// ─── URL helpers ──────────────────────────────────────────────────────────────

export interface CompareUrlState {
  ids: number[];
  baselineId: number | null;
}

/**
 * Serialize the N-scenario compare state into a path + query string.
 * Returns "/compare" when there are no IDs.
 */
export function serializeCompareUrl(
  ids: number[],
  baselineId: number | null,
): string {
  if (ids.length === 0) return "/compare";
  const p = new URLSearchParams();
  p.set("ids", ids.join(","));
  if (baselineId !== null) p.set("baseline", String(baselineId));
  return `/compare?${p.toString()}`;
}

/**
 * Parse `?ids=1,2,3&baseline=1` from a search string.
 * Also migrates the legacy `?a=1&b=2` format: `a` becomes baseline.
 */
export function deserializeCompareUrl(search: string): CompareUrlState {
  const p = new URLSearchParams(search);

  // Legacy migration: ?a=1&b=2
  if (!p.has("ids") && (p.has("a") || p.has("b"))) {
    const parseId = (raw: string | null) => {
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const a = parseId(p.get("a"));
    const b = parseId(p.get("b"));
    const ids: number[] = [];
    if (a !== null) ids.push(a);
    if (b !== null) ids.push(b);
    return { ids, baselineId: a };
  }

  // New scheme: ?ids=1,2,3&baseline=1
  const idsStr = p.get("ids");
  const baselineStr = p.get("baseline");

  const ids = idsStr
    ? idsStr
        .split(",")
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];

  const baselineId = baselineStr
    ? (() => {
        const n = parseInt(baselineStr, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
      })()
    : null;

  return { ids, baselineId };
}

// ─── Slot hydration ───────────────────────────────────────────────────────────

/**
 * Convert a parsed ID list (from the URL) into a slots array ready for the
 * component, respecting the minimum and maximum column counts.
 *
 * - Empty / short list → pad with `null` up to `min`.
 * - Oversized list     → clamp to `max`.
 * - Single-ID links    → `[id, null]` so the second selector is empty.
 *
 * @example
 *   hydrateSlots([])          // [null, null]
 *   hydrateSlots([5])         // [5, null]
 *   hydrateSlots([1, 2, 3])   // [1, 2, 3]
 *   hydrateSlots([1,2,3,4,5,6]) // [1,2,3,4,5]  (capped)
 */
export function hydrateSlots(
  ids: number[],
  min: number = MIN_SCENARIOS,
  max: number = MAX_SCENARIOS,
): (number | null)[] {
  const clamped = ids.slice(0, max);
  const slots: (number | null)[] = [...clamped];
  while (slots.length < min) slots.push(null);
  return slots;
}

// ─── Multi-column intent delta builder ───────────────────────────────────────

/** Minimal rollup row shape needed for delta computation. */
export interface RollupRowSlice {
  intentKey: string;
  intentName: string;
  domain: string;
  netUsd: number;
}

export interface IntentDeltaRow {
  intentKey: string;
  intentName: string;
  domain: string;
  /** netUsd for each slot (indexed same as `slots`). 0 when the intent is absent in that slot. */
  netBySlot: number[];
  /** max |delta vs baseline| across all non-baseline slots — used for sort order. */
  maxAbsDelta: number;
}

/**
 * Build per-intent delta rows for N scenario slots.
 *
 * @param rollupRows  one `RollupRowSlice[]` per slot; `null` when the slot has no rollup yet
 * @param slotCount   total number of slots (length of the slot arrays)
 * @param baselineIdx index of the baseline slot
 */
export function buildIntentDeltas(
  rollupRows: (RollupRowSlice[] | null)[],
  slotCount: number,
  baselineIdx: number,
): IntentDeltaRow[] {
  const baselineRows = rollupRows[baselineIdx];
  if (!baselineRows) return [];

  // Build a union of all intent keys across all loaded slots
  const allKeys = new Set<string>();
  for (const rows of rollupRows) {
    if (rows) rows.forEach((r) => allKeys.add(r.intentKey));
  }

  // Index each slot by intentKey for O(1) lookup
  const maps: Map<string, RollupRowSlice>[] = rollupRows.map((rows) =>
    rows ? new Map(rows.map((r) => [r.intentKey, r])) : new Map(),
  );

  return Array.from(allKeys)
    .map((intentKey) => {
      // Prefer metadata from the baseline; fall back to first slot that has it
      const metaRow =
        maps[baselineIdx].get(intentKey) ??
        maps.find((m) => m.has(intentKey))?.get(intentKey);

      const netBySlot = Array.from({ length: slotCount }, (_, i) =>
        maps[i]?.get(intentKey)?.netUsd ?? 0,
      );
      const baselineNet = netBySlot[baselineIdx] ?? 0;

      const maxAbsDelta = netBySlot.reduce((max, net, i) => {
        if (i === baselineIdx) return max;
        return Math.max(max, Math.abs(net - baselineNet));
      }, 0);

      return {
        intentKey,
        intentName: metaRow?.intentName ?? intentKey,
        domain: metaRow?.domain ?? "",
        netBySlot,
        maxAbsDelta,
      };
    })
    .sort((a, b) => b.maxAbsDelta - a.maxAbsDelta);
}
