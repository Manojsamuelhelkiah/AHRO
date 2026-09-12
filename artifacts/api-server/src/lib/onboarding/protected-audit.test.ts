import assert from "node:assert/strict";
import { test } from "node:test";
import { auditEntryHash, minimizeAuditPayload } from "./protected-audit";

const base = {
  organizationId: "isolated-audit-tenant",
  sequence: 1,
  occurredAt: "2026-01-02T03:04:05.000Z",
  actorId: "user_123",
  actorKind: "authenticated" as const,
  actorAuthority: "tenant-membership:admin",
  action: "onboarding.approval.decision-recorded",
  outcome: "success" as const,
  objectType: "approval",
  objectId: "ref:approval",
  caseReference: "ref:case",
  reviewedRevision: 2,
  source: "test",
  correlationId: "ref:request",
  payload: { approvalVersion: 2, decision: "approved" },
  correctionOfId: null,
  previousHash: "",
};

test("protected audit hash is deterministic and chain-position sensitive", () => {
  const first = auditEntryHash(base);
  assert.equal(first, auditEntryHash({ ...base, payload: { decision: "approved", approvalVersion: 2 } }));
  assert.notEqual(first, auditEntryHash({ ...base, sequence: 2, previousHash: first }));
  assert.notEqual(first, auditEntryHash({ ...base, payload: { approvalVersion: 3, decision: "approved" } }));
});

test("protected audit payload excludes sensitive and structured input", () => {
  assert.deepEqual(minimizeAuditPayload({
    decision: "approved",
    body: "raw document body",
    accessToken: "credential",
    workerEmail: "person@example.com",
    nested: { must: "not persist" },
    count: 2,
    unreviewedFutureField: "not persist",
  }), { decision: "approved" });
});