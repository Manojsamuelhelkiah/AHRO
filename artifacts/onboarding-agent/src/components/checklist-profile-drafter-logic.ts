import type {
  OnbChecklistProfileDraftResponse,
  OnbChecklistProfileInput,
} from "@workspace/api-client-react";

export type DrafterState = {
  generation: number;
  result: OnbChecklistProfileDraftResponse | null;
  humanAcknowledged: boolean;
  error: string | null;
  unsupportedRequests: string[];
};

export const initialDrafterState: DrafterState = {
  generation: 0,
  result: null,
  humanAcknowledged: false,
  error: null,
  unsupportedRequests: [],
};

/**
 * A generation starts a new reviewable proposal. Clearing the result and
 * acknowledgement together prevents an old approval from authorizing a new
 * model response.
 */
export function startDraftGeneration(
  state: DrafterState,
  generation: number,
): DrafterState {
  return {
    ...state,
    generation,
    result: null,
    humanAcknowledged: false,
    error: null,
    unsupportedRequests: [],
  };
}

export function editDraftDescription(
  state: DrafterState,
  generation: number,
): DrafterState {
  return startDraftGeneration(state, generation);
}

export function shouldAcceptDraftResponse(
  activeGeneration: number,
  responseGeneration: number,
): boolean {
  return activeGeneration === responseGeneration;
}

export function acceptDraftResponse(
  state: DrafterState,
  responseGeneration: number,
  result: OnbChecklistProfileDraftResponse,
): DrafterState {
  if (!shouldAcceptDraftResponse(state.generation, responseGeneration)) return state;
  return {
    ...state,
    result,
    humanAcknowledged: false,
    error: null,
    unsupportedRequests: [],
  };
}

export function acceptDraftError(
  state: DrafterState,
  responseGeneration: number,
  details: DraftErrorDetails,
): DrafterState {
  if (!shouldAcceptDraftResponse(state.generation, responseGeneration)) return state;
  return {
    ...state,
    result: null,
    humanAcknowledged: false,
    error: details.message,
    unsupportedRequests: details.unsupportedRequests,
  };
}

export type DraftErrorDetails = {
  message: string;
  unsupportedRequests: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * customFetch rejects with ApiError.data, not Axios's response.data. Keep a
 * response.data fallback for older callers, but prefer the generated client's
 * actual error envelope.
 */
export function readDraftError(
  error: unknown,
  fallback = "Failed to generate profile.",
): DraftErrorDetails {
  const record = isRecord(error) ? error : {};
  const directData = isRecord(record.data) ? record.data : null;
  const response = isRecord(record.response) ? record.response : null;
  const legacyData = response && isRecord(response.data) ? response.data : null;
  const data = directData ?? legacyData;
  const message = data && typeof data.message === "string" && data.message.trim()
    ? data.message.trim()
    : typeof record.message === "string" && record.message.trim()
      ? record.message.trim()
      : fallback;
  const unsupportedRequests = data && Array.isArray(data.unsupportedRequests)
    ? data.unsupportedRequests.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0)
    : [];
  return { message, unsupportedRequests };
}

/**
 * The generated draft payload contains an effective checklist for display.
 * ProfileEditor owns the actual save flow, so the handoff removes all
 * server/evaluation-only fields and always keeps the profile disabled.
 */
export function handoffDraftToProfileEditor(
  proposal: OnbChecklistProfileDraftResponse["proposal"],
): OnbChecklistProfileInput {
  const candidate = proposal as OnbChecklistProfileDraftResponse["proposal"] & {
    id?: unknown;
    profileId?: unknown;
    version?: unknown;
    createdAt?: unknown;
  };
  const {
    effectiveChecklist: _effectiveChecklist,
    id: _id,
    profileId: _profileId,
    version: _version,
    createdAt: _createdAt,
    ...editorInput
  } = candidate;
  return {
    ...editorInput,
    enabled: false,
  };
}