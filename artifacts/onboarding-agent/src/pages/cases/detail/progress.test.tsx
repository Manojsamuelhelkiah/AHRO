import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressTab } from './progress-tab';
import { ProgressHistory, latestHistory } from './progress-history';
import { CaseTabs } from './components';
import { CaseAccessProvider, type CaseAccessPermissions } from './case-access';
import { caseDestination, caseDestinationFromSearch, caseSectionSearch } from './progress-navigation';
import { NextActions } from './overview';

const history = { scope: 'case-a', allowed: true, loading: false, failed: false, retry: () => {} };
const access: CaseAccessPermissions = {
  caseId: 1, access: { flowRead: true, flowEdit: false, profileRead: true, profileEdit: false, notesRead: false, notesEdit: false },
  sensitive: Object.fromEntries(['identity', 'medical', 'payroll', 'bgv'].map(key => [key, { read: false, edit: false }])) as CaseAccessPermissions['sensitive'],
};
const workstreams = ['completed', 'rejected', 'blocked'].map(status => ({
  key: status, label: `Work ${status}`, status, agent: 'Records Agent', owner: 'Assigned reviewer',
  blockers: status === 'blocked' ? ['Source reference outstanding'] : [],
}));

test('ordinary Progress retains every work outcome, plan, owner and blocker before genuine history', () => {
  const html = renderToStaticMarkup(<ProgressTab c={{ planSummary: 'Recorded plan', workstreams }}
    pendingApprovals={[]} history={{ ...history, events: [{ id: 7, title: 'Actual recorded event',
      detail: 'Actual evidence', engine: 'human', agent: 'Named reviewer', createdAt: '2026-10-01T00:00:00Z' }] }} />);
  for (const text of ['Current work', 'Recorded plan', 'Work completed', 'Work rejected', 'Work blocked',
    'Assigned reviewer', 'Source reference outstanding', 'Actual recorded event', 'Named reviewer']) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf('Work rejected') < html.indexOf('id="progress-history"'));
  assert.equal((html.match(/Actual recorded event/g) || []).length, 1);
  const next = renderToStaticMarkup(<NextActions c={{ workstreams }} pendingApprovals={[]} showPlanLink={false} />);
  assert.doesNotMatch(next, /Work completed|Work rejected/);
});

test('journey stages appear once in current work and never become history', () => {
  const c = { syntheticJourney: { outcome: 'rejected', family: 'Learning', nextActions: [],
    stages: [{ id: 'one', title: 'Unique projected stage', status: 'rejected', dependencies: [],
      agent: 'Learning Agent', role: 'Reviewer', evidence: 'Worksheet', decision: 'Denied' }] } };
  const html = renderToStaticMarkup(<ProgressTab c={c} pendingApprovals={[]} history={{ ...history, events: [] }} />);
  assert.equal((html.match(/Unique projected stage/g) || []).length, 1);
  assert.doesNotMatch(html.slice(html.indexOf('id="progress-history"')), /Unique projected stage|Worksheet|Denied/);
  assert.match(html, /No recorded events yet/);
  assert.match(html, /downstream work cancelled/);
});

test('history states are distinct and restricted/loading/error branches never render cached content', () => {
  const events = [{ id: 1, createdAt: '2026-10-01T00:00:00Z', title: 'Private marker', detail: 'Private detail', engine: 'human' }];
  for (const [flags, expected] of [
    [{ allowed: false }, /history is restricted/], [{ loading: true }, /Loading recorded history/],
    [{ failed: true }, /history could not be loaded/],
  ] as const) {
    const html = renderToStaticMarkup(<ProgressHistory {...history} events={events} {...flags} />);
    assert.match(html, expected);
    assert.doesNotMatch(html, /Private marker|Private detail|No recorded events/);
  }
});

test('history sorts a copied array newest first, shows ten initially, and retains full dated attribution', () => {
  const events = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, createdAt: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    title: `Event ${i + 1}`, engine: 'human', detail: 'Long detail', agent: 'Named owner' }));
  assert.equal(latestHistory(events)[0].id, 23);
  assert.equal(events[0].id, 1);
  const html = renderToStaticMarkup(<ProgressHistory {...history} events={events} />);
  assert.equal((html.match(/data-event-id=/g) || []).length, 10);
  assert.match(html, /Show older events \(13 remaining\)/);
  assert.match(html, /dateTime="2026-10-23T00:00:00Z"/i);
  assert.match(html, /Oct 23, 2026/);
  assert.match(html, /Recorded by:.*Named owner/);
});

test('one Progress tab remains accessible without notes permission', () => {
  const html = renderToStaticMarkup(<CaseAccessProvider value={access}><CaseTabs activeTab="Progress" setTab={() => {}} /></CaseAccessProvider>);
  assert.match(html, /aria-current="page"[^>]*>Progress</);
  assert.doesNotMatch(html, />Tasks<|>Activity<|>Audit</);
});

test('legacy links, direct sections and transaction sources share destinations and retain unrelated search state', () => {
  assert.deepEqual(caseDestination('tasks'), { tab: 'Progress', section: 'current-work' });
  assert.deepEqual(caseDestination('activity'), { tab: 'Progress', section: 'history' });
  assert.deepEqual(caseDestinationFromSearch('?tab=Activity&keep=x'), { tab: 'Progress', section: 'history' });
  assert.deepEqual(caseDestinationFromSearch('?tab=progress&section=history'), { tab: 'Progress', section: 'history' });
  assert.equal(caseDestinationFromSearch('?tab=unknown').tab, 'Overview');
  assert.equal(caseDestinationFromSearch('?tab=Transaction%20context').tab, 'Transaction context');
  assert.equal(caseDestinationFromSearch('?tab=transaction-context').tab, 'Transaction context');
  for (const tab of ['Overview', 'Early tenure', 'Progress', 'Frontline', 'Documents', 'Communications',
    'Audit', 'Transaction context', 'Ask AI']) {
    assert.equal(caseDestinationFromSearch(caseSectionSearch('?keep=review', tab)).tab, tab,
      `${tab} must round-trip its emitted URL`);
  }
  const search = caseSectionSearch('?keep=a%2Fb&tab=tasks&review=2', 'Activity');
  const params = new URLSearchParams(search);
  assert.equal(params.get('keep'), 'a/b');
  assert.equal(params.get('review'), '2');
  assert.equal(params.get('tab'), 'progress');
  assert.equal(params.get('section'), 'history');
  assert.equal(new URLSearchParams(caseSectionSearch(search, 'Communications')).has('section'), false);
});
