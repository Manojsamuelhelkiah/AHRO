import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  GetWorkforceInsightsResponse, CreateWorkforceReviewCaseBody, UpdateWorkforceReviewCaseBody,
} from "@workspace/api-zod";

export type WorkforceAssessment = z.infer<typeof GetWorkforceInsightsResponse>["assessments"][number];
export type WorkforceReviewCase = z.infer<typeof GetWorkforceInsightsResponse>["reviews"][number];
export type WorkforceReviewInput = z.infer<typeof CreateWorkforceReviewCaseBody>;
export type WorkforceReviewUpdate = z.infer<typeof UpdateWorkforceReviewCaseBody>;
export const WORKFORCE_INSIGHTS_KEY = "workforce.early-warning.v1";
export const MAX_WORKFORCE_RECORDS = 5000;
export class WorkforceInsightsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const fail = (status: number, message: string): never => { throw new WorkforceInsightsError(status, message); };
export type WorkforceState = { version: number; assessments: WorkforceAssessment[]; reviews: WorkforceReviewCase[] };
export const emptyWorkforceState = (): WorkforceState => ({ version: 0, assessments: [], reviews: [] });
export const isOpenReview = (review: WorkforceReviewCase) => review.status === "open" || review.status === "in-progress";

export function assertVersion(state: WorkforceState, version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) fail(400, "A non-negative integer version is required.");
  if (state.version !== version) fail(409, "Early-warning records changed. Reload before saving.");
}
export function validDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function text(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) fail(400, `${label} must contain 1–2000 characters.`);
  return trimmed;
}
export function createHumanWorkforceReview(
  state: WorkforceState, input: WorkforceReviewInput, actor: string, now = new Date(),
): WorkforceState {
  assertVersion(state, input.version);
  if (!Number.isSafeInteger(input.caseId) || input.caseId <= 0) fail(400, "Choose a source case.");
  const reason = text(input.reason, "Reason");
  const action = text(input.recommendedAction, "Recommended follow-up");
  if (!validDateOnly(input.dueDate)) fail(400, "Choose a valid due date.");
  // Deduplication does not overwrite someone else's investigation or its owner.
  if (state.reviews.some(row => row.caseId === input.caseId && row.kind === input.kind && isOpenReview(row))) return state;
  if (state.reviews.length >= MAX_WORKFORCE_RECORDS) fail(409, "Review capacity reached. Contact the platform owner; no records have been removed.");
  const id = randomUUID();
  const review: WorkforceReviewCase = {
    id, reference: `EW-${id.slice(0, 8).toUpperCase()}`, caseId: input.caseId,
    kind: input.kind, priority: input.priority, reason, recommendedAction: action,
    ownerUserId: input.ownerUserId, dueDate: input.dueDate, status: "open", origin: "human",
    assessmentId: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), outcome: "",
    history: [{ at: now.toISOString(), actor, action: "human-review-created", outcome: reason }],
  };
  return { ...state, version: state.version + 1, reviews: [...state.reviews, review] };
}

export function updateWorkforceReview(
  state: WorkforceState, id: string, input: WorkforceReviewUpdate, actor: string, now = new Date(),
): WorkforceState {
  assertVersion(state, input.version);
  const review = state.reviews.find(row => row.id === id);
  if (!review) fail(404, "Review case not found.");
  if (!validDateOnly(input.dueDate)) fail(400, "Choose a valid due date.");
  if ((input.status === "resolved" || input.status === "dismissed") && !input.outcome.trim()) {
    fail(400, "Record an outcome before resolving or dismissing the review.");
  }
  if (isOpenReview({ ...review!, status: input.status }) &&
    state.reviews.some(row => row.id !== id && row.caseId === review!.caseId && row.kind === review!.kind && isOpenReview(row))) {
    fail(409, "Another review is already open for this source and kind.");
  }
  if (review!.history.length >= MAX_WORKFORCE_RECORDS) fail(409, "Review history capacity reached. No history has been removed.");
  const updated = {
    ...review!, status: input.status, ownerUserId: input.ownerUserId, dueDate: input.dueDate,
    outcome: input.outcome.trim(), updatedAt: now.toISOString(),
    history: [...review!.history, {
      at: now.toISOString(), actor,
      action: `review-${input.status}; owner=${input.ownerUserId}; due=${input.dueDate}`,
      outcome: input.outcome.trim(),
    }],
  };
  return { ...state, version: state.version + 1, reviews: state.reviews.map(row => row.id === id ? updated : row) };
}

