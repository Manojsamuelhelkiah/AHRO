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
import { onbEmployeeRecords } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { llmComplete, llmCompleteJson } from "./llm";

export type StintRow = typeof onbEmployeeRecords.$inferSelect;

/* ------------------------------ archive ------------------------------ */

/**
 * Seed a synthetic two-stint archive for a DEMO rehire (scenario or
 * volunteer persona cases only — manually-created rehires get an honest
 * "no archived records" answer instead of fabricated history).
 */
export async function ensureDemoRehireArchive(workerEmail: string, workerName: string): Promise<void> {
  const email = workerEmail.trim().toLowerCase();
  // Concurrent seeders are safe: the (worker_email, start_date) unique
  // index makes this an idempotent no-op insert, never a duplicate stint.
  await db.insert(onbEmployeeRecords).values([
    {
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
  ]).onConflictDoNothing({ target: [onbEmployeeRecords.workerEmail, onbEmployeeRecords.startDate] });
}

export async function getArchivedStints(workerEmail: string): Promise<StintRow[]> {
  return await db
    .select()
    .from(onbEmployeeRecords)
    .where(eq(onbEmployeeRecords.workerEmail, workerEmail.trim().toLowerCase()))
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
    | "list_stints";
  /** When present, the metric is computed over just the matching stint(s). */
  filter?: { stint: StintFilter };
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
];

async function interpretQuestion(question: string): Promise<QueryPlan | null> {
  const out = await llmCompleteJson<{ metric: string; filter?: { stint?: unknown } }>(
    `You are a large-database-model agent. Map the analyst's question to EXACTLY ONE metric from this list (return JSON {"metric":"..."}):\n${METRICS.join("\n")}\nPick the closest match; if nothing fits, use "list_stints".\nIf the question is about ONE specific past stint (not the whole history), also add a filter:\n- most recent / last stint: {"filter":{"stint":"latest"}}\n- first / earliest stint: {"filter":{"stint":"earliest"}}\n- a stint identified by years, e.g. "the 2019-2024 stint": {"filter":{"stint":{"yearRange":{"from":2019,"to":2024}}}} (either bound may be omitted).\nOmit the filter entirely when the question covers all stints.`,
    question,
    300,
  );
  const metric = METRICS.find((m) => m === out?.metric);
  if (!metric) return null;
  const plan: QueryPlan = { metric };
  const rawStint = out?.filter?.stint;
  if (rawStint !== undefined) plan.filter = { stint: rawStint as StintFilter };
  return plan;
}

/* --------------------- deterministic plan execution ------------------ */

function months(a: string, b: string): number {
  const s = new Date(a), e = new Date(b);
  return Math.max(0, Math.round((e.getTime() - s.getTime()) / (30.44 * 24 * 3600 * 1000)));
}

/**
 * Apply an optional stint filter deterministically. Unknown/unmatchable
 * filters fall back to all stints, with a note explaining the fallback.
 */
export function applyStintFilter(
  stints: StintRow[],
  filter: QueryPlan["filter"],
): { stints: StintRow[]; note: string | null } {
  if (!filter || filter.stint === undefined || filter.stint === null) return { stints, note: null };
  // Rows are ordered by startDate ascending at the DB, but sort defensively.
  const sorted = [...stints].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const f = filter.stint;
  if (f === "latest") {
    return { stints: sorted.slice(-1), note: "(scoped to the most recent stint)" };
  }
  if (f === "earliest") {
    return { stints: sorted.slice(0, 1), note: "(scoped to the earliest stint)" };
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
        return { stints: matched, note: `(scoped to the ${label} stint${matched.length > 1 ? "s" : ""})` };
      }
      return { stints: sorted, note: "(note: no stint matched the requested years — answering across all stints)" };
    }
  }
  return { stints: sorted, note: "(note: unrecognized stint filter — answering across all stints)" };
}

export function executePlan(plan: QueryPlan, allStints: StintRow[]): string {
  const { stints, note } = applyStintFilter(allStints, plan.filter);
  const suffix = note ? ` ${note}` : "";
  const span = (s: StintRow) => `${s.startDate}→${s.endDate} (${s.role})`;
  return computeMetric(plan.metric, stints, span) + suffix;
}

function computeMetric(
  metric: QueryPlan["metric"],
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

export type RecordsAnswer = { question: string; answer: string; interpreted: boolean };

export async function answerRecordsQuestions(workerEmail: string, questions: string[]): Promise<{
  stintCount: number;
  answers: RecordsAnswer[];
}> {
  const stints = await getArchivedStints(workerEmail);
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
      answers.push({ question: q, answer: executePlan(plan, stints), interpreted: true });
    }
  }
  return { stintCount: stints.length, answers };
}

