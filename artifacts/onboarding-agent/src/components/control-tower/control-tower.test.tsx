import test from 'node:test';
import assert from 'node:assert/strict';
import { activeFamilyHref } from '../../pages/cases/list-navigation';
import { Router } from 'wouter';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityPanel, ReliabilityPanel } from './panels';
import { ExamplesSection } from './examples-section';
import { composeActivity, liveReliability, projectAttention, sourceDisclosures, exampleDetailHref } from '../../lib/control-tower';

const long = 'W'.repeat(400);
const ac: any = {
  pausedOffline: false, counts: { pendingApprovals: 300, notifications: 2, missingDocuments: 0, openWorkItems: 0, completed: 1, opportunities: 2 },
  approvals: [{ id: 7, caseId: 1, status: 'pending', hitlPattern: 'hard-block', recommendation: 'r', case: {}, actions: {} }, { id: 8, caseId: 1, status: 'pending', hitlPattern: 'x', recommendation: 'r', case: {}, actions: {} }],
  notifications: [
    { id: 'event:5', caseId: 1, status: 'failed', source: 'persisted-communication', provenance: 'recorded', title: long, detail: long, caseHref: '/cases/1', createdAt: null, initiator: '' },
    { id: 'event:6', caseId: 2, status: 'overdue', source: 'recorded-system-check', provenance: 'recorded', title: 't', detail: 'd', caseHref: '/cases/2', createdAt: '2025-01-01T00:00:00Z', initiator: 'x' },
    { id: 'event:9', caseId: 3, status: 'failed', source: 'persisted-communication', provenance: 'simulated', title: 't', detail: 'd', caseHref: '/cases/3', createdAt: '2025-01-01T00:00:00Z', initiator: '' }],
  documentFollowups: [], workItems: [], opportunities: [{ id: 'approval:7:v2', caseId: 1, priority: 'high', title: 'o', evidence: { source: 's' }, caseHref: '/cases/1' }, { id: 'o2', caseId: 1, priority: 'low', title: 'o', evidence: { source: 's', checkId: 'c1' }, caseHref: '/cases/1' }],
  completed: [{ id: 'c1', caseId: 1, status: 'failed', summary: 's', actor: 'a', createdAt: '2025-01-02T00:00:00Z', caseHref: '/cases/1' }],
  domainRecords: [{ id: 'd1', caseId: 4, category: 'activity', title: 'checkpoint', detail: 'd', createdAt: null, actor: null, caseHref: '/cases/separations/4#x' }],
};

test('opportunity approval:ID:vN dedups with approval ID', () => {
  const p = projectAttention(ac, { reviews: [] } as any);
  assert.equal(p.items.filter((i) => i.key === 'approval:7').length, 1);
  assert.ok(p.items.some((i) => i.key === 'check:c1'));
});
test('reliability typed, excludes simulations/fictional, distinguishes policy', () => {
  const r = liveReliability(ac, [{ id: 1 }, { id: 2, fictionalOfflineIdentity: true }, { id: 3 }] as any)!;
  assert.equal(r.technicalFailures, 1); assert.equal(r.systemChecksOverdue, 0); assert.equal(r.excluded, 2);
  assert.equal(r.failedActions, 1); assert.equal(r.policyBlocks, 1); assert.equal(r.humanWaits, 1);
});
test('activity composes, dedups event ids, correct tabs', () => {
  const a = composeActivity([{ id: 5, caseId: 1, title: 'dash', detail: '', createdAt: '2025-01-03T00:00:00Z' }], ac);
  assert.equal(a.filter((i) => i.key === 'event:5').length, 1);
  assert.match(a.find((i) => i.key === 'event:6')!.href!, /section=history/);
  assert.equal(a.find((i) => i.key === 'record:d1')!.href, '/cases/separations/4');
  assert.equal(a.find((i) => i.key === 'record:d1')!.actor, null);
});
test('truncation disclosure and anchor', () => {
  assert.equal(sourceDisclosures(ac).find((d) => d.label === 'Approvals')!.capped, true);
  assert.equal(exampleDetailHref('/cases/1#operational-reliability'), '/cases/1#operational-reliability');
  assert.equal(activeFamilyHref('Payroll'), '/cases?caseType=Payroll&activeOnly=1');
});
test('partial failure renders independent states; long rows wrap', () => {
  const html = renderToStaticMarkup(<Router ssrPath="/"><div>
    <ActivityPanel items={composeActivity(undefined, ac)} coverage="c" />
    <ReliabilityPanel data={null} failed disclosures={sourceDisclosures(ac)} />
    <ExamplesSection failed />
  </div></Router>);
  assert.match(html, /Reliability sources unavailable/);
  assert.match(html, /Examples unavailable/);
  assert.match(html, /actor not recorded/);
  assert.match(html, /time not recorded/);
  assert.match(html, /break-words/);
  assert.match(html, /grid-cols-1|min-w-0/);
  assert.match(html, /Not complete: Approvals 2 of 300/);
  assert.doesNotMatch(html, /healthy/i);
});

