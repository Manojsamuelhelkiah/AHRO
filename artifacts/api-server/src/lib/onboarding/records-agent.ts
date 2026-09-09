/**
 * LDM (large database model) records agent.
 *
 * The engine-tag separation in this project:
 *   - "rules"  — deterministic policy rule tables (no AI).
 *   - "llm"    — language work (conversation, drafting, question forming).
 *   - "ldm"    — THIS agent: it receives natural-language questions from an
 *                LLM agent, uses a model to interpret each question into a
 *                structured query plan over the archived employment records,
 *                then EXECUTES that plan deterministically in code. The
 *                intelligence is only in understanding the question — the
 *                numbers always come from the database, never from the model.
 *
 * Demo use case: rehires. When intake detects a rehire, the LLM agent asks
 * things like "did the employee serve full notice in every past stint?" and
 * the LDM agent answers from the archive, attaching evidence to the HR
 * escalation.
 */
import { db } from "@workspace/db";
import { DEMO_ORGANIZATION_ID, onbEmployeeRecords } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { llmComplete, llmCompleteJson } from "./llm";

export type StintRow = typeof onbEmployeeRecords.$inferSelect;

/* ------------------------------ archive ------------------------------ */

/**
 * Seed a synthetic two-stint archive for a DEMO rehire (scenario or
 * volunteer persona cases only — manually-created rehires get an honest
 * "no archived records" answer instead of fabricated history).
 */
export async function ensureDemoRehireArchive(
  workerEmail: string,
  workerName: string,
  organizationId = DEMO_ORGANIZATION_ID,
): Promise<void> {
  const email = workerEmail.trim().toLowerCase();
  // Concurrent seeders are safe: the (worker_email, start_date) unique
  // index makes this an idempotent no-op insert, never a duplicate stint.
  await db.insert(onbEmployeeRecords).values([
    {
      organizationId,
      workerEmail: email,
      workerName,
      role: "Business Analyst",
      department: "Consulting",
      startDate: "2016-04-11",
      endDate: "2018-10-31",
      exitReason: "Resignation — higher studies",
      noticeRequiredDays: 60,
      noticeServedDays: 60,
      performanceRating: "3.8",
      rehireEligible: true,
      notes: "Left in good standing; exit interview positive.",
    },
    {
      organizationId,
      workerEmail: email,
      workerName,
      role: "Senior Business Analyst",
      department: "Consulting",
      startDate: "2019-06-03",
      endDate: "2024-02-29",
      exitReason: "Resignation — offer from competitor",
      noticeRequiredDays: 90,
      noticeServedDays: 62,
      performanceRating: "4.3",
      rehireEligible: true,
      notes: "Notice partially bought out by joining employer (28 days).",
    },
  ]).onConflictDoNothing({
    target: [
      onbEmployeeRecords.organizationId,
      onbEmployeeRecords.workerEmail,
      onbEmployeeRecords.startDate,
    ],
  });
}

export async function getArchivedStints(
  workerEmail: string,
  organizationId = DEMO_ORGANIZATION_ID,
): Promise<StintRow[]> {
  return await db
    .select()
    .from(onbEmployeeRecords)
    .where(and(
      eq(onbEmployeeRecords.workerEmail, workerEmail.trim().toLowerCase()),
      eq(onbEmployeeRecords.organizationId, organizationId),
    ))
    .orderBy(onbEmployeeRecords.startDate);
}

/* ------------------------- LLM: ask questions ------------------------ */

const DEFAULT_QUESTIONS = [
  "Did the employee serve the full notice period in every past stint?",
  "What was the average performance rating across all stints?",
  "Was the employee marked rehire-eligible at every exit?",
];

/** The LLM agent formulates what it wants to know (falls back to a fixed set). */
export async function formulateRecordsQuestions(caseContext: string): Promise<{ questions: string[]; viaLlm: boolean }> {
  const out = await llmCompleteJson<{ questions: string[] }>(
    'You are the reasoning agent in an HR onboarding system. A rehire was detected. Given the case context, produce the 3 most decision-relevant questions to ask the employment-records archive about the candidate\'s past stints. The archive knows, per stint: dates, role, department, exit reason, notice required vs served (days), final performance rating (1-5), rehire-eligibility flag. Return JSON {"questions": ["...","...","..."]}. Questions must be answerable from those fields only.',
    caseContext,
    400,
  );
  const qs = (out?.questions ?? []).filter((q) => typeof q === "string" && q.trim().length > 5).slice(0, 4);
  return qs.length > 0 ? { questions: qs, viaLlm: true } : { questions: DEFAULT_QUESTIONS, viaLlm: false };
}

