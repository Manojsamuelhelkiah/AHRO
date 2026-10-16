import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAttention, familyWorkload, executionEvidence, FAMILIES, reviewHref, approvalHref, caseIdentity } from './control-tower';

const base: any = { completed: [], counts: { pendingApprovals: 1, notifications: 2, missingDocuments: 1, openWorkItems: 1, completed: 0, opportunities: 0 }, approvals: [{ id: 5, caseId: 9, status: 'pending', recommendation: 'x'.repeat(300), createdAt: '2025-01-01T00:00:00Z', hitlPattern: 'x' }, { id: 6, caseId: 9, status: 'approved' }],
  notifications: [{ id: 'event:1', caseId: 9, status: 'sent', title: 't', caseHref: '/cases/9' }, { id: 'event:2', caseId: 9, status: 'open', title: 't', caseHref: '/cases/9' }],
  documentFollowups: [{ caseId: 9, documentId: 3, label: 'ID', action: 'remind', caseHref: '/cases/9' }],
  workItems: [{ id: 1, caseId: 9, kind: 'k', status: 'open', caseHref: '/cases/9', createdAt: '2025-01-01', owner: null, assignee: null }],
  opportunities: [], domainRecords: [{ id: 'r1', caseId: 9, category: 'attention', title: 'a', caseHref: '/cases/separations/9' }, { id: 'r1', caseId: 9, category: 'attention', title: 'dup', caseHref: '' }, { id: 'r2', caseId: 9, category: 'communication', title: 'c', caseHref: '' }] };
const reviews: any = { reviews: [] };

test('counts outstanding work, dedups, excludes history', () => {
  const p = projectAttention(base, reviews);
  assert.equal(p.total, 5);
  assert.equal(p.historicalNotifications, 1);
  assert.equal(p.items.find((i) => i.kind === 'work-item')?.owner, null);
  assert.equal(p.incomplete, false);
});
test('partial sources flagged incomplete', () => {
  assert.equal(projectAttention(base, undefined).incomplete, true);
  assert.equal(projectAttention(undefined, reviews).total, 0);
});
test('precise links', () => {
  assert.equal(reviewHref('abc'), '/analytics#review-abc');
  assert.match(approvalHref(5, 9), /approvalId=5&caseId=9/);
});
test('taxonomy has 12 families and dedups separations', () => {
  assert.equal(FAMILIES.length, 12);
  const rows = familyWorkload([{ id: 9, hireType: 'separation', orchestrationStatus: 'running' } as any],
    [{ caseId: 9, caseType: 'Offboarding', status: 'Open', caseHref: '/cases/separations/9', label: '' } as any]);
  assert.equal(rows.length, 12);
  assert.equal(rows.find((r) => r.family === 'Offboarding')?.total, 1);
  assert.equal(caseIdentity('/cases/separations/9', 1), 9);
});
test('evidence is unknown, never 0%', () => {
  const e = executionEvidence(4);
  assert.deepEqual([e.verifiedAutonomous, e.verifiedHumanAssisted, e.unknown, e.denominator, e.headline], [0, 0, 4, 4, 'Not assessed']);
});

test('active workload excludes rejected terminals without treating rejection as completed execution', () => {
  const rows = familyWorkload([
    { id: 1, hireType: 'payroll-correction', orchestrationStatus: 'running', syntheticJourney: { outcome: 'rejected' } },
    { id: 2, hireType: 'payroll-correction', orchestrationStatus: 'running', syntheticJourney: { outcome: 'completed' } },
    { id: 3, hireType: 'payroll-correction', lifecycleStage: 'preboarding', orchestrationStatus: 'running' },
  ] as any);
  assert.equal(rows.reduce((sum, row) => sum + row.active, 0), 1);
  assert.equal(rows.reduce((sum, row) => sum + row.completed, 0), 1);
  assert.equal(rows.reduce((sum, row) => sum + row.total, 0), 3);
});