test('live reliability items are case-linked with source/status/impact/owner/next', () => {
  const r = liveReliability(ac, [{ id: 1 }, { id: 2 }, { id: 3 }] as any)!;
  const item = r.items.find((i) => i.key === 'event:6')!;
  assert.match(item.status, /Awaiting provider|overdue/i);
  assert.equal(item.href, '/cases/2');
  assert.equal(item.owner, null);
  assert.ok(item.nextStep && item.impact && item.source);
  assert.ok(r.items.every((i) => i.href && i.reference));
  assert.ok(r.items.find((i) => i.key === 'approval:7')!.status.includes('not a technical failure'));
});
test('unknown case provenance makes no live claims; explicit identity avoids double count', () => {
  const none = liveReliability(ac, undefined)!;
  assert.equal(none.items.length, 0); assert.equal(none.provenanceKnown, false);
  const d: any = { ...ac, completed: [{ id: 'event:5', caseId: 1, status: 'failed', summary: 's', actor: 'a', caseHref: '/cases/1' }] };
  const r = liveReliability(d, [{ id: 1 }, { id: 2 }, { id: 3 }] as any)!;
  assert.equal(r.failedActions, 0); assert.equal(r.technicalFailures, 1);
});
test('explicit document and bgv check ids dedup', () => {
  const d: any = { ...ac, approvals: [], notifications: [], opportunities: [{ id: 'document:1:3', caseId: 1, priority: 'low', title: 'o', evidence: { source: 's' }, caseHref: '/cases/1' }, { id: 'bgv:1:9', caseId: 1, priority: 'low', title: 'o', evidence: { source: 's' }, caseHref: '/cases/1' }],
    documentFollowups: [{ caseId: 1, documentId: 3, label: 'ID', action: 'remind', caseHref: '/cases/1' }], domainRecords: [], workItems: [] };
  assert.equal(projectAttention(d, { reviews: [], owners: [] } as any).total, 2);
});
test('paused offline approvals and their opportunities are excluded', () => {
  const d: any = { ...ac, notifications: [], domainRecords: [], approvals: [{ id: 7, caseId: 1, status: 'pending', hitlPattern: 'x', recommendation: 'r', case: { pausedOffline: true } }] };
  assert.equal(projectAttention(d, { reviews: [], owners: [] } as any).total, 1); // only the check opportunity
});
test('examples arithmetic and absent sources', () => {
  const html = renderToStaticMarkup(<Router ssrPath="/"><ExamplesSection data={{ inventorySize: 7, items: [], answerSamples: 2, answerMatches: 1 } as any} /></Router>);
  assert.match(html, /1 of 2 sampled answers matched/);
  assert.match(html, /0 of 7/);
  assert.match(html, /Not assessed/);
});
test('canonical family completion keeps synthetic completion; separate summaries win', async () => {
  const { familyWorkload } = await import('../../lib/control-tower');
  const rows = familyWorkload([{ id: 1, hireType: 'new-hire', lifecycleStage: 'Completed', orchestrationStatus: 'completed' } as any,
    { id: 9, hireType: 'separation', orchestrationStatus: 'running' } as any],
    [{ caseId: 1, caseType: 'Onboarding', status: 'active', caseHref: '/cases/1', label: 'x' } as any,
     { caseId: 9, caseType: 'Offboarding', status: 'completed', caseHref: '/cases/separations/9', label: 'y' } as any]);
  assert.equal(rows.find((r) => r.family === 'Onboarding')!.active, 0);
  assert.equal(rows.find((r) => r.family === 'Offboarding')!.active, 0);
});