/* ---------------- LDM: interpret question -> query plan -------------- */

/** Optional stint filter: scope a metric to one specific past stint. */
export type StintFilter =
  | "latest"
  | "earliest"
  | { yearRange: { from?: number; to?: number } };

/** Constrained query-plan vocabulary the model may emit. Execution is code, not the model. */
export type QueryPlan = {
  metric:
    | "notice_served_in_full_all_stints"
    | "notice_shortfall_by_stint"
    | "avg_performance_rating"
    | "performance_rating_by_stint"
    | "rehire_eligible_all_exits"
    | "exit_reasons"
    | "total_tenure_months"
    | "stint_count"
    | "list_stints"
    | "compare_stints"
    | "rating_trend";
  /** When present, the metric is computed over just the matching stint(s). */
  filter?: { stint: StintFilter };
  /** Only for "compare_stints": the two stints to compare (defaults to earliest vs latest). */
  compare?: { a?: StintFilter; b?: StintFilter };
};

const METRICS: QueryPlan["metric"][] = [
  "notice_served_in_full_all_stints",
  "notice_shortfall_by_stint",
  "avg_performance_rating",
  "performance_rating_by_stint",
  "rehire_eligible_all_exits",
  "exit_reasons",
  "total_tenure_months",
  "stint_count",
  "list_stints",
  "compare_stints",
  "rating_trend",
];

async function interpretQuestion(question: string): Promise<QueryPlan | null> {
  const out = await llmCompleteJson<{ metric: string; filter?: { stint?: unknown }; compare?: { a?: unknown; b?: unknown } }>(
    `You are a large-database-model agent. Map the analyst's question to EXACTLY ONE metric from this list (return JSON {"metric":"..."}):\n${METRICS.join("\n")}\nPick the closest match; if nothing fits, use "list_stints".\nIf the question is about ONE specific past stint (not the whole history), also add a filter:\n- most recent / last stint: {"filter":{"stint":"latest"}}\n- first / earliest stint: {"filter":{"stint":"earliest"}}\n- a stint identified by years, e.g. "the 2019-2024 stint": {"filter":{"stint":{"yearRange":{"from":2019,"to":2024}}}} (either bound may be omitted).\nOmit the filter entirely when the question covers all stints.\nIf the question COMPARES two stints (e.g. "did performance improve between the two stints?", "was notice compliance better the second time?", "which stint was longer?"), use metric "compare_stints" and add {"compare":{"a":<selector>,"b":<selector>}} where each selector uses the same shapes as the stint filter ("earliest", "latest", or {"yearRange":{...}}). When the question just compares first vs last, use a="earliest", b="latest" (or omit "compare" — that is the default).\nIf the question asks about the DIRECTION of performance across the WHOLE history (e.g. "has performance improved consistently?", "is the rating trending up or down?", "did ratings keep getting better each time?"), use metric "rating_trend" instead of "compare_stints" — compare_stints is only for pitting exactly two specific stints against each other.`,
    question,
    400,
  );
  const metric = METRICS.find((m) => m === out?.metric);
  if (!metric) return null;
  const plan: QueryPlan = { metric };
  const rawStint = out?.filter?.stint;
  if (rawStint !== undefined) plan.filter = { stint: rawStint as StintFilter };
  if (metric === "compare_stints" && out?.compare && typeof out.compare === "object") {
    plan.compare = {
      a: out.compare.a as StintFilter | undefined,
      b: out.compare.b as StintFilter | undefined,
    };
  }
  return plan;
}

/* --------------------- deterministic plan execution ------------------ */

function months(a: string, b: string): number {
  const s = new Date(a), e = new Date(b);
  return Math.max(0, Math.round((e.getTime() - s.getTime()) / (30.44 * 24 * 3600 * 1000)));
}

/**
 * Structured description of which stints an answer was computed over.
 * `kind: "all"` covers both "no filter" and every fallback-to-all case, so
 * consumers can rely on it meaning "the whole archived history".
 */
export type RecordsScope =
  | { kind: "all" }
  | { kind: "latest" }
  | { kind: "earliest" }
  | { kind: "yearRange"; from?: number; to?: number };
