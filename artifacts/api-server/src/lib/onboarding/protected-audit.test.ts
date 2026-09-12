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
    reason: "must not persist for unrelated actions",
    body: "raw document body",
    accessToken: "credential",
    workerEmail: "person@example.com",
    nested: { must: "not persist" },
    count: 2,
    unreviewedFutureField: "not persist",
  }), { decision: "approved" });
});

test("reinstatement rationale is retained only for its explicit audit action", () => {
  const reason = "r".repeat(1_100);
  assert.deepEqual(minimizeAuditPayload({ reason }), {});
  assert.deepEqual(
    minimizeAuditPayload({ reason }, "organization.membership.revoked"),
    {},
  );
  assert.equal(
    minimizeAuditPayload({ reason }, "organization.membership.reinstated").reason,
    "r".repeat(1_000),
  );
});