/** Server-side future adapter contract, never a browser-controlled model approval. */
export const workforceModelContract = z.object({
  id: z.string().min(1), version: z.string().min(1),
  kind: z.enum(["talent-risk", "resume-integrity"]),
  validationStatus: z.literal("validated"),
  validationReference: z.string().min(1),
  horizonDays: z.number().int().positive().nullable(),
});
export type WorkforceModelContract = z.infer<typeof workforceModelContract>;

export function currentWorkforceBand(
  assessment: WorkforceAssessment | undefined,
  sourceRevision: string, model: WorkforceModelContract | undefined, now = new Date(),
): WorkforceAssessment["band"] {
  if (!assessment || !model || !workforceModelContract.safeParse(model).success ||
    assessment.modelId !== model.id || assessment.modelVersion !== model.version ||
    assessment.kind !== model.kind || assessment.sourceRevision !== sourceRevision ||
    assessment.horizonDays !== model.horizonDays ||
    Date.parse(assessment.assessedAt) > now.getTime() ||
    Date.parse(assessment.validUntil) <= now.getTime() ||
    !Number.isFinite(Date.parse(assessment.assessedAt)) ||
    !Number.isFinite(Date.parse(assessment.validUntil))) return "unknown";
  return assessment.band;
}

/**
 * Pure future model adapter: a validated, current red assessment can create or
 * update one review, without impersonating a human decision or any provider effect.
 * This release has no connected model or public model-ingestion endpoint.
 */
export function applyWorkforceModelAssessment(
  state: WorkforceState, assessment: WorkforceAssessment, model: WorkforceModelContract,
  sourceRevision: string, ownerUserId: string, now = new Date(),
): WorkforceState {
  if (currentWorkforceBand(assessment, sourceRevision, model, now) === "unknown") {
    fail(409, "A validated, current source-bound model result is required.");
  }
  if (!assessment.factors.length || !assessment.recommendedActions.length || !ownerUserId.trim()) {
    fail(400, "Model evidence, follow-up and a human review owner are required.");
  }
  if (assessment.kind === "talent-risk" && (!assessment.horizonDays ||
    assessment.probability === null || assessment.probability < 0 || assessment.probability > 1 ||
    !Number.isFinite(assessment.probability))) fail(400, "Attrition requires a valid probability and prediction period.");
  if (state.assessments.some(row => row.id === assessment.id)) return state;
  const latest = state.assessments.find(row => row.caseId === assessment.caseId && row.kind === assessment.kind);
  if (latest && Date.parse(latest.assessedAt) >= Date.parse(assessment.assessedAt)) fail(409, "An equal or newer assessment already exists.");
  if (state.assessments.length >= MAX_WORKFORCE_RECORDS) fail(409, "Assessment capacity reached; no evidence has been removed.");
  let next: WorkforceState = {
    ...state, version: state.version + 1,
    assessments: [assessment, ...state.assessments],
  };
  if (assessment.band !== "red") return next;
  const existing = state.reviews.find(row => row.caseId === assessment.caseId && row.kind === assessment.kind && isOpenReview(row));
  if (existing) {
    if (existing.history.length >= MAX_WORKFORCE_RECORDS) fail(409, "Review history capacity reached.");
    return { ...next, reviews: next.reviews.map(row => row.id === existing.id ? {
      ...row, priority: "critical", assessmentId: assessment.id, updatedAt: now.toISOString(),
      history: [...row.history, { at: now.toISOString(), actor: `model:${model.id}:${model.version}`,
        action: "critical-model-assessment-linked", outcome: assessment.factors.join("; ") }],
    } : row) };
  }
  next = createHumanWorkforceReview(next, {
    version: next.version, caseId: assessment.caseId, kind: assessment.kind, priority: "critical",
    reason: assessment.factors.join("; ").slice(0, 2000),
    recommendedAction: assessment.recommendedActions.join("; ").slice(0, 2000),
    ownerUserId, dueDate: new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10),
  }, `model:${model.id}:${model.version}`, now);
  const id = next.reviews.at(-1)!.id;
  return { ...next, reviews: next.reviews.map(row => row.id === id
    ? { ...row, origin: "model", assessmentId: assessment.id,
      history: row.history.map(event => ({ ...event, action: "critical-model-review-created" })) } : row) };
}