/**
 * Apply an optional stint filter deterministically. Unknown/unmatchable
 * filters fall back to all stints, with a note explaining the fallback.
 */
export function applyStintFilter(
  stints: StintRow[],
  filter: QueryPlan["filter"],
): { stints: StintRow[]; note: string | null; scope: RecordsScope } {
  if (!filter || filter.stint === undefined || filter.stint === null) return { stints, note: null, scope: SCOPE_ALL };
  // Rows are ordered by startDate ascending at the DB, but sort defensively.
  const sorted = [...stints].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const f = filter.stint;
  if (f === "latest") {
    return { stints: sorted.slice(-1), note: "(scoped to the most recent stint)", scope: { kind: "latest" } };
  }
  if (f === "earliest") {
    return { stints: sorted.slice(0, 1), note: "(scoped to the earliest stint)", scope: { kind: "earliest" } };
  }
  if (typeof f === "object" && f !== null && "yearRange" in f && typeof f.yearRange === "object" && f.yearRange !== null) {
    const from = Number((f.yearRange as { from?: unknown }).from);
    const to = Number((f.yearRange as { to?: unknown }).to);
    const hasFrom = Number.isFinite(from);
    const hasTo = Number.isFinite(to);
    if (hasFrom || hasTo) {
      const matched = sorted.filter((s) => {
        const startYear = Number(s.startDate.slice(0, 4));
        const endYear = Number(s.endDate.slice(0, 4));
        // Stint overlaps the requested year window.
        return (!hasTo || startYear <= to) && (!hasFrom || endYear >= from);
      });
      if (matched.length > 0) {
        const label = hasFrom && hasTo ? `${from}–${to}` : hasFrom ? `from ${from}` : `to ${to}`;
        const scope: RecordsScope = { kind: "yearRange", ...(hasFrom ? { from } : {}), ...(hasTo ? { to } : {}) };
        return { stints: matched, note: `(scoped to the ${label} stint${matched.length > 1 ? "s" : ""})`, scope };
      }
      return { stints: sorted, note: "(note: no stint matched the requested years — answering across all stints)", scope: SCOPE_ALL };
    }
  }
  return { stints: sorted, note: "(note: unrecognized stint filter — answering across all stints)", scope: SCOPE_ALL };
}

/** Execute a plan and report both the answer text and the structured scope it was computed over. */
export function executePlanScoped(plan: QueryPlan, allStints: StintRow[]): { answer: string; scope: RecordsScope } {
  const span = (s: StintRow) => `${s.startDate}→${s.endDate} (${s.role})`;
  // Comparisons span (at least) two stints drawn from the whole history, so
  // their scope is the full archive rather than a single-stint filter.
  if (plan.metric === "compare_stints") return { answer: compareStints(plan.compare, allStints, span), scope: SCOPE_ALL };
  // Trends are computed across the whole rated history.
  if (plan.metric === "rating_trend") return { answer: ratingTrend(allStints), scope: SCOPE_ALL };
  const { stints, note, scope } = applyStintFilter(allStints, plan.filter);
  const suffix = note ? ` ${note}` : "";
  return { answer: computeMetric(plan.metric, stints, span) + suffix, scope };
}

export function executePlan(plan: QueryPlan, allStints: StintRow[]): string {
  return executePlanScoped(plan, allStints).answer;
}

/**
 * Resolve one comparison selector to a single stint. Falls back to the
 * provided default (earliest/latest) when the selector is missing, does not
 * match, or is ambiguous; notes explain any fallback.
 */
function resolveCompareSelector(
  selector: StintFilter | undefined,
  sorted: StintRow[],
  fallback: "earliest" | "latest",
  label: string,
  notes: string[],
): StintRow {
  const dflt = fallback === "earliest" ? sorted[0] : sorted[sorted.length - 1];
  if (selector === undefined || selector === null) return dflt;
  const { stints: matched, note } = applyStintFilter(sorted, { stint: selector });
  // applyStintFilter falls back to ALL stints on no-match/unrecognized — treat that as a failed selector.
  if (matched.length === sorted.length && note && note.includes("all stints")) {
    notes.push(`(${label} selector did not match — using the ${fallback} stint)`);
    return dflt;
  }
  if (matched.length > 1) {
    notes.push(`(${label} selector matched ${matched.length} stints — using the ${fallback} of them)`);
    return fallback === "earliest" ? matched[0] : matched[matched.length - 1];
  }
  return matched[0];
}

