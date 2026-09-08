/**
 * Raw call-log aggregation for the actuals import feature.
 *
 * Input: raw call-log CSV text, one row per call/transaction.
 * Output: a proposed ActualsOverlayInput plus parse diagnostics.
 *
 * Column definitions (header row required):
 *   call_id            - string, required for deduplication
 *   timestamp          - ISO-8601 datetime (optional; used to derive period range)
 *   intent_key         - string (required)
 *   contained          - "true"/"false"/"1"/"0" (required)
 *   hitl_reviewed      - "true"/"false"/"1"/"0" (optional, blank = false)
 *   hitl_minutes       - number >= 0 (optional, blank = not reviewed)
 *   flow_class         - fc1-deterministic|fc2-policy|fc3-multiagent|fc4-frontier (optional)
 *   router_input_tokens, router_output_tokens
 *   reasoning_input_tokens, reasoning_output_tokens
 *   frontier_input_tokens, frontier_output_tokens
 *   data_input_tokens, data_output_tokens
 *
 * Aggregation rules:
 *   - Duplicate call_id rows are skipped (first occurrence kept); counted in warnings.
 *   - Per-intent containment = count(contained=true) / count(all rows for intent)
 *   - Per-intent avgHitlMinutes = mean(hitl_minutes where contained=true AND hitl_minutes present)
 *   - Flow-class containment = count(contained=true) / count(all rows in FC); FC derived from
 *     flow_class column (if present) otherwise looked up from intent corpus for known intents.
 *     Unknown intents with no flow_class are excluded from FC aggregates.
 *   - Global HITL sampling rate = count(hitl_reviewed=true AND contained=false) / count(contained=false)
 *     Omitted from result if count(contained=false) = 0.
 *   - Token averages: mean only over rows where the column is non-blank (blank = role not invoked).
 *   - Intents with < 30 rows emit measurements with belowMinThreshold=true in intentStats.
 */

import { intentMap } from "../data/intents";
import type { Intent } from "../data/types";

export const MIN_ROWS_PER_INTENT = 30;

const TOKEN_ROLES = ["router", "reasoning", "frontier", "data"] as const;
type TokenRole = (typeof TOKEN_ROLES)[number];

const VALID_FLOW_CLASSES = new Set([
  "fc1-deterministic",
  "fc2-policy",
  "fc3-multiagent",
  "fc4-frontier",
]);

/** Columns that must be present in the header */
const REQUIRED_COLUMNS = ["call_id", "intent_key", "contained"] as const;

/** All token column names */
const TOKEN_COLUMNS: string[] = TOKEN_ROLES.flatMap((r) => [
  `${r}_input_tokens`,
  `${r}_output_tokens`,
]);

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface IntentStat {
  intentKey: string;
  rowCount: number;
  belowMinThreshold: boolean;
}

export interface UnknownIntent {
  intentKey: string;
  rowCount: number;
}

export interface LogParseResult {
  proposedOverlay: {
    intents?: Array<{
      intentKey: string;
      measuredContainmentRate?: number;
      avgHitlMinutes?: number;
    }>;
    measuredContainmentByFlowClass?: Record<string, number>;
    measuredHitlSamplingRate?: number;
    tokenActualsByRole?: Record<string, { avgInputTokens: number; avgOutputTokens: number }>;
  };
  /** ISO date string YYYY-MM-DD derived from min(timestamp), null if no valid timestamps */
  periodStart: string | null;
  /** ISO date string YYYY-MM-DD derived from max(timestamp), null if no valid timestamps */
  periodEnd: string | null;
  /** Total non-blank data rows found in the file before any filtering. */
  totalRows: number;
  /**
   * Rows remaining after removing exact call_id duplicates
   * (totalRows − duplicateCount). Some of these may still be invalid.
   */
  deduplicatedRows: number;
  /** Number of rows skipped because their call_id was already seen. */
  duplicateCount: number;
  /**
   * Number of unique-call_id rows skipped due to data quality issues
   * (blank call_id, blank intent_key, unrecognisable contained value, etc.).
   * These are tracked separately from duplicates.
   */
  invalidRowSkips: number;
  intentStats: IntentStat[];
  unknownIntents: UnknownIntent[];
  parseWarnings: string[];
}

