import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { WorkforceInsights, WorkforceReviewCase } from '@workspace/api-client-react';
import { pendingActionReviews } from './action-review-projection';
import { ActionReviewSection } from './action-review-section';

const reviewFixture = (id: string, patch: Partial<WorkforceReviewCase> = {}): WorkforceReviewCase => ({
  id, reference: `EW-${id}`, caseId: 41, kind: 'talent-risk' as const, priority: 'standard' as const,
  status: 'open' as const, dueDate: '2026-12-01', ownerUserId: 'owner', origin: 'human' as const,
  reason: 'Recorded concern', recommendedAction: 'Supportive follow-up', outcome: '',
  assessmentId: null, createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', history: [], ...patch,
});
const data: WorkforceInsights = { organizationId: 'fixture', version: 1, modelStatus: 'not-connected', canManage: true,
  subjects: [], assessments: [], coverageNote: 'Fixture', reviews: [
  reviewFixture('standard', { dueDate: '2026-01-01' }),
  reviewFixture('critical-late', { priority: 'critical' }),
  reviewFixture('critical-first', { priority: 'critical', dueDate: '2026-11-01', status: 'in-progress', kind: 'resume-integrity' }),
  reviewFixture('resolved', { status: 'resolved' }), reviewFixture('dismissed', { status: 'dismissed' }),
  reviewFixture('standard'),
], owners: [{ userId: 'owner', label: 'Review owner' }] };

test('pending projection counts unique reviews, excludes closures and orders critical then due date', () => {
  assert.deepEqual(pendingActionReviews(data).map(r => r.id), ['critical-first', 'critical-late', 'standard']);
  assert.equal(data.reviews.length, 6, 'projection never rewrites history');
  assert.deepEqual(pendingActionReviews(undefined), []);
});
test('compact discovery includes labels, ownership, dates and existing navigation, not the editor', () => {
  const html = renderToStaticMarkup(<Router ssrPath="/approvals"><ActionReviewSection data={data} failed={false} denied={false} refreshing={false} retry={() => {}} /></Router>);
  for (const text of ['(3)', 'EW-critical-first', 'In progress', 'Resume integrity review', 'Review priority: Critical', 'Review owner', '2026-11-01', '/analytics#review-critical-first', '/cases/41']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('EW-resolved'));
  assert.ok(!html.includes('textarea'));
});
test('loading, failure, denial and empty review discovery are distinct', () => {
  const render = (props: Partial<Parameters<typeof ActionReviewSection>[0]>) => renderToStaticMarkup(<ActionReviewSection failed={false} denied={false} refreshing={false} retry={() => {}} {...props} />);
  assert.match(render({}), /Loading early-warning/);
  assert.match(render({ failed: true }), /could not be loaded.*Retry reviews/);
  assert.match(render({ failed: true, denied: true }), /administrator and source-case access/);
  assert.match(render({ data: { ...data, reviews: [] } }), /No pending early-warning/);
});