/** Deterministic two-stint comparison: rating, notice compliance, tenure. */
function compareStints(
  compare: QueryPlan["compare"],
  allStints: StintRow[],
  span: (s: StintRow) => string,
): string {
  if (allStints.length < 2) {
    return `Cannot compare stints — only ${allStints.length} archived stint${allStints.length === 1 ? "" : "s"} on record.`;
  }
  const sorted = [...allStints].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const notes: string[] = [];
  let a = resolveCompareSelector(compare?.a, sorted, "earliest", "first", notes);
  let b = resolveCompareSelector(compare?.b, sorted, "latest", "second", notes);
  if (a.id === b.id) {
    notes.push("(both selectors resolved to the same stint — comparing earliest vs latest instead)");
    a = sorted[0];
    b = sorted[sorted.length - 1];
  }
  // Present chronologically: a = earlier of the two.
  if (a.startDate.localeCompare(b.startDate) > 0) [a, b] = [b, a];

  const parts: string[] = [`Comparing ${span(a)} vs ${span(b)}.`];

  const ra = Number(a.performanceRating);
  const rb = Number(b.performanceRating);
  if (Number.isFinite(ra) && Number.isFinite(rb)) {
    const delta = rb - ra;
    const dir = delta > 0 ? `improved by ${delta.toFixed(2)}` : delta < 0 ? `declined by ${Math.abs(delta).toFixed(2)}` : "was unchanged";
    parts.push(`Rating: ${ra.toFixed(1)} → ${rb.toFixed(1)} (${dir}).`);
  } else {
    parts.push("Rating: not comparable — a numeric rating is missing on at least one stint.");
  }

  const compliance = (s: StintRow) =>
    s.noticeServedDays >= s.noticeRequiredDays
      ? "full notice"
      : `shortfall of ${s.noticeRequiredDays - s.noticeServedDays} days (${s.noticeServedDays}/${s.noticeRequiredDays})`;
  parts.push(`Notice: ${compliance(a)} → ${compliance(b)}.`);

  const ma = months(a.startDate, a.endDate);
  const mb = months(b.startDate, b.endDate);
  const tdir = mb > ma ? "longer" : mb < ma ? "shorter" : "the same length";
  parts.push(`Tenure: ≈${ma} months → ≈${mb} months (second stint ${tdir}).`);

  return parts.join(" ") + (notes.length ? " " + notes.join(" ") : "");
}

/**
 * Deterministic rating trend across ALL stints in chronological order.
 * Summarizes the direction ("consistently improved", "declined", "mixed",
 * "flat") from pairwise deltas between consecutive rated stints; stints
 * without a numeric rating are excluded and called out rather than guessed.
 */
export function ratingTrend(allStints: StintRow[]): string {
  const sorted = [...allStints].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const rated = sorted.filter((s) => Number.isFinite(Number(s.performanceRating)));
  const missing = sorted.length - rated.length;
  const missingNote = missing > 0 ? ` (${missing} stint${missing === 1 ? "" : "s"} without a numeric rating excluded)` : "";
  if (rated.length === 0) {
    return "Cannot assess rating trend — no numeric performance ratings on record.";
  }
  const series = rated.map((s) => `${s.endDate.slice(0, 4)}: ${Number(s.performanceRating).toFixed(1)}`).join(" → ");
  if (rated.length === 1) {
    return `Cannot assess a trend from a single rated stint — only ${series}.${missingNote}`;
  }
  const deltas: number[] = [];
  for (let i = 1; i < rated.length; i++) {
    deltas.push(Number(rated[i].performanceRating) - Number(rated[i - 1].performanceRating));
  }
  const ups = deltas.filter((d) => d > 0).length;
  const downs = deltas.filter((d) => d < 0).length;
  const flats = deltas.length - ups - downs;
  const net = Number(rated[rated.length - 1].performanceRating) - Number(rated[0].performanceRating);
  let direction: string;
  if (downs === 0 && ups > 0 && flats === 0) direction = "consistently improved every stint";
  else if (ups === 0 && downs > 0 && flats === 0) direction = "consistently declined every stint";
  else if (ups === 0 && downs === 0) direction = "stayed flat across all stints";
  else if (downs === 0 && ups > 0) direction = "improved overall (never declined, with some ties)";
  else if (ups === 0 && downs > 0) direction = "declined overall (never improved, with some ties)";
  else direction = `was mixed (${ups} up, ${downs} down${flats ? `, ${flats} unchanged` : ""})`;
  const netStr = net > 0 ? `net +${net.toFixed(2)}` : net < 0 ? `net ${net.toFixed(2)}` : "net unchanged";
  return `Rating trend across ${rated.length} rated stints: ${direction} — ${series} (${netStr}).${missingNote}`;
}

