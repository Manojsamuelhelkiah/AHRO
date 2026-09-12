import assert from "node:assert/strict";
import test from "node:test";
import type { OnbChecklistProfileDraftResponse } from "@workspace/api-client-react";
import {
  acceptDraftResponse,
  editDraftDescription,
  handoffDraftToProfileEditor,
  initialDrafterState,
  readDraftError,
  startDraftGeneration,
} from "./checklist-profile-drafter-logic";

const result: OnbChecklistProfileDraftResponse = {
  proposal: {
    name: "Canadian engineering",
    criteria: { workCountry: "CA" },
    overrides: [{ id: "security-training", enabled: true }],
    priority: 10,
    enabled: false,
    processPolicy: { semanticsVersion: 2 },
    effectiveChecklist: [{
      id: "security-training",
      label: "Security training",
      order: 0,
      enabled: true,
      mandatory: true,
      enforcementStage: "before-day1-review",
    }],
  },
  baseChecklistVersion: 3,
  rationale: "The policy is limited to the requested workforce context.",
  warnings: [],
  unsupportedRequests: [],
  preview: {
    activeCasesConsidered: 4,
    activeCasesTruncated: false,
    matchingActiveCases: 2,
    missingContextActiveCases: 1,
    unchangedActiveCases: 4,
  },
};

test("late responses from an older generation cannot reinstate a cleared proposal", () => {
  const started = startDraftGeneration({
    ...initialDrafterState,
    result,
    humanAcknowledged: true,
  }, 1);
  const edited = editDraftDescription(started, 2);
  const lateResponse = acceptDraftResponse(edited, 1, result);

  assert.equal(edited.result, null);
  assert.equal(edited.humanAcknowledged, false);
  assert.deepEqual(lateResponse, edited);
});

test("every new generation clears the prior human acknowledgement", () => {
  const started = startDraftGeneration({
    ...initialDrafterState,
    result,
    humanAcknowledged: true,
  }, 4);

  assert.equal(started.humanAcknowledged, false);
  assert.equal(started.result, null);
});

test("draft errors read the customFetch data envelope and its unsupported requests", () => {
  const details = readDraftError({
    data: {
      code: "unavailable",
      message: "The proposal service is unavailable.",
      unsupportedRequests: ["Send an email to the manager."],
    },
    response: {
      data: {
        message: "This Axios-shaped value must not win.",
        unsupportedRequests: ["stale"],
      },
    },
  });

  assert.deepEqual(details, {
    message: "The proposal service is unavailable.",
    unsupportedRequests: ["Send an email to the manager."],
  });
});

test("profile editor handoff strips effective checklist and server identity", () => {
  const candidate = {
    ...result.proposal,
    id: "server-id",
    profileId: "server-profile-id",
    version: 9,
    createdAt: "2025-01-01T00:00:00.000Z",
  } as unknown as OnbChecklistProfileDraftResponse["proposal"];
  const handoff = handoffDraftToProfileEditor(candidate);

  assert.equal(handoff.enabled, false);
  assert.equal("effectiveChecklist" in handoff, false);
  assert.equal("id" in handoff, false);
  assert.equal("profileId" in handoff, false);
  assert.equal("version" in handoff, false);
  assert.equal("createdAt" in handoff, false);
  assert.equal(handoff.name, result.proposal.name);
});