// ---------------------------------------------------------------------------
// CSV parsing helpers
// ---------------------------------------------------------------------------

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === "," && !inQuote) {
      fields.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

function parseBool(v: string): boolean | null {
  const lv = v.toLowerCase().trim();
  if (lv === "true" || lv === "1" || lv === "yes") return true;
  if (lv === "false" || lv === "0" || lv === "no" || lv === "") return false;
  return null;
}

function parseNum(v: string): number | null {
  if (v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDateString(iso: string): string {
  // Extract YYYY-MM-DD prefix from any ISO-8601 string
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Per-row accumulator types (internal)
// ---------------------------------------------------------------------------

interface IntentAccum {
  total: number;
  contained: number;
  hitlMinutesSum: number;
  hitlMinutesCount: number;
  // FC for this intent (determined per-row from log or corpus)
  fc: string | null;
}

interface FcAccum {
  total: number;
  contained: number;
}

interface TokenAccum {
  inputSum: number;
  inputCount: number;
  outputSum: number;
  outputCount: number;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function aggregateCallLog(
  csvText: string,
  extraIntents: readonly Intent[] = [],
): LogParseResult {
  const completeIntentMap: Record<string, Intent> = {
    ...intentMap,
    ...Object.fromEntries(extraIntents.map((intent) => [intent.key, intent])),
  };
  const warnings: string[] = [];

  const rawLines = csvText.split(/\r?\n/);
  if (rawLines.length === 0) {
    return emptyResult(["Log file is empty"], 0);
  }

  // Find header line (first non-blank, non-comment line)
  let headerIdx = -1;
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i]!.trim();
    if (l && !l.startsWith("#") && !l.startsWith("//")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return emptyResult(["Log file has no header row"], 0);
  }

  const headers = splitCsvLine(rawLines[headerIdx]!).map((h) => h.toLowerCase().trim());

  // Validate required columns
  for (const req of REQUIRED_COLUMNS) {
    if (!headers.includes(req)) {
      return emptyResult([`Missing required column: "${req}". Required: ${REQUIRED_COLUMNS.join(", ")}`], 0);
    }
  }

  const col = (name: string) => headers.indexOf(name);
  const COL_CALL_ID = col("call_id");
  const COL_TIMESTAMP = col("timestamp");
  const COL_INTENT = col("intent_key");
  const COL_CONTAINED = col("contained");
  const COL_HITL_REVIEWED = col("hitl_reviewed");
  const COL_HITL_MINUTES = col("hitl_minutes");
  const COL_FLOW_CLASS = col("flow_class");
  const TOKEN_COLS: Record<string, number> = {};
  for (const tc of TOKEN_COLUMNS) {
    const idx = col(tc);
    if (idx !== -1) TOKEN_COLS[tc] = idx;
  }

  // Accumulators
  const seenCallIds = new Set<string>();
  let totalRows = 0;
  let duplicateCount = 0;
  let invalidRowSkips = 0;

  const intentAccums = new Map<string, IntentAccum>();
  const unknownIntentCounts = new Map<string, number>();
  const fcAccums = new Map<string, FcAccum>();
  const tokenAccums = new Map<TokenRole, TokenAccum>();
  for (const role of TOKEN_ROLES) {
    tokenAccums.set(role, { inputSum: 0, inputCount: 0, outputSum: 0, outputCount: 0 });
  }

  let hitlReviewedAndUncontainedCount = 0;
  let uncontainedCount = 0;

  let minTs: number | null = null;
  let maxTs: number | null = null;

  const dataLines = rawLines.slice(headerIdx + 1);

  for (let lineIdx = 0; lineIdx < dataLines.length; lineIdx++) {
    const raw = dataLines[lineIdx]!.trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("//")) continue;

    totalRows++;
    const fields = splitCsvLine(raw);
    const get = (idx: number) => (idx === -1 ? "" : (fields[idx] ?? "").trim());

    // Deduplication
    const callId = get(COL_CALL_ID);
    if (!callId) {
      warnings.push(`Row ${lineIdx + 2}: blank call_id — row skipped`);
      invalidRowSkips++;
      continue;
    }
    if (seenCallIds.has(callId)) {
      duplicateCount++;
      continue;
    }
    seenCallIds.add(callId);

    // Timestamp
    const tsRaw = get(COL_TIMESTAMP);
    if (tsRaw) {
      const ts = Date.parse(tsRaw);
      if (!Number.isNaN(ts)) {
        minTs = minTs === null ? ts : Math.min(minTs, ts);
        maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
      }
    }

    // Intent key
    const intentKey = get(COL_INTENT);
    if (!intentKey) {
      warnings.push(`Row ${lineIdx + 2}: blank intent_key — row skipped`);
      invalidRowSkips++;
      continue;
    }

    // contained
    const containedRaw = get(COL_CONTAINED);
    const contained = parseBool(containedRaw);
    if (contained === null) {
      warnings.push(`Row ${lineIdx + 2}: unrecognised "contained" value "${containedRaw}" (expected true/false/1/0) — row skipped`);
      invalidRowSkips++;
      continue;
    }

    // hitl_reviewed
    const hitlReviewedRaw = get(COL_HITL_REVIEWED);
    const hitlReviewed = hitlReviewedRaw === "" ? false : (parseBool(hitlReviewedRaw) ?? false);

    // hitl_minutes
    const hitlMinRaw = get(COL_HITL_MINUTES);
    const hitlMin = parseNum(hitlMinRaw);
    if (hitlMin !== null && hitlMin < 0) {
      warnings.push(`Row ${lineIdx + 2}: negative hitl_minutes "${hitlMinRaw}" — field ignored`);
    }
    const validHitlMin = hitlMin !== null && hitlMin >= 0 ? hitlMin : null;

    // Flow class: from column (if present) else from corpus
    const logFc = get(COL_FLOW_CLASS);
    let resolvedFc: string | null = null;
    if (logFc && VALID_FLOW_CLASSES.has(logFc)) {
      resolvedFc = logFc;
    } else if (logFc && !VALID_FLOW_CLASSES.has(logFc)) {
      warnings.push(`Row ${lineIdx + 2}: unrecognised flow_class "${logFc}" — falling back to corpus lookup`);
      resolvedFc = completeIntentMap[intentKey]?.flowClass ?? null;
    } else {
      // No flow_class column or blank value — use corpus
      resolvedFc = completeIntentMap[intentKey]?.flowClass ?? null;
    }

    // Known vs unknown intent
    const isKnown = !!completeIntentMap[intentKey];
    if (!isKnown) {
      unknownIntentCounts.set(intentKey, (unknownIntentCounts.get(intentKey) ?? 0) + 1);
      // Unknown intents still contribute to token aggregates (role invoking is independent of intent)
    } else {
      // Intent accumulator
      if (!intentAccums.has(intentKey)) {
        intentAccums.set(intentKey, {
          total: 0,
          contained: 0,
          hitlMinutesSum: 0,
          hitlMinutesCount: 0,
          fc: resolvedFc,
        });
      }
      const acc = intentAccums.get(intentKey)!;
      acc.total++;
      if (contained) acc.contained++;
      if (contained && validHitlMin !== null) {
        acc.hitlMinutesSum += validHitlMin;
        acc.hitlMinutesCount++;
      }
      // Update FC if not yet set (could be derived later in log)
      if (!acc.fc && resolvedFc) acc.fc = resolvedFc;

      // FC accumulator (known intents only, and only if FC is determinable)
      if (resolvedFc) {
        if (!fcAccums.has(resolvedFc)) fcAccums.set(resolvedFc, { total: 0, contained: 0 });
        const fc = fcAccums.get(resolvedFc)!;
        fc.total++;
        if (contained) fc.contained++;
      }
    }

    // Row passed dedup and field validation — counted in aggregates

    // HITL sampling (all rows, contained=false denominator)
    if (!contained) {
      uncontainedCount++;
      if (hitlReviewed) hitlReviewedAndUncontainedCount++;
    }

    // Token accumulators (all rows — role invoked independently of intent knowledge)
    for (const role of TOKEN_ROLES) {
      const inputRaw = get(TOKEN_COLS[`${role}_input_tokens`] ?? -1);
      const outputRaw = get(TOKEN_COLS[`${role}_output_tokens`] ?? -1);
      const inputVal = parseNum(inputRaw);
      const outputVal = parseNum(outputRaw);
      const acc = tokenAccums.get(role)!;
      if (inputVal !== null && inputVal >= 0) {
        acc.inputSum += inputVal;
        acc.inputCount++;
      }
      if (outputVal !== null && outputVal >= 0) {
        acc.outputSum += outputVal;
        acc.outputCount++;
      }
    }
  }

  const deduplicatedRows = totalRows - duplicateCount;

  if (duplicateCount > 0) {
    warnings.push(`${duplicateCount} duplicate call_id row${duplicateCount !== 1 ? "s" : ""} skipped`);
  }

  // Build proposed overlay
  const proposedOverlay: LogParseResult["proposedOverlay"] = {};

  // Per-intent measurements
  const intentStats: IntentStat[] = [];
  const intentRows: NonNullable<LogParseResult["proposedOverlay"]["intents"]> = [];

  for (const [intentKey, acc] of intentAccums) {
    const belowMinThreshold = acc.total < MIN_ROWS_PER_INTENT;
    if (belowMinThreshold) {
      warnings.push(`Intent "${intentKey}" has only ${acc.total} row${acc.total !== 1 ? "s" : ""} (< ${MIN_ROWS_PER_INTENT} recommended) — measurement emitted but flagged`);
    }
    intentStats.push({ intentKey, rowCount: acc.total, belowMinThreshold });

    const row: (typeof intentRows)[number] = { intentKey };
    row.measuredContainmentRate = acc.contained / acc.total;
    if (acc.hitlMinutesCount > 0) {
      row.avgHitlMinutes = acc.hitlMinutesSum / acc.hitlMinutesCount;
    }
    intentRows.push(row);
  }

  if (intentRows.length > 0) proposedOverlay.intents = intentRows;

  // FC containment
  const fcMap: Record<string, number> = {};
  for (const [fc, acc] of fcAccums) {
    if (acc.total > 0) fcMap[fc] = acc.contained / acc.total;
  }
  if (Object.keys(fcMap).length > 0) proposedOverlay.measuredContainmentByFlowClass = fcMap;

  // HITL sampling rate
  if (uncontainedCount > 0) {
    proposedOverlay.measuredHitlSamplingRate = hitlReviewedAndUncontainedCount / uncontainedCount;
  }

  // Token averages per role
  const tokenMap: Record<string, { avgInputTokens: number; avgOutputTokens: number }> = {};
  for (const role of TOKEN_ROLES) {
    const acc = tokenAccums.get(role)!;
    if (acc.inputCount > 0 || acc.outputCount > 0) {
      tokenMap[role] = {
        avgInputTokens: acc.inputCount > 0 ? acc.inputSum / acc.inputCount : 0,
        avgOutputTokens: acc.outputCount > 0 ? acc.outputSum / acc.outputCount : 0,
      };
    }
  }
  if (Object.keys(tokenMap).length > 0) proposedOverlay.tokenActualsByRole = tokenMap;

  // Unknown intents
  const unknownIntents: UnknownIntent[] = [];
  for (const [intentKey, rowCount] of unknownIntentCounts) {
    unknownIntents.push({ intentKey, rowCount });
  }
  if (unknownIntents.length > 0) {
    const total = unknownIntents.reduce((s, u) => s + u.rowCount, 0);
    warnings.push(
      `${unknownIntents.length} unknown intent key${unknownIntents.length !== 1 ? "s" : ""} (${total} row${total !== 1 ? "s" : ""}) excluded from per-intent and FC aggregates — see unknownIntents list`,
    );
  }

  return {
    proposedOverlay,
    periodStart: minTs !== null ? toDateString(new Date(minTs).toISOString()) : null,
    periodEnd: maxTs !== null ? toDateString(new Date(maxTs).toISOString()) : null,
    totalRows,
    deduplicatedRows,
    duplicateCount,
    invalidRowSkips,
    intentStats,
    unknownIntents,
    parseWarnings: warnings,
  };
}

function emptyResult(warnings: string[], totalRows: number): LogParseResult {
  return {
    proposedOverlay: {},
    periodStart: null,
    periodEnd: null,
    totalRows,
    deduplicatedRows: 0,
    duplicateCount: 0,
    invalidRowSkips: 0,
    intentStats: [],
    unknownIntents: [],
    parseWarnings: warnings,
  };
}