function computeMetric(
  metric: Exclude<QueryPlan["metric"], "compare_stints" | "rating_trend">,
  stints: StintRow[],
  span: (s: StintRow) => string,
): string {
  switch (metric) {
    case "notice_served_in_full_all_stints": {
      const short = stints.filter((s) => s.noticeServedDays < s.noticeRequiredDays);
      return short.length === 0
        ? `Yes — full notice served in all ${stints.length} stints.`
        : `No — shortfall in ${short.length} of ${stints.length} stints: ${short
            .map((s) => `${span(s)}: served ${s.noticeServedDays}/${s.noticeRequiredDays} days`)
            .join("; ")}.`;
    }
    case "notice_shortfall_by_stint":
      return stints.map((s) => `${span(s)}: served ${s.noticeServedDays}/${s.noticeRequiredDays} days`).join("; ");
    case "avg_performance_rating": {
      const rated = stints.filter((s) => Number.isFinite(Number(s.performanceRating)));
      if (rated.length === 0) return "No numeric performance ratings on record.";
      const avg = rated.reduce((t, s) => t + Number(s.performanceRating), 0) / rated.length;
      return `Average final rating ${avg.toFixed(2)}/5 across ${rated.length} of ${stints.length} stints (${rated
        .map((s) => `${s.endDate.slice(0, 4)}: ${s.performanceRating}`)
        .join(", ")}).`;
    }
    case "performance_rating_by_stint":
      return stints.map((s) => `${span(s)}: ${s.performanceRating}/5`).join("; ");
    case "rehire_eligible_all_exits": {
      const not = stints.filter((s) => !s.rehireEligible);
      return not.length === 0
        ? `Yes — marked rehire-eligible at every exit (${stints.length} stints).`
        : `No — not rehire-eligible after: ${not.map(span).join("; ")}.`;
    }
    case "exit_reasons":
      return stints.map((s) => `${span(s)}: ${s.exitReason}`).join("; ");
    case "total_tenure_months": {
      const total = stints.reduce((t, s) => t + months(s.startDate, s.endDate), 0);
      return `Total prior tenure ≈ ${total} months across ${stints.length} stints.`;
    }
    case "stint_count":
      return `${stints.length} archived stints.`;
    case "list_stints":
      return stints
        .map((s) => `${span(s)}, ${s.department}; exit: ${s.exitReason}; notice ${s.noticeServedDays}/${s.noticeRequiredDays}d; rating ${s.performanceRating}/5; rehire-eligible: ${s.rehireEligible ? "yes" : "no"}`)
        .join(" | ");
  }
}

/* ------------------------------ answers ------------------------------ */

export type RecordsAnswer = {
  question: string;
  answer: string;
  interpreted: boolean;
  /** Which stints the answer covers; absent when the question could not be answered from data. */
  scope?: RecordsScope;
};

export async function answerRecordsQuestions(
  workerEmail: string,
  questions: string[],
  organizationId = DEMO_ORGANIZATION_ID,
): Promise<{
  stintCount: number;
  answers: RecordsAnswer[];
}> {
  const stints = await getArchivedStints(workerEmail, organizationId);
  if (stints.length === 0) {
    return {
      stintCount: 0,
      answers: questions.map((q) => ({
        question: q,
        answer: "No archived employment records found for this worker — cannot answer from data.",
        interpreted: false,
      })),
    };
  }
  const answers: RecordsAnswer[] = [];
  for (const q of questions) {
    const plan = await interpretQuestion(q);
    if (!plan) {
      answers.push({ question: q, answer: "Could not interpret this question against the archive schema.", interpreted: false });
    } else {
      const { answer, scope } = executePlanScoped(plan, stints);
      answers.push({ question: q, answer, interpreted: true, scope });
    }
  }
  return { stintCount: stints.length, answers };
}


const SCOPE_ALL: RecordsScope = { kind: "all" };
