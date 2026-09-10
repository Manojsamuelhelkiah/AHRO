import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContextualContactError,
  CONTEXTUAL_CONTACT_BODY_MAX,
  CONTACT_ACTIONS,
  contextualContactInternals,
  validateContextualContactRequest,
} from "./contextual-contact";

const requestId = "018f3d4e-7b3e-4b9a-9a39-d6edc4be9c10";

function base() {
  return {
    caseId: 42,
    organizationId: "org-a",
    action: "candidate-email" as const,
    scenario: "day-before" as const,
    requestId,
  };
}

test("contextual contact contract keeps the four explicit actions", () => {
  assert.deepEqual(CONTACT_ACTIONS, [
    "candidate-email",
    "owner-email",
    "backup-email",
    "candidate-call",
  ]);
});

test("candidate email content has bounded HR-editable fields", () => {
  validateContextualContactRequest({ ...base(), body: "A" });
  validateContextualContactRequest({
    ...base(),
    body: "x".repeat(CONTEXTUAL_CONTACT_BODY_MAX),
  });

  assert.throws(
    () => validateContextualContactRequest({ ...base(), body: "" }),
    (error: unknown) =>
      error instanceof ContextualContactError && error.code === "invalid_body",
  );
  assert.throws(
    () =>
      validateContextualContactRequest({
        ...base(),
        body: "x".repeat(CONTEXTUAL_CONTACT_BODY_MAX + 1),
      }),
    (error: unknown) =>
      error instanceof ContextualContactError && error.code === "invalid_body",
  );
});

test("recipient overrides are rejected for candidate and owner audiences", () => {
  assert.throws(
    () =>
      validateContextualContactRequest({
        ...base(),
        recipient: "attacker@example.com",
      } as never),
    (error: unknown) =>
      error instanceof ContextualContactError &&
      error.code === "recipient_override_forbidden",
  );
  assert.throws(
    () =>
      validateContextualContactRequest({
        ...base(),
        action: "owner-email",
        ownerEmail: "attacker@example.com",
      } as never),
    (error: unknown) =>
      error instanceof ContextualContactError &&
      error.code === "recipient_override_forbidden",
  );
});

test("SLA context revisions have a strict scalar shape", () => {
  validateContextualContactRequest({
    ...base(),
    scenario: "sla-escalation",
    slaActionId: "documentation",
    context: { currentSnapshotRevision: 3 },
  });
  assert.throws(
    () =>
      validateContextualContactRequest({
        ...base(),
        scenario: "sla-escalation",
        slaActionId: "documentation",
        context: { currentSnapshotRevision: true as never },
      }),
    (error: unknown) =>
      error instanceof ContextualContactError &&
      error.code === "invalid_snapshot_revision",
  );
  assert.throws(
    () =>
      validateContextualContactRequest({ ...base(), requestId: "not-a-uuid" }),
    (error: unknown) =>
      error instanceof ContextualContactError &&
      error.code === "invalid_request_id",
  );
});

test("SLA contacts cannot omit or fork the expected snapshot revision", () => {
  assert.throws(
    () =>
      validateContextualContactRequest({
        ...base(),
        scenario: "sla-escalation",
        slaActionId: "documentation",
      }),
    (error: unknown) =>
      error instanceof ContextualContactError &&
      error.code === "snapshot_revision_required",
  );
  assert.throws(
    () =>
      validateContextualContactRequest({
        ...base(),
        scenario: "sla-escalation",
        slaActionId: "documentation",
        context: {
          expectedSnapshotRevision: 3,
          currentSnapshotRevision: 4,
        },
      }),
    (error: unknown) =>
      error instanceof ContextualContactError &&
      error.code === "snapshot_revision_conflict",
  );
});

test("duplicate dispositions expose persisted pending, sent, and unknown states", () => {
  assert.equal(
    contextualContactInternals.classifyPersistedDispatchState({
      claimState: "queued",
    }),
    "queued",
  );
  assert.equal(
    contextualContactInternals.classifyPersistedDispatchState({
      journalStatus: "dispatching",
      journalLeaseExpired: false,
    }),
    "sending",
  );
  assert.equal(
    contextualContactInternals.classifyPersistedDispatchState({
      journalStatus: "confirmed",
      communicationStatus: "sent",
    }),
    "sent",
  );
  assert.equal(
    contextualContactInternals.classifyPersistedDispatchState({
      journalStatus: "unknown_effect_manual_repair",
    }),
    "unknown",
  );
  assert.equal(
    contextualContactInternals.classifyPersistedDispatchState({
      journalStatus: "dispatching",
      journalLeaseExpired: true,
    }),
    "unknown",
  );
});

test("provider-boundary action fencing rejects stale date or snapshot context", () => {
  const claim = {
    organizationId: "org-a",
    caseId: 42,
    slaActionId: "documentation",
    snapshotRevision: 3,
    dueAt: "2026-09-10T12:00:00.000Z",
    actionStatus: "breached",
    candidateRelevant: true,
  };
  assert.equal(
    contextualContactInternals.actionContextMatches(claim, {
      id: "documentation",
      organizationId: "org-a",
      caseId: 42,
      snapshotRevision: 3,
      status: "breached",
      dueAt: new Date("2026-09-10T12:00:00.000Z"),
      candidateRelevant: true,
    }),
    true,
  );
  assert.equal(
    contextualContactInternals.actionContextMatches(claim, {
      id: "documentation",
      organizationId: "org-a",
      caseId: 42,
      snapshotRevision: 4,
      status: "breached",
      dueAt: new Date("2026-09-10T12:00:00.000Z"),
      candidateRelevant: true,
    }),
    false,
  );
});

test("masking never exposes the full stored candidate address", () => {
  assert.equal(
    contextualContactInternals.maskEmail("alice@example.com"),
    "al***@example.com",
  );
  assert.equal(
    contextualContactInternals.maskPhone("+15551234567"),
    "+155•••67",
  );
  assert.equal(
    contextualContactInternals.candidateDocsGoal("pending-docs-offer-package"),
    true,
  );
  assert.equal(
    contextualContactInternals.candidateDocsGoal("BGV result"),
    false,
  );
});
