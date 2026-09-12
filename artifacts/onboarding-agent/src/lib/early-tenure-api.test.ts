import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEarlyTenureCase } from './early-tenure-api';

test('normalizes top-level early-tenure evidence and reminders onto their current targets', () => {
  const result = normalizeEarlyTenureCase({
    caseId: 42,
    snapshot: { id: 6, snapshotVersion: 4, anchorRevision: 2 },
    assignments: [{ id: 101, title: 'Induction', status: 'pending', dueAt: '2026-08-02T09:00:00.000Z' }],
    checkins: [{ id: 202, label: '30-day check-in', ownerUserId: 'member-202', status: 'completed', completedAt: '2026-08-31T09:00:00.000Z', evidenceReference: 'checkin-direct-reference' }],
    evidence: [
      { id: 301, assignmentId: 101, observedAt: '2026-08-03T10:00:00.000Z', provenance: 'human-authorized', evidenceReference: 'assignment-reference' },
      { id: 302, checkinId: 202, observedAt: '2026-08-31T10:00:00.000Z', provenance: 'human-authorized', evidenceReference: 'checkin-reference' },
    ],
    reminders: [
      { id: 401, targetType: 'assignment', targetId: 101, status: 'sent' },
      { id: 402, targetType: 'checkin', targetId: 202, status: 'suppressed' },
    ],
    probation: {
      maturityAt: '2026-08-30T09:00:00.000Z',
      governedEndAt: '2026-09-15T09:00:00.000Z',
      decisions: [{ disposition: 'confirmed', decisionVersion: 1, anchorRevision: 1, staleAgainstCurrentAnchor: true, createdAt: '2026-09-01T09:00:00.000Z', effectiveAt: '2026-08-31T09:00:00.000Z', extensionEndsAt: '2026-09-15T09:00:00.000Z' }],
    },
  });

  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].reminderStatus, 'sent');
  assert.deepEqual(result.assignments[0].evidence, [{
    id: 301,
    occurredAt: '2026-08-03T10:00:00.000Z',
    source: 'human-authorized',
    reference: 'assignment-reference',
    note: null,
  }]);
  assert.equal(result.checkIns[0].reminderStatus, 'suppressed');
   assert.equal(result.checkIns[0].ownerUserId, 'member-202');
  assert.equal(result.checkIns[0].evidence?.some((item) => item.reference === 'checkin-reference'), true);
  assert.equal(result.checkIns[0].evidence?.some((item) => item.reference === 'checkin-direct-reference'), true);
  assert.equal(result.probationDecision?.decidedAt, '2026-09-01T09:00:00.000Z');
  assert.equal(result.probationDecision?.effectiveAt, '2026-08-31T09:00:00.000Z');
  assert.equal(result.probationDecision?.extensionEndsAt, '2026-09-15T09:00:00.000Z');
  assert.equal(result.probationDecision?.stale, true);
  assert.equal(result.probation?.maturityAt, '2026-08-30T09:00:00.000Z');
  assert.equal(result.probation?.governedEndAt, '2026-09-15T09:00:00.000Z');
});